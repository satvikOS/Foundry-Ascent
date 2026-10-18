import { describe, expect, it } from 'vitest';

import { refusal } from './lab-memory-venture.js';

describe('lab-memory-venture refuses every database but the lab’s local Postgres', () => {
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
