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
  objective: ['Obiettivo', 'Objective', 'Goal'],
  plan: ['Piano', 'Plan'],
  todo: ['Todo', 'Todolist', 'To-do', 'Attivita', 'Tasks'],
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
      objective: aliases.objective ?? DEFAULT_ALIASES.objective,
      plan: aliases.plan ?? DEFAULT_ALIASES.plan,
      todo: aliases.todo ?? DEFAULT_ALIASES.todo,
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
    return { always: [], active: [], objective: [], plan: [], todo: [], topical: [], unclassified: [], legacy: '' };
  }
  // Build the alternations once: deriving a combined regex by slicing the
  // .source of other regexes produces unbalanced groups.
  const alwaysAlt = alternation(o.aliases.always, DEFAULT_ALIASES.always);
  const activeAlt = alternation(o.aliases.active, DEFAULT_ALIASES.active);
  const objectiveAlt = alternation(o.aliases.objective, DEFAULT_ALIASES.objective);
  const planAlt = alternation(o.aliases.plan, DEFAULT_ALIASES.plan);
  const todoAlt = alternation(o.aliases.todo, DEFAULT_ALIASES.todo);
  const topicAlt = alternation(o.aliases.topic, DEFAULT_ALIASES.topic);

  const alwaysRe = new RegExp(`^(?:${alwaysAlt})(?:\\s|$)`, 'i');
  const activeRe = new RegExp(`^(?:${activeAlt})(?:\\s|$)`, 'i');
  const objectiveRe = new RegExp(`^(?:${objectiveAlt})(?:\\s|$)`, 'i');
  const planRe = new RegExp(`^(?:${planAlt})(?:\\s|$)`, 'i');
  const todoRe = new RegExp(`^(?:${todoAlt})(?:\\s|$)`, 'i');
  const topicRe = new RegExp(`^(?:${topicAlt})\\s*:`, 'i');
  const anyHeadingRe = new RegExp(
    `^(?:${alwaysAlt}|${activeAlt}|${objectiveAlt}|${planAlt}|${todoAlt}|${topicAlt})`, 'i',
  );

  const scope = { always: [], active: [], objective: [], plan: [], todo: [], topical: [], unclassified: [], legacy: '' };
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
          : alwaysRe.test(title) ? 'always'
            : objectiveRe.test(title) ? 'objective'
              : planRe.test(title) ? 'plan'
                : todoRe.test(title) ? 'todo' : 'unclassified';
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
  // THE OBJECTIVE, THE PLAN AND THE TODO LIST ARE PERMANENT, like the always-valid rules and
  // the active checkpoint: they do not depend on the user repeating keywords, and a card that
  // carried them but delivered them only on a keyword match would lose exactly the material
  // that must not be lost. Topical sections keep the keyword rule.
  const selected = [
    ...scope.always, ...scope.active, ...scope.objective, ...scope.plan, ...scope.todo,
  ];
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

/**
 * Replace the body of ONE section, leaving every other section untouched.
 *
 * This is what makes the card writable IN BLOCKS: the agent can save the plan without
 * re-sending the objective, and without the risk of dropping a section it never mentioned. A
 * whole-card write is a full overwrite, so every block write is also a smaller blast radius.
 *
 * A section that does not exist yet is APPENDED, which is how the first write creates it.
 * A card that matches the alias MORE THAN ONCE is refused, exactly like the active checkpoint:
 * rewriting the wrong one of two identical headings is silent corruption, and silence is the
 * one failure mode this extension cannot afford.
 */
