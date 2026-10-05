#!/usr/bin/env node
/**
 * Post-deploy smoke test of a Foundry Ascent site (run by .github/workflows/deploy.yml; see
 * docs/runbooks/deploy-and-rollback.md).
 *
 *   node scripts/smoke.mjs https://dxxxxxxxxxxxxx.cloudfront.net
 *
 * Checks, in order (each one independent, all reported):
 *   1. GET /                         200 text/html with the security headers (CSP, HSTS, nosniff, DENY)
 *   2. GET /assets/<entry>.js        200 JavaScript, immutable caching
 *   3. GET /api/v1/health            200 JSON, status ok/degraded [+ the deployed version]. The public
 *                                    health route never queries the database (so polling it cannot keep
 *                                    Aurora awake); `db` is only what the instance last observed.
 *   4. POST /api/v1/auth/sign-in     401 problem+json `invalid_access_code` for a random code, no cookie.
 *                                    The first check that reaches Aurora (Data API): it waits for a resume
 *                                    from auto-pause (503 database_resuming + Retry-After, or a 504).
 *   5. GET /<tenant>/app/ventures    200 index.html (SPA deep link rewrite)
 *   6. GET /api/v1/<unknown>         4xx problem+json (API errors are never rewritten to the SPA)
 *
 * Environment:
 *   SMOKE_HEALTH_TIMEOUT_S  seconds to wait for the API to report ready and for Aurora to resume (default 120)
 *   SMOKE_EXPECT_VERSION    when set, /api/v1/health must report exactly this version (deployed commit)
 *   SMOKE_TENANT_SLUG       tenant of the deep link (default "ain")
 *   SMOKE_ALLOW_HTTP=1      accept an http:// base URL (local runs)
 *   SMOKE_RETRY_DELAY_MS    pause between first-contact retries (default 5000)
 *   SMOKE_FIRST_CONTACT_TIMEOUT_S  how long the first requests retry 403/404/5xx and network errors (default 180)
 *   GITHUB_STEP_SUMMARY     when set, a results table is appended to it
 *
 * Output is status codes, request ids and timings only: response bodies are never printed.
 * Exit code: 0 all checks passed, 1 a check failed, 2 usage error.
 */
import { createHash, randomInt } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const REQUEST_TIMEOUT_MS = 15_000;
/**
 * A request that reaches the database can wait for an Aurora resume: the API holds it up to its resume
 * budget (40 s) and CloudFront up to its origin read timeout (60 s). Wait longer than both so the server's
 * answer (or CloudFront's 504) arrives instead of a local abort.
 */
const DATABASE_REQUEST_TIMEOUT_MS = 65_000;
/** A new distribution can take a few minutes to resolve everywhere; only the first requests wait. */
const FIRST_CONTACT_TIMEOUT_S = 180;
/**
 * HTTP statuses retried during the first-contact window: 5xx, and 403 / 404, which a freshly created or
 * updated distribution or S3 origin briefly returns while the configuration and the SPA objects propagate.
 */
const FIRST_CONTACT_RETRY_STATUSES = new Set([403, 404]);
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MIN_HSTS_SECONDS = 31_536_000;
const CSP_DIRECTIVES = ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'"];

class CheckError extends Error {}

/** @param {string} message */
function fail(message) {
  throw new CheckError(message);
}

/** @param {string} line */
function out(line) {
  process.stdout.write(`${line}\n`);
}

/**
 * Whether a first-contact response should be retried (until the first-contact deadline) rather than
 * reported as a failure.
 * @param {number} status
 */
export function isTransientFirstContactStatus(status) {
  return status >= 500 || FIRST_CONTACT_RETRY_STATUSES.has(status);
}

function usage() {
  process.stderr.write(
    'Usage: node scripts/smoke.mjs <site-url>   (e.g. https://d111111abcdef8.cloudfront.net)\n',
  );
  process.exit(2);
}

/**
 * @param {string | undefined} raw
 * @returns {URL}
 */
function parseBaseUrl(raw) {
  if (!raw || raw === '-h' || raw === '--help') usage();
  let url;
  try {
    url = new URL(raw);
  } catch {
    process.stderr.write(`Not a URL: ${raw}\n`);
    process.exit(2);
  }
  const allowHttp = process.env.SMOKE_ALLOW_HTTP === '1';
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    process.stderr.write('The site URL must use https:// (set SMOKE_ALLOW_HTTP=1 for a local http:// run)\n');
    process.exit(2);
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    process.stderr.write('Pass the site origin only (no path, query or fragment)\n');
    process.exit(2);
  }
  return new URL(url.origin);
}

