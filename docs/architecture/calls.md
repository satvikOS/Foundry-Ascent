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
                    { channel: 'voice', callId, speechAudio: 'pcm' }
        ◄─ SSE turn.speech { seq, text, sig, audio } … turn.completed | turn.blocked
           turn.audio { seq, pcm, sampleRate, end }  ◄─ reserve, meter ─► ElevenLabs (Polly on failure)
        each unit played as its PCM arrives, in order (the server voices the next while one is sent)
a unit without `audio` (crisis line, a face, a failure) ─► POST /speech { sessionId, turnId, seq, text, sig }
barge-in ─► stop audio, abort the turn, POST /turns/:id/interrupt { callId, heardSeq, heard }
every 15 s ─► POST /calls/:id/heartbeat { state, micOpenSeconds } ─► { remainingSeconds, action, reason }
end ─► POST /calls/:id/end ─► { call, summary }
```

No audio passes through our API: the browser streams the founder's voice straight to Amazon Transcribe and
plays Polly audio that the API streams back for validated text only. The API stays request/response plus
SSE, with no always-on infrastructure.

**Latency budget** (end of the founder's speech to the first audible word; P50, warm; estimates to measure,
now measurable stage by stage: [latency runbook](../runbooks/latency.md)):

| Stage                                              | Budget          |
| -------------------------------------------------- | --------------- |
| End of speech → turn sent (stable partial + quiet) | 300–950 ms      |
| Browser → CloudFront → warm Lambda                 | 50–100 ms       |
| Authorization, risk classification, retrieval      | 100–300 ms      |
| Model time to first token                          | 500–1,100 ms    |
| First sentence through the sentence gate           | 100–150 ms      |
| Unit signed → first voice bytes in the turn stream | 150–300 ms      |
| Delivery and playback start                        | 30–80 ms        |
| **Total**                                          | **≈ 1.2–3.0 s** |

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
| `POST /calls/:id/face/interrupt`, `/face/end`                | the caller                       | 204. Barge-in on the face; the face is no longer shown (its vendor session ends; `/face/end` may say why, `{reason?, vendorReason?, stage?, detail?}`, audited and logged).                                                                                    |

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

- **Speech inside the turn stream** (`speechAudio: 'pcm'`, what the call screen sends; latency runbook §5). The
  checks of `POST /speech` that hold for a whole turn run once, when the turn is accepted, while its model starts
  (`speech.prepareTurnVoice`: the conversation, write access, the assignment, the kill switches, the live call in
  this conversation, the vEIR's status and voice consent, the call's time left, the platform's daily spend cap, the
  voice). Each signed unit is then reserved like a `POST /speech` unit (`reserveCallSpeech`, one statement: its play
  and the speech budgets, and a gate on what was decided once: the platform settings unchanged since the turn read
  them, so a kill switch, a voice switch or a cap changed mid-reply stops the next unit; the platform's daily spend
  under its cap; for the EIR's own voice, their voice consent still in force and the clone still ready under it; a
  gate that no longer holds closes the unit `failed`, and `POST /speech` decides it anew) and synthesized as raw PCM the moment it is written (the unit before it as context, the
  vendor connection warmed when the turn starts, at most two units at once), and its audio follows it in the same
  SSE stream as base64 `turn.audio` frames; the stream ends after the last unit's audio. Metering, settlement,
  the audit (`speech.synthesized`, `inTurn`) and Polly in place of a vendor that fails are those of `POST /speech`.
  A unit voiced here is played: asked again at `POST /speech` it is refused as already spoken. Never voiced here:
  the crisis support line, a call whose FULL face voices text or whose LITE face the server relays (a LITE face the
  page feeds gets a copy of the same PCM), a turn any of those checks refuses: those units go through
  `POST /speech` as before, which answers the refusal. A unit the server could not voice is closed with `failed`
  (the page asks `POST /speech`) or `paused` (a speech budget is used up). A reply that ends blocked (other than
  crisis support) or failed is withdrawn before its terminal event is written: nothing more of it is synthesized,
  billed or sent, a synthesis in flight is aborted (its reservation given back), and its open units close `refused`;
  the page drops their audio (as `POST /speech` refuses them: `turn_not_speakable`). A barge-in closes the turn's
  stream, which aborts every synthesis at once.

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

- **The intro** greets the founder by first name. On a first meeting the vEIR introduces itself once ("Hi Maya,
  I'm Corin's vEIR, Corin's digital twin."; a mentor under its own name, ADR-0021, only "Hi Maya, I'm Thomas.") and
  continues with the conversation's opener, or "What would you like to work on?". With someone it has met, it says
  the conversation's opener as written, never phrased again around what it is about and never
  put in a fixed frame (owner: "it always repeats the same question in the same way like reading a script";
  production 2026-11-06: "Hi, want to carry on with your perosnal life?"). A line that greets in its own words (the
  model-written next opener, and the greeting that names nothing `chooseOpener` falls back on) keeps its greeting
  ("Good to see you again, Maya. What did the student union say?"; `ownGreetingLine`); a line without one (a
  person's own) follows the call's "Hi Maya, …", unless it says the founder's name some other way ("Maya's
  clinics") while the name budget has no room: then the call invites, and the conversation keeps the line. With no
  opener, the call says hello and an invitation that names
  nothing, varied from call to call ("Hi Maya, what's on your mind today?"; "…where shall we carry on?" on a
  conversation under way).
  The founder's name is said in a greeting one reply in four at most, as in every reply (`greetedName`, read from the
  vEIR's latest replies to them: this conversation's, or the end of the last ones), never twice in one line (a model
  line that names them already, after its greeting's comma or later, is said as written), and a model line that calls
  them by name when the budget is spent is said without it ("Good to see you again. What did …"; `withoutVocative`),
  or after a plain "Hi," without its greeting when it cannot be. A greeting the opening line said ("Hi …", and a model
  line's own: "Good to see you again", "Nice to see you"; `openerSaidHello`) means the first reply does not greet
  again; a line that only welcomes them back ("Good to have you back") still leaves a hello a hello back. The opener
  is chosen afresh at call start for a conversation nobody has said anything in (`chooseOpener`; no model call on the
  way to the first word: the line was written at distillation), and kept in the same transaction: the intro becomes
  that conversation's first message (`coaching_sessions.opener`, replayed by the turn engine) when it says the opener,
  so the vEIR's history holds the greeting it gave and its first reply never greets again (the sentence gate and the
  validator leave a greeting out); a bare invitation never replaces a substantive opener (`openerKept`). The vEIR introduces
  itself by its persona name unless that name presents it as an EIR ("Corin Halvorsen", "Coach Corin"); it then
  says "Corin's vEIR". The opener is a person-editable note: it is stored, shown and spoken only if it names no EIR
  at all and passes the identity rules and the cross-venture check; otherwise it is left out. None in a temporary
  chat.

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
- **End of turn (hands-free, adaptive endpointing).** A segment Transcribe finalised, a partial whose words are
  all marked stable, or a partial that stopped changing (for 250 ms at most); plus the quiet what was heard needs,
  counted from the last voiced frame of the energy VAD (adaptive noise floor, two-frame onset; no WASM, so no
  `wasm-unsafe-eval`): **300 ms** after a finished sentence (Transcribe's full stop), a question (its question
  mark, or the shape of one: an auxiliary before its subject, "can we", "how do I", "what's the"; a question word
  alone opens statements as often, "when we launched last year") or a short answer that closes a turn ("yes",
  "no", "thank you", or any short answer with its full stop); **500 ms** after a line that reads as finished
  without either, or an unpunctuated "yeah", "okay", "probably"; **950 ms** after one left open: a trailing filler
  ("um", "uh"), a conjunction, article, subject pronoun, copula or "to"/"of" ("and", "so", "because", "the",
  "is"), a self-correction ("I mean", "sorry"), a trailing comma or ellipsis, or a fragment of one or two words
  (its last word decides first: Transcribe's final result puts a full stop even after a dangling "and"). While
  the transcript lags the voice (its last result came more than 200 ms before the last voiced frame), the old
  600 ms applies. Tuning `endpointing: 'fixed'` switches back to one 600 ms silence. Updates of a segment already
  sent only count for the words after the sent ones as revised (Transcribe revises a sent tail as the founder goes
  on: past the shared words, the shortest run closest in spelling to the sent tail is its revision, so "the
  pilots" → "the pilot for small clinics" adds "for small clinics" and "cannot" → "can not" adds nothing); a
  revision that drops added words drops them. Push-to-talk sends silence until held and ends the turn 700 ms after release. Lines finished while the
  vEIR is still answering wait and go together after it.
- **Taking a line back (a slower speaker).** When the founder goes on within 3 s of a hands-free line being
  sent (two words or a settled one that are neither a filler nor a backchannel), the line is taken back, but only
  while nothing of its reply has arrived (no unit) and only once the server classified it as ordinary (its
  `classifying` status carries no `sensitive` label: a crisis line's support and escalation are never taken back;
  a line not classified yet is not either). Its turn stream is aborted, the interrupt is posted with
  `heardSeq: -1` whenever the turn id is known, and the line's words go back to the endpointer as Transcribe now
  has them (a revised word, a word added to the same result, a retracted one), ahead of what followed: the whole
  line is sent again when the founder finishes, even when the words that took it back are retracted. Whatever
  the server made of the cancelled turn (failed, or kept because a unit was already on its way or the disconnect
  was noticed late), the conversation history says the line once: a turn of which nothing was heard whose words
  the next line repeats and goes on from is left out (`historyAsHeard`). Muting, typing or switching how to talk
  sends a line taken back instead of dropping it. Once a unit has arrived, the founder's words wait for the reply
  or barge in as before. The turn request carries `endpointing {decisionMs, waitMs, reason, resumed}` (numbers
  and a reason, logged in `turn.timing`). The take-back saves a line only while the reply is slower than the
  founder's pause: with first audio at the 0.7–1.2 s target, a line that pauses ~1 s after a finished sentence
  is answered in half, as fixed endpointing answered it ([latency runbook](../runbooks/latency.md), "End of
  speech").
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
  backchannels never become a turn, also when heard between the reply's sentences. A settled backchannel
  restores the volume at once and never counts as noise; a duck no word confirms restores the volume; after
  three, the call suggests push to talk. Typing while it speaks, Esc and
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

**The face's invariant depends on its mode.** **LITE** (the EIR's own avatar; voicing `audio`): the face only
renders audio our server made from a signed unit, and the server relays it itself, so nothing else can reach the
face. **FULL** (a vendor stock avatar in its stock voice; voicing `text`; platform admins and people a platform admin gave Video face only, labelled "AI
avatar"):
the face is only handed text our server admitted from a signed unit (each unit once, in order), and the server
reconciles the vendor's session transcript against the admitted text at every heartbeat, ending the face on any
difference. In FULL the vendor takes commands only from the browser's room connection, so the server cannot prevent
a modified page from making the face say other text on that page's own screen; it detects it within one heartbeat.
That is why FULL is limited to platform admins and the people they name (Video face) and never renders an EIR's likeness (infra refuses both
configurations, [runbook §9](../runbooks/avatars.md#9-full-mode-a-stock-avatar-with-its-stock-voice-platform-admins-and-chosen-people-only)).
**LITE fed by the page** (a vendor stock avatar lip-syncing the call's own ElevenLabs voice; §4.4) is the weakest of
the three on purpose and for stock faces only: the face renders audio our server **admitted** (each unit once, in
order, never the crisis line), forwarded by the caller's page, with **no server-side detection** (LITE has no
transcript). A real person's likeness is never fed by the page: it stays on the server's relay (LITE) or is not
offered (FULL).

### 4.1 Seams

```text
Server (packages/core ports)                                   Vendors (apps/api adapters)
EmbodimentProvider  id fake | heygen, voicing audio, likeness  heygen-liveavatar.ts (LITE), development-face.ts
  createSession({callId, personaId, avatarRef, maxSeconds})      → browser {token, url, expiresAt}, sessionRef, control
  speak(handle, VerifiedFaceAudio) / interrupt / keepAlive / end
