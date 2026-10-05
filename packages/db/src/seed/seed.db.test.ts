import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { p } from '../params.js';
import { authRepo, memoryRepo, personasRepo, venturesRepo } from '../repositories/index.js';
import { createTestDatabase, makeContext, type TestDatabase } from '../testing/test-database.js';
import { verifyAccessCode } from './access-code.js';
import { seedDatabase, type SeedConfig } from './seed.js';
import { SEED_EIRS, SEED_FOUNDERS, SEED_PROGRAM_LEAD } from './ventures.js';
import { ventureCanary } from './ids.js';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase({ seed: true });
});
afterAll(async () => {
  await t.cleanup();
});

const TABLES = [
  'tenants',
  'principals',
  'role_grants',
  'access_codes',
  'eir_profiles',
  'personas',
  'persona_releases',
  'ventures',
  'venture_memberships',
  'assignments',
  'knowledge_sources',
  'knowledge_chunks',
  'documents',
  'memory_objects',
  'memory_events',
  'escalations',
  'resources',
  'patterns',
] as const;

async function counts(): Promise<Record<string, number>> {
  return t.db.system(async (sx) => {
    const out: Record<string, number> = {};
    for (const table of TABLES) {
      const r = await sx.query(`SELECT count(*) AS n FROM ${table}`);
      out[table] = Number(r.rows[0]?.n);
    }
    return out;
  });
}

/** Re-run configuration without an owner (demo data only). */
const NO_OWNER: SeedConfig = { homeTenant: { slug: 'ain', name: 'Ain Foundry (test)' }, owner: null };