/**
 * @param {string} name
 * @param {number} fallback
 */
function positiveNumberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    process.stderr.write(`${name} must be a positive number\n`);
    process.exit(2);
  }
  return value;
}

/** A well-formed access code that is not issued to anyone (100 random bits). */
function randomAccessCode() {
  const groups = [];
  for (let g = 0; g < 4; g += 1) {
    let group = '';
    for (let i = 0; i < 5; i += 1) group += CROCKFORD[randomInt(CROCKFORD.length)];
    groups.push(group);
  }
  return `FA-${groups.join('-')}`;
}

/** @param {string} text */
function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * fetch with a per-request timeout; redirects are reported, never followed.
 * @param {URL} url
 * @param {RequestInit} [init]
 * @param {number} [timeoutMs]
 */
function request(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  return fetch(url, {
    redirect: 'manual',
    cache: 'no-store',
    ...init,
    headers: { 'user-agent': 'foundry-ascent-smoke/1', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** @param {unknown} err */
function describeError(err) {
  if (err instanceof CheckError) return err.message;
  if (err instanceof Error) {
    const cause = /** @type {{ code?: unknown } | undefined} */ (err.cause);
    const code = cause && typeof cause.code === 'string' ? ` (${cause.code})` : '';
    return `${err.name}: ${err.message}${code}`;
  }
  return String(err);
}

/** @param {Response} res */
function requestIdOf(res) {
  const id = res.headers.get('x-request-id');
  return id ? ` request-id=${id.slice(0, 64)}` : '';
}

/**
 * @param {Response} res
 * @param {string} expected
 */
function expectContentType(res, expected) {
  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  if (!type.startsWith(expected)) fail(`content-type "${type || 'none'}", expected ${expected}`);
}

/**
 * @param {Response} res
 * @param {{ page: boolean }} opts  page responses also need the CSP and frame headers
 */
function expectSecurityHeaders(res, opts) {
  const h = res.headers;
  const problems = [];
  const hsts = h.get('strict-transport-security') ?? '';
  const maxAge = /max-age=(\d+)/i.exec(hsts);
  if (!maxAge || Number(maxAge[1]) < MIN_HSTS_SECONDS) problems.push(`HSTS "${hsts || 'missing'}"`);
  if ((h.get('x-content-type-options') ?? '').toLowerCase() !== 'nosniff')
    problems.push('X-Content-Type-Options');
  if (opts.page) {
    const csp = h.get('content-security-policy') ?? '';
    if (!csp) problems.push('Content-Security-Policy missing');
    for (const directive of CSP_DIRECTIVES) {
      if (csp && !csp.includes(directive)) problems.push(`CSP lacks "${directive}"`);
    }
    if ((h.get('x-frame-options') ?? '').toUpperCase() !== 'DENY') problems.push('X-Frame-Options');
    if (!h.get('referrer-policy')) problems.push('Referrer-Policy missing');
  }
  if (problems.length > 0) fail(`security headers: ${problems.join('; ')}`);
}

/**
 * @param {Response} res
 * @param {number} expected
 */
function expectStatus(res, expected) {
  if (res.status !== expected) {
    const location = res.headers.get('location');
    fail(`HTTP ${res.status}${location ? ` -> ${location}` : ''}, expected ${expected}${requestIdOf(res)}`);
  }
}

/**
 * Problem documents are small JSON objects; anything else is reported by shape, not content.
 * @param {Response} res
 * @returns {Promise<Record<string, unknown>>}
 */
async function problemOf(res) {
  expectContentType(res, 'application/problem+json');
  /** @type {unknown} */
  let body;
  try {
    body = await res.json();
  } catch {
    fail('problem+json body is not JSON');
  }
  if (typeof body !== 'object' || body === null) fail('problem+json body is not an object');
  return /** @type {Record<string, unknown>} */ (body);
}

/** @type {{ name: string, ok: boolean, ms: number, detail: string }[]} */
const results = [];

/**
 * @param {string} name
 * @param {() => Promise<string>} fn  resolves to a short detail line
 */
async function check(name, fn) {
  const started = performance.now();
  let ok = true;
  let detail;
  try {
    detail = await fn();
  } catch (err) {
    ok = false;
    detail = describeError(err);
  }
  const ms = Math.round(performance.now() - started);
  results.push({ name, ok, ms, detail });
  out(`${ok ? 'PASS' : 'FAIL'}  ${name} (${ms} ms): ${detail}`);
}

async function main() {
  const base = parseBaseUrl(process.argv[2]);
  const healthTimeoutMs = positiveNumberEnv('SMOKE_HEALTH_TIMEOUT_S', 120) * 1000;
  const expectVersion = process.env.SMOKE_EXPECT_VERSION?.trim() || undefined;
  const tenant = process.env.SMOKE_TENANT_SLUG?.trim() || 'ain';
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(tenant)) {
    process.stderr.write('SMOKE_TENANT_SLUG must be a lowercase slug\n');
    process.exit(2);
  }
  out(`Smoke test of ${base.origin}`);
  // Shared by the checks that hit the site before the API: a fresh distribution or origin may answer
  // 403/404/5xx for a short while (FIRST_CONTACT_RETRY_STATUSES).
  const firstContactDeadline =
    Date.now() + positiveNumberEnv('SMOKE_FIRST_CONTACT_TIMEOUT_S', FIRST_CONTACT_TIMEOUT_S) * 1000;
  const retryDelayMs = positiveNumberEnv('SMOKE_RETRY_DELAY_MS', 5_000);

  /** @type {string | undefined} */
  let indexHtml;
  /** @type {string | undefined} */
  let entryScript;

  await check('GET / serves the SPA with security headers', async () => {
    const deadline = firstContactDeadline;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      /** @type {Response} */
      let res;
      try {
        res = await request(new URL('/', base));
      } catch (err) {
        // DNS of a new distribution, connection resets: retry until the first-contact deadline.
        if (Date.now() > deadline) throw err;
        await sleep(retryDelayMs);
        continue;
      }
      if (isTransientFirstContactStatus(res.status) && Date.now() <= deadline) {
        await res.body?.cancel();
        await sleep(retryDelayMs);
        continue;
      }
      expectStatus(res, 200);
      expectContentType(res, 'text/html');
      // Read the page before the header assertions so the later checks still get index.html.
      indexHtml = await res.text();
      entryScript = /<script[^>]+src="(\/assets\/[^"]+\.js)"/.exec(indexHtml)?.[1];
      expectSecurityHeaders(res, { page: true });
      if (!indexHtml.includes('id="root"')) fail('index.html has no #root element');
      return `HTTP 200, CSP + HSTS present${attempt > 1 ? ` (after ${attempt} attempts)` : ''}`;
    }
  });

  await check('GET entry script is served immutable', async () => {
    if (!entryScript) fail('no /assets/*.js entry script referenced by index.html');
    let res = await request(new URL(entryScript, base));
    while (isTransientFirstContactStatus(res.status) && Date.now() <= firstContactDeadline) {
      await res.body?.cancel();
      await sleep(retryDelayMs);
      res = await request(new URL(entryScript, base));
    }
    expectStatus(res, 200);
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!type.includes('javascript')) fail(`content-type "${type}" is not JavaScript`);
    const cacheControl = res.headers.get('cache-control') ?? '';
    if (!cacheControl.includes('immutable')) fail(`cache-control "${cacheControl}" is not immutable`);
    await res.body?.cancel();
    return `HTTP 200 ${entryScript}`;
  });

  await check('GET /api/v1/health reports the deployed version', async () => {
    const deadline = Date.now() + healthTimeoutMs;
    /** @type {string} the last observed state, reported on timeout */
    let last;
    for (;;) {
      try {
        const res = await request(new URL('/api/v1/health', base));
        const type = (res.headers.get('content-type') ?? '').toLowerCase();
        if (type.startsWith('application/json')) {
          const body = /** @type {{ status?: unknown, db?: unknown, version?: unknown }} */ (
            await res.json()
          );
          // `db` is absent until this API instance has observed the database on a real request.
          const db = body.db === undefined ? 'not observed' : String(body.db);
          last = `HTTP ${res.status} status=${String(body.status)} db=${db} version=${String(body.version)}`;
          if (res.status === 200) {
            expectSecurityHeaders(res, { page: false });
            if (body.status !== 'ok' && body.status !== 'degraded') fail(`status "${String(body.status)}"`);
            if (typeof body.version !== 'string' || body.version === '') fail('no version reported');
            const versionOk = expectVersion === undefined || body.version === expectVersion;
            if (versionOk && body.db !== 'unavailable') return `${last}${requestIdOf(res)}`;
            if (!versionOk) last += ` (expected version ${expectVersion})`;
          }
        } else {
          last = `HTTP ${res.status} ${type || 'no content-type'}${requestIdOf(res)}`;
          await res.body?.cancel();
        }
      } catch (err) {
        if (err instanceof CheckError) throw err;
        last = describeError(err);
      }
      if (Date.now() > deadline) fail(`not ready after ${healthTimeoutMs / 1000} s; last: ${last}`);
      await sleep(3_000);
    }
  });

  await check('POST /api/v1/auth/sign-in rejects an invalid code', async () => {
    const body = JSON.stringify({ accessCode: randomAccessCode() });
    // CloudFront signs the origin request with OAC; Lambda URLs need the payload hash from the viewer.
    const headers = {
      'content-type': 'application/json',
      'x-requested-with': 'foundry-ascent',
      'x-amz-content-sha256': sha256Hex(body),
    };
    // Sign-in is the first request that touches Aurora, which may be paused (auto-pause after 10 idle
    // minutes): wait for the resume within the same budget as the health check.
    const deadline = Date.now() + healthTimeoutMs;
    let resumes = 0;
    for (;;) {
      /** @type {Response} */
      let res;
      try {
        res = await request(
          new URL('/api/v1/auth/sign-in', base),
          { method: 'POST', headers, body },
          DATABASE_REQUEST_TIMEOUT_MS,
        );
      } catch (err) {
        if (Date.now() >= deadline) throw err;
        resumes += 1;
        await sleep(5_000);
        continue;
      }
      if ((res.status === 503 || res.status === 504) && Date.now() < deadline) {
        // 503 database_resuming (honour Retry-After) or a CloudFront origin timeout while Aurora resumes.
        await res.body?.cancel();
        resumes += 1;
        const retryAfter = Math.min(Number(res.headers.get('retry-after')) || 3, 10);
        await sleep(retryAfter * 1000);
        continue;
      }
      expectStatus(res, 401);
      const cookies = res.headers.getSetCookie().filter((c) => /^fa_session=[^;]+/.test(c));
      if (cookies.length > 0) fail('a rejected sign-in set a session cookie');
      const problem = await problemOf(res);
      if (problem.code !== 'invalid_access_code') fail(`problem code "${String(problem.code)}"`);
      if (typeof problem.requestId !== 'string') fail('problem document has no requestId');
      const waited = resumes > 0 ? ` (after ${resumes} retries while the database resumed)` : '';
      return `HTTP 401 invalid_access_code${requestIdOf(res)}${waited}`;
    }
  });

  await check(`GET /${tenant}/app/ventures serves the SPA (deep link)`, async () => {
    const res = await request(new URL(`/${tenant}/app/ventures`, base));
    expectStatus(res, 200);
    expectContentType(res, 'text/html');
    expectSecurityHeaders(res, { page: true });
    const html = await res.text();
    if (indexHtml !== undefined && html !== indexHtml) fail('deep link body differs from /index.html');
    if (!html.includes('id="root"')) fail('deep link did not return index.html');
    return 'HTTP 200 index.html';
  });

  await check('GET /api/v1/<unknown> stays a problem+json error', async () => {
    const res = await request(new URL('/api/v1/__smoke/not-found', base));
    if (![401, 403, 404].includes(res.status))
      fail(`HTTP ${res.status}, expected 401/403/404${requestIdOf(res)}`);
    const problem = await problemOf(res);
    return `HTTP ${res.status} ${String(problem.code)}${requestIdOf(res)}`;
  });

  const failed = results.filter((r) => !r.ok);
  out(
    failed.length === 0
      ? `All ${results.length} checks passed.`
      : `${failed.length} of ${results.length} checks failed.`,
  );

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    const escape = (/** @type {string} */ s) => s.replaceAll('|', '\\|').replaceAll('\n', ' ');
    const rows = results.map(
      (r) => `| ${r.ok ? 'pass' : '**FAIL**'} | ${escape(r.name)} | ${r.ms} | ${escape(r.detail)} |`,
    );
    appendFileSync(
      summaryFile,
      [
        '#### Smoke test',
        '',
        '| Result | Check | ms | Detail |',
        '| --- | --- | ---: | --- |',
        ...rows,
        '',
        '',
      ].join('\n'),
    );
  }
  process.exitCode = failed.length === 0 ? 0 : 1;
}

// Run only as a script (`node scripts/smoke.mjs <url>`), not when imported by its tests.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`smoke test crashed: ${describeError(err)}`);
    process.exitCode = 1;
  });
}
