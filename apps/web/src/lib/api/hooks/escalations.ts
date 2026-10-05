import {
  CreateEscalationRequest,
  CreateEscalationResponse,
  EscalationAction,
  EscalationActionResponse,
  EscalationListResponse,
} from '@foundry/contracts';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';

import { encodeBody } from '../body';
import { api, createIdempotencyKey, path } from '../client';
import { queryKeys } from '../query-keys';

/** GET /ventures/:id/escalations */
export const ventureEscalationsQueryOptions = (ventureId: string) =>
  queryOptions({
    queryKey: queryKeys.venture.escalations(ventureId),
    queryFn: ({ signal }) =>
      api.get(path`/ventures/${ventureId}/escalations`, EscalationListResponse, { signal }),
  });

export function useVentureEscalations(ventureId: string) {
  return useQuery({ ...ventureEscalationsQueryOptions(ventureId), select: (data) => data.items });
}

/** GET /inbox/escalations — escalations routed to the signed-in EIR / program lead. */
export const inboxEscalationsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.inbox.escalations(),
    queryFn: ({ signal }) => api.get('/inbox/escalations', EscalationListResponse, { signal }),
  });

export function useInboxEscalations(options: { enabled?: boolean } = {}) {
  return useQuery({
    ...inboxEscalationsQueryOptions(),
    select: (data) => data.items,
    enabled: options.enabled ?? true,
  });
}

function useInvalidateEscalations() {
  const client = useQueryClient();
  return (ventureId: string) => {
    void client.invalidateQueries({ queryKey: queryKeys.venture.escalations(ventureId) });
    void client.invalidateQueries({ queryKey: queryKeys.venture.overview(ventureId) });
    void client.invalidateQueries({ queryKey: queryKeys.inbox.escalations() });
    void client.invalidateQueries({ queryKey: queryKeys.program.escalations() });
    void client.invalidateQueries({ queryKey: queryKeys.ventures.list() });
  };
}

export type CreateEscalationInput = z.input<typeof CreateEscalationRequest>;

/** POST /ventures/:id/escalations → 201 `EscalationView` (awaiting the founder's sharing consent). */
export function useCreateEscalation(ventureId: string) {
  const invalidate = useInvalidateEscalations();
  return useMutation({
    mutationFn: (input: CreateEscalationInput) =>
      api.post(
        path`/ventures/${ventureId}/escalations`,
        CreateEscalationResponse,
        encodeBody(CreateEscalationRequest, input),
        {
          idempotencyKey: createIdempotencyKey(),
        },
      ),
    onSuccess: () => {
      invalidate(ventureId);
    },
  });
}

export type EscalationActionInput = z.input<typeof EscalationAction>;

/**
 * PATCH /escalations/:id — founder: approve_sharing / edit / withdraw; assignee: acknowledge /
 * resolve / decline.
 */
export function useEscalationAction() {
  const invalidate = useInvalidateEscalations();
  return useMutation({
    mutationFn: ({ escalationId, action }: { escalationId: string; action: EscalationActionInput }) =>
      api.patch(
        path`/escalations/${escalationId}`,
        EscalationActionResponse,
        encodeBody(EscalationAction, action),
        { idempotencyKey: createIdempotencyKey() },
      ),
    onSuccess: (escalation) => {
      invalidate(escalation.ventureId);
    },
  });
}
