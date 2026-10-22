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

`agenda` is a regression suite of its own (never part of `all`), from the owner's production calls of 2026-10-16…20:
two synthetic ventures (Pelora, typed; Quillon, on calls) whose vEIR notebook holds one open commitment due nine
days ago ("book the regulatory and reimbursement advisor session and prepare three questions"), seeded per run by
`apps/api/src/scripts/lab-agenda-ventures.ts` (local Postgres only). Three remembered conversations per channel,
fixed founder lines (`ops/lab/scenarios/agenda.json`): "I don't know. You tell me.", "you tell me what I should
ask", "help me get started", a pitch, a personal ambition, a topic shift without a marker, and "I met the advisor
last week". Each reply is checked deterministically (`conversation_lab/agenda.py`: substance when help is asked,
a question back only, fewer than two sentences of content, steering back to the commitment on another topic,
re-asking, "still open" for a past date, a follow-up when the founder brings it up, openers re-opening it, "So …"
openings) and each conversation is judged. About USD 0.2 a run.

`matrix` has two sources (input `matrix_source`); the summary says which ran:

- `builtin` (default): the lab's own scenarios (`ops/lab/scenarios/smoke.json`, 40, of which `max_scenarios` run).
- `evals`: the conversation matrix of `evals/` (`python -m foundry_evals run --suite matrix`) against the lab's
  app, with the probed simulator and judge. Its report (ids, grader codes and numbers, by evals' own contract,
  gates G1–G17 included) is printed in the summary; its transcripts and judge rationales go to the sealed outputs.
  The lab passes evals a planning estimate of USD 0.006 a turn (measured), caps evals' spend at the run's budget,
  and charges evals' simulator and judge spend to the lab's ledger.

  Its remembered (multi-session) scenarios need a dedicated synthetic venture that nobody else uses. Before the app
  starts, the lab adds one to its own freshly reset database: **Lanternwise**, with two synthetic founders and a
  synthetic teammate, QuietQuad's vEIR as its coach and an empty notebook
  (`packages/db/src/seed/lab-memory-venture.ts`, run by `apps/api/src/scripts/lab-memory-venture.ts`, which refuses
  anything but a local Postgres outside production). The lab passes it as `--memory-venture lanternwise`; evals gives
  each scenario the venture's least-used member, and waits out the app's per-person voice-turn limit (40 per 10
  minutes), which (unlike the typed limit) the lab cannot raise. evals' "days later" and "weeks later" scenarios are
  real, not compressed: after such a conversation ends, evals calls the lab's `--between-sessions-cmd`
  (`apps/api/src/scripts/lab-age-conversation.ts`), which waits for the conversation's distillation and then moves it,
  the venture's earlier live conversations and everything they produced (turns, digests, notebook lines and due dates,
  memory items and their history, escalations) back 3 or 14 days in the lab's database
  (`packages/db/src/lab/age-conversations.ts`; same local-only refusal). The next conversation's opener and "Where you
  left off" then say "3 days ago" or "2 weeks ago". The usage ledger, calls (their minutes count today, and a call's
  start never changes) and the audit log stay. The summary counts the gaps aged; evals notes each such scenario
  `time_aged_days:N` (or `time_compressed` with `between_sessions_failed:<code>` when aging failed).

The founder simulator and the judge are Amazon Bedrock models of `ops/lab/models.json`: Nova Pro plays the founder
(fallback Nova 2 Lite), Nova Premier judges (fallback Nova Pro). Each run probes them with a one-token request and
prints which answered; a model the account cannot use shows its AWS error code there (never a message). Claude is
not enabled on the account.

## Security model