export function replaceBlock(card, kind, value, opts) {
  const o = optsOf(opts);
  const fallback = DEFAULT_ALIASES[kind];
  if (!fallback || kind === 'topic') throw new Error(`unknown block kind: ${kind}`);
  const alt = alternation(o.aliases[kind], fallback);
  const heading = new RegExp(`^##[ \\t]+(?:${alt})(?:[ \\t]+[^\\r\\n]*)?\\r?$`, 'gim');
  const text = typeof card === 'string' ? card : '';
  const found = [...text.matchAll(heading)];
  const body = String(value ?? '').trim();
  if (found.length > 1) {
    throw new Error(`More than one '## ${kind}' section: rewrite the whole card before saving one block.`);
  }
  if (found.length === 1) {
    const start = found[0].index + found[0][0].length;
    const next = /^##[ \t]+/gm;
    next.lastIndex = start;
    const end = next.exec(text)?.index ?? text.length;
    return `${text.slice(0, start)}\n${body}\n\n${text.slice(end).trimStart()}`.trim();
  }
  const title = (o.aliases[kind] ?? fallback)[0];
  return `${text.trim()}\n\n## ${title}\n${body}\n`.trim();
}

/**
 * Tick, or untick, ONE item of the todo block, addressed by 1-based index or by its text.
 *
 * The list is markdown, so this is a text operation and not a model call: `- [ ] x` becomes
 * `- [x] x`. Two things matter. An AMBIGUOUS address is refused rather than guessed, because
 * ticking the wrong task is a silent lie about what is done. And only the checkbox changes:
 * the rest of the line is the task's own text and must survive untouched, so the edit is a
 * targeted substitution on the bracket and nothing else.
 */
export function checkTodo(card, target, done, opts) {
  const o = optsOf(opts);
  const alt = alternation(o.aliases.todo, DEFAULT_ALIASES.todo);
  const heading = new RegExp(`^##[ \\t]+(?:${alt})(?:[ \\t]+[^\\r\\n]*)?\\r?$`, 'gim');
  const text = typeof card === 'string' ? card : '';
  const found = [...text.matchAll(heading)];
  if (found.length !== 1) {
    throw new Error(`Exactly one todo section is required to tick an item (found ${found.length}).`);
  }
  const start = found[0].index + found[0][0].length;
  const next = /^##[ \t]+/gm;
  next.lastIndex = start;
  const end = next.exec(text)?.index ?? text.length;
  const lines = text.slice(start, end).split('\n');
  const items = [];
  lines.forEach((line, i) => {
    const m = line.match(/^\s*[-*]\s+\[([ xX~])\]\s+(.*)$/);
    if (m) items.push({ i, text: m[2].trim() });
  });
  if (items.length === 0) throw new Error('The todo block has no checkbox items.');
  let pick;
  if (typeof target === 'number') {
    if (!Number.isInteger(target) || target < 1 || target > items.length) {
      throw new Error(`Todo item ${target} does not exist: the block has ${items.length} item(s), numbered from 1.`);
    }
    pick = [items[target - 1]];
  } else {
    const needle = String(target ?? '').trim().toLocaleLowerCase(o.locale);
    if (!needle) throw new Error('Address a todo item by 1-based index or by its text.');
    pick = items.filter((item) => item.text.toLocaleLowerCase(o.locale).includes(needle));
    if (pick.length === 0) throw new Error(`No todo item contains "${target}".`);
    if (pick.length > 1) {
      throw new Error(`"${target}" matches ${pick.length} todo items: address it by index instead.`);
    }
  }
  // THREE STATES, not two: pending, in_progress and completed. The middle one is why a long
  // autonomous run can be read at a glance — "which task am I on" is the first question anyone
  // asks of a checklist, and a list that can only say done / not-done cannot answer it. A
  // BOOLEAN IS STILL ACCEPTED, so every existing caller and test keeps its meaning: `true` is
  // completed, `false` is pending.
  const mark = done === true || done === 'completed' ? 'x'
    : done === 'in_progress' ? '~'
      : ' ';
  lines[pick[0].i] = lines[pick[0].i].replace(/\[([ xX~])\]/, `[${mark}]`);
  return `${text.slice(0, start)}${lines.join('\n')}${text.slice(end)}`;
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
