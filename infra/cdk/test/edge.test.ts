/** Executes the CloudFront Function sources (plain ES5-compatible JS) against sample viewer requests. */
import { describe, expect, it } from 'vitest';
import { API_VIEWER_REQUEST_CODE, SPA_REWRITE_CODE } from '../src/constructs/edge.js';
import { VIEWER_HOST_HEADER, VIEWER_IP_HEADER } from '../src/lib/constants.js';

interface CfRequest {
  uri: string;
  headers: Record<string, { value: string }>;
}
/**
 * CloudFront Functions event (runtime 1.0 and 2.0 share it; see @types/aws-lambda
 * `CloudFrontFunctionsEvent`): `{ version, context: { distributionDomainName, distributionId, eventType,
 * requestId }, viewer: { ip }, request: { method, uri, querystring, headers, cookies } }`. Header names
 * are lower-case.
 */
interface CfEvent {
  version: '1.0';
  request: CfRequest;
  context: {
    distributionDomainName: string;
    distributionId: string;
    eventType: 'viewer-request';
    requestId: string;
  };
  viewer: { ip: string };
}
type Handler = (event: CfEvent) => CfRequest;

function load(code: string): Handler {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- evaluating our own CloudFront Function source
  const factory = new Function(`${code}\nreturn handler;`) as () => Handler;
  return factory();
}

const event = (
  uri: string,
  headers: Record<string, { value: string }> = {},
  viewerIp = '203.0.113.9',
): CfEvent => ({
  version: '1.0',
  request: { uri, headers },
  context: {
    distributionDomainName: 'd111111abcdef8.cloudfront.net',
    distributionId: 'EDFDVBD6EXAMPLE',
    eventType: 'viewer-request',
    requestId: 'req',
  },
  viewer: { ip: viewerIp },
});

describe('SPA rewrite (default behavior, viewer-request)', () => {
  const handler = load(SPA_REWRITE_CODE);

  it.each([
    ['/', '/index.html'],
    ['/sign-in', '/index.html'],
    ['/ain/app/ventures/0b6f/coach', '/index.html'],
    ['/admin/', '/index.html'],
    ['/assets/index-3f2a9c.js', '/assets/index-3f2a9c.js'],
    ['/assets/inter-latin.woff2', '/assets/inter-latin.woff2'],
    ['/favicon.svg', '/favicon.svg'],
    ['/index.html', '/index.html'],
    ['/api', '/api'],
    ['/api/v1/health', '/api/v1/health'],
    ['/api/v1/ventures/123', '/api/v1/ventures/123'],
  ])('%s -> %s', (uri, expected) => {
    expect(handler(event(uri)).uri).toBe(expected);
  });

  it('does not treat /apiary as the API', () => {
    expect(handler(event('/apiary')).uri).toBe('/index.html');
  });
});

describe('API viewer request (/api/*, viewer-request)', () => {
  const handler = load(API_VIEWER_REQUEST_CODE);

  it('sets the trusted viewer IP from event.viewer.ip (IPv4 and IPv6)', () => {
    expect(VIEWER_IP_HEADER).toBe('x-fa-viewer-ip');
    expect(handler(event('/api/v1/auth/sign-in', {}, '198.51.100.23')).headers[VIEWER_IP_HEADER]).toEqual({
      value: '198.51.100.23',
    });
    expect(handler(event('/api/v1/auth/sign-in', {}, '2001:db8::7')).headers[VIEWER_IP_HEADER]).toEqual({
      value: '2001:db8::7',
    });
  });

  it('overwrites a client-supplied viewer IP and leaves x-forwarded-for alone (the API ignores it)', () => {
    const request = handler(
      event(
        '/api/v1/auth/sign-in',
        { [VIEWER_IP_HEADER]: { value: '10.0.0.1' }, 'x-forwarded-for': { value: '10.0.0.2' } },
        '198.51.100.23',
      ),
    );
    expect(request.headers[VIEWER_IP_HEADER]).toEqual({ value: '198.51.100.23' });
    expect(request.headers['x-forwarded-for']).toEqual({ value: '10.0.0.2' });
  });

  it('records the Host the browser used', () => {
    const request = handler(event('/api/v1/me', { host: { value: 'ascent.example.org' } }));
    expect(request.headers[VIEWER_HOST_HEADER]).toEqual({ value: 'ascent.example.org' });
    expect(request.uri).toBe('/api/v1/me');
  });

  it('overwrites a client-supplied value', () => {
    const request = handler(
      event('/api/v1/me', {
        host: { value: 'd111111abcdef8.cloudfront.net' },
        [VIEWER_HOST_HEADER]: { value: 'evil.example' },
      }),
    );
    expect(request.headers[VIEWER_HOST_HEADER]).toEqual({ value: 'd111111abcdef8.cloudfront.net' });
  });

  it('falls back to the distribution domain', () => {
    expect(handler(event('/api/v1/me')).headers[VIEWER_HOST_HEADER]).toEqual({
      value: 'd111111abcdef8.cloudfront.net',
    });
  });
});
