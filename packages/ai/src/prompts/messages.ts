import type { ChatMessage } from '../gateway/types.js';
import { escapeData, truncate } from './escape.js';

/** A completed earlier turn. Turns without an answer (blocked/failed) should be omitted by the caller or are skipped. */
export interface HistoryTurn {
  founderText: string;
  /** The validated `CoachResponse.answer`, or null if the turn produced none. */
  answer: string | null;
}

export interface BuildMessagesOptions {
  /** Rendered `buildEvidenceBlock(...)`, placed in the final user message ahead of the founder's text. */
  evidenceBlock?: string;
  /** Most recent turns to keep. Default 8. */
  maxHistoryTurns?: number;
  /** Per-message cap for history. Default 2 000 characters. */
  maxHistoryChars?: number;
}

function wrapFounder(text: string): string {
  return `<founder_message>\n${escapeData(text)}\n</founder_message>`;
}

/**
 * Builds the conversation for a turn: the last N completed turns (founder text wrapped and escaped
 * as data, previous answers as assistant messages), then the evidence block and the new founder
 * message as the final user message. Evidence lives in the user turn — not the system prompt — so
 * retrieved text never gains system-level authority.
 */
export function buildMessages(
  history: readonly HistoryTurn[],
  founderText: string,
  options: BuildMessagesOptions = {},
): ChatMessage[] {
  const maxTurns = Math.max(0, options.maxHistoryTurns ?? 8);
  const maxChars = options.maxHistoryChars ?? 2_000;
  const completed = history.filter(
    (t) => t.answer !== null && t.answer.trim() !== '' && t.founderText.trim() !== '',
  );
  const recent = maxTurns === 0 ? [] : completed.slice(-maxTurns);

  const messages: ChatMessage[] = [];
  for (const turn of recent) {
    messages.push({ role: 'user', content: wrapFounder(truncate(turn.founderText, maxChars)) });
    messages.push({ role: 'assistant', content: truncate(turn.answer ?? '', maxChars) });
  }
  const parts = [options.evidenceBlock, wrapFounder(founderText)].filter(
    (p): p is string => p !== undefined && p !== '',
  );
  messages.push({ role: 'user', content: parts.join('\n\n') });
  return messages;
}
