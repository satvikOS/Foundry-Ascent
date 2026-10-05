## What and why

<!-- What changes, and the problem it solves. Link the issue, ADR or spec section (docs/architecture/system-design.md §). -->

## How it was verified

<!-- Commands run and their results; screenshots or recordings for UI changes (light and dark, narrow width). -->

- [ ] `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`
- [ ] `pnpm test:db` (schema, RLS, repositories or anything that queries the database)
- [ ] `pnpm --filter @foundry/infra test` and a reviewed `cdk diff` (infrastructure)
- [ ] Playwright / keyboard / screen-reader pass (user-facing flows)
- [ ] `ruff check` and `python -m pytest` in `ops/aws` / `evals` with their `requirements-dev.txt` (Python changes)

## Checklist

- [ ] Types come from `@foundry/contracts`; inputs are validated with Zod at the boundary
- [ ] Migrations are additive and backward compatible with the previous release, and
      `packages/db/src/migrations/bundle.generated.ts` is regenerated (`pnpm --filter @foundry/db gen:migrations`)
- [ ] Venture-scoped access goes through `authz` **and** RLS (`db.withContext`); any new `db.system(` use is justified
- [ ] No raw prompts, model output, documents or memory content in logs, errors, analytics or test snapshots
- [ ] No secrets, account ids or real personal data; fixtures and seeds are synthetic (ADR-0006)
- [ ] AI behaviour changes keep the disclosure, evidence labels, validators and high-risk escalation intact
- [ ] New cost exposure (models, AWS resources, concurrency) stays within the guardrails (ADR-0015)
- [ ] Docs updated where behaviour changed (README, ADR for a decision change, runbook for an operational change)

## Risk and rollback

<!-- Blast radius, feature flags or settings involved, and how to back out (docs/runbooks/deploy-and-rollback.md). -->
