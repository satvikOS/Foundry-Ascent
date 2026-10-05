import { SignInRequest } from '@foundry/contracts';
import { auditRepo, authRepo, principalsRepo, type SystemExecutor } from '@foundry/db';

import { createRequestContext, type RequestContext } from '../context.js';
import { DomainError } from '../errors.js';
import { type Kit } from '../internal/kit.js';
import { accessCodePrefix, timingDummyHash, verifyAccessCode } from './access-code.js';
import { PlatformKeyCache, hashViewerAttribute } from './keys.js';
import { SessionCache } from './session-cache.js';
import { viewerNetwork } from './viewer-network.js';
import { signSessionToken, verifySessionToken } from './session-token.js';

/** A verified session: the request context plus the session handle (for sign-out). */
export interface SessionContext extends RequestContext {
  readonly sessionId: string;
  /** ISO-8601 session expiry. */
  readonly sessionExpiresAt: string;
}

export interface SignInInput {
  /** As typed by the user; normalised (trim, uppercase) and validated here. */
  readonly accessCode: string;
  /** Viewer IP (CloudFront-Viewer-Address / x-forwarded-for first hop). Hashed, never stored raw. */
  readonly viewerIp: string | null;
  readonly userAgent?: string | null;
  readonly requestId: string;
}

export interface SignInResult {
  /** JWT for the `fa_session` cookie (HttpOnly; Secure; SameSite=Strict; Path=/api). */
  readonly token: string;
  readonly sessionId: string;
  readonly principalId: string;
  readonly tenantId: string;
  readonly expiresAt: string;
  /** Cookie Max-Age. */
  readonly maxAgeSeconds: number;
}

/** Uniform failure for every invalid code (no oracle for prefix existence, revocation or expiry). */
const INVALID_CODE = (): DomainError =>
  new DomainError('invalid_access_code', 'That access code is not valid.', { reason: 'invalid_access_code' });
const UNAUTHENTICATED = (reason: string): DomainError =>
  new DomainError('unauthenticated', 'Please sign in again.', { reason });

/** Placeholder verified against the dummy hash when the input is malformed. */
const MALFORMED_PLACEHOLDER = 'FA-00000-00000-00000-00000';
const GLOBAL_SUBJECT = 'global';

export interface AuthService {
  /**
   * Access-code sign-in (system executor): per-IP sliding-window lockout (10 failures / 15 min),
   * global soft limit, constant-cost verification (one scrypt per attempt), auth session row, HS256 JWT
   * (12 h, claims sub/sid/tid/iat/exp). Throws `locked_out`, `rate_limited` or `invalid_access_code`.
   */
  signIn(input: SignInInput): Promise<SignInResult>;
  /**
   * Verifies the session JWT and its revocation state (cached ≤ 60 s per container) and returns the
   * request context with the principal's active roles. Throws `unauthenticated`.
   */
  verifySession(token: string, options: { readonly requestId: string }): Promise<SessionContext>;
  /** Revokes the caller's auth session (effective immediately in this container). */
  signOut(ctx: SessionContext): Promise<void>;
  /** Drops cached sessions of a principal (after code revocation, role or status changes). */
  invalidatePrincipal(principalId: string): void;
}

