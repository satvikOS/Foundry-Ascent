import type { TurnStreamState } from '@/lib/api/hooks/turn-stream';

export interface Announcement {
  readonly text: string;
  readonly politeness: 'polite' | 'assertive';
}

/**
 * What a screen reader hears when a turn ends (content-free), matching what the page shows. It says only what
 * happened: a held-back answer is never "handed to a person" (nothing reaches anyone until the founder asks
 * for help or consents to share a drafted request), and "still answering" only while a re-check is scheduled.
 */
export function turnOutcomeAnnouncement(
  state: Pick<TurnStreamState, 'status' | 'blocked' | 'autoRetryAt'>,
  personaName: string,
): Announcement | null {
  switch (state.status) {
    case 'completed':
      return { text: 'Response ready.', politeness: 'polite' };
    case 'blocked':
      return { text: blockedAnnouncement(state.blocked), politeness: 'assertive' };
    case 'failed':
      // The replay of a message the server is still answering, when one is actually scheduled.
      return state.autoRetryAt !== null
        ? { text: `Still answering. ${personaName} will check again shortly.`, politeness: 'polite' }
        : { text: 'The response could not be completed.', politeness: 'assertive' };
    case 'cancelled':
      return { text: 'Stopped.', politeness: 'polite' };
    default:
      return null;
  }
}

/** The blocked panel's title in words, plus the drafted request when there is one (never sent yet). */
function blockedAnnouncement(blocked: TurnStreamState['blocked']): string {
  const reason = blocked?.reason ?? null;
  const drafted = blocked?.escalationId
    ? ' A support request was drafted for you to review. Nothing is shared until you do.'
    : '';
  switch (reason) {
    case 'crisis_support':
      return `You deserve support from a person. Support options are shown.${drafted}`;
    case 'policy':
    case 'cross_venture':
    case 'identity':
    case 'invalid_schema':
      return `This answer was held back. You can ask again, or ask a person.${drafted}`;
    default:
      return `This is one for a person. You can ask a person for help.${drafted}`;
  }
}
