# ADR-0021: Thomas — a stock-avatar mentor persona, presented under its own name

- **Status:** Accepted (amends ADR-0020's naming and identity lines for a persona presented as a mentor; ADR-0005's
  layers and ADR-0020's honesty line stand)
- **Date:** 2026-11-05
- **Deciders:** Platform owner (platform admin). The owner approved the release on **2026-11-05**: the display name is
  **Thomas**, a stock-avatar mentor persona.
- **Basis:** owner feedback round 2 (2026-11-05: "rename the persona Corin → Thomas", first person, "never 'I'm Thomas's
  vEIR'"), live pilots 42099643194 and 42124259353 (the customer-discovery script of Corin's v1 doctrine ran as the
  agenda of every conversation)

## Context and problem statement

The Ain tenant's ventures were coached by "Corin's vEIR", the digital twin of a fictional, synthetic EIR (Corin
Halvorsen), presented under Corin's first name with a "vEIR" badge (ADR-0020). Calls show a stock avatar whose name is
Thomas. The owner decided that students meet **Thomas**: a warm, direct, experienced founder-mentor who speaks in the
first person as himself, never "Thomas's vEIR" or "Thomas · vEIR", never narrating that he is a vEIR or a twin. Two live
pilots also showed that Corin's v1 doctrine (the last-time interview, a kill criterion, an owner and a date) was the
agenda of every reply: 9 of 60 and 8 of 60 scenarios passed.

## Decision drivers

- Presence: the student talks to Thomas, not to a product label.
- Honesty, unchanged: what Thomas is is said before the first conversation and before every call; asked sincerely, he
  says yes, he is an AI, in one warm line; he never claims to be a person, anyone else, or a past of his own.
- Consent, unchanged: the doctrine is still an EIR's approved doctrine, used under that EIR's consent.
- The production path is the studio's: a release created and approved by an authorised person, audited, with the
  conversations still on the old release moving to the new one.

## Considered options

1. **A new release of the existing persona, approved by the owner, with the persona renamed Thomas and presented as a
   mentor (`personas.presentation = 'mentor'`, migration 0028)** (chosen). Notebooks, library, lessons, embodiment,
   consent and assignments stay with the persona, so every venture it coaches gets Thomas at once.
2. A new persona "Thomas" and new assignments for every venture. Loses the persona's notebooks, common pool and face
   settings, and needs a consent of its own; refused.
3. Rename only, keeping the twin identity ("You are Thomas: Corin Halvorsen's digital twin"). Contradicts the owner's
   first-person decision; refused.

## Decision outcome

Chosen option: **1**.

- **Schema.** `personas.presentation` (`twin`, the default and every persona before it; `mentor`, an EIR persona
  presented as an AI mentor under its own name). Migration 0028, expand-only.
- **The release.** `packages/db/src/seed/owner-releases.ts` (`thomas-2026-11-05`): the rewritten doctrine (the method as
  how Thomas thinks: diagnose before advising, the evidence ladder, calibrated challenge; conversation-first: answer the
  actual question, guidance and examples, at most one question and only when it changes the advice, no scripted agenda,
  the founder's own numbers only), a warm and direct style, and a disclosure that says he is an AI mentor built with an
  EIR's consent from their approved doctrine and style, released after their review, whose individual replies no human
  EIR writes or approves.
- **Shipping.** The deploy's seed applies it once to the home tenant when `infra/cdk/config/production.json` names it
  (`homeTenant.ownerReleases` → `SEED_OWNER_RELEASES` on the migrate function): a draft created by the deploy owner,
  approved by the deploy owner (`personasRepo.createRelease`, `approveRelease`, superseding Corin's v1), the persona
  renamed Thomas and presented as a mentor, Corin's earlier releases withdrawn so every conversation moves to Thomas at
  its next message (the studio's re-pin, audited), and `persona.release_created` / `persona.release_approved` audited
  with `via: owner_release`. A redeploy changes nothing (deterministic id); a later release, withdrawal or rename made in
  the product is never undone; no other tenant or persona is touched; without a consent in force that covers doctrine,
  or without the deploy owner, nothing is applied.
- **Prompt.** A mentor identity (`resolvePersonaIdentity(…, mentor)`, `MENTOR_IDENTITY_RULES`): "You are Thomas, a
  mentor to student founders… Speak in the first person as Thomas", never a vEIR, twin, model or assistant, an honest
  yes when sincerely asked whether he is an AI and a no to being a person, no experiences, career, ventures, clients or
  meetings of his own, never anyone else; the doctrine is rendered as "How you think".
- **Validators.** The identity validator's honest lines for a mentor are his own ("I'm Thomas, an AI mentor.", "Yes —
  I'm Thomas, an AI mentor."); the EIR stays a name he never speaks as (claims to be the EIR still block). Calls
  introduce him on a first meeting as "Hi Maya, I'm Thomas." (`callIntro`, `mentor`).
- **What the student sees** (the design-v3 workstream): the persona's display name, "Thomas", with the pre-call
  disclosure, the first-visit welcome and the About panel saying what he is (an AI mentor, an AI-generated face and
  voice, what is remembered, a human is available).

### Consequences

- Good: students meet one consistent mentor; the doctrine no longer runs a script.
- Good: honesty and consent are unchanged and still enforced on the server (validators, consent checks at approval).
- Bad: a mentor's name is not an EIR's, so the badge rule of ADR-0020 ("Corin · vEIR") no longer names the person whose
  doctrine it is on screen; the release's disclosure and the About panel do.
- Neutral: other personas (Ruth's vEIR, studio-created vEIRs) stay twins; a mentor presentation is set only by an owner
  release.

## Confirmation

- `packages/db/src/migrate-0028.db.test.ts` (schema, owner-approved release, withdrawal of v1, audit, idempotence,
  tenant scope), `packages/ai/src/prompts/mentor.test.ts` (identity, honest lines), `packages/core/src/services/calls.test.ts`
  (the call intro), `infra/cdk/test/config.test.ts` (`homeTenant.ownerReleases`).

## Reopen when

- The owner wants Thomas's doctrine to come from a real EIR (record their consent and their own release in the studio).
- A jurisdiction requires a standing per-message disclosure (as ADR-0020).
