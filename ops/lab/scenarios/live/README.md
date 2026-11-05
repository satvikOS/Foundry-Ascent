# Live conversation evaluation: 600 scenarios

The owner brief's sections 16, 17 and 19, built to replace `evals/datasets/upgrade` (a templated set that ran only
on the mock model; see the audit). Code: `ops/lab/conversation_lab/live/`. Workflow:
`.github/workflows/ops-live-evals.yml`. Runbook: `docs/runbooks/conversation-lab.md` (section "Live evaluation").

**No live run has happened yet.** Everything below is the dataset, the harness and estimates. Results appear only
after a dispatch, and they are labelled by evidence: `live` (real models) or `infrastructure-only` (fake app or mock
model, never behavioural evidence).

## The dataset

`fNN-<slug>.yaml`: 30 families (the brief's table) x 20 scenarios, ids `LV-FF-NN`. Every scenario is authored
content for its own decision, failure mode or conversational challenge. The schema (`dataset.py`, strict: unknown
or missing keys fail) holds the section 17 fields:

| Field                                       | Meaning                                                                                                                                                                                                                     |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `version`                             | Stable id and content version (the run records both, with prompt, model, code and dataset hashes, a run id and timestamps)                                                                                                  |
| `title`, `challenge`                        | The decision or failure mode the scenario exists to test                                                                                                                                                                    |
| `venture`, `student`, `purpose`, `sessions` | Venture and student state; sessions with their gap in days, turns and channel (`chat` or `call`)                                                                                                                            |
| `priorMemory`, `documents`, `neighbour`     | Prior approved memory, uploaded documents, and for isolation tests a separate venture holding a secret (with `leaks`: phrases that would reveal it)                                                                         |
| `objective`, `constraints`, `hidden`        | What the student wants, their constraints, and the facts they know but reveal only when natural                                                                                                                             |
| `arc`                                       | Scripted behaviours (`["session.turn", kind, text]`): hesitations, corrections, contradictions, interruptions, topic changes, returns, distress, injections; `memory_*` beats at turn 0 are review actions before a session |
| `sources`                                   | Retrieval and tool conditions (null: normal retrieval, no documents)                                                                                                                                                        |
| `branches`                                  | Likely conversational branches                                                                                                                                                                                              |
| `expected`, `prohibited`                    | Behaviours the judge checks one by one                                                                                                                                                                                      |
| `memoryChanges`, `escalation`               | Expected memory changes; expected escalation (`none`, `offer`, `handoff`, `route`, `refuse`, `crisis`) and where to                                                                                                         |
| `scoring`                                   | The rubric dimensions in focus and what passing looks like                                                                                                                                                                  |
| `short`                                     | Required when a scenario has fewer than 8 student turns (early termination, refusal or routing is right)                                                                                                                    |

The groups the brief asks for are computed from the content, never declared (`overlap()` in `dataset.py`):

| Group                                                     | Required | Scenarios |
| --------------------------------------------------------- | -------- | --------- |
| Three or more sessions                                    | 60       | 70        |
| 50+ conversational turns (student turns + coach replies)  | 20       | 29        |
| Corrections or contradictory evidence                     | 100      | 109       |
| Interruptions, topic changes, incomplete answers, returns | 100      | 117       |

Overlaps: multi-session and long 19; multi-session and corrections 24; multi-session and interruptions 25; long
and corrections 9; long and interruptions 24; corrections and interruptions 10; in all four 6; in none 357. Voice
scenarios (a call in at least one session): 28. Student turns in total: 5,919. Short by design (9): LV-15-19,
LV-17-19, LV-18-17, LV-21-12, LV-25-03, LV-27-19, LV-28-06, LV-28-15, LV-28-17.

## Distinctness (fails the build)

`python -m conversation_lab live-check` (and `tests/test_live_dataset.py`) fails on any of:

| Measure                                                                                      | Threshold | Nearest pair in the dataset |
| -------------------------------------------------------------------------------------------- | --------- | --------------------------- |
| TF-IDF cosine, word unigrams and bigrams, the scenario's own names masked, digits folded     | 0.40      | 0.236 (LV-30-07 / LV-30-18) |
| Same cosine with industry and product words also masked (name- or industry-only variants)    | 0.45      | 0.243                       |
| Jaccard of word 4-gram shingles (copied sentences, templated phrasing)                       | 0.10      | 0.037                       |
| Any authored item of 16+ characters appearing verbatim in two scenarios (shared boilerplate) | 0         | 0                           |

The tests also prove the checker catches what it must: a name-swapped copy, an industry-swapped copy and a batch
built like the audited upgrade corpus (a fixed template with only the decision string changed).

## How a scenario runs

One synthetic venture and founder per scenario run (`apps/api/src/scripts/lab-live-ventures.ts`), prior memory and
documents created through the founder's own API, real sessions (standard privacy) with the conversation distilled
and aged between sessions (`lab-age-conversation.ts`), the AI's memory proposals left as the product leaves them
(the `approve_memory` input opts into a student who approves every proposal; the number approved is published),
voice sessions on typed-input calls (signed speech units, barge-in through `POST /turns/:id/interrupt`). Failure
conditions are enacted where the API allows: a barge-in, a duplicate event (the previous request again with the same
idempotency key), a double submit (`resend`), and a dropped call redialled before the student's turn, whose new
opening the student and the judge see. Conditions the runner cannot inject (a late or unavailable retrieval, a
degraded provider, a "your reply cut off" complaint) are carried by the student's words only, and the summary labels
those runs "failures described, not injected". The session ends when the student leaves (a stop or wrap-up beat, or
the simulator saying it is done) unless scripted beats remain. The student is an LLM (`live.simulator` in `ops/lab/models.json`, Llama 4 Maverick
first, Nova Pro as fallback, temperature 0.7) that reads the coach's actual reply. The judge (`live.judge`: Claude
Haiku 4.5 first, then Llama 4 Maverick, then Nova Premier, temperature 0) scores the twelve section 19 dimensions
with poor/acceptable/excellent anchors and checks every expected and prohibited behaviour. Deterministic checks run
beside it: repeated questions, semantic repetition, canned phrases, stacked questions, Markdown in speech,
volunteered AI disclaimers, suspected fabricated citations and figures, false action claims, isolation leaks
(figures compared as normalised values, plus each neighbour's authored `leaks` phrases), and each watch phrase's
rate per 100 replies across the whole run.

A scenario passes when it completed, every expected behaviour was met, no prohibited one occurred, escalation and
memory were right, nothing was fabricated, there was no presence violation, and no blocking deterministic finding.
Failures and timeouts count in every denominator, and their turns stay in the latency distribution at their elapsed
time. A run the simulator could not continue (`simulator_failed`: nothing is sent to the coach in its place) or a
budget stopped part-way (`stopped`) is not scored as the coach's behaviour, and every gate is computed over the
planned runs: while any planned run lacks a verdict a gate reads "NOT met (incomplete)" with its coverage. The
isolation gate counts the deterministic leaks and the judge's severe isolation codes. The summary reports per family,
severe outliers, p50/p95 coach turn latency, the section 19 gates, and run-to-run stability when a scenario ran more
than once.

## Cost (dry-run estimates, no model called)

`python -m conversation_lab live-plan` prints these with their assumptions. Coach turns are priced at the lab's
measured USD 0.006 per turn (run 39093976745: USD 0.388 over 66 turns, distillation included) plus USD 0.003 per
session; the simulator and judge at `ops/lab/models.json` prices, which are the higher published figures for Llama 4
Maverick and Claude Haiku 4.5 (verify on the Bedrock pricing page).

| Run                                          | Scenario runs | Student turns | Coach | Student | Judge | Total         | If the account falls back to Nova | Shards |
| -------------------------------------------- | ------------- | ------------- | ----- | ------- | ----- | ------------- | --------------------------------- | ------ |
| Pilot: 60, stratified (2 per family), seed 1 | 60            | 605           | 3.86  | 0.73    | 0.49  | **USD 5.09**  | USD 6.37                          | 2      |
| Full: all 600                                | 600           | 5,919         | 37.76 | 7.01    | 4.90  | **USD 49.67** | USD 62.23                         | 11     |
| Repeat of the pilot's 60 (same seed)         | 60            | 605           | 3.86  | 0.73    | 0.49  | **USD 5.09**  | USD 6.37                          | 2      |

Wall time at concurrency 4: about 40 minutes for the pilot (2 shards in parallel), about 1.5 hours for the full set
(11 shards, 4 at a time). `budget_usd` is a hard cap regardless of the estimate.
