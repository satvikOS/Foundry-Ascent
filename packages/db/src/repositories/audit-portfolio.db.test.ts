import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PortfolioSummary } from '@foundry/contracts';

import { SqlUsageError } from '../errors.js';
import { p } from '../params.js';
import { type SeedResult } from '../seed/seed.js';
import { createTestDatabase, makeContext, type TestDatabase } from '../testing/test-database.js';
import * as auditRepo from './audit.js';
import * as portfolioRepo from './portfolio.js';
import * as venturesRepo from './ventures.js';

let t: TestDatabase;
let seed: SeedResult;

beforeAll(async () => {
  t = await createTestDatabase({ seed: true });
  if (!t.seed) throw new Error('seed missing');
  seed = t.seed;
}, 120_000);

afterAll(async () => {
  await t.cleanup();
});

describe('audit hash chain', () => {
  it('chains app and system appends and detects tampering', async () => {
    const founder = seed.principals.maya ?? '';
    const ventureId = seed.ventures[0]?.id ?? '';
    for (let i = 0; i < 3; i += 1) {
      await t.db.withContext(makeContext(founder, seed.tenantId), (tx) =>
        auditRepo.appendAudit(tx, {
          action: 'retrieval.authorized',
          outcome: 'allowed',
          ventureId,
          objectType: 'venture',
          objectId: ventureId,
          metadata: { memory: 3, chunks: i, ids: ['E1', 'E2'] },
        }),
      );
      await t.db.system((sx) =>
        auditRepo.appendAudit(sx, {
          action: 'worker.ingested',
          outcome: 'succeeded',
          tenantId: seed.tenantId,
          ventureId,
          requestId: `job-${String(i)}`,
          metadata: { chunks: 4 },
        }),
      );
    }
    const intact = await t.db.system((sx) => auditRepo.verifyAuditChain(sx));
    expect(intact.firstBrokenId).toBeNull();
    expect(intact.checked).toBeGreaterThanOrEqual(6);

    // Chain verification is resumable from lastId.
    const firstHalf = await t.db.system((sx) => auditRepo.verifyAuditChain(sx, { limit: 3 }));
    const rest = await t.db.system((sx) => auditRepo.verifyAuditChain(sx, { afterId: firstHalf.lastId }));
    expect(firstHalf.checked + rest.checked).toBe(intact.checked);
    expect(rest.firstBrokenId).toBeNull();

    // Pagination walks every event exactly once, newest first.
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const page: auditRepo.AuditPage = await t.db.system((sx) =>
        auditRepo.listAuditEvents(sx, { limit: 2, cursor }),
      );
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([...seen].sort((a, b) => b - a));
    expect(seen.length).toBe(intact.checked);
    const filtered = await t.db.system((sx) =>
      auditRepo.listAuditEvents(sx, { tenantId: seed.tenantId, action: 'worker.ingested' }),
    );
    expect(filtered.items).toHaveLength(3);

    // Tamper with one event's metadata (owner can, app_rls cannot): verification pinpoints it.
    const victim = seen[seen.length - 2] ?? 0;
    await t.db.system((sx) =>
      sx.query(`UPDATE audit_events SET metadata = '{"chunks": 99}'::jsonb WHERE id = :id`, {
        id: p.bigint(victim),
      }),
    );
    const broken = await t.db.system((sx) => auditRepo.verifyAuditChain(sx));
    expect(broken.firstBrokenId).toBe(victim);
  });

  it('rejects metadata that could carry content', async () => {
    await expect(
      t.db.system((sx) =>
        auditRepo.appendAudit(sx, { action: 'x', outcome: 'succeeded', metadata: { text: 'x'.repeat(500) } }),
      ),
    ).rejects.toBeInstanceOf(SqlUsageError);
    expect(() => {
      auditRepo.assertAuditMetadata({ nested: { a: 1 } });
    }).toThrow(SqlUsageError);
    expect(() => {
      auditRepo.assertAuditMetadata({ count: 3, id: 'abc', ok: true, none: null, list: ['a', 1] });
    }).not.toThrow();
  });
});

describe('portfolio k-anonymity', () => {
  it('suppresses groups smaller than the minimum and reveals them once large enough', async () => {
    const lead = makeContext(seed.programLeadId ?? '', seed.tenantId);
    const before = await t.db.withContext(lead, (tx) => portfolioRepo.getPortfolioSummary(tx));
    expect(PortfolioSummary.safeParse(before).success).toBe(true);
    expect(before.minGroupSize).toBe(3);
    // Four seeded ventures, one per stage: every stage group is below k=3.
    expect(Object.values(before.venturesByStage).every((n) => n === null)).toBe(true);
    expect(Object.keys(before.venturesByStage).sort()).toEqual(
      ['business_model', 'commercialization', 'discovery', 'validation'].sort(),
    );
    expect(before.escalationsByCategory.medical_regulatory).toBeNull();
    expect(before.medianFeedbackRating30d).toBeNull();

    await t.db.withContext(lead, async (tx) => {
      for (const name of ['Idea One', 'Idea Two', 'Idea Three']) {
        await venturesRepo.createVenture(tx, { tenantId: seed.tenantId, name, stage: 'idea' });
      }
    });
    const after = await t.db.withContext(lead, (tx) => portfolioRepo.getPortfolioSummary(tx));
    expect(after.venturesByStage.idea).toBe(3);
    expect(after.venturesByStage.discovery).toBeNull();
    // The JSON never carries names or text.
    expect(JSON.stringify(after)).not.toMatch(/Idea One|QuietQuad|CANARY/);
  });

  it('is denied to founders and EIRs', async () => {
    for (const key of ['maya', 'eir-corin']) {
      await expect(
        t.db.withContext(makeContext(seed.principals[key] ?? '', seed.tenantId), (tx) =>
          portfolioRepo.getPortfolioSummary(tx),
        ),
      ).rejects.toMatchObject({ sqlState: '42501' });
    }
  });
});
