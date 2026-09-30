// No model call or inference: the card's active checkpoint is authoritative until
// the agent explicitly changes it. User prompts may be just "continua".
//
// Section headings are NOT hardcoded to one language. The caller passes the alias
// list for the active language plus every cross-language alias, so a card written
// in Italian stays editable after the configuration switches to English, and
// vice versa. Fallback defaults reproduce the original Italian behaviour.

const DEFAULT_ALIASES = {
  always: ['Sempre valido', 'Always valid', 'Always-valid', 'Always valid rules'],
  active: ['Lavoro attivo', 'Active work', 'Active', 'Active Work'],
  topic: ['topic', 'ambito', 'argomento'],
};

const STOP_WORDS = new Set([
  // Italian
  'alla', 'allo', 'agli', 'alle', 'della', 'dello', 'delle', 'degli', 'nella', 'nello', 'nelle', 'negli',
  'dalla', 'dallo', 'dalle', 'dagli', 'con', 'per', 'tra', 'fra', 'che', 'come', 'sono', 'dopo', 'prima',
  'questa', 'questo', 'quello', 'dove', 'quando', 'anche', 'sempre', 'solo', 'tutto', 'tutti', 'ruolo',
  'regole', 'regola', 'topic', 'argomento', 'contesto', 'specifico', 'specifica', 'carta', 'sessione',
  // english
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'then', 'than', 'have', 'has',
  'been', 'were', 'will', 'would', 'could', 'should', 'about', 'which', 'while', 'only', 'also',
  'always', 'never', 'role', 'rules', 'rule', 'context', 'specific', 'card', 'session', 'please',
]);

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function alternation(list, fallback) {
  const items = (Array.isArray(list) && list.length ? list : fallback).filter(Boolean);
  // Longer aliases first: an alternation is ordered, so "Always valid rules" must
  // win over "Always valid" instead of leaving a dangling tail.
  return [...new Set(items)]
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join('|');
}

function optsOf(opts) {
  const aliases = opts?.aliases ?? DEFAULT_ALIASES;
  return {
    aliases: {
      always: aliases.always ?? DEFAULT_ALIASES.always,
      active: aliases.active ?? DEFAULT_ALIASES.active,
      topic: aliases.topic ?? DEFAULT_ALIASES.topic,
    },
    activeTitle: opts?.activeTitle ?? 'Lavoro attivo',
    exactlyOneActive: opts?.exactlyOneActive ?? '',
    locale: opts?.locale ?? 'it-IT',
  };
}

function tokens(text, locale) {
  // Public API: a non-string userText must not blow up the caller.
  if (typeof text !== 'string') return new Set();
  return new Set(
    (text.toLocaleLowerCase(locale).match(/[\p{L}\p{N}][\p{L}\p{N}_-]{2,}/gu) ?? []).filter(
      (word) => !STOP_WORDS.has(word),
    ),
  );
}

