import { Me, SignInRequest, SignInResponse } from '@foundry/contracts';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';

import { sessionHint } from '@/lib/storage';

import { encodeBody } from '../body';
import { api, apiSend } from '../client';
import { isApiError } from '../errors';
import { queryKeys } from '../query-keys';

/**
 * GET /me. Resolves to `null` when signed out (401), so guards and components can branch without
 * treating "not signed in" as an error.
 */
export const meQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.me(),
    queryFn: async ({ signal }): Promise<Me | null> => {
      try {
        const me = await api.get('/me', Me, { signal });
        sessionHint.set(true);
        return me;
      } catch (error) {
        if (isApiError(error) && error.status === 401) {
          sessionHint.set(false);
          return null;
        }
        throw error;
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  });

/** Current principal (or null when signed out). */
export function useMe() {
  return useQuery(meQueryOptions());
}

export type SignInInput = z.input<typeof SignInRequest>;

/**
 * POST /auth/sign-in → 200 `Me` (the same shape as `GET /me`) and the HttpOnly `fa_session` cookie. The
 * returned principal seeds the `/me` cache, so no second round trip is needed.
 */
export function useSignIn() {
  const client = useQueryClient();
  return useMutation({
    mutationKey: ['auth', 'sign-in'],
    mutationFn: async (input: SignInInput): Promise<Me> => {
      const body = encodeBody(SignInRequest, input);
      const me = await api.post('/auth/sign-in', SignInResponse, body);
      // Start from a clean cache: nothing from a previous principal may survive a sign-in.
      await client.cancelQueries();
      client.removeQueries();
      client.setQueryData(queryKeys.me(), me);
      sessionHint.set(true);
      return me;
    },
  });
}

interface SignOutOptions {
  /**
   * Runs after the server revoked the session but before the cache is cleared — navigate away here
   * so mounted screens unmount instead of refetching (and failing) with a dead session.
   */
  beforeClear?: () => Promise<unknown> | undefined;
}

/** POST /auth/sign-out → clears every cached object for this principal. */
export function useSignOut({ beforeClear }: SignOutOptions = {}) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: ['auth', 'sign-out'],
    mutationFn: () => apiSend('/auth/sign-out', { method: 'POST' }),
    onSuccess: async () => {
      sessionHint.set(false);
      await client.cancelQueries();
      await beforeClear?.();
      client.removeQueries();
      client.setQueryData(queryKeys.me(), null);
    },
  });
}
