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

<!-- Owned by the web calls stream: CallProvider and the mini call bar, the call layout, CallEngine
(AudioWorklet capture, end-of-turn detection, pipelined playback, barge-in, heartbeat, typed fallback),
entry points, and the after-call summary. -->

## 4. Avatar provider seam

<!-- Owned by the web calls stream: the AvatarProvider interface, the built-in presence orb, and what an
Anam or HeyGen LiveAvatar adapter needs (CSP hosts, Secrets Manager key, token route, consent). -->

## 5. Privacy, consent and safety

<!-- Shared: audio never passes through our API; what is stored (text turns only), likeness and voice
consent, disclosure on the call screen, and the University privacy review that precedes a production
voice launch. -->
