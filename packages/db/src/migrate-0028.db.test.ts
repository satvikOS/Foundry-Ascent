/**
 * Migration 0028 (`personas.presentation`) and the owner-approved release that ships with it (ADR-0021: Thomas), on a
 * database seeded the way production's was before it: the column arrives as `twin` for every persona; the seed then
 * applies the release only when the deploy names it, through the studio's own steps (a draft by the owner, approved by
 * the owner, superseding Corin's v1), renames the persona to Thomas and presents it as a mentor; every conversation
 * still on v1 moves to Thomas at its next message (v1 withdrawn); it is audited, applied once, and touches neither
 * Ruth's persona nor any other tenant.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS, migrate } from './migrate.js';
import { p } from './params.js';
import { personasRepo } from './repositories/index.js';
import { accessCodePrefix, generateAccessCode, hashAccessCode } from './seed/access-code.js';
import { seedId } from './seed/ids.js';
import {
  THOMAS_RELEASE,
  parseOwnerReleases,
  seedOwnerReleases,
  type OwnerRelease,
} from './seed/owner-releases.js';
import { seedDatabase, type SeedConfig } from './seed/seed.js';
import { CORIN_VEIR } from './seed/veir-content.js';
import { splitStatements } from './sql-lexer.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

const PRESENTATION = MIGRATIONS.find((m) => m.version === '0028_persona_presentation');
const BEFORE = MIGRATIONS.filter((m) => m.version < '0028');

let t: TestDatabase;
let config: SeedConfig;

const corin = seedId('ain', 'persona', 'veir', 'eir-corin');
const ruth = seedId('ain', 'persona', 'veir', 'eir-ruth');
const corinV1 = seedId('ain', 'persona-release', 'veir', 'eir-corin', 'v1');
const thomasRelease = seedId('ain', 'persona-release', 'owner', THOMAS_RELEASE.key);

async function persona(id: string): Promise<Record<string, unknown> | undefined> {
  return t.db.system(
    async (sx) =>
      (
        await sx.query('SELECT name, presentation, kind, status FROM personas WHERE id = :id', {
          id: p.uuid(id),
        })
      ).rows[0],
  );
}

beforeAll(async () => {
  t = await createTestDatabase({ migrate: false });
  await migrate(t.db, { migrations: BEFORE });
  const code = generateAccessCode();
  config = {
    homeTenant: { slug: 'ain', name: 'Ain Foundry (test)' },
    owner: {
      displayName: 'Platform Owner',
      accessCodePrefix: accessCodePrefix(code),
      accessCodeHash: await hashAccessCode(code),
    },
  };
  await seedDatabase(t.db, config);
}, 180_000);
afterAll(async () => {
  await t.cleanup();
});

describe('migration 0028_persona_presentation and the Thomas owner release', () => {
  it("applies cleanly as the non-superuser owner; every persona stays its EIR's twin", async () => {
    const report = await migrate(t.db);
    expect(report.applied[0]).toBe('0028_persona_presentation');
    expect(await persona(corin)).toMatchObject({ name: "Corin's vEIR", presentation: 'twin' });
    const all = await t.db.system((sx) => sx.query(`SELECT DISTINCT presentation FROM personas`));
    expect(all.rows.map((r) => r.presentation)).toEqual(['twin']);
  });

  it('refuses a mentor presentation on a neutral guide, and re-runs without changes', async () => {
    if (!PRESENTATION) throw new Error('0028 missing');
    await expect(
      t.db.system((sx) =>
        sx.query(`UPDATE personas SET presentation = 'mentor' WHERE kind = 'neutral_guide'`),
      ),
    ).rejects.toThrow();
    await t.db.system(async (sx) => {
      for (const statement of splitStatements(PRESENTATION.sql)) await sx.query(statement);
    });
    expect((await migrate(t.db)).applied).toEqual([]);
  });

  it('leaves the persona alone when the deploy names no owner release', async () => {
    const seed = await seedDatabase(t.db, config);
    expect(seed.ownerReleases).toEqual([]);
    expect(await persona(corin)).toMatchObject({ name: "Corin's vEIR", presentation: 'twin' });
  });

  it("applies Thomas through the studio's steps: owner-created, owner-approved, superseding and withdrawing v1", async () => {
    // A conversation pinned to Corin's v1 before the release.
    const seed = await seedDatabase(t.db, {
      ...config,
      ownerReleases: parseOwnerReleases('thomas-2026-11-05'),
    });
    expect(seed.ownerReleases).toEqual([
      { key: 'thomas-2026-11-05', outcome: 'applied', releaseId: thomasRelease, personaId: corin },
    ]);
    expect(await persona(corin)).toMatchObject({
      name: 'Thomas',
      presentation: 'mentor',
      kind: 'eir_persona',
      status: 'active',
    });
    const active = await t.db.system((sx) => personasRepo.getActiveRelease(sx, corin));
    expect(active?.id).toBe(thomasRelease);
    expect(active?.version).toBe(2);
    expect(active?.createdBy?.id).toBe(seed.ownerId);
    expect(active?.approvedBy?.id).toBe(seed.ownerId);
    expect(active?.doctrine.summary).toContain('answers the question the founder actually asked');
    expect(active?.disclosureText).toMatch(/AI mentor, not a person/);
    // Truthful about authorship: the owner wrote and approved it; no EIR reviewed it.
    expect(active?.disclosureText).toMatch(/written and approved by the platform’s owner/);
    expect(active?.disclosureText).not.toMatch(/EIR|review/);
    const v1 = await t.db.system((sx) => personasRepo.getRelease(sx, corinV1));
    expect(v1?.status).toBe('withdrawn');
    // Every venture coached by Corin's vEIR now runs on Thomas (its assignments are unchanged: same persona).
    const presence = await t.db.system((sx) =>
      personasRepo.getPersonaPresence(sx, { personaId: corin, assignedEirProfileId: null }),
    );
    expect(presence.mentor).toBe(true);
    expect(presence.eirName).toBe('Corin Halvorsen');
    const audit = await t.db.system((sx) =>
      sx.query(`SELECT action, actor_id, metadata FROM audit_events WHERE object_id = :id ORDER BY id`, {
        id: p.text(thomasRelease),
      }),
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['persona.release_created', 'persona.release_approved']);
    expect(audit.rows[1]?.actor_id).toBe(seed.ownerId);
    const metadata: unknown = audit.rows[1]?.metadata;
    expect(typeof metadata === 'string' ? (JSON.parse(metadata) as unknown) : metadata).toMatchObject({
      via: 'owner_release',
      ownerRelease: 'thomas-2026-11-05',
      approvedOn: '2026-11-05',
      presentation: 'mentor',
      withdrawn: 1,
    });
    // Each withdrawn release has its own event, as the studio writes it.
    const withdrawal = await t.db.system((sx) =>
      sx.query(
        `SELECT actor_id, metadata FROM audit_events WHERE object_id = :id AND action = 'persona.release_withdrawn'`,
        { id: p.text(corinV1) },
      ),
    );
    expect(withdrawal.rows).toHaveLength(1);
    expect(withdrawal.rows[0]?.actor_id).toBe(seed.ownerId);
    const withdrawnMeta: unknown = withdrawal.rows[0]?.metadata;
    expect(
      typeof withdrawnMeta === 'string' ? (JSON.parse(withdrawnMeta) as unknown) : withdrawnMeta,
    ).toMatchObject({
      personaId: corin,
      version: 1,
      from: 'superseded',
      via: 'owner_release',
      ownerRelease: 'thomas-2026-11-05',
      supersededBy: thomasRelease,
    });
  });

  it("is applied once: a redeploy changes nothing, and Ruth's persona is never touched", async () => {
    const before = await t.db.system((sx) => sx.query('SELECT count(*) AS n FROM persona_releases'));
    const again = await seedDatabase(t.db, { ...config, ownerReleases: ['thomas-2026-11-05'] });
    expect(again.ownerReleases.map((r) => r.outcome)).toEqual(['present']);
    const after = await t.db.system((sx) => sx.query('SELECT count(*) AS n FROM persona_releases'));
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    expect(await persona(ruth)).toMatchObject({ name: "Ruth's vEIR", presentation: 'twin' });
  });

  it('never applies to another tenant, and refuses an unknown key', async () => {
    const other = await seedDatabase(t.db, {
      homeTenant: { slug: 'other', name: 'Other (test)' },
      owner: null,
      ownerReleases: ['thomas-2026-11-05'],
    });
    // Without its deploy owner nothing is approved; the other tenant's persona stays its EIR's twin.
    expect(other.ownerReleases.map((r) => r.outcome)).toEqual(['no_owner']);
    expect(await persona(seedId('other', 'persona', 'veir', 'eir-corin'))).toMatchObject({
      name: "Corin's vEIR",
      presentation: 'twin',
    });
    expect(await persona(corin)).toMatchObject({ name: 'Thomas' });
    expect(() => parseOwnerReleases('thomas-2026-11-05, nobody')).toThrow(/unknown release/);
    expect(parseOwnerReleases(undefined)).toEqual([]);
  });

  it("rolls back the same way (ADR-0021): an owner release with Corin's v1 content restores the twin", async () => {
    const restore: OwnerRelease = {
      key: 'corin-restore-test',
      eirKey: 'eir-corin',
      name: CORIN_VEIR.name,
      presentation: 'twin',
      approvedOn: '2026-11-06',
      tagline: CORIN_VEIR.tagline,
      disclosure: CORIN_VEIR.disclosure,
      doctrine: CORIN_VEIR.doctrine,
      style: CORIN_VEIR.style,
    };
    const owner = await t.db.system(
      async (sx) =>
        (
          await sx.query(`SELECT created_by FROM persona_releases WHERE id = :id`, {
            id: p.uuid(thomasRelease),
          })
        ).rows[0]?.created_by,
    );
    const tenant = await t.db.system(
      async (sx) => (await sx.query(`SELECT id FROM tenants WHERE slug = 'ain'`)).rows[0]?.id,
    );
    const results = await t.db.system((sx) =>
      seedOwnerReleases(sx, {
        tenantId: String(tenant),
        id: (...parts) => seedId('ain', ...parts),
        ownerId: String(owner),
        keys: [restore.key],
        catalog: [restore],
      }),
    );
    expect(results.map((r) => r.outcome)).toEqual(['applied']);
    expect(await persona(corin)).toMatchObject({ name: "Corin's vEIR", presentation: 'twin' });
    const active = await t.db.system((sx) => personasRepo.getActiveRelease(sx, corin));
    expect(active?.version).toBe(3);
    expect(active?.doctrine).toEqual(CORIN_VEIR.doctrine);
    const thomas = await t.db.system((sx) => personasRepo.getRelease(sx, thomasRelease));
    expect(thomas?.status).toBe('withdrawn');
    const presence = await t.db.system((sx) =>
      personasRepo.getPersonaPresence(sx, { personaId: corin, assignedEirProfileId: null }),
    );
    expect(presence.mentor).toBe(false);
  });
});
