# Runbook: local development

Run the whole product on one machine with synthetic data and the deterministic mock model: no AWS
account, no cost. **Related:** [CONTRIBUTING.md](../../CONTRIBUTING.md), [system design](../architecture/system-design.md).

## Prerequisites

| Tool         | Version                                | Notes                                                                 |
| ------------ | -------------------------------------- | --------------------------------------------------------------------- |
| Node.js      | ≥ 22.12 (24 recommended, see `.nvmrc`) | Lambdas run Node 24                                                   |
| pnpm         | 10.28.0                                | `corepack enable` picks the version from `package.json`               |
| PostgreSQL   | 16 with pgvector ≥ 0.6                 | local cluster or Docker image `pgvector/pgvector:pg16`                |
| Python       | 3.12                                   | only for `evals/` and `ops/aws/`                                      |
| AWS CLI, CDK | optional                               | only to synth/diff/deploy (`pnpm --filter @foundry/infra exec cdk …`) |

## 1. Start PostgreSQL

The tooling connects as a superuser only to create databases and the `vector`/`pgcrypto` extensions;
migrations and the app run as the non-superuser role `fa_master`, like Aurora's master user.

**Option A — local cluster (the default the scripts expect: unix socket `/var/tmp`, port 54329):**

```bash
sudo -u postgres /usr/lib/postgresql/16/bin/initdb -D /var/tmp/fa-pg --auth=trust   # once
sudo -u postgres /usr/lib/postgresql/16/bin/pg_ctl -D /var/tmp/fa-pg -o "-p 54329 -k /var/tmp" -l /var/tmp/fa-pg.log start
```

**Option B — Docker:**

```bash
docker run -d --name fa-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 pgvector/pgvector:pg16
export TEST_DATABASE_ADMIN_URL=postgresql://postgres:postgres@localhost:5432/postgres
```

## 2. Install, seed, run

```bash
pnpm install
pnpm db:reset        # recreates database "foundry", migrates, seeds synthetic data
pnpm dev             # API http://localhost:8787/api/v1 (mock model) + web http://localhost:5173
```

`pnpm db:reset` prints `DATABASE_URL` and a **DEV owner access code** (shown once; run it again for a new
one). With option B, export the printed `DATABASE_URL` before `pnpm dev`. Open
<http://localhost:5173/sign-in> and sign in with the code: you are platform admin and program lead of the
`ain` tenant with four synthetic ventures. Vite proxies `/api` to the API, so cookies and CSRF headers
behave as in production.

| Variable                  | Default (local)                                                               | Purpose                                                            |
| ------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `DATABASE_URL`            | `postgresql://fa_master:fa_master@localhost/foundry?host=/var/tmp&port=54329` | API database (`DB_DRIVER=pg`)                                      |
| `MODEL_PROVIDER`          | `mock`                                                                        | `bedrock` to call real models (needs AWS credentials, costs money) |
| `PORT`                    | `8787`                                                                        | API dev server port                                                |
| `LOCAL_UPLOAD_DIR`        | `apps/api/.local/uploads`                                                     | uploaded documents (the dev server signs local upload URLs)        |
| `TEST_DATABASE_ADMIN_URL` | `postgresql://postgres@localhost/postgres?host=/var/tmp&port=54329`           | superuser URL for `db:reset` and DB tests                          |
| `LOCAL_DB_NAME`           | `foundry`                                                                     | database name used by `db:reset`                                   |

Background jobs (document ingestion, recaps) run in-process right after they are queued. Documents are
stored on disk; nothing leaves the machine with the mock model.

**Real models locally (optional):** `MODEL_PROVIDER=bedrock BEDROCK_REGION=us-east-1
MODEL_PRIMARY_ID=us.amazon.nova-2-lite-v1:0 MODEL_FALLBACK_ID=global.amazon.nova-2-lite-v1:0
MODEL_EMBEDDINGS_ID=amazon.titan-embed-text-v2:0` with credentials allowed to invoke them. Synthetic data
only (ADR-0006); the daily spend caps still apply.

## 3. Test

```bash
pnpm lint && pnpm format:check && pnpm typecheck
pnpm test                                    # unit tests, every package (no database)
pnpm test:db                                 # *.db.test.ts against PostgreSQL (fresh database per file)
pnpm --filter @foundry/web build             # also regenerates src/routeTree.gen.ts (commit it)
pnpm --filter @foundry/web exec playwright install chromium   # once
pnpm --filter @foundry/web e2e               # founder journey (apps/web/playwright.config.ts runs the stack)
pnpm --filter @foundry/infra test            # CDK synth + cdk-nag + snapshots (no AWS credentials)
pnpm --filter @foundry/api check:bundles     # bundles the Lambda handlers like CDK and import-checks them
```

Python tooling (the CI `python` job runs exactly this; each project's `requirements-dev.txt` pins ruff,
pytest and the runtime dependencies, and is the single source of truth for the toolchain):

```bash
python3.12 -m venv .venv && . .venv/bin/activate
(cd ops/aws && pip install -r requirements-dev.txt && ruff check . && python -m pytest -q)
(cd evals && pip install -r requirements-dev.txt && ruff check . && ruff format --check . && python -m pytest -q)
```

Both test suites are offline (no AWS, no network). Both projects pin the same ruff and pytest versions;
bump them together.

## 4. Everyday tasks

| Task                                 | Command                                                                                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Changed a migration file             | add a new `packages/db/migrations/NNNN_name.sql` (never edit an applied one), then `pnpm --filter @foundry/db gen:migrations` and commit the bundle |
| Fresh data                           | `pnpm db:reset` (drops and recreates the local database only; refuses non-local URLs)                                                               |
| Format                               | `pnpm format`                                                                                                                                       |
| Accept reviewed CDK snapshot changes | `pnpm --filter @foundry/infra test -- -u`                                                                                                           |
| Synth without built assets           | `pnpm --filter @foundry/infra synth:stub`                                                                                                           |

## Troubleshooting

| Problem                                    | Fix                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| `extension "vector" is not available`      | install pgvector for PostgreSQL 16 (`postgresql-16-pgvector`) or use the Docker image |
| `connect ENOENT /var/tmp/.s.PGSQL.54329`   | the local cluster is not running: start it with `pg_ctl` (step 1)                     |
| `reset-local only targets a local cluster` | `TEST_DATABASE_ADMIN_URL` points at a remote host; reset is local-only by design      |
| Port 5173 / 8787 in use                    | stop the other process, or `PORT=8788` for the API (then adjust the Vite proxy)       |
| Sign-in says the code is invalid           | codes from an earlier `db:reset` stop working after the next reset; run it again      |
| Locked out after failed attempts           | wait 15 minutes, or `pnpm db:reset`                                                   |
| Typecheck errors in `routeTree.gen.ts`     | run `pnpm --filter @foundry/web build` (or `dev`) to regenerate it                    |
