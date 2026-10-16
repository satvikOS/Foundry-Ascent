/**
 * The operator insights job against a real database with real conversations (core services, mock model): the
 * metadata report counts what happened and carries no text, the export holds the content sealed to the
 * operator's key and leaves temporary conversations out, and every read runs in a read-only transaction.
 */
import { generateKeyPairSync } from 'node:crypto';

import { TurnStreamEvent } from '@foundry/contracts';
import { type RequestContext } from '@foundry/core';
import {
  type CoreHarness,
  createCoreHarness,
  FakeSpeechSynthesizer,
  FakeSttGrantIssuer,
} from '@foundry/core/testing';
import { DbError, insightsRepo, p } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { silentLogger } from '../logging.js';
import { open } from './insights-envelope.js';
import { renderReport } from './insights-render.js';
import { InsightsExportPart, InsightsReport, runInsights } from './insights.js';

let h: CoreHarness;
let maya: RequestContext;
let textId: string;
let voiceId: string;
let privateId: string;
let callId: string;

const keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const privatePem = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

/** Words that must never appear in the metadata (they are in founder text, answers and digests only). */
const CANARY = 'Quillfeather';
const PRIVATE_CANARY = 'Marrowstone';

async function turn(sessionId: string, text: string, voice?: string): Promise<void> {
  const events: TurnStreamEvent[] = [];
  await h.core.orchestrator.runTurn(
    maya,
    sessionId,
    voice === undefined ? { text } : { text, channel: 'voice', callId: voice },
    (e) => {
      events.push(TurnStreamEvent.parse(e));
    },
  );
  if (events.at(-1)?.event !== 'turn.completed') throw new Error('turn did not complete');
}

async function idle(sessionId: string, minutes: number): Promise<void> {
  await h.t.db.system((sx) =>
    sx.query(
      'UPDATE coaching_sessions SET last_activity_at = now() - make_interval(mins => :m) WHERE id = :id',
      { id: p.uuid(sessionId), m: p.int(minutes) },
    ),
  );
}

const deps = () => ({ db: h.t.db, logger: silentLogger });

beforeAll(async () => {
  h = await createCoreHarness({
    speech: new FakeSpeechSynthesizer(),
    sttGrants: new FakeSttGrantIssuer(),
    config: { turns: { rateLimit: 500 } },
  });
  maya = await h.ctxFor(h.people.maya);
  const venture = h.ventures.quietquad.id;

  textId = (await h.core.sessions.create(maya, venture, {})).id;
  await turn(textId, `Our pilot with ${CANARY} library went well; what should we charge?`);
  await turn(textId, 'Two libraries want a second term.');
  await idle(textId, 20);
  const distilled = await h.core.distill.distillSession({ sessionId: textId, requestId: 'insights-test' });
  if (distilled.status !== 'distilled') throw new Error(`distillation ${distilled.status}`);

  voiceId = (await h.core.sessions.create(maya, venture, {})).id;
  callId = (await h.core.calls.start(maya, voiceId, { inputMode: 'transcribe' })).call.id;
  await turn(voiceId, 'Do you remember what we talked about last time?', callId);
  await turn(voiceId, 'Right, the pricing. Let us continue.', callId);
  await h.core.calls.end(maya, callId, { reason: 'user' });

  privateId = (await h.core.sessions.create(maya, venture, { privacy: 'ephemeral' })).id;
  await turn(privateId, `Keep this between us: ${PRIVATE_CANARY}.`);
}, 180_000);

afterAll(async () => {
  await h.cleanup();
});