VoiceProvider       id elevenlabs | fake, model, price         elevenlabs-voice.ts, development-voice.ts
  synthesize({text, unit: VerifiedSpeechUnit | null, voiceRef, format, previousText?, nextText?}) · prewarm()
StockVoice          {provider: VoiceProvider, voiceRef}         the platform's ElevenLabs stock voice ("AI voice")
SpeechSynthesizer   Amazon Polly (stock voices; pcm_16000 for a face)

Browser (apps/web)
AvatarProvider      builtin (presence) | fake (canvas) | heygen (lib/realtime/embodiment/liveavatar.ts)
  connect(session, signal, relay) · video() · media() · renderer() · onLost()
FaceRenderer        render(buffer, output, handlers, audio: {pcm, manifest} | null) → stop · setVolume(v) · level()
FaceRelay           speak(audio) → POST /calls/:id/face/speak · interrupt() → POST /calls/:id/face/interrupt
CallFaceController  features/calls/use-call-face.ts: one per engine; the face belongs to the call
```

Configuration: `MEDIA_FACE_PROVIDER` (`none` | `heygen-liveavatar`), `MEDIA_FACE_SANDBOX`, `MEDIA_FACE_MODE`
(`lite` | `full`), `MEDIA_FACE_AVATAR_ID` and `MEDIA_FACE_VOICE_ID` (FULL only: the stock avatar and, optionally,
its voice; empty in LITE, where the face is always the persona's own), `MEDIA_FACE_AUDIENCE` (`admins` |
`everyone`), `MEDIA_VOICE_PROVIDER` (`polly` | `elevenlabs` | `elevenlabs-stock`), `MEDIA_VOICE_ID` (the stock
voice, `elevenlabs-stock` only), `MEDIA_VOICE_FALLBACK_VOICE_ID` (the Polly voice of the stock voice's gender that
says a unit it fails on, `elevenlabs-stock` only), `MEDIA_VOICE_MODEL`, `MEDIA_VOICE_ZERO_RETENTION` (infra `media`; production.json
ships the HeyGen sandbox stock face for admins and the ElevenLabs stock voice for everyone,
[docs/runbooks/elevenlabs-voice.md](../runbooks/elevenlabs-voice.md); infra refuses `full` without a stock avatar or with an audience other than
`admins`, and a stock avatar or voice with `lite`). Each reaches the API only when `apps/api/lambda-contract.json`
lists it for the `api` role; synth refuses a configured value that no role lists unless it is what the API assumes
without the variable (the LITE defaults), so a FULL configuration cannot deploy with its variables dropped.
Vendor keys come from Secrets Manager (`foundry-ascent/media/heygen`, `foundry-ascent/media/elevenlabs`, JSON
`{"apiKey"}`; names and prices in `packages/core/media-vendors.json`), read on first use, cached 5 minutes, never
logged, never sent to the browser. The local API runs stand-ins with `EMBODIMENT_PROVIDER=fake` and
`VOICE_CLONE_PROVIDER=fake` (refused outside development).

### 4.2 Only validated speech reaches the face and the clone

- **The clone** is handed only a `VerifiedSpeechUnit`, which only `verifiedSpeechUnit()` makes, from a unit whose
  signature (`sessionId|turnId|seq|text`, after the identity guard, meta-narration gate and sentence gate) verifies
  in that request. Passages of a stored reply (unsigned) and the crisis line use a stock voice. It speaks only in a
  call that started with it (`calls.voice_vendor`), while `cloned_voice_enabled` is on and the persona's voice is
  ready under `voice` consent; otherwise the next unit is the call's stock voice (the deployment's ElevenLabs "AI
  voice" while `vendor_voice_enabled` is on, else Polly), or the platform voice when that
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
- **FULL: admitted text, then reconciliation.** For a text face, `POST /speech` returns the stock-voice fallback
  audio only (no manifest). Every unit the face says is admitted by the server first: a signed unit of the caller's
  live call (never the crisis line, never a blocked or failed reply), within the kill switches, the platform's spend
  cap and the call's speech budget (reserved once per unit), each unit once and in order
  (`twinRepo.admitFaceText`), with salted digests of its words stored for the transcript check. Only then does the
  browser publish `avatar.speak_text` with that text into the vendor's room (no microphone track, push-to-talk never
  started, no vendor context, so the vendor's own model never speaks).
  - **Pre-approval (the common path).** When a spoken turn starts on a call whose FULL face is live, the turn engine
    admits each unit with those same checks as it signs it (`SpeechService.prepareFaceApproval`: the call, its face
    and the platform settings read once per turn, in one statement; then each unit's checks and writes in one
    statement, `twinRepo.admitPreapprovedFaceUnit`, which admits it only while the settings are still those read, and
    reads the day's spend, the speech budget's counts and the face's order as it admits it; a unit it refuses, a
    settings change included, goes through `face/say` on the settings of that moment) and streams it as
    `turn.speech` with `face: true`, a flag the unit's signature covers
    (`sessionId|turnId|seq|text|face`). The browser publishes such a unit at once: no browser-to-API round trip
    sits between the unit's arrival and the face. The admitted row is marked `call_face_texts.preapproved` (0020).
    A unit the server does not pre-approve is streamed without the flag, and after the first one nothing more of
    that turn is pre-approved, so the units the browser still asks for keep their order. Each unit's approval time
    is logged (`turn.face_approval`, ms), since it sits before the unit is sent.
  - **A streamed reply blocked or failed afterwards.** A streamed reply's units are admitted as they are sent,
    before the whole-reply check. When the turn is then blocked or fails, the turn engine (after `turn.blocked` /
    `turn.error`) reads the face's transcript and withdraws the turn's pre-approved units it has not shown, except
    the first of them (the one an honest page may be handing over as the turn ends: it hands units over one at a
    time, stops at `turn.blocked`, and on `turn.error` drops the approval of the units it still holds, which then go
    through `face/say` and are refused), and gives back their speech reservations (audited
    `call.face_text_withdrawn`). So the face can say no more of such a reply than `face/say` would have let it, and
    a page that makes it say more ends the face at the next check (`call.face_injection`). When the transcript
    cannot be read to its end then, nothing is withdrawn; the heartbeat decides that face.
  - **`POST /calls/:id/face/say` (the fallback).** For any other unit (the call intro, a face that joined mid-turn,
    a refused pre-approval), when its turn comes the browser asks `{sessionId, turnId, seq, text, sig}`; the server
    makes the same checks and only on its 204 does the browser publish. Anything else is a 422 and nothing is
    published. It is idempotent with pre-approval: asked for a pre-approved unit with the same words, it answers 204
    again without reserving or storing anything more; a unit it admitted itself is refused if asked again. At each heartbeat the server reads the vendor's transcript since the last check and compares
    the avatar's lines with the admitted texts; a difference ends the face (audited `call.face_injection`).
- **The vendor's control protocol** (LITE events): the server waits for `session.state_updated: connected` before
  any command, sends one-second `agent.speak` chunks each with its own `event_id`, waits for every
  `agent.audio_buffer_appended`, and on a unit's last part sends `agent.speak_end` and waits for
  `agent.audio_buffer_committed` before closing; `error` fails the hand-over (the call then plays the unit itself).

### 4.3 The face of a call

1. The call settings (`GET /ventures/:id/call-config`) name the face only while `faces_enabled` is on, a provider
   is wired (a vendor sandbox, which shows the vendor's stock avatar, or an `admins` audience, only to platform
   admins: the owner's live checks and FULL presentations) and, for a real likeness, the persona's face is ready
   under `likeness` consent (`app.persona_twin`; a stock avatar needs none and is labelled "AI avatar"), with the
   video minutes left (`faceMinutesLeft`).
2. **A video call waits for its face** (owner round 3, 2026-11-06: "just load the actual avatar, then the
   conversation starts"): the engine opens the call on the server (`awaitingFace`, the microphone asked for within the
   click but nothing of it heard or sent), the call tile says "Connecting to Thomas…" (no sphere, no stand-in), and
   only once the face's first frame arrived and its speak channel is open does the conversation start
   (`CallEngine.startConversation`): the face says the intro, then the founder is heard. The call's
   `CallFaceController` asks `POST /calls/avatar-session {ventureId, callId}`. The server opens a vendor session only
   for the caller's own live call in that venture with that persona, for at most the call's time left, the per-call
   video limit (`face_minutes_per_call`, 20, every session of the call counted) and the person's video minutes this
   month (`face_minutes_per_principal_month`, 60), never above the platform spend cap, outside any transaction. A call
   has one `call_faces` row holding its current session; a face the page dropped (`face_dropped`) is replaced in that
   row by the next session (migration 0030: `sessions`, at most `faceSessionsPerCall(face_minutes_per_call)`: enough
   90 s sessions for the call's whole video limit plus 6, so 20 at the default 20 minutes, never above 100;
   `earlier_seconds`),
   after the ended session was metered to its end, and each replacement is audited (`call.avatar_session`
   `metadata.session`). A face the server stopped (a cap, the switches, a failed or injected transcript, the call's
   end) is never opened again in that call, and neither is one the page dropped for a crisis turn (`face_crisis`) nor
   any face of a call that had a crisis turn (`crisis_support`, read from the call's turns): the server enforces it,
   not only the page. The vendor session carries its limit (`max_session_duration`); a vendor
   that refuses it opens no session. Anything else answers the presence (no token); the audit names the provider and
   the reason (`face_already_used`, `face_sessions`, a cap), never a token.
3. The adapter (its own chunk) joins within 8 s; at the first frame the same tile shows the face, the name tag
   stays, the founder's initials sit in the corner, and the engine hands the face each unit (§4.2). A unit is
   announced at the face's first sound (the vendor's speak event, or its audio track's level); a unit the face
   cannot start within 3 s, or the server refused, is played by the call itself (at once when the face is lost
   before the unit's first sound, so the vendor ending its session leaves no gap).
   - **Seen and heard together** (`embodiment/face-media.ts`, LITE and FULL alike). The avatar's video and audio
     tracks play in **one** media element, one `MediaStream` with both tracks, unmuted, and the tile shows that very
     element (`media()`), so the voice goes from WebRTC's jitter buffer to the speakers as the picture goes to the
     screen. (Until 2026-10-31 the audio went through the call's Web Audio graph while a muted `<video>` showed the
     face: the voice also crossed the `AudioContext`'s buffering and output latency, large on Bluetooth, which the
     picture never waited for, and the mouth looked lagged.) What keeps the two in step beyond that is WebRTC's
     receiver-side audio/video sync, which does not depend on the element: it pairs the tracks only when the vendor
     sends them in one remote stream (the same msid), and not at all in Firefox; the face lab records whether it
     does (`av_same_stream`, [avatars.md §8](../runbooks/avatars.md)). The call never plays the face's sound itself: it taps the audio track with an analyser connected to
     nothing (`MediaStreamSource → AnalyserNode`, no output), which gives the unit's first sound for the heard-units
     accounting and the captions, and the presence's level. Ducking sets the element's volume (`setVolume`, 0.2 while
     a possible barge-in is confirmed); barge-in, the end of a unit's turn or a unit given back to the call mute the
     element at once (volume 0 and `muted`, since iOS ignores `volume`), before the vendor's interrupt arrives, and
     the face's next unit turns it up again; ending the face pauses the element, empties it and takes it off the
     page. A call starts on a click and captures the microphone, so the browser lets the element sound; if it
     refuses (`play()` fails with `NotAllowedError`), the element plays muted (the face still shows) and the voice is
     routed into the call's own output through a gain barge-in can close. At the founder's next gesture that carries
     user activation (`pointerup`, `touchend`, `click`, `keydown`; never `pointerdown`, which on a touch screen
     carries none, and Safari grants playback per gesture) the element asks again within the gesture, unmuted at
     volume 0 while that route still plays the voice; only once its `play()` resolved with the element playing
     unmuted is it turned up and the route removed. A refused try mutes it again, keeps the route and waits for the
     next gesture, so a tap never cuts the voice. A paused element (the browser paused it) is played again.
4. **Reconnects.** A vendor session that ends during the call (the free plan's ~2 minute limit, a dropped room, video
   track or speak channel, a stalled channel) is replaced at once by the next session of the same call: the tile shows
   the face's last frame, dimmed, under "Reconnecting…"; the call's speech waits for the new face
   (`SpeechPlayer.holdForFace`: nothing new starts and nothing is prepared, the turn stream's audio stays buffered);
   a unit the old face gave back before a word of it was heard is said by the new face from a copy the call kept for it
   (`spare`), a unit cut partway is finished on the call's own speakers from where it was heard (never doubled, never
   lost); the turn's end is re-sent to the new face. A session within 25 s of its `expiresAt` is replaced early at a
   quiet moment (the founder's turn, nothing being said or queued), so the next reply rarely waits on a join. If no
   session comes back (the server offers none: credits, minutes, caps, the switches; or the join fails), or a video
   call's first face cannot start, the tile says "Video isn't available right now", that the conversation is kept, and
   offers **Voice call** (one tap; a call still waiting for its face starts its conversation then) and **Try again**;
   the call never turns into a voice call by itself. Switching a voice call back to video asks for a new session too.
   A server-relayed likeness face (LITE `server` route) does not replay a unit its ended session already took
   (`call_speech.face_plays`): the call says it itself.
5. The face belongs to the call: minimizing keeps it (the mini bar shows it as a thumbnail, the video alone and
   muted, or the monogram with reduced motion; the face's element plays on, still sounding, in a hidden 1 px spot
   of the page and returns to the tile when the call is shown again, so minimizing never cuts or doubles the voice).
   The call screen (mounted for the whole call, minimized or not) asks for the face as well as the tile, so a video
   call minimized while it was still starting still gets its face and its conversation; the mini bar says
   "Connecting to Thomas…", "Reconnecting…" or that video is not available meanwhile. A face that drops, the stage giving it up, or a call left on hold (page hidden) for over a minute (the vendor
   bills an idle face; a new session opens when the call resumes) tells the server (`POST /calls/:id/face/end`), with which trigger fired (`reason`: the
   vendor's video track ended or was unpublished, its room dropped, it stopped the session, with its own
   `vendorReason`, no first frame, a slow or failed join, no adapter, a crisis turn, the hold), and for a face that
   never showed the join stage it stopped at (`stage`: session, adapter, room, video, a LITE stock face's speak
   channel `control`) and a plain code (`detail`), recorded in the face's `call.face_ended` audit
   (`metadata.clientReason`, `clientStage`, `clientDetail`) and logged by the API (`call.face_failed` for a
   failure), so a face that left early, or never came, can be explained.
6. Heartbeats report whether the face is shown (neither while a session is being replaced, so the new one is not
   ended as it joins) and answer `face: stop` (and the server ends the vendor session,
   asking twice if the first stop fails) when faces are switched off, likeness consent is withdrawn, the call's
   video limit or the month's video minutes are used up, the month's minutes cannot be read (the face never goes
   on unchecked), or the face is no longer shown. A crisis turn drops the face at once: a human-looking face never says
   the crisis line, and no face comes back in that call (once the support is read, the video tile says video is not
   available and offers the voice call; the server refuses another face, step 2). Ending the call ends its face (a database trigger erases the
   control channel; the vendor session is stopped after commit).

**Metering.** Face seconds come from the server's clock and go into the usage ledger as heartbeats come and when the
face or the call ends, in the same transaction as the counter (`call_faces.metered_seconds`, never beyond the
face's limit: exactly once), as `heygen:liveavatar-lite` or, for a FULL face, `heygen:liveavatar-full` (by the mode
stored on the face) at that mode's per-minute price. Ending a call ends its
face in the database but leaves the seconds since the last heartbeat to that metering (right after commit), and the
daily maintenance bills any ended face whose seconds are not all in the ledger (a call the reaper closed, a
metering that failed): `maintenance.call_faces`. The month's video minutes count each face by the clock, whether or
not its billing ran yet. Clone and stock-voice characters are
metered per unit as `elevenlabs:<model>` at its per-1,000-characters price. Both are purpose `speech`, so the
platform's daily cap counts them and a person's AI cap does not; the call's speech budget (§2.5) bounds them.

**The stock vendor voice** (`MEDIA_VOICE_PROVIDER=elevenlabs-stock`): every unit a clone does not take (never the
crisis line, which is always Polly) is said by the ElevenLabs stock voice, labelled "AI voice" (`call-config.voice`).
Its words are the unit's spoken form with numbers, symbols and addresses written out (`speech-text.ts`); the signed
units around it, verified, go along as `previous_text`/`next_text`. A page that plays PCM as it arrives asks for
`audio/pcm` and gets the vendor's 24 kHz PCM streamed (Polly's 16 kHz on fallback), played after a 100 ms jitter buffer
(`apps/web/src/lib/realtime/pcm-stream.ts`); faces keep whole WAV units with their manifest. A vendor failure before
the first audio (2 s deadline) is said by Polly in the same response and reservation, and the vendor rests 60 s.
That Polly voice is the stock voice's own stand-in (`MEDIA_VOICE_FALLBACK_VOICE_ID`, the same gender), not the call's
Polly voice, so a failure never changes who seems to be speaking.

**Built-in presence: the voice sphere** (`sphere.ts`, `sphere.css`, `features/calls/voice-sphere.tsx`): a soft,
cloud-textured orb (an original generated texture, `apps/web/scripts/generate-sphere-clouds.mjs`, over the voice
palette) centred on the call's canvas. Its state is the call's real state: idle and connecting breathe slowly in CSS;
listening drifts and follows the founder's microphone RMS; speaking moves only with the playback `AnalyserNode` level
of audio actually playing (silence, captions-only and browser-voice replies never animate it); thinking turns the
clouds evenly; muted, on hold, sound off and disconnected are desaturated and still. Per-frame work is a few
compositor-only transform and opacity writes from the call's one frame loop (`timeline/call-timeline.ts`), never a
React render; it pauses with the page. With `prefers-reduced-motion` it is still and the state shows only in words.
It implies no likeness. The sphere is a **voice** call's presence only (owner, 2026-11-06: the drawn in-browser
character is removed, and video has no stand-in presence): a video call's 16:9 tile says "Connecting to Thomas…" until
the vendor face shows its first frame (the conversation waits for it), "Reconnecting…" while a new session replaces one
the vendor ended, and if video cannot start or come back, "Video isn't available right now" with **Voice call** and
**Try again** (§4.3); the call never
turns into a voice call by itself. Every live face is labelled "AI avatar", a stock avatar and a consented likeness
alike.

**Conversation timeline** (`features/calls/timeline/`): who spoke when, as 10 Hz RMS bins from the same frame loop
(the vEIR from the playback level while it speaks, the founder from the microphone while their voice is detected),
drawn on one canvas at most ten times a second, with a keyboard-reachable button per turn. It lives in the page's
memory only and is dropped with the call; a past session without measured audio would draw a flat midline.

### 4.4 A LITE stock face fed by the page

`media.face.mode` `lite` with `liteRoute` `browser` (the default with `stock`; `MEDIA_FACE_LITE_ROUTE=browser`) shows a
vendor **stock** avatar, labelled "AI avatar", that lip-syncs the call's own voice (the ElevenLabs stock voice, Polly
on fallback). Measured in the vendor sandbox (lab run 42087743218, docs: spec lite-elevenlabs-design §8): LITE takes
audio only over its WebSocket (`ws_url`, always at `wss://webrtc-signaling.heygen.io`), accepts a browser socket from
the production origin, ignores data and audio published into the room, keeps one socket per session (a second one
replaces the first), cuts an utterance with the next one (no queue), and sounds on the avatar's track about 0.56 s
(p50) after the first chunk.

