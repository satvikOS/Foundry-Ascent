/**
 * scripts/smoke.mjs against a local stand-in for a deployed site.
 * - First contact (R6): the first requests of a new CloudFront distribution or S3 origin can answer 403/404
 *   while the configuration propagates, and the smoke test must retry those instead of failing the deploy.
 * - Voice-call edge policy: pages must allow the microphone for this origin only, play speech from blob:
 *   URLs, and connect to nothing beyond the documents bucket and Amazon Transcribe streaming.
 */
import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const SMOKE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/smoke.mjs');
const INDEX =
  '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/index-abc.js"></script></body></html>';
const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
  'x-content-type-options': 'nosniff',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; media-src 'self' blob:; " +
    "connect-src 'self' https://foundryascent-data-documentsbucket-abc.s3.us-east-1.amazonaws.com " +
    "wss://transcribestreaming.us-east-1.amazonaws.com:8443; frame-ancestors 'none'; object-src 'none'",
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(self), geolocation=()',
};

interface Site {
  /** Answers with this status (empty body) instead of the real response while it returns a number. */
  readonly transient: (req: IncomingMessage) => number | null;
  /** Page headers that replace the deployed ones. */
  readonly pageHeaders?: Record<string, string>;
}

function serve(site: Site): Promise<{ server: Server; origin: string }> {
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const status = site.transient(req);
    if (status !== null) {
      res.writeHead(status, { 'content-type': 'application/xml' }).end('<Error/>');
      return;
    }
    const problem = (code: number, body: Record<string, string>) =>
      res
        .writeHead(code, { 'content-type': 'application/problem+json', 'x-content-type-options': 'nosniff' })
        .end(JSON.stringify({ ...body, requestId: 'req-1' }));
    if (req.method === 'GET' && (req.url === '/' || req.url === '/ain/app/ventures')) {
      res.writeHead(200, { ...PAGE_HEADERS, ...site.pageHeaders }).end(INDEX);
    } else if (req.url === '/assets/index-abc.js') {
      res
        .writeHead(200, {
          'content-type': 'application/javascript',
          'cache-control': 'public, max-age=31536000, immutable',
        })
        .end('export {};');
    } else if (req.url === '/api/v1/health') {
      res
        .writeHead(200, {
          'content-type': 'application/json',
          'strict-transport-security': PAGE_HEADERS['strict-transport-security'],
          'x-content-type-options': 'nosniff',
        })
        .end(JSON.stringify({ status: 'ok', version: 'test-version' }));
    } else if (req.method === 'POST' && req.url === '/api/v1/auth/sign-in') {
      req.resume();
      req.on('end', () => {
        problem(401, { code: 'invalid_access_code' });
      });
    } else {
      problem(404, { code: 'not_found' });
    }
  };
  return new Promise((ok) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      ok({ server, origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` });
    });
  });
}

function runSmoke(origin: string, firstContactSeconds: number): Promise<{ code: number; stdout: string }> {
  return new Promise((ok) => {
    execFile(
      process.execPath,
      [SMOKE, origin],
      {
        env: {
          PATH: process.env.PATH ?? '',
          SMOKE_ALLOW_HTTP: '1',
          SMOKE_RETRY_DELAY_MS: '20',
          SMOKE_HEALTH_TIMEOUT_S: '5',
          SMOKE_FIRST_CONTACT_TIMEOUT_S: String(firstContactSeconds),
          SMOKE_EXPECT_VERSION: 'test-version',
        },
        timeout: 60_000,
      },
      (error, stdout) => {
        const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
        ok({ code, stdout });
      },
    );
  });
}

let current: Server | null = null;
afterEach(async () => {
  const server = current;
  current = null;
  if (server) await new Promise((done) => server.close(done));
});

describe('scripts/smoke.mjs first contact (R6)', () => {
  it('retries 404 and 403 while a new distribution and its origin propagate, then passes', async () => {
    let pageMisses = 3;
    let assetMisses = 1;
    const { server, origin } = await serve({
      transient: (req) => {
        if (req.url === '/' && pageMisses > 0) {
          pageMisses -= 1;
          return 404;
        }
        if (req.url === '/assets/index-abc.js' && assetMisses > 0) {
          assetMisses -= 1;
          return 403;
        }
        return null;
      },
    });
    current = server;
    const { code, stdout } = await runSmoke(origin, 30);
    expect(stdout).toContain('(after 4 attempts)');
    expect(stdout).toContain('All 6 checks passed.');
    expect(code).toBe(0);
  });

  it.each([
    [
      'the microphone is off',
      { 'permissions-policy': 'camera=(), microphone=(), geolocation=()' },
      /Permissions-Policy microphone=\(\), expected \(self\)/,
    ],
    [
      'the camera is on',
      { 'permissions-policy': 'camera=(self), microphone=(self)' },
      /Permissions-Policy camera=\(self\), expected \(\)/,
    ],
    [
      'speech cannot play from blob: URLs',
      { 'content-security-policy': PAGE_HEADERS['content-security-policy'].replace(' blob:', '') },
      /CSP media-src "'self'", expected "'self' blob:"/,
    ],
    [
      'Transcribe streaming is not allowed',
      { 'content-security-policy': PAGE_HEADERS['content-security-policy'].replace(/ wss:\S+/, '') },
      /CSP connect-src lacks wss:\/\/transcribestreaming\.us-east-1\.amazonaws\.com:8443/,
    ],
    [
      'connect-src allows another host',
      {
        'content-security-policy': PAGE_HEADERS['content-security-policy'].replace(
          "connect-src 'self'",
          "connect-src 'self' https://*.amazonaws.com",
        ),
      },
      /CSP connect-src allows https:\/\/\*\.amazonaws\.com/,
    ],
  ])('fails the page checks when %s', async (_case, pageHeaders, problem) => {
    const { server, origin } = await serve({ transient: () => null, pageHeaders });
    current = server;
    const { code, stdout } = await runSmoke(origin, 1);
    expect(stdout).toMatch(/FAIL {2}GET \/ serves the SPA with security headers/);
    expect(stdout).toMatch(problem);
    expect(stdout).toContain('2 of 6 checks failed.'); // the page and the deep link
    expect(code).toBe(1);
  });

  it('still fails a site that keeps answering 404 once the first-contact window is over', async () => {
    const { server, origin } = await serve({ transient: (req) => (req.url === '/' ? 404 : null) });
    current = server;
    const { code, stdout } = await runSmoke(origin, 1);
    expect(stdout).toMatch(/FAIL {2}GET \/ serves the SPA with security headers .*HTTP 404/);
    expect(code).toBe(1);
  });
});
