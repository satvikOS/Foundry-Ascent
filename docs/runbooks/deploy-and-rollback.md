# Runbook: deploy and rollback

**Owner:** platform owner · **Workflows:** `.github/workflows/ci.yml`, `.github/workflows/deploy.yml` ·
**Related:** [ADR-0016](../architecture/adr/0016-staged-iam-github-oidc.md) (credentials),
[infra/cdk/README.md](../../infra/cdk/README.md) (stacks), [kill switch](kill-switch-and-persona-suspension.md)

## How a release flows

```
push to main ──► CI (quality · database · infra · python · e2e) ──success──► Deploy
                                                                               ├─ gate: commit on main and still the tip?
                                                                               └─ deploy (environment "production")
                                                                                   build SPA → AWS credentials → verify CDKToolkit
                                                                                   → resolve GitHub OIDC provider → cdk deploy --all
                                                                                   → smoke test → job summary
```

- `cdk deploy --all` updates `FoundryAscent-Foundation` (OIDC provider, deploy role), `FoundryAscent-Data`
  (Aurora, buckets, queue; termination protected) and `FoundryAscent-App`. In the App stack the migrate
  custom resource runs first on every deploy (`version = <commit SHA>`): migrations → idempotent synthetic
  seed → embedding backfill. Functions and the SPA update only after it succeeds; a failure rolls the App
  stack back before new code serves traffic.
