import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { col } from '../columns.js';
import { p } from '../params.js';
import { createTestDatabase, type TestDatabase } from '../testing/test-database.js';
import { parseLabLivePlan, seedLabLiveVentures, type LabLiveVenturePlan } from './lab-live-ventures.js';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase({ seed: true });
});
afterAll(async () => {
  await t.cleanup();
});

const PLAN: LabLiveVenturePlan[] = [
  {
    key: 'lv-01-01',
    name: 'Leftover Loop',
    oneLiner: 'An unformed idea about dining-hall food waste',
    stage: 'idea',
    domain: 'social',
    goal: 'Find out whether the idea is enough to join the track.',
    founderKey: 'lv-01-01',
    founderName: 'Tessa Arkwright',
  },
  {
    key: 'lv-29-18',
    name: 'BeanBox Coffee',
    oneLiner: 'Coffee subscription for offices',
    stage: 'commercialization',
    domain: 'consumer',
    goal: 'Grow office clients.',
    founderKey: 'lv-29-18',
    founderName: 'Victoria Asante-Lindgren',
  },
  {
    key: 'lv-29-18-nb',
    name: 'TeaTime Trays',
    oneLiner: 'A separate venture of the same founder',
    stage: 'validation',
    domain: 'general',
    goal: 'Separate venture used to test isolation',
    founderKey: 'lv-29-18',
    founderName: 'Victoria Asante-Lindgren',
  },
];

describe('the lab live-evaluation ventures', () => {
  it('gives every run its own synthetic venture and founder, coached by the demo vEIR', async () => {
    const seeded = await t.db.system((sx) => seedLabLiveVentures(sx, { tenantSlug: 'ain', plan: PLAN }));
    expect(seeded.map((v) => v.key)).toEqual(['lv-01-01', 'lv-29-18', 'lv-29-18-nb']);
    // The same student owns both isolation ventures: one principal, two memberships.
    expect(seeded[1]?.founderId).toBe(seeded[2]?.founderId);
    expect(seeded[0]?.founderId).not.toBe(seeded[1]?.founderId);
    const rows = await t.db.system(async (sx) => {
      const r = await sx.query(
        `SELECT v.name, v.classification, pr.synthetic, m.role, a.status
         FROM ventures v
         JOIN venture_memberships m ON m.venture_id = v.id
         JOIN principals pr ON pr.id = m.principal_id
         JOIN assignments a ON a.venture_id = v.id
         WHERE v.id IN (:a, :b, :c)
         ORDER BY v.name`,
        {
          a: p.uuid(seeded[0]?.ventureId ?? ''),
          b: p.uuid(seeded[1]?.ventureId ?? ''),
          c: p.uuid(seeded[2]?.ventureId ?? ''),
        },
      );
      return r.rows.map((row) => ({
        name: col.text.decode(row.name, 'name'),
        classification: col.text.decode(row.classification, 'classification'),
        synthetic: row.synthetic,
        role: row.role,
        status: row.status,
      }));
    });
    expect(rows).toEqual([
      {
        name: 'BeanBox Coffee',
        classification: 'synthetic',
        synthetic: true,
        role: 'founder',
        status: 'active',
      },
      {
        name: 'Leftover Loop',
        classification: 'synthetic',
        synthetic: true,
        role: 'founder',
        status: 'active',
      },
      {
        name: 'TeaTime Trays',
        classification: 'synthetic',
        synthetic: true,
        role: 'founder',
        status: 'active',
      },
    ]);
  });

  it('changes nothing when run again', async () => {
    const count = () =>
      t.db.system(async (sx) => Number((await sx.query('SELECT count(*) AS n FROM ventures')).rows[0]?.n));
    const before = await count();
    await t.db.system((sx) => seedLabLiveVentures(sx, { tenantSlug: 'ain', plan: PLAN }));
    expect(await count()).toBe(before);
  });

  it('refuses a malformed plan', () => {
    expect(() => parseLabLivePlan([])).toThrow(/1 to 4000/);
    expect(() => parseLabLivePlan([{ ...PLAN[0], key: 'Bad Key' }])).toThrow(/invalid key/);
    expect(() => parseLabLivePlan([PLAN[0], PLAN[0]])).toThrow(/duplicate key/);
    expect(() => parseLabLivePlan([{ ...PLAN[0], stage: 'unicorn' }])).toThrow(/stage or domain/);
  });
});
