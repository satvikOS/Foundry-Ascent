import { describe, expect, it } from 'vitest';

import { ageRequest } from './lab-age-conversation.js';
import { refusal } from './lab-local-db.js';

describe('the lab scripts refuse every database but the lab’s local Postgres', () => {
  it('accepts a local Postgres outside production (TCP or a Unix socket)', () => {
    expect(refusal({ DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/foundry_lab' })).toBeNull();
    expect(refusal({ DATABASE_URL: 'postgres://u@127.0.0.1/db', APP_ENV: 'development' })).toBeNull();
    expect(
      refusal({ DATABASE_URL: 'postgresql://postgres@localhost/foundry?host=/var/tmp&port=54329' }),
    ).toBeNull();
  });

  it('refuses production, the Data API, a remote host and a missing or odd URL', () => {
    expect(refusal({ DATABASE_URL: 'postgresql://u@localhost/db', APP_ENV: 'production' })).toMatch(
      /production/,
    );
    expect(refusal({ DATABASE_URL: 'postgresql://u@localhost/db', DB_DRIVER: 'data-api' })).toMatch(
      /DB_DRIVER/,
    );
    expect(refusal({ DATABASE_URL: 'postgresql://u@db.cluster-x.us-east-1.rds.amazonaws.com/db' })).toMatch(
      /not a local/,
    );
    expect(refusal({ DATABASE_URL: 'postgresql://u@localhost/db?host=db.example.com' })).toMatch(
      /not a local/,
    );
    expect(refusal({})).toMatch(/not set/);
    expect(refusal({ DATABASE_URL: 'not a url' })).toMatch(/not a URL/);
    expect(refusal({ DATABASE_URL: 'mysql://u@localhost/db' })).toMatch(/not postgres/);
  });
});

describe('lab-age-conversation', () => {
  const local = { DATABASE_URL: 'postgresql://postgres@localhost/foundry_lab' };
  const id = '0f6c2b9e-3a1d-4c55-9e0a-2b7d1f4a8c11';

  it('takes the conversation, the gap and what evals passes besides', () => {
    expect(
      ageRequest(
        [
          '--session-id',
          id,
          '--gap-days',
          '14',
          '--venture',
          'lanternwise',
          '--venture-id',
          id,
          '--actor',
          'a#1',
        ],
        local,
      ),
    ).toEqual({ ok: true, request: { sessionId: id, days: 14, waitSeconds: 120 } });
    expect(ageRequest(['--session-id', id, '--gap-days', '3', '--wait-seconds', '0'], local)).toEqual({
      ok: true,
      request: { sessionId: id, days: 3, waitSeconds: 0 },
    });
  });

  it('refuses a deployed or remote database before it reads any argument', () => {
    const argv = ['--session-id', id, '--gap-days', '3'];
    expect(ageRequest(argv, { ...local, APP_ENV: 'production' })).toEqual({
      ok: false,
      reason: 'APP_ENV is production',
    });
    expect(
      ageRequest(argv, { DATABASE_URL: 'postgresql://u@db.cluster-x.us-east-1.rds.amazonaws.com/db' }),
    ).toEqual({
      ok: false,
      reason: 'DATABASE_URL is not a local database',
    });
    expect(ageRequest(argv, { ...local, DB_DRIVER: 'data-api' })).toMatchObject({ ok: false });
  });

  it('refuses a malformed request', () => {
    expect(ageRequest(['--session-id', 'x', '--gap-days', '3'], local)).toEqual({
      ok: false,
      reason: '--session-id',
    });
    for (const gap of ['0', '1.5', '366', 'soon']) {
      expect(ageRequest(['--session-id', id, '--gap-days', gap], local)).toMatchObject({ ok: false });
    }
    expect(ageRequest(['--session-id', id, '--gap-days', '3', '--drop', 'all'], local)).toEqual({
      ok: false,
      reason: 'unknown or malformed argument',
    });
  });
});
