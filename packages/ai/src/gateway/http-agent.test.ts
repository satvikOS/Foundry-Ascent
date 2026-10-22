import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request, createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CountingAgent, KEEP_ALIVE_MSECS, awsConnectionStats, sharedAwsAgent } from './http-agent.js';

/**
 * A throwaway self-signed certificate for localhost, made by `openssl` when the test starts and deleted after it:
 * no key is ever committed (the secret scan reads every commit of this public repository).
 */
const dir = mkdtempSync(join(tmpdir(), 'fa-http-agent-'));
execFileSync(
  'openssl',
  ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost'].concat([
    '-keyout',
    join(dir, 'key.pem'),
    '-out',
    join(dir, 'cert.pem'),
  ]),
  { stdio: 'ignore' },
);
const server = createServer(
  { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) },
  (_req, res) => {
    res.end('ok');
  },
);
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
  rmSync(dir, { recursive: true, force: true });
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
