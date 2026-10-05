import { type HealthResponse, SESSION_COOKIE } from '@foundry/contracts';
import { type Core, DomainError, isDomainError } from '@foundry/core';
import { type Db, DatabaseResumingError } from '@foundry/db';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';

import { errorFields, type Logger } from '../logging.js';
import { jsonBody } from '../http/input.js';
import { clearedSessionCookie, sessionCookie, viewerIp } from '../http/request-meta.js';
import { type RouteBuilder } from '../http/router.js';
import { type DbStateSource } from '../runtime/db-observer.js';

type Health = z.infer<typeof HealthResponse>;

export interface SystemRouteDeps {
  readonly core: Core;
  readonly db: Pick<Db, 'ping'>;
  /** What this instance's own recent database calls saw (the public health route never queries). */
  readonly dbState?: DbStateSource | undefined;
  readonly logger: Logger;
  /** `x-forwarded-for` is only trusted for the viewer IP in development (see `viewerIp`). */
  readonly appEnv: 'production' | 'development' | 'test';
  readonly appVersion: string;
  /** Upper bound on the admin health probe (a paused Aurora answers `resuming` immediately). */
  readonly healthTimeoutMs: number;
  readonly now: () => Date;
}

/**
 * Sign-in accepts any string up to a sane length: core normalises the code and answers every invalid one
 * (including malformed ones) with the same `invalid_access_code` after one scrypt evaluation, and counts
 * it towards the lockout. Validating the format here would create a cheaper, uncounted oracle.
 */
const SignInBody = z.object({ accessCode: z.string().max(100) });

async function probeDatabase(deps: SystemRouteDeps, requestId: string): Promise<NonNullable<Health['db']>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<NonNullable<Health['db']>>((resolve) => {
    timer = setTimeout(() => {
      resolve('unavailable');
    }, deps.healthTimeoutMs);
  });
  const probe = deps.db.ping({ maxWaitMs: 0 }).then(
    (): NonNullable<Health['db']> => 'awake',
    (err: unknown): NonNullable<Health['db']> => {
      if (err instanceof DatabaseResumingError) return 'resuming';
      deps.logger.warn('health.db_unavailable', { requestId, ...errorFields(err) });
      return 'unavailable';
    },
  );
  try {
    return await Promise.race([probe, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function registerSystemRoutes(r: RouteBuilder, deps: SystemRouteDeps): void {
  const { core } = deps;

  // Public liveness: version (the deployed commit) and the database state this instance last *observed*.
  // It never queries the database, so bots and uptime checks polling it cannot keep Aurora awake (min 0
  // ACU auto-pause); `db` is omitted when there is no recent observation.
  r.public('GET', '/health', (c) => {
    const observed = deps.dbState?.observed() ?? null;
    const body: Health = {
      status: observed === 'resuming' ? 'degraded' : 'ok',
      version: deps.appVersion,
      ...(observed === null ? {} : { db: observed }),
      time: deps.now().toISOString(),
    };
    return Promise.resolve(c.json(body, 200));
  });

  // Deep health (platform admin): one database round trip without waiting for a resume. On a paused
  // cluster that single call reports `resuming` and starts the resume, which is fine for an operator.
  r.get('/admin/health', async (c, ctx) => {
    if (!ctx.roles.includes('platform_admin')) {
      throw new DomainError('forbidden', 'This health check is for platform administrators.', {
        reason: 'role:platform_admin',
      });
    }
    const db = await probeDatabase(deps, c.get('requestId'));
    const body: Health = {
      status: db === 'awake' ? 'ok' : 'degraded',
      version: deps.appVersion,
      db,
      time: deps.now().toISOString(),
    };
    return c.json(body, db === 'unavailable' ? 503 : 200);
  });

  r.public('POST', '/auth/sign-in', async (c) => {
    const { accessCode } = jsonBody(c, SignInBody);
    const requestId = c.get('requestId');
    const ip = viewerIp(c.req.raw.headers, { trustForwardedFor: deps.appEnv === 'development' });
    if (ip === null && deps.appEnv === 'production') {
      // Behind CloudFront the viewer-request function always sets it: a missing value is a deployment bug.
      deps.logger.warn('auth.viewer_ip_missing', { requestId });
    }
    const result = await core.auth.signIn({
      accessCode,
      viewerIp: ip,
      userAgent: c.req.header('user-agent')?.slice(0, 512) ?? null,
      requestId,
    });
    const session = await core.auth.verifySession(result.token, { requestId });
    c.set('session', session);
    const me = await core.me.get(session);
    c.header('set-cookie', sessionCookie(result.token, result.maxAgeSeconds, deps.now()), { append: true });
    return c.json(me, 200);
  });

  // Always succeeds for the browser: a valid session is revoked, and the cookie is cleared either way.
  r.public('POST', '/auth/sign-out', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token !== undefined && token !== '') {
      try {
        const session = await core.auth.verifySession(token, { requestId: c.get('requestId') });
        c.set('session', session);
        await core.auth.signOut(session);
      } catch (err) {
        if (!(isDomainError(err) && err.code === 'unauthenticated')) throw err;
      }
    }
    c.header('set-cookie', clearedSessionCookie(), { append: true });
    return c.body(null, 204);
  });

  r.get('/me', async (c, ctx) => c.json(await core.me.get(ctx)));
}
