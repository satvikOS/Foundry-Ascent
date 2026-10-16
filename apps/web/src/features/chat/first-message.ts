import type { CoachMode, SessionView } from '@foundry/contracts';
import { useEffect, useRef } from 'react';

import type { TurnStreamState } from '@/lib/api/hooks/turn-stream';
import type { CreateTurnBody } from '@/lib/api/sse';

import type { ComposerMode } from './composer';

/**
 * The first message typed on New chat, handed to the conversation page that New chat opens once the
 * conversation exists. The conversation page sends it through its own turn stream, so the founder sees
 * the usual progress and answer without retyping. Kept in memory only (never persisted to storage);
 * taking it removes it, so it is sent once.
 */
export interface PendingFirstMessage {
  text: string;
  /** Omitted for Auto: the vEIR picks how to help. */
  mode?: CoachMode | undefined;
  rehearsalCounterpart?: string | undefined;
}

/**
 * The body that starts a conversation from New chat (a chat, or a call's conversation). It never carries a
 * title: the server names a standard conversation after its first message unless that message was a crisis,
 * so a message that is blocked never becomes a title in anyone's list. Auto sends no mode. `privacy` is the
 * founder's choice: remembered (`standard`, the default) or private (`ephemeral`, a one-off). `openerShownAt`
 * says what New chat greeted a remembered conversation with: the `at` of the opener it showed (the conversation
 * opens with that line), or null when it showed none (it opens without one); left out, the server chooses.
 */
export function newConversationRequest({
  mode,
  privacy,
  openerShownAt,
}: {
  mode: CoachMode | undefined;
  privacy: SessionView['privacy'];
  openerShownAt?: string | null;
}): { mode?: CoachMode; privacy: SessionView['privacy']; openerShownAt?: string | null } {
  return {
    ...(mode ? { mode } : {}),
    privacy,
    ...(privacy === 'standard' && openerShownAt !== undefined ? { openerShownAt } : {}),
  };
}

const pending = new Map<string, PendingFirstMessage>();
const modes = new Map<string, ComposerMode>();

/** Hand the first message to the conversation page, and keep the mode chosen with it for follow-ups. */
export function setPendingFirstMessage(sessionId: string, message: PendingFirstMessage): void {
  rememberComposerMode(sessionId, message.mode ?? 'auto');
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

/**
 * The mode the composer shows for a conversation: the last one chosen in this browser tab, else Auto.
 * Auto is never sent (the turn omits `mode`), so it carries across follow-ups and reloads alike.
 */
export function rememberedComposerMode(sessionId: string): ComposerMode {
  return modes.get(sessionId) ?? 'auto';
}

export function rememberComposerMode(sessionId: string, mode: ComposerMode): void {
  if (mode === 'auto') modes.delete(sessionId);
  else modes.set(sessionId, mode);
}

interface HandoffOptions {
  sessionId: string;
  /** The conversation is loaded and has no turns yet. */
  ready: boolean;
  /** Messages can be sent now (kill switch, persona and conversation state allow it). */
  canSend: boolean;
  send: (body: CreateTurnBody) => Promise<TurnStreamState['status']>;
  /** Puts text back into the composer (unsendable, or stopped by the founder). */
  restore: (text: string) => void;
  /** Carries a rehearsal counterpart chosen on New chat into the conversation's composer. */
  setCounterpart: (counterpart: string) => void;
}

/**
 * Sends the first message typed on New chat once its conversation is ready. Scheduled rather than sent
 * inline, so a development double-mount cancels the timer instead of an in-flight turn. When it can't be
 * sent, or the founder stops it, the words go back into the composer; a failed send stays on screen with
 * Try again and Edit, like any other message.
 */
export function useFirstMessageHandoff({
  sessionId,
  ready,
  canSend,
  send,
  restore,
  setCounterpart,
}: HandoffOptions): void {
  const restoreRef = useRef(restore);
  const counterpartRef = useRef(setCounterpart);
  useEffect(() => {
    restoreRef.current = restore;
    counterpartRef.current = setCounterpart;
  }, [restore, setCounterpart]);

  useEffect(() => {
    if (!ready || !hasPendingFirstMessage(sessionId)) return;
    const timer = setTimeout(() => {
      const first = takePendingFirstMessage(sessionId);
      if (!first) return;
      if (first.rehearsalCounterpart) counterpartRef.current(first.rehearsalCounterpart);
      if (!canSend) {
        restoreRef.current(first.text);
        return;
      }
      void send({
        text: first.text,
        ...(first.mode ? { mode: first.mode } : {}),
        ...(first.rehearsalCounterpart ? { rehearsalCounterpart: first.rehearsalCounterpart } : {}),
      }).then((outcome) => {
        if (outcome === 'cancelled') restoreRef.current(first.text);
      });
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [ready, canSend, sessionId, send]);
}