describe('seed', () => {
  it('creates the synthetic workspace', async () => {
    const seed = t.seed;
    expect(seed).not.toBeNull();
    if (!seed) return;
    expect(seed.ventures).toHaveLength(4);
    expect(seed.eirs).toHaveLength(2);
    const c = await counts();
    expect(c.ventures).toBe(4);
    expect(c.resources).toBeGreaterThanOrEqual(12);
    expect(c.resources).toBeLessThanOrEqual(20);
    for (const v of seed.ventures) {
      const n = Object.keys(v.memoryIds).length;
      expect(n).toBeGreaterThanOrEqual(10);
      expect(n).toBeLessThanOrEqual(20);
      expect(v.documentIds.length).toBeGreaterThanOrEqual(1);
      expect(v.documentIds.length).toBeLessThanOrEqual(2);
    }
  });

  it('is idempotent (second and third runs change nothing)', async () => {
    const before = await counts();
    // Re-run with the same owner binding (read back from the database) and without an owner.
    const owner = await t.db.system((sx) =>
      sx.query(`SELECT code_prefix, code_hash FROM access_codes WHERE label = 'owner (deploy)'`),
    );
    const row = owner.rows[0] as { code_prefix: string; code_hash: string };
    await seedDatabase(t.db, {
      homeTenant: { slug: 'ain', name: 'Ain Foundry (test)' },
      owner: { displayName: 'Test Owner', accessCodePrefix: row.code_prefix, accessCodeHash: row.code_hash },
    });
    await seedDatabase(t.db, NO_OWNER);
    expect(await counts()).toEqual(before);
  });

  it('binds the owner code and gives demo principals no codes', async () => {
    const seed = t.seed;
    const code = t.ownerAccessCode;
    if (!seed || !code) throw new Error('seed missing');
    const lookup = await t.db.system((sx) => authRepo.findAccessCodeByPrefix(sx, code.slice(3, 8)));
    expect(lookup?.principalId).toBe(seed.ownerId);
    expect(lookup && (await verifyAccessCode(code, lookup.codeHash))).toBe(true);
    const codes = await t.db.system((sx) => sx.query('SELECT DISTINCT principal_id FROM access_codes'));
    expect(codes.rows.map((r) => r.principal_id)).toEqual([seed.ownerId]);
    const roles = await t.db.system((sx) =>
      sx.query(
        'SELECT role, tenant_id FROM role_grants WHERE principal_id = :id AND revoked_at IS NULL ORDER BY role',
        {
          id: p.uuid(seed.ownerId ?? ''),
        },
      ),
    );
    expect(roles.rows.map((r) => r.role)).toEqual(['platform_admin', 'program_lead']);
  });

  it('marks every demo person synthetic and uses only invented names', async () => {
    const rows = await t.db.system((sx) =>
      sx.query('SELECT display_name, synthetic FROM principals WHERE synthetic'),
    );
    const names = rows.rows.map((r) => r.display_name as string).sort();
    const expected = [SEED_PROGRAM_LEAD, ...SEED_EIRS, ...SEED_FOUNDERS].map((x) => x.displayName).sort();
    expect(names).toEqual(expected);
    const eirs = await t.db.system((sx) =>
      sx.query('SELECT bool_and(synthetic) AS all_synthetic FROM eir_profiles'),
    );
    expect(eirs.rows[0]?.all_synthetic).toBe(true);
  });

  it('activates Foundry Guide with an approved v1 release and assigns every venture', async () => {
    const seed = t.seed;
    if (!seed) throw new Error('seed missing');
    const founder = seed.ventures[0]?.members[0];
    if (!founder) throw new Error('no founder');
    await t.db.withContext(makeContext(founder.principalId, seed.tenantId), async (tx) => {
      const release = await personasRepo.getActiveRelease(tx, seed.personaId);
      expect(release?.version).toBe(1);
      expect(release?.status).toBe('approved');
      expect(release?.doctrine.frameworks.length).toBeGreaterThanOrEqual(6);
      expect(release?.disclosureText).toContain('not a person');
    });
    const assigned = await t.db.system((sx) =>
      sx.query(`SELECT count(DISTINCT venture_id) AS n FROM assignments WHERE status = 'active'`),
    );
    expect(Number(assigned.rows[0]?.n)).toBe(4);
  });

  it('embeds a unique deterministic canary per venture in one memory item and one chunk', async () => {
    const seed = t.seed;
    if (!seed) throw new Error('seed missing');
    for (const v of seed.ventures) {
      expect(v.canary).toBe(ventureCanary(v.key));
      expect(v.canary).toMatch(/^CANARY::[a-z0-9-]+::[0-9A-HJKMNP-TV-Z]{8}$/);
      const r = await t.db.system((sx) =>
        sx.query(
          `SELECT (SELECT count(*) FROM memory_objects WHERE content LIKE '%' || :c || '%') AS memory,
                  (SELECT count(*) FROM knowledge_chunks WHERE content LIKE '%' || :c || '%') AS chunks,
                  (SELECT count(*) FROM memory_objects WHERE content LIKE '%' || :c || '%' AND venture_id <> :v) AS foreign_memory`,
          { c: p.text(v.canary), v: p.uuid(v.id) },
        ),
      );
      expect(Number(r.rows[0]?.memory)).toBe(1);
      expect(Number(r.rows[0]?.chunks)).toBe(1);
      expect(Number(r.rows[0]?.foreign_memory)).toBe(0);
    }
    expect(new Set(seed.ventures.map((v) => v.canary)).size).toBe(4);
  });

  it('produces mixed memory types, statuses and visibilities with structured attributes', async () => {
    const seed = t.seed;
    const v = seed?.ventures[0];
    if (!seed || !v) throw new Error('seed missing');
    const founder = v.members[0];
    if (!founder) throw new Error('no founder');
    const items = await t.db.withContext(makeContext(founder.principalId, seed.tenantId), (tx) =>
      memoryRepo.listMemory(tx, { ventureId: v.id, statuses: ['proposed', 'confirmed', 'disputed'] }),
    );
    expect(new Set(items.map((m) => m.type)).size).toBeGreaterThanOrEqual(8);
    expect(new Set(items.map((m) => m.status))).toEqual(new Set(['confirmed', 'proposed']));
    const experiment = items.find((m) => m.type === 'experiment');
    expect(typeof experiment?.attributes.prediction).toBe('string');
    expect(typeof experiment?.attributes.method).toBe('string');
    const summaries = await t.db.withContext(makeContext(founder.principalId, seed.tenantId), (tx) =>
      venturesRepo.listVentureSummaries(tx, { principalId: founder.principalId, tenantId: seed.tenantId }),
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.myRole).toBe('founder');
    expect(summaries[0]?.pendingMemory).toBeGreaterThanOrEqual(1);
    expect(summaries[0]?.openActions).toBeGreaterThanOrEqual(1);
  });
});
