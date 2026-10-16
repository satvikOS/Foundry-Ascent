import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { p } from '../params.js';
import {
  assignmentsRepo,
  authRepo,
  knowledgeRepo,
  memoryRepo,
  notebooksRepo,
  personasRepo,
  resourcesRepo,
  sessionsRepo,
  venturesRepo,
} from '../repositories/index.js';
import { createTestDatabase, makeContext, type TestDatabase } from '../testing/test-database.js';
import { verifyAccessCode } from './access-code.js';
import { seedDatabase, type SeedConfig } from './seed.js';
import { SEED_EIRS, SEED_FOUNDERS, SEED_PROGRAM_LEAD } from './ventures.js';
import { ventureCanary } from './ids.js';
import { CORIN_VEIR, RUTH_VEIR, VEIR_ASSIGNMENTS } from './veir-content.js';

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
  'consents',
  'veir_notebooks',
  'coaching_sessions',
  'turns',
  'turn_evidence',
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

  it('coaches the demo ventures with consented vEIRs built from the synthetic EIRs', async () => {
    const seed = t.seed;
    if (!seed) throw new Error('seed missing');
    expect(seed.veirs.map((v) => v.name)).toEqual([CORIN_VEIR.name, RUTH_VEIR.name]);
    const lead = makeContext(seed.programLeadId ?? '', seed.tenantId);
    await t.db.withContext(lead, async (tx) => {
      for (const v of seed.veirs) {
        const persona = await personasRepo.getPersona(tx, v.personaId);
        expect(persona).toMatchObject({ kind: 'eir_persona', status: 'active', consentId: v.consentId });
        expect(persona?.embodiment.voiceId).toMatch(/^(Matthew|Ruth)$/);
        const consent = await personasRepo.getConsent(tx, v.consentId);
        expect(consent?.assetTypes).toEqual(['doctrine', 'style', 'voice', 'cases']);
        const release = await personasRepo.getActiveRelease(tx, v.personaId);
        expect(release).toMatchObject({ version: 1, status: 'approved' });
        expect(release?.disclosureText).toMatch(/AI coach.*not a person, and no human EIR/);
        const library = await knowledgeRepo.listPersonaLibrary(tx, { personaId: v.personaId });
        expect(library.length).toBeGreaterThanOrEqual(6);
        expect(new Set(library.map((s) => s.kind))).toEqual(new Set(['note', 'case', 'faq', 'transcript']));
        expect(library.every((s) => s.chunkCount > 0 && s.status === 'active')).toBe(true);
        const lessons = await resourcesRepo.listLessons(tx, {
          tenantId: seed.tenantId,
          personaId: v.personaId,
        });
        expect(lessons.length).toBeGreaterThanOrEqual(2);
        expect(lessons.every((l) => l.status === 'published')).toBe(true);
      }
      // The two personas are genuinely different coaches.
      const [corin, ruth] = await Promise.all(
        seed.veirs.map((v) => personasRepo.getActiveRelease(tx, v.personaId)),
      );
      expect(corin?.style.directness).toBe('direct');
      expect(ruth?.style.warmth).toBe('warm');
      expect(corin?.doctrine.summary).not.toEqual(ruth?.doctrine.summary);
    });
    for (const v of seed.ventures) {
      const eirKey = VEIR_ASSIGNMENTS[v.key];
      const veir = seed.veirs.find((x) => x.eirKey === eirKey);
      expect(v.personaId).toBe(veir?.personaId);
      expect(v.eirKey).toBe(eirKey);
      const founder = v.members.find((m) => m.role === 'founder');
      if (!founder) throw new Error('no founder');
      await t.db.withContext(makeContext(founder.principalId, seed.tenantId), async (tx) => {
        const resolved = await assignmentsRepo.resolveActiveAssignment(tx, v.id);
        expect(resolved?.assignment.id).toBe(v.assignmentId);
        expect(resolved?.persona.name).toBe(veir?.name);
        expect(resolved?.eir?.displayName).toBe(SEED_EIRS.find((e) => e.key === eirKey)?.displayName);
        // Every venture × vEIR pair has a notebook; QuietQuad's carries a past conversation and its digest.
        const notebook = await notebooksRepo.getNotebook(tx, { ventureId: v.id, personaId: v.personaId });
        expect(notebook).not.toBeNull();
        const sessions = await sessionsRepo.listSessionViews(tx, { ventureId: v.id });
        if (v.key === 'quietquad') {
          expect(notebook?.content.commitments.length).toBeGreaterThan(0);
          expect(notebook?.content.nextOpener).toMatch(/library-staff interviews/);
          expect(sessions).toHaveLength(1);
          expect(sessions[0]).toMatchObject({ status: 'ended', turnCount: 2, personaName: CORIN_VEIR.name });
          expect(sessions[0]?.digest?.commitments.length).toBe(3);
          expect(notebook?.content.commitments.every((c) => c.sourceSessionId === sessions[0]?.id)).toBe(
            true,
          );
        } else {
          expect(notebook?.version).toBe(0);
          expect(sessions).toEqual([]);
        }
      });
    }
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
    expect(new Set(items.map((m) => m.status))).toContain('confirmed');
    // What the vEIR learned is kept automatically: no AI item waits for an approval, and none claims one.
    const learned = items.filter((m) => m.origin === 'ai');
    expect(learned.length).toBeGreaterThanOrEqual(1);
    for (const m of learned) {
      expect(m).toMatchObject({ status: 'confirmed', keptAutomatically: true, approvedBy: null });
    }
    expect(items.filter((m) => m.origin !== 'ai').every((m) => !m.keptAutomatically)).toBe(true);
    const experiment = items.find((m) => m.type === 'experiment');
    expect(typeof experiment?.attributes.prediction).toBe('string');
    expect(typeof experiment?.attributes.method).toBe('string');
    const summaries = await t.db.withContext(makeContext(founder.principalId, seed.tenantId), (tx) =>
      venturesRepo.listVentureSummaries(tx, { principalId: founder.principalId, tenantId: seed.tenantId }),
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.myRole).toBe('founder');
    // Only an EIR's suggestions wait for the founder; what the vEIR learned was kept automatically.
    expect(summaries[0]?.pendingMemory).toBe(items.filter((m) => m.status === 'proposed').length);
    expect(summaries[0]?.openActions).toBeGreaterThanOrEqual(1);
  });
});

