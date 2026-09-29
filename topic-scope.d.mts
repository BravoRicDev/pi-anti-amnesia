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

/** Alias delle intestazioni di sezione accettate dal parser (IT + EN). */
export interface SectionAliases {
  always: string[];
  active: string[];
  topic: string[];
}

/**
 * Opzioni di localizzazione. Passale sempre: senza, il parser ricade sui
 * default italiani per compatibilita' con le carte gia' scritte.
 */
export interface ScopeOptions {
  aliases?: SectionAliases;
  /** Titolo canonico della sezione attiva, per i messaggi di errore. */
  activeTitle?: string;
  /** Messaggio tradotto per 'una sola sezione attiva', con {active}. */
  exactlyOneActive?: string;
  /** Locale per il matching dei token, es. 'it-IT' | 'en-US'. */
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
export function extractLatestUserText(messages: UserMessage[]): string;
