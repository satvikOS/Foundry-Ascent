import { HealthResponse } from '@foundry/contracts';
import { queryOptions, useQuery } from '@tanstack/react-query';
import type { z } from 'zod';

import { api } from '../client';
import { queryKeys } from '../query-keys';

export type Health = z.infer<typeof HealthResponse>;

/**
 * GET /health (public). Deliberately NOT polled: frequent health checks would keep the Aurora
 * cluster from auto-pausing. Fetched once per mount, refreshed at most every 5 minutes.
 */
export const healthQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.health(),
    queryFn: ({ signal }) => api.get('/health', HealthResponse, { signal, waitForResume: false }),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

export function useHealth() {
  return useQuery(healthQueryOptions());
}
