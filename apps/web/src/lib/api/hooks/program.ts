import {
  CreateProgramVentureResponse,
  CreateResourceResponse,
  CreateVentureRequest,
  EscalationAssigneeListResponse,
  EscalationQueueResponse,
  PortfolioSummary,
  ProgramVentureListResponse,
  ResourceListResponse,
  RouteEscalationRequest,
  RouteEscalationResponse,
  UpdateResourceRequest,
  UpdateResourceResponse,
  UpsertResourceRequest,
} from '@foundry/contracts';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';

import { encodeBody } from '../body';
import { api, createIdempotencyKey, path } from '../client';
import { queryKeys } from '../query-keys';

export type ProgramVenture = z.infer<typeof ProgramVentureListResponse>['items'][number];
export type EscalationQueueEntry = z.infer<typeof EscalationQueueResponse>['items'][number];
export type EscalationAssigneeEntry = z.infer<typeof EscalationAssigneeListResponse>['items'][number];

/** GET /program/portfolio — k-anonymous aggregates (null = suppressed small group). */
export const portfolioQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.program.portfolio(),
    queryFn: ({ signal }) => api.get('/program/portfolio', PortfolioSummary, { signal }),
  });

export function usePortfolio() {
  return useQuery(portfolioQueryOptions());
}

/** GET /program/ventures */
export const programVenturesQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.program.ventures(),
    queryFn: ({ signal }) => api.get('/program/ventures', ProgramVentureListResponse, { signal }),
  });

export function useProgramVentures() {
  return useQuery({ ...programVenturesQueryOptions(), select: (data) => data.items });
}

export type CreateProgramVentureInput = z.input<typeof CreateVentureRequest>;

/** POST /program/ventures — enrol a venture → 201 `ProgramVentureRow`. */
export function useCreateProgramVenture() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProgramVentureInput) =>
      api.post('/program/ventures', CreateProgramVentureResponse, encodeBody(CreateVentureRequest, input), {
        idempotencyKey: createIdempotencyKey(),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.program.all() });
      void client.invalidateQueries({ queryKey: queryKeys.ventures.list() });
    },
  });
}

/** GET /program/resources (program lead / platform admin; filters `kind&stage&tag&q` are not used yet). */
export const resourcesQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.program.resources(),
    queryFn: ({ signal }) => api.get('/program/resources', ResourceListResponse, { signal }),
  });

export function useResources() {
  return useQuery({ ...resourcesQueryOptions(), select: (data) => data.items });
}

export type UpsertResourceInput = z.input<typeof UpsertResourceRequest>;

/** POST /program/resources → 201 `ResourceView`. */
export function useCreateResource() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertResourceInput) =>
      api.post('/program/resources', CreateResourceResponse, encodeBody(UpsertResourceRequest, input), {
        idempotencyKey: createIdempotencyKey(),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.program.resources() }),
  });
}

export type UpdateResourceInput = z.input<typeof UpdateResourceRequest>;

/**
 * PATCH /program/resources/:id → 200 `ResourceView`. Send only the changed fields (no defaults are
 * applied server-side); `status: 'retired'` hides a resource, `'active'` marks it current again.
 */
export function useUpdateResource() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ resourceId, patch }: { resourceId: string; patch: UpdateResourceInput }) =>
      api.patch(
        path`/program/resources/${resourceId}`,
        UpdateResourceResponse,
        encodeBody(UpdateResourceRequest, patch),
        { idempotencyKey: createIdempotencyKey() },
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.program.resources() }),
  });
}

/** GET /program/escalations — metadata-only escalation queue (never the packet). */
export const programEscalationsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.program.escalations(),
    queryFn: ({ signal }) => api.get('/program/escalations', EscalationQueueResponse, { signal }),
  });

export function useProgramEscalations() {
  return useQuery({ ...programEscalationsQueryOptions(), select: (data) => data.items });
}

/**
 * GET /program/assignees — the tenant's active EIRs and program leads, the only people an escalation can
 * be routed to (program lead / platform admin). Pass `enabled: false` for anyone else.
 */
export const escalationAssigneesQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.program.assignees(),
    queryFn: ({ signal }) => api.get('/program/assignees', EscalationAssigneeListResponse, { signal }),
    staleTime: 5 * 60_000,
  });

export function useEscalationAssignees(options: { enabled?: boolean } = {}) {
  return useQuery({
    ...escalationAssigneesQueryOptions(),
    enabled: options.enabled ?? true,
    select: (data) => data.items,
  });
}

export type RouteEscalationInput = z.input<typeof RouteEscalationRequest>;

/** POST /program/escalations/:id/route → 200 `EscalationQueueItem` (assign to a person, optional due date). */
export function useRouteEscalation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ escalationId, route }: { escalationId: string; route: RouteEscalationInput }) =>
      api.post(
        path`/program/escalations/${escalationId}/route`,
        RouteEscalationResponse,
        encodeBody(RouteEscalationRequest, route),
        { idempotencyKey: createIdempotencyKey() },
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.program.escalations() });
      void client.invalidateQueries({ queryKey: queryKeys.inbox.escalations() });
    },
  });
}
