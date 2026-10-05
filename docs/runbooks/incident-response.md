# Runbook: incident response

**Incident lead:** platform owner (until a rota exists) · **Related:** [kill switch](kill-switch-and-persona-suspension.md),
[access codes](access-codes.md), [deploy and rollback](deploy-and-rollback.md), [SECURITY.md](../../SECURITY.md)

Blueprint 03 §8 requires kill switch, persona suspension, token revocation, evidence preservation and a
notification workflow, verified by a tabletop exercise and a timed drill. All data in V1 is synthetic
(ADR-0006), but every incident is handled as if it were real: the habits are the control.

## Severity

| Sev       | Examples                                                                                                                                                                   | Response                                               |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **SEV-1** | Alleged or confirmed cross-venture disclosure; compromised credential with write access (deploy role, AWS key, owner code); harmful response involving crisis or self-harm | Start within 1 hour, contain first, continuous updates |
| **SEV-2** | Harmful or materially wrong high-risk advice without crisis; single founder code leaked; vendor outage over 1 hour                                                         | Same business day                                      |
| **SEV-3** | Degraded quality, isolated validator miss, spend anomaly within caps                                                                                                       | Next business day, tracked issue                       |

## Common steps (every incident)

1. **Open an incident record** (private issue or document): id `INC-YYYY-NNN`, reporter, time (UTC),
   severity, what is known. Keep a timestamped log of every action.
2. **Contain** with the least destructive control that stops the harm (table per scenario below).
3. **Preserve evidence before changing data:** audit events (Admin → Audit, export ids), request ids,
   affected turn/escalation/memory ids, CloudWatch log excerpts (`/aws/lambda/FoundryAscent-*`, 30-day
   retention: export what you need), the deployed commit (`/api/v1/health` `version`). Logs contain
   identifiers only; read content in the product under the normal authorization rules, never by copying
   it into tickets or chat.
4. **Notify:** affected founders and EIRs, the Ain program lead; for a confirmed disclosure or
   credential compromise, follow University incident-reporting policy once real data is in scope.
5. **Recover**, then **review within 5 business days:** timeline, root cause, why controls did not stop
   it, actions with owners. Add a regression test or red-team case for every incident class.

## Scenario: P0 cross-venture leak allegation

A founder reports seeing another venture's information (names, numbers, a canary such as
`CANARY::<slug>::…`), or the red team finds one.

