import type { Me } from '@foundry/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';

import { meQueryOptions } from '@/lib/api/hooks/auth';

export interface RouterContext {
  queryClient: QueryClient;
}

/** Thrown from beforeLoad when the person is signed in but lacks the role for an area. */
export class ForbiddenError extends Error {
  override readonly name = 'ForbiddenError';
  constructor(readonly area: string) {
    super(`You don't have access to ${area}.`);
  }
}

export function isForbiddenError(error: unknown): error is ForbiddenError {
  return error instanceof ForbiddenError;
}

/**
 * Only same-origin, absolute-path redirects are honoured after sign-in (no open redirects:
 * rejects `//evil.com`, `/\evil.com`, schemes and anything outside the app).
 */
export function safeRedirectPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return undefined;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return undefined;
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) < 0x20 || value.charCodeAt(i) === 0x7f) return undefined;
  }
  if (value.startsWith('/sign-in')) return undefined;
  return value;
}

/** Home path for a principal. */
export function homePath(me: Me): string {
  return `/${encodeURIComponent(me.tenant.slug)}/app`;
}

/**
 * beforeLoad guard: resolves the current principal (from cache or GET /me) or redirects to /sign-in
 * with a `redirect` back to the requested URL.
 */
export async function requireMe(context: RouterContext, location: { href: string }): Promise<Me> {
  const me = await context.queryClient.query({ ...meQueryOptions(), staleTime: 'static' });
  if (!me) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirects are thrown
    throw redirect({ to: '/sign-in', search: { redirect: safeRedirectPath(location.href) } });
  }
  return me;
}
