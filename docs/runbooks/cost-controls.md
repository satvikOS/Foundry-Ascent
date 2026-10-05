# Runbook: cost controls

**Owner:** platform owner · **Related:** [ADR-0015](../architecture/adr/0015-cost-guardrails.md),
[ADR-0011](../architecture/adr/0011-aurora-serverless-postgres-data-api.md),
[ADR-0014](../architecture/adr/0014-bedrock-models-luna-nova-titan.md), [kill switch](kill-switch-and-persona-suspension.md)

Target: **about $1–3 per month idle**, AI spend hard-capped per day. Figures below are us-east-1 list
prices as configured on 2026-10-05; confirm on the AWS pricing pages before relying on them.

## Where the money goes

| Component                     | Idle                                                                                                 | Under use                                                                                                                                                                                            | Control                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Aurora Serverless v2 compute  | $0 while paused (0 ACU)                                                                              | per ACU-hour while awake (0.5–2 ACU); a cluster that never pauses at 0.5 ACU costs tens of dollars a month                                                                                           | auto-pause after 10 idle minutes, max 2 ACU                           |
| Aurora storage, backups       | ~$0.10/GB-month; backups within retention free                                                       | I/O per million requests                                                                                                                                                                             | 7-day retention                                                       |
| Bedrock reasoning             | $0                                                                                                   | Nova 2 Lite (primary, `us.` profile; `global.` fallback): ≈ $0.007 per turn at ~12 k input / 1.5 k output tokens. GPT-6 Luna (≈ $0.002) is gated by AWS and disabled (`models.luna.enabled = false`) | daily caps, turn rate limit, session turn limit                       |
| Bedrock embeddings (Titan v2) | $0                                                                                                   | ~$0.02 per million tokens (a 50-page document ≈ $0.001)                                                                                                                                              | ingestion only, kill switch                                           |
| Lambda (ARM, 1 GB)            | $0                                                                                                   | fractions of a cent per turn                                                                                                                                                                         | no reserved concurrency (see below); ≤ 2 pollers (worker); spend caps |
| Secrets Manager               | $0.40/month (one secret)                                                                             | —                                                                                                                                                                                                    | —                                                                     |
| CloudWatch                    | 5 alarms ≈ $0.50/month; logs per GB ingested                                                         | —                                                                                                                                                                                                    | 30-day log retention, no content in logs                              |
| CloudFront, S3, SQS, SNS      | cents (free tiers)                                                                                   | cents                                                                                                                                                                                                | price class 100, no WAF                                               |
| Not created at all            | NAT gateway, EIP, VPC endpoints, customer KMS keys, RDS Proxy, provisioned concurrency or throughput | —                                                                                                                                                                                                    | denied by `FoundryAscent-Boundary`                                    |

At the default global cap of **$2.00/day**, AI spend is at most ≈ $60/month (about 270 Nova turns a day
today; about 900 if Luna is enabled later). The per-person cap is **$0.50/day**.

## Application caps (Admin → Settings)

| Setting                   | Default | Meaning                                                                                            |
| ------------------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `aiEnabled`               | on      | Global kill switch (no model or embedding calls when off)                                          |
| `dailyUsdCapGlobal`       | 2.00    | Platform-wide AI spend per UTC day; reaching it returns `429 spend_cap_reached` until midnight UTC |
| `dailyUsdCapPerPrincipal` | 0.50    | Per-person AI spend per UTC day                                                                    |
| `maxTurnsPerSession`      | 40      | Hard stop for runaway sessions                                                                     |

Plus fixed limits in core configuration: 20 turns per 10 minutes per person, sign-in lockout. Every
model call writes `usage_ledger` (model, tokens, estimated cost, principal, venture), visible in
**Admin → Usage**. Prices live in `packages/ai/src/pricing.ts`; update them when AWS prices change so caps
stay accurate.

## Infrastructure limits (`infra/cdk/config/production.json`, change by PR + deploy)

