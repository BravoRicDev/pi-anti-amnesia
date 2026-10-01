export type InterpolationVars = Record<string, string | number>;

export type Translator = (key: string, vars?: InterpolationVars) => string;

export interface SectionAliases {
  always: string[];
  active: string[];
  objective: string[];
  plan: string[];
  todo: string[];
  topic: string[];
}

export interface SectionTitles {
  always: string;
  active: string;
  objective: string;
  plan: string;
  todo: string;
  topic: string;
}

export const SUPPORTED: string[];
export const FALLBACK: string;

export function isSupported(lang: string): boolean;

/**
 * Resolves the active language. Call ONCE and freeze the result.
 * @param configured  config.language value ('auto' or a language code)
 */
export function resolveLanguage(
  configured?: string | null,
  env?: Record<string, string | undefined>,
): string;

export function loadCatalog(lang: string): Record<string, unknown>;

export function makeT(lang: string): Translator;

export function interpolateAll(lines: string[], vars: InterpolationVars): string[];

/** Bilingual heading aliases: a card stays editable after a language change. */
export function sectionAliases(lang: string): SectionAliases;

/** Canonical section titles for the active language. */
export function sectionTitles(lang: string): SectionTitles;
