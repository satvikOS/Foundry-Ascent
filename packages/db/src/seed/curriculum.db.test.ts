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

  // As the coach asks: the founder's own words, Thomas's library alongside, two shared slots.
  async function shared(founderText: string) {
    const quietquad = seed.ventures.find((v) => v.key === 'quietquad');
    const founder = quietquad?.members.find((m) => m.role === 'founder');
    if (!quietquad || !founder) throw new Error('founder missing');
    return t.db.withContext(makeContext(founder.principalId, seed.tenantId), (tx) =>
      retrievalRepo.searchSharedChunks(tx, {
        tenantId: seed.tenantId,
        personaId: quietquad.personaId,
        query: founderText,
        embedding: null,
        limit: 2,
        reference: { founderText, limit: 1, sessionId: null },
      }),
    );
  }
  const isCurriculum = (title: string) => title.startsWith('Ain Foundry curriculum:');

  it("answers a founder's question about the programme, saying the programme changes as it goes", async () => {
    for (const question of [
      'What is the Module 2 capstone? Do I submit the pitch?',
      'How many events do I need for Module 1?',
      'What does Module 3 cover?',
    ]) {
      const found = (await shared(question)).filter((i) => isCurriculum(i.title));
      expect(found.length, question).toBeGreaterThan(0);
      for (const item of found) {
        if (/capstone|checklist|event|quiz/i.test(item.excerpt)) {
          expect(item.excerpt.startsWith('As of the programme materials'), question).toBe(true);
        }
      }
    }
  });

  it("leaves an ordinary founder question to the coach's own library", async () => {
    for (const question of [
      'Should I raise money or bootstrap?',
      'How should I pitch to investors?',
      'Who is my customer and who is my user?',
      'How do I find a mentor and build my network?',
    ]) {
      const found = await shared(question);
      expect(
        found.filter((i) => isCurriculum(i.title)).map((i) => i.title),
        question,
      ).toEqual([]);
    }
  });

  it('knows a message about the programme from one that is not', () => {
    expect(retrievalRepo.asksAboutProgramme('When is the business plan capstone due?')).toBe(true);
    expect(retrievalRepo.asksAboutProgramme('I missed the quiz on Blackboard')).toBe(true);
    expect(retrievalRepo.asksAboutProgramme('Should I raise money or bootstrap?')).toBe(false);
    expect(retrievalRepo.asksAboutProgramme('My customers are students')).toBe(false);
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

  it('names no presenter, and every passage with a requirement says the programme changes as it goes', () => {
    const text = JSON.stringify(AIN_CURRICULUM);
    for (const name of ['Testa', 'Mammano', 'Shifat']) expect(text).not.toContain(name);
    for (const chunk of AIN_CURRICULUM.flatMap((s) => s.chunks)) {
      if (/capstone|checklist|event|quiz/i.test(chunk.content))
        expect(chunk.content).toContain('Live Response Design');
    }
  });
});
