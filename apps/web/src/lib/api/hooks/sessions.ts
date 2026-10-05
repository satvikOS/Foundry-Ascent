import {
  CreateSessionRequest,
  CreateSessionResponse,
  EndSessionResponse,
  SessionDetailResponse,
  SessionListResponse,
  TurnEvidenceResponse,
  TurnFeedbackRequest,
} from '@foundry/contracts';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';

import { encodeBody } from '../body';
import { api, apiSend, createIdempotencyKey, path } from '../client';
import { queryKeys } from '../query-keys';

export type SessionList = z.infer<typeof SessionListResponse>;
export type SessionDetail = z.infer<typeof SessionDetailResponse>;
export type EndSessionResult = z.infer<typeof EndSessionResponse>;

/** GET /ventures/:id/sessions */
export const sessionsQueryOptions = (ventureId: string) =>
  queryOptions({
    queryKey: queryKeys.venture.sessions(ventureId),
    queryFn: ({ signal }) => api.get(path`/ventures/${ventureId}/sessions`, SessionListResponse, { signal }),
  });

export function useSessions(ventureId: string) {
  return useQuery({ ...sessionsQueryOptions(ventureId), select: (data) => data.items });
}

/** GET /sessions/:id — session plus its turns. */
export const sessionQueryOptions = (sessionId: string) =>
  queryOptions({
    queryKey: queryKeys.session.detail(sessionId),
    queryFn: ({ signal }) => api.get(path`/sessions/${sessionId}`, SessionDetailResponse, { signal }),
  });

export function useSession(sessionId: string) {
  return useQuery(sessionQueryOptions(sessionId));
}

export type CreateSessionInput = z.input<typeof CreateSessionRequest>;

/** POST /ventures/:id/sessions → 201 `SessionView`. */
export function useCreateSession(ventureId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSessionInput = {}) =>
      api.post(
        path`/ventures/${ventureId}/sessions`,
        CreateSessionResponse,
        encodeBody(CreateSessionRequest, input),
        { idempotencyKey: createIdempotencyKey() },
      ),
    onSuccess: (session) => {
      client.setQueryData<SessionDetail>(queryKeys.session.detail(session.id), { session, turns: [] });
      void client.invalidateQueries({ queryKey: queryKeys.venture.sessions(ventureId) });
      void client.invalidateQueries({ queryKey: queryKeys.venture.overview(ventureId) });
      void client.invalidateQueries({ queryKey: queryKeys.ventures.list() });
    },
  });
}

/**
 * Same as useCreateSession, with the venture chosen per call (command palette, home quick start):
 *   startSession.mutate({ ventureId, input: { mode: 'diagnose' } })
 */
export function useStartSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ ventureId, input = {} }: { ventureId: string; input?: CreateSessionInput }) =>
      api.post(
        path`/ventures/${ventureId}/sessions`,
        CreateSessionResponse,
        encodeBody(CreateSessionRequest, input),
        { idempotencyKey: createIdempotencyKey() },
      ),
    onSuccess: (session) => {
      client.setQueryData<SessionDetail>(queryKeys.session.detail(session.id), { session, turns: [] });
      void client.invalidateQueries({ queryKey: queryKeys.venture.sessions(session.ventureId) });
      void client.invalidateQueries({ queryKey: queryKeys.venture.overview(session.ventureId) });
      void client.invalidateQueries({ queryKey: queryKeys.ventures.list() });
    },
  });
}

/**
 * POST /sessions/:id/end → 200 `{ session, recap }`. `recap` is null for ephemeral sessions; its
 * `memory_candidate_ids` are proposed memory items waiting for the founder's approval.
 */
export function useEndSession(ventureId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      api.post(path`/sessions/${sessionId}/end`, EndSessionResponse, undefined, {
        idempotencyKey: createIdempotencyKey(),
      }),
    onSuccess: (result) => {
      client.setQueryData<SessionDetail>(queryKeys.session.detail(result.session.id), (previous) =>
        previous ? { ...previous, session: result.session } : previous,
      );
      void client.invalidateQueries({ queryKey: queryKeys.session.detail(result.session.id) });
      void client.invalidateQueries({ queryKey: queryKeys.venture.scope(ventureId) });
      void client.invalidateQueries({ queryKey: queryKeys.ventures.list() });
    },
  });
}

export type TurnFeedbackInput = z.input<typeof TurnFeedbackRequest>;

/** POST /turns/:id/feedback → 201 `{ feedbackId }` (body not needed). */
export function useTurnFeedback() {
  return useMutation({
    mutationFn: ({ turnId, feedback }: { turnId: string; feedback: TurnFeedbackInput }) =>
      apiSend(path`/turns/${turnId}/feedback`, {
        method: 'POST',
        body: encodeBody(TurnFeedbackRequest, feedback),
        idempotencyKey: createIdempotencyKey(),
      }),
  });
}

/** GET /turns/:id/evidence */
export const turnEvidenceQueryOptions = (turnId: string) =>
  queryOptions({
    queryKey: queryKeys.turn.evidence(turnId),
    queryFn: ({ signal }) => api.get(path`/turns/${turnId}/evidence`, TurnEvidenceResponse, { signal }),
    staleTime: Infinity, // evidence for a completed turn never changes
  });

export function useTurnEvidence(turnId: string | null | undefined) {
  return useQuery({
    ...turnEvidenceQueryOptions(turnId ?? ''),
    enabled: Boolean(turnId),
    select: (data) => data.items,
  });
}
