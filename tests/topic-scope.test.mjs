import assert from 'node:assert/strict';
import test from 'node:test';
import { extractLatestUserText, replaceActiveCheckpoint, replaceBlock, checkTodo, selectCardForTopic } from '../topic-scope.mjs';

const card = [
  '## Sempre valido',
  'Ruolo developer, rileggi /home/riccardo/PiAgent/prompts/base.md.',
  '## Lavoro attivo',
  'Obiettivo: riparare API pagamenti. Prossimo passo: eseguire test invoice.',
  '## Topic: newsletter, CRM',
  'Storico CRM: vecchio bridge newsletter, non è il lavoro attivo.',
].join('\n');

test('autonomous continuation keeps current objective and next step with no keywords', () => {
  for (const prompt of ['continua', 'ok', '', 'vai avanti']) {
    const result = selectCardForTopic(card, prompt);
    assert.match(result.text, /Prossimo passo: eseguire test invoice/);
    assert.match(result.text, /Ruolo developer/);
    assert.doesNotMatch(result.text, /Storico CRM/);
    assert.equal(result.hasActive, true);
  }
});

test('explicit archived topic adds only its own section', () => {
  const result = selectCardForTopic(card, 'Riprendiamo il CRM');
  assert.match(result.text, /Storico CRM/);
  assert.match(result.text, /API pagamenti/);
  assert.equal(result.topicMatched, true);
});

test('unrelated user question never wakes archived notes', () => {
  const result = selectCardForTopic(card, 'Scrivi una poesia per mia sorella');
  assert.doesNotMatch(result.text, /Storico CRM/);
});

test('existing unstructured session cards still survive sparse prompts', () => {
  const legacy = 'Debug del bridge newsletter nel CRM: test ancora da eseguire.';
  const result = selectCardForTopic(legacy, 'continua');
  assert.match(result.text, /test ancora da eseguire/);
  assert.equal(result.legacy, true);
});

