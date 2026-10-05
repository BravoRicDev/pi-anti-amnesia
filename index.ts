/**
 * pi-anti-amnesia — The Keeper of the self-written memory card.
 *
 * PROBLEM
 *   The anti-amnesia strategies written into prompts ("after every compaction
 *   re-read base.md") live in *prompt-space*: they ask the model to notice
 *   the compaction and obey. After a compaction the model often does not even
 *   know it happened. Soft compliance = it fails.
 *
 * SOLUTION
 *   Move anti-amnesia into *hook-space*: deterministic injection, not
 *   negotiable, exactly like Pi's own compaction.
 *
 *   Phase 1 BOOTSTRAP — on a new session, while the agent is "fresh"
 *                       (full context, knows its role), it is asked to write
 *                       the card BY ITSELF: verbatim text with the exact role
 *                       and absolute paths. No paraphrasing, no loss.
 *   Phase 2 CARD      — the agent stores it with the `memory_card` tool.
 *                       The extension persists it in a shared registry.
 *   Phase 3 KEEPER    — the extension re-injects the card on its own,
 *                       without asking the model anymore, over INDEPENDENT
 *                       and configurable channels:
 *                         a) onCompact         — after every compaction (still)
 *                         b) periodicChannel   — refresh every N turns
 *                         c) systemPromptChannel — presence in the system prompt
 *                         d) randomReviewChannel — review on a random interval
 *                         e) bootstrap         — asks for the card on a new session
 *                         f) gate              — mandatory confirmation ([CARD OK])
 *
 *   DEFAULT: compaction, periodic refresh and random review are on.
 *   Card contents are split by topic: permanent rules stay available, the
 *   topic-specific details come in only when relevant.
 *
 *   "Fresh" is verifiable: in `before_agent_start` Pi passes
 *   `systemPromptOptions` with `contextFiles` (ABSOLUTE paths of base.md/AGENTS.md),
 *   `customPrompt` (role), `cwd`. The extension uses that data as ground truth
 *   to hand to the agent, so the card is born anchored to reality.
 *
 * REGISTRY (like cronjobs, twin of ~/.pi/timers/active-timers.json)
 *   ~/.pi/anti-amnesia/registry.json      -> one entry per key/session
 *   ~/.pi/anti-amnesia/cards/<key>.md     -> card isolated per Pi session
 *   <project>/.pi/anti-amnesia/config.json -> override of the scheduling channels
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type * as TopicScope from './topic-scope.mjs';
import type * as I18n from './i18n.mjs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const GLOBAL_ROOT = path.join(os.homedir(), '.pi', 'anti-amnesia');
const CARDS_DIR = path.join(GLOBAL_ROOT, 'cards');
const REGISTRY_FILE = path.join(GLOBAL_ROOT, 'registry.json');
const PROJECT_SUBDIR = path.join('.pi', 'anti-amnesia');
const CUSTOM_TYPE = 'anti-amnesia';
const WIDGET_KEY = 'pi-anti-amnesia';
const MAX_CARD_CHARS = 20000;
const MAX_INTERVAL_TURNS = 1000;
const GATE_MAX_ATTEMPTS = 3;
// `role` may contain spaces (most roles do: "Hardware & LLM Serving Technician
// cubotto"), so it cannot be captured with (\S+): the capture stopped at the
// first token and the comparison against cfg.role always failed, making the gate
// unpassable for most of the roles in the live registry. (.+?) is non-greedy so
// the trailing `turn=` still terminates the role.
const CARD_OK_FORMAT = /\[CARD OK\] key=(\S+) role=(.+?) turn=(\d+)/;

// __dirname equivalent in ESM: directory of this source file (the extension).
const _EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
// Shared global config (synced via PiAgent, co-located with the extension).
// Precedence: DEFAULTS <- global <- user <- registry[key] <- project.
const GLOBAL_CONFIG = path.join(_EXT_DIR, 'config.json');
// Pi's conventional path (~/.pi/<name>/config.json), the one pi-cwl and pi-arc
// follow. It used to be ignored silently: a user writing their settings there
// saw no effect and no warning.
const USER_CONFIG = path.join(GLOBAL_ROOT, 'config.json');

// Shared seed, used only on an explicit bootstrap request.
// Priority: env -> config.baseCard -> card bundled for the active language -> legacy.
function draftCandidates(baseCard: string, lang: string): string[] {
  return [
    process.env.PI_ANTI_AMNESIA_DRAFT ?? '',
    baseCard,
    path.join(_EXT_DIR, 'cards', `base.${lang}.md`),
    path.join(os.homedir(), 'PiAgent', 'prompts', 'carta-anti-amnesia.md'),
  ].filter((p) => p.length > 0);
}

type Channel = 'ephemeral' | 'persistent';

interface CardConfig {
  /** Periodic re-injection interval, in turns. */
  everyTurns: number;
  /** Enables Phase 1 bootstrap: asks the agent to write its own card. */
  bootstrap: boolean;
  /** Number of initial turns to wait before proposing bootstrap (default 4). */
  bootstrapAfterTurns: number;
  /** Enables injection into the system prompt (channel c). */
  systemPromptChannel: boolean;
  /** Enables periodic refresh every N turns (channel b). */
  periodicChannel: boolean;
  /** Enables random review (random channel). */
  randomReviewChannel: boolean;
  /** Enables injection after compaction (channel a). */
  onCompact: boolean;
  /** Enables the mandatory-confirmation gate. */
  gate: boolean;
  /** Master switch. */
  active: boolean;
  /** Role declared in the card (informational). */
  role?: string;
  cwd?: string;
  generation: number;
  updatedAt: number;
  chars: number;
  /** Legacy mode in the registry; scheduled refreshes always use ephemeral context. */
  periodic: Channel;
  /** Legacy mode in the registry; compaction always uses ephemeral context. */
  compaction: Channel;
  /** 'auto' | 'it' | 'en'. 'auto' derives it from the system locale, frozen per session. */
  language: string;
  /** Explicit path of a base card. Empty = use the bundled cards/base.<lang>.md. */
  baseCard: string;
}

const DEFAULTS: CardConfig = {
  everyTurns: 15,
  bootstrap: true,
  bootstrapAfterTurns: 4,
  systemPromptChannel: false,
  periodicChannel: true,
  randomReviewChannel: true,
  onCompact: true,
  gate: false,
  active: true,
  generation: 0,
  updatedAt: 0,
  chars: 0,
  // ephemeral default: no accumulation in the transcript, same coverage.
  periodic: 'ephemeral',
  // The context hook guarantees delivery on the post-compaction retry without stale transcript.
  compaction: 'ephemeral',
  // 'auto' = derives from PI_ANTI_AMNESIA_LANG / LC_ALL / LC_MESSAGES / LANG / Intl.
  language: 'auto',
  // Empty = use cards/base.<lang>.md bundled with the extension.
  baseCard: '',
};

/**
 * Parses the boolean spellings a hand-edited JSON config may contain.
 * Returns null when the value is not a recognised boolean, so the caller can
 * decide the fallback (the default for that field).
 */
function parseBooleanish(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return null;
}

/**
 * Raw language, read BEFORE the full merge and without depending on `key`.
 * Arguments are in increasing precedence order: the last one declaring
 * `language` wins, exactly like in the { ...cfg, ...parsed } merge.
 * Without this, a `language` set in the project config would be silently
 * ignored while every other project config key is honoured.
 */
function readRawLanguage(...configPaths: string[]): string {
  let language = 'auto';
  for (const p of configPaths) {
    const raw = readText(p);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as { language?: unknown };
      if (typeof parsed.language === 'string') language = parsed.language;
    } catch { /* invalid config: ignored, as in the main merge */ }
  }
  return language;
}

// Channel-name map (/card command) -> configuration field.
const CHANNEL_FIELDS: Record<
  string,
  'onCompact' | 'systemPromptChannel' | 'periodicChannel' | 'randomReviewChannel' | 'gate'
> = {
  session_compact: 'onCompact',
  system_prompt: 'systemPromptChannel',
  periodic: 'periodicChannel',
  randomreview: 'randomReviewChannel',
  gate: 'gate',
};

// ---------------------------------------------------------------- utilities

function ensureDirs(): void {
  try {
    fs.mkdirSync(CARDS_DIR, { recursive: true });
  } catch {
    /* noop */
  }
}

function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

function writeText(p: string, text: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf-8');
}

function sanitizeKey(raw: string): string {
  const s = raw
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .toLowerCase();
  return (s || 'default').slice(0, 60);
}

function readRegistry(): Record<string, CardConfig> {
  ensureDirs();
  const raw = readText(REGISTRY_FILE);
  if (!raw) return {};
  try {
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && data.cards && typeof data.cards === 'object') {
      return data.cards as Record<string, CardConfig>;
    }
  } catch {
    /* corrupt registry: start over from an empty one */
  }
  return {};
}

