import type { CallConfigResponse } from '@foundry/contracts';
import { useQuery } from '@tanstack/react-query';

import { callConfigQueryOptions } from './use-call-veir';

/** Whether the call settings let this person call now: AI on and calls on (`calls_enabled`). */
export function callsOn(config: Pick<CallConfigResponse, 'aiEnabled' | 'callsEnabled'> | undefined): boolean {
  return config !== undefined && config.aiEnabled && config.callsEnabled !== false;
}

/**
 * Whether the venture's Call entry points show (sidebar, ⌘K, New chat, the conversation header and composer,
 * the phone bar): only for people who can write to the venture, and only once the call settings say calls are
 * on. Until they load, and when calls are paused, the entries are not there at all, so there is never a
 * link to a call that cannot start.
 */
export function useCallsAvailable(ventureId: string | null | undefined, writable: boolean): boolean {
  const config = useQuery({
    ...callConfigQueryOptions(ventureId ?? ''),
    enabled: writable && Boolean(ventureId),
  });
  return writable && Boolean(ventureId) && callsOn(config.data);
}