describe('seed re-runs (every production deploy)', () => {
  /** Ordinal and content of every chunk of a source, in order. */
  async function chunksOf(sourceId: string): Promise<string[]> {
    const r = await t.db.system((sx) =>
      sx.query('SELECT ordinal, content FROM knowledge_chunks WHERE source_id = :id ORDER BY ordinal', {
        id: p.uuid(sourceId),
      }),
    );
    return r.rows.map((row) => `${String(row.ordinal)}:${String(row.content)}`);
  }

  /** What the knowledge library does when a curator saves new text: one transaction, new chunks. */
  async function editAsCurator(sourceId: string, text: string): Promise<void> {
    await t.db.system(async (sx) => {
      await sx.query(`UPDATE knowledge_sources SET body = :body, updated_at = now() WHERE id = :id`, {
        id: p.uuid(sourceId),
        body: p.text(text),
      });
      await sx.query('DELETE FROM knowledge_chunks WHERE source_id = :id', { id: p.uuid(sourceId) });
      await sx.query(
        `INSERT INTO knowledge_chunks (source_id, tenant_id, scope, venture_id, persona_id, ordinal, heading, content,
                                       token_count)
         SELECT s.id, s.tenant_id, s.scope, s.venture_id, s.persona_id, 1, s.title, :body, 4
         FROM knowledge_sources s WHERE s.id = :id`,
        { id: p.uuid(sourceId), body: p.text(text) },
      );
    });
  }

  /** What withdrawing a library source does. */
  async function withdraw(sourceId: string): Promise<void> {
    await t.db.system(async (sx) => {
      await sx.query('DELETE FROM knowledge_chunks WHERE source_id = :id', { id: p.uuid(sourceId) });
      await sx.query(`UPDATE knowledge_sources SET status = 'withdrawn', updated_at = now() WHERE id = :id`, {
        id: p.uuid(sourceId),
      });
    });
  }

  it('seeds the Foundry Guide corpora as authored notes, as upgraded databases have them', async () => {
    const r = await t.db.system((sx) =>
      sx.query(
        `SELECT s.scope, s.kind, s.body = (
                  SELECT string_agg(CASE WHEN c.heading IS NULL OR c.heading = '' THEN c.content
                                         ELSE '## ' || c.heading || E'\\n\\n' || c.content END,
                                    E'\\n\\n' ORDER BY c.ordinal)
                  FROM knowledge_chunks c WHERE c.source_id = s.id) AS body_matches_chunks
         FROM knowledge_sources s
         WHERE s.scope = 'program' OR (s.scope = 'persona' AND s.persona_id = :guide)
         ORDER BY s.scope`,
        { guide: p.uuid(t.seed?.personaId ?? '') },
      ),
    );
    expect(r.rows).toEqual([
      { scope: 'persona', kind: 'note', body_matches_chunks: true },
      { scope: 'program', kind: 'note', body_matches_chunks: true },
    ]);
  });

  it('never gives an edited or withdrawn corpus, or a deleted document, its seeded chunks back', async () => {
    const seed = t.seed;
    if (!seed) throw new Error('seed missing');
    const corin = seed.veirs.find((v) => v.eirKey === 'eir-corin');
    const library = await t.db.system((sx) =>
      sx.query(
        `SELECT s.id FROM knowledge_sources s JOIN knowledge_chunks c ON c.source_id = s.id
         WHERE s.persona_id = :persona GROUP BY s.id, s.title HAVING count(c.id) > 1 ORDER BY s.title LIMIT 2`,
        { persona: p.uuid(corin?.personaId ?? '') },
      ),
    );
    const [edited, withdrawn] = library.rows.map((row) => String(row.id));
    const corpora = await t.db.system((sx) =>
      sx.query(
        `SELECT scope, id FROM knowledge_sources
         WHERE scope = 'program' OR (scope = 'persona' AND persona_id = :guide) ORDER BY scope`,
        { guide: p.uuid(seed.personaId) },
      ),
    );
    const [guide, program] = corpora.rows.map((row) => String(row.id));
    if (!edited || !withdrawn || !guide || !program) throw new Error('seeded corpora missing');

    await editAsCurator(edited, 'One section now.');
    await editAsCurator(guide, 'The doctrine, shortened.');
    await withdraw(withdrawn);
    await withdraw(program);
    // A founder deletes a seeded document: its chunks go and its source is withdrawn.
    const quietquad = seed.ventures.find((v) => v.key === 'quietquad');
    const maya = quietquad?.members.find((m) => m.key === 'maya');
    const documentId = quietquad?.documentIds[0];
    if (!quietquad || !maya || !documentId) throw new Error('seeded document missing');
    await t.db.withContext(makeContext(maya.principalId, seed.tenantId), (tx) =>
      tx.query('SELECT app.soft_delete_document(:id) AS s3_key', { id: p.uuid(documentId) }),
    );
    const documentSource = await t.db.system((sx) =>
      sx.query('SELECT source_id FROM documents WHERE id = :id', { id: p.uuid(documentId) }),
    );
    const deletedDocument = String(documentSource.rows[0]?.source_id);

    const snapshot = async (): Promise<Record<string, string[]>> => ({
      edited: await chunksOf(edited),
      guide: await chunksOf(guide),
      withdrawn: await chunksOf(withdrawn),
      program: await chunksOf(program),
      document: await chunksOf(deletedDocument),
    });
    const before = await snapshot();
    expect(before).toEqual({
      edited: ['1:One section now.'],
      guide: ['1:The doctrine, shortened.'],
      withdrawn: [],
      program: [],
      document: [],
    });
    const rows = await counts();
    await seedDatabase(t.db, NO_OWNER);
    await seedDatabase(t.db, NO_OWNER);
    expect(await snapshot()).toEqual(before);
    expect(await counts()).toEqual(rows);
  });
});
