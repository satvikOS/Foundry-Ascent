/**
 * The operator insights job (FoundryAscent-Insights, invoked only by the ops-insights GitHub workflow through
 * its own role): what the platform's conversations, calls, distillation, knowledge and spend look like.
 *
 * - `metadata`: numbers, codes, ids and timings only, validated against {@link InsightsReport} (strict: a
 *   field that could carry text cannot pass), so the workflow may print it in a public log.
 * - `export`: the content of the window's conversations (founder text, validated answers, voice fields,
 *   digests, notebooks, memory, lessons, openers) plus the content-free audit trail, sealed to the operator's
 *   RSA public key before it leaves this function ({@link seal}). Temporary (private) conversations and
 *   deleted ones are counted, never exported.
 *
 * Every read runs in one read-only transaction as the owner role (cross-tenant, like Admin → Usage's
 * aggregates). Logs carry counts and timings only.
 */
import {
  type Db,
  insightsRepo,
  notebooksRepo,
  sessionsRepo,
  type SystemExecutor,
  turnsRepo,
} from '@foundry/db';
import { z } from 'zod';

import { errorFields, type Logger } from '../logging.js';
import { parseRecipientKey, RecipientKeyError, SealedEnvelope, seal } from './insights-envelope.js';

export const MAX_DAYS = insightsRepo.MAX_INSIGHTS_DAYS;

export const InsightsRequest = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('metadata'), days: z.number().int().min(1).max(MAX_DAYS) }).strict(),
  z
    .object({
      scope: z.literal('export'),
      days: z.number().int().min(1).max(MAX_DAYS),
      /** Base64 DER SubjectPublicKeyInfo (or PEM) of the operator's RSA key. */
      publicKey: z.string().min(64).max(8_000),
      /** Index of the first conversation of this part (0 for the first part). */
      cursor: z.number().int().min(0).max(insightsRepo.MAX_INSIGHTS_ROWS).default(0),
    })
    .strict(),
]);
export type InsightsRequest = z.infer<typeof InsightsRequest>;

// ---- The metadata report: nothing in it can hold free text -------------------------------------------------

const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const Iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/);
/** Statuses, reasons, actions, purposes: lower-case codes. */
const Code = z.string().regex(/^[a-z][a-z0-9_.:-]{0,63}$/);
/** Model ids (`us.amazon.nova-2-lite-v1:0`, `polly:neural`, `transcribe:streaming:en-US`). */
const ModelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/);
const Count = z.number().int().min(0);
const Ms = z.number().int().min(0).nullable();

const CODE = /^[a-z][a-z0-9_.:-]{0,63}$/;
/** A stored code as reported: itself when it is a plain code, otherwise `other`. */
export function reportCode(value: string): string;
export function reportCode(value: string | null): string | null;
export function reportCode(value: string | null): string | null {
  if (value === null) return null;
  return CODE.test(value) ? value : 'other';
}

const ConversationRow = z
  .object({
    id: Uuid,
    tenantId: Uuid,
    ventureId: Uuid,
    personaId: Uuid,
    privacy: z.enum(['standard', 'ephemeral']),
    status: Code,
    channel: z.enum(['text', 'voice']),
    startedAt: Iso,
    endedAt: Iso.nullable(),
    lastActivityAt: Iso,
    deleted: z.boolean(),
    turns: z
      .object({ completed: Count, blocked: Count, failed: Count, pending: Count, voice: Count })
      .strict(),
    firstTurnAt: Iso.nullable(),
    lastTurnAt: Iso.nullable(),
    calls: Count,
    distilledAt: Iso.nullable(),
    distillVersion: Count,
    hasDigest: z.boolean(),
    digestDeleted: z.boolean(),
    unusableAnswers: Count,
    distillRunning: z.boolean(),
    hasOpener: z.boolean(),
    openerSourceSessionId: Uuid.nullable(),
    openerByPerson: z.boolean(),
  })
  .strict();

