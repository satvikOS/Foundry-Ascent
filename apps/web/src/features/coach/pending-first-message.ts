import type { CoachMode } from '@foundry/contracts';

/**
 * The first message typed on New chat, handed to the conversation page that New chat opens once the
 * conversation exists. The conversation page sends it through its own turn stream, so the founder sees
 * the usual progress and answer without retyping. Kept in memory only (never persisted to storage);
 * taking it removes it, so it is sent once.
 */
export interface PendingFirstMessage {
  text: string;
  /** Omitted for "Auto": the conversation's own mode applies. */
  mode?: CoachMode | undefined;
  rehearsalCounterpart?: string | undefined;
}

const pending = new Map<string, PendingFirstMessage>();

export function setPendingFirstMessage(sessionId: string, message: PendingFirstMessage): void {
  if (message.text.trim()) pending.set(sessionId, message);
}

/** Whether a first message is waiting for this conversation (non-destructive). */
export function hasPendingFirstMessage(sessionId: string): boolean {
  return pending.has(sessionId);
}

/** Take the waiting first message for this conversation, if any (destructive: it is sent once). */
export function takePendingFirstMessage(sessionId: string): PendingFirstMessage | null {
  const message = pending.get(sessionId) ?? null;
  pending.delete(sessionId);
  return message;
}
