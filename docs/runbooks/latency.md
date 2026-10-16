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
(BeginTransaction, CommitTransaction). A typed turn made **61 such round trips** (baseline), so the database
round trip, not the queries, decides most of the time before the model starts.

## 2. Measuring in production (the logs)

The API writes these lines (numbers and identifiers only, never content):

| Event           | Fields                                                                                                                                                                                                                                                                                                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http.request`  | `latencyMs` (to the response headers), `authMs` (session check), `dbRoundTrips`, `dbTransactions`, `dbWaitMs` (until the headers)                                                                                                                                                                                                                                             |
| `turn.timing`   | ms since the request arrived: `acceptedMs`, `modelStartMs`, `firstDeltaMs` (first sentence), `firstSpeechMs` (first spoken unit), `totalMs`; stage durations: `authMs`, `admissionMs`, `retrievalMs` (embedding wait + queries), `embedMs`, `promptMs`, `modelFirstTokenMs`, `generationMs`, `structuredMs`, `finishMs`; the whole turn's `dbRoundTrips`, `dbWaitMs`, `voice` |
| `speech.timing` | ms since the speech request reached the service, cumulative: `verifiedMs`, `plannedMs` (checks), `capsCheckedMs`, `reservedMs`, `synthesizedMs` (Polly answered), `recordedMs`, `firstAudioMs` (first bytes handed to the response); `characters`                                                                                                                             |

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

Web, cold load of New chat (median of 3; laptop / phone CPU): first paint 168 / 192 ms (the static boot
screen), app shell 588 / 789, composer 595 / 832, largest paint 596 / 804, layout shift 0.03 / 0.024. Entry
script 678 kB (214 kB compressed) in 78 script files before the composer. The serif face of the vEIR's words
started downloading at 573 / 730 ms, after the app had rendered it. Route transitions (cache warm, first visit
/ again): Knowledge 79 / 10 ms, Documents 53 ms, back to New chat 9 ms (phone: 129 / 43, 75, 39).

Production numbers: not available to this harness run (no AWS credentials on the build machine); read them
with the queries of §2 once the new fields are deployed.