- **Server.** `POST /calls/avatar-session` starts the LITE session for the call's owner (minutes, caps, kill switches
  and audience as for any face; metered at the LITE price, the sandbox at $0) and returns `controlUrl` (`ws_url`) in
  that authenticated response only: never logged, never audited, stored only encrypted. The adapter hands it over
  only at the configured origin (`media-vendors.json` `liteSocketOrigin`), which is also the one origin infra adds to
  `connect-src`. Each unit is admitted as the turn engine signs it (face pre-approval, `turn.speech` `face: true`;
  the intro through `face/say`), with the FULL checks; the face's reservation counts no characters (the page fetches
  the unit's audio from `/speech`, which counts them). `/face/speak` refuses this face, and `/face/interrupt` only
  seals and counts (it never opens a socket: one would replace the page's). The face's end is audited with its route,
  the units admitted and the barge-ins (`call.face_ended`). Core refuses a provider that asks for this route with a
  likeness (`likeness_browser_route`), as infra and the API config do.
- **Page** (`apps/web/src/lib/realtime/embodiment/lite-socket.ts`, `lite-speaker.ts`, `liveavatar.ts`). One socket per
  call, opened once the room joined; the face is live only after `session.state_updated` `connected`. The call
  fetches each signed unit's PCM as it is synthesized and hands the face a copy as it arrives (`playback.ts`, voicing
  `stream`); the face forwards only admitted units, all of a turn's units as **one utterance** (a 200 ms first chunk,
  then ~1 s chunks of 24 kHz 16-bit mono, base64, the utterance's id on every chunk; Polly's 16 kHz resampled), and
  `agent.speak_end` after the turn's last unit. A new utterance never opens while another is open: the next turn
  waits for `speak_ended` (or its interrupt). The founder hears only the avatar's audio track, in the face's one
  element; the call's own copy is played only for a unit the face gives back before it was heard (or the rest of one
  it gives back partway). A unit is heard from `agent.speak_started` (or the track's level, once it was quiet after
  the first chunk and 700 ms after a barge-in or fallback: the interrupted audio still sounds on the track ~389 ms
  and the level is measured before the element's mute), later units of the utterance where the audio before them ends,
  the last at `agent.speak_ended`; captions and the heard bookkeeping follow. Barge-in silences the element at once,
  sends `agent.interrupt`, drops everything not forwarded and tells the server; the `speak_ended` that still follows
  an interrupt is ignored. `session.keep_alive` once a minute while idle.
- **Fallback, never both, never twice.** No `speak_started` within 2 s of the first chunk, a vendor error, or the
  socket closing: the element is silenced and the vendor interrupted first, then every unit not yet heard is played
  by the call from its own copy (units already heard are not repeated); the unit being said goes back `cut` at the
  point heard (from where each chunk played) and the call plays only its rest from its copy (`PcmStream.skip`). A
  closed socket or a second stall ends the face (`control_lost`, `speech_stalled`): the presence and the speakers
  carry on.
- **Time limit.** A new turn's utterance never opens when the session's `expiresAt` (the vendor's
  `max_session_duration`; about a minute in the sandbox) is closer than an estimate of that turn (its units' words,
  at least 6 s): the face hands over between turns (`time_limit`) and the call says the turn from its start, so the
  sandbox's end does not cut a sentence. An `expiresAt` already past on this device's clock (skew) leaves the limit
  to the vendor's close, which the `cut` hand-over covers.

## 5. Privacy, consent and safety

- **Audio.** The founder's voice goes from the browser straight to Amazon Transcribe in us-east-1 (inside
  the AWS account boundary the platform already uses); our API never receives it. Neither the founder's
  audio nor the synthesized speech is recorded or stored, unless the founder records the call (§7).
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
  introduces the vEIR only on a first meeting ("Hi Maya, I'm Corin's vEIR, Corin's digital twin."; Thomas, a mentor
  under his own name: "Hi Maya, I'm Thomas.", what he is being said in the call's disclosure), and greets afterwards.
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

## 7. Recordings (ADR-0023)

A founder may record their own call from the call screen and watch it again later, with its transcript, or download
it, without calling the vEIR. Never a private call; only the person who recorded it can list, play, download or delete
it (list, play and download only while they still have the venture).

- **Recording (browser).** `features/recordings`: Record in the dock (keyboard `R`; a notice the first time), "● REC"
  and the time in the header while it records (on a phone "● REC" only, so the time left keeps its room), Stop to save;
  hanging up stops and saves it. Minimized, the call goes on recording and the mini call bar says so ("● REC", with
  Stop). The picture is the screen: the Record press asks the browser to share this tab (`getDisplayMedia`, the tab
  preferred and offered alone where the browser can, no tab sound, at most 1080p at 15 frames a second), so the
  recording is the call as the founder sees it (face or voice visual, captions, the conversation, the controls); the
  browser's own Stop sharing stops and saves it. Where a screen cannot be shared (iOS and iPadOS Safari, most phones)
  or the founder did not share it, `CallRecorder` composes the call view on a 1280×720 canvas instead (the face's
  video while it shows, else the presence; the vEIR's name and the time; the latest lines of both speakers from
  `CaptionRecorder.recent`), and the call screen says so above the controls (`recording-note`, with OK); so it does
  when a whole screen or window was shared rather than the tab. The sound is a WebAudio mix of the vEIR's voice (the
  player's output and a vendor face's audio track) and the microphone (silent whenever the call does not hear it:
  muted, on hold, push to talk released), never the shared screen's own, with `MediaRecorder` (webm, or mp4 on
  Safari, 1.5 Mbit/s); `CaptionRecorder` turns the call's captions into WebVTT cues. `CallEngine.recordingSources()`
  exposes the call's AudioContext, the player's output and the microphone stream without changing them.
