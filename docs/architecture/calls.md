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
        ◄─ { call, sttGrant, intro } ─────  signed intro (notebook opener)
mic ─► AudioWorklet, 16 kHz PCM frames ─── presigned wss (≤ 5 min to open) ───────► Transcribe streaming
        ◄────────────────────────── partial / stable / final transcripts ──────────┘
end of utterance ─► POST /sessions/:id/turns ─► admitVoiceTurn ─► orchestrator ─► validators
                    { channel: 'voice', callId }
        ◄─ SSE turn.speech { seq, text, sig } … turn.completed | turn.blocked
each unit ─► POST /speech { sessionId, turnId, seq, text, sig } ─► verify, meter ─► Polly
        ◄─ audio/mpeg (streamed), played in order; the next unit is fetched while one plays
barge-in ─► stop audio, abort the turn, POST /turns/:id/interrupt { callId, heardSeq }
every 15 s ─► POST /calls/:id/heartbeat ─► { remainingSeconds, action, reason }
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

| Endpoint                                              | Who                          | Result                                                                                         |
| ----------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `POST /sessions/:id/calls` `{inputMode}`              | founder/team, as themselves  | 201 `{call, sttGrant, intro}`. Never stored for idempotent replay (the grant is a credential). |
| `GET /calls/:id`                                      | founders, team, assigned EIR | `{call, summary}`; the summary once the call ended.                                            |
| `POST /calls/:id/stt-grant`                           | the caller                   | A fresh Transcribe URL on reconnect or unmute (at most 20 per call; 429 after).                |
| `POST /calls/:id/heartbeat` `{state, micOpenSeconds}` | the caller                   | `{remainingSeconds, action: continue \| terminate, reason}`. A terminate also ends the call.   |
| `POST /calls/:id/end` `{reason, clientStats?}`        | the caller                   | `{call, summary}`. Idempotent: an ended call is returned as it is, with its first reason.      |
| `POST /turns/:id/interrupt` `{callId, heardSeq}`      | the caller                   | 204. Records what the founder heard of the reply; the first record wins.                       |
| `POST /speech`                                        | the caller, in a live call   | `audio/mpeg`, streamed (§2.5).                                                                 |

Someone else's call or turn is 404, as is a conversation the caller cannot see. Refusals:

| Status | Code                  | When                                                                                                           |
| ------ | --------------------- | -------------------------------------------------------------------------------------------------------------- |
| 409    | `conflict`            | A live call in another conversation; the call ended or went silent; its time limit or 90-turn cap was reached. |
| 409    | `session_ended`       | The conversation has ended.                                                                                    |
| 423    | `persona_suspended`   | The vEIR is suspended, or its own voice is no longer covered by voice consent.                                 |
| 423    | `assignment_inactive` | No active assignment, or it changed since the conversation started.                                            |
| 429    | `rate_limited`        | Today's call minutes are used (`Retry-After`: midnight UTC); 40 spoken turns in 10 minutes; grant limit.       |
| 429    | `spend_cap_reached`   | The daily AI spend caps.                                                                                       |
| 503    | `ai_disabled`         | The AI kill switch, or `calls_enabled` is off.                                                                 |
| 501    | `speech_unavailable`  | No speech service here (local development): the client types and the browser speaks.                           |

### 2.2 The `calls` table (migration 0008)

One row per call: tenant, venture, conversation, persona, who started it, `status` (`live` \| `ended`),
provider, input mode (`transcribe` \| `typed`), the voice, `max_seconds`, start, last heartbeat, end,
`end_reason` (the contract's `CallEndReason`) and `end_detail` (machine-readable: `kill_switch`,
`calls_disabled`, `persona_unavailable`, `voice_consent`, `session_closed`, `spend_cap`,
`daily_call_minutes`, `max_duration`, `stale_heartbeat`, `replaced`, `client_<reason>`), grant and
synthesized-character counters, and the client's latency stats. Identifiers and numbers only, never content.

- **One live call per person** (partial unique index). Starting a call in the same conversation replaces
  the live one (a reload or a second tab); a live call elsewhere is refused (409); a call whose client sent
  no heartbeat for 60 s is closed first.
- A trigger keeps a call's identity, limits and start fixed, and an ended call ended.
- **RLS**: the caller, the venture's founders and team (summaries) and its assigned EIR read; only the
  caller inserts (on an active conversation of their venture, as themselves) and updates.
- **Turns** carry `call_id`: a turn a person sends in a conversation while their call there is alive joins
  it (trigger `turns_link_call`; a turn naming a call must name that one). `heard_seq` and
  `interrupted_at` record barge-in.
- `calls_enabled` is a platform setting (on by default).

### 2.3 Admission and limits

