/**
 * The Ain Foundry curriculum (./curriculum.ts) in the programme's own tenant: one programme-scope note per part, each
 * chunked, and found by a founder's ordinary question through the shared search the coach uses (programme guidance,
 * not the gated reference library); another tenant gets none of it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { p } from '../params.js';
import * as retrievalRepo from '../repositories/retrieval.js';
import { createTestDatabase, makeContext, type TestDatabase } from '../testing/test-database.js';
import { accessCodePrefix, generateAccessCode, hashAccessCode } from './access-code.js';
import { AIN_CURRICULUM } from './curriculum.js';
import { seedDatabase, type SeedResult } from './seed.js';

let t: TestDatabase;
let seed: SeedResult;

beforeAll(async () => {
  t = await createTestDatabase({ seed: true });
  if (!t.seed) throw new Error('seed missing');
  seed = t.seed;
}, 180_000);
afterAll(async () => {
  await t.cleanup();
});

async function curriculumSources(tenantId: string) {
  return t.db.system(
    async (sx) =>
      (
        await sx.query(
          `SELECT s.title, s.scope, s.kind, count(c.id)::int AS chunks
             FROM knowledge_sources s LEFT JOIN knowledge_chunks c ON c.source_id = s.id
            WHERE s.tenant_id = :tenantId AND s.title LIKE 'Ain Foundry curriculum:%'
            GROUP BY s.id ORDER BY s.title`,
          { tenantId: p.uuid(tenantId) },
        )
      ).rows,
  );
}

describe('the Ain Foundry curriculum', () => {
  it('is a programme-scope note per part, each chunked', async () => {
    const sources = await curriculumSources(seed.tenantId);
    expect(sources).toHaveLength(AIN_CURRICULUM.length);
    for (const s of sources) {
      expect(s).toMatchObject({ scope: 'program', kind: 'note' });
      expect(Number(s.chunks)).toBeGreaterThan(0);
    }
  });

  it("answers a founder's question about a capstone through the coach's shared search", async () => {
    const founder = seed.ventures
      .find((v) => v.key === 'quietquad')
      ?.members.find((m) => m.role === 'founder');
    if (!founder) throw new Error('founder missing');
    const found = await t.db.withContext(makeContext(founder.principalId, seed.tenantId), (tx) =>
      retrievalRepo.searchSharedChunks(tx, {
        tenantId: seed.tenantId,
        query: 'What is the Module 2 capstone? Do I submit the pitch?',
        embedding: null,
        limit: 5,
      }),
    );
    // The roadmap's "three capstones" passage answers it too; Module 2's own capstone is among the passages.
    expect(found[0]?.title.startsWith('Ain Foundry curriculum:')).toBe(true);
    expect(found.some((i) => i.title.includes('Module 2') && i.title.endsWith('Module 2 capstone'))).toBe(
      true,
    );
  });

  it('stays in its own tenant', async () => {
    const code = generateAccessCode();
    const other = await seedDatabase(t.db, {
      homeTenant: { slug: 'elsewhere', name: 'Elsewhere (test)' },
      owner: {
        displayName: 'Other Owner',
        accessCodePrefix: accessCodePrefix(code),
        accessCodeHash: await hashAccessCode(code),
      },
      includeDemoData: false,
    });
    expect(await curriculumSources(other.tenantId)).toEqual([]);
  });

  it('names no presenter and keeps the programme-changes caveat on every capstone', () => {
    const text = JSON.stringify(AIN_CURRICULUM);
    for (const name of ['Testa', 'Mammano', 'Shifat']) expect(text).not.toContain(name);
    for (const s of AIN_CURRICULUM.filter((x) => x.key.includes('module'))) {
      const capstone = s.chunks.find((c) => c.heading.endsWith('capstone'));
      expect(capstone?.content).toContain('Live Response Design');
    }
  });
});
