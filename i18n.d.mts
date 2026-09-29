export type InterpolationVars = Record<string, string | number>;

export type Translator = (key: string, vars?: InterpolationVars) => string;

export interface SectionAliases {
  always: string[];
  active: string[];
  topic: string[];
}

export interface SectionTitles {
  always: string;
  active: string;
  topic: string;
}

export const SUPPORTED: string[];
export const FALLBACK: string;

export function isSupported(lang: string): boolean;

/**
 * Risolve la lingua attiva. Chiamare UNA volta e congelare il risultato.
 * @param configured  valore di config.language ('auto' o un codice lingua)
 */
export function resolveLanguage(
  configured?: string | null,
  env?: Record<string, string | undefined>,
): string;

export function loadCatalog(lang: string): Record<string, unknown>;

export function makeT(lang: string): Translator;

export function interpolateAll(lines: string[], vars: InterpolationVars): string[];

/** Alias bilingui delle intestazioni: una carta resta editabile dopo il cambio lingua. */
export function sectionAliases(lang: string): SectionAliases;

/** Titoli canonici delle sezioni per la lingua attiva. */
export function sectionTitles(lang: string): SectionTitles;
