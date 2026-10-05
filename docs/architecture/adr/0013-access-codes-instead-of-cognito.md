# ADR-0013: Access codes instead of Cognito or SSO for V1

- **Status:** Accepted (deviation: identity provider deferred)
- **Date:** 2026-10-05
- **Deciders:** Platform owner
- **Blueprint basis:** 03 §8 "Identity" (approved authentication, short-lived tokens, MFA where available,
  no shared accounts), §14 "Denial / cost abuse"; 01 §10 decision 3 (approved identity provider)

## Context and problem statement

Blueprint 03 §8 expects University-approved authentication (e.g. UR SSO) with short-lived tokens. That
integration needs an institutional approval V1 does not have, and the V1 population is a handful of
invited people using synthetic data (ADR-0006). Amazon Cognito would add a hosted UI, email/SMS delivery,
user-pool configuration and cost for a cohort that is invited one by one.

## Decision drivers

- Invite-only access issued by an admin or program lead; instant revocation.
- No passwords to reset, no email/SMS infrastructure, nothing to phish beyond the code itself.
- Brute-force resistance and constant-time verification.
- Replaceable: SSO later must not touch authorization code.

## Considered options

1. **Per-person random access codes, hashed with scrypt, exchanged for a short-lived session cookie**
   (chosen).
2. Amazon Cognito user pool (email + password, optional MFA).
3. Magic links by email.

## Decision outcome

Chosen option: **1**.

- Codes `FA-AAAAA-BBBBB-CCCCC-DDDDD`: 100 random bits in Crockford base32, issued to one principal, shown
  once, optional expiry, revocable, `last_used_at` tracked. The first group is a public lookup prefix; the
  database stores only `scrypt$N=32768,r=8,p=1$salt$key` (64 MiB `maxmem`), compared with `timingSafeEqual`.
- `POST /api/v1/auth/sign-in` answers every invalid code with the same `invalid_access_code` problem after
  one scrypt evaluation; failures are counted per hashed viewer IP and globally (10 per 15 min per IP →
  15 min lockout).
- Success creates an `auth_sessions` row and sets `fa_session` (HS256 JWT, 12 h,
  `HttpOnly; Secure; SameSite=Strict; Path=/api`), revocable with a 60 s cache. CSRF: SameSite=Strict plus
  a mandatory `X-Requested-With: foundry-ascent` header on non-GET requests.
- The owner's code prefix and hash are deployment configuration (`infra/cdk/config/production.json`,
  public by design: a 100-bit code cannot be brute-forced through scrypt); the plaintext is generated on
  a trusted machine, kept in the owner's password manager and never committed. The only sanctioned copy
  elsewhere is the encrypted Actions secret `FA_OWNER_ACCESS_CODE` that the manual evals workflow uses.
- Authentication is confined to `packages/core/src/auth` (credential → session). Everything downstream
  consumes only the resolved `RequestContext`, so an OIDC identity provider (system design §4.1) replaces
  sign-in without touching authorization or RLS.

### Consequences

- Good: no identity vendor, no PII required (email is optional), immediate revocation.
- Bad: a code is a bearer secret with no second factor; leakage = account access until revoked. Mitigated
  by short sessions, expiry, revocation, lockout, audit and synthetic-only data.
- Bad: no self-service recovery; a lost code means issuing a new one.

### Confirmation

- `packages/core/src/auth/*.test.ts` and `auth.db.test.ts` (verification, lockout, revocation, session
  expiry); the post-deploy smoke test checks the invalid-code rejection path.
- Runbook: [access codes](../../runbooks/access-codes.md).

## Revisit trigger

- Any real (non-synthetic) data, more than one cohort, or University approval of an SSO integration:
  add the `oidc` identity provider (UR SSO or Cognito federation) and keep codes only for break-glass.