test('legacy-only cards survive, but unknown headings cannot leak into active work', () => {
  const original = '# Carta\n## 1. CHI SONO\nDeveloper\n## 2. STATO\nTest da eseguire';
  assert.equal(selectCardForTopic(original, 'ok').text, original);
  const structured = '# Carta\n## Sempre valido\nRuolo dev\n## Lavoro attivo\nProssimo passo\n## Dettagli\nPath da leggere';
  const result = selectCardForTopic(structured, 'continua');
  assert.match(result.text, /# Carta/);
  assert.doesNotMatch(result.text, /Path da leggere/);
  assert.deepEqual(result.unclassified, ['Dettagli']);
});

test('checkpoint update accepts the descriptive heading recommended by bootstrap', () => {
  const original = '## Sempre valido\nRuolo dev\n## Lavoro attivo — obiettivo e prossimo passo\nVecchio task\n## Dettagli\nNote archiviate';
  const updated = replaceActiveCheckpoint(original, 'Nuovo task');
  assert.match(updated, /## Lavoro attivo — obiettivo e prossimo passo\nNuovo task/);
  assert.doesNotMatch(updated, /Vecchio task/);
  assert.match(updated, /## Dettagli\nNote archiviate/);
});

test('checkpoint update preserves rules and archived notes verbatim', () => {
  const updated = replaceActiveCheckpoint(card, 'Obiettivo: fatture; prossimo passo: test refund.');
  assert.match(updated, /test refund/);
  assert.doesNotMatch(updated, /test invoice/);
  assert.match(updated, /Ruolo developer/);
  assert.match(updated, /Storico CRM/);
  assert.throws(() => replaceActiveCheckpoint('## Sempre valido\nsolo ruolo', 'nuovo'), /exactly one/i);
});

test('latest user text ignores assistant and tool messages', () => {
  const messages = [
    { role: 'user', content: 'Richiesta iniziale' },
    { role: 'assistant', content: 'Risposta' },
    { role: 'toolResult', content: 'output tool' },
    { role: 'user', content: [{ type: 'text', text: 'Nuova richiesta' }] },
  ];
  assert.equal(extractLatestUserText(messages), 'Nuova richiesta');
});

// ---------------------------------------------------------------------------
// Block writes: one section at a time, and one checkbox at a time.
// ---------------------------------------------------------------------------

test('a block write replaces only its own section', () => {
  const withBlocks = [
    '## Sempre valido',
    'Ruolo developer.',
    '## Obiettivo',
    'Vecchio obiettivo.',
    '## Piano',
    'passo uno, passo due',
    '## Lavoro attivo',
    'Task corrente.',
  ].join('\n');
  const updated = replaceBlock(withBlocks, 'plan', '- passo A\n- passo B');
  assert.match(updated, /## Piano\n- passo A\n- passo B/);
  assert.doesNotMatch(updated, /passo uno/);
  // Everything the caller did NOT mention is still there, verbatim: that is the
  // whole point of writing in blocks instead of rewriting the card.
  assert.match(updated, /## Obiettivo\nVecchio obiettivo\./);
  assert.match(updated, /## Lavoro attivo\nTask corrente\./);
  assert.match(updated, /## Sempre valido\nRuolo developer\./);
});

test('a block that does not exist yet is appended at the end', () => {
  const updated = replaceBlock(card, 'objective', 'Portare a termine il cantiere.');
  assert.match(updated, /## Obiettivo\nPortare a termine il cantiere\./);
  assert.match(updated, /Ruolo developer/);
  assert.ok(
    updated.indexOf('## Obiettivo') > updated.indexOf('## Topic:'),
    'the new block must land at the end, not inside another section',
  );
});

test('two identical headings are refused instead of guessing which one to rewrite', () => {
  assert.throws(() => replaceBlock('## Piano\nprimo\n## Piano\nsecondo', 'plan', 'nuovo'), /more than one/i);
});

test('an unknown block name is refused', () => {
  assert.throws(() => replaceBlock(card, 'topic', 'x'), /unknown block/i);
  assert.throws(() => replaceBlock(card, 'inventato', 'x'), /unknown block/i);
});

test('ticking a todo item touches the checkbox and nothing else', () => {
  const withTodo = `${card}\n## Todo\n- [ ] scrivere i test\n- [x] leggere il codice`;
  const ticked = checkTodo(withTodo, 1, true);
  assert.match(ticked, /- \[x\] scrivere i test/);
  assert.match(ticked, /- \[x\] leggere il codice/);
  assert.match(ticked, /Ruolo developer/);
  assert.match(ticked, /Storico CRM/);
});

test('a todo item can be addressed by its text, and unticked again', () => {
  const withTodo = `${card}\n## Todo\n- [ ] scrivere i test\n- [ ] aggiornare la carta`;
  const byText = checkTodo(withTodo, 'aggiornare', true);
  assert.match(byText, /- \[x\] aggiornare la carta/);
  assert.match(byText, /- \[ \] scrivere i test/);
  const back = checkTodo(byText, 'aggiornare', false);
  assert.match(back, /- \[ \] aggiornare la carta/);
});

test('an ambiguous todo address is refused rather than guessed', () => {
  const withTodo = `${card}\n## Todo\n- [ ] scrivere i test\n- [ ] scrivere la doc`;
  assert.throws(() => checkTodo(withTodo, 'scrivere', true), /matches 2/i);
  assert.throws(() => checkTodo(withTodo, 9, true), /does not exist/i);
});

test('a todo block with no checkboxes, or none at all, is refused', () => {
  assert.throws(() => checkTodo(card, 1, true), /exactly one todo/i);
  assert.throws(() => checkTodo(`${card}\n## Todo\nsolo prosa`, 1, true), /no checkbox/i);
});

test('the objective, the plan and the todo list are delivered without keywords', () => {
  const full = [
    '## Sempre valido', 'Ruolo dev.',
    '## Obiettivo', 'OBIETTIVO-MARCA',
    '## Piano', 'PIANO-MARCA',
    '## Todo', '- [ ] TODO-MARCA',
    '## Topic: crm', 'STORICO-MARCA',
  ].join('\n');
  // A prompt with nothing to do with any of it: the three blocks are permanent, the
  // archived topic is not. Losing the plan to a keyword rule would lose the material
  // that must not be lost.
  const result = selectCardForTopic(full, 'Scrivi una poesia per mia sorella');
  assert.match(result.text, /OBIETTIVO-MARCA/);
  assert.match(result.text, /PIANO-MARCA/);
  assert.match(result.text, /TODO-MARCA/);
  assert.doesNotMatch(result.text, /STORICO-MARCA/);
});

test('a todo item has three states, and a boolean still means done / not done', () => {
  const withTodo = `${card}\n## Todo\n- [ ] scrivere i test\n- [x] leggere il codice`;
  const working = checkTodo(withTodo, 1, 'in_progress');
  assert.match(working, /- \[~\] scrivere i test/, 'in_progress must be visible at a glance');
  assert.match(working, /- \[x\] leggere il codice/, 'the other items must not move');
  // A BOOLEAN KEEPS ITS OLD MEANING, so nothing that used to work stops working: this is the
  // difference between extending an API and breaking it.
  assert.match(checkTodo(working, 1, true), /- \[x\] scrivere i test/);
  assert.match(checkTodo(working, 1, false), /- \[ \] scrivere i test/);
  // And an in-progress item can be addressed by its text and finished.
  assert.match(checkTodo(working, 'scrivere', 'completed'), /- \[x\] scrivere i test/);
});
