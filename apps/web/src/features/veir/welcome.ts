import { VeirWelcomeAcknowledgement, type Me } from '@foundry/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { api, createIdempotencyKey } from '@/lib/api/client';
import { meQueryOptions } from '@/lib/api/hooks/auth';
import { queryKeys } from '@/lib/api/query-keys';

/**
 * Whether this person has read the welcome that introduces their vEIR, and a way to say they have. The server
 * keeps it with the person (`Me.veirWelcomeAcknowledgedAt`, migration 0016), so it shows once in any browser.
 * Acknowledging closes it at once (the cached principal is updated first) and stores it (idempotent); if that
 * fails, the principal is read again, so the welcome may show once more next time.
 */
export function useVeirWelcome(signedIn: Me): [seen: boolean, acknowledge: () => void] {
  // The cached principal (read, never fetched here), which acknowledging updates; else the one given.
  const { data } = useQuery({ ...meQueryOptions(), enabled: false });
  const me = data ?? signedIn;
  const client = useQueryClient();
  // Absent (an older API) counts as read: only an explicit null shows the welcome.
  const seen = me.veirWelcomeAcknowledgedAt !== null;

  const acknowledge = useCallback(() => {
    if (seen) return;
    const stamp = (at: string) => {
      client.setQueryData<Me | null>(queryKeys.me(), (previous) =>
        previous
          ? { ...previous, veirWelcomeAcknowledgedAt: previous.veirWelcomeAcknowledgedAt ?? at }
          : previous,
      );
    };
    stamp(new Date().toISOString());
    void api
      .post('/me/veir-welcome/acknowledge', VeirWelcomeAcknowledgement, undefined, {
        idempotencyKey: createIdempotencyKey(),
      })
      .then(({ acknowledgedAt }) => {
        client.setQueryData<Me | null>(queryKeys.me(), (previous) =>
          previous ? { ...previous, veirWelcomeAcknowledgedAt: acknowledgedAt } : previous,
        );
      })
      .catch(() => {
        void client.invalidateQueries({ queryKey: queryKeys.me() });
      });
  }, [client, seen]);

  return [seen, acknowledge];
}
