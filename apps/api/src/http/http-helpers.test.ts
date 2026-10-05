import { DomainError } from '@foundry/core';
import { DatabaseResumingError, DbError } from '@foundry/db';
import { describe, expect, it } from 'vitest';

import { createJsonLogger, errorFields, principalHash } from '../logging.js';
import { InflightTracker } from '../runtime/inflight.js';
import { sleep } from '../testing/fakes.js';
import { EventChannel } from './event-channel.js';
import { requestHash } from './idempotency.js';
import { classifyError, DEFAULT_RETRY_AFTER_SECONDS, problemDetails } from './problem.js';
import {
  clearedSessionCookie,
  resolveRequestId,
  sessionCookie,
  VIEWER_IP_HEADER,
  viewerIp,
} from './request-meta.js';

describe('viewerIp', () => {
  const production = (headers: Record<string, string>) =>
    viewerIp(new Headers(headers), { trustForwardedFor: false });
  const development = (headers: Record<string, string>) =>
    viewerIp(new Headers(headers), { trustForwardedFor: true });

  it('uses the header set by the CloudFront viewer-request function (x-fa-viewer-ip)', () => {
    expect(VIEWER_IP_HEADER).toBe('x-fa-viewer-ip');
    expect(production({ 'x-fa-viewer-ip': '203.0.113.7' })).toBe('203.0.113.7');
    expect(production({ 'x-fa-viewer-ip': '2001:db8::1' })).toBe('2001:db8::1');
    expect(production({ 'x-fa-viewer-ip': ' 2001:db8::1:443 ' })).toBe('2001:db8::1:443');
  });

  it('never trusts client-controlled headers outside development', () => {
    // A forged x-forwarded-for or CloudFront-Viewer-Address cannot pick the lockout bucket.
    expect(
      production({
        'x-fa-viewer-ip': '203.0.113.7',
        'x-forwarded-for': '198.51.100.1',
        'cloudfront-viewer-address': '198.51.100.2:443',
      }),
    ).toBe('203.0.113.7');
    expect(production({ 'x-forwarded-for': '198.51.100.1, 130.176.0.1' })).toBeNull();
    expect(production({ 'cloudfront-viewer-address': '198.51.100.2:443' })).toBeNull();
    expect(production({ 'x-fa-viewer-ip': 'garbage' })).toBeNull();
    expect(production({})).toBeNull();
  });

  it('falls back to the first x-forwarded-for hop in development only', () => {
    expect(development({ 'x-forwarded-for': '198.51.100.1, 130.176.0.1' })).toBe('198.51.100.1');
    expect(development({ 'x-forwarded-for': '[2001:db8::5]:8080' })).toBe('2001:db8::5');
    expect(development({ 'x-forwarded-for': '198.51.100.9:5173' })).toBe('198.51.100.9');
    expect(development({ 'x-fa-viewer-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' })).toBe(
      '203.0.113.7',
    );
    expect(development({ 'x-forwarded-for': 'unknown' })).toBeNull();
    expect(development({})).toBeNull();
  });
});

