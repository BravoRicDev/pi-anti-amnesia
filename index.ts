/**
 * pi-anti-amnesia — Il Custode della carta di memoria auto-scritta.
 *
 * PROBLEMA
 *   Le strategie anti-amnesia scritte nei prompt ("dopo ogni compattazione
 *   rileggi base.md") vivono in *prompt-space*: chiedono al modello di
 *   accorgersi della compattazione e di obbedire. Dopo una compaction il
 *   modello spesso non sa nemmeno che e' avvenuta. Compliance soft = fallisce.
 *
 * SOLUZIONE
 *   Spostare l'anti-amnesia in *hook-space*: iniezione deterministica, non
 *   negoziabile, esattamente come fa la compressione di Pi.
 *
 *   Fase 1 BOOTSTRAP  — a sessione nuova, mentre l'agente e' "fresco"
 *                       (contesto completo, sa il suo ruolo), gli si chiede di
 *                       scriversi DA SOLO la carta: testo verbatim con ruolo
 *                       esatto e path assoluti. Nessuna parafrasi, nessuna perdita.
 *   Fase 2 CARTA      — l'agente la deposita col tool `carta_memoria`.
 *                       L'estensione la persiste in un registro condiviso.
 *   Fase 3 CUSTODE    — l'estensione reinietta la carta per conto proprio,
 *                       senza piu' chiedere nulla al modello, su canali
 *                       INDIPENDENTI e configurabili:
 *                         a) onCompact         — dopo ogni compattazione (ancora)
 *                         b) canalePeriodico   — refresh ogni N turni
 *                         c) canaleSystemPrompt — presenza nel system prompt
 *                         d) canaleRandomReview — revisione a intervallo casuale
 *                         e) bootstrap         — chiede la carta a sessione nuova
 *                         f) gate              — conferma obbligatoria ([CARTA OK])
 *
 *   DEFAULT: compattazione, refresh periodico e revisione casuale sono attivi.
 *   I contenuti delle carte vengono separati per topic: le regole permanenti
 *   restano disponibili, i dettagli topic-specifici entrano solo se pertinenti.
 *
 *   Il "fresco" e' verificabile: in `before_agent_start` Pi passa
 *   `systemPromptOptions` con `contextFiles` (path ASSOLUTI di base.md/AGENTS.md),
 *   `customPrompt` (ruolo), `cwd`. L'estensione usa quei dati come verita'
 *   di base da consegnare all'agente, cosi' la carta nasce ancorata al reale.
 *
 * REGISTRO (come i cronjob, gemello di ~/.pi/timers/active-timers.json)
 *   ~/.pi/anti-amnesia/registry.json      -> una entry per chiave/sessione
 *   ~/.pi/anti-amnesia/cards/<chiave>.md  -> carta isolata per sessione Pi
 *   <progetto>/.pi/anti-amnesia/config.json -> override dei canali di schedulazione
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
const GATE_MAX_TENTATIVI = 3;
const FORMATO_CARTA_OK = /\[CARTA OK\] chiave=(\S+) ruolo=(\S+) turno=(\d+)/;

// __dirname equivalent in ESM: directory of this source file (the extension).
const _EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
// Config globale condiviso (sincronizzato via PiAgent, co-located con l'estensione).
// Precedenza: DEFAULTS ← global ← registry[chiave] ← project.
const GLOBAL_CONFIG = path.join(_EXT_DIR, 'config.json');

// Seed condiviso, usato solo su richiesta esplicita di bootstrap.
// Priorita': env -> config.baseCard -> carta inclusa per la lingua attiva -> legacy.
function draftCandidates(baseCard: string, lang: string): string[] {
  return [
    process.env.PI_ANTI_AMNESIA_DRAFT ?? '',
    baseCard,
    path.join(_EXT_DIR, 'cards', `base.${lang}.md`),
    path.join(os.homedir(), 'PiAgent', 'prompts', 'carta-anti-amnesia.md'),
  ].filter((p) => p.length > 0);
}

type Canale = 'effimero' | 'persistente';

interface CardConfig {
  /** Intervallo di reiniezione periodica, in turni. */
  ogniTurni: number;
  /** Abilita bootstrap Fase 1: chiede all'agente di scriversi la carta. */
  bootstrap: boolean;
  /** Abilita iniezione nel system prompt (canale c). */
  canaleSystemPrompt: boolean;
  /** Abilita refresh periodico ogni N turni (canale b). */
  canalePeriodico: boolean;
  /** Abilita revisione casuale (canale casuale). */
  canaleRandomReview: boolean;
  /** Abilita iniezione dopo compattazione (canale a). */
  onCompact: boolean;
  /** Abilita gate di conferma obbligatoria. */
  gate: boolean;
  /** Interruttore generale. */
  attivo: boolean;
  /** Ruolo dichiarato nella carta (informativo). */
  ruolo?: string;
  cwd?: string;
  generazione: number;
  updatedAt: number;
  chars: number;
  /** Modalità legacy nel registro; i refresh programmati usano sempre context effimero. */
  periodico: Canale;
  /** Modalità legacy nel registro; la compattazione usa sempre context effimero. */
  compaction: Canale;
  /** 'auto' | 'it' | 'en'. 'auto' la deriva dal locale di sistema, congelata per sessione. */
  language: string;
  /** Percorso esplicito di una carta base. Vuoto = usa cards/base.<lingua>.md inclusa. */
  baseCard: string;
}

const DEFAULTS: CardConfig = {
  ogniTurni: 15,
  bootstrap: true,
  canaleSystemPrompt: false,
  canalePeriodico: true,
  canaleRandomReview: true,
  onCompact: true,
  gate: false,
  attivo: true,
  generazione: 0,
  updatedAt: 0,
  chars: 0,
  // default effimero: nessun accumulo nel transcript, stessa copertura.
  periodico: 'effimero',
  // L'hook context garantisce consegna sul retry post-compattazione senza transcript stale.
  compaction: 'effimero',
  // 'auto' = deriva da PI_ANTI_AMNESIA_LANG / LC_ALL / LC_MESSAGES / LANG / Intl.
  language: 'auto',
  // Vuoto = usa cards/base.<lingua>.md inclusa nell'estensione.
  baseCard: '',
};

