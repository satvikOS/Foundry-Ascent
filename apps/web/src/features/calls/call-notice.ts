import { CallNoticeAcknowledgement, type CallConfigResponse } from '@foundry/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';

import { api, createIdempotencyKey } from '@/lib/api/client';
import { safeStorage } from '@/lib/storage';

/** This browser's copy of the server's answer, per person (a cache only; the server decides). */
export function callNoticeCacheKey(principalId: string): string {
  return `fa.call.notice.${principalId}`;
}

/** Call settings queries (`[...venture scope, 'call-config']`): every venture's carries the person's answer. */
function isCallConfigKey(key: readonly unknown[]): boolean {
  return key.at(-1) === 'call-config';
}

/**
 * Whether this person acknowledged how a call handles their voice (the first call shows it before starting).
 * The server keeps it with the person (`callNoticeAcknowledgedAt` in the call settings), so the notice shows in
 * every browser until the server says so; this browser only caches the answer for the moment before the call
 * settings load. `acknowledge` stores it on the server (idempotent) and updates the loaded call settings.
 */
export function useCallNotice(
  principalId: string,
  config: Pick<CallConfigResponse, 'callNoticeAcknowledgedAt'> | undefined,
): [seen: boolean, acknowledge: () => void] {
  const client = useQueryClient();
  const key = callNoticeCacheKey(principalId);
  const server = config?.callNoticeAcknowledgedAt;

  // Keep the cache in step with the server, which wins whenever it has answered.
  useEffect(() => {
    if (server === undefined) return;
    if (server === null) safeStorage.remove(key);
    else safeStorage.set(key, server);
  }, [key, server]);

  const seen = server === undefined ? safeStorage.get(key) !== null : server !== null;

  const acknowledge = useCallback(() => {
    if (server) return;
    void api
      .post('/calls/notice/acknowledge', CallNoticeAcknowledgement, undefined, {
        idempotencyKey: createIdempotencyKey(),
      })
      .then(({ acknowledgedAt }) => {
        safeStorage.set(key, acknowledgedAt);
        client.setQueriesData<CallConfigResponse>(
          { predicate: (query) => isCallConfigKey(query.queryKey) },
          (previous) =>
            previous
              ? { ...previous, callNoticeAcknowledgedAt: previous.callNoticeAcknowledgedAt ?? acknowledgedAt }
              : previous,
        );
      })
      // Not stored: the notice shows again before the next call, which then stores it.
      .catch(() => undefined);
  }, [client, key, server]);

  return [seen, acknowledge];
}
