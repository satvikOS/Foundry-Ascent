# vEIR calls

How a founder talks to their vEIR by voice. A call is a mode of a conversation, not a separate product:
spoken turns are ordinary turns with `channel: 'voice'`, so the orchestrator, validators, evidence, memory
proposals, escalation and spend caps all apply. Decisions: ADR-0010 (voice calls), ADR-0018 (knowledge
pools), ADR-0019 (conversation-first console). Contracts: `packages/contracts/src/calls.ts` and the
`turn.delta` / `turn.speech` events in `packages/contracts/src/coach.ts`.

## 1. Overview

```text
Browser                                     API (Lambda, /api/v1)                    AWS us-east-1
───────                                     ─────────────────────                    ─────────────
Call ─► POST /sessions/:id/calls ─────────► admission, calls row, STT grant,
        ◄─ { call, sttGrant, intro } ─────  signed intro (conversation opener)
mic ─► AudioWorklet, 16 kHz PCM frames ─── presigned wss (seconds to open) ───────► Transcribe streaming
        ◄────────────────────────── partial / stable / final transcripts ──────────┘
end of utterance ─► POST /sessions/:id/turns ─► admitVoiceTurn ─► orchestrator ─► validators
                    { channel: 'voice', callId }
        ◄─ SSE turn.speech { seq, text, sig } … turn.completed | turn.blocked
each unit ─► POST /speech { sessionId, turnId, seq, text, sig } ─► verify, meter ─► Polly
        ◄─ audio/mpeg (streamed), played in order; the next unit is fetched while one plays
barge-in ─► stop audio, abort the turn, POST /turns/:id/interrupt { callId, heardSeq, heard }
every 15 s ─► POST /calls/:id/heartbeat { state, micOpenSeconds } ─► { remainingSeconds, action, reason }
end ─► POST /calls/:id/end ─► { call, summary }
```

No audio passes through our API: the browser streams the founder's voice straight to Amazon Transcribe and
plays Polly audio that the API streams back for validated text only. The API stays request/response plus
SSE, with no always-on infrastructure.

**Latency budget** (end of the founder's speech to the first audible word; P50, warm; estimates to measure,
now measurable stage by stage: [latency runbook](../runbooks/latency.md)):

| Stage                                                | Budget          |
| ---------------------------------------------------- | --------------- |
| End of speech → turn sent (stable partial + silence) | 400–700 ms      |
| Browser → CloudFront → warm Lambda                   | 50–100 ms       |
| Authorization, risk classification, retrieval        | 100–300 ms      |
| Model time to first token                            | 500–1,100 ms    |
| First sentence through the sentence gate             | 100–150 ms      |
| `POST /speech` → first Polly bytes                   | 150–400 ms      |
| Delivery and playback start                          | 30–80 ms        |
| **Total**                                            | **≈ 1.3–2.8 s** |

The call opens warm: the start request resumes the database and the Lambda while the microphone starts,
and the heartbeats keep both warm. Clients report first-audio p50/p95, barge-ins and reconnects at the end
(`calls.first_audio_ms_p50`, …); the target is P50 ≤ 0.8 s, P95 ≤ 1.2 s.

## 2. Backend

### 2.1 Endpoints

Contracts in `packages/contracts/src/calls.ts`; errors are problem+json.

