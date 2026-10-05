import {
  UpdateVentureRequest,
  VentureDetailResponse,
  VentureListResponse,
  VentureOverview,
  type VentureDetail,
} from '@foundry/contracts';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';

import { encodeBody } from '../body';
import { api, createIdempotencyKey, path } from '../client';
import { queryKeys } from '../query-keys';

/** GET /ventures — ventures the principal can access (membership or assignment). */
export const venturesQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.ventures.list(),
    queryFn: ({ signal }) => api.get('/ventures', VentureListResponse, { signal }),
  });

/** Ventures as an array (`data` is `VentureSummary[]`). */
export function useVentures() {
  return useQuery({ ...venturesQueryOptions(), select: (data) => data.items });
}

/** GET /ventures/:id */
export const ventureQueryOptions = (ventureId: string) =>
  queryOptions({
    queryKey: queryKeys.venture.detail(ventureId),
    queryFn: ({ signal }) => api.get(path`/ventures/${ventureId}`, VentureDetailResponse, { signal }),
  });

export function useVenture(ventureId: string) {
  return useQuery(ventureQueryOptions(ventureId));
}

/** GET /ventures/:id/overview — the "since last session" brief. */
export const ventureOverviewQueryOptions = (ventureId: string) =>
  queryOptions({
    queryKey: queryKeys.venture.overview(ventureId),
    queryFn: ({ signal }) => api.get(path`/ventures/${ventureId}/overview`, VentureOverview, { signal }),
  });

export function useVentureOverview(ventureId: string) {
  return useQuery(ventureOverviewQueryOptions(ventureId));
}

export type UpdateVentureInput = z.input<typeof UpdateVentureRequest>;

/** PATCH /ventures/:id */
export function useUpdateVenture(ventureId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateVentureInput): Promise<VentureDetail> =>
      api.patch(
        path`/ventures/${ventureId}`,
        VentureDetailResponse,
        encodeBody(UpdateVentureRequest, input),
        {
          idempotencyKey: createIdempotencyKey(),
        },
      ),
    onSuccess: (venture) => {
      client.setQueryData(queryKeys.venture.detail(ventureId), venture);
      void client.invalidateQueries({ queryKey: queryKeys.venture.overview(ventureId) });
      void client.invalidateQueries({ queryKey: queryKeys.ventures.list() });
    },
  });
}
