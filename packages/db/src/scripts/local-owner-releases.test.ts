import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { THOMAS_RELEASE, parseOwnerReleases } from '../seed/owner-releases.js';
import { PRODUCTION_CONFIG, localOwnerReleases } from './local-owner-releases.js';

describe('local reset owner releases', () => {
  it("applies production's owner releases by default, so a local stack presents Thomas as production does", () => {
    const releases = localOwnerReleases({});
    expect(releases.source).toBe('production');
    const production = JSON.parse(readFileSync(PRODUCTION_CONFIG, 'utf8')) as {
      homeTenant: { ownerReleases: string[] };
    };
    expect(releases.raw).toBe(production.homeTenant.ownerReleases.join(','));
    expect(parseOwnerReleases(releases.raw)).toContain(THOMAS_RELEASE.key);
  });

  it('lets SEED_OWNER_RELEASES choose, and an empty value apply none (the seeded twin)', () => {
    const unread = (): string => {
      throw new Error('production.json must not be read when the variable is set');
    };
    expect(localOwnerReleases({ SEED_OWNER_RELEASES: 'thomas-2026-11-05' }, unread)).toEqual({
      raw: 'thomas-2026-11-05',
      source: 'env',
    });
    expect(localOwnerReleases({ SEED_OWNER_RELEASES: '' }, unread)).toEqual({ raw: '', source: 'env' });
    expect(parseOwnerReleases('')).toEqual([]);
  });

  it('reads none from a configuration without owner releases, and refuses a malformed one', () => {
    expect(localOwnerReleases({}, () => '{"homeTenant": {}}')).toEqual({ raw: '', source: 'production' });
    expect(localOwnerReleases({}, () => '{"homeTenant": {"ownerReleases": ["a", "b"]}}').raw).toBe('a,b');
    expect(() => localOwnerReleases({}, () => '{"homeTenant": {"ownerReleases": "a"}}')).toThrow(
      /list of release keys/,
    );
    expect(() => localOwnerReleases({}, () => 'not json')).toThrow(/SEED_OWNER_RELEASES/);
  });
});
