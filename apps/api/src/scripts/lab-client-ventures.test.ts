import { describe, expect, it } from 'vitest';

import { clientRequest } from './lab-client-ventures.js';

const LOCAL = { DATABASE_URL: 'postgresql://fa_master@localhost/fa_evals?host=/var/tmp&port=54329' };
const VENTURE = '0b7a2c3e-58a6-4b7e-9c1a-2f6f1d6f0a11';

describe('lab-client-ventures arguments', () => {
  it('reads a seed plan or an age request', () => {
    expect(clientRequest(['--plan', 'p.json'], LOCAL)).toEqual({
      ok: true,
      request: { kind: 'seed', planFile: 'p.json' },
    });
    expect(clientRequest(['--age-path', VENTURE, '--days', '7'], LOCAL)).toEqual({
      ok: true,
      request: { kind: 'age', ventureId: VENTURE, days: 7 },
    });
  });

  it.each([
    ['no argument', [], LOCAL],
    ['an unknown argument', ['--wipe'], LOCAL],
    ['a malformed id', ['--age-path', 'x', '--days', '7'], LOCAL],
    ['a bad age', ['--age-path', VENTURE, '--days', '0'], LOCAL],
    ['both at once', ['--age-path', VENTURE, '--days', '7', '--plan', 'p.json'], LOCAL],
    ['a remote database', ['--plan', 'p.json'], { DATABASE_URL: 'postgresql://x@db.example.com/foundry' }],
    ['production', ['--plan', 'p.json'], { ...LOCAL, APP_ENV: 'production' }],
  ])('refuses %s', (_what, argv, env) => {
    expect(clientRequest(argv, env).ok).toBe(false);
  });
});
