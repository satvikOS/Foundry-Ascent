# vEIR calls

How a founder talks to their vEIR by voice. A call is a mode of a conversation, not a separate product:
spoken turns are ordinary turns with `channel: 'voice'`, so the orchestrator, validators, evidence, memory
proposals, escalation and spend caps all apply. Decisions: ADR-0010 (voice calls), ADR-0018 (knowledge
pools), ADR-0019 (conversation-first console). Contracts: `packages/contracts/src/calls.ts` and the
`turn.delta` / `turn.speech` events in `packages/contracts/src/coach.ts`.

## 1. Overview

<!-- Owned by the calls backend stream: the end-to-end flow (mic → Transcribe → turn → signed units → Polly →
playback) as one diagram plus the latency budget. -->

## 2. Backend

<!-- Owned by the calls backend stream: endpoints, the calls table, admission (one live call per person,
voice-turn rate limit, per-call and daily minute caps, `calls_enabled`), speech-to-text grants (Amazon
Transcribe streaming, presigned browser-direct WebSocket), signed speech units and `POST /speech`,
heartbeat, interrupt, end and summary, and what is metered and audited. -->

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

Entry points all link to `?call=1`: the sidebar's **Call {vEIR}**, New chat's **Call {vEIR}** secondary
action, the conversation header and the composer's voice button, and ⌘K. One call at a time: opening
`?call=1` elsewhere during a call returns to the live one. Arriving by a click starts the call at once (the
click is what lets the browser play audio); a reloaded `?call=1` shows **Start call** instead, and so does
the first call in a browser, which first says how the founder's voice is handled (Amazon Transcribe turns
it into text, no audio is kept, the transcript is saved like chat, typing works throughout). When a call
cannot start, the screen says why (calls are for the venture team; AI paused; no minutes left today; the
API's own refusal in its own words) and offers **Try again** only when trying again may help. A call from
New chat that never starts (refused, cancelled, closed while connecting) deletes the conversation it
created, so no empty conversation is left in Recents.

### 3.2 The call screen

A focused, full-height surface (a modal dialog over the conversation, so focus and screen readers stay in
it):

- **Stage**: the avatar provider's form (the built-in presence) around the vEIR's monogram, or its portrait
  when likeness consent and an image exist. Under it, the name with its "vEIR · AI" badge and the state in
  words (`Connecting…`, `Listening`, `Thinking…`, `Speaking · Interrupt`, `Replying on screen`, `Muted`,
  `On hold`, `Reconnecting…`, `Hold to talk`, `Your turn`), never colour or motion alone. When the browser
  kept the call's audio suspended (no gesture reached it, as iOS requires), a **Turn on sound** button
  unlocks it; after the page was hidden, **Resume call** ends the hold.
- **Captions** (on by default; the choice is remembered per browser): the vEIR's current sentence in the
  reading face and the founder's live partials. **Call settings** (top right) choose small, medium or large
  captions and "Read captions with my screen reader", which makes the vEIR's line a polite live region;
  otherwise it is not one, since the voice and a screen reader would talk over each other.
- **Dock**: Mute (`M`), Push to talk (`P`; hold the button or Space), Captions (`C`), Type instead (`T`),
  Switch to chat, End. 48 px targets with names and pressed states. Esc interrupts the vEIR while it speaks,
  otherwise minimizes. No single key ends a call.
- **Timer** with the minutes left (from the heartbeat; the last two minutes count down and warn).
- **One AI disclosure line**: the persona release's disclosure, `role="note"`, named "AI disclosure".
- **Notices**: a failed turn (shown, never spoken, in the server's words), "Voice unavailable right now."
  while replies are on screen only, the two-minute warning, and the push-to-talk suggestion. A held-back
  turn shows the conversation's own `BlockedPanel` in place of the captions (`role="alert"`): the
  explanation for its reason, the crisis resources or the emergency line, and the drafted request for a
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

- **Capture.** The worklet is a static file on our origin (`script-src 'self'`, no blob: URLs). It averages
  each 16 kHz sample's span of input samples (a box filter) and transfers frames to the main thread. The
  event-stream codec (CRC-32 prelude and message checksums) is ours: about a hundred lines for one message
  type, instead of an SDK dependency. Muting closes the Transcribe socket, so muted minutes are not billed;
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
  `spoken` reply, split by the server's own sentence rules (unsigned passages `POST /speech` checks against
  the stored turn). A reply without a spoken form is shown, never voiced. On `501 speech_unavailable`
  (local development only) the browser's `speechSynthesis` reads the same validated text for the rest of
  the call. Any other failure never brings a substitute voice: a failure that may pass (network, 5xx, a
  busy synthesiser, a unit the server will not voice, undecodable audio) shows that sentence on screen and
  the next one asks for the voice again; a refusal for the whole call (`ai_disabled`, spend or minute caps,
  a paused vEIR or withdrawn voice consent, lost access) keeps replies on screen for the rest of the call.
  A crisis turn's fixed support line (signed units before `turn.blocked`) plays to its end; any other
  blocked turn stops at once.
- **Barge-in.** A VAD onset while the vEIR speaks ducks it to 20 % at once. The founder takes the floor
  with a settled word (a final segment, or every word marked stable), or two words while the transcript
  still changes, that are neither in what the vEIR has said of this reply (the echo guard) nor a
  backchannel ("yeah", "mm-hmm", "right", "got it"). That stops the audio, aborts the turn stream and sends
  `POST /turns/:id/interrupt {callId, heardSeq, heard}`, where `heardSeq` is the last unit heard to its end
  (-1 for none) and `heard` the units 0…heardSeq as played (sent once the contract carries it). Echo and
  backchannels never become a turn. A duck no word confirms restores the volume; after three, the call
  suggests push to talk. Typing while it speaks, Esc and Interrupt do the same.
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
Human help). The transcript is already in the conversation: spoken turns are ordinary turns. Buttons: Back to
conversation, Call again.

