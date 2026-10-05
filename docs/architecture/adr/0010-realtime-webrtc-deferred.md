# ADR-0010: Realtime voice, WebRTC and avatars are deferred

- **Status:** Accepted
- **Date:** 2026-10-05
- **Deciders:** Platform owner
- **Blueprint basis:** 03 §4 "Real-time conversation path", §10, §19 "Streaming latency and global edge",
  §24 (media, avatar), §26 ADR-010; 05 §14 "Realtime latency and streaming", §24 "Recommended first build"

## Context and problem statement

Blueprint 03 recommends LiveKit/WebRTC regional rooms, partial ASR, early endpointing, barge-in and an
avatar adapter (HeyGen LiveAvatar, Azure, Tavus), with durable workflows kept out of the audio hot path.
Blueprint 05 §24 sequences the build as workspace + memory first, then realtime voice, then an approved EIR
persona. None of the media vendors is approved, no EIR has consented to likeness or voice use, and the
serverless V1 runtime (Lambda behind CloudFront) is request/response with HTTP streaming, not a media
server.

## Decision drivers

- Ship the trust-critical core first (isolation, memory, evidence, escalation).
- No biometric assets or vendor contracts without consent records and approval (ADR-0005, ADR-0006).
- Keep idle cost near zero (ADR-0011, ADR-0015); media infrastructure is not scale-to-zero friendly.

## Considered options

1. **Defer realtime; keep the adapter seams and the response contract ready** (chosen).
2. Browser-native speech (Web Speech API) on top of the text path in V1.
3. Build the LiveKit + avatar path now with a stock avatar.

## Decision outcome

Chosen option: **1**. V1 has no audio/video capture, storage or playback. The seams that make the later
addition cheap are in place: the validated `CoachResponse` is modality-neutral (ADR-0007), persona
releases separate style/doctrine from voice/likeness (ADR-0005), session records pin model and persona
versions, and the turn pipeline already streams status events. When reopened, the realtime gateway is a
separate stateful service (Rust or Node per ADR-0009) — not a Lambda — and consumes only approved text.

### Consequences

- Good: no media vendor, biometric data or always-on infrastructure in V1.
- Bad: the voice-latency gates of 01 §9 and the barge-in target in 03 §12 are untested.
- Bad: rehearsal (pitch practice) is text-only.

### Confirmation

- No media permissions in the CSP/Permissions-Policy (`camera=(), microphone=(), geolocation=()`).
- No media vendor credentials in configuration or infrastructure.

## Revisit trigger

- An approved speech/avatar vendor (University security, privacy, accessibility, procurement review),
  a consenting EIR with a signed consent record, and funding for a realtime prototype measured against
  03 §12 latency budgets.