| Endpoint                                                     | Who                              | Result                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /sessions/:id/calls` `{inputMode, replace?}`           | founder/team, as themselves      | 201 `{call, sttGrant, intro}`. Never stored for idempotent replay (the grant is a credential).                                                                                                                                                                 |
| `GET /calls/:id`                                             | founders, team, assigned EIR     | `{call, summary}`; the summary once the call ended.                                                                                                                                                                                                            |
| `POST /calls/:id/stt-grant`                                  | the caller                       | A fresh Transcribe URL on reconnect or unmute, under the heartbeat's checks (20 per call, 100 a day).                                                                                                                                                          |
| `POST /calls/:id/heartbeat` `{state, micOpenSeconds, face?}` | the caller                       | `{remainingSeconds, action: continue \| terminate, reason, face?}`. A terminate also ends the call; `face: stop` only its face.                                                                                                                                |
| `POST /calls/:id/end` `{reason, clientStats?}`               | the caller                       | `{call, summary}`. Idempotent: an ended call is returned as it is, with its first reason.                                                                                                                                                                      |
| `POST /turns/:id/interrupt` `{callId, heardSeq, heard?}`     | the caller                       | 204. Records what the founder heard of the reply (verified); the first record wins.                                                                                                                                                                            |
| `POST /speech`                                               | the caller, in a live call       | `audio/mpeg`, streamed (§2.5); `audio/wav` with `x-face-manifest` for a unit the call's face may show (§4.2).                                                                                                                                                  |
| `POST /calls/notice/acknowledge`                             | anyone signed in, for themselves | `{acknowledgedAt}`. The first-call privacy notice was read; stored with the person (migration 0010), idempotent, audited once. `GET /ventures/:id/call-config` reports it as `callNoticeAcknowledgedAt`, and the call screen shows the notice until it is set. |
| `POST /calls/avatar-session` `{ventureId, callId}`           | founder/team                     | The face of the live call (§4.3): a room token for a vendor face, or the presence (no token).                                                                                                                                                                  |
| `POST /calls/:id/face/speak`                                 | the caller                       | 204. Hands the face a unit's exact PCM with its `x-face-manifest` (§4.2); 422 otherwise.                                                                                                                                                                       |
| `POST /calls/:id/face/interrupt`, `/face/end`                | the caller                       | 204. Barge-in on the face; the face is no longer shown (its vendor session ends).                                                                                                                                                                              |

Someone else's call or turn is 404, as is a conversation the caller cannot see. Refusals:

| Status | Code                  | When                                                                                                                                         |
| ------ | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 403    | `forbidden`           | The caller lost write access to the venture (archived, or no longer founder or team).                                                        |
| 409    | `conflict`            | A live call in another conversation (unless `replace`); the call ended or went silent; its time limit or 90-turn cap; speech already played. |
| 409    | `session_ended`       | The conversation has ended.                                                                                                                  |
| 423    | `persona_suspended`   | The vEIR is suspended, or its own voice is no longer covered by voice consent.                                                               |
| 423    | `assignment_inactive` | No active assignment, or it changed since the conversation started.                                                                          |
| 429    | `rate_limited`        | Today's call minutes are used (`Retry-After`: midnight UTC); 40 spoken turns in 10 minutes; grant limits; the speech budgets.                |
| 429    | `spend_cap_reached`   | The daily AI spend caps.                                                                                                                     |
| 503    | `ai_disabled`         | The AI kill switch, or `calls_enabled` is off.                                                                                               |
| 501    | `speech_unavailable`  | No speech service here (local development): the client types and the browser speaks. Sent after every other check.                           |

A live call in another conversation is refused with 409 until its client goes quiet for 60 s; a client that
lost track of it (a crashed tab) starts again with `replace: true`, which ends that call as `navigated`.

### 2.2 The `calls` table (migration 0008)

One row per call: tenant, venture, conversation, persona, who started it, `status` (`live` \| `ended`),
provider, input mode (`transcribe` \| `typed`), the voice, `max_seconds`, start, last heartbeat, end,
`end_reason` (the contract's `CallEndReason`) and `end_detail` (machine-readable: `kill_switch`,
`calls_disabled`, `session_closed`, `access_revoked`, `persona_unavailable`, `voice_consent`, `spend_cap`,
`daily_call_minutes`, `max_duration`, `stale_heartbeat`, `replaced`, `client_<reason>`), grant,
synthesized-character and microphone-second counters, and the client's latency stats. Identifiers and numbers
only, never content.

- **One live call per person** (partial unique index). Starting a call in the same conversation replaces
  the live one (a reload or a second tab); a live call elsewhere is refused (409) unless the caller asks to
  replace it; a call whose client sent no heartbeat for 60 s is closed first.
- A trigger keeps a call's identity, limits and start fixed, and an ended call ended.
- **RLS**: the caller, the venture's founders and team (summaries) and its assigned EIR read; only the
  caller inserts (on an active conversation of their venture, as themselves) and updates.
- **Turns** carry `call_id`: a turn a person sends in a conversation while their call there is alive joins
  it (trigger `turns_link_call`; a turn naming a call must name that one). `heard_seq`, `heard_text` and
  `interrupted_at` record barge-in (§2.6). `heard_text` is conversation content: trigger `turns_redact_heard`
  clears it whenever the turn's words are redacted (an ended temporary chat, a deleted conversation).
- `calls_enabled` is a platform setting (on by default). `GET /ventures/:id/call-config` reports it as
  `callsEnabled`, with `aiEnabled` and the minutes left today, so the call button can say why it is off.

### 2.3 Admission and limits

Starting a call checks, in order: founder/team access to an active conversation, `ai_enabled`,
`calls_enabled`, the active assignment of that conversation and its persona, the voice (§5), the daily AI
spend caps, one live call per person (under the person's turn-admission lock), and at least 60 s left today.
`max_seconds` is the smaller of the per-call cap (`max_call_minutes`, 30) and the minutes left today
(`daily_call_minutes_per_principal`, 60). A person who used today's 100 speech-to-text grants starts typed.

A spoken turn (`channel: 'voice'`) passes `admitVoiceTurn` in the transaction that inserts it: it must
name a live call of that conversation started by the caller whose client is still there, calls must be on,
time must be left (per call and today), the person may send at most 40 spoken turns in 10 minutes, and a
call holds at most 90 turns. Typed chat keeps its own rate limit. Crisis turns are never refused for call
reasons or any limit (§5); one that names no live call of the caller in that conversation, or that comes
past the typed message limit (crisis turns count towards it), is answered and recorded as a typed message
(no speech unit, no voice turn, no call marked on the conversation).

**Minutes** come from the `calls` table, by the database clock: ended calls count until they ended, live
calls until now, but never more than 60 s after their last heartbeat (or their start): as long as a call
without heartbeats still takes spoken turns and speech, so every second a call could be used is counted.
A call whose client went away is closed there (at its next start, heartbeat or end, or by
`callsRepo.reapStaleCalls`), so the count is the same before and after it is closed.

### 2.4 Heartbeats

Every 15 s. The heartbeat re-reads everything and ends the call (`action: terminate`) on, in order: the AI
kill switch or `calls_enabled` off (`disabled`), the conversation ended or deleted (`user`), the caller no
longer able to write to the venture (`disabled`), the vEIR suspended, retired or re-assigned (`disabled`),
the call's own voice no longer covered by consent (`disabled`), no heartbeat for 60 s (`timeout`), the
platform's daily AI cap or the caller's own AI cap, which counts their model spend but not speech (`budget`),
today's minutes (`budget`) or the call's time limit (`timeout`). Switching calls
off therefore stops every built-in call within 15 s. A later heartbeat of an ended call keeps answering
`terminate`.

Each heartbeat also carries the client's running total of microphone seconds. The total only grows, never by
more than the wall time since the previous heartbeat, and never beyond the call's own wall time plus 5 s
(granted once per call, so heartbeats sent faster add nothing), by the database clock. On a call with
speech-to-text what it adds is metered (§2.7).

`POST /calls/:id/end` applies the same checks first: a call that has to stop ends for the server's reason.
Otherwise it ends for the client's, which can only be `user`, `navigated` or `error` (other claims are stored
as `user`, with the claim in `end_detail`).

### 2.5 Speech-to-text and speech

- **Grants.** `SttGrantIssuer` (core port) is implemented by `TranscribeStreamingPresigner`
  (`apps/api/src/adapters`): a SigV4-presigned `wss://transcribestreaming.us-east-1.amazonaws.com:8443/
