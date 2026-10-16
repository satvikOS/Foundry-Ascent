import type { ChatMessage } from '../gateway/types.js';
import { buildContinuityBlock, type PromptContinuity } from './continuity.js';
import { deriveConversationState, renderConversationState } from './conversation-state.js';
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
  /**
   * The vEIR's notes (the same object passed to `buildSystemPrompt`). Rendered with
   * `buildContinuityBlock` as untrusted data at the start of the final user message.
   */
  continuity?: PromptContinuity | null;
  /** ISO date (YYYY-MM-DD) for marking overdue commitments in the notes. Default: today (UTC). */
  today?: string;
  /** Upper bound on the rendered notes. Default 6 000 characters. */
  maxContinuityChars?: number;
  /** Most recent turns to keep. Default 8. */
  maxHistoryTurns?: number;
  /** Per-message cap for history. Default 2 000 characters. */
  maxHistoryChars?: number;
  /**
   * Adds the `<conversation_state>` observations (the founder's move, parked threads, the vEIR's recent openings
   * and questions), derived from every completed turn given, not only the ones kept. Default true.
   */
  conversationState?: boolean;
  /**
   * The conversation's opener when it is replayed as the vEIR's first message (the caller prepends it): the
   * founder's first message is read as the reply to it in `<conversation_state>`.
   */
  opener?: string | null;
}

function wrapFounder(text: string): string {
  return `<founder_message>\n${escapeData(text)}\n</founder_message>`;
}

/**
 * The rendered `<conversation_state>` of a history and a new message, kept per history array: it does not depend
 * on how much of the history is kept, and the context budget builds the same turn's messages up to ~50 times.
 */
const stateBlocks = new WeakMap<
  readonly HistoryTurn[],
  {
    readonly length: number;
    readonly founderText: string;
    readonly opener: string | null;
    readonly block: string;
  }
>();

function conversationStateBlock(
  history: readonly HistoryTurn[],
  completed: readonly HistoryTurn[],
  founderText: string,
  opener: string | null,
): string {
  const cached = stateBlocks.get(history);
  if (cached?.length === history.length && cached.founderText === founderText && cached.opener === opener) {
    return cached.block;
  }
  const block = renderConversationState(deriveConversationState(completed, founderText, { opener }));
  stateBlocks.set(history, { length: history.length, founderText, opener, block });
  return block;
}

/**
 * Builds the conversation for a turn: the last N completed turns (founder text wrapped and escaped
 * as data, previous answers as assistant messages), then the vEIR's notes, the evidence block, the
 * conversation state and the new founder message as the final user message. Notes and evidence live in the user turn — not the
 * system prompt — so neither AI notes nor retrieved text ever gain system-level authority.
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
  const notes = buildContinuityBlock(options.continuity, {
    ...(options.today !== undefined ? { today: options.today } : {}),
    ...(options.maxContinuityChars !== undefined ? { maxChars: options.maxContinuityChars } : {}),
  });
  const state =
    options.conversationState === false
      ? ''
      : conversationStateBlock(history, completed, founderText, options.opener ?? null);
  const parts = [notes, options.evidenceBlock, state, wrapFounder(founderText)].filter(
    (p): p is string => p !== undefined && p !== '',
  );
  messages.push({ role: 'user', content: parts.join('\n\n') });
  return messages;
}
