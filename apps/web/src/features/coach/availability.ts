import type { Me, SessionView, VentureDetail } from '@foundry/contracts';

import { canWrite } from '@/lib/auth/roles';

export interface CoachingAvailability {
  /** Whether new sessions or turns can be started from this screen. */
  available: boolean;
  /** Short title for the banner explaining why not. */
  title: string | null;
  /** Plain-language reason, never blaming the founder. */
  reason: string | null;
}

const OK: CoachingAvailability = { available: true, title: null, reason: null };

/**
 * UI-side check for coaching controls (the API enforces the same rules on every request): the
 * global kill switch, a suspended or missing persona, read-only roles and the session state.
 */
export function coachingAvailability(
  me: Me,
  venture: Pick<VentureDetail, 'id' | 'persona' | 'status'>,
  session?: Pick<SessionView, 'status'> | null,
): CoachingAvailability {
  if (!canWrite(me, venture.id)) {
    return {
      available: false,
      title: 'Read-only',
      reason:
        'You can read this venture’s conversations, but only founders and team members can start or continue them.',
    };
  }
  if (!me.aiEnabled) {
    return {
      available: false,
      title: 'AI coaching is paused',
      reason:
        'An administrator has turned off AI coaching for now. Your knowledge, documents and past conversations are still here.',
    };
  }
  if (!venture.persona) {
    return {
      available: false,
      title: 'No vEIR assigned yet',
      reason: 'This venture doesn’t have a vEIR yet. Your program lead can assign one.',
    };
  }
  if (venture.persona.status === 'suspended') {
    return {
      available: false,
      title: 'Paused by a reviewer',
      reason:
        'A human reviewer has paused this vEIR for now. You can still read past conversations and ask a person for help.',
    };
  }
  if (venture.status === 'archived') {
    return { available: false, title: 'Archived venture', reason: 'This venture is archived and read-only.' };
  }
  if (session?.status === 'ended') {
    return {
      available: false,
      title: 'Conversation ended',
      reason: 'This conversation has ended. Start a new chat to keep going.',
    };
  }
  if (session?.status === 'suspended') {
    return {
      available: false,
      title: 'Conversation paused',
      reason: 'A safety control paused this conversation. A person can help — use “Request support”.',
    };
  }
  return OK;
}
