# ADR-0017: CloudFront with OAC in front of a streaming Lambda Function URL

- **Status:** Accepted
- **Date:** 2026-10-05
- **Deciders:** Platform owner
- **Blueprint basis:** 03 §8 "Network" (private service paths, rate and abuse limits), §11 "API and event
  surface" (streaming events), §24 "Global entry"; system design §2, §4.1, §6.1

## Context and problem statement

The API streams each coaching turn as Server-Sent Events, so status updates and the final structured
response reach the browser without polling. The SPA and the API should share one origin (cookies
`SameSite=Strict`, no CORS, one CSP). API Gateway REST APIs buffer responses (no streaming); HTTP APIs and
ALBs add hourly or per-request cost and no streaming either. Lambda Function URLs support
`RESPONSE_STREAM` but are public endpoints unless protected.

## Decision drivers

- Incremental streaming of turn events with a 60 s ceiling.
- One origin for SPA and API; strict cookies and CSP; security headers on every response.
- Zero idle cost; no load balancer or API Gateway stage to pay for.
- The Lambda endpoint must not be callable directly from the internet.

## Considered options

1. **CloudFront distribution: S3 origin (OAC) for the SPA, Lambda Function URL origin (OAC, `AWS_IAM`
   auth, `RESPONSE_STREAM`) for `/api/*`** (chosen).
2. API Gateway REST/HTTP API + Lambda (buffered responses, polling for progress).
3. Public Function URL with CORS from the CloudFront site.

## Decision outcome

Chosen option: **1**. The Function URL uses `AWS_IAM` auth and only accepts SigV4 requests signed by
this distribution's Origin Access Control; the function's resource policy grants
`lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` (with `InvokedViaFunctionUrl`) to the distribution
only. `/api/*` is uncached (`CachingDisabled`, `AllViewerExceptHostHeader`), uncompressed so SSE is not
buffered, with a 60 s origin read timeout; a viewer-request function sets `x-fa-viewer-ip` (sign-in lockout key)
and `x-fa-viewer-host` (the site origin, since the API has no `SITE_ORIGIN` without a custom domain),
overwriting any client value. The API is
a Hono app wrapped with `hono/aws-lambda` `streamHandle`. One response headers policy adds HSTS (2 years,
preload), `nosniff`, `X-Frame-Options: DENY`, a strict CSP and a restrictive Permissions-Policy to SPA and
API responses.

Because OAC signs the origin request with the payload hash supplied by the viewer, every non-GET request
from the browser carries `x-amz-content-sha256` (hex SHA-256 of the exact body bytes); the web API client
computes it with WebCrypto. Requests without it fail signature checks at the origin.

### Consequences

- Good: true streaming at Lambda prices; no idle cost; the origin is private.
- Good: same-origin cookies and CSP; the API never needs CORS.
- Bad: clients other than the SPA (smoke test, evals harness) must compute `x-amz-content-sha256`.
- Bad: no WAF (denied by the boundary for cost, ADR-0015); abuse controls live in the API (lockout,
  rate limits, spend caps). Lambda reserved concurrency is available but off in production (ADR-0015).
- Bad: the default `*.cloudfront.net` certificate fixes the viewer TLS policy; TLS 1.2 minimum needs a
  custom domain and ACM certificate (supported via CDK context).

### Confirmation

- CDK tests (`edge.test.ts`, `app.test.ts`): OAC on both origins, `AWS_IAM` + `RESPONSE_STREAM`, headers
  policy contents, no custom error pages on `/api/*`.
- Post-deploy smoke test (`scripts/smoke.mjs`): security headers, health reporting the deployed commit,
  signed `POST /auth/sign-in`, SPA deep link, API errors not rewritten to `index.html`.

## Revisit trigger

- Turn latency or duration exceeds what one Lambda invocation can stream (60 s), WebSocket or WebRTC is
  needed (ADR-0010), or traffic justifies a WAF and a custom domain with modern TLS policies.
