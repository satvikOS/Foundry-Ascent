import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { p } from '../params.js';
import { createTestDatabase, type TestDatabase } from '../testing/test-database.js';
import {
  ageVenturePathForLab,
  parseLabClientPlan,
  seedLabClientVentures,
  type LabClientVenture,
} from './lab-client-ventures.js';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase({ seed: true });
});
afterAll(async () => {
  await t.cleanup();
});

const NOW = new Date('2026-11-24T10:00:00.000Z');
const ENTRY = {
  key: 'or-01',
  name: 'ToolTally',
  oneLiner: 'Tracks lent tools.',
  stage: 'validation',
  domain: 'software',
  goal: 'Turn two pilots into paying shops.',
  founderKey: 'or-01',
  founderName: 'Dana Whitlock',
  record: [
    {
      type: 'milestone',
      title: 'Two paid pilots',
      content: 'Two shops pay 35 dollars a month.',
      daysAgo: 30,
    },
    { type: 'fact', title: 'Before', content: 'A clipboard.', daysAgo: 0 },
  ],
};

describe('the lab client ventures', () => {
  let seeded: readonly LabClientVenture[];

  it('gives each scenario a venture, a founder and a confirmed record dated in the past', async () => {
    seeded = await t.db.system((sx) =>
      seedLabClientVentures(sx, { tenantSlug: 'ain', plan: parseLabClientPlan([ENTRY]), now: NOW }),
    );
    expect(seeded.map((v) => v.key)).toEqual(['or-01']);
    const rows = await t.db.system(async (sx) => {
      const r = await sx.query(
        `SELECT m.title, m.status, m.origin, m.approved_by = pr.id AS approved, pr.synthetic, vm.role,
                to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS on_day, a.status AS assigned
         FROM ventures v
         JOIN memory_objects m ON m.venture_id = v.id
         JOIN venture_memberships vm ON vm.venture_id = v.id
         JOIN principals pr ON pr.id = vm.principal_id
         JOIN assignments a ON a.venture_id = v.id
         WHERE v.id = :id ORDER BY m.created_at`,
        { id: p.uuid(seeded[0]?.ventureId ?? '') },
      );
      return r.rows;
    });
    const common = {
      status: 'confirmed',
      origin: 'founder',
      approved: true,
      synthetic: true,
      role: 'founder',
      assigned: 'active',
    };
    expect(rows).toEqual([
      { title: 'Two paid pilots', on_day: '2026-10-25', ...common },
      { title: 'Before', on_day: '2026-11-24', ...common },
    ]);
  });

  it('changes nothing when run again', async () => {
    const count = () =>
      t.db.system(async (sx) =>
        Number((await sx.query('SELECT count(*) AS n FROM memory_objects')).rows[0]?.n),
      );
    const before = await count();
    await t.db.system((sx) =>
      seedLabClientVentures(sx, { tenantSlug: 'ain', plan: parseLabClientPlan([ENTRY]), now: NOW }),
    );
    expect(await count()).toBe(before);
  });

  it.each([
    ['no record list', { ...ENTRY, record: 'x' }],
    ['an unknown type', { ...ENTRY, record: [{ ...ENTRY.record[0], type: 'secret' }] }],
    ['a future item', { ...ENTRY, record: [{ ...ENTRY.record[0], daysAgo: -1 }] }],
    ['an empty item', { ...ENTRY, record: [{ ...ENTRY.record[0], content: ' ' }] }],
    ['an unknown stage', { ...ENTRY, stage: 'later' }],
  ])('refuses a plan with %s', (_what, entry) => {
    expect(() => parseLabClientPlan([entry])).toThrow();
  });

  it('moves every date of a venture path back, for that venture only', async () => {
    const mine = seeded[0]?.ventureId ?? '';
    const rows = await t.db.system(async (sx) => {
      await sx.query(
        `CREATE TABLE lab_age_probe (id integer, venture_id uuid, title text, due_on date, done_at timestamptz, intake jsonb)`,
      );
      await sx.query(
        `INSERT INTO lab_age_probe VALUES
           (1, :mine, 'a', '2026-12-01', '2026-11-20T08:00:00Z', :intake), (2, :mine, 'b', NULL, NULL, NULL),
           (3, gen_random_uuid(), 'c', '2026-12-01', '2026-11-20T08:00:00Z', :intake)`,
        { mine: p.uuid(mine), intake: p.json({ idea: 'x', deadline: { what: 'exam', on: '2026-12-03' } }) },
      );
      const moved = await ageVenturePathForLab(sx, {
        ventureId: mine,
        days: 7,
        tables: ['lab_age_probe', 'lab_no_such_table'],
      });
      expect(moved).toEqual({ tables: 1, rows: 2 });
      const r = await sx.query(
        `SELECT id, due_on::text AS due, to_char(done_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24') AS done,
                intake #>> '{deadline,on}' AS deadline, intake ->> 'idea' AS idea
         FROM lab_age_probe ORDER BY id`,
      );
      await sx.query('DROP TABLE lab_age_probe');
      return r.rows;
    });
    expect(rows).toEqual([
      { id: 1, due: '2026-11-24', done: '2026-11-13 08', deadline: '2026-11-26', idea: 'x' },
      { id: 2, due: null, done: null, deadline: null, idea: null },
      { id: 3, due: '2026-12-01', done: '2026-11-20 08', deadline: '2026-12-03', idea: 'x' },
    ]);
  });

  it('refuses days and tables it should not touch', async () => {
    const ventureId = seeded[0]?.ventureId ?? '';
    await expect(t.db.system((sx) => ageVenturePathForLab(sx, { ventureId, days: 0 }))).rejects.toThrow();
    await expect(
      t.db.system((sx) => ageVenturePathForLab(sx, { ventureId, days: 1, tables: ['x; drop'] })),
    ).rejects.toThrow();
  });
});
