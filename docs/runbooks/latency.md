# Runbook: latency

**Owner:** platform owner · **Related:** [cost controls](cost-controls.md),
[ADR-0011](../architecture/adr/0011-aurora-serverless-postgres-data-api.md) (Aurora, Data API),
[ADR-0017](../architecture/adr/0017-cloudfront-oac-lambda-function-url-streaming.md) (streaming),
[calls](../architecture/calls.md) §1 (latency budget)

How fast the vEIR answers, where the time goes, how to measure it locally and in production, and what was
changed to make it faster. Every number below says how it was measured.

## 1. Where a turn's time goes

A typed turn, from the founder pressing Enter to the first validated sentence on screen:

```text
request ─ session check ─ preflight (one transaction: conversation, access, assignment, history, notes)
        ─ spend check ─ admission (one transaction: limits, the pending turn) ─ turn.accepted
        ─ query embedding (Titan) ─ retrieval (one transaction) ─ prompt ─ model (Nova 2 Lite, streamed)
        ─ first sentence through the sentence gate ─ turn.delta  …  annotations ─ validation ─ persist
```

On a call the first validated sentence is also a signed `turn.speech` unit, which the browser sends to
`POST /speech` (checks, a speech reservation, Polly) and plays as soon as the first audio bytes arrive.

In production every database statement is an HTTPS call to the RDS Data API, and a transaction adds two more
(BeginTransaction, CommitTransaction). A typed turn made **61 such round trips** (baseline; 57 now), so the
database round trip, not the queries, decides most of the time before the model starts. A Data API transaction
runs one statement at a time (a second statement sent while one runs is refused), so independent reads only
overlap when they are in separate transactions.

## 2. Measuring in production (the logs)

The API writes these lines (numbers and identifiers only, never content):

| Event              | Fields                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http.request`     | `latencyMs` (to the response headers), `authMs` (session check), `dbRoundTrips`, `dbTransactions`, `dbWaitMs` (until the headers)                                                                                                                                                                                                                                             |
| `turn.timing`      | ms since the request arrived: `acceptedMs`, `modelStartMs`, `firstDeltaMs` (first sentence), `firstSpeechMs` (first spoken unit), `totalMs`; stage durations: `authMs`, `admissionMs`, `retrievalMs` (embedding wait + queries), `embedMs`, `promptMs`, `modelFirstTokenMs`, `generationMs`, `structuredMs`, `finishMs`; the whole turn's `dbRoundTrips`, `dbWaitMs`, `voice` |
| `speech.timing`    | ms since the speech request reached the service, cumulative: `verifiedMs`, `plannedMs` (checks), `capsCheckedMs`, `reservedMs`, `synthesizedMs` (Polly answered), `firstAudioMs` (first bytes handed to the response); `characters`. The bookkeeping (ledger, counters, audit) runs while the audio streams                                                                   |
| `ai.model.attempt` | per model call: `latencyMs`, `inputTokens`, `cachedInputTokens` (read from Bedrock's prompt cache, included in `inputTokens`), `outputTokens`, `outcome`                                                                                                                                                                                                                      |

CloudWatch Logs Insights, log group `/aws/lambda/<api function>`:

```text
filter event = "turn.timing" and outcome = "completed"
| stats count(*) as turns, pct(firstDeltaMs, 50) as firstSentenceP50, pct(firstDeltaMs, 95) as firstSentenceP95,
        pct(acceptedMs, 50) as acceptedP50, pct(retrievalMs, 50) as retrievalP50,
        pct(modelFirstTokenMs, 50) as modelTtftP50, pct(dbRoundTrips, 50) as roundTrips,
        pct(dbWaitMs / dbRoundTrips, 50) as msPerRoundTrip by voice
