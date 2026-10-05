import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  apiRequest,
  apiRequestOrEmpty,
  apiSend,
  buildUrl,
  encodeQueryComponent,
  path,
  prepareRequest,
  resumeDelay,
  RESUME_MAX_WAIT_MS,
} from './client';
import { ApiError, errorMessage, parseRetryAfter } from './errors';
import { resumingStore } from './resuming';
import { EMPTY_SHA256, sha256Hex, sha256HexSync } from './sha256';

type FetchMock = ReturnType<
  typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>
>;

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
  });
}

function problem(
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return new Response(
    JSON.stringify({
      type: `https://foundry.example/problems/${code}`,
      title: 'Problem',
      status,
      code,
      requestId: 'req-server-1',
      ...extra,
    }),
    { status, headers: { 'content-type': 'application/problem+json', ...headers } },
  );
}

function headersOf(fetchMock: FetchMock, call = 0): Headers {
  const init = fetchMock.mock.calls[call]?.[1];
  return new Headers(init?.headers);
}

let fetchMock: FetchMock;
// setImmediate stays real under fake timers; it lets WebCrypto (thread pool) callbacks complete.
const realSetImmediate = (globalThis as unknown as { setImmediate: (callback: () => void) => void })
  .setImmediate;

beforeEach(() => {
  fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('sha256', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
  ])('fallback matches the FIPS 180-4 vector for %j', (input, expected) => {
    expect(sha256HexSync(new TextEncoder().encode(input))).toBe(expected);
  });

  it('fallback handles a multi-block message (one million "a")', () => {
    const bytes = new Uint8Array(1_000_000).fill(0x61);
    expect(sha256HexSync(bytes)).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });

  it('WebCrypto and fallback agree at every padding boundary', async () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 31 + 7) % 256);
      expect(await sha256Hex(bytes)).toBe(sha256HexSync(bytes));
    }
  });
});

describe('prepareRequest / headers', () => {
  it('hashes the exact UTF-8 bytes that are sent for non-GET requests', async () => {
    const body = { title: 'Pricing test', content: 'Café ✓ — 10% cheaper' };
    const prepared = await prepareRequest('/ventures/v1/memory', {
      method: 'POST',
      body,
      idempotencyKey: 'idem-1',
    });
    const sent = prepared.init.body as Uint8Array;
    const headers = new Headers(prepared.init.headers);

    expect(new TextDecoder().decode(sent)).toBe(JSON.stringify(body));
    // Known digest of that exact JSON text (computed with `sha256sum`).
    expect(headers.get('x-amz-content-sha256')).toBe(
      'b2486e451dfa7d0f2c30a2301374824e39294ffac7f84628fcaad141f93d7723',
    );
    expect(headers.get('x-amz-content-sha256')).toBe(sha256HexSync(sent));
    expect(headers.get('x-requested-with')).toBe('foundry-ascent');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('idempotency-key')).toBe('idem-1');
    expect(headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(prepared.init.credentials).toBe('same-origin');
    expect(prepared.url).toBe('/api/v1/ventures/v1/memory');
  });

  it('uses the empty-body hash when a non-GET request has no body', async () => {
    const prepared = await prepareRequest('/auth/sign-out', { method: 'POST' });
    const headers = new Headers(prepared.init.headers);
    expect(prepared.init.body).toBeUndefined();
    expect(headers.get('x-amz-content-sha256')).toBe(EMPTY_SHA256);
    expect(headers.has('content-type')).toBe(false);
  });

  it('does not add CSRF, hash or idempotency headers to GET requests', async () => {
    const prepared = await prepareRequest('/ventures', { idempotencyKey: 'ignored' });
    const headers = new Headers(prepared.init.headers);
    expect(headers.has('x-requested-with')).toBe(false);
    expect(headers.has('x-amz-content-sha256')).toBe(false);
    expect(headers.has('idempotency-key')).toBe(false);
    expect(prepared.init.method).toBe('GET');
  });

  it('encodes path parameters and query strings', () => {
    expect(path`/ventures/${'a/b c'}/memory`).toBe('/ventures/a%2Fb%20c/memory');
    expect(
      buildUrl('/ventures/x/memory', {
        type: 'fact',
        q: 'café',
        status: undefined,
        pinned: false,
        empty: '',
      }),
    ).toBe('/api/v1/ventures/x/memory?type=fact&q=caf%C3%A9&pinned=false');
  });

  it('encodes query strings the way SigV4 canonicalises them (space is %20, never +)', () => {
    expect(buildUrl('/admin/audit', { action: 'turn blocked', q: 'a+b c' })).toBe(
      '/api/v1/admin/audit?action=turn%20blocked&q=a%2Bb%20c',
    );
    expect(buildUrl('/x', { q: "it's (really) fine!*~-_." })).toBe(
      '/api/v1/x?q=it%27s%20%28really%29%20fine%21%2A~-_.',
    );
    expect(buildUrl('/x', { 'a b': ['1', '2'] })).toBe('/api/v1/x?a%20b=1&a%20b=2');
    expect(buildUrl('/x', { q: '' })).toBe('/api/v1/x');
    expect(encodeQueryComponent('ü / é')).toBe('%C3%BC%20%2F%20%C3%A9');
  });
});

