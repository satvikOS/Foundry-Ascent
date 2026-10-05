# ADR-0012: Vite + TanStack Router SPA instead of Next.js

- **Status:** Accepted (deviation from blueprint 03 §17/§26 ADR-012 and 05 §12)
- **Date:** 2026-10-05
- **Deciders:** Platform owner
- **Blueprint basis:** 03 §17 (Product UI: Next.js App Router), §22 "Frontend shell and visual system",
  §23 "Routes, layouts, and component ownership", §26 ADR-012; 05 §12 (web shell), §18 "Minimal product
  shell and nested routes"

## Context and problem statement

Both blueprints name Next.js App Router for the web shell, citing nested layouts, server rendering and
accessibility tooling. Their real requirement (03 §26 ADR-012, 05 §18) is a persistent evidence-and-memory
session shell with nested routes `/[partner]/app/ventures/[ventureId]/{overview, sessions, memory, …}`.
V1 hosting is CloudFront + S3 + Lambda with a near-zero idle budget (ADR-0011, ADR-0015); every page is
behind sign-in and nothing needs SEO.

## Decision drivers

- Nested, type-safe layouts that keep venture context while switching panels.
- Static hosting on CloudFront/S3: no server runtime for HTML, no cold starts on navigation.
- A strict CSP (`script-src 'self'`, no inline scripts) without nonce plumbing.
- Authorization lives in the API (ADR-0004); the browser is never an authority.

## Considered options

1. **Vite 8 + React 19 + TanStack Router (file-based, typed params/search) as a static SPA** (chosen).
2. Next.js App Router on Lambda (OpenNext or a container), server components for data loading.
3. Next.js static export.

## Decision outcome

Chosen option: **1**. `apps/web` is a Vite SPA built to `apps/web/dist`, deployed to a private S3 bucket
behind CloudFront (OAC); a viewer-request function rewrites extension-less paths to `/index.html`. TanStack
Router file routes preserve the nested layout model (`$tenant/app/ventures/$ventureId/route.tsx` is the
VentureLayout with rail, context bar, canvas, inspector and dock), with type-safe params and search
state and route-level code splitting. TanStack Query handles server state. The SPA calls same-origin
`/api/v1/*`; route guards only shape the UI — the API authorizes every request.

### Consequences

- Good: zero server cost for the UI; immutable hashed assets cached for a year; `index.html` revalidated.
- Good: a strict CSP holds (the build emits no inline scripts; asset inlining is disabled).
- Bad: no server-side rendering or streaming HTML; first paint depends on the JS bundle (mitigated by
  code splitting and a static shell).
- Bad: the blueprints' Next.js-specific guidance (server components, route handlers) does not apply.

### Confirmation

- Smoke test after every deploy: deep link `/<tenant>/app/ventures` serves `index.html` with the CSP.
- Playwright founder journey; bundle size warning threshold in `vite.config.ts`.

## Revisit trigger

- A requirement for SSR: public, indexable pages (partner marketing), measured first-paint problems on
  low-bandwidth devices (05 §15) that code splitting cannot fix, or server-side data loading that the
  API cannot serve efficiently.
