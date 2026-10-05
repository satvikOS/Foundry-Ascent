import {
  AccessCodeIssued,
  AdminPrincipalListResponse,
  AuditListResponse,
  CreatePrincipalRequest,
  CreatePrincipalResponse,
  IssueAccessCodeRequest,
  PlatformSettingsView,
  RevokeAccessCodeResponse,
  UpdateSettingsRequest,
  UsageSummary,
} from '@foundry/contracts';
import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { z } from 'zod';

import { encodeBody } from '../body';
import { api, apiRequest, createIdempotencyKey, path } from '../client';
import { queryKeys, type AuditFilters } from '../query-keys';

export type AdminPrincipal = z.infer<typeof AdminPrincipalListResponse>['items'][number];
export type AuditEvent = z.infer<typeof AuditListResponse>['items'][number];
export type Usage = z.infer<typeof UsageSummary>;

/** GET /admin/principals */
export const principalsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.admin.principals(),
    queryFn: ({ signal }) => api.get('/admin/principals', AdminPrincipalListResponse, { signal }),
  });

export function usePrincipals() {
  return useQuery({ ...principalsQueryOptions(), select: (data) => data.items });
}

export type CreatePrincipalInput = z.input<typeof CreatePrincipalRequest>;

/** POST /admin/principals → 201 `AdminPrincipalRow` (no access code; issue one separately). */
export function useCreatePrincipal() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePrincipalInput) =>
      api.post('/admin/principals', CreatePrincipalResponse, encodeBody(CreatePrincipalRequest, input), {
        idempotencyKey: createIdempotencyKey(),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.admin.principals() }),
  });
}

export type IssueAccessCodeInput = z.input<typeof IssueAccessCodeRequest>;

/**
 * POST /admin/principals/:id/access-codes → AccessCodeIssued. The plaintext code is shown once:
 * never cache, log or persist it (gcTime 0 drops it from the mutation cache on unmount).
 */
export function useIssueAccessCode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ principalId, input }: { principalId: string; input: IssueAccessCodeInput }) =>
      api.post(
        path`/admin/principals/${principalId}/access-codes`,
        AccessCodeIssued,
        encodeBody(IssueAccessCodeRequest, input),
        {
          idempotencyKey: createIdempotencyKey(),
        },
      ),
    gcTime: 0,
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.admin.principals() }),
  });
}

/** DELETE /admin/access-codes/:id — revoke → 200 `{ accessCodeId, revokedAt }`. */
export function useRevokeAccessCode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (accessCodeId: string) =>
      apiRequest(path`/admin/access-codes/${accessCodeId}`, {
        method: 'DELETE',
        schema: RevokeAccessCodeResponse,
        idempotencyKey: createIdempotencyKey(),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.admin.principals() }),
  });
}

/** GET /admin/settings */
export const platformSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.admin.settings(),
    queryFn: ({ signal }) => api.get('/admin/settings', PlatformSettingsView, { signal }),
  });

export function usePlatformSettings() {
  return useQuery(platformSettingsQueryOptions());
}

export type UpdateSettingsInput = z.input<typeof UpdateSettingsRequest>;

/** PATCH /admin/settings (kill switch, spend caps, thresholds). */
export function useUpdatePlatformSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSettingsInput) =>
      api.patch('/admin/settings', PlatformSettingsView, encodeBody(UpdateSettingsRequest, input), {
        idempotencyKey: createIdempotencyKey(),
      }),
    onSuccess: (settings) => {
      client.setQueryData(queryKeys.admin.settings(), settings);
      // `aiEnabled` is surfaced on /me for every principal.
      void client.invalidateQueries({ queryKey: queryKeys.me() });
    },
  });
}

/** GET /admin/audit?action&outcome&cursor&limit — cursor-paginated, newest first. */
export const auditQueryOptions = (filters: AuditFilters = {}) =>
  infiniteQueryOptions({
    queryKey: queryKeys.admin.audit(filters),
    queryFn: ({ signal, pageParam }) =>
      api.get('/admin/audit', AuditListResponse, {
        signal,
        query: {
          action: filters.action,
          outcome: filters.outcome,
          limit: filters.limit ?? 50,
          cursor: pageParam,
        },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

export function useAuditLog(filters: AuditFilters = {}) {
  return useInfiniteQuery(auditQueryOptions(filters));
}

/** GET /admin/usage */
export const usageQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.admin.usage(),
    queryFn: ({ signal }) => api.get('/admin/usage', UsageSummary, { signal }),
  });

export function useUsage() {
  return useQuery(usageQueryOptions());
}