| Piece                                                   | What it may do                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The workflow                                            | Runs from `main` only, in the GitHub environment `conversation-lab`.                                                                                                                                                                                                                                                                                                              |
| Role `FoundryAscent-ConversationLab` (Foundation stack) | Trusted only by `repo:satvikOS@…/Foundry-Ascent@…:environment:conversation-lab`. `bedrock:InvokeModel` + `InvokeModelWithResponseStream` on exactly the app's models and the lab's (`lib/lab-models.ts`); `polly:SynthesizeSpeech`, `polly:DescribeVoices` (the app's free connection warm-up at a call's start) and `transcribe:StartStreamTranscriptionWebSocket` in us-east-1. |
| What it cannot reach                                    | Any platform resource: no Aurora, secret, bucket, queue, function or log. The deploy and insights roles are not widened.                                                                                                                                                                                                                                                          |

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

## Targeted runs and the app's own numbers

- `scenario_ids` (matrix) runs only those scenarios, for example `SM-13,SM-39`. `repeat` runs each one that many
  times (ids get `#n`). For voice, `repeat` is the number of calls in a row, for more barge-in and first-audio
  samples.
- Every summary adds what the app's own logs say, as numbers:
  - model attempts per purpose (first attempts, how many ended `invalid_output`, the share), the invalid-output
    issue codes and how often `(root): max_tokens` appears;
  - server turn time and first speech, Polly first audio per unit;
  - streamed turns that fell back to a whole reply, and interrupt requests.
- The matrix also counts the validator notes (for example `meta_narration_*`, `stream_meta_narration*`) and the
  grader findings (for example `structured_leak`).
- Recall adds RG-01: a line typed while the call greeting plays. It records how soon the turn goes out (LAB-R1) and
  whether the greeting stopped. Recall also flags openers that quote a question or name the founder in lower case
  or in the third person.
- Voice counts self-interruptions: interrupt requests the test did not cause by barging in.

Only one run of the workflow can wait at a time (GitHub cancels an older pending run of the same concurrency group).
Dispatch the next suite once the previous one has started.

## Before and after

`baseline_run_id` compares a run with an earlier run of the same suite. The summary then adds tables of the
baseline, this run and the change:

- headline numbers: pass rate, humanness, turn time, voice latencies and WER, spend;
- each matrix dimension's pass rate;
- the **phrase census**: the share of replies with each tracked habit, such as "The riskiest assumption…", "so
  neither", evidence keys, two or more questions, a reasoning leak and reply length (`conversation_lab/census.py`);
- the scenarios whose outcome changed.

The baseline is `ops/lab/baselines/<suite>-<run id>.json` when committed, otherwise that run's public summary
artifact (kept 7 days). The committed baselines are from before the wave-6 hotfix and presence work:

| Suite                 | Baseline run |
| --------------------- | ------------ |
| recall                | 39080360013  |
| voice                 | 39081203019  |
| matrix (40 scenarios) | 39084323076  |
| ui                    | 39084712617  |

Their census, notes, findings, app-log numbers, opener flags and greeting delay were computed afterwards from
the runs' sealed outputs. Issue codes were not logged then, so those counts are null.

```bash
gh workflow run ops-conversation-lab.yml -f suite=matrix -f budget_usd=5 -f max_scenarios=40 \
  -f baseline_run_id=39084323076 -f public_key="$(cat "$dir/public.b64")"
```

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

The evals matrix (`matrix_source=evals`) cost USD 0.45 for 12 scenarios (run 39093976745), so all of it (41
scenarios plus the 8 remembered ones) is about USD 1.5–2. Its planner over-estimates turns, so give it a cap of
about USD 3 to plan everything:

```sh
gh workflow run ops-conversation-lab.yml -f suite=matrix -f matrix_source=evals -f budget_usd=3 \
  -f max_scenarios=40 -f public_key="$(cat "$dir/public.b64")"
```

## Safety screen evaluation

The safety screen (packages/ai README, "Indirect ideation") is evaluated on its own, outside the suites: a script
runs the crisis pipeline (the deterministic rules, the ideation prefilter, then the screen exactly as a turn calls it:
same prompt, schema, output bound and 2.5 s budget) over the E-crisis corpus (`ops/lab/scenarios/safety-screen.json`,
1,244 synthetic lines: crisis lines, hard negatives that share their words, every line of the evals datasets, tests
and lab scenarios that the rules flag, and 17 closings sent with the vEIR's previous reply, as a turn sends them) and
prints precision, recall, latency and cost. It needs credentials
allowed to invoke the app's models (the lab role grants exactly those; an operator's own credentials work as well):