const CallRow = z
  .object({
    id: Uuid,
    sessionId: Uuid,
    ventureId: Uuid,
    status: Code,
    provider: Code,
    inputMode: Code,
    startedAt: Iso,
    endedAt: Iso.nullable(),
    seconds: Count,
    endReason: Code.nullable(),
    endDetail: Code.nullable(),
    lastState: Code.nullable(),
    micOpenSeconds: Count,
    sttGrants: Count,
    speechCharacters: Count,
    firstAudioMsP50: Ms,
    firstAudioMsP95: Ms,
    bargeIns: Count.nullable(),
    reconnects: Count.nullable(),
    turns: Count,
    interruptedTurns: Count,
    speechUnits: Count,
    speechPlays: Count,
    turnLatencyMsP50: Ms,
    turnLatencyMsP95: Ms,
  })
  .strict();

const TurnStatsRow = z
  .object({
    channel: z.enum(['text', 'voice']),
    turns: Count,
    completed: Count,
    blocked: Count,
    failed: Count,
    pending: Count,
    fallbackUsed: Count,
    latencyMsP50: Ms,
    latencyMsP95: Ms,
    firstTokenMsP50: Ms,
    firstTokenMsP95: Ms,
    outputTokensAvg: Count.nullable(),
    answerCharsP50: Count.nullable(),
    answerCharsP95: Count.nullable(),
    spokenCharsP50: Count.nullable(),
    questionMarksPerAnswerX100: Count.nullable(),
    followUpQuestionsAvgX100: Count.nullable(),
    nextActionsAvgX100: Count.nullable(),
    claimsAvgX100: Count.nullable(),
    withChallenge: Count,
    identityViolations: Count,
    crossVentureViolations: Count,
    narrowed: Count,
    escalationForced: Count,
    factsDowngraded: Count,
    evidenceIdsRemoved: Count,
    founderCharsP50: Count.nullable(),
  })
  .strict();

const TurnTraceRow = z
  .object({
    turnId: Uuid,
    sessionId: Uuid,
    callId: Uuid.nullable(),
    at: Iso,
    ordinal: Count,
    outcome: z.enum(['completed', 'blocked']),
    reason: Code.nullable(),
    channel: Code.nullable(),
    notebook: z.boolean().nullable(),
    digests: Count.nullable(),
    openerReplayed: z.boolean().nullable(),
    evidence: Count.nullable(),
    memoryCandidates: Count.nullable(),
    attempts: Count.nullable(),
    fallbackUsed: z.boolean().nullable(),
    inputTokensEstimate: Count.nullable(),
    stream: Code.nullable(),
    totalMs: Ms,
    modelMs: Ms,
    firstTokenMs: Ms,
    modelFirstTokenMs: Ms,
    speechUnits: Count.nullable(),
    gateIdentityRewrites: Count.nullable(),
  })
  .strict();

const VentureRow = z
  .object({
    ventureId: Uuid,
    conversations: Count,
    digests: Count,
    notebooks: Count,
    notebookVersion: Count.nullable(),
    notebookUpdatedAt: Iso.nullable(),
    notebookHasNextOpener: z.boolean(),
    notebookCommitments: Count,
    notebookOpenQuestions: Count,
    notebookProfileLines: Count,
    notebookAdviceLines: Count,
    memory: z
      .object({
        proposed: Count,
        confirmed: Count,
        rejected: Count,
        expired: Count,
        deleted: Count,
        other: Count,
      })
      .strict(),
    memoryFromAi: Count,
    lessonsDrafted: Count,
  })
  .strict();

export const InsightsReport = z
  .object({
    kind: z.literal('metadata'),
    version: z.literal(1),
    generatedAt: Iso,
    days: Count,
    conversations: z.array(ConversationRow),
    calls: z.array(CallRow),
    turns: z.array(TurnStatsRow),
    turnTrace: z.array(TurnTraceRow),
    validatorNotes: z.array(z.object({ code: Code, turns: Count }).strict()),
    ventures: z.array(VentureRow),
    usage: z.array(
      z
        .object({
          purpose: Code,
          modelId: ModelId,
          calls: Count,
          inputTokens: Count,
          outputTokens: Count,
          usd: z.number().min(0),
        })
        .strict(),
    ),
    audit: z.array(
      z.object({ action: Code, outcome: Code, reason: Code.nullable(), events: Count }).strict(),
    ),
  })
  .strict();
