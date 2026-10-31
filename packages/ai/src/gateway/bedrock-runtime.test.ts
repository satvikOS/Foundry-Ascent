import { createServer, type Http2Server, type ServerHttp2Session } from 'node:http2';
import { type AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createBedrockRuntimeTransport } from './bedrock-runtime.js';

/**
 * A local stand-in for the Bedrock runtime that refuses every request as Bedrock refuses an invalid one. The Bedrock
 * runtime client speaks HTTP/2 (its default handler), so the stand-in does too (cleartext, prior knowledge).
 */
let server: Http2Server;
let endpoint: string;
const seen: { path: string; body: string }[] = [];
/** Connections (HTTP/2 sessions) the stand-in accepted. */
const sessions: ServerHttp2Session[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      seen.push({ path: decodeURIComponent(req.url), body });
      res.writeHead(400, {
        'content-type': 'application/json',
        'x-amzn-errortype': 'ValidationException',
        'x-amzn-requestid': 'stand-in',
      });
      res.end(JSON.stringify({ message: 'refused' }));
    });
  });
  server.on('session', (session) => {
    sessions.push(session);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  endpoint = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  for (const session of sessions) session.destroy();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

const transport = () =>
  createBedrockRuntimeTransport({
    region: 'us-east-1',
    endpoint,
    maxAttempts: 1,
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'example-secret' },
  });

describe('prewarming the Bedrock runtime connection', () => {
  it('sends a Converse and then an InvokeModel the runtime refuses before any model runs, and never rejects', async () => {
    seen.length = 0;
    sessions.length = 0;
    await expect(
      transport().prewarm('us.amazon.nova-2-lite-v1:0', 'amazon.titan-embed-text-v2:0'),
    ).resolves.toBeUndefined();
    expect(seen.map((r) => r.path)).toEqual([
      '/model/us.amazon.nova-2-lite-v1:0/converse',
      '/model/amazon.titan-embed-text-v2:0/invoke',
    ]);
    // No message and no input text: nothing a model could run on, so nothing is billed.
    expect(JSON.parse(seen[0]?.body ?? 'null')).toEqual({ messages: [] });
    expect(seen[1]?.body).toBe('{}');
    // One after the other on one connection, which the turn's embedding and model call then reuse.
    expect(sessions).toHaveLength(1);
  });

  it('warms Nova alone without an embedding model', async () => {
    seen.length = 0;
    await transport().prewarm('us.amazon.nova-2-lite-v1:0');
    expect(seen.map((r) => r.path)).toEqual(['/model/us.amazon.nova-2-lite-v1:0/converse']);
  });

  it('resolves when the runtime cannot be reached', async () => {
    const unreachable = createBedrockRuntimeTransport({
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:9',
      maxAttempts: 1,
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'example-secret' },
    });
    await expect(
      unreachable.prewarm('us.amazon.nova-2-lite-v1:0', 'amazon.titan-embed-text-v2:0'),
    ).resolves.toBeUndefined();
  });
});
