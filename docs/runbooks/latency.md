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
(BeginTransaction, CommitTransaction). A typed turn made **61 such round trips** (baseline; 57 now, a call's 64 → 60), so the
database round trip, not the queries, decides most of the time before the model starts. A Data API transaction
runs one statement at a time (a second statement sent while one runs is refused), so independent reads only
overlap when they are in separate transactions.

## 2. Production baseline (2026-10-16)

The binding numbers: production's own logs and audit for Oct 6–16, read through the **Ops - insights**
workflow (aggregates and identifiers only, no content). One founder, 5 conversations, 12 answered turns (9 on
calls): read them as mechanisms, not statistics.

| Production, p50 (p95)                                         | Value                                                                                              |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Voice turn, server (audit `totalMs`)                          | 8.3 s (9.7 s)                                                                                      |
| First validated words after the turn request (`firstTokenMs`) | 4.4 s (4.7 s)                                                                                      |
| Model time of a turn (both calls)                             | 4.6 s (5.9 s)                                                                                      |
| First audio after the founder's turn (client)                 | 4.6–5.6 s per call (5.4–10.6 s)                                                                    |
| `POST /speech`, per unit                                      | 776 ms (1.1 s)                                                                                     |
| First turn of a call without a replayed opener                | 2 of 2 fell back to a whole reply (`structured_output`): 9.5 and 9.7 s, one spoken unit at the end |
| Prompt of a voice turn                                        | 7.2–8.7 k tokens (13–15 k billed over both calls), 20–22 evidence items                            |
| Output of a turn (both calls)                                 | 550–1,900 tokens, of which a call speaks about 60 words                                            |
| First request after 10 idle minutes                           | 15–20 s (sign-in p95 20.0 s): Aurora resuming                                                      |
| API Lambda                                                    | 11 % cold starts, init 738 ms (913 ms max); duration 354 ms (1.65 s)                               |
| `GET /ventures/:id/memory`                                    | 93 calls in 30 days for one founder; the memory batch 810 ms (3.3 s)                               |

The stage-by-stage fields of §3 (`turn.timing`, `speech.timing`) were not deployed yet when these were read;
re-run the insights workflow after this work deploys.

## 3. Measuring in production (the logs)

The API writes these lines (numbers and identifiers only, never content):

| Event              | Fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http.request`     | `latencyMs` (to the response headers), `authMs` (session check), `dbRoundTrips`, `dbTransactions`, `dbWaitMs` (until the headers), `inflightAtStart` / `inflightMax` (other requests the process served alongside), `awsConnectionsOpened` / `awsConnectionsReused` (AWS HTTPS connections, process-wide deltas)                                                                                                                                                                                                                                                                                                                                                                                                        |
| `turn.timing`      | ms since the request arrived: `acceptedMs`, `modelStartMs`, `firstDeltaMs` (first sentence), `firstSpeechMs` (first spoken unit), `totalMs`; stage durations: `authMs`, `admissionMs`, `retrievalMs` (embedding wait + queries), `embedMs`, `promptMs`, `modelFirstTokenMs`, `generationMs`, `structuredMs`, `finishMs`; the whole turn's `dbRoundTrips`, `dbWaitMs`, `voice`; `embedCalls`, `inflightAtStart`, `inflightMax`, `awsConnectionsOpened`, `awsConnectionsReused`; the turn's model calls: `inputTokens`, `cacheReadInputTokens`, `cacheWriteInputTokens` (Bedrock's prompt cache), and the streamed reply's call (the one `modelFirstTokenMs` measures): `streamInputTokens`, `streamCacheReadInputTokens` |
| `speech.timing`    | ms since the speech request reached the service, cumulative: `verifiedMs`, `plannedMs` (checks), `capsCheckedMs`, `reservedMs`, `synthesizedMs` (Polly answered), `firstAudioMs` (first bytes handed to the response); `characters`. The bookkeeping (ledger, counters, audit) runs while the audio streams                                                                                                                                                                                                                                                                                                                                                                                                             |
| `ai.model.attempt` | per model call: `latencyMs`, `inputTokens`, `cachedInputTokens` and `cacheWriteInputTokens` (read from and written to Bedrock's prompt cache, included in `inputTokens`), `cachePoints` (cache checkpoints the request carried), `outputTokens`, `outcome`                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

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

Prompt caching (below): the streamed reply's time to first token with and without a cache read.

```text
filter event = "turn.timing" and outcome = "completed"
| stats count(*) as turns, pct(modelFirstTokenMs, 50) as ttftP50, pct(modelFirstTokenMs, 95) as ttftP95,
        avg(streamCacheReadInputTokens / streamInputTokens) as cachedShare
  by voice, streamCacheReadInputTokens > 0
```

`dbWaitMs / dbRoundTrips` is the measured Data API round trip: put it into the harness (§4) with
`--set dbRoundTripMs=…` to replace the calibrated figure there.

Connection reuse (LAB-P2: on browser-paced call turns Titan, Bedrock's first token and Polly's first audio were all
slower than on back-to-back turns). The Bedrock and Polly clients share one keep-alive agent per process
(`sharedAwsAgent`, packages/ai), and a call's start opens both connections with free requests while the greeting is
prepared (a Converse the runtime refuses before any model runs, then an InvokeModel of the embedding model with an
empty body, refused the same way, on the same connection: a turn's first Bedrock call is its Titan query embedding;
and `DescribeVoices`). Note: the Bedrock runtime client (SDK 3.1152) speaks HTTP/2 through its own default handler,
which ignores the `httpsAgent` it is given, so its connection is the SDK's HTTP/2 session (kept and reused by the SDK)
and the agent's counts below are Polly's alone. A turn that opened a new connection rather than reusing one shows it:

```text
filter event = "turn.timing" and outcome = "completed"
| stats pct(embedMs, 50), pct(modelFirstTokenMs, 50), avg(awsConnectionsOpened), avg(embedCalls), avg(inflightMax)
  by voice, awsConnectionsOpened > 0
```

### Prompt caching (Bedrock, Nova 2 Lite)

Converse and ConverseStream requests to Nova carry cache checkpoints (`cachePoint`) where the prompt stops being the
same as on the conversation's previous turn (`MODEL_PROMPT_CACHE`, on by default; `off` sends none; the mock and
Luna ignore it). What AWS documents for Nova 2 Lite (prompt-caching user guide and the model card, checked
2026-10-22): explicit caching on Converse and ConverseStream; checkpoints in `system` and `messages` only (not
`tools`); at least 1K tokens before a checkpoint, counted over everything before it; at most 4 checkpoints; at most
20K cached tokens; a 5-minute TTL that every hit resets; usage reports `cacheReadInputTokens` and
`cacheWriteInputTokens` apart from `inputTokens`. The AWS price list bills reads at a quarter of the input rate and
writes at $0 (`pricing.ts`). Nova also caches repeated prefixes on its own (implicit caching, best effort).

- The system prompt opens with what is the same on every turn and in both calls of a turn
  (`buildSystemPromptParts().stable`: identity to notes, ≈ 20,500 characters, ≈ 5.1 k tokens of the seeded voice
  turn's ≈ 8 k); the control block (this turn's risk and crisis flags), the call's field contract, the turn policy
  and the output section follow it. Only the control block moved (policy `fa-coach-policy/2026-10-22.2`); phase A
  edits only what follows the prefix (`answerSystemPrompt`'s `stableChars`). Checkpoint 1 follows the prefix.
- The conversation so far is cached up to its last two founder messages (checkpoints 2 and 3): the earlier one is
  where the previous turn wrote, so the next turn reads its history back up to there.
- Phase B carries its submit tool before the system prompt (Bedrock reads `tools`, then `system`, then `messages`),
  so the two calls of a turn cache separately: each reads what the same call of the previous turn wrote. The first
  turn of a conversation only writes.
- A request Bedrock refuses with its checkpoints (`ValidationException`) is sent once more without them, and that
  process sends none after it (`ai.model.attempt` `kind = cache_retry`): a turn never fails for the cache.

## 4. Measuring locally (the harness)

The whole API runs in one process over a fresh seeded database on the local cluster (port 54329), with the
real app, middleware, turn engine and instrumentation; only the far ends are simulated
(`apps/api/src/perf/simulation.ts`). Profile `production` is calibrated on §2:

| Simulated (profile `production`)                 | Value               | Was (profile `estimate`) |
| ------------------------------------------------ | ------------------- | ------------------------ |
| Data API round trip (statement, begin, commit)   | 45 ms               | 20 ms                    |
| Nova 2 Lite time to first token, then per word   | 2,000 ms, then 5 ms | 650 ms, then 6 ms        |
| Structured call (a streamed reply's annotations) | 2,400 ms            | 1,400 ms                 |
| Titan query embedding                            | 200 ms              | 90 ms                    |
| Polly first audio bytes                          | 200 ms              | 180 ms                   |

Fit, the harness run on the code production ran (d12f634: 1dabb37 plus the instrumentation) against §2:

| Voice turn, p50                   | Harness, calibrated | Production        | Harness, estimate |
| --------------------------------- | ------------------- | ----------------- | ----------------- |
| First validated words             | 4.48 s              | 4.42 s            | 1.87 s            |
| Model time (stream + annotations) | 4.60 s              | 4.65 s            | 2.4 s             |
| Whole turn                        | 7.47 s              | 8.34 s            | 3.56 s            |
| `POST /speech`, first unit        | 1.10 s              | 0.78 s            | 0.59 s            |
| Evidence items / prompt tokens    | 20 / 8.4 k          | 20–22 / 7.2–8.7 k | 20 / 8.4 k        |

One round-trip figure cannot fit both a turn and a speech request (a turn's statements are heavier), so the
harness's whole turn is 10 % short and its speech request 40 % long: read its differences, not its absolute
numbers, and translate them with §2.

```sh
pnpm --filter @foundry/api latency                       # profile production, 8 typed + 8 spoken turns
pnpm --filter @foundry/api latency --duplicate-memory 3  # the venture's latest memory repeated, as production's was
pnpm --filter @foundry/api latency --profile local       # what the code itself costs on this machine
pnpm --filter @foundry/api latency --set dbRoundTripMs=60 --set modelFirstTokenMs=1500   # recalibrate
pnpm --filter @foundry/api latency --text 10 --voice 10 --json /tmp/latency.json --label "after X"
pnpm --filter @foundry/api latency --cold --text 0 --voice 3 --queries   # each turn's round trips before its model call
```

A run signs a founder in, opens the venture and its conversations, types the messages, then starts a call
(the intro is spoken) and talks; every other spoken message asks for a one-sentence reply. The client side is
timed as the browser sees it (in process: no network to the browser), and the server side is read from the
log lines of §3. Each turn also reports its prompt: the evidence items, the evidence block's tokens and the
reply prompt's tokens (the turn audit's `inputTokensEstimate`). `apps/api/src/perf/latency.db.test.ts` runs a
small scenario in the DB test suite and checks that every stage is measured, in order, that a call's turn
reads fewer evidence items, and that the timing lines carry no words of the conversation.

The web app is measured by `apps/web/e2e/web-perf.chat.spec.ts` (Playwright, Chromium, through the e2e
script): a cold load of the founder's New chat over a 40 ms / 20 Mbit/s connection, once as a laptop and once
with the CPU four times slower (a mid-range phone), then the main route transitions with a warm cache, each
with its layout shift. It writes `test-results/web-perf/<label>-<device>.json` and asserts only what does not
depend on the machine (no layout shift above 0.1, on the load or a transition).
`apps/web/e2e/requests.chat.spec.ts` counts the API reads of a conversation (New chat, three turns, Knowledge
and back) and fails when a turn reads again what a turn does not change.

## 5. Before and after

Calibrated harness, the code production ran (d12f634) against this branch, 8 typed and 8 spoken turns after a
warm-up, `--duplicate-memory 3`, p50 (p95):

| Flow                            | First sentence | First spoken unit | First audio                       | Last spoken unit | Completed     | Round trips |
| ------------------------------- | -------------- | ----------------- | --------------------------------- | ---------------- | ------------- | ----------- |
| Typed turn                      | 4,234 → 4,056  |                   |                                   |                  | 7,791 → 7,597 | 61 → 57     |
| Spoken turn                     | 4,484 → 4,264  | 4,667 → 4,265     | 5,766 → **4,996** (8,181 → 5,128) | 6,934 → 4,265    | 7,466 → 7,308 | 64 → 60     |
| Spoken turn, one-sentence reply | 4,443 → 4,264  | 6,892 → **4,264** | 7,997 → **4,939**                 | 6,892 → 4,264    | 7,460 → 7,294 | 64 → 60     |

| Prompt, p50             | Typed turn    | Spoken turn       |
| ----------------------- | ------------- | ----------------- |
| Evidence items          | 20 → 18       | 20 → **10**       |
| Evidence block (tokens) | 1,975 → 1,796 | 1,920 → **992**   |
| Reply prompt (tokens)   | 8,466 → 8,306 | 8,356 → **7,298** |

Server stages (spoken turn, p50): retrieval 680 → 504 ms, model start 2,295 → 2,119 ms. `POST /speech`, first
unit's first audio 1,101 → 678 ms; the call intro 1,095 → 687 ms. Requests (one each, unchanged by this work):
`GET /me` 477 ms (10 round trips), venture 379 (8), conversations 292 (6), overview 916 (19), notebook 382 (8),
memory 249 (5), call config 576 (12), new conversation 1,086 (23), call start 1,076 (22), call end 862 (18).

Web, cold load of New chat (laptop / phone CPU): first paint 176 / 192 ms (the static boot screen), composer
621 / 820 ms, layout shift 0.03 / 0.024; route transitions with a warm cache: Knowledge 79 / 128 ms,
Documents 57 / 71, Knowledge again 15 / 37, New chat 11 / 34, each with a layout shift of 0. The first load
fetches 31 script files, 957 kB (307 kB compressed), the same before and after (only the entry file changed:
React moved into a chunk it preloads). Landing page, signed out: ready at about 420 ms, layout shift 0.18
(§7).

| Change                                                                                                                                                                                                                                                                         | Where                                                                            | Measured (harness, calibrated)                                                                                                                                                           | In production terms (§2)                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A call speaks each validated sentence the moment the sentence gate releases it (units used to wait for the next one, the last for the annotations), and says nothing after the reply's last sentence: a narrowed answer's note stays in the transcript.                        | `orchestrator/generate.ts` (`SpeechStream`)                                      | first audio 5,766 → 4,996 ms (p95 8,181 → 5,128); one-sentence reply 7,997 → 4,939; last spoken unit 6,934 → 4,265                                                                       | the founder hears a one-sentence reply about 3 s sooner, and a reply's last sentence a whole annotation call (≈ 2 s) sooner                                |
| A first reply the model writes as structured output (JSON, `Answer:` labels) streams its reply field, and the model stops when it ends; a reply that runs on into the mode name and claims ends there.                                                                         | `orchestrator/reply-extract.ts`, `generate.ts`                                   | tests (`turn-engine.db.test.ts`): spoken sentence by sentence before the annotations, no whole-reply call                                                                                | the first turn of a call without an opener: 9.5–9.7 s with one unit at the end → streamed like any turn (first words ≈ 4.3 s)                              |
| A call's reply stops once all that can be said (70 words) was said; the annotations call is bounded at 2,000 output tokens (was 4,096).                                                                                                                                        | `orchestrator/generate.ts`                                                       | tests; the harness's replies are short, so no change shows there                                                                                                                         | production's voice answers were ≈ 140 words (p95 ≈ 250) for 70 spoken: ≈ 70–180 words less to write and annotate per call turn                             |
| `POST /speech`: the call side of the checks runs in a second transaction alongside the conversation side; the platform spend is read alongside them; the reservation autocommits (one atomic statement); usage ledger, counters and audit are written while the audio streams. | `services/speech.ts`, `orchestrator/guards.ts`                                   | first unit's first audio 1,101 → 678 ms; call intro 1,095 → 687 ms                                                                                                                       | `POST /speech` p50 776 ms → about 480 ms (same ratio)                                                                                                      |
| Retrieval searches the five stores in one statement (identical results, tested).                                                                                                                                                                                               | `db/repositories/retrieval.ts`, `orchestrator/retrieval.ts`                      | retrieval 680 → 504 ms; 4 round trips fewer                                                                                                                                              | ≈ 180 ms before every model start                                                                                                                          |
| A call's turn reads at most 13 evidence items (memory 6, documents 3, library 2, resources 1, patterns 1; typed turns keep 24), and an item that repeats a higher-ranked one takes no slot (the next distinct one does).                                                       | `orchestrator/retrieval.ts`, `evidence.ts`; one line in `run-turn.ts`            | call prompt 8,356 → 7,298 tokens, evidence 1,920 → 992 tokens; typed evidence 1,975 → 1,796                                                                                              | ≈ 1 k fewer input tokens in each of a call turn's two model calls (≈ 2 k billed per turn); time to first token, production only                            |
| Index `turns (author_id, created_at)` for the per-person limits (migration 0015).                                                                                                                                                                                              | `0015_turn_admission_index.sql`                                                  | 0.65 → 0.02 ms per count at 200,000 turns (EXPLAIN ANALYZE); grows with the table without it                                                                                             | none today; keeps admission flat as turns accumulate                                                                                                       |
| Aurora was held at 0.5 ACU (`aurora.minCapacityAcu: 0.5`, ≈ USD 44 a month). **Reverted 2026-10-17** at the owner's request: it pauses again, after 30 idle minutes (USD 0 while paused, ≈ USD 0.06 an hour in use).                                                           | `infra/cdk/config/production.json`, `data-stack.ts`                              | production only                                                                                                                                                                          | removed the 15–20 s wait of the first request after an idle pause (sign-in p95 20 s); since the revert that wait comes back after 30 idle minutes (was 10) |
| API Lambda 1,024 → 1,769 MB (one full vCPU).                                                                                                                                                                                                                                   | `production.json`                                                                | the bundle's cold import is CPU-bound (136 ms of CPU on a laptop core)                                                                                                                   | cold-start init 738 ms → expected ≈ 450 ms (≈ 1.7× the CPU share); 11 % of requests met one                                                                |
| Bedrock prompt-cache tokens are metered and logged (`cachedInputTokens`).                                                                                                                                                                                                      | `ai/gateway/nova.ts`, `router.ts`                                                | correctness of the caps                                                                                                                                                                  | shows the cache share (§3)                                                                                                                                 |
| A finished turn refreshes only what a turn changes (memory, overview, venture, escalations, conversations); the memory list and the overview stay fresh 5 minutes.                                                                                                             | `apps/web/src/lib/api/venture-refresh.ts`, hooks; one line in `create-engine.ts` | New chat, three turns, Knowledge and back: 42 → 36 API reads (call settings 4 → 1, documents 4 → 1); a return to the tab within 5 minutes reads neither the memory list nor the overview | fewer of the 93 memory reads (the review UI's own reads go with that UI); each saved overview read is 19 round trips                                       |
| React in its own chunk. The build fails when the first load (the entry and every chunk it imports statically, which index.html preloads) exceeds 975 kB.                                                                                                                       | `apps/web/vite.config.ts`, `vite-plugins/page-speed.ts`                          | first load unchanged: 31 files, 957,134 → 957,129 bytes (307.6 → 307.2 kB compressed); only the entry file shrank (678 → 471 kB)                                                         | caching across releases only: a release changes the app chunk, the 219 kB React chunk stays cached                                                         |

### The first turn a process serves (2026-10-31)

Lab face run 41235680528 (GitHub runner, the dev server on real Bedrock): the run's first spoken turn started its model
call 856 ms after the request (retrieval 394 ms, Titan 375 ms), the next four at 198–312 ms (retrieval 131–262 ms);
first speech 1,941 ms against 1,110–1,609 ms. Turns 3 and 4 were the first turns of two new calls and were as fast as
the rest, so the cost belongs to the process, not to the call or its conversation: nothing per call (persona, notes,
history, policy) was slow to load.

Reproduced on the harness (`latency --cold`, which skips the warm-up conversation): a fresh process's first spoken turn
starts its model call at ~280 ms against ~15 ms for every later turn and for a second call's first turn (profile
local; profile production: 2,272 against ~2,095 ms, the same ~180 ms on top of the simulated round trips). Stage by
stage (profile local, first turn against later ones): the risk classifier 95 ms (its first call, on the message alone)
and 85 ms (its second, with the other ventures' names) against 0.2 ms; building the sentence gate 73 ms against
0.5 ms; reading the stream's first sentences ~40 ms against ~2 ms. The preflight, admission, retrieval and prompt
assembly were within a few ms of a warm turn, and the AWS SDK's own first send costs ~10 ms (measured on a local
stand-in). The cost is V8 compiling the regular expressions of the classifier's rules and of the gate's identity and
craft checks the first time they run, and again to machine code the second time.

The turn engine is warmed before the call's first turn needs it (`packages/core/src/orchestrator/warm-up.ts`): the
same functions run on synthetic text, in steps of a few milliseconds that each give the event loop back. It reads and
writes nothing, calls no model and keeps no state of a call; the prompt, the classification and the gate's output are
byte for byte the same with and without it (`warm-up.test.ts`).

- **When the process starts** (`apps/api/src/runtime/warm-up.ts`, `api.init_warm_up` `outcome`, `ms`): in the API
  Lambda's init phase (`handlers/api.ts`, before the container takes its first request) and in the dev server before it
  listens; it waits at most 3 s and a warm-up that fails or runs over never fails the start. ~485 ms wall, ~515 ms CPU
  on this machine (Node 24); a Lambda CPU may be slower.
- **The call screen and the call start** only check it (memoized: ~0.01 ms) and warm the call's own guard names
  (`POST /sessions/:id/calls` once the greeting is ready: ~10 ms), after the response; a warm-up that fails or never
  ends leaves the call starting as before (`call-warm-up.db.test.ts`). Logged as `call.turn_warm_up` (`ms`).

Why not after a response only (the first version of this change): on Lambda, work after the response runs in the
invocation's drain, and a container that is draining takes no other request, so the call screen's next requests went
to another container, perhaps a cold one. On the single-process harness the same work showed as contention on the
requests that followed the call screen (below). The cost moves to a container's cold start: init grows by the
warm-up's ~0.5 s, paid by whichever request met the cold start (§2: 11 % of requests, init 738 ms), and no turn on any
container pays the first-run cost. §8 lists what to read in production to confirm the trade.

V8 discards a regular expression's compiled code when it goes unused through a few major garbage collections (Node 24:
3 organic major GCs, or 2 forced ones; the classifier's patterns then cost ~100 ms again; `--no-flush-bytecode` and
`--bytecode-old-age` do not change it). A memoized warm-up therefore times one run of the classifier's longest pattern
(`turnEngineLooksCold`: ~0.01 ms warm, 3-9 ms cold) and warms again when it went cold. The harness saw no major GC in a
whole founder flow (8 turns and 13 other requests, heap ~106 MB), so a re-warm is rare.

| `latency --cold --text 0 --voice 4`, the call's first turn (later turns unchanged) | Before | After |
| ---------------------------------------------------------------------------------- | ------ | ----- |
| Profile local: model start                                                         | 285 ms | 27 ms |
| Profile local: first spoken unit (`turn.speech`)                                   | 329 ms | 35 ms |
| Profile local: first audio bytes (client)                                          | 444 ms | 52 ms |
| Profile production: model start                                                    | 2,272  | 2,102 |
| Profile production: first audio bytes (client)                                     | 5,141  | 4,932 |
| Profile local: the call intro's `/speech` (the warm-up runs beside it)             | 9 ms   | 25 ms |

Warm-up at process start against warm-up after the call screen's response (the first version), `latency --cold
--text 0 --voice 3`, 3 runs each, profile local, ms (both versions also warm the call's guard names at call start):

| Request (the call screen's, in order)       | After the call screen's response | At process start |
| ------------------------------------------- | -------------------------------- | ---------------- |
| `GET call-config`                           | 7–8                              | 3                |
| `POST sessions` (×2, right after)           | 119–261                          | 15–25            |
| `GET sessions/:id`                          | 41–61                            | 2                |
| Call start                                  | 12–13                            | 12               |
| The call intro's `/speech`                  | 26                               | 26–27            |
| The call's first turn: model start          | 28                               | 26–31            |
| The call's first turn: first audio (client) | 55–56                            | 53–59            |

The intro's `/speech` stays at ~26 ms on profile local because the call start's warm-up of the call's guard names (the
gate compiles a few patterns per name) runs beside it: without that step it is 9–10 ms and the first turn's first audio
67–74 ms; started while the greeting is prepared instead, the call start takes 30 ms and the intro 9 ms. On profile
production both are the same within 3 ms (the greeting's database round trips leave the CPU idle), so the step stays
where it was.

### What a call's turns read before the model (2026-10-31)

`latency --profile production --cold --text 0 --voice 3 --queries` lists each turn's round trips before its model
call by statement. A spoken turn makes 44–46 before its model starts, in this order (the second turn of a call, ms
since the request; a transaction runs one statement at a time):

| Stage                 | Round trips (sequential)                                                                                                                                                             | Same for the whole call                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Idempotency key       | 1                                                                                                                                                                                    | no                                                                                |
| Preflight transaction | 16: begin, context, session, access, settings, assignment, release, history (2), interruptions, **presence, founder, notes, earlier conversations**, turn count, **venture**, commit | the 5 in bold depend only on the conversation's keys; the rest are checks or live |
| Spend caps            | 2 (global, then the person's)                                                                                                                                                        | no (live)                                                                         |
| Admission transaction | 13: lock, session lock, in-flight, call, settings, call seconds, voice count, call turns, spend cap, the turn, audit                                                                 | no (live, atomic by design)                                                       |
| Query embedding       | Titan, then 1 (usage ledger)                                                                                                                                                         | no                                                                                |
| Retrieval transaction | 5 (with "Where you left off", 5, beside it)                                                                                                                                          | the left-off reads are, and already run beside it                                 |

So 5 of the ~38 round trips on the critical path before the model are the same for the whole call; the rest are
authorization, limits and live state, which a per-call cache must not answer. A cache of their results could not be
trusted on Lambda without a round trip to check it (a note is changed by the distillation worker, another Lambda), so
the turn reads them, but beside its checks instead of after them (`packages/core/src/orchestrator/turn-context.ts`):
the process remembers each conversation's keys (tenant, person, conversation, venture, persona, the assignment's EIR,
privacy), from the call's start and from every turn's preflight, and a turn whose keys are known starts those five
reads at once in a transaction of their own. The preflight uses them when its own authorization reads resolve to the
same keys, and waits for them only after its transaction has ended (a transaction holding a connection never waits on
another that needs one). Keys that changed, an unknown conversation or a prefetch that failed fall back to reading
them as before. Logged as `turn.context` (`source`: `prefetched`, `read`, `keys_changed`, `prefetch_failed`, and
`unused` for a turn that ended before it reached the reads: refused, replayed, its conversation gone).

The prefetch's transaction never outlives its turn. Whatever became of the turn, runTurn hands that transaction to the
host's after-response work, which the API Lambda drains before the invocation returns (`afterResponse` ->
`InflightTracker`), so a frozen container never holds a Data API transaction open into a later invocation; without a
host hook (tests) the turn waits for it. A refusal is therefore not held up by it, and a turn that used the reads has
already waited for them.

Nothing but the keys is remembered, so a note written mid-call is in the next turn's prompt, and both paths run the
same reads (`readTurnContext`), so the prompt is byte for byte the same (`turn-context.db.test.ts`: identical prompts
with and without the prefetch, a note written between two turns, changed keys, a failed prefetch, a call's first turn,
and the prefetch's transaction ended, or handed to the host, when a refused or completed turn returns).

| `latency --cold --text 0 --voice 3`, 2 runs, profile production, ms | Before (6eefa05 + d06c2fd) | After           |
| ------------------------------------------------------------------- | -------------------------- | --------------- |
| The call's first turn: model start                                  | 2,015–2,022                | 1,774–1,781     |
| The call's first turn: first spoken unit                            | 4,177–4,181                | 3,933–3,942     |
| The call's first turn: first audio (client)                         | 4,848–4,857                | 4,608–4,617     |
| Later turns: model start                                            | 2,098–2,102                | 1,860–1,869     |
| Later turns: first audio (client)                                   | 4,817–4,938                | 4,577–4,704     |
| The call start, its intro's `/speech`, `call-config`                | 1,707, 680, 572            | 1,702, 679, 568 |

The preflight's chain goes from 16 round trips to 11 with an 8-round-trip transaction beside it: ~235 ms on every turn
whose conversation the process knows (a call's first turn on the container that started it, and every later turn
served by a container that served one before), at the Data API's ~45 ms a round trip. Locally (no simulated round
trip) the change is within noise (first turn 26–31 ms, later turns 15–17 ms).

## 6. Measured and not kept

| Tried                                                                                                                 | Result                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<link rel="preload">` for the Latin Geist and Newsreader faces                                                       | first paint 168 → 276 ms: Chrome holds the first paint while a preloaded font downloads; the composer was no sooner                                                                                                                                                                                                                                                                            |
| Preloading the italic display face (the landing headline's "remembers")                                               | landing layout shift 0.179 → 0.174, first paint 172 → 288 ms                                                                                                                                                                                                                                                                                                                                   |
| Local serif fallback faces sized like Newsreader (`size-adjust`, ascent/descent overrides, within 0.7 % of its width) | landing layout shift 0.179 → 0.162: the 80 px headline still sets 6 lines in the fallback and 5 in Newsreader (§7); New chat 0.030 → 0.024, within noise                                                                                                                                                                                                                                       |
| Warming the display face (`document.fonts.load`) and the first page's route chunks at start-up                        | the landing page 413 → 494 ms and `/me` queued behind the chunks on the local HTTP/1.1 preview; no gain measured                                                                                                                                                                                                                                                                               |
| Landing and sign-in out of the entry chunk                                                                            | landing ready 385 → 462 ms (one more chunk before it can render)                                                                                                                                                                                                                                                                                                                               |
| Loading the Mantle (Luna) adapter and the OpenAI SDK lazily                                                           | API bundle cold import 108 → 112 ms: parsing, not evaluation, dominates                                                                                                                                                                                                                                                                                                                        |
| Removing `motion` from the shell (prototype, not committed: the shell is another stream's)                            | first load 957 → 832 kB (entry 471 → 344 kB), cold load on the local preview unchanged within noise (§7)                                                                                                                                                                                                                                                                                       |
| A scheduled warm-up ping of the API Lambda                                                                            | not built: a page load fans out into 7–10 parallel requests, each needing its own warm container, and one ping keeps one; its gain needs a production measurement                                                                                                                                                                                                                              |
| Caching the call intro's audio                                                                                        | not built: a call's intro is synthesized once (a second request is refused as already played), so a per-call cache never hits; across calls the intro's words differ (name, where you left off), and the audio would have to reach whichever Lambda serves `POST /speech`. Polly is 200 of the intro's 687 ms; the rest is the checks, which this work cut from 1,095 ms                       |
| A lower token limit on a call's reply (instead of stopping at the spoken budget)                                      | not kept: a reply cut by the limit ends mid-sentence in the transcript; stopping once 70 words were said ends on the sentence the budget ran out in                                                                                                                                                                                                                                            |
| Bedrock latency-optimized inference                                                                                   | not offered for Nova 2 Lite (Nova Pro, Claude 3.5 Haiku and Llama 3.1 only, checked 2026-10-16). The closest lever is the Priority service tier (`serviceTier: priority`; a third-party price list, unconfirmed by AWS, shows about 75 % more per token): an owner decision, to measure in production                                                                                          |
| Polly output format                                                                                                   | MP3 at the neural default 24 kHz kept: first bytes depend on synthesis, not on the format                                                                                                                                                                                                                                                                                                      |
| Warming the turn engine at the start of every turn, beside its own database waits                                     | not kept: profile production's first turn 2,272 → 2,177 ms, but profile local's 284 → 381 ms (the warm-up competes with a turn whose database answers at once); the call screen and the call start warm it instead                                                                                                                                                                             |
| A per-call cache of the turn's context (persona, notes, policy), prebuilt at call start                               | not built as a cache of results: 5 of the ~38 round trips before the model are the same for the whole call (§5, "What a call's turns read before the model"), but on Lambda a cached note could be stale (the distillation worker writes it in another process) unless a round trip checks it; the turn reads them beside its checks instead, which saves the same ~235 ms and cannot be stale |

## 7. Proposals for the files other streams own (measured or derived)

| Proposal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Owner                                                       | Expected gain                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Replay the call's spoken intro as the vEIR's first message when a conversation has no opener (`openerMessages(intro)` in `assembleContext`). Why the first turn of a call fell back in production: with no reply of the vEIR's in the conversation, the model followed the turn rules' description of the whole response (both opener-less first turns fell back; the one with a replayed opener and all 7 later turns streamed). The extractor now streams such a reply anyway; this removes the cause, and the vEIR would also know it already greeted the founder. | `context-budget.ts` / `run-turn.ts` (w4-memory: call intro) | fewer structured first replies; no second greeting                                                        |
| `run-turn.ts`: drop the closing `SPOKEN_NARROWING_CAVEAT` passed to `speech.finish` and its comment ("and a caveat when the answer was narrowed"): a streamed reply's speech says nothing after its last sentence now.                                                                                                                                                                                                                                                                                                                                                | `orchestrator/run-turn.ts`                                  | clarity only                                                                                              |
| Start the query embedding as soon as the spend caps passed (before the directory lookups and the admission transaction), and read the spend while the preflight runs instead of after it. Prototype measured with this harness (profile `estimate`): typed first sentence 1,684 → 1,539 ms, retrieval 230 → 117 ms, accepted 694 → 659 ms. The embedding is then bought for a message the admission refuses (rate limit, in-flight limit): about USD 0.000001 each.                                                                                                   | `orchestrator/run-turn.ts`                                  | ≈ 145 ms per turn                                                                                         |
| Read the history, its interruptions and the turn count in a transaction of their own beside the preflight's (5 of its 18 round trips). Two transactions must never wait on each other while holding a connection (a nested wait deadlocked the local pool in the prototype).                                                                                                                                                                                                                                                                                          | `orchestrator/run-turn.ts`                                  | ≈ 100 ms (5 round trips at 20 ms)                                                                         |
| Persist: build the completed turn's view from what was just written instead of reading its evidence and extras back.                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `orchestrator/run-turn.ts`                                  | 2 round trips (≈ 40 ms) on completion                                                                     |
| Venture overview: its six memory lists in one statement (`row_number() OVER (PARTITION BY type)`), 19 round trips.                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `services/ventures.ts`                                      | ≈ 100 ms on every New chat                                                                                |
| System prompt: dynamic parts (the control block opens it, then venture, notes, date) after the stable ones (identity, rules, doctrine), so Bedrock's prompt cache serves the long common prefix; the auto-mode section is 964 of the ≈ 4,400 tokens.                                                                                                                                                                                                                                                                                                                  | `prompts/system.ts`, `turn-prompts.ts`                      | production only: cached prefixes cut the model's time to first token; `cachedInputTokens` shows the share |
| Annotations (phase B) re-send the whole prompt (≈ 7,500 tokens) to describe one reply.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `turn-prompts.ts`                                           | shorter time to completion and lower cost                                                                 |
| Build the de-identification lexicon's set on first use (39,283 words split and hashed at module load, 10 ms of a 136 ms cold import).                                                                                                                                                                                                                                                                                                                                                                                                                                 | `ai/distill/lexicon.ts`                                     | ≈ 25–40 ms per API cold start on Lambda                                                                   |
| The audit chain's advisory lock is held from a request's `audit()` call to its commit; with more founders at once, transactions that audit wait on each other. Appending the audit last before commit shortens the hold.                                                                                                                                                                                                                                                                                                                                              | `db` migrations, services                                   | under concurrency only                                                                                    |
| Status banners: CSS transitions instead of `motion` (the only importer of `motion`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `components/shell/status-banners.tsx` (w4-theme)            | first load 957 → 832 kB (125 kB, 42 kB compressed, less script to parse before the first paint)           |
| Landing page: the 80 px headline (leading 1.0, `text-balance`) sets 6 lines in the fallback serif and 5 in Newsreader, so when the display face arrives (about 5 ms after the first render locally) the paragraph, buttons and preview card move up 88 px: layout shift 0.16–0.18. Preloading either face or sizing the fallback like Newsreader does not change the line count (§6); reserve the headline's height (a minimum of its 5-line height at each breakpoint) or set it in the sans face until the serif has loaded.                                        | landing (w4-theme)                                          | layout shift 0.18 → below 0.02                                                                            |

### Taken up at integration (wave 4)

- **Done:** status banners fade with CSS instead of `motion`: first-load script 957,559 → 830,829 bytes
  (gzip 308,434 → 266,832); the first-load budget is now 860,000 bytes, so `motion` coming back fails the build.
- **Already done on the merged tree:** nothing is spoken after a streamed reply (`generate.ts`, this stream);
  "Where you left off" loads in its own transaction alongside the embedding and retrieval (`run-turn.ts`,
  w4-memory); the lexicon's word set is built on first use (`isEnglishWord`).
- **Not taken:**
  - starting the embedding before admission: it would buy a model call for a message the rate or in-flight
    limit then refuses, which the turn engine deliberately never does;
  - history in a parallel transaction (the prototype deadlocked the pool), the persisted view and the overview's
    single statement (estimates, not measured), the prompt reordering and phase B's shorter prompt (production
    only), the audit lock (concurrency only);
  - replaying the generic call intro as the first message: the call's opener is already replayed when there is
    one, and a first reply written as structured output now streams anyway;
  - the landing headline's layout shift (0.16–0.18, reported, not asserted): reserving the fallback's taller
    height leaves a blank line once the display face loads; open for the landing page's owner.

## 8. What only production can show

- Whether the first turn of every call now streams: `turn.completed` audits with `stream = structured_output`
  should be rare, and notes `stream_structured_json` / `stream_structured_labelled` show the replies the
  extractor took out of structured output (§7 proposes removing the cause).
- How much a 1 k-token smaller prompt shortens Nova 2 Lite's time to first token on a call
  (`modelFirstTokenMs` by `voice`).
- The Data API round trip (`dbWaitMs / dbRoundTrips`), and so the real weight of every round trip saved above.
- Nova 2 Lite's time to first token with and without a cache read, and the cache's share of the streamed reply's
  prompt (`modelFirstTokenMs`, `streamCacheReadInputTokens`, `streamInputTokens`; the query in §3).
- Cold starts at 1,769 MB, and how often a founder meets one.
- What the process-start warm-up costs a cold start and gives a call's first turn: the REPORT lines' `Init Duration`
  before and after the deploy, `api.init_warm_up` `ms` and `outcome`, and `turn.timing` `modelStartMs` of each call's
  first turn against its later turns. And whether the Titan prewarm brings the first turn's `embedMs` down to the
  later turns' (a lab face run shows both).
- How often a turn finds its conversation's keys (`turn.context` `source = prefetched` against `read`), and so how
  often a call's turns land on a container that served the call before.
- Not taken here, live state on the turn's critical path that could still overlap (each one round trip, ~45 ms): the
  two spend reads run one after the other; the admission reads the platform settings the preflight read a second
  earlier; the query embedding's usage-ledger insert is awaited before retrieval starts.
- The web app over CloudFront (HTTP/2 and HTTP/3, immutable assets): the local preview is HTTP/1.1 with six
  connections, so it penalises extra chunks that production does not.
- How often someone meets a resume now that Aurora pauses after 30 idle minutes (was 10), and how much of it
  the page-open wake hides: `db.wake` lines (`outcome: resuming` = a page open started a resume), then
  `http.request` lines with a `dbWaitMs` above 10 s and `503 database_resuming`. Keeping it awake
  (`aurora.minCapacityAcu: 0.5`, about USD 44 a month) removes them; see
  [cost controls](cost-controls.md#aurora-paused-when-idle) for the trade-off.
