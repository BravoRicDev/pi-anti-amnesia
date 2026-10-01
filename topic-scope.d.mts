export interface TopicCardSelection {
  text: string;
  hasTopics: boolean;
  topicMatched: boolean;
  hasActive: boolean;
  unclassified: string[];
  legacy: boolean;
}

export interface UserMessage {
  role: string;
  content?: unknown;
}

/** Section heading aliases accepted by the parser (IT + EN). */
export interface SectionAliases {
  always: string[];
  active: string[];
  objective: string[];
  plan: string[];
  todo: string[];
  topic: string[];
}

/**
 * Localization options. Always pass them: without, the parser falls back to
 * the Italian defaults for compatibility with already-written cards.
 */
export interface ScopeOptions {
  aliases?: SectionAliases;
  /** Canonical title of the active section, for error messages. */
  activeTitle?: string;
  /** Translated message for 'exactly one active section', with {active}. */
  exactlyOneActive?: string;
  /** Locale for token matching, e.g. 'it-IT' | 'en-US'. */
  locale?: string;
}

export function selectCardForTopic(
  text: string,
  userText: string,
  opts?: ScopeOptions,
): TopicCardSelection;
export function replaceActiveCheckpoint(
  card: string,
  checkpoint: string,
  opts?: ScopeOptions,
): string;
/**
 * Replaces the body of ONE section and leaves every other section untouched; appends the
 * section when it does not exist yet. Throws when the alias matches more than once, because
 * rewriting the wrong one of two identical headings is silent corruption.
 */
export function replaceBlock(
  card: string,
  kind: string,
  value: string,
  opts?: ScopeOptions,
): string;
/**
 * Ticks or unticks ONE item of the todo block, by 1-based index or by its text. Throws on an
 * ambiguous address rather than guessing, and on a todo section that is missing or duplicated.
 */
export function checkTodo(
  card: string,
  target: number | string,
  done: boolean | string,
  opts?: ScopeOptions,
): string;
export function extractLatestUserText(messages: UserMessage[]): string;