export type InsightsReport = z.infer<typeof InsightsReport>;

export const InsightsExportPart = z
  .object({
    kind: z.literal('export'),
    version: z.literal(1),
    generatedAt: Iso,
    days: Count,
    part: Count,
    /** Conversations (with content) in this part. */
    conversations: Count,
    /** Cursor of the next part, or null when this was the last. */
    nextCursor: Count.nullable(),
    envelope: SealedEnvelope,
  })
  .strict();
export type InsightsExportPart = z.infer<typeof InsightsExportPart>;

export const InsightsFailure = z
  .object({ kind: z.literal('error'), error: z.enum(['invalid_request', 'invalid_public_key', 'failed']) })
  .strict();

export const InsightsResponse = z.union([InsightsReport, InsightsExportPart, InsightsFailure]);
export type InsightsResponse = z.infer<typeof InsightsResponse>;

// ---- Building --------------------------------------------------------------------------------------------

/** Rounds `value` to a non-negative integer (aggregates come back as decimals). */
const whole = (value: number): number => Math.max(0, Math.round(value));
const wholeOrNull = (value: number | null): number | null => (value === null ? null : whole(value));

/** The metadata report of the window (read-only executor). */
export async function buildReport(sx: SystemExecutor, days: number, now: Date): Promise<InsightsReport> {
  const scope = { days };
  const conversations = await insightsRepo.listConversations(sx, scope);
  const calls = await insightsRepo.listCalls(sx, scope);
  const turns = await insightsRepo.turnStats(sx, scope);
  const turnTrace = await insightsRepo.turnTrace(sx, scope);
  const validatorNotes = await insightsRepo.validatorNoteCounts(sx, scope);
  const ventures = await insightsRepo.ventureKnowledge(sx, scope);
  const usage = await insightsRepo.usageByPurposeAndModel(sx, scope);
  const audit = await insightsRepo.auditCounts(sx, scope);
  return InsightsReport.parse({
    kind: 'metadata',
    version: 1,
    generatedAt: now.toISOString(),
    days,
    conversations: conversations.map((c) => ({
      ...c,
      status: reportCode(c.status),
    })),
    calls: calls.map((c) => ({
      ...c,
      status: reportCode(c.status),
      provider: reportCode(c.provider),
      inputMode: reportCode(c.inputMode),
      endReason: reportCode(c.endReason),
      endDetail: reportCode(c.endDetail),
      lastState: reportCode(c.lastState),
      seconds: whole(c.seconds),
      speechPlays: whole(c.speechPlays),
    })),
    turns: turns.map((t) => ({
      ...t,
      outputTokensAvg: wholeOrNull(t.outputTokensAvg),
      answerCharsP50: wholeOrNull(t.answerCharsP50),
      answerCharsP95: wholeOrNull(t.answerCharsP95),
      spokenCharsP50: wholeOrNull(t.spokenCharsP50),
      questionMarksPerAnswerX100: wholeOrNull(t.questionMarksPerAnswerX100),
      followUpQuestionsAvgX100: wholeOrNull(t.followUpQuestionsAvgX100),
      nextActionsAvgX100: wholeOrNull(t.nextActionsAvgX100),
      claimsAvgX100: wholeOrNull(t.claimsAvgX100),
      founderCharsP50: wholeOrNull(t.founderCharsP50),
    })),
    turnTrace: turnTrace.map((t) => ({
      ...t,
      digests: wholeOrNull(t.digests),
      evidence: wholeOrNull(t.evidence),
      memoryCandidates: wholeOrNull(t.memoryCandidates),
      attempts: wholeOrNull(t.attempts),
      inputTokensEstimate: wholeOrNull(t.inputTokensEstimate),
      totalMs: wholeOrNull(t.totalMs),
      modelMs: wholeOrNull(t.modelMs),
      firstTokenMs: wholeOrNull(t.firstTokenMs),
      modelFirstTokenMs: wholeOrNull(t.modelFirstTokenMs),
      speechUnits: wholeOrNull(t.speechUnits),
      gateIdentityRewrites: wholeOrNull(t.gateIdentityRewrites),
    })),
    validatorNotes,
    // Venture names never leave in the report: ids only.
    ventures: ventures.map(({ ventureName: _name, ...v }) => v),
    usage: usage.map((u) => ({
      ...u,
      purpose: reportCode(u.purpose),
      modelId: /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(u.modelId) ? u.modelId : 'other',
      inputTokens: whole(u.inputTokens),
      outputTokens: whole(u.outputTokens),
      usd: Math.max(0, Number(u.usd.toFixed(6))),
    })),
    audit: audit.map((a) => ({
      ...a,
      action: reportCode(a.action),
      outcome: reportCode(a.outcome),
      reason: reportCode(a.reason),
    })),
  });
}