stream-transcription-websocket` URL (en-US, PCM, 16 kHz, partial-results stabilization high), signed with
  the API Lambda role's credentials from the credential provider chain. Infra grants
  `transcribe:StartStreamTranscriptionWebSocket` to the API role and adds the host to `connect-src`. Without
  the port (mock model, local development) calls start with `sttGrant: null` and input mode `typed`; a
  signing failure leaves the call running without a grant.
- **What a grant allows.** A presigned URL can open any number of streams until it expires, and a stream
  keeps running after the URL expires; neither a heartbeat nor a kill switch can close a browser-direct
  stream. So a grant lives 30 s (just long enough to connect), a grant is minted only under the heartbeat's
  checks, each call may mint 20 and each person 100 a day, and the microphone time heartbeats report is
  metered. What a modified client does with a URL inside those 30 s is not metered (§5).
- **Signed units.** The turn engine streams each validated unit of the spoken reply as `turn.speech` the moment
  the sentence gate releases it (nothing waits for the next unit or the annotations). Nothing is said after a
  streamed reply's last unit, usually the question that hands the turn back: a narrowed answer's note stays
  in the transcript instead of being spoken a whole model call later, over or after the founder's answer. A
  reply written whole is said as one held reply whose last unit is `final`. Units are signed
  (HMAC-SHA256, key derived by HKDF from the session-signing key) over `sessionId|turnId|seq|text`
  (`orchestrator/speech-units.ts`). The call intro is signed the same way with no turn and `seq` 0.
- **`POST /speech`** speaks, during the caller's live call in that conversation and in the call's voice:
  - a signed unit or the intro whose signature verifies; units of a turn that was finally blocked or failed
    are refused;
  - or, unsigned, the whole stored `spoken` form of a completed turn of the conversation, or one or more
    consecutive whole sentences of it (at least 12 characters). Sentences end at `.`, `!`, `?` or `…`
    followed by a space, never after an abbreviation or an initial. The stored words are spoken, not the
    request's spelling; fragments, reordered or skipped sentences and the answer text are refused (422);
  - or the fixed crisis support message (§5).

  It checks the kill switches, the active assignment, the voice consent, the call's time left, the
  platform's daily spend cap and the speech budgets, and only then reports 501 where no speech service runs.

- **Speech budgets.** A person's own AI cap leaves call speech out, so `/speech` is bounded by what a call can
  say instead. Before Polly is called, one statement (`callsRepo.reserveCallSpeech`, under the call's row
  lock, so concurrent requests are serialised) reserves a play of what is spoken in `call_speech` and its
  characters on the call (`calls.speech_characters`), and refuses:
  - a replay: the intro and each signed unit are synthesized once per call, a run of whole sentences of a
    stored reply twice (409 `speech_already_played`);
  - more than 15 characters per second the call has lasted plus 2,000 (the intro and a reply fetched ahead
    of playback), and never more than 15 a second over the call's time limit: 27,000 characters in a
    30-minute call (429 `call_speech_limit`);
  - more than 15 characters a second over the daily minute cap across the calls a person started that UTC
    day: 54,000 at 60 minutes (429 `daily_speech_limit`, `Retry-After` midnight UTC).

  A synthesis that fails gives its play and characters back; one billed differently is corrected to the
  bill. Each refusal is audited (`speech.refused`).

- **The intro** greets the founder by first name, says the vEIR is an AI coach, and continues with the
  conversation's opener before its first turn (`coaching_sessions.opener`: the notebook's next opener as it
  was when the conversation was created, which the turn engine replays as the vEIR's first message; none in
  a temporary chat), "What would you like to work on?" without one, and "Where would you like to pick up?"
  on a conversation under way. The vEIR introduces itself by its persona name unless
  that name presents it as an EIR ("Corin Halvorsen", "Coach Corin"); it then says "Corin's vEIR". The
  opener is a person-editable note: it is stored, shown and spoken only if it names no EIR at all and passes
  the identity rules and the cross-venture check; otherwise it is left out.

### 2.6 Barge-in, end and summary

`POST /turns/:id/interrupt` records `heard_seq` (the last unit the founder heard to its end, -1 for none)
and, from `heard`, the words of units 0…`heard_seq` as played. Each heard unit must verify: a signed unit of
this turn, or a whole sentence of its stored spoken reply; anything else is refused (422). The turn engine
builds the conversation history with `historyAsHeard` over `callsRepo.listTurnInterruptions`: a reply the
founder spoke over is replayed as the words they heard, and left out when they heard none of it or the client
did not send the units. The model never sees a reply as heard when it was not.

A barge-in usually lands while the turn is still being answered (playback starts during the stream). A spoken
turn the caller cancels after some of its speech units were sent is therefore not failed: it is stored as
completed with the reply as far as it was written (all of it when only the annotations were left), without
annotations and with the validator note `interrupted`, and no further unit is sent. The next turn's history
then has the founder's words and, once the interrupt is recorded, only what they heard of the reply. A turn
cancelled before any unit was sent fails as before.

`POST /calls/:id/end` stores the client's numbers and returns the summary: turn count, duration, AI memory
proposals from the call's turns still awaiting review, their next actions (each once, at most 10) and
escalations drafted from them. A summary lists what its reader may open: an assigned EIR, who reads only the
turns sampled for review, sees the count and follow-ups of those turns.

### 2.7 Metering and audit

- Each synthesis is a `usage_ledger` row with purpose `speech` (characters, Polly price per engine),
  counted by the platform's daily cap (not by a person's own AI cap: the speech budgets of §2.5 bound it), and
  its characters are reserved on `calls.speech_characters` and its play in `call_speech` before Polly is
  called.
- Speech-to-text is a `usage_ledger` row with purpose `speech` and model `transcribe:streaming:en-US` for the
  microphone seconds each heartbeat adds (`input_tokens` holds the seconds; $0.024 a minute), so the
  platform's daily cap covers it, as reported. The last few seconds before the end are not metered.
- Audit events (identifiers and counts only): `call.started`, `call.refused`, `call.stt_granted`,
  `call.terminated` (with the cause), `call.ended`, `call.access` (denied), `turn.interrupted`,
  `turn.interrupt_refused`, `turn.rejected` (voice admission), `speech.synthesized` (`crisis_support` for the
  crisis message), `speech.refused`.
- Logs never carry grant URLs, intros, heard words, transcripts or spoken text.
- Daily maintenance ends calls whose client went away (`callsRepo.reapStaleCalls`, audited
  `maintenance.stale_calls`); the API also closes them lazily on the next start, heartbeat or end.

## 3. Client

Code: `apps/web/src/lib/realtime/` (the engine; framework-free, unit-tested with fake WebSocket, Web Audio
and fetch) and `apps/web/src/features/calls/` (the UI).

### 3.1 Where calls live

A call belongs to the person, not to a page. `CallProvider` wraps the app shell (`routes/$tenant/app/route.tsx`),
so a call keeps going while the founder moves between conversations and venture pages. It loads the engine
and the call screen on demand (warmed once the app is idle), so the shell's bundle does not carry them.

| URL                                                 | What shows                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `/<tenant>/app/v/<venture>?call=1`                  | The call screen; the call creates its conversation, whose URL the page takes once the call is live.     |
| `/<tenant>/app/v/<venture>/c/<conversation>?call=1` | The call screen, calling in this conversation.                                                          |
| Any page while a call is live                       | The **mini call bar** at the top of the content: the vEIR's face, the timer, mute, Return to call, End. |
| Any page after a call ended out of view             | The mini bar offers the summary (time limit, kill switch, lost connection).                             |

Entry points all link to `?call=1`: the sidebar's **Call {vEIR}** (also in the phone's navigation sheet),
the voice button in New chat's composer, the conversation header (the phone's only bar) and the
conversation composer's voice button, and ⌘K. They show only for the venture's founders and team, and only
while the call settings (`GET /ventures/:id/call-config`) say AI and calls are on (`useCallsAvailable`), so a
paused calls switch leaves no dead link. The AI is named as "Corin's vEIR" everywhere on a call (stage,
dialog title, mini bar, captions, summary), never by the EIR's bare name. One call at a time: opening
`?call=1` elsewhere during a call returns to the live one. Arriving by a click starts the call at once (the
click is what lets the browser play audio); a reloaded `?call=1` shows **Start call** instead, and so does
the first call in a browser, which first says how the founder's voice is handled (Amazon Transcribe turns
it into text, no audio is kept, the transcript is saved like chat, typing works throughout). When a call
cannot start, the screen says why (calls are for the venture team; AI paused; no minutes left today; the
API's own refusal in its own words) and offers **Try again** only when trying again may help; a call
minimized while it connects says why in a toast. When the founder is already in a call in another
conversation (409 on start), the screen asks "Move it here?": **Move here** (named "Move here, ending the
other call") starts again with `replace: true`, which ends the other call; **Not now** leaves it. The first-call notice is acknowledged per
browser (local storage): no server field records it yet, so a founder on a new device sees it once more. A call from New chat that never starts (refused,
cancelled, closed while connecting) deletes the conversation it created, so no empty conversation is left
in Recents.

### 3.2 The call screen

A focused, full-height surface (a modal dialog over the conversation, so focus and screen readers stay in
it):

- **Stage**: the avatar provider's form (the built-in presence) around the vEIR's monogram, or its portrait
  when likeness consent and an image exist. Under it, the name with its "vEIR · AI · Live voice" badge and the state in
  words (`Connecting…`, `Listening`, `Thinking…`, `Speaking · Interrupt`, `Replying on screen`, `Muted`,
  `On hold`, `Reconnecting…`, `Hold to talk`, `Your turn`), never colour or motion alone. When the browser
  kept the call's audio suspended (no gesture reached it, as iOS requires), a **Turn on** button (named
  "Turn on sound", beside "Sound is off") unlocks it; after the page was hidden, **Resume call** ends the hold.
- **Captions** (on by default; the choice is remembered per browser): the vEIR's current sentence in the
  reading face and the founder's live partials. **Call settings** (top right) choose small, medium or large
  captions and "Read captions with my screen reader", which makes the vEIR's line a polite live region;
  otherwise it is not one, since the voice and a screen reader would talk over each other.
- **Dock**: Mute (`M`), Push to talk (`P`; hold the button or Space), Captions (`C`), Type instead (`T`),
  Switch to chat, End. 48 px targets with names and pressed states. Esc interrupts the vEIR while it speaks,
  otherwise minimizes. No single key ends a call.
- **Timer** with the minutes left (from the heartbeat; the last two minutes count down and warn).
- **The vEIR's tile** (ADR-0020): the presence in a call tile with a name tag ("Corin · vEIR", its badge
  explains what the vEIR is) and a speaking indicator; no disclaimer line.
- **Notices**: a failed turn (shown, never spoken, in the server's words), "Voice replies are unavailable." while
  replies are on screen only ("Voice paused for this call. Replies continue as text." once the call's or the
  day's speech budget ran out), the two-minute warning, and the push-to-talk suggestion. A held-back turn
  shows the conversation's own `BlockedPanel` in place of the captions (`role="alert"`): the explanation for
  its reason, the crisis resources or the emergency line, and the drafted request for a
  person, with Switch to chat; the microphone is muted. The typed line says once why voice input is off.

**Switch to chat** ends the media and returns to the conversation. **End** shows the summary.
Neither ends the conversation.

### 3.3 CallEngine

```text
mic ─ getUserMedia (echo cancellation, noise suppression) ─ AudioWorklet /worklets/pcm-capture.js
    ─ 16 kHz s16le PCM, 50 ms frames + RMS ─ AWS event-stream AudioEvent ─ presigned Transcribe WSS (sttGrant)
    ◄ TranscriptEvent partials (stabilised) ─ captions ─ end of turn
    ─ POST /sessions/:id/turns {text, channel: 'voice', callId} (SSE)
    ◄ turn.speech {seq, text, sig} ─ POST /speech {seq, sig} (next unit fetched while this one plays)
    ─ decodeAudioData ─ AudioBufferSource ─ gain (duck) ─ analyser (presence) ─ speakers