export function createAuthService(kit: Kit): AuthService {
  const cfg = kit.config;
  const keys = new PlatformKeyCache(kit, Math.max(cfg.session.keyGraceSeconds, cfg.session.ttlSeconds));
  const cache = new SessionCache(cfg.session.revocationCacheSeconds * 1000, cfg.session.cacheMaxEntries);

  async function systemAudit(sx: SystemExecutor, event: auditRepo.AuditEventInput): Promise<void> {
    await auditRepo.appendAudit(sx, event);
  }

  async function signIn(input: SignInInput): Promise<SignInResult> {
    const now = kit.now();
    const parsed = SignInRequest.safeParse({ accessCode: input.accessCode });
    const code = parsed.success ? parsed.data.accessCode : null;
    const salt = await keys.ipSalt();
    // IPv6 viewers are counted per /64 (one client controls the whole prefix); IPv4 per address.
    const subject = hashViewerAttribute(salt, 'ip', viewerNetwork(input.viewerIp));
    const windowSeconds = cfg.signIn.ipWindowSeconds;

    // 1. Brute-force protection (before any credential work). `reserveAuthAttempt` serialises attempts
    //    per viewer and records this one as failed up front, so concurrent attempts cannot all slip under
    //    the threshold: at most `ipFailureLimit` per window reach verification. Success flips it below.
    const { reservation, globalWindow } = await kit.system(async (sx) => ({
      reservation: await authRepo.reserveAuthAttempt(sx, {
        subjectHash: subject,
        windowSeconds,
        failureLimit: cfg.signIn.ipFailureLimit,
      }),
      globalWindow: await authRepo.authFailureWindow(sx, { subjectHash: GLOBAL_SUBJECT, windowSeconds }),
    }));
    const denied = async (
      policyReason: string,
      metadata: Record<string, number>,
      attemptToDrop: number | null,
    ): Promise<void> => {
      await kit.system(
        async (sx) => {
          // A refused attempt is not counted, so retrying during a lockout does not extend it.
          if (attemptToDrop !== null) await authRepo.deleteAuthAttempt(sx, attemptToDrop);
          await systemAudit(sx, {
            action: 'auth.sign_in',
            outcome: 'denied',
            policyReason,
            requestId: input.requestId,
            metadata,
          });
        },
        { transaction: false },
      );
    };
    if (reservation.attemptId === null) {
      const last = reservation.lastFailureAt ? Date.parse(reservation.lastFailureAt) : now.getTime();
      const retryAfterSeconds = Math.max(1, Math.ceil((last + windowSeconds * 1000 - now.getTime()) / 1000));
      await denied('locked_out', { failures: reservation.failures }, null);
      throw new DomainError('locked_out', 'Too many failed attempts. Please try again later.', {
        retryAfterSeconds,
        reason: 'locked_out',
      });
    }
    const attemptId = reservation.attemptId;
    if (globalWindow.failures >= cfg.signIn.globalSoftLimit && reservation.failures > 0) {
      await denied('global_soft_limit', { globalFailures: globalWindow.failures }, attemptId);
      throw new DomainError('rate_limited', 'Sign-in is temporarily limited. Please try again shortly.', {
        retryAfterSeconds: cfg.signIn.globalRetryAfterSeconds,
        reason: 'global_soft_limit',
      });
    }

    // 2. Constant-cost verification: exactly one scrypt evaluation whatever the input.
    const lookup =
      code === null
        ? null
        : await kit.system((sx) => authRepo.findAccessCodeByPrefix(sx, accessCodePrefix(code)), {
            transaction: false,
          });
    const secretMatches = await verifyAccessCode(
      code ?? MALFORMED_PLACEHOLDER,
      lookup?.codeHash ?? (await timingDummyHash()),
    );
    let reason: string | null = null;
    if (code === null) reason = 'malformed';
    else if (lookup === null) reason = 'unknown_code';
    else if (!secretMatches) reason = 'secret_mismatch';
    else if (lookup.revokedAt !== null) reason = 'code_revoked';
    else if (lookup.expiresAt !== null && Date.parse(lookup.expiresAt) <= now.getTime())
      reason = 'code_expired';
    else if (lookup.principalStatus !== 'active') reason = 'principal_disabled';
    else if (lookup.tenantStatus !== 'active') reason = 'tenant_inactive';

    if (reason !== null || lookup === null) {
      const known = lookup !== null && secretMatches;
      await kit.system(
        async (sx) => {
          // The viewer's failure is the attempt recorded in step 1.
          await authRepo.recordAuthAttempt(sx, { subjectHash: GLOBAL_SUBJECT, succeeded: false });
          await systemAudit(sx, {
            action: 'auth.sign_in',
            outcome: 'denied',
            policyReason: reason ?? 'unknown_code',
            requestId: input.requestId,
            // Only attribute the attempt when the secret matched (the holder is known).
            tenantId: known ? lookup.tenantId : null,
            actorId: known ? lookup.principalId : null,
            objectType: known ? 'access_code' : null,
            objectId: known ? lookup.id : null,
          });
        },
        { transaction: false },
      );
      throw INVALID_CODE();
    }

    // 3. Success: session row + JWT.
    const sessionId = kit.deps.ids.uuid();
    const expiresAt = new Date(now.getTime() + cfg.session.ttlSeconds * 1000);
    await kit.system(async (sx) => {
      await authRepo.markAuthAttemptSucceeded(sx, attemptId);
      await authRepo.markAccessCodeUsed(sx, lookup.id);
      await authRepo.createAuthSession(sx, {
        id: sessionId,
        principalId: lookup.principalId,
        accessCodeId: lookup.id,
        expiresAt,
        userAgentHash: input.userAgent ? hashViewerAttribute(salt, 'ua', input.userAgent) : null,
      });
      await systemAudit(sx, {
        action: 'auth.sign_in',
        outcome: 'succeeded',
        requestId: input.requestId,
        tenantId: lookup.tenantId,
        actorId: lookup.principalId,
        objectType: 'auth_session',
        objectId: sessionId,
        metadata: { accessCodeId: lookup.id },
      });
    });
    if (kit.deps.random() < 0.01) {
      // Occasional housekeeping: attempts older than a day are never read again.
      await kit
        .system((sx) => authRepo.pruneAuthAttempts(sx, 86_400), { transaction: false })
        .catch(() => undefined);
    }
    const key = await keys.signingKey();
    const { token } = await signSessionToken(
      key,
      { sub: lookup.principalId, sid: sessionId, tid: lookup.tenantId },
      { now, ttlSeconds: cfg.session.ttlSeconds },
    );
    return {
      token,
      sessionId,
      principalId: lookup.principalId,
      tenantId: lookup.tenantId,
      expiresAt: expiresAt.toISOString(),
      maxAgeSeconds: cfg.session.ttlSeconds,
    };
  }

  async function verifySession(
    token: string,
    options: { readonly requestId: string },
  ): Promise<SessionContext> {
    const now = kit.now();
    const claims = await verifySessionToken(token, await keys.verificationKeys(), { now });
    if (claims === null) throw UNAUTHENTICATED('invalid_token');
    let entry = cache.get(claims.sid, now.getTime());
    if (entry === null) {
      const loaded = await kit.system(
        async (sx) => {
          const session = await authRepo.getAuthSession(sx, claims.sid);
          if (session === null) return null;
          const roles = await principalsRepo.listActiveRoles(sx, {
            principalId: session.principalId,
            tenantId: session.tenantId,
          });
          return { session, roles };
        },
        { transaction: false },
      );
      if (loaded === null) throw UNAUTHENTICATED('unknown_session');
      const { session, roles } = loaded;
      const expiresAtMs = Date.parse(session.expiresAt);
      entry = {
        sessionId: session.id,
        principalId: session.principalId,
        tenantId: session.tenantId,
        roles,
        valid:
          session.revokedAt === null &&
          session.accessCodeRevokedAt === null &&
          session.principalStatus === 'active' &&
          expiresAtMs > now.getTime(),
        expiresAtMs,
        checkedAtMs: now.getTime(),
      };
      cache.set(entry);
    }
    if (!entry.valid) throw UNAUTHENTICATED('session_revoked');
    if (entry.principalId !== claims.sub || entry.tenantId !== claims.tid)
      throw UNAUTHENTICATED('claims_mismatch');
    if (entry.expiresAtMs <= now.getTime()) throw UNAUTHENTICATED('session_expired');
    const ctx = createRequestContext({
      principalId: entry.principalId,
      tenantId: entry.tenantId,
      roles: entry.roles,
      requestId: options.requestId,
    });
    return {
      ...ctx,
      sessionId: entry.sessionId,
      sessionExpiresAt: new Date(entry.expiresAtMs).toISOString(),
    };
  }

  async function signOut(ctx: SessionContext): Promise<void> {
    await kit.system(async (sx) => {
      await authRepo.revokeAuthSession(sx, ctx.sessionId);
      await systemAudit(sx, {
        action: 'auth.sign_out',
        outcome: 'succeeded',
        requestId: ctx.requestId,
        tenantId: ctx.tenantId,
        actorId: ctx.principalId,
        objectType: 'auth_session',
        objectId: ctx.sessionId,
      });
    });
    cache.invalidate(ctx.sessionId);
  }

  return {
    signIn,
    verifySession,
    signOut,
    invalidatePrincipal: (principalId) => {
      cache.invalidatePrincipal(principalId);
    },
  };
}
