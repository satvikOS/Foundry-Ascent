import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Doctrine, Style } from '@foundry/contracts';
import { describe, expect, it } from 'vitest';

import { renderBundle } from '../scripts/gen-migrations.js';
import {
  ACCESS_CODE_RE,
  accessCodePrefix,
  generateAccessCode,
  hashAccessCode,
  isAccessCodeHash,
  verifyAccessCode,
} from './access-code.js';
import { GUIDE_DOCTRINE, GUIDE_STYLE } from './doctrine.js';
import { seedId, uuidV5, ventureCanary } from './ids.js';
import { SEED_RESOURCES } from './resources.js';
import { seedConfigFromEnv } from './seed.js';
import { SEED_EIRS, SEED_FOUNDERS, SEED_PROGRAM_LEAD, buildSeedVentures } from './ventures.js';

describe('deterministic ids and canaries', () => {
  it('implements RFC 9562 UUIDv5', () => {
    // Test vector: DNS namespace + "www.example.com".
    expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
    expect(seedId('ain', 'venture', 'quietquad')).toBe(seedId('ain', 'venture', 'quietquad'));
    expect(seedId('ain', 'venture', 'quietquad')).not.toBe(seedId('other', 'venture', 'quietquad'));
  });

  it('produces stable, unique canaries', () => {
    const ventures = buildSeedVentures(() => '2026-01-01');
    const canaries = ventures.map((v) => ventureCanary(v.key));
    expect(new Set(canaries).size).toBe(ventures.length);
    for (const c of canaries) expect(c).toMatch(/^CANARY::[a-z0-9-]+::[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(ventureCanary('quietquad')).toBe(ventureCanary('quietquad'));
  });
});

describe('access codes', () => {
  it('generates well-formed 100-bit codes and verifies scrypt hashes in constant time', async () => {
    const code = generateAccessCode();
    expect(code).toMatch(ACCESS_CODE_RE);
    expect(accessCodePrefix(code.toLowerCase())).toBe(code.slice(3, 8));
    const hash = await hashAccessCode(code);
    expect(isAccessCodeHash(hash)).toBe(true);
    expect(hash.startsWith('scrypt$N=32768,r=8,p=1$')).toBe(true);
    expect(await verifyAccessCode(` ${code.toLowerCase()} `, hash)).toBe(true);
    expect(await verifyAccessCode(generateAccessCode(), hash)).toBe(false);
    expect(await verifyAccessCode(code, 'bcrypt$whatever')).toBe(false);
    expect(() => accessCodePrefix('FA-ILOU0-00000-00000-00000')).toThrow();
  });

  it('accepts the production owner hash format from infra config', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const config = JSON.parse(
      await readFile(join(here, '..', '..', '..', '..', 'infra', 'cdk', 'config', 'production.json'), 'utf8'),
    ) as { owner: { accessCodePrefix: string; accessCodeHash: string } };
    expect(isAccessCodeHash(config.owner.accessCodeHash)).toBe(true);
    expect(config.owner.accessCodePrefix).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}$/);
  });
});

describe('seed content', () => {
  const ventures = buildSeedVentures((n) =>
    new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString().slice(0, 10),
  );
  const people = new Set([SEED_PROGRAM_LEAD, ...SEED_EIRS, ...SEED_FOUNDERS].map((x) => x.key));

  it('has a valid doctrine and style for the contracts', () => {
    expect(Doctrine.parse(GUIDE_DOCTRINE)).toEqual(GUIDE_DOCTRINE);
    expect(Style.parse(GUIDE_STYLE)).toEqual(GUIDE_STYLE);
    const names = GUIDE_DOCTRINE.frameworks.map((f) => f.name.toLowerCase()).join(' | ');
    for (const topic of [
      'customer discovery',
      'falsifiable',
      'evidence ledger',
      'business-model',
      'commercialization',
      'rehearsal',
    ]) {
      expect(names).toContain(topic);
    }
    expect(GUIDE_DOCTRINE.redLines.length).toBeGreaterThanOrEqual(5);
  });

  it('describes four ventures across stages and domains with valid references', () => {
    expect(ventures).toHaveLength(4);
    expect(new Set(ventures.map((v) => v.stage)).size).toBe(4);
    expect(new Set(ventures.map((v) => v.domain)).size).toBe(4);
    expect(ventures.filter((v) => v.members.some((m) => m.role === 'advisor'))).toHaveLength(1);
    for (const v of ventures) {
      expect(people.has(v.eir)).toBe(true);
      expect(v.members.some((m) => m.role === 'founder')).toBe(true);
      expect(v.memory.length).toBeGreaterThanOrEqual(10);
      expect(v.memory.length).toBeLessThanOrEqual(20);
      expect(v.documents.length).toBeGreaterThanOrEqual(1);
      expect(v.documents.length).toBeLessThanOrEqual(2);
      expect(v.memory.filter((m) => m.canary)).toHaveLength(1);
      expect(v.documents.filter((d) => d.canary)).toHaveLength(1);
      expect(new Set(v.memory.map((m) => m.key)).size).toBe(v.memory.length);
      expect(new Set(v.memory.map((m) => m.visibility)).size).toBeGreaterThanOrEqual(2);
      for (const m of v.memory) {
        expect(people.has(m.author)).toBe(true);
        if (m.origin === 'eir') expect(m.status).toBe('proposed');
        if (m.type === 'experiment') expect(m.attributes).toHaveProperty('prediction');
        if (m.type === 'action') {
          expect(typeof m.attributes.owner).toBe('string');
          expect(m.attributes.due).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
        if (m.type === 'milestone') {
          expect(typeof m.attributes.owner).toBe('string');
          expect(m.attributes.target_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
        if (m.type === 'decision') expect(m.attributes).toHaveProperty('reversal_condition');
      }
    }
    const types = new Set(ventures.flatMap((v) => v.memory.map((m) => m.type)));
    expect(types.size).toBeGreaterThanOrEqual(10);
  });

  it('has 12–20 generic program resources without URLs', () => {
    expect(SEED_RESOURCES.length).toBeGreaterThanOrEqual(12);
    expect(SEED_RESOURCES.length).toBeLessThanOrEqual(20);
    expect(new Set(SEED_RESOURCES.map((r) => r.key)).size).toBe(SEED_RESOURCES.length);
    const names = SEED_RESOURCES.map((r) => r.name);
    for (const expected of [
      'University technology transfer office',
      'Campus venture legal clinic',
      'Pre-seed grant program',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('reads the seed configuration from the runtime environment', () => {
    expect(seedConfigFromEnv({})).toEqual({ homeTenant: { slug: 'ain', name: 'Ain Foundry' }, owner: null });
    expect(
      seedConfigFromEnv({
        HOME_TENANT_SLUG: 'ain',
        HOME_TENANT_NAME: 'Ain Foundry',
        OWNER_DISPLAY_NAME: 'Platform Owner',
        OWNER_ACCESS_CODE_PREFIX: 'T9302',
        OWNER_ACCESS_CODE_HASH: 'scrypt$x',
      }).owner,
    ).toEqual({ displayName: 'Platform Owner', accessCodePrefix: 'T9302', accessCodeHash: 'scrypt$x' });
    expect(() => seedConfigFromEnv({ APP_ENV: 'production' })).toThrow(/required in production/);
  });
});

describe('migration bundle', () => {
  it('is up to date with packages/db/migrations/*.sql', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const current = await readFile(join(here, '..', 'migrations', 'bundle.generated.ts'), 'utf8');
    expect(current).toBe(await renderBundle());
  });
});
