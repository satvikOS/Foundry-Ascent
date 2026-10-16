import { AdminInsights } from '@foundry/contracts';
import { type insightsRepo } from '@foundry/db';
import { describe, expect, it } from 'vitest';

import { summarizeAdminInsights, type AdminInsightsData } from './insights.js';

const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function conversation(
  n: number,
  overrides: Partial<insightsRepo.ConversationInsight> = {},
): insightsRepo.ConversationInsight {
  return {
    id: ID(n),
    tenantId: ID(900),
    ventureId: ID(800),
    personaId: ID(700),
    privacy: 'standard',
    status: 'active',
    channel: 'text',
    startedAt: '2026-10-10T10:00:00.000Z',
    endedAt: null,
    lastActivityAt: '2026-10-10T10:10:00.000Z',
    deleted: false,
    turns: { completed: 4, blocked: 0, failed: 0, pending: 0, voice: 0 },
    firstTurnAt: null,
    lastTurnAt: null,
    calls: 0,
    distilledAt: null,
    distillVersion: 0,
    hasDigest: false,
    digestDeleted: false,
    unusableAnswers: 0,
    distillRunning: false,
    hasOpener: false,
    openerSourceSessionId: null,
    openerByPerson: false,
    ...overrides,
  };
}

const DATA: AdminInsightsData = {
  conversations: [
    conversation(1, { distilledAt: '2026-10-10T10:20:00.000Z', distillVersion: 4, hasDigest: true }),
    conversation(2, {
      channel: 'voice',
      turns: { completed: 6, blocked: 0, failed: 0, pending: 0, voice: 6 },
    }),
    conversation(3, { distillRunning: true }),
    conversation(4, { privacy: 'ephemeral' }),
    conversation(5, { deleted: true }),
    conversation(6, { turns: { completed: 0, blocked: 1, failed: 0, pending: 0, voice: 0 } }),
  ],
  calls: [{ seconds: 600 } as insightsRepo.CallInsight, { seconds: 90 } as insightsRepo.CallInsight],
  ventures: [
    {
      ventureId: ID(800),
      ventureName: 'QuietQuad',
      conversations: 3,
      digests: 1,
      notebooks: 1,
      notebookVersion: 2,
      notebookUpdatedAt: null,
      notebookHasNextOpener: true,
      notebookCommitments: 1,
      notebookOpenQuestions: 0,
      notebookProfileLines: 0,
      notebookAdviceLines: 0,
      memory: { proposed: 3, confirmed: 2, rejected: 1, expired: 1, deleted: 0, other: 1 },
      memoryFromAi: 4,
      lessonsDrafted: 0,
    },
  ],
  latency: [
    {
      channel: 'text',
      turns: 10,
      totalMsP50: 4200.4,
      totalMsP95: 9000.6,
      firstTokenMsP50: null,
      firstTokenMsP95: null,
    },
    { channel: 'other', turns: 1, totalMsP50: 1, totalMsP95: 1, firstTokenMsP50: 1, firstTokenMsP95: 1 },
  ],
  audit: [
    { action: 'session.distill_failed', outcome: 'failed', reason: 'invalid_schema', events: 2 },
    { action: 'session.distill_dropped', outcome: 'blocked', reason: 'no_content', events: 1 },
    { action: 'session.distill_dropped', outcome: 'blocked', reason: 'persona_inactive', events: 1 },
  ],
};

describe('summarizeAdminInsights', () => {
  it('counts standard conversations by channel, private ones apart, deleted ones never', () => {
    const value = AdminInsights.parse(summarizeAdminInsights(DATA));
    expect(value.conversations).toEqual([
      { channel: 'text', conversations: 3, turns: 8, averageTurns: 2.7 },
      { channel: 'voice', conversations: 1, turns: 6, averageTurns: 6 },
    ]);
    expect(value.privateConversations).toBe(1);
    expect(value.calls).toEqual({ calls: 2, minutes: 11.5 });
  });

  it('places each answered conversation once in the distillation health, and counts recorded outcomes', () => {
    const { distillation } = summarizeAdminInsights(DATA);
    expect(distillation).toEqual({ upToDate: 1, pending: 1, running: 1, dropped: 2, failed: 2 });
  });

  it('reports memory per venture and rounded latency for chat and calls only', () => {
    const value = summarizeAdminInsights(DATA);
    expect(value.memory).toEqual([
      { ventureId: ID(800), ventureName: 'QuietQuad', digests: 1, proposed: 3, confirmed: 2, other: 3 },
    ]);
    expect(value.latency).toEqual([
      { channel: 'text', turns: 10, p50Ms: 4200, p95Ms: 9001, firstWordsP50Ms: null, firstWordsP95Ms: null },
    ]);
  });
});