function writeRegistry(cards: Record<string, CardConfig>): boolean {
  ensureDirs();
  const temp = `${REGISTRY_FILE}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeText(temp, JSON.stringify({ version: 1, cards }, null, 2));
    fs.renameSync(temp, REGISTRY_FILE); // never expose a half-written JSON
    return true;
  } catch {
    try { fs.unlinkSync(temp); } catch { /* cleanup best effort */ }
    return false;
  }
}

/**
 * A lock whose owning process is gone can never be released, and the holder is
 * recorded as a pid on the first line: use it to break a stale lock instead of
 * leaving registry persistence disabled for good.
 * Returns true when the lock was removed.
 */
function breakStaleLock(lockPath: string): boolean {
  try {
    const raw = fs.readFileSync(lockPath, 'utf-8').trim().split('\n')[0] ?? '';
    const pid = Number.parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0); // signal 0: existence check only
      return false; // still alive: the lock is legitimate
    } catch (err) {
      // ESRCH = no such process. EPERM means it exists but belongs to someone
      // else, so we must not touch it.
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') return false;
    }
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * The `.bak` files are free-rolling backups that are never pruned. Every time
 * the card is rewritten it leaves another one, and a write/delete cycle
 * (resume, bootstrap) produces two in a row, for an unaccounted pile-up of old
 * contents. The whole backup cycle is reduced to a single file: the last one,
 * the one that was meant to be kept.
 * Called at session_start so the pile stops growing with every session that
 * rewrites the card, and never grows again on its own.
 */
function pruneBackups(): void {
  try {
    const dir = CARDS_DIR;
    if (!fs.existsSync(dir)) return;
    // Two separate piles, and the second is the bigger one in practice:
    //   1) several .bak of the SAME card - keep the newest, drop the rest.
    //   2) a .bak whose card was already deleted (purge, resume, rename) - the
    //      backup outlived the thing it was backing up, so it is pure garbage.
    // Both are unbounded: every write adds to (1), every purge adds to (2).
    const newest = new Map<string, string>(); // base path -> newest bak path
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.bak')) continue;
      const base = path.join(dir, entry.name.slice(0, -'.bak'.length));
      const existing = newest.get(base);
      if (!existing || fs.statSync(path.join(dir, entry.name)).mtimeMs > fs.statSync(existing).mtimeMs) {
        newest.set(base, entry.name);
      }
    }
    for (const [base, keep] of newest) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.bak')) continue;
        if (entry.name === keep) continue;
        const base2 = path.join(dir, entry.name.slice(0, -'.bak'.length));
        if (base2 !== base) continue;
        try { fs.unlinkSync(path.join(dir, entry.name)); } catch { /* noop */ }
      }
    }
    // (2): a .bak whose card no longer exists is garbage - delete it outright.
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.bak')) continue;
      const base = path.join(dir, entry.name.slice(0, -'.bak'.length));
      if (fs.existsSync(base)) continue;
      try { fs.unlinkSync(path.join(dir, entry.name)); } catch { /* noop */ }
    }
  } catch {
    /* noop: pruning is best-effort and must never break session start */
  }
}

/** Cross-process lock over the WHOLE read-modify-write, not just the rename. */
function withRegistryLock(update: () => boolean): boolean {
  ensureDirs();
  const lockPath = `${REGISTRY_FILE}.lock`;
  let fd: number | undefined;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeSync(fd, `${process.pid}\n`); // orphan lock diagnostics
      } catch {
        try { fs.closeSync(fd); fs.unlinkSync(lockPath); } catch { /* noop */ }
        return false;
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      // Before waiting: if the holder is dead, clear the lock. Otherwise a crash
      // mid-write would block every later attempt forever, with no recovery.
      if (breakStaleLock(lockPath)) continue;
      Atomics.wait(pause, 0, 0, 20); // max wait ~800 ms, then an explicit error
    }
  }
  if (fd === undefined) return false;
  let ok = false;
  try {
    ok = update();
  } catch {
    ok = false;
  } finally {
    try { fs.closeSync(fd); } catch { ok = false; }
    try { fs.unlinkSync(lockPath); } catch { ok = false; }
  }
  return ok;
}

// ---------------------------------------------------------------- extension

export default function (pi: ExtensionAPI) {
  let ctxRef: ExtensionContext | undefined;
  // /reload must read the NEW version of the ESM helper: static imports
  // can stay in the process cache, breaking even memory_card.
  let scope: typeof TopicScope | undefined;
  function currentScope(): typeof TopicScope {
    if (!scope) throw new Error(t('error.helperUninitialized'));
    return scope;
  }
  let key = 'default';
  let card: string | null = null;
  let cardPath: string | null = null;
  let cardOrigin: 'project' | 'global' | 'memory' | 'draft' = 'global';
  let latestUserInput = '';
  let cfg: CardConfig = { ...DEFAULTS };
  // Language frozen for the whole session: the LLM must never see the
  // context change language mid-conversation (typical cause: hybrid output).
  let lang = 'en';
  let t: (key: string, vars?: Record<string, string | number>) => string = (key) => `[${key}]`;
  let scopeOpts: Record<string, unknown> = {};
  // Canonical section titles and raw catalog, for the composed prompts.
  // A DIAGNOSTIC LOG, because this extension had NONE. The operator reported that the
  // post-compaction injection "non sta funzionando" and there was no way to tell whether the
  // event fired, whether the handler returned early, or whether the block was built and then
  // lost. Every branch below leaves a row. Append-only and capped; a write failure is swallowed,
  // because logging must never break the extension it observes.
  const CARD_LOG_PATH = path.join(GLOBAL_ROOT, 'card.log');
  function cardLog(row: string): void {
    try {
      fs.mkdirSync(GLOBAL_ROOT, { recursive: true });
      fs.appendFileSync(CARD_LOG_PATH, `${new Date().toISOString()} ${row}\n`, 'utf-8');
      if (fs.statSync(CARD_LOG_PATH).size > 512 * 1024) {
        fs.writeFileSync(CARD_LOG_PATH, (readText(CARD_LOG_PATH) ?? '').split('\n').slice(-800).join('\n'), 'utf-8');
      }
    } catch { /* logging must never break the extension */ }
  }

  // THE POST-COMPACTION WINDOW — OFF BY DEFAULT, and that is deliberate. A native compaction
  // replaces a large part of the conversation with a summary, so the argument for keeping the
  // card in flight for a few turns is real: one ephemeral injection means the next turn has
  // neither the card nor the history that carried it. But the existing suite encodes the
  // ONE-SHOT behaviour as intended (tests/extension-flow.test.mjs:285 asserts that the call
  // right after the retry returns nothing), and I could not verify the failure mode on the
  // live path. Turning this on is a BEHAVIOUR CHANGE and must be justified by the log above,
  // not by a hypothesis. Set to 3 to enable the window.
  const POST_COMPACT_TURNS = 0;
  let postCompactUntil = -1;

  let sectionTitles = { always: 'Always valid', active: 'Active work', objective: 'Objective', plan: 'Plan', todo: 'Todo', topic: 'Topic' };
  let scopeI18n: Record<string, unknown> = {};
  let interpolateAll: (lines: string[], vars: Record<string, string | number>) => string[] =
    (lines) => lines;

  let turns = 0;
  let periodicTurns = 0;
  let bootstrapped = false;
  let pendingPeriodic = false;
  let pendingManual = false;
  let pendingResume = false;
  let pendingHeartbeat = false;
  let pendingPostCompact = false;
  let pendingRandomReview = false;
  let randomTarget = 0;
  let lastUpdateTurn = 0;
  let activeGate: { channel: string; turn: number; attempts: number } | null = null;
  let gateViolations: number = 0;
  let gateLastViolationTurn = 0;
  const GATE_COOLDOWN_TURNS = 5;

  let projectConfigPath = '';

  const globalCardPath = () => path.join(CARDS_DIR, `${key}.md`);
  const globalRegistry = () => readRegistry();

  // ---- loading ----

  /**
   * Caps a card on READ as well as on write.
   * MAX_CARD_CHARS was enforced only when the tool wrote a card, so a card
   * already on disk (edited by hand, or written by an older version) was
   * injected whole on every turn, however large it was.
   */
  function clampCard(text: string): string {
    if (text.length <= MAX_CARD_CHARS) return text;
    return `${text.slice(0, MAX_CARD_CHARS)}\n\n${t('error.cardTooLong', { len: text.length, max: MAX_CARD_CHARS })}`;
  }

  function loadCard(draftOnly = false): void {
    if (!draftOnly) {
      // Project cards are not loaded: they may belong to another role/chat.
      const fromGlobal = readText(globalCardPath());
      if (fromGlobal && fromGlobal.trim()) {
        card = clampCard(fromGlobal);
        cardPath = globalCardPath();
        cardOrigin = 'global';
        return;
      }
    }
    // The shared draft is loadable only during an explicit bootstrap.
    // Never re-inject it as a silent fallback in chats with no card.
    if (draftOnly) {
      for (const cand of draftCandidates(cfg.baseCard, lang)) {
        const draft = readText(cand);
        if (draft && draft.trim()) {
          card = clampCard(draft);
          cardPath = cand;
          cardOrigin = 'draft';
          return;
        }
      }
    }
    card = null;
    cardPath = null;
    cardOrigin = 'global';
  }


  function loadConfig(): void {
    cfg = { ...DEFAULTS };
    // 1) Shared global config (synced via PiAgent, co-located with the extension),
    // then Pi's conventional user config path.
    for (const source of [GLOBAL_CONFIG, USER_CONFIG]) {
      const raw = readText(source);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') cfg = { ...cfg, ...parsed };
      } catch { /* invalid config: ignored */ }
    }
    // 2) Session registry (overrides the global one).
    const stored = globalRegistry()[key];
    cfg = { ...cfg, ...(stored ?? {}) };
    // 3) Project config (wins over everything).
    const fromProject = readText(projectConfigPath);
    if (fromProject) {
      try {
        const parsed = JSON.parse(fromProject);
        if (parsed && typeof parsed === 'object') cfg = { ...cfg, ...parsed };
      } catch { /* invalid project config: ignored */ }
    }
    if (!Number.isFinite(cfg.everyTurns) || cfg.everyTurns < 1 || cfg.everyTurns > MAX_INTERVAL_TURNS) cfg.everyTurns = DEFAULTS.everyTurns;
    cfg.everyTurns = Math.floor(cfg.everyTurns);
    const bat = (cfg as any).bootstrapAfterTurns;
    if (typeof bat === 'number' && Number.isFinite(bat)) {
      cfg.bootstrapAfterTurns = Math.max(0, Math.floor(bat));
    } else {
      cfg.bootstrapAfterTurns = DEFAULTS.bootstrapAfterTurns;
    }
    for (const field of ['bootstrap', 'systemPromptChannel', 'periodicChannel', 'randomReviewChannel', 'onCompact', 'gate', 'active'] as const) {
      // A hand-edited config.json can hold the STRING "false". Falling back to
      // the default for anything non-boolean turned an explicit "off" into
      // "on" for every channel whose default is true (periodicChannel,
      // randomReviewChannel, onCompact, bootstrap, active) - the user's intent
      // silently inverted. Recognised strings are parsed; only values that are
      // neither a boolean nor a known boolean string fall back to the default.
      const raw = cfg[field] as unknown;
      if (typeof raw === 'boolean') continue;
      const parsed = parseBooleanish(raw);
      cfg[field] = parsed ?? DEFAULTS[field];
    }
    if (cfg.periodic !== 'ephemeral' && cfg.periodic !== 'persistent') cfg.periodic = DEFAULTS.periodic;
    if (cfg.compaction !== 'ephemeral' && cfg.compaction !== 'persistent') cfg.compaction = DEFAULTS.compaction;
    if (typeof cfg.role !== 'string') delete cfg.role;
    if (typeof cfg.cwd !== 'string') delete cfg.cwd;
  }

  /** Install-wide settings, not session settings: they do not go into the registry. */
  const INSTALL_KEYS = ['language', 'baseCard'] as const;

  function persistConfig(cardWritten = false): boolean {
    return withRegistryLock(() => {
      const cards = globalRegistry();
      // language/baseCard live in config.json and apply to every session.
      // Writing them here would freeze them: loadConfig lets the registry win
      // over the global config, so a later config.json change would no longer
      // take effect on this session. They must be excluded, not overwritten.
      const snapshot = { ...cfg };
      for (const k of INSTALL_KEYS) delete snapshot[k];
      cards[key] = {
        ...snapshot,
        chars: card ? card.length : 0,
        updatedAt: cardWritten ? Date.now() : (cards[key]?.updatedAt ?? 0),
      };
      return writeRegistry(cards);
    });
  }

  function pickRandomTarget(): number {
    const N = cfg.everyTurns;
    return N + Math.floor(Math.random() * (N + 1)); // N … 2N inclusive
  }

  function setIntervalTurns(value: number): void {
    cfg.everyTurns = Math.floor(value);
    periodicTurns = 0;
    pendingPeriodic = false;
    pendingHeartbeat = false;
    pendingRandomReview = false;
    randomTarget = turns + pickRandomTarget();
  }

  /** Normalises a message content (string | block array | other) to plain text. */
  function contentToText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((b) => {
          if (typeof b === 'string') return b;
          if (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string') {
            return (b as { text: string }).text;
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
    return '';
  }

  function verifyGate(content: unknown): boolean {
    const match = contentToText(content).match(CARD_OK_FORMAT);
    if (!match) return false;
    if (match[1] !== key) return false;
    if (cfg.role && match[2].trim() !== cfg.role) return false;
    // Compare against the turn the model was ASKED to echo (activeGate.turn),
    // not the live counter: `turns` advances on every turn_end, so any turn
    // boundary between arming and answering rejected a correct confirmation.
    const expected = activeGate ? activeGate.turn : turns;
    if (parseInt(match[3], 10) !== expected) return false;
    return true;
  }

  // ---- injection ----

  function cardBlock(reason: string): string {
    if (!card || cardOrigin === 'draft') return '';
    const scoped = currentScope().selectCardForTopic(card, latestUserInput, scopeOpts);
    if (!scoped.text) return '';
    const warning = scoped.legacy
      ? t('scope.legacyHint')
      : t('scope.checkpointHint');
    const unclassified = scoped.unclassified.length
      ? t('scope.unclassifiedHint', {
          list: scoped.unclassified.slice(0, 3).join(', '),
          always: sectionTitles.always,
          active: sectionTitles.active,
          topic: sectionTitles.topic,
        })
      : '';
    const passiveHeader = `[SISTEMA \u00b7 MEMORIA DI SESSIONE PASSIVA (NON RISPONDERE)]`;
    const passiveNotice = `\n[Memoria interna pregressa. NON rispondere a questo blocco, NON commentarlo. Continua normalmente eseguendo la richiesta dell'utente.]`;
    return `${passiveHeader}\n[ANTI-AMNESIA \u00b7 ${reason}]\n${scoped.text}${warning}${unclassified}${passiveNotice}`;
  }

  function injectEphemeral(reason: string): string {
    return cardBlock(reason);
  }

  // ---- widget ----

  function renderWidget(): void {
    const ctx = ctxRef;
    if (!ctx || !ctx.hasUI) return;
    const theme = ctx.ui.theme;
    const label = `[${key}]`;

    if (!card) {
      ctx.ui.setWidget(WIDGET_KEY, [
        theme.fg('warning', `\u26a0 ${t('widget.cardAbsent', { label })}`),
      ]);
      return;
    }

    const remaining = cfg.everyTurns - (periodicTurns % cfg.everyTurns);
    const remainingRandom = randomTarget - turns;
    const turnAge = turns - lastUpdateTurn;
    const ageStr = `${turnAge}t`;
    const channels = [
      cfg.onCompact ? t('widget.compactDown') : t('widget.compactOff'),
      cfg.periodicChannel ? t('widget.periodicOn', { turns: cfg.everyTurns, remaining }) : t('widget.periodicOff'),
      cfg.randomReviewChannel ? t('widget.reviewOn', { remaining: remainingRandom }) : t('widget.reviewOff'),
      cfg.systemPromptChannel ? t('widget.systemPrompt') : t('widget.systemPromptOff'),
      t('widget.eta', { age: ageStr }),
    ].join(' \u00b7 ');

    const status = cfg.active ? '' : theme.fg('warning', ` \u00b7 ${t('widget.disabled')}`);
    const gateInfo = activeGate
      ? theme.fg('error', ` \u00b7 ${t('widget.gate', { attempts: activeGate.attempts, max: GATE_MAX_ATTEMPTS, channel: activeGate.channel })}`)
      : '';
    const violations = gateViolations > 0
      ? theme.fg('error', ` \u00b7 ${t('widget.violations', { count: gateViolations })}`)
      : '';
    ctx.ui.setWidget(WIDGET_KEY, [
      theme.fg('accent', `\u26e8 ${t('widget.title', { label })} `) +
        theme.fg('dim', t('widget.cardInfo', { chars: card.length, origin: cardOrigin })) +
        theme.fg('muted', channels) +
        status +
        gateInfo +
        violations,
    ]);
  }

  function clearWidget(): void {
    const ctx = ctxRef;
    if (ctx && ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
  }

  // ---- bootstrap: the agent writes its card while fresh ----

  /** Structural subset of BuildSystemPromptOptions: no cast needed. */
  interface FreshContext {
    customPrompt?: string;
    cwd?: string;
    contextFiles?: Array<{ path: string }>;
    selectedTools?: string[];
  }

  function bootstrapMessage(o?: FreshContext): string {
    const opts = o ?? {};
    const files = opts.contextFiles ?? [];
    const fileList = files.length
      ? files.map((f) => `  - ${f.path}`).join('\n')
      : t('bootstrap.noContextFiles');
    const tools = opts.selectedTools ?? [];
    const draftActive = cardOrigin === 'draft' && Boolean(card);

    const bt = scopeI18n.bootstrap as Record<string, unknown> | undefined;
    // A wrong array key would degrade silently: the prompt would lose
    // lines and nobody would notice. Make it noisy, like t().
    const missing = (key: string) => [`[missing i18n key: ${key} (${lang})]`];
    const rows = (key: string): string[] =>
      Array.isArray(bt?.[key]) ? (bt[key] as string[]) : missing(`bootstrap.${key}`);
    const vars = { cwd: opts.cwd ?? ctxRef?.cwd ?? '?', path: cardPath ?? '', active: sectionTitles.active, topic: sectionTitles.topic, always: sectionTitles.always, objective: sectionTitles.objective, plan: sectionTitles.plan, todo: sectionTitles.todo };

    return [
      typeof bt?.header === 'string' ? bt.header : '[ANTI-AMNESIA]',
      ...interpolateAll(rows('intro'), vars),
      draftActive ? t('bootstrap.draftLoaded', { path: cardPath ?? '' }) : '',
      '',
      t('bootstrap.detected'),
      t('bootstrap.cwd', { cwd: vars.cwd }),
      t('bootstrap.rolePromptLoaded', { value: opts.customPrompt ? t('bootstrap.rolePromptCustom') : t('bootstrap.rolePromptNone') }),
      t('bootstrap.contextFiles'),
      fileList,
      tools.length ? t('bootstrap.activeTools', { tools: tools.join(', ') }) : '',
      '',
      ...interpolateAll(rows('keyNotice'), vars),
      '',
      t('bootstrap.structure'),
      t('bootstrap.sectionAlways', { always: sectionTitles.always }),
      t('bootstrap.sectionActive', { active: sectionTitles.active }),
      ...interpolateAll(rows('sectionActiveNote'), vars),
      // The three blocks are ANNOUNCED here, and that is not decoration: an agent that is not
      // told they exist will keep rewriting the whole card with `text`, which is the operation
      // these blocks exist to replace. A tool nobody knows about is a tool nobody uses.
      t('bootstrap.sectionObjective', { objective: sectionTitles.objective }),
      t('bootstrap.sectionPlan', { plan: sectionTitles.plan }),
      t('bootstrap.sectionTodo', { todo: sectionTitles.todo }),
      t('bootstrap.sectionTopic', { topic: sectionTitles.topic }),
      t('bootstrap.topicWarning', { topic: sectionTitles.topic }),
      ...interpolateAll(rows('handoff'), vars),
      '',
      t('bootstrap.closing'),
    ]
      .filter((l) => l !== '')
      .join('\n');
  }

  // ---------------------------------------------------------------- events

  pi.on('session_start', async (_event, ctx) => {
    ctxRef = ctx;
    const cwd = ctx.cwd ?? process.cwd();
    // Needed BEFORE i18n: the language must be able to come from the project config.
    projectConfigPath = path.join(cwd, PROJECT_SUBDIR, 'config.json');
    // Every runtime/reload uses a distinct URL: no stale helper from the ESM cache.
    const helperUrl = new URL('./topic-scope.mjs', import.meta.url);
    const helperSource = readText(fileURLToPath(helperUrl));
    if (helperSource === null) throw new Error(t('error.helperUnreadable'));
    // Content hash: unchanged code reuses the cache; an edit invalidates it.
    // Avoids a new ESM module on every long resume with no file change.
    helperUrl.searchParams.set('version', createHash('sha256').update(helperSource).digest('hex').slice(0, 16));
    scope = await import(helperUrl.href) as typeof TopicScope;
    if (typeof scope.replaceActiveCheckpoint !== 'function' || typeof scope.selectCardForTopic !== 'function' ||
        typeof scope.extractLatestUserText !== 'function') {
      throw new Error(t('error.helperIncompatible'));
    }

    // i18n: same cache-busting as the helper, so an edited catalog and a
    // /reload really reload it instead of serving the ESM cache copy.
    const i18nUrl = new URL('./i18n.mjs', import.meta.url);
    const i18nSource = readText(fileURLToPath(i18nUrl));
    if (i18nSource === null) throw new Error(t('error.helperUnreadable'));
    i18nUrl.searchParams.set('version', createHash('sha256').update(i18nSource).digest('hex').slice(0, 16));
    const i18n = await import(i18nUrl.href) as typeof I18n;
    lang = i18n.resolveLanguage(readRawLanguage(GLOBAL_CONFIG, USER_CONFIG, projectConfigPath));
    t = i18n.makeT(lang);
    sectionTitles = i18n.sectionTitles(lang);
    // SAFETY: loadCatalog returns an arbitrary JSON object; we treat it as a
    // section record and missing keys are tolerated by interpolateAll.
    scopeI18n = i18n.loadCatalog(lang) as unknown as Record<string, unknown>;
    interpolateAll = i18n.interpolateAll;
    scopeOpts = {
      aliases: i18n.sectionAliases(lang),
      activeTitle: sectionTitles.active,
      exactlyOneActive: t('error.exactlyOneActive'),
      locale: lang === 'it' ? 'it-IT' : 'en-US',
    };

    const sessionId = ctx.sessionManager.getSessionId();
    // The Pi ID is stable even if cwd or session name change.
    key = sanitizeKey(sessionId);

    // Load the config BEFORE using cfg.bootstrap / cfg.everyTurns.
    loadConfig();

    // The .bak files are free-rolling backups that are never pruned: reduce the
    // pile to the last one that was meant to be kept, once per session start.
    pruneBackups();

    turns = 0;
    latestUserInput = '';
    periodicTurns = 0;
    lastUpdateTurn = 0;
    activeGate = null;
    gateViolations = 0;
    gateLastViolationTurn = 0;
    pendingManual = false;
    pendingResume = false;
    pendingPeriodic = false;
    pendingHeartbeat = false;
    pendingPostCompact = false;
    pendingRandomReview = false;
    randomTarget = pickRandomTarget();
    // Only /resume reuses the same session card; a fork has a distinct ID.
    // The shared draft is loaded exclusively with /card bootstrap.
    bootstrapped = false;
    loadCard();
    if (card) {
      // A draft is not yet the agent's card: it is not a generation.
      if (cardOrigin !== 'draft') cfg.generation = Math.max(cfg.generation, 1);
      cfg.chars = card.length;
      // A resumed session may receive only "continue": anchor the card to the
      // very first LLM, without waiting five/fifteen turns of the timer.
      pendingResume = cardOrigin !== 'draft';
      if (!persistConfig() && ctx.hasUI) ctx.ui.notify(t('warn.registryNotSaveable'), 'error');
    }
    renderWidget();
    // Warning if a previous card (registry) is very old: signal, do not inherit silently.
    const reg = globalRegistry()[key];
    if (card && cardOrigin !== 'draft' && reg?.updatedAt) {
      const ageMs = Date.now() - reg.updatedAt;
      if (ageMs > 24 * 3600 * 1000) {
        const ctx = ctxRef;
        if (ctx && ctx.hasUI) {
          ctx.ui.notify(
            t('warn.previousCardFound', { date: new Date(reg.updatedAt).toLocaleString(lang === 'it' ? 'it-IT' : 'en-US') }),
            'warning',
          );
        }
      }
    }
  });

  // Channel c) system prompt + Phase 1 bootstrap
  pi.on('before_agent_start', async (event) => {
    if (!cfg.active) return;
    // Phase 1 bootstrap
    if (!card || cardOrigin === 'draft') {
      if (bootstrapped) return;
      if (!cfg.bootstrap) return;
      if (turns < cfg.bootstrapAfterTurns) return;
      bootstrapped = true;
      return {
        message: {
          customType: `${CUSTOM_TYPE}-bootstrap`,
          content: bootstrapMessage(event.systemPromptOptions),
          display: true,
        },
      };
    }
    latestUserInput = event.prompt;
    if (!cfg.systemPromptChannel) return;
    const block = cardBlock(t('inject.reasonPermanent'));
    if (!block) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${block}`,
    };
  });

  // At the end of a full turn, the user text is no longer a key for archived
  // notes. agent_end is too early (Pi may make automatic retries).
  pi.on('agent_settled', async () => { latestUserInput = ''; });

  // ---- LLM turn counters; autonomous cycles with no user input advance too ----

  pi.on('turn_end', async () => {
    if (!cfg.active) return;
    turns += 1;
    if (!card || cardOrigin === 'draft') {
      // An ignored bootstrap is proposed again: otherwise the plugin stays off forever.
      if (turns % cfg.everyTurns === 0) bootstrapped = false;
      return;
    }
    periodicTurns += 1;

    // Staleness: if the card is not updated for 2N turns, force periodic + random
    const stalenessLimit = 2 * cfg.everyTurns;
    const isStale = (turns - lastUpdateTurn) >= stalenessLimit;

    if (cfg.periodicChannel && (periodicTurns % cfg.everyTurns === 0 || (isStale && turns % cfg.everyTurns === 0))) {
      pendingPeriodic = true;
      const inCooldown = gateLastViolationTurn > 0 && (turns - gateLastViolationTurn) < GATE_COOLDOWN_TURNS;
      if (cfg.gate && activeGate === null && !inCooldown) activeGate = { channel: 'periodic', turn: turns, attempts: 0 };
    }

    // In long autonomous cycles the active checkpoint is repeated more often
    // than the full refresh, without waking archived Topic notes.
    const heartbeatEvery = Math.max(1, Math.floor(cfg.everyTurns / 3));
    if (cfg.periodicChannel && !pendingPeriodic && periodicTurns % heartbeatEvery === 0 &&
        card && currentScope().selectCardForTopic(card, '', scopeOpts).hasActive) {
      pendingHeartbeat = true;
    }

    // Random channel: card review between N and 2N turns
    if (turns >= randomTarget && cfg.randomReviewChannel) {
      pendingRandomReview = true;
      randomTarget = turns + pickRandomTarget();
      const inCooldown = gateLastViolationTurn > 0 && (turns - gateLastViolationTurn) < GATE_COOLDOWN_TURNS;
      if (cfg.gate && activeGate === null && !inCooldown) activeGate = { channel: 'review', turn: turns, attempts: 0 };
      const ctx = ctxRef;
      if (ctx && ctx.hasUI) {
        ctx.ui.notify(t('warn.revisionScheduled'), 'warning');
      }
    }

    // Staleness: also force the random review if the card is old
    if (isStale && turns % cfg.everyTurns === 0 && !pendingRandomReview && cfg.randomReviewChannel) {
      pendingRandomReview = true;
      const inCooldown = gateLastViolationTurn > 0 && (turns - gateLastViolationTurn) < GATE_COOLDOWN_TURNS;
      if (cfg.gate && activeGate === null && !inCooldown) {
        activeGate = { channel: 'review', turn: turns, attempts: 0 };
        const ctx = ctxRef;
        if (ctx && ctx.hasUI) {
          ctx.ui.notify(t('warn.staleForcedGate'), 'warning');
        }
      }
    }

    // Gate: attempt handling and escalation (once per activation)
    if (activeGate && activeGate.turn < turns) {
      activeGate.attempts += 1;
      if (activeGate.attempts >= GATE_MAX_ATTEMPTS) {
        gateViolations += 1;
        gateLastViolationTurn = turns;
        const ctx = ctxRef;
        if (ctx && ctx.hasUI) {
          ctx.ui.notify(t('error.gateFailed', { attempts: GATE_MAX_ATTEMPTS, channel: activeGate.channel, violations: gateViolations }), 'error');
        }
        activeGate = null;
      }
    }

    renderWidget();
  });

  // Channel a) + b) ephemeral delivery, guaranteed on every LLM call
  pi.on('context', async (event) => {
    // Card files may be edited by another live Pi process. The file is the source
    // of truth, so refresh before deciding what this hook injects.
    if (cardOrigin !== 'draft') loadCard();
    if (!cfg.active) {
      cardLog(`CONTEXT turn ${turns}: skipped, the extension is switched off`);
      return;
    }
    // Filter even if the card was deleted: old persistent messages
    // must not resurrect the previous task during the new bootstrap.
    let lastBootstrap = -1;
    event.messages.forEach((message, index) => {
      if (message.role === 'custom' && message.customType === `${CUSTOM_TYPE}-bootstrap`) lastBootstrap = index;
    });
    const cleanMessages = event.messages.filter((message, index) => {
      if (message.role !== 'custom') return true;
      if (message.customType === CUSTOM_TYPE) return false;
      if (message.customType !== `${CUSTOM_TYPE}-bootstrap`) return true;
      // If a new bootstrap arrived from before_agent_start, keep it.
      // Discard the earlier ones; when we propose the bootstrap again, discard all.
      return (!card || cardOrigin === 'draft') && bootstrapped && index === lastBootstrap;
    });
    if (!card || cardOrigin === 'draft') {
      if (!cfg.bootstrap || bootstrapped) {
        // THIS RETURN IS THE ONE THAT COULD HIDE THE COMPACTION FAILURE. If the card is gone or
        // is still a draft and the bootstrap was already proposed, the hook leaves WITHOUT
        // injecting and WITHOUT saying anything — so a session that lost its card looked
        // identical, from the outside, to a session that simply had nothing to inject. It is
        // logged now: the whole point of the log is that no branch can be silent.
        cardLog(`CONTEXT turn ${turns}: no card (${!card ? 'absent' : 'draft'}), bootstrap already proposed - nothing injected`);
        if (cleanMessages.length !== event.messages.length) return { messages: cleanMessages };
        return;
      }
      bootstrapped = true;
      return { messages: [...cleanMessages, {
        role: 'custom' as const,
        customType: `${CUSTOM_TYPE}-bootstrap`,
        content: bootstrapMessage({ cwd: ctxRef?.cwd }),
        display: false,
        timestamp: Date.now(),
      }] };
    }
    // Do not reuse the LAST user of the HISTORY: during resume/autonomous
    // cycles it may trace back to an old task. Only before_agent_start (current
    // turn prompt) enables the archived Topic sections.
    const blocks: string[] = [];
    const cardReasons: string[] = [];

    // Gate: verify the user confirmation in the incoming message
    if (activeGate && cfg.gate) {
      const lastMsg = event.messages[event.messages.length - 1];
      // SAFETY: only messages with `content` can contain the gate
      // confirmation; the others (e.g. bash) do not contain it by definition.
      const lastContent = lastMsg && 'content' in lastMsg ? lastMsg.content : undefined;
      if (verifyGate(lastContent)) {
        activeGate = null;
      } else {
        const scoped = currentScope().selectCardForTopic(card, latestUserInput, scopeOpts);
        if (!scoped.text) {
          activeGate = null;
        } else blocks.push(
          `[ANTI-AMNESIA \u00b7 ${t('gate.header', { attempts: activeGate.attempts, max: GATE_MAX_ATTEMPTS })}] ` +
            `${t('gate.confirm')}\n` +
            `${t('gate.format', { key, role: cfg.role ?? t('gate.noRole'), turn: activeGate.turn })}\n` +
            `${t('gate.relevantMemory', { chars: scoped.text.length })}\n${scoped.text || t('gate.noContent')}`,
        );
      }
    }
    if (pendingResume) {
      if (!cfg.systemPromptChannel) cardReasons.push(t('inject.reasonResume'));
      pendingResume = false;
      pendingHeartbeat = false;
      pendingPeriodic = false;
    }
    if (pendingManual) {
      cardReasons.push(t('inject.reasonManual'));
      pendingManual = false;
    }
    if (pendingPostCompact) {
      if (cfg.onCompact) cardReasons.push(t('inject.reasonPostCompact'));
      pendingPostCompact = false;
      pendingHeartbeat = false;
      cardLog(`CONTEXT turn ${turns}: post-compaction injection, window until ${postCompactUntil}`);
    }
    // THE WINDOW. A compaction is still in effect after the first injection, so the card keeps
    // being delivered until the window closes. Without this the very next turn would have
    // neither the card nor the history that the compaction removed.
    if (postCompactUntil > turns && cfg.onCompact && cardReasons.length === 0) {
      cardReasons.push(t('inject.reasonPostCompact'));
    }
    if (pendingPeriodic) {
      if (cfg.periodicChannel) cardReasons.push(t('inject.reasonPeriodic', { turns }));
      pendingPeriodic = false;
      pendingHeartbeat = false;
    }
    if (pendingHeartbeat && cfg.periodicChannel && cardReasons.length === 0 &&
        blocks.every((item) => !item.startsWith('[ANTI-AMNESIA · GATE'))) {
      const active = currentScope().selectCardForTopic(card, '', scopeOpts);
      if (active.hasActive) {
        blocks.push(`${t('inject.heartbeatHeader')}\n${active.text}\n` +
          t('inject.heartbeatFooter'));
      }
      pendingHeartbeat = false;
    }
    if (pendingRandomReview) {
      if (cfg.randomReviewChannel) {
        if (cardReasons.length === 0) cardReasons.push(t('inject.reasonScheduled'));
        // SAFETY: the catalog is untyped JSON; if 'inject' is missing only
        // the lines already present remain. A missing key stays noise.
        const injectRows = (scopeI18n.inject as { randomReview?: unknown } | undefined)?.randomReview;
        blocks.push(Array.isArray(injectRows)
          ? interpolateAll(injectRows as string[], sectionTitles).join(' ')
          : `[missing i18n key: inject.randomReview (${lang})]`);
      }
      pendingRandomReview = false;
    }
    // One copy of the card per LLM call, even if compaction,
    // periodic and review all fall due together.
    if (cardReasons.length > 0) {
      pendingHeartbeat = false;
      if (blocks.every((item) => !item.startsWith('[ANTI-AMNESIA · GATE'))) {
        const block = injectEphemeral(cardReasons.join('; '));
        if (block) blocks.unshift(block);
      }
    }
    if (!cfg.periodicChannel) pendingHeartbeat = false;
    if (blocks.length === 0) {
      cardLog(`CONTEXT turn ${turns}: nothing to inject (pending consumed, no window, no review)`);
      if (cleanMessages.length !== event.messages.length) return { messages: cleanMessages };
      return;
    }
    cardLog(`CONTEXT turn ${turns}: injected ${blocks.length} block(s), ${blocks.join('|').length} chars, reasons=${cardReasons.join(';') || 'none'}`);
    // SAFETY: CustomMessage is registered in CustomAgentMessages, so the
    // literal object below is already a valid AgentMessage: no cast.
    const reminder = {
      role: 'custom' as const,
      customType: CUSTOM_TYPE,
      content: blocks.join('\n\n'),
      display: false,
      timestamp: Date.now(),
    };
    return { messages: [...cleanMessages, reminder] }; 
  });


  pi.on('session_compact', async (event, ctx) => {
    if (!card || cardOrigin === 'draft' || !cfg.active || !cfg.onCompact) {
      cardLog(`COMPACT skipped (reason=${event.reason}): ${!card ? 'no-card' : cardOrigin === 'draft' ? 'draft' : !cfg.active ? 'inactive' : 'channel-off'}`);
      return;
    }
    // nextTurn waits for the next user input: insufficient during an automatic
    // retry after compaction. The next context hook delivers the checkpoint at once.
    pendingPostCompact = true;
    // STRICTLY greater: with the window off (`POST_COMPACT_TURNS = 0`) this is `turns`, and
    // `turns > turns` is false — which is the whole point. Written as `>=` it fired on the same
    // turn and made the window impossible to switch off.
    postCompactUntil = POST_COMPACT_TURNS > 0 ? turns + POST_COMPACT_TURNS : -1;
    cardLog(`COMPACT fired (reason=${event.reason}): card ${card.length} chars, window until turn ${postCompactUntil}`);
    if (cfg.gate) {
      const inCooldown = gateLastViolationTurn > 0 && (turns - gateLastViolationTurn) < GATE_COOLDOWN_TURNS;
      if (!inCooldown) {
        activeGate = { channel: 'compaction', turn: turns, attempts: 0 };
        if (ctx.hasUI) {
          ctx.ui.notify(t('warn.reinjectedGate', { reason: event.reason }), 'warning');
        }
      }
    } else if (ctx.hasUI) {
      ctx.ui.notify(t('info.reinjected', { reason: event.reason }), 'info');
    }
    renderWidget();
  });

  pi.on('session_shutdown', async () => {
    clearWidget();
  });

  // ---------------------------------------------------------------- tool

  pi.registerTool({
    name: 'memory_card',
    label: t('tool.label'),
    description:
      t('tool.description'),
    promptSnippet: t('tool.promptSnippet'),
    promptGuidelines: [
      t('tool.guideline'),
    ],
    parameters: Type.Object({
      text: Type.Optional(
        Type.String({
          description:
            t('param.text'),
        }),
      ),
      activeWork: Type.Optional(Type.String({
        description: t('param.activeWork', { active: sectionTitles.active }),
      })),
      everyTurns: Type.Optional(Type.Number({ description: t('param.everyTurns') })),
      role: Type.Optional(Type.String({ description: t('param.role') })),
      key: Type.Optional(Type.String({ description: t('param.key') })),
      sessionCompactChannel: Type.Optional(Type.Boolean({ description: t('param.sessionCompactChannel') })),
      systemPromptChannel: Type.Optional(Type.Boolean({ description: t('param.systemPromptChannel') })),
      periodicChannel: Type.Optional(Type.Boolean({ description: t('param.periodicChannel') })),
      randomReviewChannel: Type.Optional(Type.Boolean({ description: t('param.randomReviewChannel') })),
      block: Type.Optional(Type.String({ description: t('param.block') })),
      value: Type.Optional(Type.String({ description: t('param.value') })),
      todoItem: Type.Optional(
        Type.Union([Type.Number(), Type.String()], { description: t('param.todoItem') }),
      ),
      todoDone: Type.Optional(Type.Boolean({ description: t('param.todoDone') })),
      todoStatus: Type.Optional(Type.String({ description: t('param.todoStatus') })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ctxRef = ctx;

      if (params.key && sanitizeKey(params.key) !== key) {
        return {
          content: [{ type: 'text', text: t('error.sessionIsolated') }],
          details: { ok: false, error: 'session-key-mismatch' },
        };
      }

      // Disk is authoritative: a second process may have edited the card since the
      // last hook ran. Reload before validating or writing so this process can never
      // acknowledge a write that erases an external change from a stale cache.
      if (cardOrigin !== 'draft') loadCard();

      if (params.everyTurns !== undefined &&
          (!Number.isInteger(params.everyTurns) || params.everyTurns < 1 || params.everyTurns > MAX_INTERVAL_TURNS)) {
        return {
          content: [{ type: 'text', text: t('error.intervalRange', { max: MAX_INTERVAL_TURNS }) }],
          details: { ok: false, error: 'invalid-interval' },
        };
      }
      const hasBlock = params.block !== undefined;
      const hasTodo = params.todoItem !== undefined;
      if (params.value !== undefined && !hasBlock) {
        return {
          content: [{ type: 'text', text: t('error.orphanValue') }],
          details: { ok: false, error: 'orphan-param', parameter: 'value', requires: 'block' },
        };
      }
      if ((params.todoDone !== undefined || params.todoStatus !== undefined) && !hasTodo) {
        return {
          content: [{ type: 'text', text: t('error.orphanTodoState') }],
          details: { ok: false, error: 'orphan-param', requires: 'todoItem' },
        };
      }
      if (hasTodo && params.todoDone === undefined && params.todoStatus === undefined) {
        return {
          content: [{ type: 'text', text: t('error.todoStateMissing') }],
          details: { ok: false, error: 'todo-state-missing', allowed: ['todoDone', 'todoStatus'] },
        };
      }
      const allowedTodoStatuses = ['pending', 'in_progress', 'completed'];
      if (params.todoStatus !== undefined && !allowedTodoStatuses.includes(params.todoStatus)) {
        return {
          content: [{ type: 'text', text: t('error.invalidTodoStatus', { allowed: allowedTodoStatuses.join(', ') }) }],
          details: { ok: false, error: 'invalid-todo-status', allowed: allowedTodoStatuses },
        };
      }
      if (params.text !== undefined && (params.block !== undefined || params.activeWork !== undefined || params.todoItem !== undefined)) {
        return {
          content: [{ type: 'text', text: t('error.mutationConflict') }],
          details: { ok: false, error: 'incompatible-params' },
        };
      }
      if (params.block !== undefined && (params.activeWork !== undefined || params.todoItem !== undefined)) {
        return {
          content: [{ type: 'text', text: t('error.mutationConflict') }],
          details: { ok: false, error: 'incompatible-params' },
        };
      }
      let text = (params.text ?? '').trim();
      let workingCard = text || (card ?? '');

      if (params.activeWork !== undefined) {
        if (!workingCard || !params.activeWork.trim()) {
          return {
            content: [{ type: 'text', text: t('error.needCardAndCheckpoint') }],
            details: { ok: false, error: 'checkpoint-missing' },
          };
        }
        try {
          workingCard = currentScope().replaceActiveCheckpoint(workingCard, params.activeWork, scopeOpts);
          text = workingCard;
        } catch (err) {
          return {
            content: [{ type: 'text', text: (err as Error).message }],
            details: { ok: false, error: 'checkpoint-ambiguous' },
          };
        }
      }

      // BLOCK WRITES. The card is written IN BLOCKS so that saving the plan does not require
      // re-sending the objective, and — more importantly — so that a block write cannot drop a
      // section the caller never mentioned. A whole-card write is a full overwrite; this is the
      // narrow version of it. `block` + `value` replaces ONE section; `todoItem` ticks ONE item
      // of the list. Both need an EXISTING card: creating one from a single block would silently
      // discard whatever else the session had, which is the one thing a recovery mechanism must
      // never do. An unknown block is refused with the allowed list rather than guessed.
      if (params.block !== undefined) {
        if (!workingCard || cardOrigin === 'draft') {
          return {
            content: [{ type: 'text', text: t('error.needCardAndCheckpoint') }],
            details: { ok: false, error: 'card-missing' },
          };
        }
        const kind = String(params.block ?? '').trim().toLowerCase();
        const allowed = ['always', 'active', 'objective', 'plan', 'todo'];
        if (!allowed.includes(kind)) {
          return {
            content: [{ type: 'text', text: t('error.unknownBlock', { block: kind, allowed: allowed.join(', ') }) }],
            details: { ok: false, error: 'unknown-block', allowed },
          };
        }
        if (params.value === undefined) {
          return {
            content: [{ type: 'text', text: t('error.blockNeedsValue', { block: kind }) }],
            details: { ok: false, error: 'value-missing', allowed },
          };
        }
        try {
          workingCard = currentScope().replaceBlock(workingCard, kind, params.value, scopeOpts);
          text = workingCard;
        } catch (err) {
          return {
            content: [{ type: 'text', text: (err as Error).message }],
            details: { ok: false, error: 'block-refused' },
          };
        }
      }

      if (params.todoItem !== undefined) {
        if (!workingCard || cardOrigin === 'draft') {
          return {
            content: [{ type: 'text', text: t('error.needCardAndCheckpoint') }],
            details: { ok: false, error: 'card-missing' },
          };
        }
        const state = params.todoStatus ?? params.todoDone;
        if (state === undefined) {
          return {
            content: [{ type: 'text', text: t('error.todoStateMissing') }],
            details: { ok: false, error: 'todo-state-missing', allowed: ['todoDone', 'todoStatus'] },
          };
        }
        try {
          workingCard = currentScope().checkTodo(workingCard, params.todoItem, state, scopeOpts);
          text = workingCard;
        } catch (err) {
          return {
            content: [{ type: 'text', text: (err as Error).message }],
            details: { ok: false, error: 'block-refused' },
          };
        }
      }
      if (!text) {
        return {
          content: [
            {
              type: 'text',
              text: card
                ? t('info.currentCard', { chars: card.length, origin: cardOrigin, key, card })
                : t('info.noCardForKey', { key }),
            },
          ],
          details: { ok: true, action: 'read', key, chars: card?.length ?? 0 },
        };
      }

      if (text.length > MAX_CARD_CHARS) {
        return {
          content: [{ type: 'text', text: t('error.cardTooLong', { len: text.length, max: MAX_CARD_CHARS }) }],
          details: { ok: false, error: 'card-too-long' },
        };
      }

      // The key identifies the session: updating the existing file avoids stale copies.
      const target = globalCardPath();

      try {
        if (fs.existsSync(target)) writeText(`${target}.bak`, readText(target) ?? '');
        // Do not publish an incomplete card to memory nor to disk.
        writeText(`${target}.tmp`, text);
        fs.renameSync(`${target}.tmp`, target);
      } catch (err) {
        try { fs.unlinkSync(`${target}.tmp`); } catch { /* noop */ }
        return {
          content: [{ type: 'text', text: t('error.cardUnchanged', { err: (err as Error).message }) }],
          details: { ok: false, error: 'write-failed' },
        };
      }
      card = text;
      cardPath = target;
      cardOrigin = 'memory';
      cfg.generation += 1;
      // A WRITE IS A REVISION. The age resets, and the review countdown restarts with it:
      // changing the card IS the revision, so a review that was about to fire is no longer
      // about to fire — the material it would have examined has just been rewritten. Without
      // this the review arrives one turn after an edit and re-reads what was just written,
      // which is the definition of noise.
      lastUpdateTurn = turns;
      randomTarget = turns + pickRandomTarget();
      cardLog(`WRITE: ${card.length} chars, generation ${cfg.generation}, review re-armed for turn ${randomTarget}`);
      if (params.everyTurns !== undefined) setIntervalTurns(params.everyTurns);
      if (params.role) cfg.role = params.role;
      if (typeof params.sessionCompactChannel === 'boolean') cfg.onCompact = params.sessionCompactChannel;
      if (typeof params.systemPromptChannel === 'boolean') cfg.systemPromptChannel = params.systemPromptChannel;
      if (typeof params.periodicChannel === 'boolean') cfg.periodicChannel = params.periodicChannel;
      if (typeof params.randomReviewChannel === 'boolean') cfg.randomReviewChannel = params.randomReviewChannel;
      cfg.cwd = ctx.cwd ?? process.cwd();
      cfg.active = true;
      cfg.chars = card.length;
      const registrySaved = persistConfig(true);
      bootstrapped = true;
      renderWidget();

      const channels = [];
      if (cfg.onCompact) channels.push(t('info.channelCompact'));
      if (cfg.periodicChannel) channels.push(t('info.channelPeriodic', { turns: cfg.everyTurns }));
      if (cfg.systemPromptChannel) channels.push(t('info.channelSystemPrompt'));
      if (cfg.randomReviewChannel) channels.push(t('info.channelRandomReview'));
      return {
        content: [
          {
            type: 'text',
            text:
              t('info.cardSavedFull', {
                saved: registrySaved ? t('info.cardSaved') : t('info.cardSavedRegistryFail'),
                chars: card.length, key, generation: cfg.generation,
              }) +
              (channels.length ? `${t('info.reinjectionActive', { channels: channels.join(' + ') })}\n` : '') +
              t('info.cardFile', { target }),
          },
        ],
        details: { ok: registrySaved, action: 'write', key, chars: card.length, generation: cfg.generation, ...(registrySaved ? {} : { error: 'registry-failed', cardSaved: true }) },
      };
    },
  });

  // ---------------------------------------------------------------- commands

  function invalidateActiveCard(): void {
    card = null;
    cardPath = null;
    cardOrigin = 'global';
    cfg.bootstrap = true;
    bootstrapped = false;
    pendingPeriodic = pendingManual = pendingResume = pendingHeartbeat = pendingPostCompact = pendingRandomReview = false;
    activeGate = null;
    renderWidget();
  }

  function status(): string {
    if (!card) return t('warn.cardAbsent', { key });
    const remaining = cfg.everyTurns - (turns % cfg.everyTurns);
    return [
      cfg.active ? t('status.on', { key }) : t('status.off', { key }),
      t('status.cardLine', { chars: card.length, origin: cardOrigin, draft: cardOrigin === 'draft' ? t('status.draftNote') : '', generation: cfg.generation }),
      cardPath ? `  ${cardPath}` : t('status.notOnDisk'),
      t('status.sessionCompact', { state: cfg.onCompact ? t('status.ephemeral') : t('status.channelOff') }),
      t('status.systemPrompt', { state: cfg.systemPromptChannel ? t('status.channelOn') : t('status.channelOff') }),
      t('status.periodic', { state: cfg.periodicChannel ? t('status.periodicOn', { turns: cfg.everyTurns, remaining }) : t('status.channelOff') }),
      t('status.randomReview', { state: cfg.randomReviewChannel ? t('status.channelOn') : t('status.channelOff') }),
      t('status.gate', { state: cfg.gate ? t('status.channelOn') : t('status.channelOff') }) + (gateViolations > 0 ? t('status.gateViolations', { count: gateViolations }) : ''),
      t('status.turns', { turns }),
    ].join('\n');
  }

  pi.registerCommand('card', {
    description: t('command.description'),
    handler: async (args, ctx) => {
      ctxRef = ctx;
      // Commands can read or write the card too; never operate on stale memory.
      if (cardOrigin !== 'draft') loadCard();
      const parts = (args ?? '').trim().split(/\s+/).filter(Boolean);
      const action = (parts[0] ?? '').toLowerCase();

      switch (action) {
        case '':
        case 'status':
          ctx.ui.notify(status(), 'info');
          return;

        case 'blocks': {
          // A STRUCTURED VIEW of the card. "Which sections exist, and how big is each" is the
          // question the block API raises and the full card does not answer at a glance: reading
          // the whole thing tells you what it says, not how it is divided.
          if (!card) {
            ctx.ui.notify(t('warn.cardAbsent', { key }), 'warning');
            return;
          }
          // CAPTURED IN A CONST, and that is not cosmetic. `card` is a mutable module-level
          // binding: the `if (!card) return` above narrows it to `string` HERE, but TypeScript
          // widens it back inside the closure below, because a callback can run after `card` has
          // changed. Assigning to a `const` makes the narrowing survive the closure.
          const text = card;
          const headings = [...text.matchAll(/^##[ \t]+(.+)$/gm)];
          if (headings.length === 0) {
            ctx.ui.notify(t('command.blocksNone', { chars: text.length }), 'info');
            return;
          }
          const rows = headings.map((h, i) => {
            const start = (h.index ?? 0) + h[0].length;
            const end = i + 1 < headings.length ? (headings[i + 1].index ?? text.length) : text.length;
            return t('command.blockLine', { title: h[1].trim(), chars: text.slice(start, end).trim().length });
          });
          ctx.ui.notify(
            [t('command.blocksHeader', { total: text.length, count: headings.length }), ...rows].join('\n'),
            'info',
          );
          return;
        }

        case 'regenerate': {
          const target = globalCardPath();
          try {
            if (fs.existsSync(target)) {
              writeText(`${target}.bak`, readText(target) ?? '');
              fs.unlinkSync(target); // on resume the superseded card must not come back
            }
          } catch (err) {
            ctx.ui.notify(t('error.regenerateCancelled', { err: (err as Error).message }), 'error');
            return;
          }
          card = null;
          cardPath = null;
          cfg.bootstrap = true;
          bootstrapped = false;
          turns = 0;
          pendingPeriodic = pendingManual = pendingResume = pendingHeartbeat = pendingPostCompact = pendingRandomReview = false;
          const saved = persistConfig();
          renderWidget();
          if (!saved) ctx.ui.notify(t('warn.registryNotSaveable'), 'error');
          ctx.ui.notify(t('info.cardArchived'), 'info');
          return;
        }

        case 'every': {
          const n = Number(parts[1]);
          if (!Number.isInteger(n) || n < 1 || n > MAX_INTERVAL_TURNS) {
            ctx.ui.notify(t('error.usageEveryN', { max: MAX_INTERVAL_TURNS }), 'warning');
            return;
          }
          setIntervalTurns(n);
          const saved = persistConfig();
          renderWidget();
          if (!saved) ctx.ui.notify(t('info.intervalNotSaveable'), 'error');
          ctx.ui.notify(t('info.intervalSet', { turns: cfg.everyTurns }), 'info');
          return;
        }

        case 'on':
        case 'off': {
          // /card on|off -> master switch
          cfg.active = action === 'on';
          const saved = persistConfig();
          renderWidget();
          if (!saved) ctx.ui.notify(t('info.toggleNotSaveable'), 'error');
          ctx.ui.notify(cfg.active ? t('info.enabled', { key }) : t('info.disabled', { key }), 'info');
          return;
        }

        case 'session_compact':
        case 'system_prompt':
        case 'periodic':
        case 'randomreview':
        case 'gate': {
          // /card <channel> [on|off] -> toggle the single channel.
          // With no argument it shows the channel state.
          const field = CHANNEL_FIELDS[action];
          const sub = (parts[1] ?? '').toLowerCase();
          if (sub === 'on' || sub === 'off') {
            cfg[field] = sub === 'on';
            if (action === 'randomreview' && sub === 'on') {
              pendingRandomReview = false;
              randomTarget = turns + pickRandomTarget();
            }
            const saved = persistConfig();
            renderWidget();
            if (!saved) ctx.ui.notify(t('info.channelNotSaveable'), 'error');
            ctx.ui.notify(t('info.channelOnOff', { channel: action, state: sub === 'on' ? 'ON' : 'OFF', key }), 'info');
            return;
          }
          if (action === 'gate' && activeGate) {
            ctx.ui.notify(
              t('gate.activeStatus', { channel: activeGate.channel, turn: activeGate.turn, attempts: activeGate.attempts, max: GATE_MAX_ATTEMPTS }) +
                (gateViolations > 0 ? `\n${t('gate.violationsLine', { count: gateViolations })}` : ''),
              'error',
            );
            return;
          }
          ctx.ui.notify(t('info.channelState', { channel: action, state: cfg[field] ? 'ON' : 'OFF', key }), 'info');
          return;
        }

        case 'now': {
          if (!card) {
            ctx.ui.notify(t('warn.nothingToInject'), 'warning');
            return;
          }
          pendingManual = true;
          ctx.ui.notify(t('info.cardReady'), 'info');
          return;
        }

        case 'project': {
          if (!card) {
            ctx.ui.notify(t('warn.nothingToCopy'), 'warning');
            return;
          }
          const dest = path.join(ctx.cwd ?? process.cwd(), PROJECT_SUBDIR, 'card.md');
          try {
            writeText(dest, card);
            ctx.ui.notify(t('info.copyCreated', { dest }), 'info');
          } catch (err) {
            ctx.ui.notify(t('error.copyFailed', { err: (err as Error).message }), 'error');
          }
          return;
        }

        case 'bootstrap': {
          const target = globalCardPath();
          try {
            if (fs.existsSync(target)) {
              writeText(`${target}.bak`, readText(target) ?? '');
              fs.unlinkSync(target);
            }
          } catch (err) {
            ctx.ui.notify(t('error.bootstrapCancelled', { err: (err as Error).message }), 'error');
            return;
          }
          cfg.bootstrap = true;
          bootstrapped = false;
          pendingPeriodic = pendingManual = pendingResume = pendingHeartbeat = pendingPostCompact = pendingRandomReview = false;
          loadCard(true); // explicit draft, never re-injected as a personal card
          const saved = persistConfig();
          renderWidget();
          if (!saved) ctx.ui.notify(t('warn.registryNotSaveable'), 'error');
          ctx.ui.notify(t('warn.bootstrapForced'), 'warning');
          return;
        }

        case 'list': {
          const cards = globalRegistry();
          const entries = Object.entries(cards);
          if (entries.length === 0) {
            ctx.ui.notify(t('info.noCards'), 'info');
            return;
          }
          const lines = entries.map(([k, c]) => {
            const date = c.updatedAt ? new Date(c.updatedAt).toLocaleString(lang === 'it' ? 'it-IT' : 'en-US') : t('info.neverUpdated');
            return t('info.registryLine', { key: k, generation: c.generation, chars: c.chars, date });
          });
          ctx.ui.notify(t('info.cardsInRegistry', { count: entries.length, list: lines.join('\n') }), 'info');
          return;
        }

        case 'delete': {
          // Keep the raw remainder: whitespace in a key is invalid, but it must be
          // rejected as such rather than silently searching only its first word.
          const targetKey = (args ?? '').trim().replace(/^delete(?:\s+|$)/i, '').trim();
          if (!targetKey) {
            ctx.ui.notify(t('error.deleteNeedsKey'), 'warning');
            return;
          }
          // The command also reads historical keys: never use them directly in path.join
          // without preventing traversal (../, slash, absolute paths).
          if (!/^[a-z0-9][a-z0-9._-]{0,59}$/.test(targetKey)) {
            ctx.ui.notify(t('error.invalidKey'), 'error');
            return;
          }
          const cardFile = path.join(CARDS_DIR, `${targetKey}.md`);
          let missing = false;
          let removed = false;
          const saved = withRegistryLock(() => {
            const cards = globalRegistry();
            if (!cards[targetKey] && !fs.existsSync(cardFile)) {
              missing = true;
              return true;
            }
            if (fs.existsSync(cardFile)) fs.unlinkSync(cardFile);
            removed = true;
            delete cards[targetKey];
            return writeRegistry(cards);
          });
          if (missing) {
            ctx.ui.notify(t('warn.cardNotInRegistry', { key: targetKey }), 'warning');
            return;
          }
          if (removed && targetKey === key) invalidateActiveCard();
          if (!saved) {
            ctx.ui.notify(t('error.deleteIncomplete'), 'error');
            return;
          }
          ctx.ui.notify(t('info.cardDeleted', { key: targetKey }), 'info');
          return;
        }

        case 'purge': {
          const hours = parts[1] === undefined ? 48 : Number(parts[1]);
          if (!Number.isFinite(hours) || hours <= 0) {
            ctx.ui.notify(t('error.usagePurge'), 'warning');
            return;
          }
          const cutoff = Date.now() - hours * 3600 * 1000;
          let removed = 0;
          let matched = 0;
          let activeRemoved = false;
          const saved = withRegistryLock(() => {
            const cards = globalRegistry();
            const toDelete = Object.entries(cards).filter(([, c]) => c.updatedAt < cutoff);
            matched = toDelete.length;
            if (matched === 0) return true;
            for (const [k] of toDelete) {
              // The registry may have been edited by hand: no invalid
              // key may become a path to delete.
              if (!/^[a-z0-9][a-z0-9._-]{0,59}$/.test(k)) continue;
              const cardFile = path.join(CARDS_DIR, `${k}.md`);
              try {
                if (fs.existsSync(cardFile)) fs.unlinkSync(cardFile);
              } catch {
                continue; // do not declare a card deleted while still on disk
              }
              delete cards[k];
              if (k === key) activeRemoved = true;
              removed++;
            }
            return writeRegistry(cards);
          });
          if (activeRemoved) invalidateActiveCard();
          if (!saved) {
            ctx.ui.notify(t('error.purgeIncomplete', { removed }), 'error');
            return;
          }
          if (matched === 0) {
            ctx.ui.notify(t('warn.purgeNothing', { hours }), 'info');
            return;
          }
          ctx.ui.notify(t('info.purgeDone', { removed, hours }), 'info');
          return;
        }

        default:
          ctx.ui.notify(t('warn.actionsHelp'), 'warning');
      }
    },
  });
}
