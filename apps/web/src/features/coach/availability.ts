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
      reason: 'You can read this venture’s sessions, but only founders and team members can coach in it.',
    };
  }
  if (!me.aiEnabled) {
    return {
      available: false,
      title: 'Coaching is paused',
      reason:
        'An administrator has turned off AI coaching for now. Your workspace, memory and past sessions are still available.',
    };
  }
  if (!venture.persona) {
    return {
      available: false,
      title: 'No coach assigned',
      reason:
        'This venture doesn’t have an active coaching assignment yet. Your program lead can set one up.',
    };
  }
  if (venture.persona.status === 'suspended') {
    return {
      available: false,
      title: 'Coach paused by a reviewer',
      reason:
        'A human reviewer has paused Foundry Guide for this venture. You can still read past sessions and escalate to a person.',
    };
  }
  if (venture.status === 'archived') {
    return { available: false, title: 'Archived venture', reason: 'This venture is archived and read-only.' };
  }
  if (session?.status === 'ended') {
    return {
      available: false,
      title: 'Session ended',
      reason: 'This session has ended. Start a new session to keep going.',
    };
  }
  if (session?.status === 'suspended') {
    return {
      available: false,
      title: 'Session paused',
      reason: 'A safety control paused this session. A person can help — use “Request human support”.',
    };
  }
  return OK;
}