```

- **Capture.** The worklet is a static file on our origin (`/worklets/pcm-capture.js`, covered by
  `script-src 'self'`, no blob: URLs; the CSP needs no change for it). It averages
  each 16 kHz sample's span of input samples (a box filter) and transfers frames to the main thread. The
  event-stream codec (CRC-32 prelude and message checksums) is ours: about a hundred lines for one message
  type, instead of an SDK dependency. The socket opens while the worklet loads, not after it, because a grant
  only opens a stream within seconds of being minted. Muting closes the Transcribe socket, so muted minutes
  are not billed;
  unmuting re-mints the grant (`POST /calls/:id/stt-grant`) when the old one is within 15 s of expiry.
- **Speech-to-text failures.** A socket the browser refuses to create (`SecurityError`: the CSP lacks the
  Transcribe host, or the browser blocks it) continues by typing at once; any other failure to connect is
  retried like a dropped socket. `start()` never rejects: whatever throws, the call ends in `failed` with
  the microphone released.
- **End of turn (hands-free).** A segment Transcribe finalised, a partial whose words are all marked stable,
  or a partial unchanged for the silence window; plus ~600 ms without a voiced frame from the energy VAD
  (adaptive noise floor, two-frame onset; no WASM, so no `wasm-unsafe-eval`). Updates of a segment already
  sent only count for new trailing words. Push-to-talk sends silence until held and ends the turn 700 ms
  after release. Lines finished while the vEIR is still answering wait and go together after it.
- **Playback.** Units play in order through the call's one AudioContext, which the Start/Call click
  unlocks (or Turn on sound, when the browser kept it suspended; `statechange` is watched for the whole
  call). Calls speak only validated text: signed `turn.speech` units, the signed intro (`turnId: null`,
  seq 0), or, when no units streamed (streaming switched off), the sentences of the completed turn's stored
  `spoken` reply, split by the server's own sentence rules (`POST /speech` checks each unsigned passage
  against the stored turn; a sentence under 12 characters joins its neighbour, since the server voices a
  passage that short only as the whole reply). A reply without a spoken form is shown, never voiced. On
  `501 speech_unavailable` (local development only), a **development build** lets the browser's
  `speechSynthesis` read the same validated text for the rest of the call, with a voice on the device only
  (`localService`; Chrome's online voices would send the text to a third party). Production builds never
  pass the browser's synthesis to the engine, so a 501 shows captions with "Voice replies are
  unavailable." Any other failure never brings a substitute voice: a failure that may pass (network, 5xx, a
  busy synthesiser, a unit the server will not voice, undecodable audio) shows that sentence on screen and
  the next one asks for the voice again; a refusal for the whole call (`ai_disabled`, spend or minute caps,
  a paused vEIR or withdrawn voice consent, lost access) keeps replies on screen for the rest of the call.
  A crisis turn's fixed support line (signed units before `turn.blocked`) plays to its end, and nothing cuts
  it off (Esc, Interrupt and a barge-in are ignored while it plays); any other blocked turn stops at once.
- **Barge-in.** A VAD onset while the vEIR speaks ducks it to 20 % at once. The founder takes the floor
  with a word that is neither in what the vEIR has said of this reply (the echo guard) nor a backchannel
  ("yeah", "mm-hmm", "right", "got it"; "sorry" or "wait" open a turn): a settled one (a final segment, or
  every word marked stable), one Transcribe already marked stable in a partial, one while the voice has run
  on for 0.3 s, or two while the transcript still changes; or with the voice alone running on for about
  0.7 s (short gaps between words included) when no word heard yet says it is only a backchannel or the echo
  (the lab measured 2.0 s to stop while it waited for confirmed words). On a call where voice alone stopped
  the reply and no word followed within 3 s (speakers, a room), only words stop it from then on. A line
  typed or said while the call's greeting is still on its way or playing stops the greeting and is sent at
  once. That stops the audio, aborts the turn stream and sends
  `POST /turns/:id/interrupt {callId, heardSeq, heard}`, where `heardSeq` is the last unit heard to its end
  (-1 for none) and `heard` the units 0…heardSeq as played (signed units with their `sig`, stored passages
  as text). Echo and
  backchannels never become a turn, also when heard between the reply's sentences. A duck no word confirms
  restores the volume; after three, the call suggests push to talk. Typing while it speaks, Esc and
  Interrupt do the same.
- **Half duplex** (iOS and iPadOS, where echo cancellation does not reliably keep the vEIR out of the
  microphone): the microphone sends silence and transcripts are ignored while the vEIR speaks; a large
  Interrupt button (or Esc) takes the floor.
- **Hold.** When the page is hidden, a voice call goes on hold: the microphone is muted and the Transcribe
  socket closed, so nothing is heard or billed. **Resume call** (a tap, which mobile browsers need before
  playing again) unmutes. While live, the screen stays awake (Screen Wake Lock, re-acquired when the page is
  shown again).
- **Heartbeat** every 15 s (`POST /calls/:id/heartbeat {state, micOpenSeconds}`): `terminate` ends the call
  with the server's reason; three missed heartbeats end it as `error`. The client also ends at its own
  countdown (`timeout`) and warns two minutes before.
- **Reconnect.** A dropped Transcribe socket reconnects with a fresh grant (0.5, 1, 2, 4 s backoff); after
  30 s the call continues by typing.
- **Typed fallback.** No `sttGrant` (mock and local development), a refused or missing microphone, or lost
  voice input: the founder types; the line is still a `voice` turn and is answered aloud.
- **Teardown.** End posts `POST /calls/:id/end` and shows its summary. Closing the tab ends the call with a
  `keepalive` fetch prepared at call start (`navigator.sendBeacon` cannot send the CSRF header or the payload
  hash CloudFront's origin access control signs). Leaving the app (sign-out) ends it the same way and
  releases the microphone.
- **Client stats** sent with End are numbers only: first-audio p50/p95, barge-ins, reconnects. Nothing on the
  client logs content.

### 3.4 After the call

`POST /calls/:id/end` returns the summary, shown in place of the stage: the duration and exchanges, what the
vEIR would like to remember (each proposal with **Keep** / **Not now**: nothing is kept without the founder),
the next actions it suggested, and any request for a person it drafted (with a link to review and consent in
Human help), and the AI disclosure. Keep / Not now go through the app's one review path (the batch memory
route). The transcript is already in the conversation: spoken turns are ordinary turns. Buttons: Back to
conversation, Call again.

Why a call ended is said plainly: the time limit, calls paused by the program, a lost connection, or the
budget. A `budget` end reads the refreshed call settings to say which budget: today's call minutes ("Your
conversation is saved, and you can keep going in chat") or today's AI allowance, which pauses typed chat too
until midnight UTC ("Your conversation is saved"). A voice turn refused for the allowance says the same
instead of a generic error.

## 4. The face and the voice of a call (the digital twin)

The call engine owns the conversation (speech in, validated speech out); a face only embodies it and a cloned voice
only says what the engine already validated. Both are off by default (`faces_enabled`, `cloned_voice_enabled`), each
needs its own consent scope, and each falls back without a word. How to turn them on:
[docs/runbooks/avatars.md](../runbooks/avatars.md). The code is authoritative.

### 4.1 Seams

```text
Server (packages/core ports)                                   Vendors (apps/api adapters)
EmbodimentProvider  id fake | heygen, voicing audio, likeness  heygen-liveavatar.ts (LITE), development-face.ts
  createSession({callId, personaId, avatarRef, maxSeconds})      → browser {token, url, expiresAt}, sessionRef, control
  speak(handle, VerifiedFaceAudio) / interrupt / keepAlive / end
