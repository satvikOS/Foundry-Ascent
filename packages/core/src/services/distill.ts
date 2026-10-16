import {
  DISTILL_SCHEMA_NAME,
  DistillDraft,
  NOTEBOOK_OPENER_PIN,
  NOTEBOOK_SUMMARY_PIN,
  buildDistillPrompt,
  isModelGatewayError,
  isNearDuplicate,
  sanitizeDistill,
  type DistillSanitizeContext,
  type SanitizedDistill,
} from '@foundry/ai';
import { type EvidenceItem, type SessionView } from '@foundry/contracts';
import {
  auditRepo,
  documentsRepo,
  eirRepo,
  knowledgeRepo,
  memoryRepo,
  notebooksRepo,
  personasRepo,
  principalsRepo,
  resourcesRepo,
  sessionsRepo,
  settingsRepo,
  turnsRepo,
  venturesRepo,
  type SystemExecutor,
} from '@foundry/db';

import { type RequestContext } from '../context.js';
import { isDomainError } from '../errors.js';
import { type DirectoryCache, type OtherVentures, type TenantDirectory } from '../internal/directory.js';
import { memoryEmbeddingText } from '../internal/embeddings.js';
import { type Kit } from '../internal/kit.js';
import { meteredStructured } from '../internal/metered.js';
import { assertWithinSpendCaps } from '../orchestrator/guards.js';
import {
  distillSkipReason,
  dropSuppressed,
  filenameWords,
  previousNeedsDistill,
  removedSince,
  sameNotebook,
  staleWriteReason,
  withoutPinnedRewrites,
} from './distill-rules.js';
import { proposeMemoryCandidates } from './memory.js';

/**
 * Distillation: how a vEIR's specific pool grows from conversations (docs/architecture/knowledge-pools.md).
 * One structured model call per conversation version (purpose `distill`, metered within the spend caps,
 * skipped while the kill switch is off) produces, after `sanitizeDistill`:
 *
 * - the conversation's digest and an improved title;
 * - the vEIR notebook, merged with what is there and keeping every line a person edited since the last
 *   distillation, never writing back a line a person removed or corrected;
 * - memory candidates, deduplicated against the venture's memory and proposed for a person to approve;
 * - de-identified lesson candidates, drafted in the persona's common pool for its curators to review.
 *
 * Everything is written in one transaction, idempotently per (conversation, completed-turn count). Audit
 * events and logs carry ids, counts and codes only.
 *
 * Triggers (the API calls them after the change commits): every completed turn of a standard conversation
 * queues a job delayed by `turnDelaySeconds`; ending a conversation queues one now; starting a conversation
 * queues the person's previous one when it was never distilled. A queued job skips cheaply when there is
 * nothing new or the conversation is still active. A bounded backstop (daily maintenance, and the
 * `distill_sweep` message) distils idle conversations that slipped through, inline: the worker never enqueues.
 */
export interface DistillService {
  /** After a completed turn: queues the conversation's distillation, delayed (standard conversations). */
  afterTurn(ctx: RequestContext, sessionId: string): Promise<void>;
  /** After a conversation ended: queues its distillation now. */
  afterEnd(ctx: RequestContext, sessionId: string): Promise<void>;
  /** After a conversation started: queues the person's previous conversation when it is undistilled and idle. */
  afterCreate(ctx: RequestContext, session: Pick<SessionView, 'id' | 'ventureId'>): Promise<void>;
  /**
   * Distils one conversation (worker, owner role). Throws {@link RetryableDistillError} for transient model
   * failures and lets database errors through (the queue retries both); every other outcome is returned.
   */
  distillSession(job: DistillJobInput, options?: DistillRunOptions): Promise<DistillOutcome>;
  /**
   * The backstop: distils up to `backstopBatch` standard conversations that are idle (or ended) and have
   * turns no digest covers, oldest first, while the deadline leaves time for another one.
   */
  backstop(options: {
    readonly requestId: string;
    readonly deadline?: number;
  }): Promise<DistillBackstopReport>;
}

