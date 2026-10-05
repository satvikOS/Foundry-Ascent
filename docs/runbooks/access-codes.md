# Runbook: access codes

**Who:** platform admins (anyone in the tenant), program leads (people without admin or program-lead
roles) · **Related:** [ADR-0013](../architecture/adr/0013-access-codes-instead-of-cognito.md),
[incident response](incident-response.md)

Access codes are the V1 credential: `FA-AAAAA-BBBBB-CCCCC-DDDDD` (100 random bits, Crockford base32;
the sign-in form reads a typed `O` as `0` and `I`/`L` as `1`). The first group is a public lookup prefix; the database stores only a
scrypt hash. A code is **shown once**, belongs to exactly one person, can expire, and can be revoked at
any time. Signing in sets a 12-hour session cookie.

## Handling rules

- Deliver codes over a channel that reaches only the recipient (in person, the University's messaging
  system, a password manager share). Never by group chat, shared documents, tickets or screenshots.
- One code per person; never share codes between people or reuse a revoked one.
- Default expiry is 30 days; use shorter for demos and guests. Codes without expiry only for the owner.
- Do not paste codes into issues, commits, logs, test fixtures or AI tools. gitleaks scans every push
  with a rule for access codes; fixtures use only the documented placeholders (for example
  `FA-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ`, see `.gitleaks.toml`), never a real code or a production prefix.

## Issue a code

1. **Admin → Principals** (platform admin) or the venture **Team** page (program lead invitation).
2. Create the principal if needed (display name, title, roles or venture membership). Email is optional.
3. **Issue access code**: label (e.g. "Fall cohort laptop"), expiry in days (1–365).
4. Copy the code from the one-time dialog and deliver it. Closing the dialog discards it for good.

API: `POST /api/v1/admin/principals/<principalId>/access-codes` with `{"label": "…", "expiresInDays": 30}`
(admin), or `POST /api/v1/ventures/<ventureId>/team/invitations` (program lead). Non-GET calls need
`x-requested-with: foundry-ascent` and `x-amz-content-sha256` (see the kill-switch runbook for a curl example).

## Revoke a code

1. **Admin → Principals** → person → active codes → **Revoke**.
   API: `DELETE /api/v1/admin/access-codes/<accessCodeId>`.
2. Effect: the code stops working at once, and every session signed in with it is revoked (within the
   60-second session cache).
3. Revoking a person's role or venture membership is separate: do both when someone leaves.
4. Audit events: `access_code.issued`, `access_code.revoked`, `auth.sign_in` successes and failures
   (hashed IP, never the code).

Lost code: revoke it and issue a new one; there is no recovery.

## Lockouts

Ten failed sign-ins from one network address within 15 minutes lock that address out for 15 minutes
(`429 locked_out`); a platform-wide failure spike rate-limits addresses that already failed. Every invalid
code gets the same answer and timing. A locked-out user waits 15 minutes; repeated lockouts from one
place are a brute-force signal (incident response, SEV-2).

## Rotate the owner code

The owner's code is deployment configuration: only its prefix and scrypt hash are in
`infra/cdk/config/production.json` (`owner.accessCodePrefix`, `owner.accessCodeHash`). Both are public by
design; the plaintext code is never in git. Every deploy's seed
binds that hash to the owner principal (`platform_admin` + `program_lead`) and revokes the previous deploy
code when the prefix changes. Rotate when the code may have been exposed, when someone else had access to
it, and at least every 90 days.

1. Generate a new code on a trusted machine, from a clone of the repository with dependencies installed:

   ```bash
   pnpm --filter @foundry/db owner-code
   ```

   It prints the plaintext code **once**, under a warning, followed by the two public values to paste
   into `infra/cdk/config/production.json` (`"accessCodePrefix"` and `"accessCodeHash"`). It checks the
   hash against the code before printing, writes nothing to disk, and refuses to run in CI (`CI` or
   `GITHUB_ACTIONS` set), so a code can never end up in a workflow log.

2. Store the **code** in your password manager immediately; clear the terminal scrollback.
3. Open a PR that changes only `owner.accessCodePrefix` and `owner.accessCodeHash` (the hash is not a
   secret: 100-bit codes cannot be brute-forced through scrypt). Merge → the normal deploy applies it.
4. Sign in with the new code; check **Admin → Principals** shows the old deploy code revoked.
5. If the repository secret `FA_OWNER_ACCESS_CODE` exists (evals), replace its value with the new code
   (Settings → Secrets and variables → Actions → Secrets → `FA_OWNER_ACCESS_CODE` → Update).

If you are locked out (old code revoked, new one not yet deployed), the same PR is the recovery path.
Never put the plaintext code in a repository **variable**, a workflow input, an issue, or a log. The one
sanctioned exception is the encrypted Actions **secret** `FA_OWNER_ACCESS_CODE`, read only by the manual
evals workflow (GitHub masks it in logs; workflows from forks never receive it); see [evals](evals.md).
Delete that secret when no evaluation is planned, and rotate the owner code if it may have leaked.

## Periodic review (monthly)

**Admin → Principals**: revoke codes unused for 30 days (`last used`), people who left, expired guests;
confirm only the owner holds `platform_admin`.