/** Conversations per export part at most, and the raw JSON size after which a part closes. */
export const EXPORT_PART_CONVERSATIONS = 25;
export const EXPORT_PART_BYTES = 6_000_000;

export interface ExportPartContent {
  /** The cursor this part starts at. */
  readonly part: number;
  readonly conversations: readonly unknown[];
  readonly skipped: { readonly private: number; readonly deleted: number };
  /** First part only: the report, the audit trail, notebooks, memory and lessons. */
  readonly shared: Record<string, unknown> | null;
  readonly nextCursor: number | null;
}

/** One conversation with its content: the record, turns, voice fields, calls, speech units, continuity. */
async function exportConversation(
  sx: SystemExecutor,
  conversation: insightsRepo.ConversationInsight,
  calls: readonly insightsRepo.CallInsight[],
): Promise<Record<string, unknown>> {
  const record = await sessionsRepo.getDistillState(sx, conversation.id);
  const turns = await turnsRepo.listTurns(sx, conversation.id);
  const voice = await insightsRepo.exportVoiceTurns(sx, conversation.id);
  const own = calls.filter((c) => c.sessionId === conversation.id);
  const speechUnits = await insightsRepo.exportSpeechUnits(
    sx,
    own.map((c) => c.id),
  );
  // What a turn of this conversation would load as "previous conversations" now (ids and dates only: the
  // digests themselves are exported with their own conversations).
  const continuityNow = await sessionsRepo.listRecentDigests(sx, {
    ventureId: conversation.ventureId,
    personaId: conversation.personaId,
    excludeSessionId: conversation.id,
    limit: 3,
  });
  return {
    metadata: conversation,
    record,
    turns,
    voice,
    calls: own,
    speechUnits,
    continuityNow: continuityNow.map((d) => ({
      sessionId: d.sessionId,
      lastActivityAt: d.lastActivityAt,
      hasCalls: d.hasCalls,
    })),
  };
}

/** The shared content of the first part: report, audit trail, notebooks, memory and lessons. */
async function exportShared(
  sx: SystemExecutor,
  days: number,
  now: Date,
  conversations: readonly insightsRepo.ConversationInsight[],
): Promise<Record<string, unknown>> {
  const report = await buildReport(sx, days, now);
  const audit: insightsRepo.AuditEventInsight[] = [];
  for (let page = 0, afterId = 0; page < 20; page += 1) {
    const rows = await insightsRepo.auditEvents(sx, { days, afterId, limit: 500 });
    audit.push(...rows);
    const last = rows.at(-1);
    if (rows.length < 500 || last === undefined) break;
    afterId = last.id;
  }
  const pairs = new Map<string, { ventureId: string; personaId: string }>();
  for (const c of conversations) pairs.set(`${c.ventureId}:${c.personaId}`, c);
  const notebooks = [];
  for (const pair of pairs.values()) {
    notebooks.push({ ...pair, notebook: await notebooksRepo.getNotebook(sx, pair) });
  }
  const ventureIds = [...new Set(conversations.map((c) => c.ventureId))];
  const memory = await insightsRepo.exportMemory(sx, ventureIds);
  const lessons = await insightsRepo.exportLessons(
    sx,
    conversations.map((c) => c.id),
  );
  return { report, audit, notebooks, memory, lessons };
}

