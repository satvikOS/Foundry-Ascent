/**
 * Admin → Usage → Insights: the admin's tenant over the last 30 days, as counts and timings (no content). The
 * reads are the operator insights queries (insightsRepo, read-only transaction); this module turns them into the
 * `AdminInsights` contract.
 */
import { type AdminInsights } from '@foundry/contracts';
import { insightsRepo, type SystemExecutor } from '@foundry/db';
import { type z } from 'zod';

export type AdminInsightsValue = z.infer<typeof AdminInsights>;

/** The window Admin → Usage reports (matches its spend tables). */
export const ADMIN_INSIGHTS_DAYS = 30;

export interface AdminInsightsData {
  readonly conversations: readonly insightsRepo.ConversationInsight[];
  readonly calls: readonly insightsRepo.CallInsight[];
  readonly ventures: readonly insightsRepo.VentureKnowledgeInsight[];
  readonly latency: readonly insightsRepo.TurnLatencyInsight[];
  readonly audit: readonly insightsRepo.AuditCountInsight[];
}

/** Reads everything the summary needs for one tenant (owner role; the caller authorized the admin). */
export async function readAdminInsights(
  sx: SystemExecutor,
  tenantId: string,
  days: number = ADMIN_INSIGHTS_DAYS,
): Promise<AdminInsightsData> {
  await insightsRepo.beginReadOnly(sx);
  const scope = { days, tenantId };
  return {
    conversations: await insightsRepo.listConversations(sx, scope),
    calls: await insightsRepo.listCalls(sx, scope),
    ventures: await insightsRepo.ventureKnowledge(sx, scope),
    latency: await insightsRepo.turnLatency(sx, scope),
    audit: await insightsRepo.auditCounts(sx, scope),
  };
}

const roundOrNull = (value: number | null): number | null => (value === null ? null : Math.round(value));

/** The contract value (pure). */
export function summarizeAdminInsights(
  data: AdminInsightsData,
  days: number = ADMIN_INSIGHTS_DAYS,
): AdminInsightsValue {
  const live = data.conversations.filter((c) => !c.deleted);
  const standard = live.filter((c) => c.privacy === 'standard');
  const conversations = (['text', 'voice'] as const).flatMap((channel) => {
    const list = standard.filter((c) => c.channel === channel);
    if (list.length === 0) return [];
    const turns = list.reduce((sum, c) => sum + c.turns.completed, 0);
    return [
      {
        channel,
        conversations: list.length,
        turns,
        averageTurns: Math.round((turns / list.length) * 10) / 10,
      },
    ];
  });
  const answered = standard.filter((c) => c.turns.completed > 0 && !c.digestDeleted);
  const auditEvents = (action: string): number =>
    data.audit.filter((a) => a.action === action).reduce((sum, a) => sum + a.events, 0);
  return {
    days,
    conversations,
    privateConversations: live.length - standard.length,
    calls: {
      calls: data.calls.length,
      minutes: Math.round(data.calls.reduce((sum, c) => sum + c.seconds, 0) / 6) / 10,
    },
    distillation: {
      upToDate: answered.filter((c) => !c.distillRunning && c.distillVersion >= c.turns.completed).length,
      pending: answered.filter((c) => !c.distillRunning && c.distillVersion < c.turns.completed).length,
      running: answered.filter((c) => c.distillRunning).length,
      dropped: auditEvents('session.distill_dropped'),
      failed: auditEvents('session.distill_failed'),
    },
    memory: data.ventures.map((v) => ({
      ventureId: v.ventureId,
      ventureName: v.ventureName,
      digests: v.digests,
      proposed: v.memory.proposed,
      confirmed: v.memory.confirmed,
      other: v.memory.rejected + v.memory.expired + v.memory.deleted + v.memory.other,
    })),
    latency: data.latency.flatMap((l) =>
      l.channel === 'text' || l.channel === 'voice'
        ? [
            {
              channel: l.channel,
              turns: l.turns,
              p50Ms: roundOrNull(l.totalMsP50),
              p95Ms: roundOrNull(l.totalMsP95),
              firstWordsP50Ms: roundOrNull(l.firstTokenMsP50),
              firstWordsP95Ms: roundOrNull(l.firstTokenMsP95),
            },
          ]
        : [],
    ),
  };
}