- **Saving.** `POST /calls/:id/recordings` → presigned PUTs (the captions uploaded first, then the recording) →
  `POST /recordings/:id/complete` (sizes checked) → listed. While the call screen is open the save shows in it, above
  the controls (`RecordingSaveStatus`: Watch, or Try again and Discard); a toast says it once the screen is closed. A
  failed save keeps the file in the page, and Record waits until it is saved or discarded. While a take exists only in
  the page (recording, saving, or kept for Try again) leaving the page asks first (`beforeunload`). A save refused by
  the daily limit (`daily_recordings`) says so and offers neither Try again nor Record until it has passed.
- **Replay.** `GET /recordings/:id/playback` → presigned GETs for the `<video>` (CORS, range requests) and the captions
  file. Recordings is a section of the venture (side panel, `g r`, `/v/:id/recordings`): its rows (and the
  conversation's own list, at the end of its transcript) say when, which conversation, how long, video or sound only
  and the size, with Watch, Download and Delete. Watch (and the call screen's Watch after a save) opens the viewer,
  `/v/:id/recordings/:recordingId`: the player large, the transcript beside it (below it on a phone) marking the line
  being heard and keeping it in view, a line seeking to it, `K` play or pause and `J`/`L` ten seconds; Download, Open
  conversation and Delete. While a call is live a replay does not start by itself; on a voice call, playing it holds
  the call (microphone off) and the microphone opening again pauses it, so a replay is never heard by the call.
- **Download.** `GET /recordings/:id/download?file=recording|transcript` → one presigned GET (5 minutes) whose response
  is `Content-Disposition: attachment` under a readable name in the founder's time zone ("Thomas call 2026-11-07
  14-22.webm", "… transcript.vtt"), audited `recording.downloaded`; the browser follows it as a link, so the bucket
  needs no CORS for it and the CSP no new origin.
- **Storage.** The private recordings bucket (Data stack): exact-origin CORS, SSE-S3, a year's retention with a
  lifecycle backstop; `call_recordings` (migration 0031) holds keys, sizes, duration, cue count and lifecycle, owner-only
  under RLS. Deleting the conversation deletes its recordings (trigger), the API and the daily maintenance remove the
  files.
- **Locally** `LocalRecordingStore` stands in for the bucket (`/_local/recordings/:token`, development only).
