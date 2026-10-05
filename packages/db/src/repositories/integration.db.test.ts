/**
 * Repository functions added for the API/core integration: idempotency reservations, the status-guarded
 * memory embedding write, ephemeral turn redaction, reservable sign-in attempts and the purge of stored
 * idempotent responses when memory or a document is deleted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type DbContext } from '../db.js';
import { SqlUsageError } from '../errors.js';
import { p } from '../params.js';
import { type SeedResult } from '../seed/seed.js';
import { createTestDatabase, makeContext, type TestDatabase } from '../testing/test-database.js';
import * as assignmentsRepo from './assignments.js';
import * as authRepo from './auth.js';
import * as documentsRepo from './documents.js';
import * as idempotencyRepo from './idempotency.js';
import * as knowledgeRepo from './knowledge.js';
import * as memoryRepo from './memory.js';
import * as sessionsRepo from './sessions.js';
import * as turnsRepo from './turns.js';
import * as venturesRepo from './ventures.js';

let t: TestDatabase;
let seed: SeedResult;
let maya: DbContext;
let graham: DbContext;
let quietquad: string;
let solesignal: string;

const vector = (value: number): number[] => new Array<number>(knowledgeRepo.EMBEDDING_DIMENSIONS).fill(value);

beforeAll(async () => {
  t = await createTestDatabase({ seed: true });
  if (!t.seed) throw new Error('seed missing');
  seed = t.seed;
  maya = makeContext(seed.principals.maya ?? '', seed.tenantId);
  graham = makeContext(seed.principals.graham ?? '', seed.tenantId);
  quietquad = seed.ventures.find((v) => v.key === 'quietquad')?.id ?? '';
  solesignal = seed.ventures.find((v) => v.key === 'solesignal')?.id ?? '';
}, 120_000);

afterAll(async () => {
  await t.cleanup();
});

async function createMemory(ctx: DbContext, ventureId: string, title: string): Promise<string> {
  const record = await t.db.withContext(ctx, (tx) =>
    memoryRepo.createMemory(tx, {
      tenantId: seed.tenantId,
      ventureId,
      type: 'fact',
      title,
      content: `${title} content`,
      status: 'confirmed',
      visibility: 'venture',
      origin: 'founder',
      createdBy: ctx.principalId,
    }),
  );
  return record.id;
}

async function embeddingIsSet(memoryId: string): Promise<boolean> {
  const result = await t.db.system((sx) =>
    sx.query('SELECT embedding IS NOT NULL AS set FROM memory_objects WHERE id = :id', {
      id: p.uuid(memoryId),
    }),
  );
  return result.rows[0]?.set === true;
}

describe('idempotency reservations', () => {
  const scope = (key: string) => ({
    principalId: seed.principals.maya ?? '',
    route: 'POST /ventures/:id/memory',
    key,
  });

  it('reserves once, reports in-progress and mismatching requests, then replays the stored response', async () => {
    await t.db.system(async (sx) => {
      const key = scope('reserve-1');
      expect(await idempotencyRepo.reserveIdempotencyKey(sx, { ...key, requestHash: 'h1' })).toEqual({
        kind: 'reserved',
      });
      expect(await idempotencyRepo.reserveIdempotencyKey(sx, { ...key, requestHash: 'h1' })).toEqual({
        kind: 'in_progress',
      });
      expect(await idempotencyRepo.reserveIdempotencyKey(sx, { ...key, requestHash: 'h2' })).toEqual({
        kind: 'mismatch',
      });
      expect(
        await idempotencyRepo.completeIdempotencyKey(sx, {
          ...key,
          requestHash: 'h1',
          statusCode: 201,
          response: { id: 'm-1' },
        }),
      ).toBe(true);
      expect(await idempotencyRepo.reserveIdempotencyKey(sx, { ...key, requestHash: 'h1' })).toEqual({
        kind: 'replay',
        statusCode: 201,
        response: { id: 'm-1' },
      });
      // A completed record is never released or completed again.
      expect(await idempotencyRepo.releaseIdempotencyKey(sx, { ...key, requestHash: 'h1' })).toBe(false);
      expect(
        await idempotencyRepo.completeIdempotencyKey(sx, {
          ...key,
          requestHash: 'h1',
          statusCode: 200,
          response: {},
        }),
      ).toBe(false);
    });
  });

  it('releases a failed request so a retry executes again', async () => {
    await t.db.system(async (sx) => {
      const key = scope('release-1');
      await idempotencyRepo.reserveIdempotencyKey(sx, { ...key, requestHash: 'h1' });
      expect(await idempotencyRepo.releaseIdempotencyKey(sx, { ...key, requestHash: 'h2' })).toBe(false);
      expect(await idempotencyRepo.releaseIdempotencyKey(sx, { ...key, requestHash: 'h1' })).toBe(true);
      expect(await idempotencyRepo.reserveIdempotencyKey(sx, { ...key, requestHash: 'h1' })).toEqual({
        kind: 'reserved',
      });
    });
  });

  it('takes over a stale reservation (crashed request) with the same hash only', async () => {
    await t.db.system(async (sx) => {
      const key = scope('stale-1');
      await idempotencyRepo.reserveIdempotencyKey(sx, { ...key, requestHash: 'h1' });
      await sx.query(
        "UPDATE idempotency_keys SET created_at = now() - interval '5 minutes' WHERE key = :key",
        { key: p.text(key.key) },
      );
      expect(await idempotencyRepo.reserveIdempotencyKey(sx, { ...key, requestHash: 'h2' })).toEqual({
        kind: 'mismatch',
      });
      expect(await idempotencyRepo.reserveIdempotencyKey(sx, { ...key, requestHash: 'h1' })).toEqual({
        kind: 'reserved',
      });
      expect(await idempotencyRepo.reserveIdempotencyKey(sx, { ...key, requestHash: 'h1' })).toEqual({
        kind: 'in_progress',
      });
    });
  });

  it('stores 2xx responses only', async () => {
    await t.db.system(async (sx) => {
      const key = scope('status-1');
      await idempotencyRepo.reserveIdempotencyKey(sx, { ...key, requestHash: 'h1' });
      await expect(
        idempotencyRepo.completeIdempotencyKey(sx, {
          ...key,
          requestHash: 'h1',
          statusCode: 500,
          response: {},
        }),
      ).rejects.toBeInstanceOf(SqlUsageError);
    });
  });
});

describe('memory embeddings (status-guarded)', () => {
  it('never gives a deleted item a vector of its old text', async () => {
    const id = await createMemory(maya, quietquad, 'Guarded embedding');
    expect(await t.db.withContext(maya, (tx) => memoryRepo.deleteMemory(tx, id))).toBe(1);
    const stored = await t.db.system((sx) =>
      knowledgeRepo.setMemoryEmbeddings(sx, [{ id, embedding: vector(0.01) }]),
    );
    expect(stored).toBe(0);
    expect(await embeddingIsSet(id)).toBe(false);
  });

  it('writes under RLS for members who may edit the item, and nothing for others', async () => {
    const ownId = await createMemory(maya, quietquad, 'Embedding under RLS');
    expect(
      await t.db.withContext(maya, (tx) =>
        knowledgeRepo.setMemoryEmbeddings(tx, [{ id: ownId, embedding: vector(0.02) }]),
      ),
    ).toBe(1);
    expect(await embeddingIsSet(ownId)).toBe(true);

    // Graham is only an advisor of SoleSignal (no write access) and no member of QuietQuad.
    const otherId = await createMemory(
      makeContext(seed.principals.amara ?? '', seed.tenantId),
      solesignal,
      'Advisor view',
    );
    const byAdvisor = await t.db.withContext(graham, (tx) =>
      knowledgeRepo.setMemoryEmbeddings(tx, [
        { id: otherId, embedding: vector(0.03) },
        { id: ownId, embedding: vector(0.03) },
      ]),
    );
    expect(byAdvisor).toBe(0);
    expect(await embeddingIsSet(otherId)).toBe(false);
  });
});

describe('ephemeral session redaction', () => {
  it('removes founder text and responses of every turn of the session', async () => {
    const sessionId = await t.db.withContext(maya, async (tx) => {
      const resolved = await assignmentsRepo.resolveActiveAssignment(tx, quietquad);
      if (!resolved?.release) throw new Error('no release');
      const session = await sessionsRepo.createSession(tx, {
        tenantId: seed.tenantId,
        ventureId: quietquad,
        assignmentId: resolved.assignment.id,
        personaReleaseId: resolved.release.id,
        startedBy: maya.principalId,
        mode: 'diagnose',
        privacy: 'ephemeral',
        goal: null,
        policyVersion: '2026-10-05.1',
      });
      for (const text of ['Private pricing idea', 'Another private idea']) {
        await turnsRepo.createTurn(tx, {
          tenantId: seed.tenantId,
          ventureId: quietquad,
          sessionId: session.id,
          authorId: maya.principalId,
          mode: 'diagnose',
          founderText: text,
          riskCategories: [],
        });
      }
      return session.id;
    });
    // Advisors cannot write the venture: nothing happens.
    expect(await t.db.withContext(graham, (tx) => turnsRepo.redactSessionTurns(tx, sessionId))).toBe(0);
    expect(await t.db.withContext(maya, (tx) => turnsRepo.redactSessionTurns(tx, sessionId))).toBe(2);
    const turns = await t.db.withContext(maya, (tx) => turnsRepo.listTurns(tx, sessionId));
    expect(turns.map((x) => x.founderText)).toEqual([
      turnsRepo.EPHEMERAL_REDACTION_TEXT,
      turnsRepo.EPHEMERAL_REDACTION_TEXT,
    ]);
    expect(JSON.stringify(turns)).not.toContain('Private pricing idea');
  });
});

describe('sign-in attempts', () => {
  it('records an attempt as failed first, then marks it succeeded or deletes it', async () => {
    await t.db.system(async (sx) => {
      const subjectHash = 'reserve-ip';
      const first = await authRepo.recordAuthAttempt(sx, { subjectHash, succeeded: false });
      const second = await authRepo.recordAuthAttempt(sx, { subjectHash, succeeded: false });
      expect(second).toBeGreaterThan(first);
      expect((await authRepo.authFailureWindow(sx, { subjectHash, windowSeconds: 900 })).failures).toBe(2);
      expect(await authRepo.markAuthAttemptSucceeded(sx, first)).toBe(true);
      expect(await authRepo.deleteAuthAttempt(sx, second)).toBe(true);
      expect(await authRepo.deleteAuthAttempt(sx, second)).toBe(false);
      expect((await authRepo.authFailureWindow(sx, { subjectHash, windowSeconds: 900 })).failures).toBe(0);
    });
  });
});

describe('venture member directory (guard input, system only)', () => {
  it('lists active members per venture of one tenant, and nothing for another tenant', async () => {
    const rows = await t.db.system((sx) => venturesRepo.listVentureMemberNames(sx, seed.tenantId));
    expect(rows).toContainEqual({
      ventureId: solesignal,
      principalId: seed.principals.amara ?? '',
      displayName: 'Amara Nwosu-Belling',
    });
    expect(rows.filter((r) => r.ventureId === quietquad).map((r) => r.displayName)).toContain(
      'Maya Okafor-Lindqvist',
    );
    expect(
      await t.db.system((sx) =>
        venturesRepo.listVentureMemberNames(sx, '00000000-0000-4000-8000-0000000000aa'),
      ),
    ).toEqual([]);
  });
});

describe('deletes purge stored idempotent responses', () => {
  async function storeResponse(key: string, response: unknown): Promise<void> {
    await t.db.system((sx) =>
      idempotencyRepo.saveIdempotencyRecord(sx, {
        principalId: maya.principalId,
        route: 'POST /test',
        key,
        requestHash: 'h',
        statusCode: 201,
        response,
      }),
    );
  }
  async function storedKeys(): Promise<string[]> {
    const result = await t.db.system((sx) =>
      sx.query("SELECT key FROM idempotency_keys WHERE route = 'POST /test' ORDER BY key"),
    );
    return result.rows.map((r) => String(r.key));
  }

  it('memory: every stored response that mentions a deleted version goes, others stay', async () => {
    const id = await createMemory(maya, quietquad, 'Purged from idempotency');
    await storeResponse('purge-memory-1', { id, title: 'Purged from idempotency', content: 'secret' });
    await storeResponse('purge-memory-2', { recap: { memory_candidate_ids: [id] } });
    await storeResponse('purge-memory-3', { id: '00000000-0000-4000-8000-000000000000' });
    expect(await t.db.withContext(maya, (tx) => memoryRepo.deleteMemory(tx, id))).toBe(1);
    expect(await storedKeys()).toEqual(['purge-memory-3']);
  });

  it('documents: stored responses that mention the document go', async () => {
    const documentId = '22222222-2222-4222-8222-222222222222';
    await t.db.withContext(maya, (tx) =>
      documentsRepo.createDocument(tx, {
        id: documentId,
        tenantId: seed.tenantId,
        ventureId: quietquad,
        filename: 'board-notes.md',
        contentType: 'text/markdown',
        sizeBytes: 10,
        s3Key: `tenants/${seed.tenantId}/ventures/${quietquad}/documents/${documentId}/board-notes.md`,
        uploadedBy: maya.principalId,
      }),
    );
    await storeResponse('purge-document-1', { document: { id: documentId, filename: 'board-notes.md' } });
    expect(
      await t.db.withContext(maya, (tx) => documentsRepo.softDeleteDocument(tx, documentId)),
    ).not.toBeNull();
    expect(await storedKeys()).toEqual(['purge-memory-3']);
  });
});
