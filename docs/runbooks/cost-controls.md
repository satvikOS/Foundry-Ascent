# Runbook: cost controls

**Owner:** platform owner · **Related:** [ADR-0015](../architecture/adr/0015-cost-guardrails.md),
[ADR-0011](../architecture/adr/0011-aurora-serverless-postgres-data-api.md),
[ADR-0014](../architecture/adr/0014-bedrock-models-luna-nova-titan.md),
[ADR-0010](../architecture/adr/0010-realtime-webrtc-deferred.md) (calls),
[ADR-0018](../architecture/adr/0018-veir-knowledge-pools.md) (distillation), [kill switch](kill-switch-and-persona-suspension.md)

Target: **about $1–3 per month idle**, AI spend hard-capped per day. Figures are us-east-1 list prices
(AWS price list of 2026-09-11 for Polly and Transcribe); confirm on the AWS pricing pages before relying
on them.

## Where the money goes

| Component                     | Idle                                                                                                 | Under use                                                                                                                                                                                            | Control                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Aurora Serverless v2 compute  | $0 while paused (0 ACU)                                                                              | about $0.12 per ACU-hour while awake (0.5–2 ACU); a cluster that never pauses costs about $44 a month at 0.5 ACU                                                                                     | auto-pause after 10 idle minutes, max 2 ACU                                                             |
| Aurora storage, backups       | ~$0.10/GB-month; backups within retention free                                                       | I/O per million requests                                                                                                                                                                             | 7-day retention                                                                                         |
| Bedrock reasoning             | $0                                                                                                   | Nova 2 Lite (primary, `us.` profile; `global.` fallback): ≈ $0.007 per turn at ~12 k input / 1.5 k output tokens. GPT-6 Luna (≈ $0.002) is gated by AWS and disabled (`models.luna.enabled = false`) | daily caps, turn rate limit, session turn limit                                                         |
| Bedrock embeddings (Titan v2) | $0                                                                                                   | ~$0.02 per million tokens (a 50-page document ≈ $0.001)                                                                                                                                              | ingestion only, kill switch                                                                             |
| Distillation (worker)         | $0: jobs exist only after someone talked                                                             | one `distill` model call per conversation version (digest, notebook, memory and lesson candidates)                                                                                                   | daily caps, kill switch                                                                                 |
| Amazon Polly (call speech)    | $0                                                                                                   | per character synthesized: neural $16, generative $30 per million (a 70-word spoken reply ≈ 420 characters ≈ $0.007 neural)                                                                          | global cap (metered as `speech`), minute caps, kill switches, two alarms                                |
| Amazon Transcribe (call STT)  | $0                                                                                                   | billed per second while the browser's stream is open (silence included); the app meters the reported microphone time at $0.024 a minute                                                              | global cap (as reported), minute caps, AWS's stream quota, the AWS Budget, `speech.enabled` (see below) |
| Lambda (ARM, 1 GB)            | $0                                                                                                   | fractions of a cent per turn                                                                                                                                                                         | no reserved concurrency (see below); ≤ 2 pollers (worker); spend caps                                   |
| Secrets Manager               | $0.40/month (one secret)                                                                             | —                                                                                                                                                                                                    | —                                                                                                       |
| CloudWatch                    | 7 alarms ≈ $0.70/month; logs per GB ingested                                                         | —                                                                                                                                                                                                    | 30-day log retention, no content in logs                                                                |
| CloudFront, S3, SQS, SNS      | cents (free tiers)                                                                                   | cents                                                                                                                                                                                                | price class 100, no WAF                                                                                 |
| Not created at all            | NAT gateway, EIP, VPC endpoints, customer KMS keys, RDS Proxy, provisioned concurrency or throughput | —                                                                                                                                                                                                    | denied by `FoundryAscent-Boundary`                                                                      |

At the default global cap of **$15.00/day**, AI spend (models, embeddings, distillation and speech) is at
most ≈ $450/month, about 2,100 Nova turns a day. The per-person cap is **$1.00/day** and counts a person's
models, embeddings and distillation, **not call speech**: Polly and Transcribe (usage purpose `speech`) are
bounded by the call-minute caps (30 per call, 60 per person per day) and the global cap, so a call never ends
early on a founder's chat budget; the model spend of a call's spoken turns still counts toward it. A
streamed turn makes two model calls (the answer, then its annotations), about twice the input tokens of a
whole reply (≈ $0.006 instead of ≈ $0.004 on Nova 2 Lite). A full 30-minute call meters about $0.72 of
Transcribe at the app's $0.024 a minute (AWS's price list of 2026-09-11 gives $0.01; the app's figure errs
high), plus its speech and turns.