Starting a call checks, in order: founder/team access to an active conversation, `ai_enabled`,
`calls_enabled`, the active assignment of that conversation and its persona, the voice (§5), the daily AI
spend caps, one live call per person (under the person's turn-admission lock), and at least 60 s left today.
`max_seconds` is the smaller of the per-call cap (`max_call_minutes`, 30) and the minutes left today
(`daily_call_minutes_per_principal`, 60).

A spoken turn (`channel: 'voice'`) passes `admitVoiceTurn` in the transaction that inserts it: it must
name a live call of that conversation started by the caller whose client is still there, calls must be on,
time must be left (per call and today), the person may send at most 40 spoken turns in 10 minutes, and a
call holds at most 90 turns. Typed chat keeps its own rate limit.

**Minutes** come from the `calls` table, by the database clock: ended calls count until they ended, live
calls until now, and a call whose client went away until a minute after its last heartbeat (it is closed
at its last heartbeat plus 15 s). `GET /ventures/:id/call-config` reports the minutes left today.

### 2.4 Heartbeats

Every 15 s. The heartbeat re-reads everything and ends the call (`action: terminate`) on, in order: the AI
kill switch or `calls_enabled` off (`disabled`), the conversation ended or deleted (`user`), the vEIR
suspended, retired or re-assigned (`disabled`), the call's own voice no longer covered by consent
(`disabled`), no heartbeat for 60 s (`timeout`), the daily AI spend caps (`budget`), today's minutes
(`budget`) or the call's time limit (`timeout`). Switching calls off therefore stops every built-in call
within 15 s. A later heartbeat of an ended call keeps answering `terminate`.

### 2.5 Speech-to-text and speech

- **Grants.** `SttGrantIssuer` (core port) is implemented by `TranscribeStreamingPresigner`
  (`apps/api/src/adapters`): a SigV4-presigned `wss://transcribestreaming.us-east-1.amazonaws.com:8443/
stream-transcription-websocket` URL (en-US, PCM, 16 kHz, partial-results stabilization high), valid for
  300 s to open the stream, signed with the API Lambda role's credentials from the credential provider
  chain. Infra grants `transcribe:StartStreamTranscriptionWebSocket` to the API role and adds the host to
  `connect-src`. Without the port (mock model, local development) calls start with `sttGrant: null` and
  input mode `typed`; a signing failure leaves the call running without a grant.
- **Signed units.** The turn engine streams each validated unit of the spoken reply as `turn.speech`, signed
  (HMAC-SHA256, key derived by HKDF from the session-signing key) over `sessionId|turnId|seq|text`
  (`orchestrator/speech-units.ts`). The call intro is signed the same way with no turn and `seq` 0.
- **`POST /speech`** speaks, during the caller's live call in that conversation and in the call's voice:
  - a signed unit or the intro whose signature verifies; units of a turn that was finally blocked or failed
    are refused;
  - or, unsigned, the whole stored `spoken` form of a completed turn of the conversation, or one or more
    consecutive whole sentences of it (at least 12 characters); fragments, reordered or skipped sentences
    and the answer text are refused (422).

  It then checks the kill switches, the active assignment, the voice consent, the call's time left and the
  daily spend caps, and only then reports 501 where no speech service runs.

- **The intro** greets the founder by first name, says the vEIR is an AI coach, and continues with the
  notebook's opener on a fresh conversation ("What would you like to work on?" without one; "Where would
  you like to pick up?" on a conversation under way). The opener is a person-editable note: it is spoken
  only if it passes the identity rules and the cross-venture check; otherwise it is left out.

### 2.6 Barge-in, end and summary

`POST /turns/:id/interrupt` stores `heard_seq` (the last unit the founder heard, -1 for none) on the turn.
The turn engine reads it (`callsRepo.listTurnInterruptions`) so the conversation history replays what the
founder heard of an interrupted reply (`heardPortion`), not the whole reply. `POST /calls/:id/end` stores the client's numbers and returns the summary: turn count,
duration, AI memory proposals from the call's turns still awaiting review, their next actions (each once,
at most 10) and escalations drafted from them.

### 2.7 Metering and audit

- Each synthesis is a `usage_ledger` row with purpose `speech` (characters, Polly price per engine) under
  the daily spend caps, and is added to `calls.speech_characters`.
- Audit events (identifiers and counts only): `call.started`, `call.refused`, `call.stt_granted`,
  `call.terminated` (with the cause), `call.ended`, `call.access` (denied), `turn.interrupted`,
  `turn.rejected` (voice admission), `speech.synthesized`, `speech.refused`.
- Logs never carry grant URLs, intros, transcripts or spoken text.
- `callsRepo.reapStaleCalls` ends calls whose client went away; the API also closes them lazily on the next
  start, heartbeat or end.

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
  like chat (temporary chats keep nothing once they end). The `calls` row holds identifiers and numbers
  only.
- **The grant** is a presigned URL that authorizes one Transcribe stream with fixed parameters for five
  minutes. It carries the API role's temporary session token, never its secret key; it is never logged or
  stored for idempotent replay.
- **Validated speech only.** A call speaks only signed units the validators approved, the signed intro, or
  whole sentences of a stored validated reply. Units of a reply that is blocked in the end are never spoken
  again. The vEIR never claims to be its EIR: the intro states it is an AI coach, and a person-edited opener
  that breaks the identity rules is left out.
- **Disclosure.** The intro says the vEIR is an AI; the call screen keeps the one-line AI disclosure.
- **Voice consent.** A vEIR speaks with its EIR's chosen voice only while the EIR's consent covers `voice`;
  otherwise calls are refused rather than switched to another voice. Heartbeats re-check the consent, so a
  revoked or expired consent ends a live call within 15 s. Likeness (portraits, vendor avatars) needs
  `likeness` consent and is not used by the built-in presence.
- **Safety and cost.** Spoken turns go through the same risk classification, crisis path, validators,
  escalation and memory approval as typed ones. The AI kill switch, `calls_enabled`, the daily spend caps,
  the per-call and daily minute caps and the spoken-turn rate limit always apply.
- **Before a production voice launch**, the University's privacy review covers student voice processing
  by Amazon Transcribe and the first-call notice.
