import type { Me, SessionView, VentureDetail } from '@foundry/contracts';

import { canWrite } from '@/lib/auth/roles';
import { veirName } from '@/lib/veir';

export interface CoachingAvailability {
  /** Whether new conversations or messages can be started from this screen. */
  available: boolean;
  /** Short title (the disabled composer's placeholder). */
  title: string | null;
  /** Plain-language reason, never blaming the founder. */
  reason: string | null;
}

const OK: CoachingAvailability = { available: true, title: null, reason: null };

/**
 * UI-side check for the chat controls (the API enforces the same rules on every request): read-only
 * roles, the global kill switch, a missing or suspended vEIR, an archived venture and the conversation's
 * own state.
 */
export function coachingAvailability(
  me: Me,
  venture: Pick<VentureDetail, 'id' | 'persona' | 'status'>,
  session?: Pick<SessionView, 'status'> | null,
): CoachingAvailability {
  if (!canWrite(me, venture.id)) {
    return { available: false, title: 'Read-only', reason: 'Only founders and the team can chat.' };
  }
  if (!me.aiEnabled) {
    return {
      available: false,
      title: 'AI is paused',
      reason: 'An admin paused AI. Everything else works.',
    };
  }
  if (!venture.persona) {
    return {
      available: false,
      title: 'No vEIR yet',
      reason: 'Your program lead can assign one.',
    };
  }
  if (venture.persona.status === 'suspended') {
    const name = veirName(venture.persona.name, venture.persona.kind);
    return {
      available: false,
      title: `${name} is paused`,
      reason: 'Paused by a reviewer. Past chats and human help still work.',
    };
  }
  if (venture.status === 'archived') {
    return { available: false, title: 'Archived', reason: 'Archived ventures are read-only.' };
  }
  if (session?.status === 'ended') {
    return { available: false, title: 'Ended', reason: 'This conversation has ended.' };
  }
  if (session?.status === 'suspended') {
    return {
      available: false,
      title: 'Paused',
      reason: 'A safety control paused this. You can ask a person.',
    };
  }
  return OK;
}