/**
 * Lingua grezza, letta PRIMA del merge completo e senza dipendere da `key`.
 * Gli argomenti sono in ordine di precedenza crescente: l'ultimo che dichiara
 * `language` vince, esattamente come nel merge { ...cfg, ...parsed }.
 * Senza questo, un `language` messo nella config di progetto verrebbe ignorato
 * in silenzio mentre ogni altra chiave di project config viene onorata.
 */
function readRawLanguage(...configPaths: string[]): string {
  let language = 'auto';
  for (const p of configPaths) {
    const raw = readText(p);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as { language?: unknown };
      if (typeof parsed.language === 'string') language = parsed.language;
    } catch { /* config invalida: si ignora, come nel merge principale */ }
  }
  return language;
}

// Mappa nome-canale (comando /carta) -> campo di configurazione.
const CANALE_CAMPI: Record<
  string,
  'onCompact' | 'canaleSystemPrompt' | 'canalePeriodico' | 'canaleRandomReview' | 'gate'
> = {
  session_compact: 'onCompact',
  system_prompt: 'canaleSystemPrompt',
  periodico: 'canalePeriodico',
  random_review: 'canaleRandomReview',
  gate: 'gate',
};

// ---------------------------------------------------------------- utilita'

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
    /* registro corrotto: si riparte */
  }
  return {};
}