function parseCard(text, opts) {
  const o = optsOf(opts);
  // A non-string card is not a card: treat it as empty legacy instead
  // of propagating a TypeError inside the hook context.
  if (typeof text !== 'string') {
    return { always: [], active: [], topical: [], unclassified: [], legacy: '' };
  }
  // Build the alternations once: deriving a combined regex by slicing the
  // .source of other regexes produces unbalanced groups.
  const alwaysAlt = alternation(o.aliases.always, DEFAULT_ALIASES.always);
  const activeAlt = alternation(o.aliases.active, DEFAULT_ALIASES.active);
  const topicAlt = alternation(o.aliases.topic, DEFAULT_ALIASES.topic);

  const alwaysRe = new RegExp(`^(?:${alwaysAlt})(?:\\s|$)`, 'i');
  const activeRe = new RegExp(`^(?:${activeAlt})(?:\\s|$)`, 'i');
  const topicRe = new RegExp(`^(?:${topicAlt})\\s*:`, 'i');
  const anyHeadingRe = new RegExp(`^(?:${alwaysAlt}|${activeAlt}|${topicAlt})`, 'i');

  const scope = { always: [], active: [], topical: [], unclassified: [], legacy: '' };
  const lines = text.split(/\r?\n/);
  if (!lines.some((line) => anyHeadingRe.test(line.replace(/^##\s+/, '').trim()))) {
    scope.legacy = text.trim();
    return scope;
  }
  let current = null;
  const flush = () => {
    if (!current) return;
    const body = current.lines.join('\n').trim();
    if (!body) return;
    if (current.kind === 'topic') scope.topical.push({ title: current.title, body });
    else if (current.kind === 'unclassified') scope.unclassified.push({ title: current.title, body });
    else scope[current.kind].push(body);
  };
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      flush();
      const title = line.replace(/^##\s+/, '').trim();
      const kind = topicRe.test(title) ? 'topic'
        : activeRe.test(title) ? 'active'
          : alwaysRe.test(title) ? 'always' : 'unclassified';
      current = { title, kind, lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      // A preamble must not silently disappear during recovery.
      scope.always.push(line);
    }
  }
  flush();
  scope.always = scope.always.filter((line) => line.trim());
  return scope;
}

/** Permanent rules and the active work checkpoint do not depend on the user repeating keywords. */
export function selectCardForTopic(text, userText, opts) {
  const o = optsOf(opts);
  const scope = parseCard(text, o);
  const query = tokens(userText ?? '', o.locale);
  const selected = [...scope.always, ...scope.active];
  const hasTopics = scope.topical.length > 0;
  let topicMatched = false;

  const declaredRe = new RegExp(`^(?:${alternation(o.aliases.topic, DEFAULT_ALIASES.topic)})\\s*:\\s*(.+)$`, 'i');

  for (const section of scope.topical) {
    const declared = section.title.match(declaredRe)?.[1] ?? '';
    const keywords = tokens(declared, o.locale);
    // No guessing from the body: a generic "continua" must not wake archived topics.
    if ([...keywords].some((word) => query.has(word))) {
      selected.push(`## ${section.title}\n${section.body}`);
      topicMatched = true;
    }
  }
  if (scope.legacy) selected.push(scope.legacy); // Existing session cards remain usable until migrated.
  return {
    text: selected.join('\n\n').trim(),
    hasTopics,
    topicMatched,
    hasActive: scope.active.length > 0,
    unclassified: scope.unclassified.map((section) => section.title),
    legacy: Boolean(scope.legacy),
  };
}

// Reject ambiguous cards instead of accidentally erasing another section.
export function replaceActiveCheckpoint(card, checkpoint, opts) {
  const o = optsOf(opts);
  const headings = [
    ...card.matchAll(
      new RegExp(
        `^##[ \\t]+(?:${alternation(o.aliases.active, DEFAULT_ALIASES.active)})(?:[ \\t]+[^\\r\\n]*)?\\r?$`,
        'gim',
      ),
    ),
  ];
  if (headings.length !== 1) {
    // SAFETY: the template comes from the translated catalog; if it is missing
    // we fall back to an English message, so the error is still readable.
    throw new Error(
      o.exactlyOneActive
        ? o.exactlyOneActive.replace('{active}', o.activeTitle)
        : `Exactly one '## ${o.activeTitle}' section is required: migrate the card before updating the checkpoint.`,
    );
  }
  const heading = headings[0];
  const start = heading.index + heading[0].length;
  const next = /^##[ \t]+/gm;
  next.lastIndex = start;
  const end = next.exec(card)?.index ?? card.length;
  return `${card.slice(0, start)}\n${checkpoint.trim()}\n\n${card.slice(end).trimStart()}`.trim();
}

export function extractLatestUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      return message.content.map((block) => {
        if (typeof block === 'string') return block;
        return block && typeof block.text === 'string' ? block.text : '';
      }).filter(Boolean).join('\n');
    }
    return '';
  }
  return '';
}
