import type { SessionView, TurnView } from '@foundry/contracts';
import { useEffect, useRef } from 'react';

/**
 * Where a conversation opens, once, when it first loads: an ended one opened for its summary at the summary, an
 * open one at its latest exchange. The first load is over as soon as the conversation is there, with or without
 * turns, so turns that arrive later (the first answer of a conversation started from New chat) never move the
 * page: a founder who scrolled while it streamed stays where they are.
 */
export function useFirstLoadScroll(
  session: Pick<SessionView, 'status'> | null,
  turns: readonly Pick<TurnView, 'id'>[],
  view: string | undefined,
): void {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !session) return;
    done.current = true;
    if (view === 'digest' && session.status === 'ended') {
      document.getElementById('digest')?.scrollIntoView({ block: 'start' });
      return;
    }
    const last = turns[turns.length - 1];
    if (last) document.getElementById(`turn-${last.id}`)?.scrollIntoView({ block: 'start' });
  }, [session, turns, view]);
}
