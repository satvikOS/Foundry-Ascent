# ADR-0010: Voice calls through browser speech recognition, validated text and Amazon Polly; realtime media and avatar vendors behind a provider seam

- **Status:** Accepted (revised 2026-10-16: live voice calls ship now on the serverless stack; WebRTC
  media, avatar vendors and the camera stay deferred. The 2026-10-05 decision deferred all voice and
  avatar work; see [Revision history](#revision-history))
- **Date:** 2026-10-05 (revised 2026-10-16)
- **Deciders:** Platform owner
- **Blueprint basis:** 03 §4 "Real-time conversation path", §10, §12 latency budgets, §19 "Streaming
  latency and global edge", §24 (media, avatar), §26 ADR-010; 05 §14 "Realtime latency and streaming",
  §24 "Recommended first build"; 02 §4 capability releases (Conversation row: push-to-talk, captions,
  accessibility controls; audio-only fallback), §14 (neutral surrogate body until likeness approval)

## Context and problem statement

Blueprint 03 recommends LiveKit/WebRTC regional rooms, partial ASR, early endpointing, barge-in and an
avatar adapter (HeyGen LiveAvatar, Azure, Tavus), with durable workflows kept out of the audio hot path.
The serverless V1 runtime (Lambda behind CloudFront, ADR-0011, ADR-0017) is request/response with HTTP
response streaming: it cannot hold a media session, a WebSocket or bidirectional audio.

On 2026-10-05 no speech or avatar vendor was approved and no EIR had consented to voice or likeness use,
so all of it was deferred. On 2026-10-16 the owner made a call home part of the acceptance bar: founders
must be able to talk to their vEIR by voice now, from an obvious place in the app, and avatar vendors
(HeyGen or better) must plug in later without a redesign. Two fictional EIR personas with synthetic
consent records, including `voice`, now ship (ADR-0018).

A voice call does not need a media server if speech recognition happens in the browser and the server
answers each utterance with validated text plus synthesized audio. That fits the existing turn pipeline.

## Decision drivers

- **Validate before speak.** A call may say only what the text path validated (ADR-0002, ADR-0007).
- **No new always-on infrastructure.** Scale to zero stays (ADR-0011, ADR-0015).
- **No audio on our servers.** No recording, storage or server-side processing of the founder's voice.
- **Consent per asset** (ADR-0005): a persona-specific voice, a portrait or a vendor avatar each need the
  EIR's consent for that asset.
- **Vendor neutrality** (ADR-0001): the avatar vendor is a replaceable adapter.
- **Accessible and degradable:** captions, keyboard control, push-to-talk, a typed fallback inside the
  call; text stays the complete path (ADR-0007).
- **Metered:** speech counts against the same daily caps and stops with the kill switch.

## Considered options

1. **Browser speech recognition → the normal turn endpoint (`channel: 'voice'`) → Amazon Polly speech of
   the validated reply, played sentence by sentence; a built-in "presence" avatar now, vendor avatars
   later behind an `AvatarProvider` seam** (chosen).
2. Keep deferring (the 2026-10-05 decision).
3. Server-side speech-to-speech (Bedrock Nova Sonic bidirectional streaming) or a LiveKit/WebRTC media
   server. Needs a long-running service with internet egress (Fargate), which the isolated VPC (no IGW,
   NAT or endpoints; denied by `FoundryAscent-Boundary`) does not allow; not scale-to-zero; the model's
   speech would bypass the text validators.
4. A vendor-hosted realtime avatar now (HeyGen LiveAvatar, Tavus, Simli). No vendor is approved, no EIR
   has given likeness consent, and the blueprint's body-layer cost is about $0.10 per minute.
5. Server-side speech recognition (Amazon Transcribe streaming). Needs bidirectional streaming (not
   possible through a Lambda Function URL) and puts the founder's raw audio on our servers.

## Decision outcome

Chosen option: **1**.

### Call pipeline (v1)

1. **Listen.** The browser's `SpeechRecognition` (Chrome, Edge, Safari) produces interim captions and the
   final utterance. Where it is missing (Firefox, some embedded browsers) the call offers type-to-talk.
2. **Think.** The final utterance becomes a normal turn (`POST /sessions/:id/turns`, `channel: 'voice'`):
   same orchestrator, retrieval, validators, escalation and crisis paths, same SSE events. The transcript
   of a call is the conversation's turns; nothing else is kept.
3. **Speak.** The validated response carries `spoken` (at most 70 words of plain sentences, no markdown or
   citation keys) next to the full `answer`. The call screen sends it to `POST /api/v1/speech`
   (`{sessionId, turnId, text}`), which synthesizes only text that belongs to that validated turn, never
   arbitrary text, so the endpoint cannot be used as a general voice generator. Amazon Polly returns
   `audio/mpeg`; the browser plays it from a `blob:` URL, sentence by sentence.
4. **Barge-in.** When the founder starts speaking, playback stops.
5. **After the call** the conversation shows "Call · N min" and its digest (ADR-0018).

The founder's audio never reaches Foundry Ascent servers, and neither it nor the synthesized speech is
stored. Recognition does run
in the browser's speech service: Chrome sends audio to Google, Safari to Apple (or on device), Edge to
Microsoft, under the browser vendor's terms. The call screen says so in one line, and type-to-talk is
always available.

### Voices and faces

- The platform default is a stock Polly voice (`speech.defaultVoice`, `Matthew`) on the generative engine
  (`speech.engine`; neural is the cheaper alternative). Stock voices are synthetic: they are nobody's
  voice. A persona-specific voice id is used only when the EIR's `voice` consent is active; otherwise the
  default speaks.
- The built-in avatar is an audio-reactive presence orb with the persona's monogram, or its portrait when
  `likeness` consent and an image exist. No video of a person is generated.
- The camera stays off for the whole site (`camera=()`): calls are voice only.
- Every call screen carries the one-line AI disclosure and labels the vEIR "vEIR · AI · Live voice". The
  vEIR never claims to be the human EIR or to be live in person (ADR-0005).

### Provider seam

- Web: `apps/web/src/lib/realtime/` holds the `CallEngine` (listen, turn, speak loop) and the
  `AvatarProvider` interface below (its shape; the code is authoritative). `builtin` ships; `heygen`,
  `tavus` and `simli` are documented adapters.

  ```text
  AvatarProvider
    id                        builtin | heygen | tavus | simli
    mount(element, options)   attach the stage: monogram, portrait or vendor video
    speak(audio | text)       play synthesized audio, or hand validated text to a vendor that voices it
    setState(state)           listening | thinking | speaking | idle
    unmount()                 release the stage and any vendor session
  ```

- Server: `POST /api/v1/calls/avatar-session` is reserved for minting a vendor's short-lived session token;
  today it returns the built-in provider's configuration. Per-persona embodiment (provider, voice id,
  portrait) is part of the persona record and gated by consent.
- A vendor adapter is its own reviewed change: the vendor approved (security, privacy, accessibility,
  procurement), the EIR's `likeness` (and, for a cloned voice, `voice`) consent recorded, the vendor key in
  Secrets Manager (AWS-managed encryption; customer keys are denied by the boundary) read by the API
  role only, the vendor SDK bundled from npm (`script-src 'self'`), and exact vendor hosts added to
  `connect-src`, `media-src` and, if it renders in a frame, `frame-src` (a test forbids `*` in the CSP).
  The vendor renders only text this platform validated (option 1, step 3).

### Infrastructure and cost

| Item               | Setting                                                                                                                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Permissions-Policy | `camera=(), microphone=(self), geolocation=()`: the microphone for this origin only; the browser still asks the person first                                                                                                 |
| CSP                | adds `media-src 'self' blob:` (synthesized speech played from blob URLs); `connect-src` unchanged                                                                                                                            |
| IAM                | API role only: `polly:SynthesizeSpeech`, `polly:DescribeVoices` on `*` (no resource-level permissions without a lexicon) with `aws:RequestedRegion = us-east-1`                                                              |
| Runtime contract   | `SPEECH_ENABLED`, `SPEECH_DEFAULT_VOICE`, `SPEECH_ENGINE` (api) from `infra/cdk/config/production.json` → `speech`; `speech.enabled: false` removes the Polly grant                                                          |
| Spend              | usage purpose `speech`, priced per character (generative $30, neural $16 per million; a 70-word reply ≈ 420 characters ≈ $0.013) under the daily caps; per-call cap 30 minutes and a daily per-person minute cap in settings |
| Kill switch        | `ai_enabled = false` stops calls with every other AI path                                                                                                                                                                    |
| Alarm              | `FoundryAscent-Speech-Characters`: more than 100,000 Polly characters in an hour, a backstop for the in-app metering                                                                                                         |

### Consequences

- Good: founders can talk to their vEIR now, with no new always-on infrastructure, no stored audio and no
  media vendor.
- Good: a call cannot say anything the text path did not validate, and its transcript is an ordinary
  conversation with evidence, memory suggestions and escalation.
- Good: avatar vendors drop in behind `AvatarProvider` and the reserved token route without touching the
  turn pipeline.
- Bad: turn-taking, not full duplex. The first audible reply takes the model's turn time plus synthesis
  (seconds), so the 01 §9 gate (first audible response P50 ≤ 800 ms, P95 ≤ 1.2 s) is not met.
- Bad: recognition quality and availability depend on the browser, and the browser vendor processes the
  audio. Universities that cannot accept that use type-to-talk until server-side recognition exists.
- Neutral: rehearsal (pitch practice) can now be spoken.

### Confirmation

- `infra/cdk/test/app.test.ts` pins the Permissions-Policy, the CSP (including `media-src 'self' blob:` and
  an unchanged `connect-src`), the API-only, region-pinned Polly statement, the speech alarm and the
  runtime-contract environment; with `speech.enabled: false` no Polly grant and no alarm exist. cdk-nag
  runs on every synth.
- API tests for `/speech`: validated text of the caller's own turn only, caps, kill switch, consent.
- Playwright: the call screen with type-to-talk (CI's Chromium has no speech service), the disclosure
  line, keyboard operation.

## Revisit trigger

- An approved avatar vendor and an EIR's signed `likeness` consent: build that vendor's `AvatarProvider`
  adapter and the token route.
- Measured first-audible latency that founders reject, or a token-streaming turn contract: synthesize
  while the reply streams, or move to a speech-to-speech service on long-running compute (a boundary and
  VPC change).
- A University data review that rejects browser-vendor recognition, or on-device recognition becoming
  broadly available: switch to server-side or on-device recognition.

## Revision history

- **2026-10-05.** Status Accepted: realtime voice, WebRTC and avatars deferred behind adapter interfaces.
  V1 had no audio capture, storage or playback, and the Permissions-Policy was
  `camera=(), microphone=(), geolocation=()`. The seams it kept (a modality-neutral `CoachResponse`,
  separable persona layers, sessions pinning model and persona versions, streamed status events) are the
  ones the 2026-10-16 call pipeline uses.
- **2026-10-16.** Revised to option 1 (this record) after the owner made voice calls part of the
  acceptance bar.