export interface DistillJobInput {
  readonly sessionId: string;
  readonly requestId: string;
}

export interface DistillRunOptions {
  /** Epoch ms by which the call must be over (Lambda remaining time); the model call is cancelled then. */
  readonly deadline?: number;
}

export interface DistillOutcome {
  readonly sessionId: string;
  /**
   * `distilled`: written. `skipped`: nothing to do now (see `reason`), retried by a later trigger.
   * `dropped`: nothing worth keeping, or the result was blocked; recorded so it is not retried until a new
   * turn. `failed`: the model gave no usable answer; recorded the same way.
   */
  readonly status: 'distilled' | 'skipped' | 'dropped' | 'failed';
  /** Skip, drop or failure code; null when distilled. */
  readonly reason: string | null;
  /** Completed turns the distillation covers (0 when skipped early). */
  readonly turns: number;
  readonly notebookVersion: number | null;
  readonly memoryProposed: number;
  readonly memoryRepeated: number;
  readonly lessonsDrafted: number;
}

export interface DistillBackstopReport {
  readonly candidates: number;
  readonly distilled: number;
  readonly skipped: number;
  readonly dropped: number;
  readonly failed: number;
  /** Candidates left for a later run because the deadline was near. */
  readonly deferred: number;
}

/** A transient failure (the model was unavailable, throttled or timed out): the queue retries the job. */
export class RetryableDistillError extends Error {
  override readonly name = 'RetryableDistillError';

  constructor(readonly code: string) {
    super(`distillation failed transiently (${code})`);
  }
}

/** Time a distillation needs to start (model call with its fallback, plus the writes). */
export const MIN_DISTILL_BUDGET_MS = 45_000;
/** Margin kept before a deadline: the model call is cancelled this long before it. */
const DEADLINE_MARGIN_MS = 5_000;
/** Notebook writes retried on a concurrent edit before the notebook is left for the next distillation. */
const NOTEBOOK_WRITE_ATTEMPTS = 3;
/** Evidence keys a distillation prompt may carry (the conversation's unique evidence, re-keyed E1…). */
const MAX_SESSION_EVIDENCE = 20;
/** Terms a lesson must never mention: the venture's relationships (customers, labs, sponsors) and documents. */
const DENYLIST_MAX = 100;
/** Lesson `source_class` of distilled drafts. */
const DISTILLED_SOURCE_CLASS = 'conversation';

/** Everything one distillation reads before its model call (owner role). */
interface DistillSource {
  readonly venture: venturesRepo.VentureRecord;
  readonly persona: personasRepo.PersonaRecord;
  readonly release: personasRepo.PersonaReleaseRecord;
  readonly eirName: string | null;
  readonly founderFirstName: string | null;
  readonly turns: readonly turnsRepo.TurnRecord[];
  readonly evidence: ReadonlyMap<string, EvidenceItem>;
  readonly notebook: notebooksRepo.NotebookRecord | null;
  readonly pins: readonly string[];
  /** Titles of the venture's relationship memory (customers, labs, sponsors, partners). */
  readonly relationships: readonly string[];
  readonly lessonTitles: readonly string[];
  readonly documentNames: readonly string[];
  readonly directory: TenantDirectory;
  readonly others: OtherVentures;
}

function pinKey(edit: string): string {
  if (edit === notebooksRepo.SUMMARY_EDIT) return NOTEBOOK_SUMMARY_PIN;
  if (edit === notebooksRepo.OPENER_EDIT) return NOTEBOOK_OPENER_PIN;
  return edit;
}

function firstName(displayName: string | null | undefined): string | null {
  const first = displayName?.trim().split(/\s+/)[0];
  return first === undefined || first === '' ? null : first;
}