describe('metadata', () => {
  let report: InsightsReport;

  beforeAll(async () => {
    report = InsightsReport.parse(await runInsights(deps(), { scope: 'metadata', days: 7 }));
  });

  it('counts conversations, turns, calls and distillation per conversation', () => {
    const byId = new Map(report.conversations.map((c) => [c.id, c]));
    expect(byId.get(textId)).toMatchObject({
      channel: 'text',
      privacy: 'standard',
      turns: { completed: 2, voice: 0 },
      hasDigest: true,
      distillVersion: 2,
    });
    expect(byId.get(voiceId)).toMatchObject({
      channel: 'voice',
      turns: { completed: 2, voice: 2 },
      calls: 1,
      hasDigest: false,
      distilledAt: null,
    });
    expect(byId.get(privateId)).toMatchObject({ privacy: 'ephemeral', turns: { completed: 1 } });
    const call = report.calls.find((c) => c.id === callId);
    expect(call).toMatchObject({ sessionId: voiceId, status: 'ended', endReason: 'user', turns: 2 });
  });

  it('traces what each turn remembered: the call after a distilled conversation had its digest', () => {
    const voiceTurns = report.turnTrace.filter((t) => t.sessionId === voiceId);
    expect(voiceTurns).toHaveLength(2);
    const firstText = report.turnTrace.find((t) => t.sessionId === textId && t.ordinal === 1);
    expect(firstText).toMatchObject({ channel: 'text', notebook: expect.any(Boolean) as unknown });
    // The seed's earlier conversations, plus the one distilled before the call.
    expect(voiceTurns[0]).toMatchObject({ channel: 'voice', callId, digests: (firstText?.digests ?? 0) + 1 });
    expect(voiceTurns[0]?.totalMs).toEqual(expect.any(Number));
  });

  it('reports turn statistics, usage, knowledge and audit counts', () => {
    expect(report.turns.map((t) => t.channel).sort()).toEqual(['text', 'voice']);
    expect(report.usage.some((u) => u.purpose === 'turn' && u.calls > 0)).toBe(true);
    expect(report.usage.some((u) => u.purpose === 'distill' && u.calls > 0)).toBe(true);
    const venture = report.ventures.find((v) => v.ventureId === h.ventures.quietquad.id);
    expect(venture?.digests).toBeGreaterThanOrEqual(1);
    expect(venture?.notebooks).toBeGreaterThanOrEqual(1);
    expect(report.audit.some((a) => a.action === 'session.distilled' && a.events >= 1)).toBe(true);
  });

  it('carries no text: no founder words, answers, names or titles, rendered or raw', () => {
    const raw = JSON.stringify(report);
    const markdown = renderReport(report);
    for (const text of [raw, markdown]) {
      expect(text).not.toContain(CANARY);
      expect(text).not.toContain(PRIVATE_CANARY);
      expect(text).not.toContain('QuietQuad');
      expect(text).not.toContain('Maya');
      expect(text).not.toContain('pricing');
    }
  });

  it('scopes to a tenant when asked (Admin → Usage) and to the window', async () => {
    const other = '00000000-0000-4000-8000-0000000000aa';
    const none = await h.t.db.system((sx) =>
      insightsRepo.listConversations(sx, { days: 7, tenantId: other }),
    );
    expect(none).toEqual([]);
    const own = await h.t.db.system((sx) =>
      insightsRepo.listConversations(sx, { days: 7, tenantId: h.seed.tenantId }),
    );
    expect(own.map((c) => c.id)).toEqual(expect.arrayContaining([textId, voiceId, privateId]));
  });
});

describe('export', () => {
  it('seals the content to the operator key; temporary conversations are counted, never exported', async () => {
    const part = InsightsExportPart.parse(await runInsights(deps(), { scope: 'export', days: 7, publicKey }));
    expect(part.nextCursor).toBeNull();
    const sealed = JSON.stringify(part);
    expect(sealed).not.toContain(CANARY);
    expect(sealed).not.toContain(PRIVATE_CANARY);

    const content = open(part.envelope, privatePem) as {
      conversations: { metadata: { id: string }; turns: { founderText: string }[]; calls: unknown[] }[];
      skipped: { private: number };
      shared: { report: unknown; notebooks: unknown[]; memory: unknown[]; audit: unknown[] };
    };
    const ids = content.conversations.map((c) => c.metadata.id);
    expect(ids).toEqual(expect.arrayContaining([textId, voiceId]));
    expect(ids).not.toContain(privateId);
    expect(content.skipped.private).toBeGreaterThanOrEqual(1);
    const plain = JSON.stringify(content);
    expect(plain).toContain(CANARY);
    expect(plain).not.toContain(PRIVATE_CANARY);
    const voice = content.conversations.find((c) => c.metadata.id === voiceId);
    expect(voice?.turns.map((t) => t.founderText)).toEqual([
      'Do you remember what we talked about last time?',
      'Right, the pricing. Let us continue.',
    ]);
    expect(voice?.calls).toHaveLength(1);
    expect(InsightsReport.safeParse(content.shared.report).success).toBe(true);
    expect(content.shared.notebooks.length).toBeGreaterThanOrEqual(1);
    expect(content.shared.audit.length).toBeGreaterThan(0);
  });

  it('pages: a later cursor carries the rest and no shared section', async () => {
    const first = InsightsExportPart.parse(
      await runInsights(deps(), { scope: 'export', days: 7, publicKey, cursor: 1 }),
    );
    const content = open(first.envelope, privatePem) as { conversations: unknown[]; shared: unknown };
    expect(content.shared).toBeNull();
    expect(content.conversations.length).toBe(first.conversations);
  });

  it('refuses a bad request or key with a code only', async () => {
    expect(await runInsights(deps(), { scope: 'export', days: 7, publicKey: 'A'.repeat(100) })).toEqual({
      kind: 'error',
      error: 'invalid_public_key',
    });
    expect(await runInsights(deps(), { scope: 'metadata', days: 0 })).toEqual({
      kind: 'error',
      error: 'invalid_request',
    });
    expect(await runInsights(deps(), { scope: 'metadata', days: 7, sql: 'DELETE FROM turns' })).toEqual({
      kind: 'error',
      error: 'invalid_request',
    });
  });
});

describe('read-only', () => {
  it('a write in the insights transaction is refused by PostgreSQL', async () => {
    const attempt = h.t.db.system(async (sx) => {
      await insightsRepo.beginReadOnly(sx);
      await sx.query('UPDATE coaching_sessions SET title = NULL WHERE id = :id', { id: p.uuid(textId) });
    });
    await expect(attempt).rejects.toBeInstanceOf(DbError);
    await expect(attempt).rejects.toMatchObject({ sqlState: '25006' });
  });
});
