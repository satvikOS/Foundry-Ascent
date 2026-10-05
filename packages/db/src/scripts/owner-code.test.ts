import { describe, expect, it } from 'vitest';

import { ACCESS_CODE_RE, verifyAccessCode } from '../seed/access-code.js';
import { createOwnerCode, renderOwnerCode, runningInCi } from './owner-code.js';

describe('owner-code script', () => {
  it('creates a fresh code whose prefix and hash belong to it', async () => {
    const owner = await createOwnerCode();
    expect(owner.code).toMatch(ACCESS_CODE_RE);
    expect(owner.prefix).toBe(owner.code.slice(3, 8));
    expect(await verifyAccessCode(owner.code, owner.hash)).toBe(true);
    const other = await createOwnerCode();
    expect(other.code).not.toBe(owner.code);
  });

  it('prints the code once, with a warning, and the production.json values', () => {
    const text = renderOwnerCode({
      code: 'FA-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ',
      prefix: 'ZZZZZ',
      hash: 'scrypt$N=32768,r=8,p=1$salt$key',
    });
    expect(text.split('FA-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ')).toHaveLength(2);
    expect(text).toMatch(/WARNING: .* shown only once/);
    expect(text).toContain('"accessCodePrefix": "ZZZZZ",');
    expect(text).toContain('"accessCodeHash": "scrypt$N=32768,r=8,p=1$salt$key"');
    expect(text).toContain('infra/cdk/config/production.json');
  });

  it('refuses CI environments, where output lands in a log', () => {
    expect(runningInCi({ GITHUB_ACTIONS: 'true' })).toBe(true);
    expect(runningInCi({ CI: 'true' })).toBe(true);
    expect(runningInCi({ CI: '1' })).toBe(true);
    expect(runningInCi({ CI: 'false' })).toBe(false);
    expect(runningInCi({})).toBe(false);
  });
});