- Typical duration: 5–10 minutes; the first deploy ~30 minutes (Aurora ~15, CloudFront ~10).
- Automatic deploys ship only the tip of main. If CI runs of two pushes finish out of order, the older one
  is skipped with a notice (the newer commit's CI run deploys it).
- Deploy, **Platform - deploy data stack** and **Ops - retire stage-0 AWS access** share the concurrency
  group `deploy-production`: a run waits while another CloudFormation deployment is in progress (GitHub
  keeps one waiting run per group; a newer one replaces it).
- **GitHub OIDC provider.** The Foundation stack creates the provider for
  `token.actions.githubusercontent.com` unless it is given an existing one to import (context
  `githubOidcProviderArn`); an account holds one provider per URL. Before `cdk deploy`, the step
  _Resolve GitHub OIDC provider_ lists the providers and checks whether `FoundryAscent-Foundation` itself
  contains an `AWS::IAM::OIDCProvider`. It passes the context only when a provider exists **and** the
  stack does not manage it. First deploy: created (or imported if one already exists). Re-deploys: a
  managed provider stays managed, an imported one stays imported, so CloudFormation never deletes a
  provider it manages. Under stage 1 the deploy role may not list providers; the step then uses the
  provider's fixed ARN (it must exist, since the role was just assumed through it). The job summary shows
  which case applied.
- `scripts/smoke.mjs` then checks the live site: security headers on `/`, an immutable asset,
  `/api/v1/health` **reporting the deployed commit** (the public health route never queries the
  database), a signed `POST /api/v1/auth/sign-in` with an invalid code → `401 invalid_access_code` (the
  first request that reaches Aurora: it waits through a resume from auto-pause, honouring
  `503 database_resuming` + `Retry-After`, for up to 120 s), the SPA deep link `/<tenant>/app/ventures`,
  and that API errors stay problem+json. Results are in the job summary.

## Where production stands (2026-10-05)

Stage 0 (access key). Done: stage-0 policies attached, permissions boundary published, `CDKToolkit`
bootstrapped, and **`FoundryAscent-Data` deployed first, on its own**, with **Platform - deploy data
stack** (Aurora takes longest to create). Not yet: Foundation and App. The first full **Deploy** creates
them and updates Data in place; before it, review the Data diff (below) so the cluster, secret and
buckets are updated, never replaced.

```bash
pnpm --filter @foundry/web build
pnpm --filter @foundry/infra exec cdk diff FoundryAscent-Data -c appVersion=$(git rev-parse HEAD)
```

## One-time setup

1. **Bootstrap** (account administrator in AWS CloudShell): `infra/iam/apply-bootstrap-access.sh`
   (boundary and stage-0 policy), then `infra/iam/cdk-bootstrap.sh` (`CDKToolkit`); then run
   **Ops - verify AWS access** (`infra/iam/README.md`). (Done; re-run the script whenever a policy file
   changes, because the CI user has no IAM write permission.)
2. **GitHub settings** (Settings → Environments → `production`): deployment branches = `main` only
   (**required**: the deploy role trusts only jobs in this environment, so this rule is what keeps other
   branches out); add required reviewers if deploys should wait for a human approval.
3. **Credentials:** stage 0 = repository secrets `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. Stage 1 =
   repository secret `AWS_DEPLOY_ROLE_ARN` (see [Switch to OIDC](#switch-to-github-oidc-stage-1)).
4. **Branch protection on main:** require the CI jobs (`quality`, `database`, `infra`, `python`, `e2e`),
   `Secret scan (gitleaks)` and CodeQL; require review from code owners; no force pushes.
5. **Lambda concurrency:** production reserves none (`api.reservedConcurrency: null`), because a
   reservation fails the deploy (`PutFunctionConcurrency`) on accounts whose regional quota is only 10.
   To reserve later, check Service Quotas → AWS Lambda → _Concurrent executions_ (it must leave 10
   unreserved), then set the number in `infra/cdk/config/production.json` in a PR.
6. **Data stack first** (optional, already done here): **Platform - deploy data stack** deploys only
   `FoundryAscent-Data` with the stage-0 key, so Aurora exists before the first full release.
7. **Cost alerts:** subscribe to the `FoundryAscent-Alarms` topic and create the AWS Budget
   ([cost controls](cost-controls.md#alarms-and-budgets-one-time-setup-account-administrator)).
8. **Evals:** create the environment `evals` with the environment secret `FA_OWNER_ACCESS_CODE`, and
   add the repository variable `FA_SITE_URL` ([evals](evals.md)).

## Routine operations

| Task                       | How                                                                                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deploy                     | Merge to `main`. Watch Actions → **Deploy**; the environment link and job summary show the URL.                                                                         |
| Redeploy current main      | Actions → **Deploy** → _Run workflow_ (branch `main`, `sha` empty).                                                                                                     |
| Preview changes            | `pnpm --filter @foundry/infra exec cdk diff --all -c appVersion=$(git rev-parse HEAD)` with read credentials.                                                           |
| Re-run the smoke test only | `node scripts/smoke.mjs https://<distribution>.cloudfront.net` (any machine with Node ≥ 22).                                                                            |
| Find the site URL          | Deploy job summary, or `aws cloudformation describe-stacks --stack-name FoundryAscent-App --query "Stacks[0].Outputs[?OutputKey=='SiteUrl'].OutputValue" --output text` |

## Switch to GitHub OIDC (stage 1)

1. After the first successful deploy, read the Foundation output:
   `aws cloudformation describe-stacks --stack-name FoundryAscent-Foundation --query "Stacks[0].Outputs[?OutputKey=='GitHubDeployRoleArn'].OutputValue" --output text`
2. Settings → Secrets and variables → Actions → **Secrets** → `AWS_DEPLOY_ROLE_ARN` = that ARN (a secret keeps the account id masked in the public logs; a variable also works).
3. Run **Deploy** manually. The summary must show _AWS access: GitHub OIDC (stage 1)_ and _GitHub OIDC
   provider: managed by FoundryAscent-Foundation (kept)_ (or _existing provider imported_ if the account
   already had one before the first deploy).
4. Retire stage 0 with **Ops - retire stage-0 AWS access**: `mode = plan`, then `mode = retire` with
   `confirm = RETIRE-STAGE-0` (refused while `AWS_DEPLOY_ROLE_ARN` is unset). It detaches both stage-0
   policies and deletes every access key of `Foundry-Ascent`, its own last (`infra/iam/README.md`). Then
   delete the two secrets. Rotate nothing else: no other static credential exists.

## When a deploy fails

| Symptom                                                          | Meaning and action                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CDK bootstrap missing` / `CDKToolkit is …`                      | The account owner runs `infra/iam/cdk-bootstrap.sh` in CloudShell, then re-run the deploy.                                                                                                                                                                      |
| `No AWS credentials`                                             | Set the variable (stage 1) or the two secrets (stage 0).                                                                                                                                                                                                        |
| `cdk deploy` fails, stack `UPDATE_ROLLBACK_COMPLETE`             | CloudFormation restored the previous version; production is unchanged. Read the first `*_FAILED` event: `aws cloudformation describe-stack-events --stack-name FoundryAscent-App --max-items 40`. Fix forward in a PR.                                          |
| Migrate custom resource failed                                   | Check log group `/aws/lambda/FoundryAscent-Migrate` (identifiers and error codes only). Never edit an applied migration (checksums are verified); add a new migration.                                                                                          |
| `UPDATE_ROLLBACK_FAILED`                                         | `pnpm --filter @foundry/infra exec cdk rollback FoundryAscent-App` (or console → _Continue update rollback_). Skip resources only when you understand why they failed.                                                                                          |
| First Data deploy `ROLLBACK_FAILED`                              | Deletion protection kept the new cluster: disable deletion protection on `foundry-ascent`, continue the rollback, re-run.                                                                                                                                       |
| Smoke: health not ready / version mismatch                       | `/api/v1/health` never answered 200 with the deployed commit: check the App stack status and the `FoundryAscent-Api` function (version = `APP_VERSION`).                                                                                                        |
| Smoke: sign-in never `401` (503/504 until timeout)               | Aurora did not resume within 120 s, or the Data API fails. Re-run the job once; then check RDS events and `/aws/rds/cluster/foundry-ascent/postgresql`.                                                                                                         |
| `OIDC provider lookup failed` / `Foundation stack lookup failed` | The step could not tell whether to create, keep or import the provider, so it stopped before any change. Stage 0: the user needs `iam:ListOpenIDConnectProviders` and `cloudformation:DescribeStackResources` (bootstrap-operator policy). Re-run after fixing. |
| Smoke: headers / deep link / problem+json                        | CloudFront config regression: the new version is live. Roll back (below) or fix forward.                                                                                                                                                                        |

## Rollback

Prefer **fix forward or `git revert`** on main (the normal pipeline keeps history and production
identical). When production must change faster than CI can run:

1. Find the last good commit: Settings → Environments → `production` (deployment history), or
   `git log --first-parent --format='%H %s' origin/main`.
2. Actions → **Deploy** → _Run workflow_ on `main` with `sha` = that full commit SHA. The workflow verifies the
   commit is on main, deploys its infrastructure, functions and SPA, and the smoke test checks that
   `/api/v1/health` reports that version.
3. Revert the bad change on main in a PR, or the next automatic deploy reintroduces it.

**Database:** migrations are forward-only and run before code goes live. A rollback deploy runs the
older migration bundle; newer applied migrations are left in place and logged as
`schema.unknown_migrations`. This is safe only because every migration must be **backward compatible
with the previous release** (expand → deploy → contract; never drop or rename in the same release that
stops using a column). If data itself is damaged:

1. Stop writes: [global kill switch](kill-switch-and-persona-suspension.md) or API concurrency 0.
2. Restore a point in time (7-day retention) to a **new** cluster (account administrator, CloudShell):

   ```bash
   NEW=foundry-ascent-restore-$(date -u +%Y%m%d)
   aws rds restore-db-cluster-to-point-in-time --source-db-cluster-identifier foundry-ascent \
     --db-cluster-identifier "$NEW" --restore-to-time 2026-10-05T12:00:00Z \
     --serverless-v2-scaling-configuration MinCapacity=0,MaxCapacity=2
   aws rds create-db-instance --db-instance-identifier "$NEW-writer" --db-cluster-identifier "$NEW" \
     --db-instance-class db.serverless --engine aurora-postgresql
   aws rds enable-http-endpoint --resource-arn "$(aws rds describe-db-clusters \
     --db-cluster-identifier "$NEW" --query 'DBClusters[0].DBClusterArn' --output text)"
   ```

3. Compare or copy the affected rows with the Data API, or plan a controlled cut-over in a PR (the cluster
   identifier is part of the Data stack). Rehearse this before any real data is stored (ADR-0006).

## Before every release (reviewer checklist)

- CI green on the exact commit; `cdk diff` reviewed for IAM, data-retention and replacement changes.
- No resource replacement of the Aurora cluster, secret or buckets (replacement = data loss risk).
- Migrations backward compatible; seed changes idempotent (`ON CONFLICT DO NOTHING`).
- New settings or limits documented in [cost controls](cost-controls.md) when they affect spend.
