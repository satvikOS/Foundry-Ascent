/** Executes the CloudFront Function sources (plain ES5-compatible JS) against sample viewer requests. */
import { describe, expect, it } from 'vitest';
import { API_VIEWER_HOST_CODE, SPA_REWRITE_CODE } from '../src/constructs/edge.js';
import { VIEWER_HOST_HEADER } from '../src/lib/constants.js';

interface CfRequest {
  uri: string;
  headers: Record<string, { value: string }>;
}
interface CfEvent {
  request: CfRequest;
  context: { distributionDomainName: string };
}
type Handler = (event: CfEvent) => CfRequest;

function load(code: string): Handler {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- evaluating our own CloudFront Function source
  const factory = new Function(`${code}\nreturn handler;`) as () => Handler;
  return factory();
}

const event = (uri: string, headers: Record<string, { value: string }> = {}): CfEvent => ({
  request: { uri, headers },
  context: { distributionDomainName: 'd111111abcdef8.cloudfront.net' },
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

describe('API viewer host (/api/*, viewer-request)', () => {
  const handler = load(API_VIEWER_HOST_CODE);

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