VoiceProvider       id elevenlabs | fake, model, price         elevenlabs-voice.ts, development-voice.ts
  synthesize({unit: VerifiedSpeechUnit, voiceRef, format})
SpeechSynthesizer   Amazon Polly (stock voices; pcm_16000 for a face)

Browser (apps/web)
AvatarProvider      builtin (presence) | fake (canvas) | heygen (lib/realtime/embodiment/liveavatar.ts)
  connect(session, signal, relay) · video() · renderer() · onLost()
FaceRenderer        render(buffer, output, handlers, audio: {pcm, manifest} | null) → stop
FaceRelay           speak(audio) → POST /calls/:id/face/speak · interrupt() → POST /calls/:id/face/interrupt
CallFaceController  features/calls/use-call-face.ts: one per engine; the face belongs to the call
```

Configuration: `MEDIA_FACE_PROVIDER` (`none` | `heygen-liveavatar`), `MEDIA_FACE_SANDBOX`, `MEDIA_VOICE_PROVIDER`
(`polly` | `elevenlabs`), `MEDIA_VOICE_MODEL`, `MEDIA_VOICE_ZERO_RETENTION` (infra `media`, off in production.json).
Vendor keys come from Secrets Manager (`foundry-ascent/media/heygen`, `foundry-ascent/media/elevenlabs`, JSON
`{"apiKey"}`; names and prices in `packages/core/media-vendors.json`), read on first use, cached 5 minutes, never
logged, never sent to the browser. The local API runs stand-ins with `EMBODIMENT_PROVIDER=fake` and
`VOICE_CLONE_PROVIDER=fake` (refused outside development).

### 4.2 Only validated speech reaches the face and the clone

- **The clone** is handed only a `VerifiedSpeechUnit`, which only `verifiedSpeechUnit()` makes, from a unit whose
  signature (`sessionId|turnId|seq|text`, after the identity guard, meta-narration gate and sentence gate) verifies
  in that request. Passages of a stored reply (unsigned) and the crisis line use a stock voice. It speaks only in a
  call that started with it (`calls.voice_vendor`), while `cloned_voice_enabled` is on and the persona's voice is
  ready under `voice` consent; otherwise the next unit is the call's stock voice, or the platform voice when that
  call's clone was withdrawn (the call goes on). A clone that fails (vendor error, timeout, missing key) costs the
  unit nothing: the same verified words are spoken in that stock voice within the same reservation (billed as the
  stock voice), and that clone rests for a minute in that container, so its next units skip it instead of waiting
  on it again.
- **The face's speak channel stays on the server.** LiveAvatar LITE's `ws_url` is stored only encrypted
  (AES-256-GCM, a key derived from the session-signing key, bound to the call) in `call_faces` and erased when the
  face or the call ends; the browser gets the room's client token and URL only, and never publishes into the room.
- **Face audio is checked byte for byte.** For a call with a live face, `POST /speech` returns a signed unit as
  24 kHz PCM in a WAV (the browser can always play it itself) with `x-face-manifest`: an HMAC over the unit, the
  call, the face session and the SHA-256 of every one-second chunk. When the unit's turn comes, the face's relay
  sends those bytes back (`POST /calls/:id/face/speak`, parts of at most 18 s, `x-face-part`); the server checks the
  manifest and every chunk, then admits the part in one statement under the face's row lock
  (`twinRepo.admitFacePart`): a unit's first part counts its one hand-over (`call_speech.face_plays`) and makes it
  the unit the face is saying (`call_faces.speaking_unit`); every later part must be of that unit and start exactly
  at its next chunk (`call_speech.face_next_chunk`), and nothing follows its last chunk. Barge-in
  (`POST /calls/:id/face/interrupt`) seals it. Only then are the bytes relayed to the vendor. Anything else (other
  audio, a changed sample, another call's manifest, a replayed, skipped or reordered part, a part of a unit the face
  is no longer saying, an unsigned unit) is refused (422, audited `call.face_refused`: `already_shown`,
  `part_out_of_order`, …) before the vendor sees it, so validated speech cannot be cut up and re-sequenced. One
  synthesis serves both the speakers' copy and the face.
- **The vendor's control protocol** (LITE events): the server waits for `session.state_updated: connected` before
  any command, sends one-second `agent.speak` chunks each with its own `event_id`, waits for every
  `agent.audio_buffer_appended`, and on a unit's last part sends `agent.speak_end` and waits for
  `agent.audio_buffer_committed` before closing; `error` fails the hand-over (the call then plays the unit itself).

### 4.3 The face of a call

1. The call settings (`GET /ventures/:id/call-config`) name the face only while `faces_enabled` is on, a provider
   is wired (a vendor sandbox, which shows the vendor's stock avatar, only to platform admins: the owner's first
   live checks) and, for a real likeness, the persona's face is ready under `likeness` consent
   (`app.persona_twin`), with the video minutes left (`faceMinutesLeft`).
2. Once the call is live the stage asks the call's `CallFaceController` for it; the controller asks
   `POST /calls/avatar-session {ventureId, callId}` once per call. The server opens a vendor session only for the
   caller's own live call in that venture with that persona, for at most the call's time left, the per-call video
   limit (`face_minutes_per_call`, 20) and the person's video minutes this month (`face_minutes_per_principal_month`,
   60), never above the platform spend cap, outside any transaction; one face per call (`call_faces`). The vendor
   session carries that limit (`max_session_duration`); a vendor that refuses it opens no session. Anything else
   answers the presence (no token); the audit names the provider and the reason, never a token.
3. The adapter (its own chunk) joins within 8 s; at the first frame the same tile shows the face's video (muted),
   the name tag stays, the founder's initials sit in the corner, and the engine hands the face each unit (§4.2).
   A unit is announced at the face's first sound (the vendor's speak event, or its audio track's level); a unit the
   face cannot start within 3 s, or the server refused, is played by the call itself.
4. The face belongs to the call: minimizing keeps it (the mini bar shows it as a thumbnail, the monogram with
   reduced motion); a face that drops, the stage giving it up, or a call left on hold (page hidden) for over a
   minute (the vendor bills an idle face) tells the server (`POST /calls/:id/face/end`).
5. Heartbeats report whether the face is shown and answer `face: stop` (and the server ends the vendor session,
   asking twice if the first stop fails) when faces are switched off, likeness consent is withdrawn, the call's
   video limit or the month's video minutes are used up, the month's minutes cannot be read (the face never goes
   on unchecked), or the face is no longer shown. A crisis turn drops the face to the presence at once: a human-looking face never says the
   crisis line. Ending the call ends its face (a database trigger erases the control channel; the vendor session is
   stopped after commit).

**Metering.** Face seconds come from the server's clock and go into the usage ledger as heartbeats come and when the
face or the call ends, in the same transaction as the counter (`call_faces.metered_seconds`, never beyond the
face's limit: exactly once), as `heygen:liveavatar-lite` at the vendor's per-minute price. Ending a call ends its
face in the database but leaves the seconds since the last heartbeat to that metering (right after commit), and the
daily maintenance bills any ended face whose seconds are not all in the ledger (a call the reaper closed, a
metering that failed): `maintenance.call_faces`. The month's video minutes count each face by the clock, whether or
not its billing ran yet. Clone characters are
metered per unit as `elevenlabs:<model>` at its per-1,000-characters price. Both are purpose `speech`, so the
platform's daily cap counts them and a person's AI cap does not; the call's speech budget (§2.5) bounds the clone.

**Built-in presence** (`presence.ts`, `presence.css`): concentric hairlines and a soft halo drawn only from the
colour tokens, so it follows the theme. The outer ring and halo follow the vEIR's voice (the playback
`AnalyserNode`; a gentle synthetic pulse when the browser voice or captions-only mode leave nothing to
measure), the inner ring follows the founder's microphone, an arc turns while connecting or thinking, and each
sentence gives the halo a soft lift. Levels reach CSS as custom properties set through the CSSOM, which the
strict CSP allows. With `prefers-reduced-motion` it is still and the state shows only in words. It implies no
likeness: the face is the vEIR's monogram (serif initials in a hairline ring) unless the EIR consented to a
portrait. It is the face whenever no vendor face is live.

## 5. Privacy, consent and safety

- **Audio.** The founder's voice goes from the browser straight to Amazon Transcribe in us-east-1 (inside
  the AWS account boundary the platform already uses); our API never receives it. Neither the founder's
  audio nor the synthesized speech is recorded or stored.
- **What is stored.** The words of a call are the conversation's turns, kept, validated, shown and deleted
  like chat (temporary chats keep nothing once they end). What the founder heard of an interrupted reply is
  stored on its turn and redacted with it. The `calls` row holds identifiers and numbers only.
- **The grant** is a presigned URL with fixed stream parameters. It carries the API role's temporary session
  token, never its secret key, and is never logged or stored for idempotent replay. It can open streams for
  30 s, and a stream it opened runs until the browser closes it: a modified client could open several
  streams in that window and keep them open after its call ended, unmetered. Grants are therefore minted only
  for a live call that passes every heartbeat check, and are capped per call and per person per day. The
  residual exposure is bounded by those caps and by the account's Transcribe quotas.
- **Validated speech only.** A call speaks only signed units the validators approved, the signed intro,
  whole sentences of a stored validated reply, or the fixed crisis support message. Units of a reply that is
  blocked in the end are never spoken again. The vEIR never claims to be its EIR: the intro (on a first meeting)
  names it the EIR's digital twin under a name that is not the EIR's, and a person-edited opener that names an
  EIR or breaks the identity rules is left out.
- **Disclosure.** Said once, in the welcome stored with the person (a call opened first says it on its start
  screen, beside the voice notice; Start call stores both); the tile's badge keeps it a tap away. The intro
  introduces the vEIR only on a first meeting ("Hi Maya, I'm Corin's vEIR, Corin's digital twin."), and greets
  afterwards.
- **Voice consent.** A vEIR speaks with its EIR's chosen voice only while the EIR's consent covers `voice`;
  otherwise calls are refused rather than switched to another voice. Heartbeats re-check the consent, so a
  revoked or expired consent ends a live call within 15 s. The EIR's cloned voice (§4) also needs `voice`;
  withdrawn mid-call, the call goes on in the platform voice. Likeness (portraits, the video face) needs
  `likeness` consent and is not used by the built-in presence; withdrawn, the face ends at once. Each scope can
  be withdrawn on its own (`POST /consents/:id/withdraw-scope`) without suspending the vEIR.
- **Crisis.** Spoken turns go through the same risk classification and crisis path as typed ones: a crisis
  is answered with fixed human-support text, no model call, and a P1 escalation draft the founder chooses to
  share. On a call the fixed spoken message is played for the turn's author whatever the call's state, the
  switches and the spend caps (it is not model output), in the call's voice while approved and in the
  platform voice otherwise, for 10 minutes after the turn and at most 5 times (reserved atomically before
  each synthesis, so concurrent requests cannot exceed it); the written message stays on screen.
- **Safety and cost.** Spoken turns go through the same validators, escalation and memory approval as typed
  ones. The AI kill switch, `calls_enabled`, the platform's daily spend cap (which counts speech and
  speech-to-text), the caller's own AI cap (which counts their model spend, not speech), the per-call and
  daily minute caps, the speech budgets (§2.5) and the spoken-turn rate limit always apply to everything but
  the crisis message.
- **Before a production voice launch**, the University's privacy review covers student voice processing
  by Amazon Transcribe and the first-call notice.