/** The conversation's evidence, unique by reference, re-keyed E1…En in turn order (like the recap). */
function sessionEvidence(
  turns: readonly turnsRepo.TurnRecord[],
  byTurn: ReadonlyMap<string, readonly EvidenceItem[]>,
): Map<string, EvidenceItem> {
  const evidence = new Map<string, EvidenceItem>();
  const seen = new Set<string>();
  for (const turn of turns) {
    for (const item of byTurn.get(turn.id) ?? []) {
      const ref = `${item.kind}:${item.refId}`;
      if (seen.has(ref) || evidence.size >= MAX_SESSION_EVIDENCE) continue;
      seen.add(ref);
      const key = `E${evidence.size + 1}`;
      evidence.set(key, { ...item, key });
    }
  }
  return evidence;
}

export function createDistillService(kit: Kit, directory: DirectoryCache): DistillService {
  const { logger } = kit.deps;
  const cfg = kit.config.distillation;

  async function enqueue(
    session: Pick<sessionsRepo.SessionRecord, 'id' | 'tenantId' | 'ventureId'>,
    requestId: string,
    delaySeconds: number,
    trigger: 'turn' | 'end' | 'next_conversation',
  ): Promise<void> {
    await kit.deps.jobQueue.enqueue(
      {
        type: 'distill_session',
        sessionId: session.id,
        tenantId: session.tenantId,
        ventureId: session.ventureId,
        requestId,
      },
      delaySeconds > 0 ? { delaySeconds } : {},
    );
    logger.info('distill.enqueued', { requestId, sessionId: session.id, trigger, delaySeconds });
  }

  /** Triggers never fail the request they follow: a lost job is caught by the backstop. */
  async function trigger(
    ctx: RequestContext,
    sessionId: string,
    name: 'turn' | 'end' | 'next_conversation',
    run: () => Promise<void>,
  ): Promise<void> {
    try {
      await run();
    } catch (err) {
      logger.warn('distill.enqueue_failed', {
        requestId: ctx.requestId,
        sessionId,
        trigger: name,
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  async function standardSession(
    ctx: RequestContext,
    sessionId: string,
  ): Promise<sessionsRepo.SessionRecord | null> {
    const session = await kit.inRequest(ctx, ({ tx }) => sessionsRepo.getSession(tx, sessionId));
    return session?.privacy === 'standard' ? session : null;
  }

  async function loadSource(
    sx: SystemExecutor,
    state: sessionsRepo.DistillState,
  ): Promise<DistillSource | null> {
    const [venture, release, persona] = await Promise.all([
      venturesRepo.getVenture(sx, state.ventureId),
      personasRepo.getRelease(sx, state.personaReleaseId),
      personasRepo.getPersona(sx, state.personaId),
    ]);
    if (venture === null || release === null || persona === null) return null;
    const eir =
      persona.kind === 'eir_persona' && persona.eirProfileId !== null
        ? await eirRepo.getEirProfile(sx, persona.eirProfileId)
        : null;
    const founder = await principalsRepo.getPrincipal(sx, state.startedBy);
    // Crisis turns never feed notes, memory or lessons (their titles are never derived either).
    const turns = (await turnsRepo.listTurns(sx, state.id)).filter(
      (t) => t.status === 'completed' && t.riskLabel !== 'crisis',
    );
    const byTurn = await turnsRepo.listTurnEvidence(
      sx,
      turns.map((t) => t.id),
    );
    const notebook = await notebooksRepo.getNotebook(sx, { ventureId: venture.id, personaId: persona.id });
    const pins = notebook
      ? await notebooksRepo.getPersonEdits(sx, { ventureId: venture.id, personaId: persona.id })
      : [];
    const relationships = await memoryRepo.listMemory(sx, {
      ventureId: venture.id,
      types: ['relationship'],
      limit: DENYLIST_MAX,
      excerptChars: 0,
    });
    const lessons = await resourcesRepo.listLessons(sx, {
      tenantId: state.tenantId,
      personaId: persona.id,
      statuses: ['draft', 'in_review', 'published'],
    });
    const documents = await documentsRepo.listDocuments(sx, venture.id);
    return {
      venture,
      persona,
      release,
      eirName: eir?.displayName ?? null,
      founderFirstName: firstName(founder?.displayName),
      turns,
      evidence: sessionEvidence(turns, byTurn),
      notebook,
      pins,
      relationships: relationships.map((m) => m.title),
      lessonTitles: lessons.map((l) => l.title),
      documentNames: documents.map((d) => filenameWords(d.filename)).filter((n) => n !== ''),
      directory: await directory.get(state.tenantId),
      others: await directory.others(state.tenantId, venture.id),
    };
  }

  /** The sanitize context for one notebook state (the one the model saw, or a newer one after an edit). */
  function sanitizeContext(
    state: sessionsRepo.DistillState,
    source: DistillSource,
    now: string,
    notebook: notebooksRepo.NotebookContent | null,
    pins: readonly string[],
    removed: readonly string[],
  ): DistillSanitizeContext {
    const own = source.directory.ventures.find((v) => v.id === source.venture.id);
    return {
      sessionId: state.id,
      now,
      personaName: source.persona.name,
      eirNames: source.directory.eirNames,
      personaEirName: source.eirName,
      previousNotebook: notebook,
      suppressed: removed,
      pinnedEntryIds: pins.map(pinKey),
      evidenceKeys: source.evidence.keys(),
      // Memory candidates are deduplicated when they are proposed (proposeMemoryCandidates): by content, and
      // a repeat raises the pending proposal again instead of being dropped here by its title.
      otherVentureNames: source.others.names,
      otherVentureCanaries: source.others.canaries,
      otherVentureMemberNames: source.others.memberNames,
      lessons: {
        ventureNames: [source.venture.name],
        personNames: own?.memberNames ?? [],
        canaries: own ? [own.canary] : [],
        // Customers, labs, sponsors and places the venture works with, and its documents' names.
        denylist: [...source.relationships, ...source.documentNames].slice(0, DENYLIST_MAX),
        allowedTerms: source.release.doctrine.frameworks.map((f) => f.name),
      },
    };
  }

  /** Embeds the memory candidates (best effort: without vectors, deduplication is lexical only). */
  async function embedCandidates(
    ctx: RequestContext,
    ventureId: string,
    result: SanitizedDistill,
  ): Promise<(readonly number[] | null)[] | undefined> {
    if (result.memoryCandidates.length === 0) return undefined;
    try {
      const embedded = await kit.deps.gateway.embed(result.memoryCandidates.map(memoryEmbeddingText), {
        purpose: 'embedding',
        requestId: ctx.requestId,
      });
      await kit.recordUsage({
        ctx,
        ventureId,
        purpose: 'embedding',
        attempts: [{ modelId: embedded.modelId, usage: embedded.usage, costUsd: embedded.costUsd }],
      });
      return result.memoryCandidates.map((_, i) => {
        const vector = embedded.vectors[i];
        return vector?.length === knowledgeRepo.EMBEDDING_DIMENSIONS ? vector : null;
      });
    } catch (err) {
      logger.warn('distill.embedding_deferred', {
        requestId: ctx.requestId,
        candidates: result.memoryCandidates.length,
        error: err instanceof Error ? err.name : 'unknown',
      });
      return undefined;
    }
  }

  /**
   * Records an outcome that produced nothing to write (dropped or failed), so the conversation is not
   * retried until a new turn, with an audit event (ids and codes only).
   */
  async function recordWithoutDigest(
    state: sessionsRepo.DistillState,
    requestId: string,
    outcome: 'dropped' | 'failed',
    reason: string,
  ): Promise<DistillOutcome> {
    await kit.system(async (sx) => {
      await sessionsRepo.markSessionDistilled(sx, {
        sessionId: state.id,
        distillVersion: state.completedTurns,
      });
      await auditRepo.appendAudit(sx, {
        action: outcome === 'failed' ? 'session.distill_failed' : 'session.distill_dropped',
        outcome: outcome === 'failed' ? 'failed' : 'blocked',
        tenantId: state.tenantId,
        ventureId: state.ventureId,
        objectType: 'session',
        objectId: state.id,
        requestId,
        policyReason: reason,
        metadata: { turns: state.completedTurns, personaId: state.personaId },
      });
    });
    logger.info('distill.recorded', { requestId, sessionId: state.id, outcome, reason });
    return { ...empty(state.id, outcome, reason), turns: state.completedTurns };
  }

  function empty(sessionId: string, status: DistillOutcome['status'], reason: string | null): DistillOutcome {
    return {
      sessionId,
      status,
      reason,
      turns: 0,
      notebookVersion: null,
      memoryProposed: 0,
      memoryRepeated: 0,
      lessonsDrafted: 0,
    };
  }

  async function distillSession(
    job: DistillJobInput,
    options: DistillRunOptions = {},
  ): Promise<DistillOutcome> {
    const { sessionId, requestId } = job;
    const state = await kit.system((sx) => sessionsRepo.getDistillState(sx, sessionId), {
      transaction: false,
    });
    const skip = distillSkipReason(state, kit.now(), cfg.activeWindowSeconds);
    if (state === null || skip !== null) {
      logger.info('distill.skipped', { requestId, sessionId, reason: skip ?? 'not_found' });
      return empty(sessionId, 'skipped', skip ?? 'not_found');
    }
    const settings = await kit.system((sx) => settingsRepo.getPlatformSettings(sx), { transaction: false });
    if (!settings.aiEnabled) {
      logger.info('distill.skipped', { requestId, sessionId, reason: 'kill_switch' });
      return empty(sessionId, 'skipped', 'kill_switch');
    }
    // Billed to the person whose conversation it is, within the daily caps like their turns.
    const ctx: RequestContext = {
      principalId: state.startedBy,
      tenantId: state.tenantId,
      roles: [],
      requestId,
    };
    try {
      await assertWithinSpendCaps(kit, ctx, settings, { ventureId: state.ventureId, operation: 'distill' });
    } catch (err) {
      if (isDomainError(err) && err.code === 'spend_cap_reached') {
        logger.info('distill.skipped', { requestId, sessionId, reason: 'spend_cap' });
        return empty(sessionId, 'skipped', 'spend_cap');
      }
      throw err;
    }

    const source = await kit.system((sx) => loadSource(sx, state), { transaction: false });
    if (source === null) {
      logger.warn('distill.context_unavailable', { requestId, sessionId });
      return empty(sessionId, 'skipped', 'context_unavailable');
    }
    if (source.turns.length === 0) return recordWithoutDigest(state, requestId, 'dropped', 'no_content');

    const now = kit.now();
    const prompt = buildDistillPrompt({
      personaName: source.persona.name,
      eirName: source.eirName,
      founderFirstName: source.founderFirstName,
      venture: {
        name: source.venture.name,
        stage: source.venture.stage,
        domain: source.venture.domain,
        currentGoal: source.venture.currentGoal,
      },
      sessionGoal: state.goal,
      turns: source.turns.map((t) => ({
        founderText: t.founderText,
        answer: t.response?.answer ?? null,
        channel: t.channel,
      })),
      evidence: [...source.evidence.values()],
      previousNotebook: source.notebook
        ? { ...source.notebook.content, updatedAt: source.notebook.updatedAt }
        : null,
      today: now.toISOString().slice(0, 10),
    });
    const remaining =
      options.deadline === undefined ? null : options.deadline - Date.now() - DEADLINE_MARGIN_MS;
    let draft: DistillDraft;
    try {
      const result = await meteredStructured(
        kit,
        { ctx, ventureId: state.ventureId, purpose: 'distill' },
        {
          system: prompt.system,
          messages: prompt.messages,
          schemaName: DISTILL_SCHEMA_NAME,
          zodSchema: DistillDraft,
          timeoutMs: kit.config.turns.modelTimeoutMs,
          ...(remaining === null ? {} : { signal: AbortSignal.timeout(Math.max(1_000, remaining)) }),
        },
      );
      draft = result.value;
    } catch (err) {
      if (isModelGatewayError(err)) {
        // Unavailable, throttled, timed out or cancelled at the deadline: worth retrying later.
        if (err.code === 'model_unavailable') throw new RetryableDistillError(err.code);
        return recordWithoutDigest(state, requestId, 'failed', err.code);
      }
      throw err;
    }

    const nowIso = now.toISOString();
    const readContent = source.notebook?.content ?? null;
    const sanitizeFor = (
      notebook: notebooksRepo.NotebookContent | null,
      pins: readonly string[],
      removed: readonly string[],
    ): SanitizedDistill | null =>
      sanitizeDistill(
        withoutPinnedRewrites(draft, new Set(pins)),
        sanitizeContext(state, source, nowIso, notebook, pins, removed),
      );
    const result = sanitizeFor(readContent, source.pins, []);
    if (result === null) return recordWithoutDigest(state, requestId, 'dropped', 'cross_venture');
    const embeddings = await embedCandidates(ctx, state.ventureId, result);

    const written = await kit.system(async (sx) => {
      const locked = await sessionsRepo.getDistillState(sx, sessionId, { lock: true });
      const stale = staleWriteReason(locked, state.completedTurns);
      if (stale !== null) return { kind: 'stale' as const, reason: stale };
      await sessionsRepo.setSessionDigest(sx, {
        sessionId,
        digest: result.digest,
        distillVersion: state.completedTurns,
        title: result.title,
      });

      // The notebook, written against the version read; a person's edit in between is merged, not lost.
      const scope = { ventureId: state.ventureId, personaId: state.personaId };
      let notebookVersion: number | null = null;
      let suppressedDropped = 0;
      for (let attempt = 0; attempt < NOTEBOOK_WRITE_ATTEMPTS && notebookVersion === null; attempt += 1) {
        const current = await notebooksRepo.getNotebook(sx, scope);
        const version = current?.version ?? 0;
        const merged =
          version === (source.notebook?.version ?? 0)
            ? result
            : sanitizeFor(
                current?.content ?? null,
                await notebooksRepo.getPersonEdits(sx, scope),
                removedSince(readContent, current?.content ?? null),
              );
        if (merged === null) break;
        const filtered = dropSuppressed(merged.notebookDelta, current?.suppressed ?? []);
        suppressedDropped = filtered.dropped;
        if (sameNotebook(current?.content ?? notebooksRepo.EMPTY_NOTEBOOK, filtered.content)) {
          notebookVersion = version;
          break;
        }
        const saved = await notebooksRepo.saveNotebook(sx, {
          tenantId: state.tenantId,
          ...scope,
          expectedVersion: version,
          content: filtered.content,
          suppressed: current?.suppressed ?? [],
          editedBy: 'veir',
          principalId: null,
        });
        notebookVersion = saved?.version ?? null;
      }

      const memory = await proposeMemoryCandidates(sx, {
        tenantId: state.tenantId,
        ventureId: state.ventureId,
        createdBy: state.startedBy,
        candidates: result.memoryCandidates,
        evidence: source.evidence,
        source: { kind: 'session', id: sessionId },
        // Conversation evidence never cites a founder_private item (retrieval and the turn_evidence policy
        // exclude them), so these are team items, like a recap's.
        visibility: 'team',
        ...(embeddings ? { embeddings } : {}),
      });

      const titles = [...source.lessonTitles];
      let lessonsDrafted = 0;
      let lessonsDuplicate = 0;
      for (const lesson of result.lessonCandidates) {
        if (titles.some((t) => isNearDuplicate(t, lesson.title))) {
          lessonsDuplicate += 1;
          continue;
        }
        await resourcesRepo.createPattern(sx, {
          tenantId: state.tenantId,
          personaId: state.personaId,
          origin: 'distilled',
          status: 'draft',
          ownerId: null,
          sourceClass: DISTILLED_SOURCE_CLASS,
          ...lesson,
        });
        titles.push(lesson.title);
        lessonsDrafted += 1;
      }

      await auditRepo.appendAudit(sx, {
        action: 'session.distilled',
        outcome: 'succeeded',
        tenantId: state.tenantId,
        ventureId: state.ventureId,
        objectType: 'session',
        objectId: sessionId,
        requestId,
        metadata: {
          turns: state.completedTurns,
          personaId: state.personaId,
          titled: result.title !== null,
          notebookVersion,
          pinnedKept: result.stats.pinnedKept,
          suppressedDropped: result.stats.suppressedDropped + suppressedDropped,
          duplicatesDropped: result.stats.duplicatesDropped,
          identityRewrites: result.stats.identityRewrites,
          memoryProposed: memory.created,
          memoryRepeated: memory.repeated,
          memoryDropped: memory.dropped + result.stats.memoryCandidatesDropped,
          lessonsDrafted,
          lessonsDropped: result.stats.lessonCandidatesDropped + lessonsDuplicate,
          lessonDropReasons: result.stats.lessonDropReasons,
        },
      });
      return { kind: 'written' as const, notebookVersion, memory, lessonsDrafted };
    });

    if (written.kind === 'stale') {
      logger.info('distill.skipped', { requestId, sessionId, reason: written.reason });
      return empty(sessionId, 'skipped', written.reason);
    }
    logger.info('distill.done', {
      requestId,
      sessionId,
      turns: state.completedTurns,
      notebookVersion: written.notebookVersion,
      memoryProposed: written.memory.created,
      memoryRepeated: written.memory.repeated,
      lessonsDrafted: written.lessonsDrafted,
    });
    return {
      sessionId,
      status: 'distilled',
      reason: null,
      turns: state.completedTurns,
      notebookVersion: written.notebookVersion,
      memoryProposed: written.memory.created,
      memoryRepeated: written.memory.repeated,
      lessonsDrafted: written.lessonsDrafted,
    };
  }

  return {
    afterTurn: (ctx, sessionId) =>
      trigger(ctx, sessionId, 'turn', async () => {
        const session = await standardSession(ctx, sessionId);
        if (session !== null) await enqueue(session, ctx.requestId, cfg.turnDelaySeconds, 'turn');
      }),

    afterEnd: (ctx, sessionId) =>
      trigger(ctx, sessionId, 'end', async () => {
        const session = await standardSession(ctx, sessionId);
        if (session !== null) await enqueue(session, ctx.requestId, 0, 'end');
      }),

    afterCreate: (ctx, created) =>
      trigger(ctx, created.id, 'next_conversation', async () => {
        const previous = await kit.inRequest(ctx, ({ tx }) =>
          sessionsRepo.getPreviousConversation(tx, {
            ventureId: created.ventureId,
            startedBy: ctx.principalId,
            excludeSessionId: created.id,
          }),
        );
        if (previous === null || !previousNeedsDistill(previous, kit.now(), cfg.activeWindowSeconds)) return;
        await enqueue(
          { id: previous.id, tenantId: ctx.tenantId, ventureId: created.ventureId },
          ctx.requestId,
          0,
          'next_conversation',
        );
      }),

    distillSession,

    backstop: async ({ requestId, deadline }) => {
      const report = { candidates: 0, distilled: 0, skipped: 0, dropped: 0, failed: 0, deferred: 0 };
      const settings = await kit.system((sx) => settingsRepo.getPlatformSettings(sx), { transaction: false });
      if (!settings.aiEnabled) return report;
      const candidates = await kit.system(
        (sx) =>
          sessionsRepo.listDistillationCandidates(sx, {
            idleSeconds: cfg.activeWindowSeconds,
            limit: cfg.backstopBatch,
          }),
        { transaction: false },
      );
      report.candidates = candidates.length;
      for (const [index, candidate] of candidates.entries()) {
        if (deadline !== undefined && deadline - Date.now() < MIN_DISTILL_BUDGET_MS) {
          report.deferred = candidates.length - index;
          break;
        }
        try {
          const outcome = await distillSession(
            { sessionId: candidate.sessionId, requestId },
            deadline === undefined ? {} : { deadline },
          );
          report[outcome.status] += 1;
        } catch (err) {
          report.failed += 1;
          logger.warn('distill.backstop_failed', {
            requestId,
            sessionId: candidate.sessionId,
            error: err instanceof Error ? err.name : 'unknown',
          });
        }
      }
      logger.info('distill.backstop_done', { requestId, ...report });
      return report;
    },
  };
}