`aurora.maxCapacityAcu` (2), `aurora.minCapacityAcu` (0 = can pause), `aurora.autoPauseMinutes` (10),
`api.reservedConcurrency` (`null` = none, the production setting; a reservation fails the deploy on
accounts whose Lambda concurrency quota is only 10), `api.memoryMb` (1024), `api.timeoutSeconds` (60), `logRetentionDays` (30),
`models.luna.enabled` (`false`; see [ADR-0014](../architecture/adr/0014-bedrock-models-luna-nova-titan.md#enabling-luna-later)).

## Alarms and budgets (one-time setup, account administrator)

1. **Subscribe to alarms** — the topic has no subscribers by default:
   `aws sns subscribe --topic-arn <AlarmTopicArn output> --protocol email --notification-endpoint <you>` and
   confirm the email. Alarms: `FoundryAscent-Api-Errors`, `FoundryAscent-Api-Throttles`,
   `FoundryAscent-Worker-Errors`, `FoundryAscent-Jobs-DLQ-NotEmpty`, `FoundryAscent-CloudFront-5xxRate`.
2. **AWS Budgets** (Billing → Budgets), **recommended**: a monthly cost budget of $10 with email alerts at
   50 %, 80 % and 100 % actual and 100 % forecast. Budgets are outside the CDK app (account-level); the
   stage-0 policy allows `budgets:ModifyBudget`, but create it as the account administrator.
3. **Cost Anomaly Detection** (Billing → Cost Anomaly Detection): enable the default service monitor
   with a daily email summary (free).

## Routine checks (weekly, 5 minutes)

- Run the **Ops - AWS inventory (read-only)** workflow: Cost Explorer month-to-date and last month by
  service and region (two calls, $0.01 each), plus billable resources outside Foundry Ascent. It uses the
  stage-0 key; once that is retired, run `python ops/aws/inventory.py` locally with read-only credentials.
- **Admin → Usage**: spend by day and model; look for one principal or venture dominating.
- Aurora is pausing: CloudWatch metric `AWS/RDS ServerlessDatabaseCapacity` for `foundry-ascent` should drop
  to 0 overnight:
  ```bash
  aws cloudwatch get-metric-statistics --namespace AWS/RDS --metric-name ServerlessDatabaseCapacity \
    --dimensions Name=DBClusterIdentifier,Value=foundry-ascent --statistics Maximum --period 3600 \
    --start-time "$(date -u -d '-24 hours' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)"
  ```

## When Aurora does not pause

Any database call wakes the cluster and restarts the 10-minute idle timer: signed-in users, sign-in
attempts (valid or not), worker jobs (document ingestion), the deploy-time migrate resource, the deploy
smoke test's sign-in check, evals runs, and the platform admin's `GET /api/v1/admin/health`. The public
`GET /api/v1/health` does **not**: it never queries the database, so uptime monitors may poll it. If
capacity never reaches 0:

1. Find the caller: API logs (`/aws/lambda/FoundryAscent-Api`, request ids and paths) and the jobs queue
   depth.
2. Bots hammering `POST /api/v1/auth/sign-in`: the per-IP lockout answers without a model call, but each
   attempt still touches the database; treat a sustained stream as an incident
   ([incident response](incident-response.md)).
3. A stuck job retrying: check `FoundryAscent-Jobs-DLQ`; purge or fix the poison message.

## When a cap is hit

Founders see "daily AI budget reached; resumes at midnight UTC". Decide deliberately: raise the cap in
**Admin → Settings** (audited) if the usage is legitimate, or leave it and investigate (abuse, a loop,
a leaked code → [incident response](incident-response.md)).

## Cost of a deploy

A deploy wakes Aurora for the migrations (~10–15 minutes of minimum capacity) and runs a CloudFront
invalidation (first 1,000 paths per month free). Frequent deploys are cheap but not free.
