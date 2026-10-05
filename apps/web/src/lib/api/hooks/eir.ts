import {
  ApprovePersonaReleaseResponse,
  CreatePersonaReleaseRequest,
  CreatePersonaReleaseResponse,
  PersonaListResponse,
  PersonaReleaseDetailResponse,
  PersonaView,
  ResumePersonaResponse,
  ReviewQueueResponse,
  SubmitReviewRequest,
  SubmitReviewResponse,
  SuspendPersonaRequest,
  SuspendPersonaResponse,
} from '@foundry/contracts';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';

import { encodeBody } from '../body';
import { api, createIdempotencyKey, path } from '../client';
import { queryKeys } from '../query-keys';

export type ReviewSampleView = z.infer<typeof ReviewQueueResponse>['items'][number];

/** GET /personas */
export const personasQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.personas.list(),
    queryFn: ({ signal }) => api.get('/personas', PersonaListResponse, { signal }),
  });

export function usePersonas() {
  return useQuery({ ...personasQueryOptions(), select: (data) => data.items });
}

/** GET /personas/:id */
export const personaQueryOptions = (personaId: string) =>
  queryOptions({
    queryKey: queryKeys.personas.detail(personaId),
    queryFn: ({ signal }) => api.get(path`/personas/${personaId}`, PersonaView, { signal }),
  });

export function usePersona(personaId: string) {
  return useQuery(personaQueryOptions(personaId));
}

/**
 * GET /persona-releases/:id — one release with its full doctrine, style, disclosure and modes (drafts:
 * program leads, platform admins and the persona's EIR). `null` disables the query.
 */
export const personaReleaseQueryOptions = (releaseId: string) =>
  queryOptions({
    queryKey: queryKeys.personas.release(releaseId),
    queryFn: ({ signal }) =>
      api.get(path`/persona-releases/${releaseId}`, PersonaReleaseDetailResponse, { signal }),
  });

export function usePersonaRelease(releaseId: string | null) {
  return useQuery({
    ...personaReleaseQueryOptions(releaseId ?? ''),
    enabled: releaseId !== null,
  });
}

function useInvalidatePersonas() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: queryKeys.personas.all() });
}

export type CreatePersonaReleaseInput = z.input<typeof CreatePersonaReleaseRequest>;

/** POST /personas/:id/releases → 201 draft `PersonaReleaseView` (also cached as its release detail). */
export function useCreatePersonaRelease(personaId: string) {
  const client = useQueryClient();
  const invalidate = useInvalidatePersonas();
  return useMutation({
    mutationFn: (input: CreatePersonaReleaseInput) =>
      api.post(
        path`/personas/${personaId}/releases`,
        CreatePersonaReleaseResponse,
        encodeBody(CreatePersonaReleaseRequest, input),
        {
          idempotencyKey: createIdempotencyKey(),
        },
      ),
    onSuccess: (release) => {
      client.setQueryData(queryKeys.personas.release(release.id), release);
      return invalidate();
    },
  });
}

/** POST /persona-releases/:id/approve → 200 approved `PersonaReleaseView`. */
export function useApprovePersonaRelease() {
  const invalidate = useInvalidatePersonas();
  return useMutation({
    mutationFn: (releaseId: string) =>
      api.post(path`/persona-releases/${releaseId}/approve`, ApprovePersonaReleaseResponse, undefined, {
        idempotencyKey: createIdempotencyKey(),
      }),
    onSuccess: invalidate,
  });
}

/** POST /personas/:id/suspend — human kill switch; takes effect on the next turn. */
export function useSuspendPersona() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ personaId, reason }: { personaId: string; reason: string }) =>
      api.post(
        path`/personas/${personaId}/suspend`,
        SuspendPersonaResponse,
        encodeBody(SuspendPersonaRequest, { reason }),
        {
          idempotencyKey: createIdempotencyKey(),
        },
      ),
    onSuccess: (persona) => {
      client.setQueryData(queryKeys.personas.detail(persona.id), persona);
      void client.invalidateQueries({ queryKey: queryKeys.personas.all() });
      // Ventures show the persona status in their context bar.
      void client.invalidateQueries({ queryKey: ['fa', 'venture'] });
    },
  });
}

/** POST /personas/:id/resume */
export function useResumePersona() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (personaId: string) =>
      api.post(path`/personas/${personaId}/resume`, ResumePersonaResponse, undefined, {
        idempotencyKey: createIdempotencyKey(),
      }),
    onSuccess: (persona) => {
      client.setQueryData(queryKeys.personas.detail(persona.id), persona);
      void client.invalidateQueries({ queryKey: queryKeys.personas.all() });
      void client.invalidateQueries({ queryKey: ['fa', 'venture'] });
    },
  });
}

/** GET /eir/reviews — blind calibration samples from assigned ventures. */
export const reviewQueueQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.eir.reviews(),
    queryFn: ({ signal }) => api.get('/eir/reviews', ReviewQueueResponse, { signal }),
  });

/** `enabled: false` for people who are not EIRs (the API answers 403: reviews belong to assigned EIRs). */
export function useReviewQueue(options: { enabled?: boolean } = {}) {
  return useQuery({
    ...reviewQueueQueryOptions(),
    select: (data) => data.items,
    enabled: options.enabled ?? true,
  });
}

export type SubmitReviewInput = z.input<typeof SubmitReviewRequest>;

/** POST /eir/reviews/:turnId → 201 `{ reviewId, turnId }`. */
export function useSubmitReview() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ turnId, review }: { turnId: string; review: SubmitReviewInput }) =>
      api.post(path`/eir/reviews/${turnId}`, SubmitReviewResponse, encodeBody(SubmitReviewRequest, review), {
        idempotencyKey: createIdempotencyKey(),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.eir.reviews() }),
  });
}
