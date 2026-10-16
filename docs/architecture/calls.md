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

**Latency budget** (end of the founder's speech to the first audible word; P50, warm; estimates to measure):

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

| Endpoint                                                 | Who                          | Result                                                                                                |
| -------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `POST /sessions/:id/calls` `{inputMode, replace?}`       | founder/team, as themselves  | 201 `{call, sttGrant, intro}`. Never stored for idempotent replay (the grant is a credential).        |
| `GET /calls/:id`                                         | founders, team, assigned EIR | `{call, summary}`; the summary once the call ended.                                                   |
| `POST /calls/:id/stt-grant`                              | the caller                   | A fresh Transcribe URL on reconnect or unmute, under the heartbeat's checks (20 per call, 100 a day). |
| `POST /calls/:id/heartbeat` `{state, micOpenSeconds}`    | the caller                   | `{remainingSeconds, action: continue \| terminate, reason}`. A terminate also ends the call.          |
| `POST /calls/:id/end` `{reason, clientStats?}`           | the caller                   | `{call, summary}`. Idempotent: an ended call is returned as it is, with its first reason.             |
| `POST /turns/:id/interrupt` `{callId, heardSeq, heard?}` | the caller                   | 204. Records what the founder heard of the reply (verified); the first record wins.                   |
| `POST /speech`                                           | the caller, in a live call   | `audio/mpeg`, streamed (§2.5).                                                                        |

Someone else's call or turn is 404, as is a conversation the caller cannot see. Refusals:

| Status | Code                  | When                                                                                                                  |
| ------ | --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 403    | `forbidden`           | The caller lost write access to the venture (archived, or no longer founder or team).                                 |
| 409    | `conflict`            | A live call in another conversation (unless `replace`); the call ended or went silent; its time limit or 90-turn cap. |
| 409    | `session_ended`       | The conversation has ended.                                                                                           |
| 423    | `persona_suspended`   | The vEIR is suspended, or its own voice is no longer covered by voice consent.                                        |
| 423    | `assignment_inactive` | No active assignment, or it changed since the conversation started.                                                   |
| 429    | `rate_limited`        | Today's call minutes are used (`Retry-After`: midnight UTC); 40 spoken turns in 10 minutes; grant limits.             |
| 429    | `spend_cap_reached`   | The daily AI spend caps.                                                                                              |
| 503    | `ai_disabled`         | The AI kill switch, or `calls_enabled` is off.                                                                        |
| 501    | `speech_unavailable`  | No speech service here (local development): the client types and the browser speaks. Sent after every other check.    |

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
calls until now, but never more than 30 s after their last heartbeat. A call whose client went away is
closed there (at its next start, heartbeat or end, or by `callsRepo.reapStaleCalls`), so the count is the
same before and after it is closed.

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
more than the wall time since the previous heartbeat, and on a call with speech-to-text what it adds is
metered (§2.7).

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
- **Signed units.** The turn engine streams each validated unit of the spoken reply as `turn.speech`, signed
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

  It checks the kill switches, the active assignment, the voice consent, the call's time left and the daily
  spend caps, and only then reports 501 where no speech service runs.

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

`POST /calls/:id/end` stores the client's numbers and returns the summary: turn count, duration, AI memory
proposals from the call's turns still awaiting review, their next actions (each once, at most 10) and
escalations drafted from them. A summary lists what its reader may open: an assigned EIR, who reads only the
turns sampled for review, sees the count and follow-ups of those turns.

### 2.7 Metering and audit

- Each synthesis is a `usage_ledger` row with purpose `speech` (characters, Polly price per engine),
  counted by the platform's daily cap (not by a person's own AI cap: call minutes bound speech), and is added
  to `calls.speech_characters`.
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

<!-- Owned by the web calls stream: CallProvider and the mini call bar, the call layout, CallEngine
(AudioWorklet capture, end-of-turn detection, pipelined playback, barge-in, heartbeat, typed fallback),
entry points, and the after-call summary. -->

## 4. Avatar provider seam

<!-- Owned by the web calls stream: the AvatarProvider interface, the built-in presence orb, and what an
Anam or HeyGen LiveAvatar adapter needs (CSP hosts, Secrets Manager key, token route, consent). -->

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
  blocked in the end are never spoken again. The vEIR never claims to be its EIR: the intro states it is an
  AI coach under a name that is not the EIR's, and a person-edited opener that names an EIR or breaks the
  identity rules is left out.
- **Disclosure.** The intro says the vEIR is an AI; the call screen keeps the one-line AI disclosure.
- **Voice consent.** A vEIR speaks with its EIR's chosen voice only while the EIR's consent covers `voice`;
  otherwise calls are refused rather than switched to another voice. Heartbeats re-check the consent, so a
  revoked or expired consent ends a live call within 15 s. Likeness (portraits, vendor avatars) needs
  `likeness` consent and is not used by the built-in presence.
- **Crisis.** Spoken turns go through the same risk classification and crisis path as typed ones: a crisis
  is answered with fixed human-support text, no model call, and a P1 escalation draft the founder chooses to
  share. On a call the fixed spoken message is played for the turn's author whatever the call's state, the
  switches and the spend caps (it is not model output), in the call's voice while approved and in the
  platform voice otherwise, for 10 minutes after the turn and at most 5 times; the written message stays on
  screen.
- **Safety and cost.** Spoken turns go through the same validators, escalation and memory approval as typed
  ones. The AI kill switch, `calls_enabled`, the platform's daily spend cap (which counts speech and
  speech-to-text), the caller's own AI cap (which counts their model spend, not speech), the per-call and
  daily minute caps and the spoken-turn rate limit always apply to everything but the crisis message.
- **Before a production voice launch**, the University's privacy review covers student voice processing
  by Amazon Transcribe and the first-call notice.
