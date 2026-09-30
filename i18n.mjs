/**
 * i18n — language, catalogs and section patterns.
 *
 * Language: resolved ONCE at startup and frozen for the whole session.
 * The LLM must never see the context change language mid-conversation:
 * that is the main cause of hybrid it/en output in cards.
 *
 * Resolution priority:
 *   1. PI_ANTI_AMNESIA_LANG   (env, explicit override — useful for tests)
 *   2. config.language        (if set and different from "auto")
 *   3. LC_ALL > LC_MESSAGES > LANG   (e.g. it_IT.UTF-8 -> Italian)
 *   4. Intl.DateTimeFormat().resolvedOptions().locale
 *   5. fallback: English
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const I18N_DIR = path.join(HERE, 'i18n');

/** Supported languages. English is the fallback and the default. */
export const SUPPORTED = ['en', 'it'];
export const FALLBACK = 'en';

const cache = new Map();

/** A language is supported only if it has a catalog on disk. */
export function isSupported(lang) {
  return SUPPORTED.includes(lang) && fs.existsSync(path.join(I18N_DIR, `${lang}.json`));
}

/** Extracts the language code from a locale tag like "it_IT.UTF-8" -> "it". */
function primaryOf(tag) {
  if (typeof tag !== 'string') return null;
  const m = /^\s*([A-Za-z]{2,3})(?:-|_)/.exec(tag) ?? /^\s*([A-Za-z]{2,3})\s*$/.exec(tag);
  return m ? m[1].toLowerCase() : null;
}

/** Reads the environment without discarding the values. */
function fromEnvironment(env) {
  for (const name of ['PI_ANTI_AMNESIA_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG', 'LANGUAGE']) {
    const tag = env?.[name];
    if (!tag || tag === 'C' || tag === 'POSIX') continue;
    const primary = primaryOf(tag);
    if (primary && isSupported(primary)) return primary;
  }
  return null;
}

/** Runtime locale, as a last resort before the fallback. */
function fromIntl() {
  try {
    return primaryOf(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return null;
  }
}

/**
 * Resolves the active language. Call ONCE and freeze the result.
 * @param {string|undefined|null} configured  config.language value
 * @param {Record<string,string|undefined>} [env]
 */
export function resolveLanguage(configured, env = process.env) {
  const forced = primaryOf(env?.PI_ANTI_AMNESIA_LANG);
  if (forced && isSupported(forced)) return forced;

  const explicit = primaryOf(configured);
  if (explicit && explicit !== 'auto' && isSupported(explicit)) return explicit;

  return fromEnvironment(env) ?? (isSupported(fromIntl() ?? '') ? fromIntl() : FALLBACK);
}

/** Loads a catalog, with cascading fallback to English. */
export function loadCatalog(lang) {
  if (cache.has(lang)) return cache.get(lang);
  const read = (l) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(I18N_DIR, `${l}.json`), 'utf8'));
    } catch {
      return null;
    }
  };
  // Last resort: an empty object. Do not fail session startup for
  // a missing catalog — t() will emit [missing i18n key: ...] on every key,
  // so the fault stays loudly visible instead of being silently lost.
  const catalog = read(lang) ?? read(FALLBACK) ?? {};
  cache.set(lang, catalog);
  return catalog;
}

/** Interpolates {name} with the provided values. */
function interpolate(template, vars) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

/**
 * Builds the translator for a language.
 * t('error.cardTooLong', { len, max })
 * Missing keys reveal the full path instead of failing silently.
 */
export function makeT(lang) {
  const catalog = loadCatalog(lang);
  return function t(key, vars) {
    const template = key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), catalog);
    if (typeof template !== 'string') {
      // Do not degrade silently: a key error must be evident.
      return `[missing i18n key: ${key} (${lang})]`;
    }
    return interpolate(template, vars);
  };
}

/** Expands {name} inside an array of strings (prompt lines). */
export function interpolateAll(lines, vars) {
  return lines.map((line) => interpolate(line, vars));
}

/**
 * Section heading aliases, to be used as parser patterns.
 * It ALWAYS contains the aliases of both languages, so a card stays
 * editable even after a configuration language change.
 */
export function sectionAliases(lang) {
  const catalog = loadCatalog(lang);
  const aliases = catalog?.section?._aliases ?? {};
  return {
    always: Array.isArray(aliases.always) ? aliases.always : ['Sempre valido', 'Always valid'],
    active: Array.isArray(aliases.active) ? aliases.active : ['Lavoro attivo', 'Active work'],
    topic: Array.isArray(aliases.topic) ? aliases.topic : ['topic', 'ambito', 'argomento'],
  };
}

/** Canonical section titles, for the active language. */
export function sectionTitles(lang) {
  const catalog = loadCatalog(lang);
  return {
    always: catalog?.section?.always ?? 'Always valid',
    active: catalog?.section?.active ?? 'Active work',
    topic: catalog?.section?.topicPrefix ?? 'Topic',
  };
}
