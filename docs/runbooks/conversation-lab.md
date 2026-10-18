# Runbook: conversation lab

**Owner:** platform owner · **Related:** [platform insights](insights.md), [evals](evals.md),
[cost controls](cost-controls.md), [local development](local-development.md)

Real conversations with the app's real models, headless, on synthetic data only: the same code, prompts and model
configuration as production, run on a GitHub runner against a throwaway PostgreSQL. It answers "does the vEIR
remember, listen, speak and behave like a present human mentor?" with numbers, and keeps every transcript sealed.

## What runs

**Ops - conversation lab** (`.github/workflows/ops-conversation-lab.yml`, manual) starts one job per suite. Each job
runs PostgreSQL 16 + pgvector, `pnpm db:reset` (the synthetic seed: tenant `ain`, founder Maya of QuietQuad,
Corin's vEIR), embeds the seed with Titan as every deploy does, starts the API dev server with
`MODEL_PROVIDER=bedrock` and the models of `infra/cdk/config/production.json`, serves the production web build, and
runs the harness (`ops/lab`, `python -m conversation_lab`):

| Suite    | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                            | Passes when                                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `recall` | Through the UI, typed: **RC-01** the owner's scenario (a call, hang up, a second call 150 s later, "do you remember what we talked about last time?" and "what did I say my biggest worry was?"); **RC-02** chat then call; **RC-03** call then chat (`ops/lab/scenarios/recall.json`).                                                                                                                                                                 | The reply names the earlier conversation's distinctive facts (synonym groups), the judge rates accuracy ≥ 4 with nothing invented, no presence finding |
| `voice`  | A true voice call: Amazon Polly speaks the founder's four lines; Chromium hears line 1 through its fake microphone device and the rest mixed into the same microphone stream; the app streams to Amazon Transcribe, answers on the real model, speaks with Polly (muted). Line 3 interrupts the vEIR.                                                                                                                                                   | Speech-to-text was granted, every line heard with WER ≤ 0.25, the vEIR's audio started after each turn, and the barge-in sent the interrupt            |
| `matrix` | Conversations across the matrix of human conversation (question types, answer styles, emotions, topic changes, relational moves, chat and call, registers): founder turns from an LLM simulator, graded by the deterministic graders and an LLM judge.                                                                                                                                                                                                  | Every turn answered, no blocking or presence finding, and the judge found the scenario's expectation met, the founder heard (≥ 4), no presence slip    |
| `ui`     | The whole Playwright suite (`apps/web/e2e`) against the real model, speech off as in CI. Its assertions hold for any model (a recall names the earlier topic's key term, memory is matched loosely by topic, citations are asked of questions only the seed's records answer); a step that genuinely cannot hold for a real model carries `@mock-only` with its reason, and the lab passes `--grep-invert @mock-only` (CI runs everything on the mock). | Playwright's own outcome per test (retried once)                                                                                                       |

Until the conversation-matrix suite of `evals/` lands, `matrix` runs the built-in smoke set
(`ops/lab/scenarios/smoke.json`, 14 scenarios); the summary says which source ran.

The founder simulator and the judge are Amazon Bedrock models of `ops/lab/models.json`: Nova Pro plays the founder
(fallback Nova 2 Lite), Nova Premier judges (fallback Nova Pro). Each run probes them with a one-token request and
prints which answered; a model the account cannot use shows its AWS error code there (never a message). Claude is
not enabled on the account.

## Security model

| Piece                                                   | What it may do                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The workflow                                            | Runs from `main` only, in the GitHub environment `conversation-lab`.                                                                                                                                                                                                                                |
| Role `FoundryAscent-ConversationLab` (Foundation stack) | Trusted only by `repo:satvikOS@…/Foundry-Ascent@…:environment:conversation-lab`. `bedrock:InvokeModel` + `InvokeModelWithResponseStream` on exactly the app's models and the lab's (`lib/lab-models.ts`); `polly:SynthesizeSpeech` and `transcribe:StartStreamTranscriptionWebSocket` in us-east-1. |
| What it cannot reach                                    | Any platform resource: no Aurora, secret, bucket, queue, function or log. The deploy and insights roles are not widened.                                                                                                                                                                            |

The repository is public, so the log, the job summary and artifacts are world-readable:

- The harness prints only pass rates, latencies, counts, ids, codes, fixed test titles and dollars
  (`conversation_lab/report.py`); Playwright prints through `apps/web/e2e/lab/public-reporter.ts` (title,
  outcome, duration). Exceptions print their class name only.
- Transcripts, judge rationales, failure screenshots, the Playwright JSON report and the server logs go to a private
  folder. With `public_key` they are sealed with the ops-insights envelope (RSA-OAEP-256 wrapping a random
  AES-256-GCM key, gzip; `apps/api/src/scripts/lab-seal.ts`) and uploaded for **1 day**; without it they are
  deleted. The upload step refuses any file that is not an envelope.
- The public summary (`summary.json`, `summary.md`, the lab's spend ledger) is uploaded unsealed for 7 days.

## One-time setup (repository owner)

After the deploy that creates the role, create the environment with the same branch rule as `production`:

```bash
gh api -X PUT repos/satvikOS/Foundry-Ascent/environments/conversation-lab \
  -F 'deployment_branch_policy[protected_branches]=false' -F 'deployment_branch_policy[custom_branch_policies]=true'
gh api -X POST repos/satvikOS/Foundry-Ascent/environments/conversation-lab/deployment-branch-policies \
  -f name=main -f type=branch
```

## Running it

```bash
# numbers only
gh workflow run ops-conversation-lab.yml -f suite=recall -f budget_usd=2
# with sealed transcripts (key pair as in the insights runbook; the private key never leaves your machine)
gh workflow run ops-conversation-lab.yml -f suite=all -f budget_usd=5 -f max_scenarios=14 \
  -f public_key="$(cat "$dir/public.b64")"
gh run watch "$(gh run list --workflow ops-conversation-lab.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

Read the job summary of each suite. To open the sealed outputs:

```bash
gh run download <run id> -p 'conversation-lab-sealed-*' -D "$dir/sealed"
for d in "$dir"/sealed/*/; do
  pnpm --filter @foundry/api exec tsx src/scripts/lab-seal.ts open "$dir/private.pem" "$d" "$dir/opened"
done
```

`opened/` holds conversation content of synthetic people: keep it in that folder and delete it when the findings
are written. Findings that point at the product (not the harness) go to the stream that owns the code.

## Reading the summary

| Field             | Meaning                                                                                                                                                                                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Passed            | Scenarios that met the suite's bar (table above)                                                                                                                                                                                                                                                               |
| Why               | `pass`, `pass_rules_only` (no judge model answered), `facts_missing`, `judge`, `presence`, `no_reply`, `run_error`, `not_captured`, `judge_expectation`, `judge_felt_heard`, `judge_presence`, `blocking_finding`, `turn_error`, `no_voice_input`, `misheard`, `line_not_heard`, `no_audio`, `barge_in_missed` |
| Presence findings | `volunteered_ai_disclaimer`, `identity_not_honest` (a sincere "are you a bot?" not answered honestly), `legal_boilerplate`, `human_claim`, `physical_presence_claim` (`conversation_lab/presence.py`)                                                                                                          |
| Craft findings    | The codes of `evals/foundry_evals/graders/conversation.py` (stock openers, repeated questions, a report answering thanks, …); informational                                                                                                                                                                    |
| Humanness         | The judge's mean score over scenarios, 1–5 scaled to 0–100                                                                                                                                                                                                                                                     |
| Voice latencies   | First audio after the founder stops speaking; end of speech to turn sent (endpointing + Transcribe); turn sent to first audio (model + Polly). The app's own client stats (sent at hang-up) are printed beside them                                                                                            |
| Stopped by        | `completed`, `budget_app`, `budget_lab`, or `app_refused` (the app answered `spend_cap_reached` or another stop code)                                                                                                                                                                                          |

## Spend

`budget_usd` (default 5, at most 50) is a hard cap for the whole run, split by suite weight (recall 1, voice 1,
matrix 2, ui 2). Within a suite:

- the **app's share** (recall and voice 85 %, matrix 55 %, ui 100 %) is metered by the app itself (the usage ledger
  behind Admin → Usage: model turns, distillation, embeddings, Polly characters, Transcribe seconds). Before anything
  runs the harness sets, through the owner's `PATCH /admin/settings`, the platform's daily cap to that share (the
  per-person cap the same), so the app refuses the turn that would go over; the harness also stops scheduling new
  scenarios before it. Other lab values: 200 turns per conversation, 30-minute calls, 240 call minutes a day (the UI
  suite keeps the seeded defaults apart from the caps). The turn rate limit is raised with
  `CORE_TURN_RATE_LIMIT=1000`.
- the **lab's share** (judge, simulator, the founder's synthesized voice) is metered from each response's token or
  character counts at the prices in `ops/lab/models.json` and `packages/core/speech-voices.json`; a call whose worst
  case would not fit is never made.

Expected cost per run, from the prices (actual figures are in each summary): recall ≈ USD 0.10–0.20 (≈ 9 voice and
chat turns with distillation and Polly, 4 judge calls), voice ≈ USD 0.05–0.10, matrix ≈ USD 0.30–0.60 for 14
scenarios (≈ 35 turns, simulator and judge), ui ≈ USD 0.50–1.00 (the suite's ≈ 80 turns). A full `all` run stays
well under the default USD 5.

## Locally

The harness has a dry run that needs no AWS (the app on the mock model; no probes, no backfill, no voice):

```bash
LOCAL_DB_NAME=foundry_lab pnpm db:reset   # export the DATABASE_URL it prints, and the owner code as E2E_OWNER_ACCESS_CODE
cd ops/lab && PYTHONPATH=../../evals python -m conversation_lab run --suite matrix --budget-usd 1 \
  --out /tmp/lab --api-port 8788 --web-port 4174 --mock
```

The browser suites run through Playwright like the e2e suite (silent: fake audio output, silent speech synthesis):
`pnpm --filter @foundry/web exec playwright test --config e2e/lab/playwright.config.ts --project=recall` with
`E2E_OWNER_ACCESS_CODE` and `DATABASE_URL` set (`LAB_RECALL_GAP_SECONDS=3` shortens the pauses). Unit tests:
`cd ops/lab && python -m pytest` (offline; CI runs them in the Python job).

## Troubleshooting

| Problem                             | Cause and fix                                                                                                                                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Could not assume role`             | The environment `conversation-lab` is missing or not limited to `main`, or the deploy that creates the role has not run.                                                                              |
| Probes show `AccessDeniedException` | The model is not in the role's grant (it follows `ops/lab/models.json` and production.json; deploy after changing either) or not available to the account. The next model in the list is used.        |
| Voice: `no_voice_input`             | The call started typed: no Transcribe grant (the API runs with `LOCAL_AWS_SPEECH=true` only in this workflow) or the daily grant quota. The sealed `voice/result.json` holds the call's status lines. |
| Voice: `misheard` / high WER        | Compare the sealed transcripts with `ops/lab/scenarios/voice.json`; Transcribe accuracy, endpointing (600 ms of silence) or a line cut by the barge-in.                                               |
| `Stopped by: budget_app`            | The app's share ran out (Admin → Usage numbers are in the summary). Raise `budget_usd` or lower `max_scenarios`.                                                                                      |
| Luna enabled in production.json     | The app's primary model moves to the Mantle endpoint, which the lab role does not grant (`bedrock-mantle:CreateInference` on `*`); turns fall back to Nova 2 Lite until the role is extended.         |