function writeRegistry(cards: Record<string, CardConfig>): boolean {
  ensureDirs();
  const temp = `${REGISTRY_FILE}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeText(temp, JSON.stringify({ version: 1, cards }, null, 2));
    fs.renameSync(temp, REGISTRY_FILE); // mai esporre un JSON scritto a metà
    return true;
  } catch {
    try { fs.unlinkSync(temp); } catch { /* cleanup best effort */ }
    return false;
  }
}

/** Lock cross-process su TUTTO il read-modify-write, non solo sul rename. */
function withRegistryLock(update: () => boolean): boolean {
  ensureDirs();
  const lockPath = `${REGISTRY_FILE}.lock`;
  let fd: number | undefined;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeSync(fd, `${process.pid}\n`); // diagnosi di lock orfani
      } catch {
        try { fs.closeSync(fd); fs.unlinkSync(lockPath); } catch { /* noop */ }
        return false;
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      Atomics.wait(pause, 0, 0, 20); // attesa massima ~800 ms, poi errore esplicito
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

// ---------------------------------------------------------------- estensione

export default function (pi: ExtensionAPI) {
  let ctxRef: ExtensionContext | undefined;
  // /reload deve leggere la versione NUOVA dell'helper ESM: gli import statici
  // possono restare nella cache del processo, rompendo persino carta_memoria.
  let scope: typeof TopicScope | undefined;
  function currentScope(): typeof TopicScope {
    if (!scope) throw new Error(t('error.helperUninitialized'));
    return scope;
  }
  let key = 'default';
  let card: string | null = null;
  let cardPath: string | null = null;
  let cardOrigin: 'progetto' | 'globale' | 'memoria' | 'bozza' = 'globale';
  let latestUserInput = '';
  let cfg: CardConfig = { ...DEFAULTS };
  // Lingua congelata per tutta la sessione: l'LLM non deve mai vedere il
  // contesto cambiare lingua a meta' conversazione (causa tipica: output ibrido).
  let lang = 'en';
  let t: (key: string, vars?: Record<string, string | number>) => string = (key) => `[${key}]`;
  let scopeOpts: Record<string, unknown> = {};
  // Titoli canonici delle sezioni e catalogo grezzo, per i prompt composti.
  let sectionTitles = { always: 'Always valid', active: 'Active work', topic: 'Topic' };
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
  let gateAttivo: { canale: string; turno: number; tentativi: number } | null = null;
  let gateViolazioni: number = 0;
  let gateLastViolationTurn = 0;
  const GATE_COOLDOWN_TURNI = 5;

  let projectConfigPath = '';

  const globalCardPath = () => path.join(CARDS_DIR, `${key}.md`);
  const globalRegistry = () => readRegistry();

  // ---- caricamento ----

  function loadCard(soloBozza = false): void {
    if (!soloBozza) {
      // Le carte di progetto non vengono caricate: potrebbero appartenere a un altro ruolo/chat.
      const fromGlobal = readText(globalCardPath());
      if (fromGlobal && fromGlobal.trim()) {
        card = fromGlobal;
        cardPath = globalCardPath();
        cardOrigin = 'globale';
        return;
      }
    }
    // La bozza condivisa è caricabile solo durante un bootstrap esplicito.
    // Mai reiniettarla come fallback silenzioso in chat prive di carta.
    if (soloBozza) {
      for (const cand of draftCandidates(cfg.baseCard, lang)) {
        const draft = readText(cand);
        if (draft && draft.trim()) {
          card = draft;
          cardPath = cand;
          cardOrigin = 'bozza';
          return;
        }
      }
    }
    card = null;
    cardPath = null;
  }


  function loadConfig(): void {
    cfg = { ...DEFAULTS };
    // 1) Config globale condiviso (sincronizzato via PiAgent, co-located con l'estensione).
    const fromGlobal = readText(GLOBAL_CONFIG);
    if (fromGlobal) {
      try {
        const parsed = JSON.parse(fromGlobal);
        if (parsed && typeof parsed === 'object') cfg = { ...cfg, ...parsed };
      } catch { /* config globale invalida: si ignora */ }
    }
    // 2) Registro della sessione (sovrascrive il globale).
    const stored = globalRegistry()[key];
    cfg = { ...cfg, ...(stored ?? {}) };
    // 3) Config di progetto (vince su tutto).
    const fromProject = readText(projectConfigPath);
    if (fromProject) {
      try {
        const parsed = JSON.parse(fromProject);
        if (parsed && typeof parsed === 'object') cfg = { ...cfg, ...parsed };
      } catch { /* config di progetto invalida: si ignora */ }
    }
    if (!Number.isFinite(cfg.ogniTurni) || cfg.ogniTurni < 1 || cfg.ogniTurni > MAX_INTERVAL_TURNS) cfg.ogniTurni = DEFAULTS.ogniTurni;
    cfg.ogniTurni = Math.floor(cfg.ogniTurni);
    for (const field of ['bootstrap', 'canaleSystemPrompt', 'canalePeriodico', 'canaleRandomReview', 'onCompact', 'gate', 'attivo'] as const) {
      if (typeof cfg[field] !== 'boolean') cfg[field] = DEFAULTS[field];
    }
    if (cfg.periodico !== 'effimero' && cfg.periodico !== 'persistente') cfg.periodico = DEFAULTS.periodico;
    if (cfg.compaction !== 'effimero' && cfg.compaction !== 'persistente') cfg.compaction = DEFAULTS.compaction;
    if (typeof cfg.ruolo !== 'string') delete cfg.ruolo;
    if (typeof cfg.cwd !== 'string') delete cfg.cwd;
  }

  /** Impostazioni di installazione, non di sessione: non vanno nel registro. */
  const INSTALL_KEYS = ['language', 'baseCard'] as const;

  function persistConfig(cardWritten = false): boolean {
    return withRegistryLock(() => {
      const cards = globalRegistry();
      // language/baseCard vivono in config.json e valgono per tutte le sessioni.
      // Scriverli qui li congelerebbe: loadConfig fa vincere il registro sulla
      // config globale, quindi un cambio successivo di config.json non avrebbe
      // piu' effetto su questa sessione. Vanno esclusi, non sovrascritti.
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
    const N = cfg.ogniTurni;
    return N + Math.floor(Math.random() * (N + 1)); // N … 2N inclusi
  }

  function setIntervalTurns(value: number): void {
    cfg.ogniTurni = Math.floor(value);
    periodicTurns = 0;
    pendingPeriodic = false;
    pendingHeartbeat = false;
    pendingRandomReview = false;
    randomTarget = turns + pickRandomTarget();
  }

  /** Normalizza il content di un messaggio (stringa | array di blocchi | altro) a testo puro. */
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
    const match = contentToText(content).match(FORMATO_CARTA_OK);
    if (!match) return false;
    if (match[1] !== key) return false;
    if (cfg.ruolo && match[2] !== cfg.ruolo) return false;
    if (parseInt(match[3], 10) !== turns) return false;
    return true;
  }

  // ---- iniezione ----

  function cardBlock(reason: string): string {
    if (!card || cardOrigin === 'bozza') return '';
    const scoped = currentScope().selectCardForTopic(card, latestUserInput, scopeOpts);
    if (!scoped.text) return '';
    const warning = scoped.legacy
      ? t('scope.legacyHint')
      : t('scope.checkpointHint');
    const unclassified = scoped.unclassified.length
      ? t('scope.unclassifiedHint', { list: scoped.unclassified.slice(0, 3).join(', ') })
      : '';
    return `[ANTI-AMNESIA \u00b7 ${reason}]\n${scoped.text}${warning}${unclassified}`;
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
        theme.fg('warning', `\u26a0 CARTA ${label} assente \u2014 bootstrap al prossimo turno`),
      ]);
      return;
    }

    const restanti = cfg.ogniTurni - (periodicTurns % cfg.ogniTurni);
    const restanteCasuale = randomTarget - turns;
    const etaTurni = turns - lastUpdateTurn;
    const etaStr = `${etaTurni}t`;
    const canali = [
      cfg.onCompact ? 'compattazione↓ (effimero)' : 'compattazione off',
      cfg.canalePeriodico ? `ogni ${cfg.ogniTurni}t (tra ${restanti})` : 'periodico off',
      cfg.canaleRandomReview ? `revisione (tra ${restanteCasuale}t)` : 'revisione off',
      cfg.canaleSystemPrompt ? 'sysprompt' : 'sysprompt off',
      `eta: ${etaStr}`,
    ].join(' \u00b7 ');

    const stato = cfg.attivo ? '' : theme.fg('warning', ' \u00b7 SPENTA');
    const gateInfo = gateAttivo
      ? theme.fg('error', ` \u00b7 GATE ${gateAttivo.tentativi}/${GATE_MAX_TENTATIVI} (${gateAttivo.canale})`)
      : '';
    const violazioni = gateViolazioni > 0
      ? theme.fg('error', ` \u00b7 VIOLAZIONI: ${gateViolazioni}`)
      : '';
    ctx.ui.setWidget(WIDGET_KEY, [
      theme.fg('accent', `\u26e8 CARTA ${label} `) +
        theme.fg('dim', `${card.length} char \u00b7 ${cardOrigin} \u00b7 `) +
        theme.fg('muted', canali) +
        stato +
        gateInfo +
        violazioni,
    ]);
  }

  function clearWidget(): void {
    const ctx = ctxRef;
    if (ctx && ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
  }

  // ---- bootstrap: l'agente si scrive la carta da fresco ----

  /** Sottoinsieme strutturale di BuildSystemPromptOptions: nessun cast necessario. */
  interface ContestoFresco {
    customPrompt?: string;
    cwd?: string;
    contextFiles?: Array<{ path: string }>;
    selectedTools?: string[];
  }

  function bootstrapMessage(o: ContestoFresco): string {
    const files = o.contextFiles ?? [];
    const elencoFile = files.length
      ? files.map((f) => `  - ${f.path}`).join('\n')
      : t('bootstrap.noContextFiles');
    const strumenti = o.selectedTools ?? [];
    const bozzaAttiva = cardOrigin === 'bozza' && Boolean(card);


    const bt = scopeI18n.bootstrap as Record<string, unknown> | undefined;
    // Una chiave di array sbagliata degraderebbe in silenzio: il prompt perderebbe
    // righe e nessuno se ne accorgerebbe. Fallo rumore, come t().
    const missing = (key: string) => [`[missing i18n key: ${key} (${lang})]`];
    const rows = (key: string): string[] =>
      Array.isArray(bt?.[key]) ? (bt[key] as string[]) : missing(`bootstrap.${key}`);
    const vars = { cwd: o.cwd ?? ctxRef?.cwd ?? '?', path: cardPath ?? '', active: sectionTitles.active, topic: sectionTitles.topic, always: sectionTitles.always };

    return [
      typeof bt?.header === 'string' ? bt.header : '[ANTI-AMNESIA]',
      ...interpolateAll(rows('intro'), vars),
      bozzaAttiva ? t('bootstrap.draftLoaded', { path: cardPath ?? '' }) : '',
      '',
      t('bootstrap.detected'),
      t('bootstrap.cwd', { cwd: vars.cwd }),
      t('bootstrap.rolePromptLoaded', { value: o.customPrompt ? t('bootstrap.rolePromptCustom') : t('bootstrap.rolePromptNone') }),
      t('bootstrap.contextFiles'),
      elencoFile,
      strumenti.length ? t('bootstrap.activeTools', { tools: strumenti.join(', ') }) : '',
      '',
      ...interpolateAll(rows('keyNotice'), vars),
      '',
      t('bootstrap.structure'),
      t('bootstrap.sectionAlways', { always: sectionTitles.always }),
      t('bootstrap.sectionActive', { active: sectionTitles.active }),
      ...interpolateAll(rows('sectionActiveNote'), vars),
      t('bootstrap.sectionTopic', { topic: sectionTitles.topic }),
      t('bootstrap.topicWarning', { topic: sectionTitles.topic }),
      ...interpolateAll(rows('handoff'), vars),
      '',
      t('bootstrap.closing'),
    ]
      .filter((l) => l !== '')
      .join('\n');
  }

  // ---------------------------------------------------------------- eventi

  pi.on('session_start', async (_event, ctx) => {
    ctxRef = ctx;
    const cwd = ctx.cwd ?? process.cwd();
    // Serve PRIMA dell'i18n: la lingua deve poter venire dalla config di progetto.
    projectConfigPath = path.join(cwd, PROJECT_SUBDIR, 'config.json');
    // Ogni runtime/reload usa un URL distinto: niente helper vecchio dalla cache ESM.
    const helperUrl = new URL('./topic-scope.mjs', import.meta.url);
    const helperSource = readText(fileURLToPath(helperUrl));
    if (helperSource === null) throw new Error(t('error.helperUnreadable'));
    // Hash del contenuto: stesso codice riusa la cache; una modifica la invalida.
    // Evita un modulo ESM nuovo a ogni resume lungo senza cambiamenti del file.
    helperUrl.searchParams.set('version', createHash('sha256').update(helperSource).digest('hex').slice(0, 16));
    scope = await import(helperUrl.href) as typeof TopicScope;
    if (typeof scope.replaceActiveCheckpoint !== 'function' || typeof scope.selectCardForTopic !== 'function' ||
        typeof scope.extractLatestUserText !== 'function') {
      throw new Error(t('error.helperIncompatible'));
    }

    // i18n: stesso cache-busting dell'helper, cosi' un catalogo modificato e un
    // /reload lo ricaricano davvero invece di servire la copia in cache ESM.
    const i18nUrl = new URL('./i18n.mjs', import.meta.url);
    const i18nSource = readText(fileURLToPath(i18nUrl));
    if (i18nSource === null) throw new Error(t('error.helperUnreadable'));
    i18nUrl.searchParams.set('version', createHash('sha256').update(i18nSource).digest('hex').slice(0, 16));
    const i18n = await import(i18nUrl.href) as typeof I18n;
    lang = i18n.resolveLanguage(readRawLanguage(GLOBAL_CONFIG, projectConfigPath));
    t = i18n.makeT(lang);
    sectionTitles = i18n.sectionTitles(lang);
    // SAFETY: loadCatalog restituisce un oggetto JSON arbitrario; lo trattiamo come
    // record di sezioni e le chiavi mancanti sono tollerate da interpolateAll.
    scopeI18n = i18n.loadCatalog(lang) as unknown as Record<string, unknown>;
    interpolateAll = i18n.interpolateAll;
    scopeOpts = {
      aliases: i18n.sectionAliases(lang),
      activeTitle: sectionTitles.active,
      exactlyOneActive: t('error.exactlyOneActive'),
      locale: lang === 'it' ? 'it-IT' : 'en-US',
    };

    const sessionId = ctx.sessionManager.getSessionId();
    // L'ID Pi è stabile anche se cwd o nome della sessione cambiano.
    key = sanitizeKey(sessionId);

    // Carica la config PRIMA di usare cfg.bootstrap / cfg.ogniTurni.
    loadConfig();

    turns = 0;
    latestUserInput = '';
    periodicTurns = 0;
    lastUpdateTurn = 0;
    gateAttivo = null;
    gateViolazioni = 0;
    gateLastViolationTurn = 0;
    pendingManual = false;
    pendingResume = false;
    pendingPeriodic = false;
    pendingHeartbeat = false;
    pendingPostCompact = false;
    pendingRandomReview = false;
    randomTarget = pickRandomTarget();
    // Solo /resume riusa la carta della stessa sessione; un fork ha un ID distinto.
    // La bozza condivisa si carica esclusivamente con /carta bootstrap.
    bootstrapped = false;
    loadCard();
    if (card) {
      // Una bozza non e' ancora la carta dell'agente: non e' una generazione.
      if (cardOrigin !== 'bozza') cfg.generazione = Math.max(cfg.generazione, 1);
      cfg.chars = card.length;
      // Una sessione ripresa può ricevere solo "continua": ancora la carta al
      // primissimo LLM, senza attendere cinque/quindici turni del timer.
      pendingResume = cardOrigin !== 'bozza';
      if (!persistConfig() && ctx.hasUI) ctx.ui.notify(t('warn.registryNotSaveable'), 'error');
    }
    renderWidget();
    // Warning se una carta precedente (registro) è molto vecchia: segnala, non ereditare silenziosamente.
    const reg = globalRegistry()[key];
    if (card && cardOrigin !== 'bozza' && reg?.updatedAt) {
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

  // Canale c) system prompt + Fase 1 bootstrap
  pi.on('before_agent_start', async (event) => {
    if (!cfg.attivo) return;
    // Fase 1 bootstrap
    if (!card || cardOrigin === 'bozza') {
      if (bootstrapped) return;
      if (!cfg.bootstrap) return;
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
    if (!cfg.canaleSystemPrompt) return;
    const block = cardBlock('carta permanente');
    if (!block) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${block}`,
    };
  });

  // A fine turno completo, il testo utente non è più una chiave per appunti
  // archiviati. agent_end è troppo presto (Pi potrebbe fare retry automatici).
  pi.on('agent_settled', async () => { latestUserInput = ''; });

  // ---- Contatori di turni LLM; anche i cicli autonomi senza input utente avanzano ----

  pi.on('turn_end', async () => {
    if (!cfg.attivo) return;
    turns += 1;
    if (!card || cardOrigin === 'bozza') {
      // Un bootstrap ignorato viene riproposto: altrimenti il plugin resta spento per sempre.
      if (turns % cfg.ogniTurni === 0) bootstrapped = false;
      return;
    }
    periodicTurns += 1;

    // Staleness: se la carta non viene aggiornata da 2N turni, forza periodic + random
    const stalenessLimit = 2 * cfg.ogniTurni;
    const isStale = (turns - lastUpdateTurn) >= stalenessLimit;

    if (cfg.canalePeriodico && (periodicTurns % cfg.ogniTurni === 0 || isStale)) {
      pendingPeriodic = true;
      const inCooldown = gateLastViolationTurn > 0 && (turns - gateLastViolationTurn) < GATE_COOLDOWN_TURNI;
      if (cfg.gate && gateAttivo === null && !inCooldown) gateAttivo = { canale: 'periodico', turno: turns, tentativi: 0 };
    }

    // Nei lunghi cicli autonomi il checkpoint attivo viene ripetuto più spesso
    // del refresh completo, senza risvegliare appunti Topic archiviati.
    const heartbeatEvery = Math.max(1, Math.floor(cfg.ogniTurni / 3));
    if (cfg.canalePeriodico && !pendingPeriodic && periodicTurns % heartbeatEvery === 0 &&
        card && currentScope().selectCardForTopic(card, '', scopeOpts).hasActive) {
      pendingHeartbeat = true;
    }

    // Canale casuale: revisione carta fra N e 2N turni
    if (turns >= randomTarget && cfg.canaleRandomReview) {
      pendingRandomReview = true;
      randomTarget = turns + pickRandomTarget();
      const inCooldown = gateLastViolationTurn > 0 && (turns - gateLastViolationTurn) < GATE_COOLDOWN_TURNI;
      if (cfg.gate && gateAttivo === null && !inCooldown) gateAttivo = { canale: 'revisione', turno: turns, tentativi: 0 };
      const ctx = ctxRef;
      if (ctx && ctx.hasUI) {
        ctx.ui.notify(t('warn.revisionScheduled'), 'warning');
      }
    }

    // Staleness: forza anche la revisione casuale se la carta e' vecchia
    if (isStale && turns % cfg.ogniTurni === 0 && !pendingRandomReview && cfg.canaleRandomReview) {
      pendingRandomReview = true;
      const inCooldown = gateLastViolationTurn > 0 && (turns - gateLastViolationTurn) < GATE_COOLDOWN_TURNI;
      if (cfg.gate && gateAttivo === null && !inCooldown) {
        gateAttivo = { canale: 'revisione', turno: turns, tentativi: 0 };
        const ctx = ctxRef;
        if (ctx && ctx.hasUI) {
          ctx.ui.notify(t('warn.staleForcedGate'), 'warning');
        }
      }
    }

    // Gate: gestione tentativi e escalation (una tantum per attivazione)
    if (gateAttivo && gateAttivo.turno < turns) {
      gateAttivo.tentativi += 1;
      if (gateAttivo.tentativi >= GATE_MAX_TENTATIVI) {
        gateViolazioni += 1;
        gateLastViolationTurn = turns;
        const ctx = ctxRef;
        if (ctx && ctx.hasUI) {
          ctx.ui.notify(t('error.gateFailed', { attempts: GATE_MAX_TENTATIVI, channel: gateAttivo.canale, violations: gateViolazioni }), 'error');
        }
        gateAttivo = null;
      }
    }

    renderWidget();
  });

  // Canale a) + b) consegna effimera, garantita a ogni chiamata LLM
  pi.on('context', async (event) => {
    if (!cfg.attivo) return;
    // Filtra anche se la carta è stata cancellata: i vecchi messaggi persistenti
    // non devono risuscitare l'incarico precedente durante il nuovo bootstrap.
    let lastBootstrap = -1;
    event.messages.forEach((message, index) => {
      if (message.role === 'custom' && message.customType === `${CUSTOM_TYPE}-bootstrap`) lastBootstrap = index;
    });
    const cleanMessages = event.messages.filter((message, index) => {
      if (message.role !== 'custom') return true;
      if (message.customType === CUSTOM_TYPE) return false;
      if (message.customType !== `${CUSTOM_TYPE}-bootstrap`) return true;
      // Se è arrivato un nuovo bootstrap da before_agent_start, conservalo.
      // Scarta i precedenti; quando riproponiamo il bootstrap, scarta tutti.
      return (!card || cardOrigin === 'bozza') && bootstrapped && index === lastBootstrap;
    });
    if (!card || cardOrigin === 'bozza') {
      if (!cfg.bootstrap || bootstrapped) {
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
    // Non riusare l'ultimo utente della STORIA: durante resume/cicli autonomi
    // può risalire a un incarico vecchio. Solo before_agent_start (prompt del
    // turno attuale) abilita le sezioni Topic archiviate.
    const blocchi: string[] = [];
    const motiviCarta: string[] = [];

    // Gate: verifica conferma utente nel messaggio arrivato
    if (gateAttivo && cfg.gate) {
      const lastMsg = event.messages[event.messages.length - 1];
      // SAFETY: solo i messaggi con `content` possono contenere la conferma
      // del gate; gli altri (es. bash) non la contengono per definizione.
      const lastContent = lastMsg && 'content' in lastMsg ? lastMsg.content : undefined;
      if (verifyGate(lastContent)) {
        gateAttivo = null;
      } else {
        const scoped = currentScope().selectCardForTopic(card, latestUserInput, scopeOpts);
        if (!scoped.text) {
          gateAttivo = null;
        } else blocchi.push(
          `[ANTI-AMNESIA \u00b7 GATE ${gateAttivo.tentativi}/${GATE_MAX_TENTATIVI}] ` +
            `Conferma obbligatoria: rispondi SOLO con il formato esatto:\n` +
            `[CARTA OK] chiave=${key} ruolo=${cfg.ruolo ?? 'N/D'} turno=${gateAttivo.turno}\n` +
            `Memoria pertinente (${scoped.text.length} char):\n${scoped.text || '(nessun contenuto applicabile al topic corrente)'}`,
        );
      }
    }
    if (pendingResume) {
      if (!cfg.canaleSystemPrompt) motiviCarta.push(t('inject.reasonResume'));
      pendingResume = false;
      pendingHeartbeat = false;
      pendingPeriodic = false;
    }
    if (pendingManual) {
      motiviCarta.push(t('inject.reasonManual'));
      pendingManual = false;
    }
    if (pendingPostCompact) {
      if (cfg.onCompact) motiviCarta.push(t('inject.reasonPostCompact'));
      pendingPostCompact = false;
      pendingHeartbeat = false;
    }
    if (pendingPeriodic) {
      if (cfg.canalePeriodico) motiviCarta.push(t('inject.reasonPeriodic', { turns }));
      pendingPeriodic = false;
      pendingHeartbeat = false;
    }
    if (pendingHeartbeat && cfg.canalePeriodico && motiviCarta.length === 0 &&
        blocchi.every((item) => !item.startsWith('[ANTI-AMNESIA · GATE'))) {
      const active = currentScope().selectCardForTopic(card, '', scopeOpts);
      if (active.hasActive) {
        blocchi.push(`${t('inject.heartbeatHeader')}\n${active.text}\n` +
          t('inject.heartbeatFooter'));
      }
      pendingHeartbeat = false;
    }
    if (pendingRandomReview) {
      if (cfg.canaleRandomReview) {
        if (motiviCarta.length === 0) motiviCarta.push(t('inject.reasonScheduled'));
        // SAFETY: il catalogo e' JSON non tipizzato; se 'inject' manca restano
        // solo le righe gia' presenti. Una chiave assente resta rumore.
        const injectRows = (scopeI18n.inject as { randomReview?: unknown } | undefined)?.randomReview;
        blocchi.push(Array.isArray(injectRows)
          ? interpolateAll(injectRows as string[], sectionTitles).join(' ')
          : `[missing i18n key: inject.randomReview (${lang})]`);
      }
      pendingRandomReview = false;
    }
    // Una sola copia della carta per chiamata LLM, anche se compattazione,
    // periodico e revisione scadono contemporaneamente.
    if (motiviCarta.length > 0) {
      pendingHeartbeat = false;
      if (blocchi.every((item) => !item.startsWith('[ANTI-AMNESIA · GATE'))) {
        const block = injectEphemeral(motiviCarta.join('; '));
        if (block) blocchi.unshift(block);
      }
    }
    if (!cfg.canalePeriodico) pendingHeartbeat = false;
    if (blocchi.length === 0) {
      if (cleanMessages.length !== event.messages.length) return { messages: cleanMessages };
      return;
    }
    // SAFETY: CustomMessage e' registrato in CustomAgentMessages, quindi
    // l'oggetto letterale qui sotto e' gia' un AgentMessage valido: nessun cast.
    const promemoria = {
      role: 'custom' as const,
      customType: CUSTOM_TYPE,
      content: blocchi.join('\n\n'),
      display: false,
      timestamp: Date.now(),
    };
    return { messages: [...cleanMessages, promemoria] }; 
  });


  pi.on('session_compact', async (event, ctx) => {
    if (!card || cardOrigin === 'bozza' || !cfg.attivo || !cfg.onCompact) return;
    // nextTurn aspetta il prossimo input dell'utente: insufficiente durante un retry
    // automatico dopo compaction. Il prossimo hook context consegna subito il checkpoint.
    pendingPostCompact = true;
    if (cfg.gate) {
      const inCooldown = gateLastViolationTurn > 0 && (turns - gateLastViolationTurn) < GATE_COOLDOWN_TURNI;
      if (!inCooldown) {
        gateAttivo = { canale: 'compattazione', turno: turns, tentativi: 0 };
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
    name: 'carta_memoria',
    label: t('tool.label'),
    description:
      t('tool.description'),
    promptSnippet: t('tool.promptSnippet'),
    promptGuidelines: [
      t('tool.guideline'),
    ],
    parameters: Type.Object({
      testo: Type.Optional(
        Type.String({
          description:
            t('param.testo'),
        }),
      ),
      lavoro_attivo: Type.Optional(Type.String({
        description: t('param.lavoro_attivo', { active: sectionTitles.active }),
      })),
      ogni_turni: Type.Optional(Type.Number({ description: t('param.ogni_turni') })),
      ruolo: Type.Optional(Type.String({ description: t('param.ruolo') })),
      chiave: Type.Optional(Type.String({ description: t('param.chiave') })),
      canale_session_compact: Type.Optional(Type.Boolean({ description: t('param.canale_session_compact') })),
      canale_system_prompt: Type.Optional(Type.Boolean({ description: t('param.canale_system_prompt') })),
      canale_periodico: Type.Optional(Type.Boolean({ description: t('param.canale_periodico') })),
      canale_random_review: Type.Optional(Type.Boolean({ description: t('param.canale_random_review') })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ctxRef = ctx;

      if (params.chiave && sanitizeKey(params.chiave) !== key) {
        return {
          content: [{ type: 'text', text: t('error.sessionIsolated') }],
          details: { ok: false, error: 'chiave-sessione-diversa' },
        };
      }

      if (params.ogni_turni !== undefined &&
          (!Number.isFinite(params.ogni_turni) || params.ogni_turni < 1 || params.ogni_turni > MAX_INTERVAL_TURNS)) {
        return {
          content: [{ type: 'text', text: t('error.intervalRange', { max: MAX_INTERVAL_TURNS }) }],
          details: { ok: false, error: 'intervallo-non-valido' },
        };
      }
      if (params.testo !== undefined && params.lavoro_attivo !== undefined) {
        return {
          content: [{ type: 'text', text: t('error.textOrActive') }],
          details: { ok: false, error: 'parametri-incompatibili' },
        };
      }
      let testo = (params.testo ?? '').trim();
      if (params.lavoro_attivo !== undefined) {
        if (!card || !params.lavoro_attivo.trim()) {
          return {
            content: [{ type: 'text', text: t('error.needCardAndCheckpoint') }],
            details: { ok: false, error: 'checkpoint-assente' },
          };
        }
        try {
          testo = currentScope().replaceActiveCheckpoint(card, params.lavoro_attivo, scopeOpts);
        } catch (err) {
          return {
            content: [{ type: 'text', text: (err as Error).message }],
            details: { ok: false, error: 'checkpoint-ambiguo' },
          };
        }
      }
      if (!testo) {
        return {
          content: [
            {
              type: 'text',
              text: card
                ? t('info.currentCard', { chars: card.length, origin: cardOrigin, key, card })
                : t('info.noCardForKey', { key }),
            },
          ],
          details: { ok: true, azione: 'lettura', chiave: key, chars: card?.length ?? 0 },
        };
      }

      if (testo.length > MAX_CARD_CHARS) {
        return {
          content: [{ type: 'text', text: t('error.cardTooLong', { len: testo.length, max: MAX_CARD_CHARS }) }],
          details: { ok: false, error: 'carta-troppo-lunga' },
        };
      }

      // La chiave identifica la sessione: aggiornare il file esistente evita copie stale.
      const target = globalCardPath();

      try {
        if (fs.existsSync(target)) writeText(`${target}.bak`, readText(target) ?? '');
        // Non pubblicare una carta incompleta in memoria né su disco.
        writeText(`${target}.tmp`, testo);
        fs.renameSync(`${target}.tmp`, target);
      } catch (err) {
        try { fs.unlinkSync(`${target}.tmp`); } catch { /* noop */ }
        return {
          content: [{ type: 'text', text: t('error.cardUnchanged', { err: (err as Error).message }) }],
          details: { ok: false, error: 'scrittura-fallita' },
        };
      }
      card = testo;
      cardPath = target;
      cardOrigin = 'memoria';
      cfg.generazione += 1;
      lastUpdateTurn = turns;
      if (params.ogni_turni !== undefined) setIntervalTurns(params.ogni_turni);
      if (params.ruolo) cfg.ruolo = params.ruolo;
      if (typeof params.canale_session_compact === 'boolean') cfg.onCompact = params.canale_session_compact;
      if (typeof params.canale_system_prompt === 'boolean') cfg.canaleSystemPrompt = params.canale_system_prompt;
      if (typeof params.canale_periodico === 'boolean') cfg.canalePeriodico = params.canale_periodico;
      if (typeof params.canale_random_review === 'boolean') cfg.canaleRandomReview = params.canale_random_review;
      cfg.cwd = ctx.cwd ?? process.cwd();
      cfg.attivo = true;
      cfg.chars = card.length;
      const registrySaved = persistConfig(true);
      bootstrapped = true;
      renderWidget();

      const canali = [];
      if (cfg.onCompact) canali.push('compattazione (effimero)');
      if (cfg.canalePeriodico) canali.push(`periodico ogni ${cfg.ogniTurni} turni (effimero)`);
      if (cfg.canaleSystemPrompt) canali.push('system prompt');
      if (cfg.canaleRandomReview) canali.push('random review');
      return {
        content: [
          {
            type: 'text',
            text:
              t('info.cardSavedFull', {
                saved: registrySaved ? t('info.cardSaved') : t('info.cardSavedRegistryFail'),
                chars: card.length, key, generation: cfg.generazione,
              }) +
              (canali.length ? `${t('info.reinjectionActive', { channels: canali.join(' + ') })}\n` : '') +
              t('info.cardFile', { target }),
          },
        ],
        details: { ok: registrySaved, azione: 'scrittura', chiave: key, chars: card.length, generazione: cfg.generazione, ...(registrySaved ? {} : { error: 'registro-fallito', cartaSalvata: true }) },
      };
    },
  });

  // ---------------------------------------------------------------- comandi

  function invalidateActiveCard(): void {
    card = null;
    cardPath = null;
    cardOrigin = 'globale';
    cfg.bootstrap = true;
    bootstrapped = false;
    pendingPeriodic = pendingManual = pendingResume = pendingHeartbeat = pendingPostCompact = pendingRandomReview = false;
    gateAttivo = null;
    renderWidget();
  }

  function stato(): string {
    if (!card) return t('warn.cardAbsent', { key });
    const restanti = cfg.ogniTurni - (turns % cfg.ogniTurni);
    return [
      cfg.attivo ? t('status.on', { key }) : t('status.off', { key }),
      t('status.cardLine', { chars: card.length, origin: cardOrigin, draft: cardOrigin === 'bozza' ? t('status.draftNote') : '', generation: cfg.generazione }),
      cardPath ? `  ${cardPath}` : t('status.notOnDisk'),
      `  session_compact: ${cfg.onCompact ? 'effimero' : 'off'}`,
      `  system_prompt: ${cfg.canaleSystemPrompt ? 'on' : 'off'}`,
      `  periodico: ${cfg.canalePeriodico ? `effimero ogni ${cfg.ogniTurni} turni (tra ${restanti})` : 'off'}`,
      `  random_review: ${cfg.canaleRandomReview ? 'on' : 'off'}`,
      `  gate: ${cfg.gate ? 'on' : 'off'}${gateViolazioni > 0 ? ` (violazioni: ${gateViolazioni})` : ''}`,
      `  turni trascorsi: ${turns}`,
    ].join('\n');
  }

  pi.registerCommand('carta', {
    description: t('command.description'),
    handler: async (args, ctx) => {
      ctxRef = ctx;
      const parti = (args ?? '').trim().split(/\s+/).filter(Boolean);
      const azione = (parti[0] ?? '').toLowerCase();

      switch (azione) {
        case '':
        case 'stato':
          ctx.ui.notify(stato(), 'info');
          return;

        case 'rigenera': {
          const target = globalCardPath();
          try {
            if (fs.existsSync(target)) {
              writeText(`${target}.bak`, readText(target) ?? '');
              fs.unlinkSync(target); // al resume non deve tornare la carta superata
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

        case 'ogni': {
          const n = Number(parti[1]);
          if (!Number.isFinite(n) || n < 1 || n > MAX_INTERVAL_TURNS) {
            ctx.ui.notify(t('error.usageEveryN', { max: MAX_INTERVAL_TURNS }), 'warning');
            return;
          }
          setIntervalTurns(n);
          const saved = persistConfig();
          renderWidget();
          if (!saved) ctx.ui.notify(t('info.intervalNotSaveable'), 'error');
          ctx.ui.notify(t('info.intervalSet', { turns: cfg.ogniTurni }), 'info');
          return;
        }

        case 'on':
        case 'off': {
          // /carta on|off -> interruttore generale
          cfg.attivo = azione === 'on';
          const saved = persistConfig();
          renderWidget();
          if (!saved) ctx.ui.notify(t('info.toggleNotSaveable'), 'error');
          ctx.ui.notify(cfg.attivo ? t('info.enabled', { key }) : t('info.disabled', { key }), 'info');
          return;
        }

        case 'session_compact':
        case 'system_prompt':
        case 'periodico':
        case 'random_review':
        case 'gate': {
          // /carta <canale> [on|off] -> attiva/disattiva il singolo canale.
          // Senza argomento mostra lo stato del canale.
          const campo = CANALE_CAMPI[azione];
          const sub = (parti[1] ?? '').toLowerCase();
          if (sub === 'on' || sub === 'off') {
            cfg[campo] = sub === 'on';
            if (azione === 'random_review' && sub === 'on') {
              pendingRandomReview = false;
              randomTarget = turns + pickRandomTarget();
            }
            const saved = persistConfig();
            renderWidget();
            if (!saved) ctx.ui.notify(t('info.channelNotSaveable'), 'error');
            ctx.ui.notify(t('info.channelOnOff', { channel: azione, state: sub === 'on' ? 'ON' : 'OFF', key }), 'info');
            return;
          }
          if (azione === 'gate' && gateAttivo) {
            ctx.ui.notify(
              `GATE ATTIVO: canale=${gateAttivo.canale} turno=${gateAttivo.turno} tentativi=${gateAttivo.tentativi}/${GATE_MAX_TENTATIVI}` +
                (gateViolazioni > 0 ? `\nViolazioni: ${gateViolazioni}` : ''),
              'error',
            );
            return;
          }
          ctx.ui.notify(t('info.channelState', { channel: azione, state: cfg[campo] ? 'ON' : 'OFF', key }), 'info');
          return;
        }

        case 'ora': {
          if (!card) {
            ctx.ui.notify(t('warn.nothingToInject'), 'warning');
            return;
          }
          pendingManual = true;
          ctx.ui.notify(t('info.cardReady'), 'info');
          return;
        }

        case 'progetto': {
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
          loadCard(true); // bozza esplicita, mai reiniettata come carta personale
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
            const eta = c.updatedAt ? new Date(c.updatedAt).toLocaleString(lang === 'it' ? 'it-IT' : 'en-US') : 'mai';
            return `  ${k} — gen ${c.generazione}, ${c.chars} char, aggiornata ${eta}`;
          });
          ctx.ui.notify(t('info.cardsInRegistry', { count: entries.length, list: lines.join('\n') }), 'info');
          return;
        }

        case 'delete': {
          const targetKey = parti[1] ?? key;
          // Il comando legge anche chiavi storiche: mai usarle direttamente in path.join
          // senza impedire traversal (../, slash, path assoluti).
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
          const hours = parti[1] === undefined ? 48 : Number(parti[1]);
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
              // Il registro può essere stato modificato a mano: nessuna chiave
              // non valida può diventare un percorso da cancellare.
              if (!/^[a-z0-9][a-z0-9._-]{0,59}$/.test(k)) continue;
              const cardFile = path.join(CARDS_DIR, `${k}.md`);
              try {
                if (fs.existsSync(cardFile)) fs.unlinkSync(cardFile);
              } catch {
                continue; // non dichiarare eliminata una carta ancora su disco
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