describe('problem+json → ApiError', () => {
  it('maps code, status, requestId, retryAfter and field errors', async () => {
    fetchMock.mockResolvedValue(
      problem(429, 'locked_out', { detail: 'Too many attempts', retryAfterSeconds: 900 }),
    );
    const error = await apiSend('/auth/sign-in', { method: 'POST', body: { accessCode: 'x' } }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(429);
    expect(apiError.code).toBe('locked_out');
    expect(apiError.requestId).toBe('req-server-1');
    expect(apiError.retryAfter).toBe(900);
    expect(errorMessage(apiError)).toContain('15 minutes');
  });

  it('keeps validation field errors', async () => {
    fetchMock.mockResolvedValue(
      problem(422, 'validation_failed', { errors: [{ path: 'title', message: 'Required' }] }),
    );
    const error = (await apiSend('/ventures/v/memory', { method: 'POST', body: {} }).catch(
      (e: unknown) => e,
    )) as ApiError;
    expect(error.code).toBe('validation_failed');
    expect(error.fieldErrors).toEqual([{ path: 'title', message: 'Required' }]);
  });

  it('falls back to the Retry-After header and status for non-problem bodies', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html>Bad gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html', 'retry-after': '7' },
      }),
    );
    const error = (await apiSend('/ventures').catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('internal');
    expect(error.status).toBe(502);
    expect(error.retryAfter).toBe(7);
    expect(error.isTransient).toBe(true);
    // The client-generated request id is attached so support can correlate.
    expect(error.requestId).toBe(headersOf(fetchMock).get('x-request-id'));
    // Raw bodies are never surfaced.
    expect(errorMessage(error)).not.toContain('html');
  });

  it('turns network failures into network_error and keeps aborts as AbortError', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const network = (await apiSend('/ventures').catch((e: unknown) => e)) as ApiError;
    expect(network.code).toBe('network_error');
    expect(network.status).toBe(0);

    const controller = new AbortController();
    controller.abort();
    fetchMock.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));
    const aborted = await apiSend('/ventures', { signal: controller.signal }).catch((e: unknown) => e);
    expect(aborted).toBeInstanceOf(DOMException);
    expect((aborted as DOMException).name).toBe('AbortError');
  });

  it('parses Retry-After in seconds and HTTP-date forms', () => {
    expect(parseRetryAfter('120')).toBe(120);
    expect(
      parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT', Date.parse('Wed, 21 Oct 2026 07:27:00 GMT')),
    ).toBe(60);
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it('resolves a 204 No Content to null and still validates bodies (apiRequestOrEmpty)', async () => {
    const schema = z.object({ id: z.uuid() });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(apiRequestOrEmpty('/memory/m', { method: 'PATCH', body: {}, schema })).resolves.toBeNull();
    const id = '7d1f2c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
    fetchMock.mockResolvedValueOnce(json({ id }));
    await expect(apiRequestOrEmpty('/memory/m', { method: 'PATCH', body: {}, schema })).resolves.toEqual({
      id,
    });
  });

  it('fails loudly on contract drift in development, logging paths but never values', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchMock.mockResolvedValue(json({ items: [{ id: 'secret-venture-content' }] }));
    const schema = z.object({ items: z.array(z.object({ id: z.uuid() })) });
    const error = (await apiRequest('/ventures', { schema }).catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('contract_mismatch');
    expect(error.detail).toContain('items.0.id');
    expect(consoleError).toHaveBeenCalledOnce();
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('secret-venture-content');
  });
});

