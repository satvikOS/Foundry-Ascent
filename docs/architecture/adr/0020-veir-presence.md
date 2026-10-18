# ADR-0020: vEIR presence — disclose once, a persistent badge, a twin that speaks as itself

- **Status:** Accepted (amends the persistent-disclosure line of the system design §9 and ADR-0019's
  composer; ADR-0005's layers stand)
- **Date:** 2026-10-17
- **Deciders:** Platform owner
- **Blueprint basis:** 01 F-09 (persistent synthetic-identity disclosure), 02 §8 founder transparency, 03
  ADR-005 (separable persona layers)

## Context and problem statement

Production transcripts (October 2026) showed the vEIR reciting its legal disclosure when a founder asked a
personal question, and calls opening "this is Corin's vEIR, an AI coach" every time. Every composer, call and
summary carried a one-line disclaimer. The owner's direction: founders should feel their EIR is right there
with them, as on a video call — a warm, present mentor in the EIR's style, never a robot apologising for
itself ("I'm an AI, not a real human, I don't have a life").

The honesty line is not negotiable: a vEIR that denies being an AI when sincerely asked would be deceptive, and
unlawful in several jurisdictions. It never claims to be human, to be the EIR in person, a body, a place or a
real-world action, or that the EIR (or anyone) reviewed, approved or said something.

## Decision drivers

- Presence: no volunteered disclaimers, no meta-talk, one honest warm line when sincerely asked.
- Honesty where it matters: disclosure before the first conversation, and a way to check it any time.
- Consent: speaking under an EIR's first name is that EIR's choice, recorded like voice and likeness.
- Enforcement on the server and in the deterministic validators, not in prompts alone.

## Considered options

1. **Disclose once (a welcome stored with the person), keep a persistent "vEIR" badge beside the name that
   explains it, and let the twin speak as itself; a consent scope for the first-name presentation** (chosen).
2. Keep a disclaimer line on every surface and only soften the model's wording. The line is what made the
   product feel like talking to a robot.
3. Present the twin as the EIR. Deceptive; refused.

## Decision outcome

Chosen option: **1**.

- **Welcome.** The first time a founder or teammate meets their vEIR, one calm screen says in two sentences
  what it is ("Corin's digital twin: an AI built with Corin's consent from how Corin coaches. Corin sees what
  you work on here." — the second only when the vEIR's EIR is the venture's assigned EIR). A venture coached by
  the program's neutral guide gets its own ("Meet Foundry Guide: the program's AI coach… It isn't a person.").
  Acknowledged once,
  stored with the person (`principals.veir_welcome_acknowledged_at`, migration 0016, closed to `app_rls` like
  0010's call notice; `POST /me/veir-welcome/acknowledge`, audited once). A call opened first says it on its
  start screen, beside the voice notice; Start call stores both.
- **Badge.** Wherever the vEIR is named it carries a badge ("vEIR" under the EIR's first name, "AI"
  otherwise) that opens one short paragraph: an AI, the EIR's digital twin, not the EIR in person, who does not
  write or approve its replies. No disclaimer line under composers, calls or summaries; exports keep the
  release's full disclosure (print), and the studio keeps it beside the test bench.
- **Naming.** With the EIR's `first_person` consent the twin is "Corin · vEIR" (the first name and the badge,
  like a call tile); without it, "Corin's vEIR". The human EIR, where meant, is their full name.
- **Prompt.** The identity rules tell the vEIR who it is (the EIR's digital twin, an AI, built with consent),
  to be present in the EIR's voice (first-person consent) or to credit the method to the EIR (without it), never
  to volunteer what it is, to answer a sincere question in one warm honest line and carry on, to introduce
  itself only on a first meeting, and every hard line above. They no longer recite the disclosure (fewer
  tokens).
- **Validators.** Claims to be human, the EIR, present in a place or acting in the world, and endorsements stay
  violations (claims to be the EIR block); their correction is one brief line in the twin's voice ("I'm Corin's
  digital twin, not Corin in person.", "I can't speak for Corin on that."). A volunteered self-deprecating
  disclaimer is a style finding (`ai_disclaimer`): rewritten out (the phrase or the sentence), never blocking,
  never counted as an identity violation. The rewrite never takes the honest answer away: a disclaimer sentence
  that also says what the coach is ("Honestly? I'm just an AI.") becomes its honest line ("Honestly? I'm Corin's
  digital twin, built from how Corin coaches.") unless the reply already says it, and when the founder sincerely
  asked what the coach is (`asksAboutIdentity`, read from their message by the validator and the sentence gate)
  nothing is rewritten out of the answer at all. Only the reply keeps an honest line; claims, actions and
  memories lose a lone disclaimer and the item is dropped. A claim of presence counts in the coach's own voice
  only: drafts and scripts for the founder (quoted, after "Draft:" or "Say:", in a letter to someone else) and
  next actions are theirs. "This is really Corin", "the real Corin here", "Nope, not an AI" and "I'm real" are
  claims like their plain forms. TypeScript validator and Python grader share `identity_cases.json` (cases,
  honest answers and the founder questions both read as sincere).
- **Calls.** The intro introduces the vEIR only on a first meeting ("Hi Maya, I'm Corin's vEIR, Corin's digital
  twin."): nothing said yet in this conversation and no earlier one. Later calls greet. The call stage is a tile
  with a name tag and a speaking indicator.
- **Private conversations.** The EIR never reads them (turns_read RLS), so the vEIR never says there that its
  EIR sees the work.
- **Evals.** G5 counts a session as disclosed when the founder is shown what the coach is (the server reports
  the welcome for them and names the coach's kind, with a vEIR's EIR, for the badge) and the record is on the
  session.

### Consequences

- Good: conversations read like a mentor, not a terms-of-service page; disclosure is clearer (said once,
  calmly, and always one tap away) than a line nobody reads.
- Good: the first-name presentation is consented, revocable and enforced server-side (venture detail, call
  settings, the prompt), never chosen by the client.
- Bad: a founder who dismisses the welcome without reading it relies on the badge; the badge must stay on
  every surface that names the vEIR (checked by the e2e naming invariant).
- Neutral: the seed extends its fictional EIRs' seeded consents with `first_person` once; real EIRs record it
  in the studio.

## Confirmation

- `packages/ai` identity tests and `evals/tests/test_graders_identity.py` over the shared cases (twin
  self-references allowed, disclaimers style-only, physical presence flagged, every earlier case unchanged).
- `migrate-0016.db.test.ts`, `presence.db.test.ts` (core and API), the web component tests, and
  `apps/web/e2e/presence.chat.spec.ts` (welcome once per person, no disclaimer line, the honest one-liner,
  no "I don't have a life", the call tile "Corin · vEIR").

## Reopen when

- A jurisdiction the program serves requires a standing per-message disclosure.
- Vendor avatars (likeness) arrive: the tile shows video and the badge must stay on it.
