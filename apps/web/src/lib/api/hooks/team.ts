import { AccessCodeIssued, InviteMemberRequest, TeamResponse } from '@foundry/contracts';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';

import { encodeBody } from '../body';
import { api, createIdempotencyKey, path } from '../client';
import { queryKeys } from '../query-keys';

export type TeamMember = z.infer<typeof TeamResponse>['items'][number];
export type IssuedAccessCode = z.infer<typeof AccessCodeIssued>;

/** GET /ventures/:id/team */
export const teamQueryOptions = (ventureId: string) =>
  queryOptions({
    queryKey: queryKeys.venture.team(ventureId),
    queryFn: ({ signal }) => api.get(path`/ventures/${ventureId}/team`, TeamResponse, { signal }),
  });

export function useTeam(ventureId: string) {
  return useQuery({ ...teamQueryOptions(ventureId), select: (data) => data.items });
}

export type InviteMemberInput = z.input<typeof InviteMemberRequest>;

/**
 * POST /ventures/:id/team/invitations (program lead / admin). The plaintext access code in the
 * result is shown exactly once — never cache, log or persist it. It is deliberately not written
 * to the query cache.
 */
export function useInviteMember(ventureId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: InviteMemberInput) =>
      api.post(
        path`/ventures/${ventureId}/team/invitations`,
        AccessCodeIssued,
        encodeBody(InviteMemberRequest, input),
        {
          idempotencyKey: createIdempotencyKey(),
        },
      ),
    // Don't keep the one-time code in the mutation cache after the component unmounts.
    gcTime: 0,
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.venture.team(ventureId) }),
  });
}
