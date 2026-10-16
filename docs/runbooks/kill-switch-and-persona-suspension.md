# Runbook: kill switch and persona suspension

**Who:** program leads and linked EIRs (persona), platform admins (global switch, caps), account
administrator (break-glass) · **Related:** [ADR-0005](../architecture/adr/0005-separable-persona-layers.md),
[ADR-0015](../architecture/adr/0015-cost-guardrails.md), [incident response](incident-response.md)

Blueprint 01 §7 requires that Ain and the EIR can suspend the system **without engineering
intervention**. Levels 1–3 below are product features; level 4 is for when the product itself cannot be
trusted or reached. Every product action is written to the audit log with the actor and reason.

| Level | Scope                                 | Who                      | Effect                                                                                                         | Reversal            |
| ----- | ------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------- |
| 1     | One persona (e.g. Corin's vEIR)       | program lead, linked EIR | New conversations, turns and calls with it are refused (`423 persona_suspended`); its live calls end           | Resume              |
| 2     | AI spend                              | platform admin           | Turns, speech and distillation refused once today's spend reaches the cap (`429 spend_cap_reached`)            | Raise cap           |
| 2a    | Voice calls (`callsEnabled`)          | platform admin           | New calls refused; live calls end at their next heartbeat (≤ 15 s). Chat keeps working                         | Re-enable           |
| 2b    | Streamed replies (`streamingEnabled`) | platform admin           | Replies arrive whole instead of sentence by sentence; nothing else changes                                     | Re-enable           |
| 3     | All AI (global)                       | platform admin           | Conversation start, every turn and every call refused (`503 ai_disabled`); no model, embedding or speech calls | Re-enable           |
| 4     | Whole API                             | account administrator    | Every `/api/*` request throttled; the SPA still loads but cannot sign in                                       | Restore concurrency |

All levels take effect on the next request: settings and persona status are read from the database on
every conversation start, every turn and every call heartbeat (no cache). Memory, documents, escalations
and history are never modified by any level.

## Level 1 — suspend a persona

1. Sign in → **EIR studio → Personas** → select the persona → **Suspend**. A reason is required
   (3–500 characters; it is stored in the audit log, so describe the issue, not the content).
2. Verify: the persona shows _Suspended_; starting a conversation on a venture assigned to it shows the
   suspension notice.
3. API equivalent (signed-in session cookie; CloudFront needs the body hash):
   ```bash
   BODY='{"reason":"Doctrine review after incident INC-2026-001"}'
   curl -sS -X POST "https://<site>/api/v1/personas/<personaId>/suspend" \
     -H 'content-type: application/json' -H 'x-requested-with: foundry-ascent' \
     -H "x-amz-content-sha256: $(printf '%s' "$BODY" | sha256sum | cut -d' ' -f1)" \
     -H "cookie: fa_session=<token>" --data "$BODY"
   ```
4. **Resume** from the same page (`POST /api/v1/personas/<id>/resume`) once the cause is resolved. EIR
   personas resume only with a valid consent record; a revoked consent keeps them suspended. The page then
   offers no Resume and says why; the API answers 403 with the reason at `errors[].path = "consent"`.

Use level 1 for doctrine or style problems in one persona, a withdrawn EIR consent, or suspected persona
poisoning (03 §14). A problem in a single **release** can also be handled by approving a corrected
release, which supersedes the faulty one.

## Level 2 — tighten the spend caps

**Admin → Settings**: daily AI spend cap, global and per person (USD, UTC day; checked on conversation
start, every turn, every spoken reply and every distillation). A global cap of `0` blocks all coaching
without changing `aiEnabled`. See [cost controls](cost-controls.md); after raising the global cap, raise
`speech.dailyAlarmUsd` to match.

## Level 2a and 2b — switch off calls or streaming

Use **2a** when calls misbehave (speech, recognition, a call vendor or the call minutes) and chat should
stay up; use **2b** when streamed sentences misbehave and whole, fully validated replies are enough.

1. Sign in as a platform admin → **Admin → Settings → Calls and streaming**.
2. **2a:** turn off **Voice calls**, then confirm **Turn off calls** in the "Turn off voice calls?" dialog.
   Every Call entry point disappears for founders (sidebar, ⌘K, New chat, the conversation header and
   composer); a call screen opened from an old link says calls are paused; live calls end at their next
   heartbeat (≤ 15 s) with "Calls were paused by the program." in their summary.
3. **2b:** turn off **Streamed replies** (no confirmation: nothing is lost). Replies arrive whole.
4. Verify: the toast says "Voice calls off" or "Streamed replies off", and **Admin → Audit** lists the
   settings change.
5. Re-enable with the same switch once the cause is fixed.

Through the API (same headers as above; the change is audited):

```bash
BODY='{"callsEnabled": false}'        # or '{"streamingEnabled": false}'
curl -sS -X PATCH "https://<site>/api/v1/admin/settings" \
  -H 'content-type: application/json' -H 'x-requested-with: foundry-ascent' \
  -H "x-amz-content-sha256: $(printf '%s' "$BODY" | sha256sum | cut -d' ' -f1)" \
  -H "cookie: fa_session=<token>" --data "$BODY"
```

Re-enable with `true`. Conversations, including the transcripts of earlier calls, stay readable.

## Level 3 — global AI kill switch

1. **Admin → Settings → AI kill switch**: turn off **AI coaching enabled**, then confirm **Pause AI
   coaching** in the "Pause AI coaching for everyone?" dialog. API: `PATCH /api/v1/admin/settings` with
   `{"aiEnabled": false}` (same headers as above).
2. Effect: no new conversations, turns or calls, and live calls end at their next heartbeat; recaps and
   distillation are skipped; document ingestion still stores text chunks but skips embeddings (lexical
   retrieval only). Founders can still read memory, documents and escalations, and escalations still
   route to humans.
3. Communicate: tell founders and EIRs the coach is paused and how to reach the program team.
4. Re-enable with the same toggle after the incident review.

### Infrastructure off switch (PR + deploy)

`speech.enabled: false` in `infra/cdk/config/production.json` is for when the in-product switches are
not enough (for example a defect that bypasses them). It removes the API role's Amazon Polly and Amazon
Transcribe permissions and sets `SPEECH_ENABLED=false`, so the API offers neither and calls can neither
listen nor speak even if application code tried to. Transcribe sockets already open run until the browser
closes them. It is a one-line change plus a normal deploy (about 2 minutes after CI).

## Level 4 — break-glass (product unavailable or not trusted)

Account administrator in the AWS console or CloudShell (`us-east-1`). The GitHub deploy role cannot do this
by design.

```bash
# Stop every API request (CloudFront then returns an error for /api/*; the SPA still loads):
aws lambda put-function-concurrency --function-name FoundryAscent-Api --reserved-concurrent-executions 0
# Stop background jobs (messages stay in the queue and retry later; watch the DLQ):
aws lambda put-function-concurrency --function-name FoundryAscent-Worker --reserved-concurrent-executions 0
```

Set the AI switch directly in the database when the API is down but the database is reachable (Data API,
owner credentials; record the change in the incident log because this bypasses the audit trail):

```bash
APP=FoundryAscent-App
out() { aws cloudformation describe-stacks --stack-name "$APP" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
aws rds-data execute-statement --resource-arn "$(out ClusterArn)" --secret-arn "$(out SecretArn)" \
  --database foundry --sql "UPDATE platform_settings SET value = 'false', updated_at = now() WHERE key = 'ai_enabled'"
```

**Restore:** `aws lambda delete-function-concurrency --function-name FoundryAscent-Api` and
`aws lambda delete-function-concurrency --function-name FoundryAscent-Worker`. Production reserves no
concurrency for either function (`api.reservedConcurrency` is `null`; the worker's SQS mapping caps it at
2 pollers); if a reservation has since been configured, restore that number with
`put-function-concurrency` instead. A redeploy does **not** undo these out-of-band changes unless the
template changes, so always restore explicitly and check with `aws lambda get-function-concurrency`
(no `ReservedConcurrentExecutions` = unreserved).

## After any use

- Record who, when, which level, why, and when it was lifted (incident log, linked from the PR or issue).
- Review the audit log (**Admin → Audit**) for the period; export identifiers only.
- If level 4 was used, run the deploy smoke test against the site after restoring.
