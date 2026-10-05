# Contributing to Foundry Ascent

Thank you for helping. This guide condenses the engineering standards of the
[system design §3](docs/architecture/system-design.md#3-repository-layout-and-engineering-standards); where
they differ, the system design wins. Set up your machine with the
[local development runbook](docs/runbooks/local-development.md).

## Ground rules

1. **Synthetic data only** ([ADR-0006](docs/architecture/adr/0006-synthetic-and-authorized-data-only.md)).
   No real founder, venture, EIR or student information in code, fixtures, issues, screenshots or prompts
   to AI tools.
2. **Never log content.** Logs, errors, metrics and test snapshots carry identifiers, counts and timings —
   never prompts, model output, documents or memory content. Content lives only in the database under RLS.
3. **Isolation is two-layered** ([ADR-0004](docs/architecture/adr/0004-isolation-in-service-and-database.md)).
   Venture-scoped work goes through `authz.requireVentureAccess` and `db.withContext()`; browser-supplied
   ids are never authority. A new `db.system(` call needs a comment explaining why RLS cannot apply.
4. **The AI never decides alone.** Model output passes the deterministic validators; high-risk topics escalate;
   memory written by AI is only ever `proposed`
   ([ADR-0002](docs/architecture/adr/0002-single-orchestrator-deterministic-validators.md),
   [ADR-0003](docs/architecture/adr/0003-typed-memory-with-approval.md),
   [ADR-0008](docs/architecture/adr/0008-high-risk-education-and-escalation.md)).
5. **No secrets in the repository.** Configuration that is not secret (model ids, the owner code _hash_)
   lives in `infra/cdk/config`; secrets live in AWS Secrets Manager or GitHub secrets. gitleaks scans
   every push with a dedicated access-code rule: tests and docs use only the placeholder codes
   `FA-AAAAA-BBBBB-CCCCC-DDDDD`, `FA-ABCDE-FGHJK-MNPQR-STVWX`, `FA-00000-00000-00000-00000`,
   `FA-XXXXX-XXXXX-XXXXX-XXXXX` or `FA-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ`, or generate codes at runtime.

## Code standards

| Area         | Standard                                                                                                                                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Toolchain    | pnpm 10 workspaces, Node 24 (local ≥ 22.12), TypeScript 5.9                                                                                                                                                            |
| TypeScript   | `strict`, `noUncheckedIndexedAccess`, ESM everywhere, `moduleResolution: "Bundler"`; relative imports end in `.js`; internal packages are consumed as source (`"exports": { ".": "./src/index.ts" }`)                  |
| Types        | Shared types come from `@foundry/contracts` (Zod); never redefine them. No `any` in exported APIs. Validate every boundary (HTTP input, env, DB rows, model output) with Zod                                           |
| Zod          | Zod 4 API (`z.uuid()`, `z.email()`, `z.iso.datetime()`, `z.toJSONSchema()`)                                                                                                                                            |
| Errors       | RFC 9457 problem+json with a stable `code` from `ErrorCode` and the `requestId`                                                                                                                                        |
| Writes       | Honour `Idempotency-Key`; side effects must be safe to retry                                                                                                                                                           |
| Logging      | Structured JSON, one line per event, request id on every line, levels via `LOG_LEVEL`                                                                                                                                  |
| Lint/format  | ESLint (typescript-eslint strict type-checked) with `--max-warnings 0`; Prettier (110 columns, single quotes)                                                                                                          |
| Python       | 3.12; `ruff check` (plus `ruff format` in `evals`) and offline `pytest`, with ruff and pytest pinned in each project's `requirements-dev.txt` (the CI toolchain); boto3 calls never print account ids or secret values |
| Web          | WCAG 2.2 AA: keyboard path, visible focus, labels, status never by colour alone, `prefers-reduced-motion`; no inline scripts (strict CSP)                                                                              |
| Dependencies | Prefer what is already installed. A new dependency needs a reason in the PR (size, maintenance, licence, supply-chain risk) and goes into the narrowest package                                                        |

## Tests

- Every behaviour change ships with tests at the lowest useful level: unit (Vitest) for pure logic,
  `*.db.test.ts` against real PostgreSQL 16 + pgvector for SQL, RLS and repositories, Playwright for user
  journeys, CDK assertions for infrastructure.
- Security properties get **negative** tests: the wrong principal, a revoked membership, another venture,
  an expired code.
- Bugs are fixed test-first: a failing test that reproduces the issue, then the fix.
- The mock model provider keeps tests deterministic; never call real models from tests.

## Database migrations

- Add `packages/db/migrations/NNNN_short_name.sql`; never edit a migration that has been applied anywhere
  (checksums are verified on every deploy).
- Regenerate and commit the bundle: `pnpm --filter @foundry/db gen:migrations` (CI fails otherwise).
- Migrations must be **backward compatible with the previous release** (expand → deploy → contract), so a
  code rollback never meets an incompatible schema.
- Every new table: RLS enabled, policies through the `app.*` helpers, explicit grants to `app_rls` (or
  none for credential/ledger tables), and a case in `rls.db.test.ts`.

## Commits and pull requests

- Branch from `main`; keep pull requests focused and reviewable.
- Commit subject in the imperative mood (≤ 72 characters, e.g. "Add memory pin endpoint"); the body explains
  **why**, not what the diff already shows.
- Fill in the [pull request template](.github/pull_request_template.md). CI (`quality`, `database`,
  `infra`, `python`, `e2e`), gitleaks and CodeQL must be green; code owners review.
- A change to a decision recorded in an ADR updates or supersedes that ADR in the same PR. Operational
  changes update the matching [runbook](docs/runbooks/README.md).
- `main` is protected: no direct pushes, no force pushes. Merging to `main` deploys to production.

## CI and supply chain

- Workflow actions are pinned to full commit SHAs with the version in a trailing comment; Dependabot
  proposes updates weekly. Never reference an action by a moving tag.
- Workflows get the least `permissions` they need. AWS credentials reach only `deploy.yml` (stage-0 key
  or, from stage 1, OIDC limited to `main` and the `production` environment) and the manually dispatched
  stage-0 workflows (`platform-*.yml`, `ops-aws-*.yml`), never during dependency installation. Workflows
  that change CloudFormation share one concurrency group (`deploy-production`).
- Installs use `pnpm install --frozen-lockfile`; update `pnpm-lock.yaml` only through `pnpm` commands.

## Reporting security issues

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).
