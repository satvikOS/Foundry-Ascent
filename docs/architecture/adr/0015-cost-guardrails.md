# ADR-0015: Cost guardrails — boundary, spend caps, capacity ceilings, alarms and a budget

- **Status:** Accepted
- **Date:** 2026-10-05
- **Deciders:** Platform owner
- **Blueprint basis:** 03 §12 "Cost visibility", §14 "Denial / cost abuse" (quotas, rate limits, session
  caps, circuit breakers); 02 §10 "Capacity and economics"; 05 §20 "Business and service economics"

## Context and problem statement

V1 runs in a personal AWS account. Its failure modes are financial as much as technical: a runaway loop
of model calls, a leaked access code used by a bot, a misconfigured stack creating a NAT gateway or a
provisioned database, or a compromised pipeline launching instances. The target is an idle bill of about
$1–3/month and a hard ceiling on AI spend per day, enforced without human attention.

## Decision drivers

- Guardrails must hold even if application code or the CI pipeline is wrong or compromised.
- AI spend is the only cost that scales with usage; it must be capped in the request path.
- Prefer limits that fail closed with a clear message over silent degradation.

## Considered options

1. **Layered guardrails: IAM permissions boundary, in-database daily spend caps and rate limits,
   capacity ceilings, CloudWatch alarms, and an account-level AWS Budget** (chosen).
2. AWS Budgets alerts only.
3. Bedrock provisioned throughput or a fixed-price plan.

## Decision outcome

Chosen option: **1**.

| Layer      | Guardrail                                                                                                                                                                                                                                                                                                                                                                                                                        | Where                                            |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Account    | `FoundryAscent-Boundary` denies cost hazards for every platform role, including CloudFormation's execution role: customer KMS keys, EC2 instances, NAT gateways, Elastic IPs, VPC endpoints, non-`db.serverless` RDS, RDS Proxy, ElastiCache, OpenSearch, Redshift, SageMaker endpoints, Bedrock provisioned throughput and customization, provisioned Lambda concurrency, Kinesis, EKS, WAF, domain registration, savings plans | `infra/iam/policies/permissions-boundary.json`   |
| AI spend   | Daily caps in `platform_settings`: `daily_usd_cap_global` ($2.00) and `daily_usd_cap_per_principal` ($0.50), UTC day, computed from `usage_ledger`; exceeding returns `429 spend_cap_reached` and is audited                                                                                                                                                                                                                     | `packages/core`, admin settings                  |
| Abuse      | 20 turns / 10 min per principal; `max_turns_per_session` 40; sign-in lockout (ADR-0013); global AI kill switch `ai_enabled`                                                                                                                                                                                                                                                                                                      | `platform_settings`, core config                 |
| Compute    | Aurora max 2 ACU and auto-pause after 10 idle minutes; worker ≤ 2 concurrent SQS pollers; 60 s API timeout. API reserved concurrency is optional (`api.reservedConcurrency`) and `null` in production: a reservation fails the deploy on accounts whose Lambda concurrency quota is only 10, and no guardrail above depends on it                                                                                                | `infra/cdk/config/production.json`               |
| Visibility | Alarms: API errors and throttles, worker errors, DLQ not empty, CloudFront 5xx rate → SNS `FoundryAscent-Alarms`; per-turn tokens, cost and latency in `turns`/`usage_ledger`; admin usage page                                                                                                                                                                                                                                  | App stack, `/admin/usage`                        |
| Retention  | Log groups 30 days, access logs 90 days                                                                                                                                                                                                                                                                                                                                                                                          | CDK                                              |
| Budget     | AWS Budgets monthly cost budget (recommended $10) with email alerts at 50/80/100 % actual and 100 % forecast, plus Cost Anomaly Detection: account-level, created once by the account administrator, outside CDK                                                                                                                                                                                                                 | [cost controls](../../runbooks/cost-controls.md) |

### Consequences

- Good: worst-case AI spend is bounded at roughly the global cap per day (≈ $60/month at $2.00/day);
  infrastructure that could cost hundreds per month cannot be created by any platform role.
- Good: a compromised deploy role still cannot remove the boundary or create unbounded principals.
- Bad: legitimate needs (WAF, a VPC endpoint, provisioned capacity) require a reviewed boundary change.
- Bad: caps can block real use on a busy day; admins raise them in the settings page (audited).
- Neutral: caps are per UTC day; costs are estimates from configured prices, reconciled with Cost Explorer.
- Neutral: the public `/api/v1/health` never queries the database, so external uptime checks cannot keep
  Aurora from pausing.
- Bad: without reserved concurrency a burst of traffic can use the account's whole Lambda pool; per-person
  rate limits and the spend caps bound the AI cost of such a burst, and the budget alerts on the rest.

### Confirmation

- CDK guardrail tests (`infra/cdk/test/guardrails.test.ts`): no NAT/EIP/endpoints/instances, boundary on
  every role, no provisioned concurrency.
- Core tests for spend caps and rate limits; the `Ops - AWS inventory` workflow for actual spend.
- Runbook: [cost controls](../../runbooks/cost-controls.md).

## Revisit trigger

- Sustained usage approaching the caps with demonstrated value (02 §12 cost per qualified progress
  event), a pilot cohort with a funded budget, or any boundary change request.