**Transcribe is metered as the client reports it.** The API grants speech-to-text only to a live call
that passes every heartbeat check (at most 20 grants per call and 100 per person per day), and each grant
(valid 30 s) only opens a socket. Each heartbeat adds the microphone seconds the client reports (never more
than wall time plus a few seconds) to `usage_ledger` as `speech`, which the global cap and Admin → Usage see. Once open, the
browser streams straight to AWS: the minute caps, `callsEnabled` and the kill switch end the call in the
app, and a well-behaved client closes its socket, but nothing on the server can, and streams a modified
client opens beyond what it reports are not metered. AWS publishes no per-stream duration metric to alarm
on. What bounds those:

- AWS's quota of 25 concurrent streams per account in us-east-1: at most about $360 a day;
- the AWS Budget and Cost Anomaly Detection ([owner actions](owner-actions.md) §2), which see Transcribe
  by service;
- `speech.enabled: false` (a deploy), which removes the grant so no new socket opens.

## Application caps (Admin → Settings)

| Setting                            | Default          | Meaning                                                                                                                                 |
| ---------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `aiEnabled`                        | on               | Global kill switch (no model, embedding, speech or call activity when off)                                                              |
| `dailyUsdCapGlobal`                | 15.00            | Platform-wide AI spend per UTC day; reaching it returns `429 spend_cap_reached` until midnight UTC                                      |
| `dailyUsdCapPerPrincipal`          | 1.00             | Per-person AI spend per UTC day (models, embeddings, distillation; call speech is bounded by the minute caps instead)                   |
| `maxTurnsPerSession`               | 40               | Hard stop for runaway conversations                                                                                                     |
| `maxCallMinutes`                   | 30               | Longest call                                                                                                                            |
| `dailyCallMinutesPerPrincipal`     | 60               | Call minutes one person may use per UTC day                                                                                             |
| `callsEnabled`                     | on               | Voice calls (off: new calls refused, live calls end at the next heartbeat)                                                              |
| `streamingEnabled`                 | on               | Streamed replies (off: whole replies only)                                                                                              |
| `dailyUploadDocumentsPerPrincipal` | 20               | Documents one person may start uploading per UTC day; beyond it the upload is refused with `429` and `Retry-After` (until midnight UTC) |
| `dailyUploadBytesPerPrincipal`     | 52428800 (50 MB) | Upload volume one person may start per UTC day (same refusal)                                                                           |

Plus fixed limits in core configuration: 20 turns per 10 minutes per person, a separate rate limit and a
per-call turn cap for spoken turns, one live call per person, at most 3 answers in flight per person,
sign-in lockout. Every model and speech call writes `usage_ledger` (purpose, model or voice, tokens or
characters, estimated cost, principal, venture), visible in **Admin → Usage**. Prices live in
`packages/ai/src/pricing.ts` (models) and `packages/core/speech-voices.json` (speech, which also prices the
speech alarms); update them when AWS prices change so the caps stay accurate.

**Document ingestion counts against the caps.** Embedding an uploaded document is attributed to the person
who uploaded it (`documents.uploaded_by`), and the worker checks the global cap and that person's cap
before every embedding call. A document that would exceed a cap is marked **failed** with the reason
`spend_cap_reached`; nothing is embedded past the cap. The admission check and the turn insert run under
one per-person lock in one transaction, so parallel requests cannot overshoot the turn rate limit.

**Sign-in lockout and Aurora.** After the database has locked a network out (repeated invalid codes), each
API container remembers the lockout in memory and answers `429` with `Retry-After` without touching the
database or the audit log until it ends; only the first refusal per window is audited. A single anonymous
sign-in attempt from a network that is not locked out still reaches the database (checking a code needs
it), so it can resume a paused Aurora cluster.

## Infrastructure limits (`infra/cdk/config/production.json`, change by PR + deploy)