```bash
MODEL_PROVIDER=bedrock BEDROCK_REGION=us-east-1 \
MODEL_PRIMARY_ID=us.amazon.nova-2-lite-v1:0 MODEL_FALLBACK_ID=global.amazon.nova-2-lite-v1:0 \
MODEL_EMBEDDINGS_ID=amazon.titan-embed-text-v2:0 \
pnpm --filter @foundry/api exec tsx src/scripts/lab-safety-screen.ts --budget-usd 1 --out /tmp/safety-screen
```

(copy the model ids from `infra/cdk/config/production.json`). `--scope all` also screens the lines the prefilter
lets pass (the screen's recall without the prefilter, when deciding to widen or narrow it); `--limit N` and
`--concurrency N` (default 4) bound a run. Without `MODEL_PROVIDER=bedrock` it runs on the mock gateway's rule (a
free plumbing check). The output is public-safe: counts, rates, row ids, model ids, milliseconds and dollars. With
`--out`, every row's outcome and the model's one-sentence reason, with the corpus text, go to
`<out>/private/safety-screen.json`, for the operator only.

Read it as follows:

- `rulesOnly` and `pipeline`: confusion counts, precision and recall on the lines labelled `crisis` and `none`, for
  the rules alone (origin/main's behaviour) and for rules + screen. The pipeline's true positives can only grow:
  the screen never removes a rule's crisis.
- `screenAlone`: precision and recall on the lines the screen read, with the first ids of its false crises (ordinary
  lines answered with the crisis message) and missed crises. The product rule: ordinary coaching must not get the
  crisis response, so a false crisis on a sign-off, venture frustration or a joke is the number to drive down
  (change the prompt in `src/risk/safety-screen.ts` with `POLICY_VERSION`), while a missed crisis is one the rules
  never caught either.
- `withReply`: the closings read with the reply they answer ("goodbye" after "Anything else before we stop?", and
  after "Are you safe right now?"). Sign-offs are the screen's most frequent production input, so a false crisis
  there is the first thing to check.
- `wellbeingOnOrdinary`: ordinary lines given the wellbeing flag (each forces a P1 escalation): also false
  positives.
- `latencyMs` and `costUsd`: the latency a prefilter hit adds to a turn, and the cost per call and per 1,000 founder
  turns at a given share of prefilter hits.

A run of the whole corpus screens 669 lines: about USD 0.33 on Nova 2 Lite (≈ 1,100 input and ≈ 50 output tokens a
call at the `us.` profile's USD 0.33 and 2.75 per million: ≈ USD 0.0005 a call), within the default budget of USD 1.

What it costs in production. The prefilter fires on about 0.1 % of the lab's, evals' and e2e suites' ordinary lines
(2 of 1,627), but also on bare closings: 14 of 33 everyday sign-offs ("goodbye", "ok goodbye", "i think i'm done",
"thank you for everything") reach the screen, so a conversation that ends with one pays for one call. At ≈ USD 0.0005
a call that is about USD 0.0005 per 1,000 turns at a 0.1 % hit rate, USD 0.025 at 5 % and USD 0.05 at 10 % (one
sign-off in every ten turns), against about USD 6 for the 1,000 coaching turns themselves: under 1 %. Latency: the screen runs once the turn
is admitted (the founder already sees it accepted, at "Understanding"), typically 0.5–1.5 s and never more than 2.5 s,
and the retrieval embedding waits for its verdict (≈ 0.1–0.2 s more) so that a screened crisis makes no retrieval
call. Every other message pays nothing, and a request a gate refuses (call admission, the message limit, the spend
caps) never buys a screen call.

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
