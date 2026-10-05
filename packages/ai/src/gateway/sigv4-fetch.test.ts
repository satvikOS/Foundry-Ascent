import { createHash, createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createSigV4Fetch, type FetchFn } from './sigv4-fetch.js';

const CREDS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
const NOW = new Date('2026-10-05T12:34:56Z');
const URL_ = 'https://bedrock-mantle.us-east-1.api.aws/openai/v1/chat/completions';
const BODY = JSON.stringify({
  model: 'openai.gpt-6-luna',
  messages: [{ role: 'user', content: 'héllo — “quotes”' }],
});

interface Captured {
  url: string;
  init: RequestInit;
  headers: Headers;
}

function capture(): { fetch: FetchFn; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetch: FetchFn = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {}, headers: new Headers(init?.headers) });
    return Promise.resolve(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  };
  return { fetch, calls };
}

const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest();

/** Independent SigV4 implementation (AWS docs) used to verify the signer's output. */
function expectedSignature(opts: {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  payloadHash: string;
  amzDate: string;
  region: string;
  service: string;
  secret: string;
}): { signature: string; signedHeaders: string } {
  const names = Object.keys(opts.headers)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders = names.map((n) => `${n}:${(opts.headers[n] ?? '').trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    opts.method,
    opts.path,
    opts.query,
    canonicalHeaders,
    signedHeaders,
    opts.payloadHash,
  ].join('\n');
  const date = opts.amzDate.slice(0, 8);
  const scope = `${date}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', opts.amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${opts.secret}`, date);
  const kRegion = hmac(kDate, opts.region);
  const kService = hmac(kRegion, opts.service);
  const kSigning = hmac(kService, 'aws4_request');
  return {
    signature: createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex'),
    signedHeaders,
  };
}

describe('createSigV4Fetch', () => {
  it('signs for bedrock-mantle in us-east-1 with a body hash matching the exact payload', async () => {
    const { fetch, calls } = capture();
    const signed = createSigV4Fetch({ region: 'us-east-1', credentials: CREDS, fetch, now: () => NOW });

    await signed(URL_, {
      method: 'POST',
      body: BODY,
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer sigv4',
        'user-agent': 'OpenAI/JS 7.28.0',
        'x-stainless-os': 'Linux',
        accept: 'application/json',
      },
    });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error('no call');
    const auth = call.headers.get('authorization') ?? '';
    expect(auth).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261005\/us-east-1\/bedrock-mantle\/aws4_request, /,
    );
    expect(auth).toContain('SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date,');
    expect(auth).not.toContain('Bearer');
    expect(call.headers.get('x-amz-content-sha256')).toBe(sha256Hex(Buffer.from(BODY, 'utf8')));
    expect(call.headers.get('x-amz-date')).toBe('20261005T123456Z');
    // Unsigned headers that fetch/SDKs may rewrite are passed through untouched.
    expect(call.headers.get('user-agent')).toBe('OpenAI/JS 7.28.0');
    expect(call.headers.get('x-stainless-os')).toBe('Linux');
    expect(call.headers.has('host')).toBe(false);
    expect(call.init.body).toBe(BODY);
    expect(call.init.method).toBe('POST');
    expect(call.url).toBe(URL_);

    const expected = expectedSignature({
      method: 'POST',
      path: '/openai/v1/chat/completions',
      query: '',
      headers: {
        'content-type': 'application/json',
        host: 'bedrock-mantle.us-east-1.api.aws',
        'x-amz-content-sha256': sha256Hex(Buffer.from(BODY, 'utf8')),
        'x-amz-date': '20261005T123456Z',
      },
      payloadHash: sha256Hex(Buffer.from(BODY, 'utf8')),
      amzDate: '20261005T123456Z',
      region: 'us-east-1',
      service: 'bedrock-mantle',
      secret: CREDS.secretAccessKey,
    });
    expect(auth).toBe(
      `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261005/us-east-1/bedrock-mantle/aws4_request, SignedHeaders=${expected.signedHeaders}, Signature=${expected.signature}`,
    );
  });

  it('signs the session token and sorted query parameters', async () => {
    const { fetch, calls } = capture();
    const signed = createSigV4Fetch({
      region: 'us-east-1',
      credentials: () => Promise.resolve({ ...CREDS, sessionToken: 'SESSION/TOKEN+1' }),
      fetch,
      now: () => NOW,
    });
    await signed(`${URL_.replace('/chat/completions', '/models')}?b=2&a=1`, { method: 'GET' });
    const call = calls[0];
    if (!call) throw new Error('no call');
    const auth = call.headers.get('authorization') ?? '';
    expect(call.headers.get('x-amz-security-token')).toBe('SESSION/TOKEN+1');
    expect(auth).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,');
    const emptyHash = sha256Hex('');
    expect(call.headers.get('x-amz-content-sha256')).toBe(emptyHash);
    const expected = expectedSignature({
      method: 'GET',
      path: '/openai/v1/models',
      query: 'a=1&b=2',
      headers: {
        host: 'bedrock-mantle.us-east-1.api.aws',
        'x-amz-content-sha256': emptyHash,
        'x-amz-date': '20261005T123456Z',
        'x-amz-security-token': 'SESSION/TOKEN+1',
      },
      payloadHash: emptyHash,
      amzDate: '20261005T123456Z',
      region: 'us-east-1',
      service: 'bedrock-mantle',
      secret: CREDS.secretAccessKey,
    });
    expect(auth.endsWith(`Signature=${expected.signature}`)).toBe(true);
    expect(call.init.body).toBeUndefined();
  });

  it('accepts a Request object and Uint8Array bodies', async () => {
    const { fetch, calls } = capture();
    const signed = createSigV4Fetch({
      region: 'eu-west-1',
      service: 'custom-svc',
      credentials: CREDS,
      fetch,
      now: () => NOW,
    });
    const bytes = new TextEncoder().encode(BODY);
    await signed(
      new Request(URL_, { method: 'POST', body: bytes, headers: { 'content-type': 'application/json' } }),
    );
    const call = calls[0];
    if (!call) throw new Error('no call');
    expect(call.headers.get('authorization')).toContain('/eu-west-1/custom-svc/aws4_request');
    expect(call.headers.get('x-amz-content-sha256')).toBe(sha256Hex(bytes));
  });

  it('rejects streaming bodies it cannot hash', async () => {
    const { fetch } = capture();
    const signed = createSigV4Fetch({ region: 'us-east-1', credentials: CREDS, fetch, now: () => NOW });
    const stream = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
    await expect(signed(URL_, { method: 'POST', body: stream, duplex: 'half' })).rejects.toThrow(TypeError);
  });

  it('propagates credential failures', async () => {
    const { fetch } = capture();
    const signed = createSigV4Fetch({
      region: 'us-east-1',
      credentials: () =>
        Promise.reject(Object.assign(new Error('no creds'), { name: 'CredentialsProviderError' })),
      fetch,
    });
    await expect(signed(URL_, { method: 'POST', body: '{}' })).rejects.toMatchObject({
      name: 'CredentialsProviderError',
    });
  });
});