/** Builds one export part (read-only executor). */
export async function buildExportPart(
  sx: SystemExecutor,
  args: { readonly days: number; readonly cursor: number; readonly now: Date },
): Promise<ExportPartContent> {
  const all = await insightsRepo.listConversations(sx, { days: args.days });
  const exportable = all.filter((c) => c.privacy === 'standard' && !c.deleted);
  const calls = await insightsRepo.listCalls(sx, { days: args.days });
  const conversations: unknown[] = [];
  let bytes = 0;
  let index = args.cursor;
  while (index < exportable.length && conversations.length < EXPORT_PART_CONVERSATIONS) {
    const conversation = exportable[index];
    if (conversation === undefined) break;
    const entry = await exportConversation(sx, conversation, calls);
    conversations.push(entry);
    index += 1;
    bytes += JSON.stringify(entry).length;
    if (bytes >= EXPORT_PART_BYTES) break;
  }
  return {
    part: args.cursor,
    conversations,
    skipped: {
      private: all.filter((c) => c.privacy !== 'standard').length,
      deleted: all.filter((c) => c.privacy === 'standard' && c.deleted).length,
    },
    shared: args.cursor === 0 ? await exportShared(sx, args.days, args.now, exportable) : null,
    nextCursor: index < exportable.length ? index : null,
  };
}

// ---- The handler logic -----------------------------------------------------------------------------------

export interface InsightsDeps {
  readonly db: Db;
  readonly logger: Logger;
  readonly now?: () => Date;
}

/** How long the job waits for Aurora to resume from auto-pause before the first read. */
export const RESUME_WAIT_MS = 120_000;

/** Runs one insights request. Never throws: failures are returned as an error code (logged by name only). */
export async function runInsights(deps: InsightsDeps, event: unknown): Promise<InsightsResponse> {
  const started = Date.now();
  const parsed = InsightsRequest.safeParse(event);
  if (!parsed.success) {
    deps.logger.warn('insights.invalid_request', {});
    return { kind: 'error', error: 'invalid_request' };
  }
  const request = parsed.data;
  const now = deps.now?.() ?? new Date();
  try {
    await deps.db.ping({ maxWaitMs: RESUME_WAIT_MS });
    if (request.scope === 'metadata') {
      const report = await deps.db.system(async (sx) => {
        await insightsRepo.beginReadOnly(sx);
        return buildReport(sx, request.days, now);
      });
      deps.logger.info('insights.metadata_done', {
        days: request.days,
        conversations: report.conversations.length,
        calls: report.calls.length,
        ms: Date.now() - started,
      });
      return report;
    }
    const recipient = parseRecipientKey(request.publicKey);
    const content = await deps.db.system(async (sx) => {
      await insightsRepo.beginReadOnly(sx);
      return buildExportPart(sx, { days: request.days, cursor: request.cursor, now });
    });
    const envelope = seal(
      { kind: 'insights-export', version: 1, generatedAt: now.toISOString(), days: request.days, ...content },
      recipient,
    );
    deps.logger.info('insights.export_done', {
      days: request.days,
      cursor: request.cursor,
      conversations: content.conversations.length,
      bytes: envelope.data.length,
      ms: Date.now() - started,
    });
    return InsightsExportPart.parse({
      kind: 'export',
      version: 1,
      generatedAt: now.toISOString(),
      days: request.days,
      part: content.part,
      conversations: content.conversations.length,
      nextCursor: content.nextCursor,
      envelope,
    });
  } catch (err) {
    if (err instanceof RecipientKeyError) {
      deps.logger.warn('insights.invalid_public_key', {});
      return { kind: 'error', error: 'invalid_public_key' };
    }
    deps.logger.error('insights.failed', { scope: request.scope, ...errorFields(err) });
    return { kind: 'error', error: 'failed' };
  }
}