```

```text
filter event = "speech.timing" | stats pct(firstAudioMs, 50), pct(firstAudioMs, 95), pct(plannedMs, 50) by signed
```

```text
filter event = "ai.model.attempt" and outcome = "ok"
| stats pct(latencyMs, 50), sum(cachedInputTokens) / sum(inputTokens) as cacheShare by purpose, modelId
```

```text
filter event = "http.request" and route like "/api/v1/" | stats pct(latencyMs, 50), pct(dbRoundTrips, 50) by route
```

`dbWaitMs / dbRoundTrips` is the measured Data API round trip: put it into the harness (§3) to replace the
estimate there.

## 3. Measuring locally (the harness)

The whole API runs in one process over a fresh seeded database on the local cluster (port 54329), with the
real app, middleware, turn engine and instrumentation; only the far ends are simulated
(`apps/api/src/perf/simulation.ts`):

| Simulated (profile `production`, an estimate)    | Value             |
| ------------------------------------------------ | ----------------- |
| Data API round trip (statement, begin, commit)   | 20 ms             |
| Nova 2 Lite time to first token, then per word   | 650 ms, then 6 ms |
| Structured call (a streamed reply's annotations) | 1,400 ms          |
| Titan query embedding                            | 90 ms             |
| Polly first audio bytes                          | 180 ms            |

```sh
pnpm --filter @foundry/api latency                       # production profile, 8 typed + 8 spoken turns
pnpm --filter @foundry/api latency --profile local       # what the code itself costs on this machine
pnpm --filter @foundry/api latency --text 10 --voice 10 --json /tmp/latency.json --label "after X"
```

A run signs a founder in, opens the venture and its conversations, types the messages, then starts a call
(the intro is spoken) and talks; every other spoken message asks for a one-sentence reply. The client side is
timed as the browser sees it (in process: no network to the browser), and the server side is read from the
log lines of §2. `apps/api/src/perf/latency.db.test.ts` runs a small scenario in the DB test suite and
checks that every stage is measured, in order, and that the timing lines carry no words of the conversation.

The web app is measured by `apps/web/e2e/web-perf.chat.spec.ts` (Playwright, Chromium, through the e2e
script): a cold load of the founder's New chat over a 40 ms / 20 Mbit/s connection, once as a laptop and once
with the CPU four times slower (a mid-range phone), then the main route transitions with a warm cache. It
writes `test-results/web-perf/<label>-<device>.json`; it asserts only what does not depend on the machine
(no layout shift above 0.1).

## 4. Baseline (1dabb37)

API harness, profile `production`, 10 typed and 10 spoken turns after a warm-up conversation, p50 (p95):

| Flow                            | First sentence | First spoken unit | First audio   | Completed | Round trips |
| ------------------------------- | -------------- | ----------------- | ------------- | --------- | ----------- |
| Typed turn                      | 1,737 (1,764)  |                   |               | 4,013     | 61          |
| Spoken turn                     | 1,874 (1,925)  | 1,925 (3,321)     | 2,563 (3,908) | 3,561     | 64          |
| Spoken turn, one-sentence reply | 1,836          | 3,259             | 3,840         | 3,514     | 64          |

Server stages of a typed turn (p50): accepted at 681 ms (admission transaction 214), retrieval 309 (embedding
91), model start 990, model first token 651, first sentence 1,737; database wait 1,329 ms of 61 round trips.
`POST /speech` for the first unit: checks done at 277 ms, reserved 362, Polly answered 544, first audio 587;
18 round trips (the call intro: 598 ms).

Requests (one each): `GET /me` 244 ms (10 round trips), venture 176 (8), conversations 132 (6), new
conversation 514 (23), conversation 316 (13), call start 507 (21), call end 385 (18).

Requests New chat makes as it opens (measured with the harness after this work; this stream did not change
them): venture overview 427 ms (19 round trips), call config 263 (12), notebook 177 (8), memory 113 (5).

Web, cold load of New chat (median of 5; laptop / phone CPU): first paint 168 / 192 ms (the static boot
screen), app shell 574 / 801, composer 582 / 850, largest paint 584 / 820, layout shift 0.03 / 0.024. Entry
script 678 kB (214 kB compressed) in 78 script files before the composer. The serif face of the vEIR's words
started downloading at 559 / 734 ms, after the app had rendered it. Route transitions (cache warm, first visit
/ again): Knowledge 79 / 10 ms, Documents 53 ms, back to New chat 9 ms (phone: 129 / 43, 75, 39). Landing page,
signed out: ready at 385 ms, layout shift 0.18.

Production numbers: not available to this harness run (no AWS credentials on the build machine); read them
with the queries of §2 once the new fields are deployed.

## 5. What changed, and by how much

Same harness and profile as the baseline, after every change of this stream (p50, p95 in brackets):

| Flow                            | First sentence    | First spoken unit     | First audio                       | Last spoken unit | Round trips |
| ------------------------------- | ----------------- | --------------------- | --------------------------------- | ---------------- | ----------- |
| Typed turn                      | 1,737 → **1,684** |                       |                                   |                  | 61 → 57     |
| Spoken turn                     | 1,874 → 1,826     | 1,925 → 1,826 (1,914) | 2,563 → **2,233** (3,908 → 2,324) | 3,297 → 1,827    | 64 → 60     |
| Spoken turn, one-sentence reply | 1,836 → 1,798     | 3,259 → **1,798**     | 3,840 → **2,222**                 | 3,259 → 1,798    | 64 → 60     |

| Change                                                                                                                                                                                                                                                                         | Where                                                                   | Measured                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A call speaks each validated sentence the moment the sentence gate releases it. Units used to be held until the next one was ready (so the last could be marked `final`): the first waited for the second, the last for the reply's annotations, a whole model call later.     | `orchestrator/generate.ts` (`SpeechStream`, eager for streamed replies) | one-sentence reply first audio 3,840 → 2,222 ms; last spoken unit 3,297 → 1,827 ms                                                                                                                                                                                                              |
| `POST /speech`: the call side of the checks runs in a second transaction alongside the conversation side; the platform spend is read alongside them; the reservation autocommits (one atomic statement); usage ledger, counters and audit are written while the audio streams. | `services/speech.ts`, `orchestrator/guards.ts`                          | first unit's first audio 587 → 404 ms; call intro 598 → 386 ms                                                                                                                                                                                                                                  |
| Retrieval searches the five stores in one statement (identical results, tested).                                                                                                                                                                                               | `db/repositories/retrieval.ts`, `orchestrator/retrieval.ts`             | retrieval 309 → 230 ms; 4 round trips fewer                                                                                                                                                                                                                                                     |
| Index `turns (author_id, created_at)` for the per-person limits (migration 0015).                                                                                                                                                                                              | `0015_turn_admission_index.sql`                                         | 0.65 → 0.02 ms per count at 200,000 turns (EXPLAIN ANALYZE); grows with the table without it                                                                                                                                                                                                    |
| Aurora kept awake at 0.5 ACU (≈ USD 44 a month; 0 restores pausing).                                                                                                                                                                                                           | `infra/cdk/config/production.json`, `data-stack.ts`                     | production only: removes the 15–30 s resume wait of the first request after 10 idle minutes                                                                                                                                                                                                     |
| API Lambda 1,024 → 1,769 MB (one full vCPU).                                                                                                                                                                                                                                   | `production.json`                                                       | production only: the bundle's cold import is CPU-bound (136 ms of CPU on a laptop core); ≈ 1.7x the CPU share                                                                                                                                                                                   |
| Bedrock prompt-cache tokens are metered and logged (`cachedInputTokens`).                                                                                                                                                                                                      | `ai/gateway/nova.ts`, `router.ts`                                       | correctness of the caps; production shows the cache share (§2)                                                                                                                                                                                                                                  |
| React in its own chunk. The build fails when the first load (the entry and every chunk it imports statically, which index.html preloads) exceeds 975 kB.                                                                                                                       | `apps/web/vite.config.ts`, `vite-plugins/page-speed.ts`                 | first load unchanged: 31 files, 957,134 → 957,129 bytes (307.6 → 307.2 kB compressed); only the entry file shrank (678 → 471 kB) because React moved into a chunk the entry preloads. Gain: caching across releases only (a release changes the app chunk, the 219 kB React chunk stays cached) |

## 6. Measured and not kept

| Tried                                                                                          | Result                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<link rel="preload">` for the Latin Geist and Newsreader faces                                | first paint 168 → 276 ms: Chrome holds the first paint while a preloaded font downloads; the composer was no sooner                                                                                                                                                                                   |
| Warming the display face (`document.fonts.load`) and the first page's route chunks at start-up | the landing page 413 → 494 ms and `/me` queued behind the chunks on the local HTTP/1.1 preview; no gain measured                                                                                                                                                                                      |
| Landing and sign-in out of the entry chunk                                                     | landing ready 385 → 462 ms (one more chunk before it can render)                                                                                                                                                                                                                                      |
| Loading the Mantle (Luna) adapter and the OpenAI SDK lazily                                    | API bundle cold import 108 → 112 ms: parsing, not evaluation, dominates                                                                                                                                                                                                                               |
| Removing `motion` from the shell (prototype, not committed)                                    | entry 471 → 344 kB, cold load unchanged within noise                                                                                                                                                                                                                                                  |
| A scheduled warm-up ping of the API Lambda                                                     | not built: a page load fans out into 7–10 parallel requests, each needing its own warm container, and one ping keeps one; its gain needs a production measurement                                                                                                                                     |
| Bedrock latency-optimized inference                                                            | not offered for Nova 2 Lite (Nova Pro, Claude 3.5 Haiku and Llama 3.1 only, checked 2026-10-16). The closest lever is the Priority service tier (`serviceTier: priority`; a third-party price list, unconfirmed by AWS, shows about 75 % more per token): an owner decision, to measure in production |
| Polly output format                                                                            | MP3 at the neural default 24 kHz kept: first bytes depend on synthesis, not on the format                                                                                                                                                                                                             |

