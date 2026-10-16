import { createHash, createHmac } from 'node:crypto';

import { CALL_LIMITS, SttGrantError } from '@foundry/core';
import { describe, expect, it } from 'vitest';

import { loadApiConfig } from '../config.js';
import { sttGrantsFor } from '../runtime/api.js';
import { TranscribeStreamingPresigner } from './transcribe-presigner.js';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const CREDENTIALS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  sessionToken: 'FQoGZXIvYXdzEXAMPLE/token+with=chars',
};
const REQUEST = { languageCode: 'en-US', sampleRateHertz: 16000, expiresInSeconds: 300, requestId: 'req-1' };

/** The SigV4 canonical request AWS computes for this grant (fixed clock, fake credentials). */
const GOLDEN_CANONICAL_REQUEST = [
  'GET',
  '/stream-transcription-websocket',
  [
    'X-Amz-Algorithm=AWS4-HMAC-SHA256',
    'X-Amz-Credential=AKIDEXAMPLE%2F20261016%2Fus-east-1%2Ftranscribe%2Faws4_request',
    'X-Amz-Date=20261016T120000Z',
    'X-Amz-Expires=300',
    'X-Amz-Security-Token=FQoGZXIvYXdzEXAMPLE%2Ftoken%2Bwith%3Dchars',
    'X-Amz-SignedHeaders=host',
    'enable-partial-results-stabilization=true',
    'language-code=en-US',
    'media-encoding=pcm',
    'partial-results-stability=high',
    'sample-rate=16000',
  ].join('&'),
  'host:transcribestreaming.us-east-1.amazonaws.com:8443',
  '',
  'host',
  // SHA-256 of the empty payload.
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
].join('\n');

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** Signs a canonical request the way the SigV4 specification does, independently of the SDK. */
function expectedSignature(canonicalRequest: string): string {
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    '20261016T120000Z',
    '20261016/us-east-1/transcribe/aws4_request',
    createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n');
  const key = hmac(
    hmac(hmac(hmac(`AWS4${CREDENTIALS.secretAccessKey}`, '20261016'), 'us-east-1'), 'transcribe'),
    'aws4_request',
  );
  return hmac(key, stringToSign).toString('hex');
}

/** The query string of a URL in SigV4 canonical form (RFC 3986 encoding, sorted), without the signature. */
function canonicalQuery(url: URL): string {
  const escape = (v: string) =>
    encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return [...url.searchParams]
    .filter(([key]) => key !== 'X-Amz-Signature')
    .map(([key, value]) => `${escape(key)}=${escape(value)}`)
    .sort()
    .join('&');
}

describe('Transcribe streaming presigner', () => {
  it('presigns the browser-direct WebSocket with the golden canonical request', async () => {
    const presigner = new TranscribeStreamingPresigner({
      region: 'us-east-1',
      credentials: CREDENTIALS,
      now: () => NOW,
    });
    const grant = await presigner.issue(REQUEST);
    const url = new URL(grant.url);
    expect(url.protocol).toBe('wss:');
    expect(url.host).toBe('transcribestreaming.us-east-1.amazonaws.com:8443');
    expect(url.pathname).toBe('/stream-transcription-websocket');
    const canonical = [
      'GET',
      url.pathname,
      canonicalQuery(url),
      `host:${url.host}`,
      '',
      'host',
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    ].join('\n');
    expect(canonical).toBe(GOLDEN_CANONICAL_REQUEST);
    expect(url.searchParams.get('X-Amz-Signature')).toBe(expectedSignature(GOLDEN_CANONICAL_REQUEST));
    expect(grant.expiresAt).toBe('2026-10-16T12:05:00.000Z');
    // The URL carries the temporary session token, never the secret key.
    expect(grant.url).not.toContain(CREDENTIALS.secretAccessKey);
    expect(grant.url).not.toContain(encodeURIComponent(CREDENTIALS.secretAccessKey));
  });

  it('presigns the short-lived grant calls ask for', async () => {
    const presigner = new TranscribeStreamingPresigner({
      region: 'us-east-1',
      credentials: CREDENTIALS,
      now: () => NOW,
    });
    const grant = await presigner.issue({ ...REQUEST, expiresInSeconds: CALL_LIMITS.sttGrantSeconds });
    expect(new URL(grant.url).searchParams.get('X-Amz-Expires')).toBe(String(CALL_LIMITS.sttGrantSeconds));
    expect(Date.parse(grant.expiresAt) - NOW.getTime()).toBe(CALL_LIMITS.sttGrantSeconds * 1000);
  });

  it('never presigns for longer than Transcribe allows', async () => {
    const presigner = new TranscribeStreamingPresigner({
      region: 'us-east-1',
      credentials: CREDENTIALS,
      now: () => NOW,
    });
    const grant = await presigner.issue({ ...REQUEST, expiresInSeconds: 3600 });
    expect(new URL(grant.url).searchParams.get('X-Amz-Expires')).toBe('300');
    expect(grant.expiresAt).toBe('2026-10-16T12:05:00.000Z');
  });

  it('reports missing credentials as a grant error', async () => {
    const presigner = new TranscribeStreamingPresigner({
      region: 'us-east-1',
      credentials: () => Promise.reject(new Error('no credentials in this environment')),
      now: () => NOW,
    });
    await expect(presigner.issue(REQUEST)).rejects.toBeInstanceOf(SttGrantError);
  });
});

describe('speech-to-text wiring', () => {
  it('presigns wherever the models run on Bedrock, and grants nothing on the mock model', () => {
    const env = { DOCUMENTS_BUCKET: 'docs-bucket', JOBS_QUEUE_URL: 'https://sqs.test/queue' };
    const config = loadApiConfig(env, 'api');
    expect(sttGrantsFor({ ...env, MODEL_PROVIDER: 'bedrock' }, config).sttGrants).toBeInstanceOf(
      TranscribeStreamingPresigner,
    );
    expect(sttGrantsFor({ ...env, MODEL_PROVIDER: 'mock' }, config)).toEqual({});
    expect(sttGrantsFor(env, config)).toEqual({});
  });
});
