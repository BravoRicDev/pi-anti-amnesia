/**
 * i18n — lingua, cataloghi e pattern delle sezioni.
 *
 * Lingua: risolta UNA volta all'avvio e congelata per tutta la sessione.
 * L'LLM non deve mai vedere il contesto cambiare lingua a meta' conversazione:
 * e' la causa principale di output ibrido it/en nelle carte.
 *
 * Priorita' di risoluzione:
 *   1. PI_ANTI_AMNESIA_LANG   (env, override esplicito — utile per test)
 *   2. config.language        (se valorizzata e diversa da "auto")
 *   3. LC_ALL > LC_MESSAGES > LANG   (es. it_IT.UTF-8 -> italiano)
 *   4. Intl.DateTimeFormat().resolvedOptions().locale
 *   5. fallback: inglese
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const I18N_DIR = path.join(HERE, 'i18n');

/** Lingue supportate. L'inglese e' il fallback e il default. */
export const SUPPORTED = ['en', 'it'];
export const FALLBACK = 'en';

const cache = new Map();

/** Una lingua e' supportata solo se ha un catalogo su disco. */
export function isSupported(lang) {
  return SUPPORTED.includes(lang) && fs.existsSync(path.join(I18N_DIR, `${lang}.json`));
}

/** Estrae il codice lingua da un tag di locale tipo "it_IT.UTF-8" -> "it". */
function primaryOf(tag) {
  if (typeof tag !== 'string') return null;
  const m = /^\s*([A-Za-z]{2,3})(?:-|_)/.exec(tag) ?? /^\s*([A-Za-z]{2,3})\s*$/.exec(tag);
  return m ? m[1].toLowerCase() : null;
}

/** Legge l'ambiente senza buttare via i valori. */
function fromEnvironment(env) {
  for (const name of ['PI_ANTI_AMNESIA_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG', 'LANGUAGE']) {
    const tag = env?.[name];
    if (!tag || tag === 'C' || tag === 'POSIX') continue;
    const primary = primaryOf(tag);
    if (primary && isSupported(primary)) return primary;
  }
  return null;
}

/** Locale del runtime, come ultimo resort prima del fallback. */
function fromIntl() {
  try {
    return primaryOf(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return null;
  }
}

/**
 * Risolve la lingua attiva. Chiamare UNA volta e congelare il risultato.
 * @param {string|undefined|null} configured  valore di config.language
 * @param {Record<string,string|undefined>} [env]
 */
export function resolveLanguage(configured, env = process.env) {
  const forced = primaryOf(env?.PI_ANTI_AMNESIA_LANG);
  if (forced && isSupported(forced)) return forced;

  const explicit = primaryOf(configured);
  if (explicit && explicit !== 'auto' && isSupported(explicit)) return explicit;

  return fromEnvironment(env) ?? (isSupported(fromIntl() ?? '') ? fromIntl() : FALLBACK);
}

/** Carica un catalogo, con fallback a cascata sull'inglese. */
export function loadCatalog(lang) {
  if (cache.has(lang)) return cache.get(lang);
  const read = (l) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(I18N_DIR, `${l}.json`), 'utf8'));
    } catch {
      return null;
    }
  };
  // Ultimo resort: un oggetto vuoto. Non far fallire l'avvio della sessione per
  // un catalogo mancante — t() emetterà [missing i18n key: ...] su ogni chiave,
  // quindi il guasto resta rumorosamente visibile invece di beinge silently lost.
  const catalog = read(lang) ?? read(FALLBACK) ?? {};
  cache.set(lang, catalog);
  return catalog;
}

/** Interpola {name} con i valori forniti. */
function interpolate(template, vars) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

/**
 * Costruisce il traduttore per una lingua.
 * t('error.cardTooLong', { len, max })
 * Le chiavi mancanti rivelano il path completo invece di fallire in silenzio.
 */
export function makeT(lang) {
  const catalog = loadCatalog(lang);
  return function t(key, vars) {
    const template = key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), catalog);
    if (typeof template !== 'string') {
      // Non degradare in silenzio: un errore di chiave deve essere evidente.
      return `[missing i18n key: ${key} (${lang})]`;
    }
    return interpolate(template, vars);
  };
}

/** Espande {name} dentro un array di stringhe (righe di prompt). */
export function interpolateAll(lines, vars) {
  return lines.map((line) => interpolate(line, vars));
}

/**
 * Alias delle intestazioni di sezione, da usare come pattern nel parser.
 * Contiene SEMPRE gli alias di entrambe le lingue, cosi' una carta resta
 * modificabile anche dopo un cambio di lingua della configurazione.
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

/** Titoli canonici delle sezioni, per la lingua attiva. */
export function sectionTitles(lang) {
  const catalog = loadCatalog(lang);
  return {
    always: catalog?.section?.always ?? 'Always valid',
    active: catalog?.section?.active ?? 'Active work',
    topic: catalog?.section?.topicPrefix ?? 'Topic',
  };
}
