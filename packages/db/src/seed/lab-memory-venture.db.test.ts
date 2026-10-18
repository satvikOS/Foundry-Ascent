import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { p } from '../params.js';
import { createTestDatabase, type TestDatabase } from '../testing/test-database.js';
import { seedId } from './ids.js';
import { LAB_MEMORY_VENTURE, LAB_MEMORY_VENTURE_KEY, seedLabMemoryVenture } from './lab-memory-venture.js';
import { SEED_FOUNDERS } from './ventures.js';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase({ seed: true });
});
afterAll(async () => {
  await t.cleanup();
});

const TABLES = ['principals', 'ventures', 'venture_memberships', 'assignments', 'veir_notebooks'] as const;

function counts(): Promise<Record<string, number>> {
  return t.db.system(async (sx) => {
    const out: Record<string, number> = {};
    for (const table of TABLES) {
      const r = await sx.query(`SELECT count(*) AS n FROM ${table}`);
      out[table] = Number(r.rows[0]?.n);
    }
    return out;
  });
}

describe('the lab memory venture', () => {
  it('is a synthetic venture of its own, with synthetic founders and a teammate and the seeded vEIR', async () => {
    const before = await counts();
    const result = await t.db.system((sx) => seedLabMemoryVenture(sx, { tenantSlug: 'ain' }));
    expect(await counts()).toEqual({
      principals: (before.principals ?? 0) + 3,
      ventures: (before.ventures ?? 0) + 1,
      venture_memberships: (before.venture_memberships ?? 0) + 3,
      assignments: (before.assignments ?? 0) + 1,
      veir_notebooks: (before.veir_notebooks ?? 0) + 1,
    });
    // evals keys a venture by its name in lower-case letters and digits; never a seeded demo venture's key.
    expect(LAB_MEMORY_VENTURE.name.toLowerCase().replace(/[^a-z0-9]+/g, '')).toBe(LAB_MEMORY_VENTURE_KEY);
    expect(['quietquad', 'benchtally', 'solesignal', 'emberloop']).not.toContain(result.key);

    const { venture, members, coach, quietquad, notebook } = await t.db.system(async (sx) => ({
      venture: (
        await sx.query('SELECT name, classification FROM ventures WHERE id = :id', {
          id: p.uuid(result.ventureId),
        })
      ).rows[0],
      members: (
        await sx.query(
          `SELECT m.role, pr.synthetic, pr.display_name FROM venture_memberships m
           JOIN principals pr ON pr.id = m.principal_id WHERE m.venture_id = :id ORDER BY m.role`,
          { id: p.uuid(result.ventureId) },
        )
      ).rows,
      coach: (
        await sx.query(`SELECT persona_id FROM assignments WHERE venture_id = :id AND status = 'active'`, {
          id: p.uuid(result.ventureId),
        })
      ).rows,
      quietquad: (
        await sx.query(`SELECT persona_id FROM assignments WHERE venture_id = :id AND status = 'active'`, {
          id: p.uuid(seedId('ain', 'venture', 'quietquad')),
        })
      ).rows[0],
      notebook: (
        await sx.query('SELECT persona_id FROM veir_notebooks WHERE venture_id = :id', {
          id: p.uuid(result.ventureId),
        })
      ).rows,
    }));
    expect(venture).toEqual({ name: 'Lanternwise', classification: 'synthetic' });
    expect(members.map((m) => [m.role, m.synthetic])).toEqual([
      ['founder', true],
      ['founder', true],
      ['team', true],
    ]);
    const seededNames = new Set(SEED_FOUNDERS.map((f) => f.displayName));
    for (const m of members) expect(seededNames.has(String(m.display_name))).toBe(false);
    expect(coach).toHaveLength(1);
    expect(coach[0]?.persona_id).toBe(quietquad?.persona_id);
    expect(result.personaId).toBe(quietquad?.persona_id);
    expect(notebook.map((n) => n.persona_id)).toEqual([result.personaId]);
  });

  it('changes nothing when run again', async () => {
    const before = await counts();
    await t.db.system((sx) => seedLabMemoryVenture(sx, { tenantSlug: 'ain' }));
    expect(await counts()).toEqual(before);
  });

  it('refuses a database without the seeded tenant', async () => {
    await expect(t.db.system((sx) => seedLabMemoryVenture(sx, { tenantSlug: 'nowhere' }))).rejects.toThrow(
      /home tenant/,
    );
  });
});