## 7. Proposals for the files other streams own (measured or derived)

| Proposal                                                                                                                                                                                                                                                                                                                                                                                                                                       | Owner                                  | Expected gain                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Start the query embedding as soon as the spend caps passed (before the directory lookups and the admission transaction), and read the spend while the preflight runs instead of after it. Prototype measured with this harness: typed first sentence 1,684 → 1,539 ms, retrieval 230 → 117 ms, accepted 694 → 659 ms. The embedding is then bought for a message the admission refuses (rate limit, in-flight limit): about USD 0.000001 each. | `orchestrator/run-turn.ts`             | ≈ 145 ms per turn                                                                                         |
| Read the history, its interruptions and the turn count in a transaction of their own beside the preflight's (5 of its 18 round trips). Two transactions must never wait on each other while holding a connection (a nested wait deadlocked the local pool in the prototype).                                                                                                                                                                   | `orchestrator/run-turn.ts`             | ≈ 100 ms (5 round trips at 20 ms)                                                                         |
| Persist: build the completed turn's view from what was just written instead of reading its evidence and extras back.                                                                                                                                                                                                                                                                                                                           | `orchestrator/run-turn.ts`             | 2 round trips (≈ 40 ms) on completion                                                                     |
| Venture overview: its six memory lists in one statement (`row_number() OVER (PARTITION BY type)`), 19 round trips.                                                                                                                                                                                                                                                                                                                             | `services/ventures.ts`                 | ≈ 100 ms on every New chat                                                                                |
| System prompt: dynamic parts (the control block opens it, then venture, notes, date) after the stable ones (identity, rules, doctrine), so Bedrock's prompt cache serves the long common prefix; the auto-mode section is 964 of the ≈ 4,400 tokens.                                                                                                                                                                                           | `prompts/system.ts`, `turn-prompts.ts` | production only: cached prefixes cut the model's time to first token; `cachedInputTokens` shows the share |
| Annotations (phase B) re-send the whole prompt (≈ 7,500 tokens) to describe one reply.                                                                                                                                                                                                                                                                                                                                                         | `turn-prompts.ts`                      | shorter time to completion and lower cost                                                                 |
| Build the de-identification lexicon's set on first use (39,283 words split and hashed at module load, 10 ms of a 136 ms cold import).                                                                                                                                                                                                                                                                                                          | `ai/distill/lexicon.ts`                | ≈ 25–40 ms per API cold start on Lambda                                                                   |
| Status banners: CSS transitions instead of `motion`.                                                                                                                                                                                                                                                                                                                                                                                           | `components/shell/status-banners.tsx`  | 125 kB (42 kB compressed) less entry script                                                               |
| Landing page: its hero moves as the display face swaps in (layout shift 0.16–0.18: the paragraph, buttons and preview card). Fallback metrics (`size-adjust`) for the serif face, or the italic warmed early.                                                                                                                                                                                                                                  | landing                                | layout shift below 0.1                                                                                    |
| The audit chain's advisory lock is held from a request's `audit()` call to its commit; with more founders at once, transactions that audit wait on each other. Appending the audit last before commit shortens the hold.                                                                                                                                                                                                                       | `db` migrations, services              | under concurrency only                                                                                    |

## 8. What only production can show

- The Data API round trip (`dbWaitMs / dbRoundTrips`), and so the real weight of every round trip saved above.
- Nova 2 Lite's time to first token and the prompt cache's share (`modelFirstTokenMs`, `cachedInputTokens`).
- Cold starts at 1,769 MB, and how often a founder meets one.
- The web app over CloudFront (HTTP/2 and HTTP/3, immutable assets): the local preview is HTTP/1.1 with six
  connections, so it penalises extra chunks that production does not.
- That no request waits for a resume any more: `503 database_resuming` should drop to zero.