| Key                                  | Production | Effect                                                                                         |
| ------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------- |
| `aurora.maxCapacityAcu`              | 2          | ceiling under load                                                                             |
| `aurora.minCapacityAcu`              | 0          | 0 = can pause                                                                                  |
| `aurora.autoPauseMinutes`            | 10         | idle time before pausing                                                                       |
| `api.reservedConcurrency`            | `null`     | none; a reservation fails the deploy on accounts whose Lambda concurrency quota is only 10     |
| `api.memoryMb`, `api.timeoutSeconds` | 1024, 60   |                                                                                                |
| `logRetentionDays`                   | 30         |                                                                                                |
| `models.luna.enabled`                | `false`    | see [ADR-0014](../architecture/adr/0014-bedrock-models-luna-nova-titan.md#enabling-luna-later) |
| `speech.enabled`                     | `true`     | `false` removes the API's Polly and Transcribe permissions and both speech alarms              |
| `speech.engine`                      | `neural`   | `generative` costs almost twice as much per character and carries a residual risk (ADR-0010)   |
| `speech.dailyAlarmUsd`               | 15         | the daily speech alarm's threshold: keep it equal to `dailyUsdCapGlobal`                       |
| `distillation.sweepEnabled`          | `false`    | keep off: a 15-minute sweep that queries Aurora stops it from pausing (ADR-0018)               |

## Alarms

All alarms publish to the SNS topic `FoundryAscent-Alarms`, which has no subscriber until the owner adds
one ([owner actions](owner-actions.md)): `FoundryAscent-Api-Errors`, `FoundryAscent-Api-Throttles`,
`FoundryAscent-Worker-Errors`, `FoundryAscent-Jobs-DLQ-NotEmpty`, `FoundryAscent-CloudFront-5xxRate`, and
two speech backstops:

- `FoundryAscent-Speech-Characters`: more than 100,000 characters synthesized by Polly in one hour (about
  $1.60 neural): a burst several full calls wide.
- `FoundryAscent-Speech-Characters-Daily`: more than the global daily cap's worth of characters in one day
  (937,500 neural characters at $15): a steady leak below the burst threshold.

Either one means the in-app metering did not hold, or the cap was raised without updating
`speech.dailyAlarmUsd`. Check **Admin → Usage** (purpose `speech`) and the API logs; switch calls off
(`callsEnabled`) or use the kill switch if in doubt.

## Routine checks (weekly, 5 minutes)

- Cost Explorer month-to-date and last month by service (or `python ops/aws/inventory.py` locally with
  read-only credentials; its CI workflow used the deleted stage-0 key).
- **Admin → Usage**: spend by day, model and purpose; look for one principal or venture dominating.
- Aurora is pausing: CloudWatch metric `AWS/RDS ServerlessDatabaseCapacity` for `foundry-ascent` should drop
  to 0 overnight:
  ```bash
  aws cloudwatch get-metric-statistics --namespace AWS/RDS --metric-name ServerlessDatabaseCapacity \
    --dimensions Name=DBClusterIdentifier,Value=foundry-ascent --statistics Maximum --period 3600 \
    --start-time "$(date -u -d '-24 hours' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)"
  ```

## When Aurora does not pause

Any database call wakes the cluster and restarts the 10-minute idle timer: signed-in users, sign-in
attempts (valid or not), worker jobs (document ingestion, distillation, daily maintenance), the
deploy-time migrate resource, the deploy smoke test's sign-in check, evals runs, and the platform admin's
`GET /api/v1/admin/health`. The public `GET /api/v1/health` does **not**: it never queries the database, so
uptime monitors may poll it. Distillation jobs follow conversations (a delayed job after each turn, one at
the end), so they only run while people talk. If capacity never reaches 0:

1. Find the caller: API logs (`/aws/lambda/FoundryAscent-Api`, request ids and paths), worker logs
   (`/aws/lambda/FoundryAscent-Worker`, job types) and the jobs queue depth. Check that the
   `DistillSweep` schedule is still `DISABLED` (EventBridge Scheduler console).
2. Bots hammering `POST /api/v1/auth/sign-in`: the per-IP lockout answers without a model call, but each
   attempt still touches the database; treat a sustained stream as an incident
   ([incident response](incident-response.md)).
3. A stuck job retrying: check `FoundryAscent-Jobs-DLQ`; purge or fix the poison message.

## When a cap is hit

Founders see "Today’s AI usage limit has been reached. Coaching resumes tomorrow." (`429
spend_cap_reached`, worded in `apps/web/src/lib/api/errors.ts`). Decide deliberately: raise the cap in
**Admin → Settings** (audited) if the usage is legitimate, and then `speech.dailyAlarmUsd` to match, or
leave it and investigate (abuse, a loop, a leaked code → [incident response](incident-response.md)).

## Cost of a deploy

A deploy wakes Aurora for the migrations (~10–15 minutes of minimum capacity) and runs a CloudFront
invalidation (first 1,000 paths per month free). Frequent deploys are cheap but not free.
