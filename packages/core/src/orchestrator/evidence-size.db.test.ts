/**
 * How much evidence a typed turn carries, on the labelled student questions of the retrieval evaluation and a venture's
 * own record, with the play its message asks for (what the path decides): a turn reads the play, then little else.
 */
import { buildEvidenceBlock, hashEmbedding, MOCK_EMBEDDINGS_MODEL_ID } from '@foundry/ai';
import { knowledgeRepo, tagEmbedding } from '@foundry/db';
import { createTestDatabase, makeContext, type TestDatabase } from '@foundry/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_CORE_CONFIG } from '../config.js';
import { phraseIntent } from '../path/match.js';
import { pickPlay } from '../path/semantic.js';
import { meaningOfTest } from '../path/testing/meaning.js';
import { PLAYBOOK } from '../path/playbook/index.js';
import { estimateTokens } from './context-budget.js';
import { type EvidencePack } from './evidence.js';
import { RETRIEVAL_EVAL } from './retrieval-eval.fixture.js';
import { retrieveEvidence } from './retrieval.js';

let t: TestDatabase;
let tenantId: string;
let venture: { id: string; personaId: string; founder: string };
const embed = (text: string): number[] => tagEmbedding(hashEmbedding(text), MOCK_EMBEDDINGS_MODEL_ID);

beforeAll(async () => {
  t = await createTestDatabase({ seed: true });
  const seeded = t.seed?.ventures.find((v) => v.key === 'quietquad');
  if (!t.seed || !seeded) throw new Error('seed missing');
  tenantId = t.seed.tenantId;
  venture = {
    id: seeded.id,
    personaId: seeded.personaId,
    founder: seeded.members[0]?.principalId ?? '',
  };
  await t.db.system(async (sx) => {
    const chunks = await knowledgeRepo.listChunksMissingEmbeddings(sx, 5_000);
    await knowledgeRepo.setChunkEmbeddings(
      sx,
      chunks.map((b) => ({ id: b.id, embedding: embed(b.text) })),
    );
    const memory = await knowledgeRepo.listMemoryMissingEmbeddings(sx, 5_000);
    await knowledgeRepo.setMemoryEmbeddings(
      sx,
      memory.map((b) => ({ id: b.id, embedding: embed(b.text) })),
    );
  });
}, 180_000);
afterAll(async () => {
  await t.cleanup();
});

function evidence(message: string): Promise<EvidencePack> {
  // As meaning would choose one: the nearest, or none.
  const intent = (
    phraseIntent(PLAYBOOK, message) ?? pickPlay(PLAYBOOK, message, meaningOfTest(PLAYBOOK, message), 'ask')
  ).intent;
  const play = PLAYBOOK.plays.find((x) => x.id === intent?.playId) ?? null;
  return t.db.withContext(makeContext(venture.founder, tenantId), (tx) =>
    retrieveEvidence(tx, {
      tenantId,
      ventureId: venture.id,
      personaId: venture.personaId,
      stage: 'discovery',
      query: message,
      founderText: message,
      embedding: embed(message),
      dataClassCeiling: 'venture_private',
      budgets: DEFAULT_CORE_CONFIG.retrieval,
      privateOwnerId: null,
      play: play === null ? null : { play, sources: PLAYBOOK.sources },
    }),
  );
}

describe('the evidence of a typed turn', () => {
  it('is small: the play, the founder’s own record, one or two passages', async () => {
    const tokens: number[] = [];
    const items: number[] = [];
    for (const { query } of RETRIEVAL_EVAL) {
      const pack = await evidence(query);
      tokens.push(estimateTokens(buildEvidenceBlock(pack.items.map((k) => k.item))));
      items.push(pack.items.length);
    }
    tokens.sort((a, b) => a - b);
    const mean = tokens.reduce((a, b) => a + b, 0) / tokens.length;
    const at = (q: number): number => tokens[Math.floor(q * (tokens.length - 1))] ?? 0;
    process.stdout.write(
      `\nevidence of ${String(tokens.length)} typed turns: mean ${mean.toFixed(0)} tokens, p50 ${String(at(0.5))}, ` +
        `p95 ${String(at(0.95))}, max ${String(at(1))}; ${(items.reduce((a, b) => a + b, 0) / items.length).toFixed(1)} items\n`,
    );
    // Before (memory 8, chunks 6, resources 4, patterns 2, openings of 600 characters): mean 799, p95 1604, max 2292.
    expect(mean).toBeLessThan(700);
    expect(at(0.95)).toBeLessThan(1_250);
    expect(at(1)).toBeLessThan(2_100);
  }, 180_000);
});