| Step     | Action                                                                                                                                                                                                                                                                                                     |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contain  | Global AI kill switch (level 3) immediately; it stops retrieval and generation. If the leak could be outside the AI path (lists, documents, exports), API concurrency 0 (level 4).                                                                                                                         |
| Evidence | Session id, turn ids, `turn_evidence` rows for those turns (which item ids were retrieved), `validator_results`, audit events `retrieval.authorized` / `retrieval.denied` for the request ids, the commit deployed at that time.                                                                           |
| Triage   | Was the foreign item **retrieved** (authorization/RLS failure: SEV-1, ADR-0004) or **generated** (model invented or echoed user-provided text: check the founder's own inputs and documents)? Run `pnpm test:db` (RLS + authz matrix) at the deployed commit and the red-team suite against a local stack. |
| Recover  | Fix with a failing test first; deploy; re-enable AI only after the red-team suite passes with 0 disclosures (01 §9 kill criterion).                                                                                                                                                                        |
| Notify   | Both ventures' founders (the one exposed and the one who saw it).                                                                                                                                                                                                                                          |

## Scenario: compromised code or credential

| What                                           | Contain                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A founder/EIR access code                      | Admin → Principals → revoke the code (also revokes its sessions); issue a new one through a trusted channel ([access codes](access-codes.md)).                                                                                                                                                                                                                                                                                    |
| The owner access code                          | Revoke it in the product if you still have a session; otherwise rotate via deploy ([access codes § rotate](access-codes.md#rotate-the-owner-code)). Review the audit log for admin actions since the suspected exposure.                                                                                                                                                                                                          |
| Session signing key suspected                  | Rotate the platform key (new sessions use it; old tokens fail after the grace period) and revoke all auth sessions. Requires a reviewed change (`authRepo.rotatePlatformKey`).                                                                                                                                                                                                                                                    |
| AWS stage-0 access key                         | IAM → Users → `Foundry-Ascent` → deactivate the key now, then delete; switch to OIDC (deploy runbook). Check CloudTrail for the key id. Since the 2026-10 hardening the key can read, assume the four CDK bootstrap roles (so deploy whatever CDK app it runs, capped by `FoundryAscent-Boundary`) and call Bedrock, but cannot change IAM; review CloudFormation events of `FoundryAscent-*` stacks for deploys you did not run. |
| GitHub account, workflow or deploy role misuse | Revoke the GitHub session/PAT; disable the Deploy workflow (Actions → Deploy → Disable); remove `AWS_DEPLOY_ROLE_ARN`; in IAM, add an explicit deny or delete role `FoundryAscent-GitHubDeploy` (recreated by the next deploy). Review CloudTrail for `AssumeRoleWithWebIdentity` and CloudFormation changes. The permissions boundary still blocks privilege escalation and cost hazards.                                        |
| Malicious commit or dependency                 | Revert on main, redeploy a known-good SHA ([rollback](deploy-and-rollback.md#rollback)); check `pnpm audit`, Dependabot and gitleaks results; rotate anything the code could read at runtime (database secret via Secrets Manager rotation, owner code).                                                                                                                                                                          |
| Secret committed to the repository             | Treat as leaked even if removed: revoke/rotate first, then purge history if needed. The repository is public.                                                                                                                                                                                                                                                                                                                     |

## Scenario: harmful response

A response gave dangerous, discriminatory or prescriptive high-risk advice, impersonated a human, or
missed a crisis signal.

1. **Contain:** suspend the persona (level 1) if the cause is doctrine or style; global switch (level 3)
   if the cause is the model or validators. For any crisis signal: make sure a human from the program has
   reached the founder; this comes before any technical work.
2. **Evidence:** turn id, `risk_label`, `validator_results`, model id and persona release version on the
   turn, prompt version (`packages/ai/src/prompts/version.ts`), whether escalation was forced.
3. **Triage:** classifier miss (add patterns + labelled case), validator gap (new deterministic check),
   doctrine issue (new persona release), or model regression (fallback model, provider change).
4. **Recover:** fix + evals benchmark and red team green; resume; follow up with the founder.

## Scenario: vendor outage (Bedrock, Aurora, AWS region)

| Symptom                                  | What happens                                                                                                                                                                                                         | Action                                                                                                                                                                                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary model errors or times out (25 s) | Gateway falls back automatically: Nova 2 Lite `us.` profile → `global.` profile (same model, global routing)                                                                                                         | Watch `model_unavailable` rates and latency; nothing to do unless both fail                                                                                                                                                               |
| Both models down                         | Turns fail with `503 model_unavailable`; reading memory, documents and escalations works                                                                                                                             | Post a notice; consider the global switch to stop retries; check the AWS Health Dashboard. Both are Nova 2 Lite while GPT-6 Luna is gated, so a Nova-wide outage takes both; enabling Luna (ADR-0014) is a deploy, not an incident action |
| Embeddings down                          | Ingestion stores chunks without embeddings; retrieval falls back to lexical; the migrate backfill fills them later                                                                                                   | None; re-run backfill by redeploying after recovery                                                                                                                                                                                       |
| Aurora resuming/unavailable              | Requests get `503 database_resuming` + `Retry-After` after the API's 40 s wait; the UI shows "Waking up your workspace…" and retries ~45 s; `/api/v1/admin/health` (platform admin) reports `resuming`/`unavailable` | If unavailable beyond minutes: RDS events, cluster status; restore runbook if storage is affected                                                                                                                                         |
| CloudFront / Lambda regional issue       | Site or API unavailable                                                                                                                                                                                              | No multi-region in V1; communicate and wait; verify with the smoke test after recovery                                                                                                                                                    |

## Drills

Run a tabletop for each scenario before the first real cohort and after major changes; time a level-3 and a
level-4 kill-switch drill (target: under 5 minutes from decision to effect). Record results in the incident
log template.
