# ADR-0010: Voice calls through browser-direct Amazon Transcribe, validated text and Amazon Polly; avatar vendors behind a provider seam

- **Status:** Accepted (revised twice on 2026-10-16: live voice calls ship on the serverless stack, with
  speech-to-text by Amazon Transcribe streaming straight from the browser; WebRTC media, avatar vendors
  and the camera stay deferred. See [Revision history](#revision-history))
- **Date:** 2026-10-05 (revised 2026-10-16)
- **Deciders:** Platform owner
- **Blueprint basis:** 03 §4 "Real-time conversation path", §10, §12 latency budgets, §19 "Streaming
  latency and global edge", §24 (media, avatar), §26 ADR-010; 05 §14 "Realtime latency and streaming",
  §24 "Recommended first build"; 02 §4 capability releases (Conversation row: push-to-talk, captions,
  accessibility controls; audio-only fallback), §14 (neutral surrogate body until likeness approval)

## Context and problem statement

Blueprint 03 recommends LiveKit/WebRTC regional rooms, partial ASR, early endpointing, barge-in and an
avatar adapter (HeyGen LiveAvatar, Azure, Tavus), with durable workflows kept out of the audio hot path.
The serverless runtime (Lambda behind CloudFront, ADR-0011, ADR-0017) is request/response with HTTP
response streaming: it cannot hold a media session, a WebSocket or bidirectional audio.

The owner made a call home part of the acceptance bar: founders talk to their vEIR by voice now, from an
obvious place in the app, and avatar vendors plug in later without a redesign. Two fictional EIR personas
with synthetic consent records, including `voice`, ship with the platform (ADR-0018).

A call needs no media server if speech recognition does not pass through our API and the server answers
each utterance with validated text plus synthesized audio. Who recognizes the speech is a privacy
decision: Chrome's Web Speech API sends the audio to Google by default (Safari to Apple, Edge to
Microsoft), none of which is an approved processor of student voice. Amazon Transcribe is AWS, the
processor the platform already uses, and its streaming endpoint accepts a WebSocket the browser opens
itself with a URL our API presigns.

## Decision drivers

- **Validate before speak.** A call says only what the text path validated (ADR-0002, ADR-0007).
- **No new always-on infrastructure.** Scale to zero stays (ADR-0011, ADR-0015).
- **No audio on our servers.** No recording, storage or server-side processing of the founder's voice.
- **Approved processors only.** Student voice goes to AWS in `us-east-1`, nowhere else.
- **Consent per asset** (ADR-0005): a persona-specific voice, a portrait or a vendor avatar each need the
  EIR's consent for that asset.
- **Vendor neutrality** (ADR-0001): the avatar vendor is a replaceable adapter.
- **Accessible and degradable:** captions, keyboard control, push-to-talk, a typed fallback inside the
  call; text stays the complete path (ADR-0007).
- **Metered and stoppable:** speech counts against the daily caps; calls have their own minute caps and
  `calls_enabled` switch, and stop with the AI kill switch.

## Considered options

1. **Amazon Transcribe streaming, browser-direct over a presigned WebSocket URL minted by the API → the
   normal turn endpoint (`channel: 'voice'`) → validated, signed speech units → Amazon Polly; a built-in
   "presence" avatar now, vendor avatars later behind an `AvatarProvider` seam** (chosen).
2. Browser speech recognition (Web Speech API). Free and needs no infrastructure, but the default
   recognizers are cloud services of the browser vendor (unapproved processors), Firefox lacks it, iOS
   continuous mode is unreliable, and it cannot listen on the echo-cancelled track, so barge-in hears the
   vEIR. Only Chrome's opt-in on-device mode (`processLocally`) avoids the vendor, and few browsers have it.
3. Keep deferring (the 2026-10-05 decision).
4. Server-side speech-to-speech (Bedrock Nova Sonic bidirectional streaming) or a LiveKit/WebRTC media
   server. Needs a long-running service with internet egress (Fargate), which the isolated VPC (no IGW,
   NAT or endpoints; denied by `FoundryAscent-Boundary`) does not allow; not scale-to-zero; the model's
   speech would bypass the text validators.
5. Transcribe relayed through our API. A Lambda Function URL cannot hold the bidirectional stream, and
   relaying puts the founder's raw audio on our servers. Option 1 has neither problem: the API only signs
   the URL, and the browser streams to AWS directly. (The first 2026-10-16 revision rejected Transcribe
   altogether on this relay premise.)
6. A vendor-hosted realtime avatar now (HeyGen LiveAvatar, Tavus, Simli). No vendor is approved, no EIR
   has given likeness consent, and the blueprint's body-layer cost is about $0.10 per minute.

## Decision outcome

Chosen option: **1**. The flow, endpoints and client engine are specified in
[calls.md](../calls.md); this record fixes the decisions.

### Call pipeline

1. **Start.** `POST /sessions/:id/calls` admits the call (one live call per person, `calls_enabled`, the
   AI kill switch, per-call and daily minute caps, persona status and consent) and returns the call, an
   STT grant and the signed intro (the notebook's next opener). The grant is a SigV4-presigned
   `wss://transcribestreaming.us-east-1.amazonaws.com:8443/stream-transcription-websocket` URL signed with
   the API role's credentials and valid for at most 5 minutes (`X-Amz-Expires` ≤ 300 s bounds the
   handshake only). `POST /calls/:id/stt-grant` mints a new one on reconnect or unmute.
2. **Listen.** The echo-cancelled microphone track feeds an AudioWorklet loaded from a same-origin static
   file, which sends 16 kHz 16-bit PCM in event-stream frames to Transcribe. Partial results are the
   founder's live captions; a stable partial plus about 600 ms of silence ends the turn. Typing is always
   available inside the call.
3. **Think.** The utterance becomes a normal turn (`POST /sessions/:id/turns`, `channel: 'voice'`,
   `callId`): voice-turn admission (its own rate limit and per-call turn cap), then the same orchestrator,
   retrieval, validators, escalation and crisis paths. The transcript of a call is the conversation's
   turns; nothing else is kept.
4. **Speak.** On the voice channel the reply streams `turn.speech` units: each is a sentence of the
   validated spoken form (plain sentences, no markdown or citation keys), HMAC-signed over
   `(sessionId, turnId, seq, text)` with a key derived from the active session-signing key. The client
   sends each unit to `POST /api/v1/speech` as a `SpeechRequest` `{sessionId, turnId, text, seq, sig}`;
   the call intro is signed with `turnId: null, seq: 0`. Without `seq`/`sig`, the text must be the stored,
   validated `spoken` form of a completed turn of that session. The API verifies before it synthesizes, so
   the endpoint is never a general voice generator. Polly returns `audio/mpeg`, streamed; the browser plays
   it from a `blob:` URL and fetches the next unit while the current one plays.
5. **Barge-in.** Voice activity while the vEIR speaks stops playback, aborts the reply and posts
   `/turns/:id/interrupt` with the last unit the founder heard.
6. **Heartbeat** every 15 s delivers the kill switch, the remaining budget, persona suspension and consent
   revocation; `terminate` ends the call.
7. **After the call** (`POST /calls/:id/end`) a summary lists memory to keep and next actions, and the
   conversation shows the call and its digest (ADR-0018).

Without AWS (local development, CI, e2e) the grant is null, so the call uses typed input, and
`POST /speech` answers `501 speech_unavailable`, so the browser reads replies with `speechSynthesis`.
That fallback exists only there.

### Where the audio goes

The founder's audio travels from the browser to Amazon Transcribe in `us-east-1` and never reaches
Foundry Ascent servers; neither it nor the synthesized speech is stored by the platform. AWS AI services
may keep content for service improvement unless the account opts out (an owner action, see
[owner actions](../../runbooks/owner-actions.md)). A University privacy review precedes any production
voice launch with real students.

### Voices and faces

- **Engine: `neural`** (`speech.engine` → `SPEECH_ENGINE`; the API's Polly adapter tries it first, then
  the voice's other engine). It has lower latency, costs about half as much ($16 against $30 per million
  characters) and carries no hallucination caveat. `generative` stays a configuration option
  with a recorded residual risk: AWS states that in rare cases the generative model "might continue
  generating random content beyond the stop threshold. Do not assume complete protection against
  hallucinated speech output" (Polly developer guide, "Generative voices"). Short per-sentence units and
  captions of the validated text limit, but do not remove, that risk; choosing generative needs the same
  review as any change to what a call may say.
- **Voices.** Corin's vEIR speaks as Matthew, Ruth's as Ruth; personas without a consented voice of their
  own, such as Foundry Guide, use the platform voice, Danielle. All three exist on both engines in
  `us-east-1`. `packages/core/speech-voices.json` is the one list of voices, engines and prices: core
  speaks and meters with it, infra prices the speech alarms with it, and tests pin it to the AWS voice
  list. Stock voices are synthetic: they are nobody's voice. A persona-specific voice is used only while
  the EIR's `voice` consent is active.
- The built-in avatar is an audio-reactive presence orb with the persona's monogram, or its portrait when
  `likeness` consent and an image exist. No video of a person is generated.
- The camera stays off for the whole site (`camera=()`): calls are voice only.
- Every call screen carries the one-line AI disclosure and labels the vEIR "vEIR · AI · Live voice". The
  vEIR never claims to be the human EIR or to be live in person (ADR-0005).

### Provider seam

- Web: `apps/web/src/lib/realtime/` holds the `CallEngine` (listen, turn, speak loop) and the
  `AvatarProvider` interface (its shape; the code is authoritative). Only `builtin` exists;
  [calls.md](../calls.md) §4 says what a vendor adapter needs.

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
  Secrets Manager (AWS-managed encryption; customer keys are denied by the boundary) read by the API role
  only, the vendor SDK bundled from npm (`script-src 'self'`), and exact vendor hosts added to
  `connect-src`, `media-src` and, if it renders in a frame, `frame-src` (a test forbids `*` in the CSP).
  The vendor renders only text this platform validated.
- AWS adapters (Polly synthesis, the Transcribe URL presigner) live in the API runtime behind core ports,
  next to the S3 and SQS adapters; [ADR-0001](0001-own-the-brain-provider-adapters.md#amendment-2026-10-16-aws-service-adapters)
  records why.

### Infrastructure and cost

| Item               | Setting                                                                                                                                                                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Permissions-Policy | `camera=(), microphone=(self), geolocation=()`: the microphone for this origin only; the browser still asks the person first                                                                                                                                                        |
| CSP                | `media-src 'self' blob:` (speech played from blob URLs); `connect-src` adds exactly `wss://transcribestreaming.us-east-1.amazonaws.com:8443`. The AudioWorklet is a same-origin file, which `script-src 'self'` already allows (checked in Chromium, Firefox and WebKit)            |
| IAM                | API role only, pinned with `aws:RequestedRegion = us-east-1`: `polly:SynthesizeSpeech` and `polly:DescribeVoices` on `*` (no resource-level permissions without a lexicon); `transcribe:StartStreamTranscriptionWebSocket` on `*` (the action has no resource types)                |
| Runtime contract   | `SPEECH_ENABLED`, `SPEECH_ENGINE` (api) from `infra/cdk/config/production.json` → `speech`; `speech.enabled: false` removes the Polly and Transcribe grants and the speech alarms, and the API then offers neither (no speech-to-text grant, `/speech` answers 501)                 |
| Spend              | Polly per character (neural $16, generative $30 per million; a 70-word reply ≈ 420 characters ≈ $0.007 neural), metered as usage purpose `speech` under the daily caps; Transcribe streaming $0.01 per minute while a socket is open, outside the app's metering (see Consequences) |
| Kill switches      | `calls_enabled = false` refuses new calls and ends live ones at the next heartbeat; `ai_enabled = false` stops calls with every other AI path. Both reach the browser, which closes its Transcribe socket; neither can close it from the server                                     |
| Alarms             | `FoundryAscent-Speech-Characters` (more than 100,000 Polly characters in an hour) and `FoundryAscent-Speech-Characters-Daily` (more than the global daily AI cap's worth in a day): backstops for the in-app metering                                                               |

### Consequences

- Good: founders can talk to their vEIR now, with no new always-on infrastructure, no audio on our
  servers and no processor beyond AWS.
- Good: a call speaks only validated text, as signed units or the stored validated reply; the default
  neural engine has no hallucination caveat. Its transcript is an ordinary conversation with evidence,
  memory suggestions and escalation.
- Good: avatar vendors drop in behind `AvatarProvider` and the reserved token route without touching the
  turn pipeline.
- Bad: turn-taking, not full duplex. The first audible reply takes the model's first sentence plus
  synthesis (an estimated 1.3–2.8 s at P50), so the 01 §9 gate (first audible response P50 ≤ 800 ms,
  P95 ≤ 1.2 s) is not met.
- Bad: `connect-src` names Transcribe's shared endpoint, which serves every AWS account, so the CSP cannot
  pin it to ours; `script-src 'self'` is what keeps injected code from using it.
- Bad: Transcribe bills the whole time a socket is open, silence included, and the minute caps bound only
  a well-behaved client. The API mints grants only for a live call, a limited number per call, and the
  5-minute expiry bounds only the handshake: once open, the browser's socket to AWS is out of the
  platform's reach. Heartbeats, minute caps and `calls_enabled` cannot close it, Transcribe use is not in
  `usage_ledger`, and AWS publishes no per-stream duration metric to alarm on. A modified client can keep
  streaming for hours. The real bounds are AWS's quota of 25 concurrent streams per account in
  `us-east-1` (at most about $360 a day at $0.01 a minute), the AWS Budget with Cost Anomaly Detection
  ([owner actions](../../runbooks/owner-actions.md) §2), and `speech.enabled: false`, which stops new
  sockets but not open ones.
- Neutral: rehearsal (pitch practice) can now be spoken.

### Confirmation

- `infra/cdk/test/app.test.ts` pins the Permissions-Policy, the CSP (`media-src`, and a `connect-src` of
  exactly the documents bucket and the Transcribe origin), the API-only, region-pinned Polly and
  Transcribe statements, both speech alarms and the runtime-contract environment; with
  `speech.enabled: false` there is no grant and no alarm. cdk-nag runs on every synth.
- The voices file is pinned by `infra/cdk/test/speech-voices.test.ts` (the AWS voice list, the seeded
  voices, the prices) and `packages/core/src/services/voices.test.ts` (neural first, the seeded voices,
  the same prices as `packages/ai`). API tests pin that `SPEECH_ENGINE` is tried first and that
  `SPEECH_ENABLED=false` wires no Polly.
- `scripts/smoke.mjs` checks the deployed Permissions-Policy, `media-src` and `connect-src` after every
  deploy.
- API tests for calls and `/speech`: signed units and the intro verify, forged or foreign text is refused,
  admission, caps, kill switches and consent apply.
- Playwright: the call screen on the typed path (CI has no AWS), the disclosure line, keyboard operation.

## Revisit trigger

- An approved avatar vendor and an EIR's signed `likeness` consent: build that vendor's `AvatarProvider`
  adapter and the token route.
- Measured first-audible latency that founders reject: Polly's bidirectional stream per reply, or a
  speech-to-speech service on long-running compute (a boundary and VPC change).
- The University privacy review rejecting AWS as the speech processor: calls fall back to typed input.

## Revision history

- **2026-10-05.** Accepted: realtime voice, WebRTC and avatars deferred behind adapter interfaces. V1 had
  no audio capture, storage or playback, and the Permissions-Policy was
  `camera=(), microphone=(), geolocation=()`. The seams it kept (a modality-neutral `CoachResponse`,
  separable persona layers, sessions pinning model and persona versions, streamed status events) are the
  ones the call pipeline uses.
- **2026-10-16 (first revision).** Voice calls through browser speech recognition, validated text and
  Polly on the generative engine; Transcribe rejected as needing a server-side stream.
- **2026-10-16 (second revision, this record).** Speech-to-text by browser-direct Transcribe over a
  presigned URL (Web Speech sends audio to unapproved processors); signed speech units for `/speech`;
  `neural` as the default engine with the generative residual risk recorded.