describe('database_resuming retry', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Real WebCrypto resolves on Node's thread pool, outside fake time; resolve digests as microtasks
    // so timing is deterministic under parallel test load. (Hash correctness is covered above.)
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(() =>
      Promise.resolve(new ArrayBuffer(32)),
    );
  });

  /** Advance fake time in small steps, yielding to real I/O (WebCrypto) between steps. */
  async function advance(ms: number, step = 100): Promise<void> {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      await vi.advanceTimersByTimeAsync(step);
      await new Promise<void>((resolve) => {
        realSetImmediate(resolve);
      });
    }
  }

  it('waits out 503 database_resuming with backoff, reusing the idempotency key', async () => {
    fetchMock
      .mockResolvedValueOnce(problem(503, 'database_resuming', { retryAfterSeconds: 1 }))
      .mockResolvedValueOnce(problem(503, 'database_resuming'))
      .mockResolvedValueOnce(json({ ok: true }));

    const result = apiRequest('/ventures/v/sessions', {
      method: 'POST',
      body: { mode: 'diagnose' },
      idempotencyKey: 'intent-1',
      schema: z.object({ ok: z.boolean() }),
    });

    await advance(300);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resumingStore.getSnapshot().waiting).toBe(1);
    expect(resumingStore.getSnapshot().since).not.toBeNull();

    await advance(8_000);
    await expect(result).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(resumingStore.getSnapshot().waiting).toBe(0);
    expect(resumingStore.getSnapshot().lastResumedAt).not.toBeNull();

    const keys = [0, 1, 2].map((i) => headersOf(fetchMock, i).get('idempotency-key'));
    expect(new Set(keys)).toEqual(new Set(['intent-1']));
    const requestIds = [0, 1, 2].map((i) => headersOf(fetchMock, i).get('x-request-id'));
    expect(new Set(requestIds).size).toBe(3);
  });

  it('gives up after the maximum wait and surfaces database_resuming', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(problem(503, 'database_resuming')));
    const result = apiSend('/ventures').catch((e: unknown) => e);
    await advance(RESUME_MAX_WAIT_MS + 2_000, 500);
    const error = (await result) as ApiError;
    expect(error.code).toBe('database_resuming');
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(resumingStore.getSnapshot().waiting).toBe(0);
  });

  it('stops waiting immediately when the person cancels', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(problem(503, 'database_resuming')));
    const result = apiSend('/ventures').catch((e: unknown) => e);
    await advance(200);
    expect(resumingStore.getSnapshot().waiting).toBe(1);
    resumingStore.cancelAll();
    const error = (await result) as ApiError;
    expect(error.code).toBe('database_resuming');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resumingStore.getSnapshot().waiting).toBe(0);
  });

  it('propagates caller aborts during the wait as AbortError', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(problem(503, 'database_resuming')));
    const controller = new AbortController();
    const result = apiSend('/ventures', { signal: controller.signal }).catch((e: unknown) => e);
    await advance(200);
    controller.abort();
    const error = await result;
    expect((error as Error).name).toBe('AbortError');
  });

  it('does not retry when waitForResume is false', async () => {
    fetchMock.mockResolvedValue(problem(503, 'database_resuming'));
    const error = (await apiSend('/health', { waitForResume: false }).catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('database_resuming');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('computes exponential delays with jitter, capped, honouring Retry-After', () => {
    const mid = () => 0.5; // no jitter
    expect(resumeDelay(0, undefined, mid)).toBe(1000);
    expect(resumeDelay(1, undefined, mid)).toBe(2000);
    expect(resumeDelay(2, undefined, mid)).toBe(4000);
    expect(resumeDelay(5, undefined, mid)).toBe(8000);
    expect(resumeDelay(0, 5, mid)).toBe(5000);
    expect(resumeDelay(0, undefined, () => 0)).toBe(800);
    expect(resumeDelay(0, undefined, () => 1)).toBe(1200);
  });
});