describe('request ids and cookies', () => {
  it('accepts well-formed ids only', () => {
    expect(resolveRequestId('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(
      '0f8fad5b-d9cb-469f-a165-70867728950e',
    );
    expect(resolveRequestId('short')).not.toBe('short');
    expect(resolveRequestId('x'.repeat(200))).toHaveLength(36);
    expect(resolveRequestId(undefined)).toHaveLength(36);
  });

  it('builds the session cookie with every required attribute', () => {
    const cookie = sessionCookie('a.b.c', 43_200, new Date('2026-10-05T00:00:00Z'));
    expect(cookie).toBe(
      'fa_session=a.b.c; Max-Age=43200; Expires=Mon, 05 Oct 2026 12:00:00 GMT; Path=/api; HttpOnly; Secure; SameSite=Strict',
    );
    expect(() => sessionCookie('bad;token', 10)).toThrow(TypeError);
    expect(clearedSessionCookie()).toMatch(
      /^fa_session=; Max-Age=0;.*Path=\/api; HttpOnly; Secure; SameSite=Strict$/,
    );
  });
});

describe('problem mapping', () => {
  it('maps infrastructure errors through core and hides unknown ones', () => {
    const resuming = classifyError(new DatabaseResumingError({ waitedMs: 45_000, retryAfterSeconds: 7 }));
    expect(resuming).toMatchObject({ unexpected: false, error: { code: 'database_resuming', status: 503 } });
    expect(problemDetails(resuming.error, 'r1')).toMatchObject({
      status: 503,
      retryAfterSeconds: 7,
      requestId: 'r1',
    });

    expect(classifyError(new DbError('dup', { sqlState: '23505' })).error.code).toBe('conflict');
    expect(classifyError(new DbError('rls', { sqlState: '42501' })).error.code).toBe('forbidden');

    const unknown = classifyError(new Error('select * from secrets'));
    expect(unknown.unexpected).toBe(true);
    expect(problemDetails(unknown.error, 'r2')).toMatchObject({ status: 500, code: 'internal' });
    expect(JSON.stringify(problemDetails(unknown.error, 'r2'))).not.toContain('secrets');
  });

  it('always gives database_resuming, locked_out and rate_limited a retry hint', () => {
    for (const code of ['database_resuming', 'locked_out', 'rate_limited', 'spend_cap_reached'] as const) {
      const body = problemDetails(new DomainError(code, 'Retry later'), 'r4');
      expect(body.retryAfterSeconds, code).toBe(DEFAULT_RETRY_AFTER_SECONDS[code]);
    }
    expect(
      problemDetails(new DomainError('locked_out', 'x', { retryAfterSeconds: 0.2 }), 'r5').retryAfterSeconds,
    ).toBe(1);
    expect(problemDetails(new DomainError('not_found', 'x'), 'r6')).not.toHaveProperty('retryAfterSeconds');
  });

  it('includes field errors and a stable type URI', () => {
    const error = new DomainError('validation_failed', 'Invalid', {
      errors: [{ path: 'text', message: 'Required' }],
    });
    expect(problemDetails(error, 'r3')).toEqual({
      type: 'urn:foundry-ascent:problem:validation_failed',
      title: 'Validation failed',
      status: 422,
      detail: 'Invalid',
      code: 'validation_failed',
      requestId: 'r3',
      errors: [{ path: 'text', message: 'Required' }],
    });
  });
});

describe('logging', () => {
  it('writes one JSON line per event, filtered by level, with truncated strings', () => {
    const lines: string[] = [];
    const logger = createJsonLogger({
      level: 'info',
      base: { service: 's' },
      write: (l) => lines.push(l),
      now: () => new Date(0),
    });
    logger.debug('hidden');
    logger
      .child({ requestId: 'r' })
      .warn('visible', { count: 2, long: 'x'.repeat(2_000), skipped: undefined });
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(line).toMatchObject({
      level: 'warn',
      event: 'visible',
      service: 's',
      requestId: 'r',
      count: 2,
      time: '1970-01-01T00:00:00.000Z',
    });
    expect(String(line.long).length).toBeLessThan(1_100);
    expect('skipped' in line).toBe(false);
  });

  it('hashes principal ids and strips error messages', () => {
    expect(principalHash('AAAAAAAA-0000-4000-8000-000000000000')).toBe(
      principalHash('aaaaaaaa-0000-4000-8000-000000000000'),
    );
    const fields = errorFields(new TypeError('contains SECRET content'));
    expect(fields.errorName).toBe('TypeError');
    expect(JSON.stringify(fields)).not.toContain('SECRET');
  });
});

describe('EventChannel and InflightTracker', () => {
  it('delivers every item in order to a late consumer and ends on close', async () => {
    const channel = new EventChannel<number>();
    channel.push(1);
    const firstPromise = channel.first();
    channel.push(2);
    setTimeout(() => {
      channel.push(3);
      channel.close();
      channel.push(4);
    }, 5);
    const seen: number[] = [];
    for await (const item of channel) seen.push(item);
    expect(seen).toEqual([1, 2, 3]);
    expect(await firstPromise).toBe(1);
    const empty = new EventChannel<number>();
    empty.close();
    expect(await empty.first()).toBeNull();
  });

  it('drains tracked work with a timeout', async () => {
    const tracker = new InflightTracker();
    void tracker.track(sleep(10));
    void tracker.track(Promise.reject(new Error('ignored')).catch(() => undefined));
    expect(await tracker.drain(1_000)).toBe(0);
    void tracker.track(sleep(200));
    expect(await tracker.drain(10)).toBe(1);
  });
});

describe('requestHash', () => {
  it('binds method, path and body', () => {
    const body = new TextEncoder().encode('{"a":1}');
    expect(requestHash('post', '/x', body)).toBe(requestHash('POST', '/x', body));
    expect(requestHash('POST', '/x', body)).not.toBe(requestHash('POST', '/y', body));
    expect(requestHash('POST', '/x', body)).not.toBe(
      requestHash('POST', '/x', new TextEncoder().encode('{"a":2}')),
    );
  });
});
