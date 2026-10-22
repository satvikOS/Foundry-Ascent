import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { col } from '../columns.js';
import { p } from '../params.js';
import { createTestDatabase, type TestDatabase } from '../testing/test-database.js';
import { AGENDA_COMMITMENT, LAB_AGENDA_VENTURES, seedLabAgendaVentures } from './lab-agenda-ventures.js';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase({ seed: true });
});
afterAll(async () => {
  await t.cleanup();
});

const NOW = new Date('2026-10-20T10:00:00.000Z');

describe('the lab agenda ventures', () => {
  it('each opens on one open commitment dated in the past, from an earlier distilled conversation', async () => {
    const seeded = await t.db.system((sx) => seedLabAgendaVentures(sx, { tenantSlug: 'ain', now: NOW }));
    expect(seeded.map((v) => [v.name, v.channel])).toEqual([
      ['Pelora', 'chat'],
      ['Quillon', 'call'],
    ]);
    for (const v of LAB_AGENDA_VENTURES) {
      const row = await t.db.system(async (sx) => {
        const r = await sx.query(
          `SELECT n.content, n.updated_at, s.status, s.privacy, s.digest IS NOT NULL AS digested,
                  pr.synthetic, m.role
           FROM ventures v
           JOIN veir_notebooks n ON n.venture_id = v.id
           JOIN coaching_sessions s ON s.venture_id = v.id
           JOIN venture_memberships m ON m.venture_id = v.id
           JOIN principals pr ON pr.id = m.principal_id
           WHERE v.name = :name`,
          { name: p.text(v.name) },
        );
        return r.rows;
      });
      expect(row).toHaveLength(1);
      const [only] = row;
      const content = col
        .json<{ commitments: { text: string; due: string; status: string }[] }>()
        .decode(only?.content, 'content');
      expect(content.commitments).toEqual([
        expect.objectContaining({ text: AGENDA_COMMITMENT, due: '2026-10-11', status: 'open' }),
      ]);
      expect(only).toMatchObject({
        status: 'ended',
        privacy: 'standard',
        digested: true,
        synthetic: true,
        role: 'founder',
      });
    }
  });

  it('changes nothing when run again', async () => {
    const count = () =>
      t.db.system(async (sx) =>
        Number((await sx.query('SELECT count(*) AS n FROM coaching_sessions')).rows[0]?.n),
      );
    const before = await count();
    await t.db.system((sx) => seedLabAgendaVentures(sx, { tenantSlug: 'ain', now: NOW }));
    expect(await count()).toBe(before);
  });
});