## 4. Avatar provider seam

The call engine owns the conversation (speech in, validated speech out); an avatar provider only embodies it.
`apps/web/src/lib/realtime/avatar.ts` (the code is authoritative):

```text
AvatarProvider
  id                         builtin | heygen | tavus | simli   (PersonaEmbodiment.provider)
  drawsFace                  true when the provider renders its own face (vendor video)
  mount(stage, options)      attach to the stage element; honours reduced motion
  setState(state)            connecting | listening | thinking | speaking | muted | idle
  setLevels({veir, founder}) both voices' loudness (0–1), every animation frame
  speak({text})              a validated unit starts being heard
  unmount()                  release the stage (and any vendor session)
```

`createAvatarProvider(id)` returns the registered adapter. Only `builtin` ships; a persona configured for a
vendor keeps the presence until that vendor's adapter is registered. The interface is visual: `speak`
notifies the face that a unit started being heard through the engine's own playback. A vendor that voices
the face itself needs two additions first (below), so a vendor adapter never doubles the audio.

**Built-in presence** (`presence.ts`, `presence.css`): concentric hairlines and a soft halo drawn only from the
colour tokens, so it follows the theme. The outer ring and halo follow the vEIR's voice (the playback
`AnalyserNode`; a gentle synthetic pulse when the browser voice or captions-only mode leave nothing to
measure), the inner ring follows the founder's microphone, an arc turns while connecting or thinking, and each
sentence gives the halo a soft lift. Levels reach CSS as custom properties set through the CSSOM, which the
strict CSP allows. With `prefers-reduced-motion` it is still and the state shows only in words. It implies no
likeness: the face is the vEIR's monogram (serif initials in a hairline ring) unless the EIR consented to a
portrait.

**What a vendor adapter (Anam, HeyGen LiveAvatar FULL) needs.** Both fit as browser relay: the vendor renders
and voices the face from text this platform validated; our turn endpoint stays the only brain.

1. **Approval and consent.** The vendor approved (security, privacy, accessibility, procurement; audio
   retention and training opt-out in its terms), and the EIR's `likeness` consent recorded, plus `voice` for a
   cloned voice (ADR-0005). The persona's embodiment names the provider only once consent covers it
   (`PersonaEmbodiment.likenessConsented` / `voiceConsented`); revoking consent suspends the persona and ends
   its calls at the next heartbeat.
2. **Key and token route.** The vendor API key in Secrets Manager (`foundry-ascent/media/<vendor>`,
   AWS-managed encryption), readable by the API role only. `POST /api/v1/calls/avatar-session` (reserved; it
   returns the built-in configuration today) mints the vendor's single-use session token for the call (Anam
   `POST /v1/auth/session-token` with the custom-LLM mode that disables its own model; HeyGen
   `POST /v1/sessions/token` in FULL mode with `max_session_duration` set to the call's `maxSeconds`). Tokens
   are never stored or replayed.
3. **Browser adapter.** The vendor SDK bundled from npm and loaded only with its adapter (`script-src 'self'`);
   `mount` renders the vendor's `<video>` into the stage (`drawsFace: true`). Two additions to the seam come
   with the first vendor:
   - a capability on the provider, `voices: 'engine' | 'text'`. With `'text'` the engine skips
     `POST /speech` and hands each validated unit's text to the provider (Anam
     `createTalkMessageStream().streamMessageChunk`, HeyGen `avatar.speak_text`), and takes the unit's
     start and end (for captions and `heardSeq`) from the provider's events instead of an AudioBufferSource;
   - an `onInterrupted(heardSeq)` callback the provider calls when the vendor's own barge-in fires, which
     runs the engine's interrupt (stop, abort, `POST /turns/:id/interrupt`).

   The vendor never receives evidence, memory or the full response. Anam also needs `'anam'` added to
   `AvatarProviderId` in the contracts (today `builtin | heygen | tavus | simli`) and a migration widening
   the provider check on `personas.embodiment` (migration 0004).

4. **CSP and permissions.** The vendor's exact API, signalling and media hosts (Anam's WebRTC hosts; HeyGen's
   API and LiveKit WSS host) added to `connect-src`, `media-src` and, if it renders in a frame, `frame-src`,
   from the CDK config of the enabled vendor; a test forbids `*`. The camera stays off.
5. **Latency and cost.** The vendor's voice and render add about 150–500 ms (vendor-reported) to our turn;
   end of speech to an audible avatar is about 0.75–2 s across vendors, most of it our own turn. Vendor
   minutes cost about $0.11–0.19 self-serve (Anam; HeyGen FULL ≈ $0.16–0.19) against ≈ $0.03–0.05 for the
   built-in cascade (estimates in `research/avatars.md`). Measure from recorded audio, not vendor claims,
   before a cohort. The kill switch, minute caps and heartbeat apply unchanged.

## 5. Privacy, consent and safety

<!-- Shared: audio never passes through our API; what is stored (text turns only), likeness and voice
consent, disclosure on the call screen, and the University privacy review that precedes a production
voice launch. -->
