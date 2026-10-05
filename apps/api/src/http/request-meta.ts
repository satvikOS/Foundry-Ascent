import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

import { SESSION_COOKIE } from '@foundry/contracts';

import { VIEWER_IP_HEADER } from '../lambda-contract.js';

export { VIEWER_IP_HEADER };

/** Accepted client-supplied request ids: 8–128 visible, log-safe characters. */
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

/** The caller's `x-request-id` when well-formed (the web client sends a UUID), otherwise a new UUID. */
export function resolveRequestId(header: string | undefined): string {
  const value = header?.trim();
  return value !== undefined && REQUEST_ID_RE.test(value) ? value : randomUUID();
}

/**
 * Parses `ip`, `ip:port`, `[v6]` or `[v6]:port` (a bare address is preferred: `2001:db8::1:443` is
 * itself a valid IPv6 literal). Anything else is null.
 */
function parseAddress(address: string): string | null {
  const value = address.trim();
  if (value === '' || value.length > 64) return null;
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(value);
  if (bracketed?.[1] !== undefined) return isIP(bracketed[1]) === 6 ? bracketed[1] : null;
  if (isIP(value) !== 0) return value;
  const colon = value.lastIndexOf(':');
  const withoutPort = colon > 0 && /^\d{1,5}$/.test(value.slice(colon + 1)) ? value.slice(0, colon) : null;
  return withoutPort !== null && isIP(withoutPort) === 4 ? withoutPort : null;
}

export interface ViewerIpOptions {
  /**
   * Accept the first `x-forwarded-for` hop when the trusted header is absent. Only for local development
   * (the Vite proxy / dev server): behind CloudFront that value is whatever the client sent.
   */
  readonly trustForwardedFor: boolean;
}

/**
 * Viewer IP for brute-force protection (hashed by core, never stored raw).
 *
 * The only trusted source is {@link VIEWER_IP_HEADER} (`x-fa-viewer-ip`): the /api/* CloudFront
 * viewer-request function sets it from `event.viewer.ip` on every request, overwriting any value the
 * client sent, and the Function URL accepts only SigV4-signed requests from that distribution (OAC), so it
 * cannot be forged. `x-forwarded-for` (first hop, client-controlled) is used only when
 * `trustForwardedFor` is set (development). Otherwise null: core then counts the attempt under one shared
 * "unknown viewer" bucket, which fails closed (it can lock out, never bypass).
 */
export function viewerIp(headers: Headers, options: ViewerIpOptions): string | null {
  const trusted = headers.get(VIEWER_IP_HEADER);
  if (trusted !== null) return parseAddress(trusted);
  if (!options.trustForwardedFor) return null;
  const first = headers.get('x-forwarded-for')?.split(',')[0];
  return first === undefined ? null : parseAddress(first);
}

/** Cookie scope: only API requests carry the session (system design §4.1). */
export const SESSION_COOKIE_PATH = '/api';

/**
 * `fa_session=<jwt>; Max-Age=<s>; Expires=<date>; Path=/api; HttpOnly; Secure; SameSite=Strict`.
 * Secure is always set: browsers treat http://localhost as a secure context, so local development works.
 */
export function sessionCookie(token: string, maxAgeSeconds: number, now: Date = new Date()): string {
  if (!/^[A-Za-z0-9._-]+$/.test(token)) throw new TypeError('session token has unexpected characters');
  const maxAge = Math.max(0, Math.floor(maxAgeSeconds));
  const expires = new Date(now.getTime() + maxAge * 1000).toUTCString();
  return `${SESSION_COOKIE}=${token}; Max-Age=${maxAge}; Expires=${expires}; Path=${SESSION_COOKIE_PATH}; HttpOnly; Secure; SameSite=Strict`;
}

/** Expires the session cookie immediately (sign-out, rejected sessions). */
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=${SESSION_COOKIE_PATH}; HttpOnly; Secure; SameSite=Strict`;
}
