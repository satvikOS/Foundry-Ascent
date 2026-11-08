/**
 * The demo-story release (./story-releases.ts) on a database seeded the way production's was before it: Amara keeps
 * SoleSignal until the deploy names the release; then she gets Seam Again (its memory, its document, an empty notebook,
 * coached by the vEIR Thomas is presented as) and leaves SoleSignal, whose rows all stay; it is audited, applied once,
 * and a membership restored in the product is not revoked again.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { p } from '../params.js';
import { createTestDatabase, type TestDatabase } from '../testing/test-database.js';
import { accessCodePrefix, generateAccessCode, hashAccessCode } from './access-code.js';
import { seedId } from './ids.js';
import { parseOwnerReleases } from './owner-releases.js';
import { seedDatabase, type SeedConfig } from './seed.js';
import { SEAM_AGAIN_RELEASE } from './story-releases.js';

let t: TestDatabase;
let config: SeedConfig;

const KEY = SEAM_AGAIN_RELEASE.key;
const amara = seedId('ain', 'principal', 'amara');
const seamAgain = seedId('ain', 'venture', 'seamagain');
const soleSignal = seedId('ain', 'venture', 'solesignal');
const corin = seedId('ain', 'persona', 'veir', 'eir-corin');

async function rows(sql: string, params: Record<string, ReturnType<typeof p.uuid>> = {}) {
  return t.db.system(async (sx) => (await sx.query(sql, params)).rows);
}

async function memberships(): Promise<readonly Readonly<Record<string, unknown>>[]> {
  return rows(
    `SELECT v.name, m.role FROM venture_memberships m JOIN ventures v ON v.id = m.venture_id
      WHERE m.principal_id = :amara AND m.revoked_at IS NULL ORDER BY v.name`,
    { amara: p.uuid(amara) },
  );
}

beforeAll(async () => {
  t = await createTestDatabase();
  const code = generateAccessCode();
  config = {
    homeTenant: { slug: 'ain', name: 'Ain Foundry (test)' },
    owner: {
      displayName: 'Platform Owner',
      accessCodePrefix: accessCodePrefix(code),
      accessCodeHash: await hashAccessCode(code),
    },
    ownerReleases: parseOwnerReleases('thomas-2026-11-05'),
  };
  await seedDatabase(t.db, config);
}, 180_000);
afterAll(async () => {
  await t.cleanup();
});

describe('the Seam Again story release', () => {
  it('changes nothing until the deploy names it', async () => {
    const seed = await seedDatabase(t.db, config);
    expect(seed.storyReleases).toEqual([]);
    expect(await memberships()).toEqual([{ name: 'SoleSignal', role: 'founder' }]);
    expect(await rows('SELECT 1 FROM ventures WHERE id = :id', { id: p.uuid(seamAgain) })).toEqual([]);
  });

  it('gives Amara Seam Again, coached by Thomas, and takes her out of SoleSignal without deleting it', async () => {
    const before = await rows('SELECT count(*)::int AS n FROM memory_objects WHERE venture_id = :v', {
      v: p.uuid(soleSignal),
    });
    const seed = await seedDatabase(t.db, {
      ...config,
      ownerReleases: parseOwnerReleases(`thomas-2026-11-05,${KEY}`),
    });
    expect(seed.ownerReleases.map((r) => r.outcome)).toEqual(['present']);
    expect(seed.storyReleases).toEqual([{ key: KEY, outcome: 'applied', ventureId: seamAgain, left: 1 }]);

    expect(await memberships()).toEqual([{ name: 'Seam Again', role: 'founder' }]);
    const [venture] = await rows(
      'SELECT name, stage, domain, classification, current_goal FROM ventures WHERE id = :id',
      { id: p.uuid(seamAgain) },
    );
    expect(venture).toMatchObject({ name: 'Seam Again', stage: 'validation', domain: 'consumer' });
    expect(venture?.classification).toBe('synthetic');
    const [assignment] = await rows(
      `SELECT a.persona_id, pe.name FROM assignments a JOIN personas pe ON pe.id = a.persona_id
        WHERE a.venture_id = :v AND a.status = 'active'`,
      { v: p.uuid(seamAgain) },
    );
    expect(assignment).toEqual({ persona_id: corin, name: 'Thomas' });

    const memory = await rows('SELECT title, status FROM memory_objects WHERE venture_id = :v', {
      v: p.uuid(seamAgain),
    });
    expect(memory).toHaveLength(SEAM_AGAIN_RELEASE.venture(() => '2026-01-01').memory.length);
    expect(memory.some((m) => String(m.title).includes('First pop-up day'))).toBe(true);
    const chunks = await rows(
      `SELECT c.content FROM knowledge_chunks c JOIN documents d ON d.source_id = c.source_id
        WHERE d.venture_id = :v AND d.status = 'ready'`,
      { v: p.uuid(seamAgain) },
    );
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.some((c) => String(c.content).includes('$118'))).toBe(true);
    expect(
      await rows('SELECT 1 FROM veir_notebooks WHERE venture_id = :v AND persona_id = :pe', {
        v: p.uuid(seamAgain),
        pe: p.uuid(corin),
      }),
    ).toHaveLength(1);

    // Nothing in the new venture mentions the old story; the old venture keeps every row.
    const text = JSON.stringify([venture, memory, chunks]).toLowerCase();
    for (const old of ['insole', 'podiatr', 'clinic', 'solesignal']) expect(text).not.toContain(old);
    expect(
      await rows('SELECT count(*)::int AS n FROM memory_objects WHERE venture_id = :v', {
        v: p.uuid(soleSignal),
      }),
    ).toEqual(before);
    const [principal] = await rows('SELECT title FROM principals WHERE id = :id', { id: p.uuid(amara) });
    expect(principal?.title).toBe('Founder, Seam Again (synthetic)');

    const audit = await rows(
      `SELECT action, metadata::text AS metadata FROM audit_events WHERE object_id = :v AND action = 'venture.story_release_applied'`,
      { v: p.text(seamAgain) },
    );
    expect(audit).toHaveLength(1);
    expect(JSON.parse(String(audit[0]?.metadata))).toMatchObject({ storyRelease: KEY, membershipsLeft: 1 });
  });

  it('is applied once: a membership restored in the product stays restored', async () => {
    await rows(
      `INSERT INTO venture_memberships (venture_id, principal_id, role) VALUES (:v, :amara, 'founder')`,
      { v: p.uuid(soleSignal), amara: p.uuid(amara) },
    );
    const again = await seedDatabase(t.db, { ...config, ownerReleases: parseOwnerReleases(KEY) });
    expect(again.storyReleases).toEqual([{ key: KEY, outcome: 'present', ventureId: seamAgain, left: 0 }]);
    expect(await memberships()).toEqual([
      { name: 'Seam Again', role: 'founder' },
      { name: 'SoleSignal', role: 'founder' },
    ]);
    expect(
      await rows('SELECT count(*)::int AS n FROM memory_objects WHERE venture_id = :v', {
        v: p.uuid(seamAgain),
      }),
    ).toEqual([{ n: SEAM_AGAIN_RELEASE.venture(() => '2026-01-01').memory.length }]);
  });

  it('needs the demo data: a tenant seeded without it gets nothing', async () => {
    const code = generateAccessCode();
    const plain = await seedDatabase(t.db, {
      homeTenant: { slug: 'plain', name: 'Plain (test)' },
      owner: {
        displayName: 'Plain Owner',
        accessCodePrefix: accessCodePrefix(code),
        accessCodeHash: await hashAccessCode(code),
      },
      includeDemoData: false,
      ownerReleases: parseOwnerReleases(KEY),
    });
    expect(plain.storyReleases.map((r) => r.outcome)).toEqual(['no_demo_data']);
  });

  it('is a known release key', () => {
    expect(parseOwnerReleases(` ${KEY} , ${KEY}`)).toEqual([KEY]);
    expect(() => parseOwnerReleases('amara-seam-again-1999')).toThrow();
  });
});
