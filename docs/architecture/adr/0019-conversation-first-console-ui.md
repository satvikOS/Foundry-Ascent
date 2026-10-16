# ADR-0019: A conversation-first console — one sidebar shell for every role, the conversation as home

- **Status:** Accepted (supersedes the workspace layout described in ADR-0012; its technology choice
  stands)
- **Date:** 2026-10-16
- **Deciders:** Platform owner
- **Blueprint basis:** 02 §4A Fig 4 "Founder session shell" (left navigation, conversation canvas,
  evidence and memory inspector, control dock), 02 §8 founder transparency, 02 §11 adoption design, 03 §22
  "Frontend shell and visual system", §23 "Routes, layouts, and component ownership"; 05 §18 "Minimal
  product shell and nested routes"

## Context and problem statement

The V1 web app (ADR-0012) implemented the blueprint shell literally, as an admin dashboard: a global
rail, a venture context bar, a 10-tab venture strip, page tabs, a 4-tab inspector and a docked composer.
Reaching the coach took Home → venture → Coach tab → session list → a "Start a session" dialog with mode
cards. On a session page about 40 % of the viewport was navigation. Six places started a session in
different ways, eight surfaced memory to review, the AI disclosure appeared three times on one screen, a
"Synthetic" chip sat on nearly every object, and students saw operations telemetry ("Workspace ready").

The owner's acceptance bar asks for consoles as simple as ChatGPT, Claude and Gemini, with
industry-standard navigation, a proper home for every interactable, no crammed screens, better
typography and faces with the existing colour tokens, less redundant copy, and an easy-to-reach home for
vEIR calls.

## Decision drivers

- The conversation is the product: starting one is one click, and earlier ones are always in view.
- One place per concept: start a chat, start a call, review memory, ask for human help, the disclosure.
- The same shell for founders, EIRs, program leads and admins.
- Keep every trust surface: persistent AI disclosure, evidence and citations, memory approval,
  escalation with consent, the crisis path (ADR-0003, ADR-0007, ADR-0008).
- WCAG 2.2 AA, keyboard and screen-reader use, 390 px mobile; the Playwright journey stays a CI gate.
- Strict CSP (ADR-0012, ADR-0017): self-hosted fonts and assets only.

## Considered options

1. **Conversation-first shell: a collapsible left sidebar (sheet on mobile), a single centred
   conversation column, a context panel closed by default; staff workspaces in the same shell** (chosen).
2. Restyle the dashboard shell. Fixes the look but not the navigation depth or the duplicated entry
   points.
3. A separate app per role. Duplicates the shell, the data layer and the accessibility work, and lets the
   roles drift apart.

## Decision outcome

Chosen option: **1**.

### Shell

- **Sidebar**, top to bottom: the workspace or venture switcher (venture settings live in its menu);
  **New chat** and **Call {EIR}**; search (⌘K); recents grouped Today, Previous 7 days and Older, with
  calls marked by a phone icon and a hover menu (rename, delete, open digest); then the venture
  destinations **Knowledge**, **Documents**, **Human help** and **Team**; the account menu at the bottom
  (theme, shortcuts, workspaces by role, data use and privacy, report a problem, the one tenant-level
  "Synthetic data" notice, sign out).
- **Staff workspaces** reuse the shell; the switcher changes the sections. EIR studio: assigned
  ventures, personas and knowledge, lessons to review, calibration reviews, inbox. Program: portfolio,
  ventures, resources, escalations, vEIRs and assignments. Admin: people and access, settings, usage,
  audit.
- **Removed:** the global top bar, the venture context bar, the venture tab strip, the "Workspace ready"
  badge and per-object "Synthetic" chips. The database-waking banner appears only while the database is
  waking.

### Conversation

- **New chat** (`/$tenant/app/v/$ventureId`): the vEIR's face, a greeting that uses the notebook's next
  opener (ADR-0018), three or four suggestions from the venture's state, and the composer. No dialog: the
  first message creates the conversation in `auto` mode.
- **Conversation** (`/$tenant/app/v/$ventureId/c/$sessionId`): one centred column (about 768 px). vEIR
  messages are prose in the reading face with inline citation chips; claims, uncertainty and the
  challenge sit in a small "Sources & reasoning" disclosure; memory suggestions are one compact row (Keep,
  Not now); follow-up questions become chips above the composer for the latest message only. Founder
  messages are right-aligned bubbles.
- **Composer:** auto-growing text, attach, a compact mode chip (Auto, Diagnose, Challenge, Coach, Teach,
  Rehearse, Route), a voice button that starts a call, Send, and under it the single AI disclosure line
  (`role="note"`, accessible name "AI disclosure").
- **Context panel** (closed by default; opened from a citation or the header): Sources, Notebook ("What
  {EIR} knows", editable), To review (memory suggestions with batch approve), Human help.
- **Calls** open a full-viewport call screen from four places (sidebar, conversation header, composer
  voice button, new-chat home); see ADR-0010.

### Venture pages

**Knowledge** merges memory, decisions, experiments, milestones and evidence, with type and status
filters, search, a To review queue, the notebook and the conversation digests; the old routes redirect to
it with a filter. Documents, Human help and Team keep their functions in calmer layouts. Staff consoles
use tables with row menus or detail drawers and one primary action per page; persona detail is sectioned
(Overview, Doctrine & style, Knowledge library, Lessons, Releases, Consent, Test bench).

### Visual system

- Colour tokens in `apps/web/src/styles/globals.css` keep their values.
- Fonts are self-hosted with `@fontsource-variable` (the CSP has `font-src 'self' data:`): Geist for the
  interface, Newsreader for display headings and vEIR prose, Geist Mono for labels and data. Inter is
  removed.
- A type scale with a large display-to-body ratio, 1.6–1.7 line height and a 60–75 character measure for
  prose, tabular numerals for figures and dates.
- `PersonaAvatar` (portrait with `likeness` consent, otherwise a serif monogram) and `UserAvatar` wherever
  a person or a vEIR appears.
- One motion grammar (150 ms hover, 300–400 ms entrances, out-expo), honouring reduced motion. Nothing
  above the fold starts at opacity 0: that is what left the landing page blank until its code chunk
  loaded.

### Consequences

- Good: starting a conversation or a call is one click from anywhere; earlier conversations are always
  one click away.
- Good: one disclosure line, one memory review queue, one escalation status, one synthetic-data notice.
- Good: the data layer survives unchanged (API client, CSRF and payload-hash headers, SSE turn stream,
  query hooks); only the shell, routes and presentation change.
- Bad: the Playwright specs (journey, documents, safety, a11y, mobile) are rewritten with the new
  information architecture, and the route tree changes.
- Bad: bookmarks to old venture tabs rely on redirects; returning users relearn where things are.
- Neutral: the deploy smoke test's deep link (`/<tenant>/app/ventures`) keeps working because CloudFront
  serves `index.html` for any extension-less path; the SPA redirects it.

### Confirmation

- CI `e2e`: the founder journey through chat, citations, memory keep, digest, knowledge, human help and
  consent; documents; safety; axe accessibility checks in dark and light; mobile at 390 px.
- `apps/web/src/routeTree.gen.ts` is committed and CI fails if the build changes it.
- The post-deploy smoke test (`scripts/smoke.mjs`) still serves the SPA deep link with the security
  headers.

## Revisit trigger

- Usability sessions with founders in which they cannot find a past conversation, the call, or the
  review queue without help.
- An accessibility audit finding the shell cannot fix locally.
- A requirement for a native mobile app or for public, indexable pages (which also reopens ADR-0012).
