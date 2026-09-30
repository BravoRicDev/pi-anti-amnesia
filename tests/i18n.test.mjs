import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SUPPORTED,
  resolveLanguage,
  makeT,
  interpolateAll,
  sectionAliases,
  sectionTitles,
  loadCatalog,
} from '../i18n.mjs';
import { selectCardForTopic, replaceActiveCheckpoint } from '../topic-scope.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('language resolves from the environment, and the env var wins', () => {
  assert.equal(resolveLanguage('auto', { LANG: 'it_IT.UTF-8' }), 'it');
  assert.equal(resolveLanguage('auto', { LC_ALL: 'en_US.UTF-8', LANG: 'it_IT.UTF-8' }), 'en');
  assert.equal(resolveLanguage('auto', { PI_ANTI_AMNESIA_LANG: 'en', LANG: 'it_IT.UTF-8' }), 'en');
  // LC_ALL beats LANG
  assert.equal(resolveLanguage('auto', { LC_ALL: 'en_GB.UTF-8', LANG: 'it_IT.UTF-8' }), 'en');
});

test('an explicit config language wins over the environment', () => {
  assert.equal(resolveLanguage('en', { LANG: 'it_IT.UTF-8' }), 'en');
  assert.equal(resolveLanguage('it', { LANG: 'en_US.UTF-8' }), 'it');
});

test('an unsupported language falls back instead of breaking', () => {
  // No supported language in env: the fallback must be usable, never undefined.
  assert.ok(SUPPORTED.includes(resolveLanguage('klingon', {})));
  assert.equal(resolveLanguage('klingon', { LANG: 'it_IT.UTF-8' }), 'it');
});

test('every shipped catalog resolves every key used by the other', () => {
  const [en, it] = SUPPORTED.map((lang) => loadCatalog(lang));
  const keys = (obj, prefix = '') =>
    Object.entries(obj).flatMap(([k, v]) =>
      k.startsWith('_') ? [] :
      v && typeof v === 'object' && !Array.isArray(v) ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]);
  const enKeys = new Set(keys(en));
  const itKeys = new Set(keys(it));
  for (const k of itKeys) assert.ok(enKeys.has(k), `key only in it.json: ${k}`);
  for (const k of enKeys) assert.ok(itKeys.has(k), `key only in en.json: ${k}`);
});

test('a missing key is reported loudly, never silently blank', () => {
  const t = makeT('en');
  assert.match(t('definitamente.non.esiste'), /missing i18n key/);
});

test('interpolation fills placeholders and leaves unknown ones alone', () => {
  const t = makeT('en');
  assert.match(t('error.cardTooLong', { len: 25, max: 20 }), /25 > 20/);
  // A placeholder with no value stays literal: it is a bug in the caller of
  // t(), and rendering it as silently empty would hide the missing datum.
  assert.match(t('error.cardTooLong', { len: 25 }), /\{max\}/);
});

test('interpolateAll keeps one line per element', () => {
  assert.deepEqual(interpolateAll(['a {x}', 'b {y}'], { x: '1', y: '2' }), ['a 1', 'b 2']);
});

test('section aliases always contain both languages', () => {
  for (const lang of SUPPORTED) {
    const active = sectionAliases(lang).active.join(' ');
    assert.match(active, /Lavoro attivo/, `IT alias missing in ${lang}`);
    assert.match(active, /Active work/i, `EN alias missing in ${lang}`);
  }
});

test('section titles are localised', () => {
  assert.equal(sectionTitles('it').active, 'Lavoro attivo');
  assert.equal(sectionTitles('en').active, 'Active work');
});

for (const lang of SUPPORTED) {
  test(`an ${lang} card is recognised and its checkpoint updated`, () => {
    const titles = sectionTitles(lang);
    const opts = {
      aliases: sectionAliases(lang),
      activeTitle: titles.active,
      exactlyOneActive: loadCatalog(lang).error.exactlyOneActive,
      locale: lang === 'it' ? 'it-IT' : 'en-US',
    };
    const card = [
      `## ${titles.always}`,
      '- stable rule',
      '',
      `## ${titles.active}`,
      '- objective: x',
      '',
      `## ${titles.topic}: crm, refactor`,
      '- archived note',
    ].join('\n');

    const scoped = selectCardForTopic(card, 'parla di crm', opts);
    assert.equal(scoped.hasActive, true);
    assert.equal(scoped.hasTopics, true);
    assert.equal(scoped.topicMatched, true, 'the declared topic must wake up');
    assert.deepEqual(scoped.unclassified, [], 'no unclassified section');

    const out = replaceActiveCheckpoint(card, 'NUOVO CHECKPOINT', opts);
    assert.match(out, /NUOVO CHECKPOINT/);
    assert.ok(out.includes(titles.always), 'the neighbouring sections must stay intact');
  });
}

test('a card written in one language stays editable under the other', () => {
  // This is the invariant that avoids losing the card on a language change.
  const en = sectionTitles('en');
  const itOpts = { aliases: sectionAliases('it'), activeTitle: sectionTitles('it').active };
  const cardEn = `## ${en.always}\n- rule\n\n## ${en.active}\n- objective: x`;
  const scoped = selectCardForTopic(cardEn, '', itOpts);
  assert.equal(scoped.hasActive, true, 'an EN card must stay readable with an IT config');
  assert.doesNotThrow(() => replaceActiveCheckpoint(cardEn, 'checkpoint', itOpts));
});

test('an ambiguous card is rejected instead of erasing a section', () => {
  const opts = { aliases: sectionAliases('it'), activeTitle: 'Lavoro attivo' };
  assert.throws(
    () => replaceActiveCheckpoint('## Sempre valido\n- a\n\n## Lavoro attivo\n- b\n\n## Lavoro attivo\n- c', 'x', opts),
    /esattamente una sezione|exactly one/i,
  );
});
