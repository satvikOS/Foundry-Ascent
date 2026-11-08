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
request ─ session check ─ preflight (one transaction, two statements: the conversation and what its checks read,
          then the history; the Idempotency-Key reserved and the vEIR's notes read beside it)
        ─ admission (one transaction, three statements: the locks, every limit and the spend caps, the pending turn
          with its audit) ─ turn.accepted (the stream opens)
        ─ query embedding (Titan), retrieval's transaction opening beside it ─ retrieval (one statement)
        ─ prompt ─ model (Nova 2 Lite, streamed) ─ first sentence through the sentence gate ─ turn.delta
        …  annotations ─ validation ─ persist
```

On a call the first validated sentence is also a signed `turn.speech` unit, which the server reserves and voices at
once (ElevenLabs, Polly when it fails) and streams as `turn.audio` PCM frames in the same response; the browser plays
them as they arrive (§5, "Speech inside the turn stream"). Units the server does not voice go to `POST /speech`.

In production every database statement is an HTTPS call to the RDS Data API, and a transaction adds two more
(BeginTransaction, CommitTransaction). A typed turn made **61 such round trips** (baseline; 43 now, a call's 64 → 46), so the
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

| Event              | Fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http.request`     | `latencyMs` (to the response headers), `authMs` (session check), `dbRoundTrips`, `dbTransactions`, `dbWaitMs` (until the headers), `inflightAtStart` / `inflightMax` (other requests the process served alongside), `awsConnectionsOpened` / `awsConnectionsReused` (AWS HTTPS connections, process-wide deltas)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `turn.timing`      | ms since the request arrived: `acceptedMs`, `modelStartMs`, `firstDeltaMs` (first sentence), `firstSpeechMs` (first spoken unit), `totalMs`; stage durations: `authMs`, `admissionMs`, `retrievalMs` (embedding wait + queries), `embedMs`, `promptMs`, `modelFirstTokenMs`, `generationMs`, `structuredMs`, `finishMs`; the whole turn's `dbRoundTrips`, `dbWaitMs`, `voice`; `embedCalls`, `inflightAtStart`, `inflightMax`, `awsConnectionsOpened`, `awsConnectionsReused`; the turn's model calls: `inputTokens`, `cacheReadInputTokens`, `cacheWriteInputTokens` (Bedrock's prompt cache), and the streamed reply's call (the one `modelFirstTokenMs` measures): `streamInputTokens`, `streamCacheReadInputTokens` ; a call's spoken turn adds the browser's end-of-speech decision (sent with the request, §5 "End of speech"): `endpointMs` (quiet after the last voiced frame when the turn was sent), `endpointWaitMs` (the quiet required), `endpointReason`, `endpointResumed` (times the line was taken back) |
| `speech.timing`    | `route` (`request`: `POST /speech`; `turn`: voiced in the turn stream, ms since the unit was written); ms since the speech request reached the service, cumulative: `verifiedMs`, `plannedMs` (checks), `capsCheckedMs`, `reservedMs`, `synthesizedMs` (Polly answered), `firstAudioMs` (first bytes handed to the response); `characters`. The bookkeeping (ledger, counters, audit) runs while the audio streams                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ai.model.attempt` | per model call: `latencyMs`, `inputTokens`, `cachedInputTokens` and `cacheWriteInputTokens` (read from and written to Bedrock's prompt cache, included in `inputTokens`), `cachePoints` (cache checkpoints the request carried), `outputTokens`, `outcome`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

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

### Prompt caching (Bedrock: the Claude Haiku 4.5 coach, Nova 2 Lite)

Converse and ConverseStream requests carry cache checkpoints (`cachePoint`) where the prompt stops being the
same as on the conversation's previous turn (`MODEL_PROMPT_CACHE`, on by default; `off` sends none; the mock and
Luna ignore it), for the models whose cache rates `pricing.ts` carries (`nova.ts` `usesCachePoints`): Nova and, since
the coach moved to it (ADR-0022), Claude Haiku 4.5.

What AWS documents for Claude Haiku 4.5 (its Bedrock model card, checked 2026-11-06): explicit caching on Converse and
ConverseStream; checkpoints in `system`, `messages` and `tools`; at least **4,096 tokens** before a checkpoint (a
shorter prefix is simply not cached: no error, no write); at most 4 checkpoints; a 5-minute TTL (1 hour on request,
not used). Prices (AWS price list, us-east-1, the `us.` profile): input $1.10, cache write $1.375, cache read $0.11
per million (`pricing.ts`). Bedrock reads `tools`, then `system`, then `messages`, so phase B's checkpoint after the
system prefix also caches its tool. Thomas's unchanging prefix is about 18,000 characters, about 4,500 tokens at four
characters a token (Claude's tokenizer counts more), so it caches on its own; a much shorter persona would cache only
from the conversation's checkpoints on. Measured with the real gateway and a stand-in for Bedrock's cache
(`packages/core/src/orchestrator/prompt-cache-hit-rate.test.ts`: the Thomas release, eight voice turns 20 s apart,
both calls of each turn): the first turn writes (each call its own prefix), and from the second turn on **0.88 of
phase A's and 0.87 of phase B's input is read from the cache** (0.77 over the eight turns); a turn whose own part
changes (a flagged topic) reads back the system prefix alone, and so does the next one. The meter prices those tokens
at the cache rates: USD 0.059 for the eight turns against USD 0.132 uncached (55 % less). A conversation idle for over
5 minutes writes again. Nova, below: What AWS documents for Nova 2 Lite (prompt-caching user guide and the model card, checked
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
pnpm --filter @foundry/api latency --text 2 --voice 6 --queries --face  # calls with a FULL face; round trips in sequence
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

### Round trips before the stream and the first spoken unit (2026-10-31)

On the Data API a transaction runs one statement at a time and every statement, begin and commit is one HTTPS call
(~65 ms in production: `dbWaitMs / dbRoundTrips`), so what a turn waits for before the founder hears anything is the
number of round trips it makes **one after another**, not the number it makes. A spoken turn made 30 of them before
its stream opened and 35 before its first spoken unit (39 with a FULL face): ~2.3 s of database before the stream at
production's round trip. Now 10 and 13 (14 with a FULL face): at ~65 ms a round trip, the stream opens ~1.3 s sooner
and the first spoken unit ~1.4 s sooner (~1.6 s with a FULL face).

| Round trips waited for one after another (`latency --queries`), voice turns, p50 | Before  | After   |
| -------------------------------------------------------------------------------- | ------- | ------- |
| To the stream opening (`turn.accepted`), without a face                          | 30      | 10      |
| To the first spoken unit (`turn.speech`), without a face                         | 35      | 13      |
| To the stream opening, FULL face                                                 | 30      | 10      |
| To the first spoken unit, FULL face                                              | 39      | 14      |
| Typed turn: to the stream opening / to the first sentence                        | 27 / 32 | 10 / 13 |

| Profile production (45 ms a round trip), 6 voice turns after a warm-up, ms, p50 (p95) | Before        | After         |
| ------------------------------------------------------------------------------------- | ------------- | ------------- |
| Stream opening (response headers), without a face                                     | 1,390 (1,527) | 467 (606)     |
| First spoken unit (`turn.speech`), without a face                                     | 3,896 (4,041) | 2,840 (2,930) |
| First audio bytes (client), without a face                                            | 4,609 (4,704) | 3,520 (3,595) |
| Stream opening, FULL face                                                             | 1,389 (1,573) | 467 (652)     |
| First spoken unit, FULL face                                                          | 4,018 (4,303) | 2,890 (2,975) |
| Model start (server), without a face                                                  | 1,831 (1,965) | 722 (864)     |
| Typed turn: stream opening / first sentence                                           | 1,247 / 3,698 | 469 / 2,738   |
| Database round trips of the whole voice turn (all of them, not in sequence)           | 67 (82 face)  | 46 (51 face)  |

How it is counted: the harness traces every round trip with the time it was sent and answered (the simulated network
time included) and takes the longest run of round trips each sent once the one before it was answered, among those
answered by the moment measured (`perf/critical-path.ts`). It reads that on a second run of the same turns with the
model's and the embedding's time at zero, where a round trip nobody waits for (a commit, a write handed to the host)
is still in flight at the moment measured instead of filling the model's wait. A spoken reply of one sentence counts
one more: its usage row is still written before its only unit (plan item 7 below, not taken). In production two of
the 13 (the retrieval transaction's begin and context) overlap the ~155-200 ms query embedding.

A returning founder's opener is pinned the same way (`perf/round-trips.db.test.ts`, coaching v3): with the line the
distillation wrote ahead current, `GET /ventures/:id/opener` waits for 15 round trips one after another and creating
the conversation for 30, no model call on either. Coaching v3 first read the stored line's closing-question check
(does it only repeat the question the last conversation ended on?) with a statement of its own (16 and 31); it now
reads the answers from the statement that already reads the founder's last messages there.

What changed, in the order of the way to the first spoken unit:

| Step                    | Before                                                                                                                            | After                                                                                                                                                                                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idempotency-Key         | reserved (1), then everything else                                                                                                | reserved beside the preflight; the turn waits for it only before admission (`RunTurnOptions.beforeAdmission`)                                                                                                                                                                                  |
| Preflight transaction   | begin, context, 9-12 statements (session, access, settings, assignment, release, history ×2-3, interruptions, turn count), commit | begin, context, **2 statements**: the conversation with everything its checks read (`readTogether`: session, access, settings, turn count, typed messages, assignment, release, pinned release), then the history (ids, the newest batch of rows, interruptions); the commit is not waited for |
| Conversation context    | prefetched beside the preflight in 5 statements, or read in it                                                                    | the same reads in **1 statement** (`readTurnContext`), the prefetch's commit not waited for                                                                                                                                                                                                    |
| Spend caps              | 2 reads in sequence before admission                                                                                              | removed: admission's `app.spend_cap_state` enforces both caps under the lock, with the same refusal and audit (`spend_cap.reached`, metadata `scope`)                                                                                                                                          |
| Admission transaction   | begin, context, 11 statements, commit                                                                                             | begin, context, **3 statements**: the admission lock then the conversation's row lock (one statement, the advisory lock first), every limit's reads (`readTogether`, after the lock), the pending turn with its `turn.accepted` audit (one CTE), commit                                        |
| Idempotency-Key, stored | before the stream opened                                                                                                          | once the stream is open; the stream ends only after it is stored                                                                                                                                                                                                                               |
| "Where you left off"    | from `turn.accepted`, beside retrieval (5)                                                                                        | from the end of the preflight, beside the admission                                                                                                                                                                                                                                            |
| Query embedding         | its usage row written before the vector was used (1)                                                                              | the usage row handed to the host                                                                                                                                                                                                                                                               |
| Retrieval transaction   | opened after the embedding: begin, context, search, audit, commit                                                                 | opened while the query is embedded (begin and context beside it), then the search; the commit is not waited for, and the retrieval audit is written beside the reply (the same events)                                                                                                         |
| FULL face, per unit     | settings and spend (1), speech reservation (1), face admission (1)                                                                | **1 statement** (`twinRepo.admitPreapprovedFaceUnit`): settings unchanged since the turn read them, the day's spend, the speech budget, the face's order, then the reservation and the face text, both or neither                                                                              |

Guarantees kept:

- **Admission stays atomic and serialised per person.** The advisory lock and the conversation's row lock are taken
  in one statement whose plan evaluates the lock first (an uncorrelated condition: PostgreSQL's one-time filter, before
  the row is scanned and locked); every limit is read in the next statement, which starts after the lock is held and so
  counts a pending turn the person's previous admission just committed; the turn and its audit are one statement in the
  same transaction (an `expectedOrdinal` mismatch rolls both back). `turn-engine.db.test.ts` (parallel turns, the
  in-flight limit, a delete racing a turn).
- **RLS context per transaction.** Every transaction still begins with `SET_CONTEXT_SQL`; the reads merged into one
  statement are the same SQL under the same role (`readTogether` puts each read in a subquery and decodes its rows with
  the decoder it had alone; a key one read resolves for another, such as the conversation's venture, is a subquery of
  the same row).
- **Spend caps.** Enforced under the lock as before; the refusal, its message, its retry time and its audit are the
  ones the pre-check produced (the check read the same ledger the same way: `app.spend_cap_state` and
  `usageRepo.spendToday` count the same rows).
- **Idempotency.** A key used for another request, a request with the key still being answered (`IN_FLIGHT`) and an
  answered one (replayed from storage) decide the response as they did when the reservation came first, whatever the
  turn's checks found meanwhile; a reservation this request holds is released when the turn is refused; a retry before
  the accepted turn is stored is still `IN_FLIGHT`, and the stream ends only after it is stored
  (`turn-stream.test.ts`). The checks of a request whose reservation then refuses it have run, so their refusal audits
  (`turn.rejected`) can exist for it.
- **Audits.** Written as before; the ones moved off the way (retrieval, a FULL face unit's admission) and every
  deferred write (the embedding's usage row, the ends of read transactions, "Where you left off") go to the host's
  after-response work (`Kit.later` → `afterResponse` → the Lambda's `InflightTracker`, drained before the invocation
  returns), or are waited for before `runTurn` returns when there is no host hook (tests).
- **FULL face.** A unit is pre-approved only while the platform settings are still the ones the turn read with the call
  and its face (a digest of every setting, `settingsRepo.SETTINGS_FINGERPRINT_SQL`); the switches and caps are then
  the ones of the moment, and the day's spend, the call's speech budget and the face's order are read by the statement
  itself. A unit refused for any reason, a settings change included, goes through `face/say` on the settings of that
  moment (`face.db.test.ts`: every refusal, in order, once).
- **The prompt.** Byte for byte what the separate reads gave (`turn-context.db.test.ts`); no data is remembered
  between turns (the conversation's keys only, as before).

The pin: `apps/api/src/perf/round-trips.db.test.ts` runs a call's spoken turns with and without a FULL face over the
local database with every round trip delayed 100 ms and fails when a turn waits for more (or fewer) round trips than
10 before its stream and 13 (14 with a face) before its first spoken unit. On the code before this change it reads
28-30 and 33-36 (36-39 with a face).

Not taken (the plan's items outside this change): a per-call cache of the conversation's data (a note the
distillation worker writes from another process would be stale; the keys-only prefetch stays); a reply of one
sentence still writes its usage row before its only unit (1 round trip, `generate.ts`); the 60 s caches are not
refreshed in the background (up to 6 round trips on a turn that meets an expired one); preflight and admission are
still two transactions (3 round trips of begin, context and commit).

### The ElevenLabs voice, streamed PCM against whole units (2026-11-05)

What changed: calls speak with the ElevenLabs stock voice ([live voice runbook](elevenlabs-voice.md)), and the call
screen asks `POST /speech` for raw PCM and plays it as it arrives (100 ms jitter buffer, `pcm-stream.ts`) instead of
waiting for a unit's whole audio and decoding it. Measured with the harness, profile `production` recalibrated as in the
baseline (database round trip 65 ms, model first token 700 ms, embedding 155 ms, Polly first byte 100 ms), 10 voice
turns per arm, warm, one process, Apple M4 Max, Node 24, no browser (the client edge of the API; decoding and device
output excluded). ElevenLabs is a local stand-in (`perf/elevenlabs-stub.ts`) behind the real adapter: time to first byte
uniform 100–250 ms, audio streamed 4 or 10 times faster than real time (ElevenLabs publishes no streaming-speed figure).
"Playable" is when the player can start the first unit: once the whole unit arrived for MP3, once 100 ms of PCM is in
hand for the stream.

```
pnpm --filter @foundry/api latency --profile production --set dbRoundTripMs=65 --set modelFirstTokenMs=700 \
  --set embedMs=155 --set speechFirstByteMs=100 --text 0 --voice 10 \
  [--voice-vendor elevenlabs-stub [--stub-speed 4|10]] [--pcm]
```

| Arm (first unit of a voice turn, ms from sending the turn) | first audio bytes p50 / p95 | whole unit arrived p50 / p95 | **playable p50 / p95** |
| ---------------------------------------------------------- | --------------------------- | ---------------------------- | ---------------------- |
| A. Polly, whole MP3 (main before this change)              | 2,509 / 2,699               | 2,576 / 2,766                | **2,576 / 2,766**      |
| B. ElevenLabs stand-in, whole MP3, 4x                      | 2,570 / 2,759               | 3,226 / 4,290                | **3,226 / 4,290**      |
| C. ElevenLabs stand-in, streamed PCM, 4x                   | 2,577 / 2,799               | 3,277 / 4,290                | **2,577 / 2,799**      |
| B10. ElevenLabs stand-in, whole MP3, 10x                   | 2,572 / 2,767               | 2,958 / 3,287                | **2,958 / 3,287**      |
| C10. ElevenLabs stand-in, streamed PCM, 10x                | 2,583 / 2,760               | 2,955 / 3,304                | **2,583 / 2,760**      |
| D. Polly, streamed PCM (the fallback path)                 | 2,516 / 2,671               | 2,582 / 2,738                | **2,516 / 2,671**      |

- Streaming cuts the whole-unit wait: with ElevenLabs it saves **649 ms p50 and 1,491 ms p95** at 4x (B → C) and
  **375 / 527 ms** at 10x (B10 → C10). Without it, ElevenLabs would be slower to first sound than Polly today, because
  a sentence's audio takes longer to arrive than its first byte.
- With streaming, ElevenLabs reaches first sound at the same point as Polly did (C 2,577 against A 2,576 p50): the
  first audio is now bound by the stand-in's first byte, and everything before it (the `/speech` checks, about 600 ms
  of database round trips at 65 ms, and the turn itself) is unchanged.
- The first PCM piece (100 ms of audio) fills the jitter buffer, so "playable" equals "first audio bytes" in C.
- Not measured: the real vendor's time to first byte and speed from AWS, CloudFront's streaming of `audio/pcm`, and
  the browser's audible output. These are the first things to read in production (`speech.timing` with `voice: vendor`;
  the lab's end of speech → first audio).

### Speech inside the turn stream (2026-11-06)

What changed: a call's turn asks for its units' audio in its own stream (`speechAudio: 'pcm'`). Before, each signed
unit reached the browser as `turn.speech`, then the browser sent `POST /speech`, which verified it again and made its
checks (two transactions and the spend read, about 600 ms of database round trips at 65 ms) before calling
ElevenLabs. Now the checks that hold for the whole turn run once, when the turn is accepted, while the model starts
(`speech.prepareTurnVoice`; the vendor connection is warmed at the same moment), and each unit, the moment it is
written to the stream, is reserved (one statement: its play, the speech budgets, and what the turn's checks decided
still holding: the platform settings unchanged, the daily spend under its cap, the EIR's voice consent and clone
when the voice is theirs; otherwise the unit is closed `failed` and `POST /speech` decides it on the settings of the
moment) and synthesized as raw PCM, the
unit before it as `previous_text`, at most two units at once (`apps/api/src/http/turn-voice.ts`). Its audio follows
it as base64 `turn.audio` frames in the same SSE stream (through CloudFront and Lambda response streaming like the
deltas), the rate on the first frame and a closing frame (`done`, `failed`, `paused`, `refused`); the stream ends after
the last unit's audio. A reply that ends blocked (not crisis support) or failed is withdrawn before its terminal event
is written: what is not yet synthesized never is (its reservation given back), a synthesis in flight is aborted, no
PCM of it follows the terminal event, and its open units close `refused` (the page drops their audio, as
`POST /speech` refuses them). The stream waits for the turn's checks at most once per turn (400 ms, the first unit
that finds them unfinished): a unit written while they are still running goes to `POST /speech`, and the units after
them are voiced in the stream, so a slow prepare (an Aurora resume) never holds every unit back. The page's player is unchanged: the call engine hands it each unit's frames as `POST /speech` would
have (`apps/web/src/lib/realtime/turn-audio.ts`), so the jitter buffer, a LITE face fed from the same PCM and the
barge-in stop work as before; a barge-in closes the stream, which aborts every synthesis on the server. Kept on
`POST /speech`: the call intro, the crisis support line (Polly, its own plays, past the caps), stored-reply passages,
a FULL face's fallback, a LITE face the server relays, and any unit the server could not voice (`failed`: its play is
given back first). Metering, settlement, the audit (`speech.synthesized` with `inTurn`) and Polly in place of a
vendor that fails are the `POST /speech` ones (`speakReserved`, shared).

Measured with the harness, profile `production` recalibrated as above (database round trip 65 ms, model first token
700 ms, embedding 155 ms), ElevenLabs stand-in behind the real adapter with its time to first byte uniform 150–250 ms
and audio 4 times faster than real time, 10 voice turns per arm, warm, one process, Apple M4 Max, Node 24, no browser:

```
pnpm --filter @foundry/api latency --profile production --set dbRoundTripMs=65 --set modelFirstTokenMs=700 \
  --set embedMs=155 --set speechFirstByteMs=100 --text 0 --voice 10 --voice-vendor elevenlabs-stub \
  --stub-ttfb 150-250 --stub-speed 4 --pcm [--stream-audio]
```

| Voice turn, ms from sending the turn, p50 (p95)       | Before: `POST /speech` per unit | After: audio in the turn stream |
| ----------------------------------------------------- | ------------------------------- | ------------------------------- |
| First spoken unit (`turn.speech`)                     | 1,791 (1,859)                   | 1,776 (1,937)                   |
| First audio bytes = first unit playable               | 2,647 (2,741)                   | **2,040 (2,220)**               |
| First unit signed → its first audio bytes             | 846 (943)                       | **248 (296)**                   |
| First unit, whole audio arrived                       | 3,155 (4,369)                   | 2,684 (3,831)                   |
| `POST /speech` requests per turn                      | 2 (5); 28 in 10 turns           | **0**                           |
| Server: unit reserved / first audio (`speech.timing`) | 669 / 846 after the request     | 67 / 247 after the unit         |

- The first audio comes **607 ms sooner at p50 (521 ms at p95)**: what is left between a unit and its first sound is
  its reservation (one round trip, 67 ms) and the vendor's time to first byte (the stand-in's 150–250 ms).
- The reservation stays before the vendor call: overlapping them would let a unit the budget refuses be synthesized
  and billed outside the ledger.
- The pin: `apps/api/src/perf/latency.db.test.ts` (no `POST /speech` on a normal spoken turn, every unit voiced in
  the stream, its first audio measured on both sides), `speech-in-turn.db.test.ts` (reserved, metered and audited
  once; a unit voiced in the stream is refused by `POST /speech` as already spoken; the crisis line left to it; Polly
  in place of a failing vendor in the same stream; a reply blocked or failed after its units were announced voices,
  bills and sends nothing more of them; a setting changed mid-reply leaves the next unit to `POST /speech`),
  `calls.db.test.ts` (the gated reservation), `turn-voice.test.ts` (withdrawal; one bounded wait per turn),
  `call-engine.test.ts` (the browser makes no `POST /speech` for a unit voiced in the stream; a `failed` unit or one
  whose stream closed first is asked from it; a failed or blocked reply's streamed audio stops at once).
- To read in production: `turn.timing` `firstAudioMs` against `firstSpeechMs`, `speech.timing` with `route = turn`
  (`reservedMs`, `firstAudioMs`), `turn.stream_finished` `audioUnits` / `audioFailed` / `audioWithdrawn`, and the client's
  `submitToPlayback`. Not measured here: CloudFront's and Lambda's delivery of the frames, the real vendor from AWS.

### End of speech: adaptive endpointing (2026-11-06)

What changed (latency plan C; `apps/web/src/lib/realtime/endpointing.ts`, `call-engine.ts`): a hands-free turn no
longer waits one 600 ms silence after a stable transcript. The quiet it waits for follows what was heard: 300 ms after
a finished sentence, a question (a question mark, or an auxiliary before its subject: "can we", "how do I"; never a
question word alone, "when we launched last year") or a closed short answer ("yes", "no", "thank you", any short
answer with its full stop), 500 ms after a line that reads as finished without either or an unpunctuated "yeah" or
"okay", 950 ms after one left open ("um", "and", "the main thing is", "I mean", a trailing comma, a fragment), and the
old 600 ms while the transcript lags the voice. Going on within 3 s of a send, before any unit of the reply arrived and
once the server classified the line as ordinary, takes the line back: the turn is cancelled, the interrupt says nothing
was heard, and the line's words go back to the endpointer as Transcribe now has them, sent again whole when the founder
finishes (also when the words that took it back are retracted, or the founder went on inside the same Transcribe
result). A backchannel while the vEIR speaks ("yeah", "mm-hmm") restores its volume at once and never counts as noise.
Tuning `endpointing: 'fixed'` is the switch back.

Measured with transcript fixtures replayed through the real call engine (`endpointing.test-fixtures.ts`: raw Transcribe
`TranscriptEvent` payloads with partial-results stabilisation and 50 ms VAD frames, modelled on Transcribe's cadence;
written for the test, not recorded from a person), frame by frame with fake timers. Decision latency is from the end of
the founder's last voiced frame to the turn being sent; "before" is fixed 600 ms with no take-back (main before this
change). `ENDPOINT_BENCH=1 pnpm --filter @foundry/web exec vitest run src/lib/realtime/call-engine.test.ts -t fixtures`
prints the table.

| Fixture (10)                               | before ms       | before: answered half the line | after ms            | after: why                 |
| ------------------------------------------ | --------------- | ------------------------------ | ------------------- | -------------------------- |
| fast question (question mark on a partial) | 600             | no                             | **300**             | question                   |
| fast statement (full stop only on final)   | 600             | no                             | **500**             | open                       |
| short answer ("Yes")                       | 600             | no                             | **300**             | short answer               |
| open line, unpunctuated                    | 600             | no                             | **500**             | open                       |
| slow speaker, 0.9 s pause mid-clause       | 700             | **yes**                        | **500**             | open (waited 950 at "is")  |
| slow speaker, 1.2 s pause after a sentence | 600             | **yes**                        | **300**             | taken back once, then sent |
| self-correction, "fifty, I mean" 0.7 s     | 600             | no                             | **300**             | sentence end               |
| trailing "um", 0.8 s                       | 700             | **yes**                        | **450**             | sentence end               |
| trailing "and", 0.65 s                     | 600             | no                             | **300**             | sentence end               |
| transcript lagging the voice               | 600             | no                             | 600                 | catching up                |
| **p50 / p90 / max**                        | 600 / 700 / 700 | 3 of 10                        | **300 / 500 / 600** | 0 of 10                    |

- End of speech to the turn being sent: **p50 600 → 300 ms, p90 700 → 500 ms**. Against the production estimate of
  ~678 ms (600 ms plus Transcribe's finalisation), the expected saving on a finished line is about 300 ms; an open
  line saves about 100 ms.
- Lines answered in half depend on how soon the reply starts, because a take-back only happens before any of it
  arrives. The same replay with the fake server answering (accepted and classified after 100 ms, first spoken unit
  after the time below; `-t fixtures` prints it):

  | First unit after the request                           | before: answered in half | after: answered in half                             |
  | ------------------------------------------------------ | ------------------------ | --------------------------------------------------- |
  | never (the table above)                                | 3 of 10                  | **0 of 10**                                         |
  | 2.5 s (today's production first audio ≈ 2.4–4.1 s p50) | 3 of 10                  | **0 of 10**                                         |
  | 1.2 s (target)                                         | 3 of 10                  | **1 of 10** (1.2 s pause after a finished sentence) |
  | 0.7 s (target)                                         | 3 of 10                  | **1 of 10** (the same line)                         |

  The guarantee "a slower speaker is never answered on half a line" holds only while first audio is slower than the
  founder's pause plus the words that take the line back; at the target latencies a pause of about a second after a
  finished sentence is answered in half, as fixed endpointing answered it, and the founder's next words barge in.
  The mid-clause pause and the trailing "um" still wait at every latency (950 ms classes, not take-backs).

- The price: a line taken back is a cancelled turn request (the model may have started; it is metered as before), and
  a line that ends on an ambiguous word ("that's how it is") waits 950 ms.
- Not measured: real Transcribe partial timing and punctuation on partials across accents and microphones, and how
  often production lines are taken back. Read them from `turn.timing` once deployed:

```text
filter event = "turn.timing" and ispresent(endpointReason)
| stats count(*) as turns, pct(endpointMs, 50) as endP50, pct(endpointMs, 90) as endP90, sum(endpointResumed) as takenBack
  by endpointReason
```

### The coach on Claude Haiku 4.5 (2026-11-06)

What changed: the coach (every turn's streamed reply and its fields) runs on Claude Haiku 4.5 instead of Nova 2 Lite
(ADR-0022), with prompt caching (above). Nobody has measured Haiku's time to first token from this account yet, so
the harness ran with an assumption: profile `production` recalibrated as in "Speech inside the turn stream", the
ElevenLabs stand-in, audio in the turn stream, 4 typed and 8 voice turns per arm, warm, one process, Apple M4 Max,
Node 24. Nova's arm is that section's figures (first token 700 ms, 5 ms a word, structured call 2,400 ms); Haiku's
assumes **1,000 ms to the first token** (an uncached ~9.6k-token prompt; a cache read should be faster), 10 ms a word
(about 100 words a second, half Nova's) and 3,600 ms for phase B's structured call (≈ 400 output tokens):

```
pnpm --filter @foundry/api latency --profile production --set dbRoundTripMs=65 --set modelFirstTokenMs=1000 \
  --set modelWordMs=10 --set structuredMs=3600 --set embedMs=155 --set speechFirstByteMs=100 --text 4 --voice 8 \
  --voice-vendor elevenlabs-stub --stub-ttfb 150-250 --stub-speed 4 --pcm --stream-audio
```

| ms from sending the turn, p50 (p95)      | Nova 2 Lite (700 ms first token) | Claude Haiku 4.5 (1,000 ms, assumed) |
| ---------------------------------------- | -------------------------------- | ------------------------------------ |
| Voice: first spoken unit (`turn.speech`) | 1,762 (1,870)                    | 2,124 (2,410)                        |
| Voice: first audio bytes = playable      | 2,014 (2,120)                    | **2,362 (2,685)**                    |
| Voice: turn completed (with its fields)  | 5,011 (5,280)                    | 6,699 (7,082)                        |
| Typed: first sentence (`turn.delta`)     | 1,700 (1,769)                    | 2,019 (2,467)                        |
| Typed: turn completed                    | 5,370 (5,583)                    | 7,353 (7,867)                        |

- The first sound comes about **350 ms later at p50** (565 ms at p95): the 300 ms slower first token and the slower
  words before the first sentence is complete. Every 100 ms of Haiku's real first token moves it by about as much.
- Phase B's fields took about 1.7 s longer on the slower model. That was not free: the turn's `turn.completed`, a
  call's return to listening (the next line the founder said waited, queued, for it) and a chat's composer all waited
  for them. The lab then measured Haiku at p50 0.67 s to the first token, 1.29 s to the first text, 5.6 s for phase B
  and 8.0 s in all (run 42238272157), so since the bug sweep of 2026-11-06 a streamed reply completes without them:

### Phase B after the turn (2026-11-06)

- `turn.completed` is sent once the reply is validated, with `fieldsPending: true`; phase B starts at the same moment
  (from the same prompt and the reply as shown), and the same turn with its fields (claims, next steps, follow-ups,
  what it kept, the mode the model chose, a model-proposed escalation) follows in the same stream as a second
  `turn.completed` once they are stored (`turnsRepo.annotateTurn`, audit `turn.annotated`). The answer is unchanged.
- Nothing the founder waits on waits for phase B: the turn is no longer pending (the next message is admitted), a call
  goes back to listening, the composer is free, and a new message never cancels the open stream of a completed turn
  (`useTurnStream`). `turn.timing` `totalMs` ends at the first `turn.completed`; `structuredMs` still counts phase B.
- What is said is gated as before: the crisis path and the safety screen run before generation, the sentence gate on
  every unit, and a pre-classified escalation is forced by the reply's own validation (its draft is created with the
  turn). Fields that would not pass the validation (another venture's name, an identity claim) are left out, never the
  reply (`annotations_discarded`). A barge-in or a cancel before phase B starts stops it, as before.
- Phase B forces its tool on Claude Haiku 4.5 (no prose before the object, no repair round).
- Not measured: Haiku's real first token and speed from us-east-1 (§8), and how much a cache read shortens the first
  token on a conversation's later turns.

### A production call on Claude Haiku 4.5 (2026-11-07)

Read from the Ops - insights export of the owner's call (three voice turns; aggregates only):

| Per turn                                                      | Turn 1 | Turn 2 | Turn 3 |
| ------------------------------------------------------------- | ------ | ------ | ------ |
| Model's first token after it started (`modelFirstTokenMs`)    | 630    | 570    | 559    |
| Phase A in all (`modelMs`)                                    | 1,225  | 1,305  | 1,453  |
| First validated words after the request (`firstTokenMs`)      | 2,723  | 3,428  | 3,667  |
| Phase B's structured call (`ai.model.attempt`, ~1,000 tokens) | 7,386  | 6,205  | 5,280  |

The call's own numbers: first audio p50 4.1 s (p95 4.4 s); its "turn latency" p50 7.5 s is the turn record's, which
ends with phase B, and nothing the founder waits on waits for phase B (above). The model is not the slow part: its
first token came 0.56–0.63 s after it started (as fast as the lab's cached turns; the export carries no cache fields).
Of the 2.7–3.7 s to the first validated words, about 1.8–2.6 s come before the model starts (the request's Data API
round trips, retrieval, the face's pre-approval; the export carries no per-stage fields, so `turn.timing` in
CloudWatch, §3, is the next read), and the rest is the time to finish the first sentence, which a call says whole or
not at all. Each reply's first sentence was a long question (25–40 words, about 0.3–0.4 s of Haiku's output before the
gate could release it); the spoken register now asks for a short first sentence that says something (policy
`fa-coach-policy/2026-11-07.1`, current `fa-coach-policy/2026-11-07.8`). A call's start never waits for the notebook's
opener being written (it is written ahead, or after the response for the next start, and meanwhile the call offers
help with the notebook's newest open thread: knowledge-pools.md), so nothing new comes before the first word.
Not explained yet: the 1.8–2.6 s before the model starts; the call's `turn.timing` lines (`acceptedMs`, `retrievalMs`,
`promptMs`, `modelStartMs`, the prompt-cache token fields) are what would say which stage it is.

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
- How much a 1 k-token smaller prompt shortens the coach's time to first token on a call
  (`modelFirstTokenMs` by `voice`).
- Claude Haiku 4.5's real time to first token and words per second from us-east-1, with and without a cache read
  (`modelFirstTokenMs`, `streamCacheReadInputTokens`), against the harness's assumption (§5, "The coach on Claude
  Haiku 4.5"), and its real cache hit rate (`cachedInputTokens` against `inputTokens` of `ai.model.attempt`).
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
- The Data API round trip a turn now waits for 10 times before its stream and 13 times before its first spoken unit
  (§5, "Round trips before the stream and the first spoken unit"): `dbRoundTrips` of `http.request` for
  `POST /sessions/:id/turns` counts all of them, including those made alongside (the reservation, the context, "Where
  you left off"); `dbWaitMs` of the same line is what the stream waited for.
- The web app over CloudFront (HTTP/2 and HTTP/3, immutable assets): the local preview is HTTP/1.1 with six
  connections, so it penalises extra chunks that production does not.
- How often someone meets a resume now that Aurora pauses after 30 idle minutes (was 10), and how much of it
  the page-open wake hides: `db.wake` lines (`outcome: resuming` = a page open started a resume), then
  `http.request` lines with a `dbWaitMs` above 10 s and `503 database_resuming`. Keeping it awake
  (`aurora.minCapacityAcu: 0.5`, about USD 44 a month) removes them; see
  [cost controls](cost-controls.md#aurora-paused-when-idle) for the trade-off.
