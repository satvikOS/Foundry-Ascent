import type { TurnView } from '@foundry/contracts';
import type { QueryClient } from '@tanstack/react-query';

import type { SessionDetail } from '@/lib/api/hooks/sessions';
import { queryKeys } from '@/lib/api/query-keys';
import { refreshVentureAfterTurn } from '@/lib/api/venture-refresh';
import { browserCallDeps } from '@/lib/realtime/browser';
import { CallEngine } from '@/lib/realtime/call-engine';

/**
 * The person's one CallEngine, wired to the browser and to the query cache: a finished turn joins the
 * conversation's transcript, and the venture's data (memory proposals, call minutes) is refreshed.
 * Loaded on demand with the call screen.
 */
export function createCallEngine(queryClient: QueryClient): CallEngine {
  const engine: CallEngine = new CallEngine(
    browserCallDeps((sessionId: string, turn: TurnView | null) => {
      if (turn) {
        queryClient.setQueryData<SessionDetail>(queryKeys.session.detail(sessionId), (previous) =>
          previous
            ? {
                session: {
                  ...previous.session,
                  turnCount: Math.max(previous.session.turnCount, turn.ordinal),
                },
                turns: [...previous.turns.filter((t) => t.id !== turn.id), turn].sort(
                  (a, b) => a.ordinal - b.ordinal,
                ),
              }
            : previous,
        );
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.session.detail(sessionId) });
      const ventureId = engine.getSnapshot().ventureId;
      // A finished turn refreshes what a turn changes; the end of a call (no turn) the whole venture.
      if (ventureId && turn) refreshVentureAfterTurn(queryClient, ventureId);
      else if (ventureId)
        void queryClient.invalidateQueries({ queryKey: queryKeys.venture.scope(ventureId) });
    }),
  );
  return engine;
}
