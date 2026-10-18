import { request, createServer } from 'node:https';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CountingAgent, KEEP_ALIVE_MSECS, awsConnectionStats, sharedAwsAgent } from './http-agent.js';

/** A self-signed certificate for localhost, for this test only (no secret: it guards nothing). */
const KEY = [
  '-----BEGIN PRIVATE KEY-----',
  'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgiq68fBMbIdn4JRKG',
  '8auwC5dQM55Pb7XkonT3VHStMpWhRANCAAT07EzTzCSyCQEgrWG4+H9w/MPS1lfH',
  'edDxON6bkKUuJDzj53SxKwA/5+5dEtCYWAwL7RBqcu1iM/oL6+XU6Vdm',
  '-----END PRIVATE KEY-----',
].join('\n');
const CERT = [
  '-----BEGIN CERTIFICATE-----',
  'MIIBnDCCAUGgAwIBAgIUQUgDQFI8ErjnGLKecq4Sw5C23d4wCgYIKoZIzj0EAwIw',
  'FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAxODA1NTAxMFoYDzIxMjYwOTI0',
  'MDU1MDEwWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO',
  'PQMBBwNCAAT07EzTzCSyCQEgrWG4+H9w/MPS1lfHedDxON6bkKUuJDzj53SxKwA/',
  '5+5dEtCYWAwL7RBqcu1iM/oL6+XU6Vdmo28wbTAdBgNVHQ4EFgQUuwFVAdsbHwJC',
  'crDEnH7kOsPAopswHwYDVR0jBBgwFoAUuwFVAdsbHwJCcrDEnH7kOsPAopswDwYD',
  'VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI',
  'zj0EAwIDSQAwRgIhAIBBOgSgDlFZUu/vxMBgjzgJSgp+frqWSbRGZ69M5HNLAiEA',
  'ubsdKRCidOk5WEDawlqoc5diU3pWTtbMvuTaS66mTvM=',
  '-----END CERTIFICATE-----',
].join('\n');

const server = createServer({ key: KEY, cert: CERT }, (_req, res) => {
  res.end('ok');
});
let port = 0;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
});

function get(agent: CountingAgent): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/', agent, rejectUnauthorized: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => {
        resolve(body);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('the AWS clients’ keep-alive agent (LAB-P2)', () => {
  it('opens one connection for requests one after another, reuses it, and counts both', async () => {
    const agent = new CountingAgent({ keepAlive: true, keepAliveMsecs: KEEP_ALIVE_MSECS });
    const before = awsConnectionStats();
    for (let i = 0; i < 3; i += 1) expect(await get(agent)).toBe('ok');
    const after = awsConnectionStats();
    expect(after.opened - before.opened).toBe(1);
    expect(after.reused - before.reused).toBe(2);
    agent.destroy();
  });

  it('is one agent for the whole process, keeping idle connections alive', () => {
    const agent = sharedAwsAgent();
    expect(sharedAwsAgent()).toBe(agent);
    expect(agent.options.keepAlive).toBe(true);
    expect(agent.options.keepAliveMsecs).toBe(KEEP_ALIVE_MSECS);
  });
});
