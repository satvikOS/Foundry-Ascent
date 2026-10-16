import {
  DISTILL_LIMITS,
  DISTILL_SCHEMA_NAME,
  DistillDraft,
  MAX_DISTILL_TURNS,
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
  NotebookIntegrityError,
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
  type SqlExecutor,
  type SystemExecutor,
} from '@foundry/db';

import { type RequestContext } from '../context.js';
import { isDomainError } from '../errors.js';
import { type DirectoryCache, type OtherVentures, type TenantDirectory } from '../internal/directory.js';
import { memoryEmbeddingText } from '../internal/embeddings.js';
import { type Kit } from '../internal/kit.js';
import { meteredEmbed, meteredStructured } from '../internal/metered.js';
import { assertWithinSpendCaps } from '../orchestrator/guards.js';
import {
  distillSkipReason,
  dropSuppressed,
  filenameWords,
  humanAdviceIds,
  keepHumanAdvice,
  withoutAdviceRewrites,
  modelFailure,
  personaCanDistill,
  previousNeedsDistill,
  removedSince,
  sameNotebook,
  staleWriteReason,
} from './distill-rules.js';
import { proposeMemoryCandidates } from './memory.js';

/**
 * Distillation: how a vEIR's specific pool grows from conversations (docs/architecture/knowledge-pools.md).
 * One structured model call per part of a conversation (purpose `distill`, metered within the spend caps,
 * skipped while the kill switch is off): the earliest completed turns no digest covers yet, at most
 * MAX_DISTILL_TURNS, with the digest of the turns before them, so a long conversation is distilled whole and
 * the digest only ever covers turns the model saw. Each part produces, after `sanitizeDistill`:
 *
 * - the conversation's digest and an improved title;
 * - the vEIR notebook, merged with what is there and keeping every line a person edited since the last
 *   distillation, never writing back a line a person removed or corrected;
 * - memory candidates, deduplicated against the venture's memory and proposed for a person to approve;
 * - de-identified lesson candidates, drafted in the persona's common pool for its curators to review.
 *
 * Everything of a part is written in one transaction, idempotently per (conversation, covered-turn count), and
 * only one run per conversation calls the model at a time (a claim taken before the call). A job distils up to
 * four parts while time and the caps allow; the rest waits for the next trigger or the backstop. Nothing is distilled
 * for a persona that is no longer active or whose EIR's consent is not in force. Audit events and logs carry
 * ids, counts and codes only.
 *
 * Triggers (the API calls them after the change commits): every completed turn of a standard conversation
 * queues a job delayed by `turnDelaySeconds`; ending a conversation queues one now; starting a conversation
 * queues the person's previous one when it was never distilled. Each job carries the turn count it was queued
 * at, and skips cheaply when a later turn queued another, when there is nothing new or when the conversation
 * is still active. A bounded backstop (daily maintenance, and the `distill_sweep` message) distils idle
 * conversations that slipped through, inline: the worker never enqueues.
 */
export interface DistillService {
  /** After a completed turn: queues the conversation's distillation, delayed (standard conversations). */
  afterTurn(ctx: RequestContext, sessionId: string): Promise<void>;
  /** After a conversation ended: queues its distillation now. */
  afterEnd(ctx: RequestContext, sessionId: string): Promise<void>;
  /** After a conversation started: queues the person's previous conversation when it is undistilled and idle. */
  afterCreate(ctx: RequestContext, session: Pick<SessionView, 'id' | 'ventureId'>): Promise<void>;
  /**
   * Distils one conversation (worker, owner role). Throws {@link RetryableDistillError} for failures worth
   * another delivery and lets database errors through (the queue retries both); every other outcome is
   * returned.
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
  /** Completed turns when the job was queued; a conversation with more by now is left to the later job. */
  readonly queuedTurns?: number;
}

export interface DistillRunOptions {
  /** Epoch ms by which the call must be over (Lambda remaining time); the model call is cancelled then. */
  readonly deadline?: number;
  /**
   * Delivery attempt of a queued job (1-based) and the queue's maximum. An invalid or refused model answer is
   * tried once more through the queue before it is recorded; inline runs (the backstop) record it at once.
   */
  readonly attempt?: number;
  readonly maxAttempts?: number;
}

export interface DistillOutcome {
  readonly sessionId: string;
  /**
   * `distilled`: written. `skipped`: nothing to do now (see `reason`), retried by a later trigger.
   * `dropped`: nothing worth keeping, the result was blocked, or there is no active persona to distil for;
   * recorded so it is not retried until a new turn. `failed`: the model gave no usable answer; recorded the
   * same way.
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

/** A failure worth another delivery (the model unavailable or out of time, a notebook racing): retried. */
export class RetryableDistillError extends Error {
  override readonly name = 'RetryableDistillError';

  constructor(readonly code: string) {
    super(`distillation failed transiently (${code})`);
  }
}

/** Time a distillation needs to start (model call with its fallback, plus the writes). */
const MIN_DISTILL_BUDGET_MS = 45_000;
/** Margin kept before a deadline: the model call is cancelled this long before it. */
const DEADLINE_MARGIN_MS = 5_000;
/** How long a run without a deadline holds its claim on the conversation (a run with one: past it). */
const DEFAULT_CLAIM_SECONDS = 600;
const CLAIM_MARGIN_SECONDS = 30;
const MAX_CLAIM_SECONDS = 1_800;
/** Runs of one job when another distillation of the same notebook wrote meanwhile (each calls the model). */
const NOTEBOOK_ROUNDS = 2;
/**
 * Parts of one conversation a job distils (each part is at most MAX_DISTILL_TURNS turns and one model call);
 * the rest stays undistilled for the next trigger or the backstop.
 */
const MAX_PARTS_PER_JOB = 4;
/** Notebook writes retried on a concurrent edit before the notebook is left for the next distillation. */
const NOTEBOOK_WRITE_ATTEMPTS = 3;
/** Evidence keys a distillation prompt may carry (the conversation's unique evidence, re-keyed E1…). */
const MAX_SESSION_EVIDENCE = 20;
/** Terms a lesson must never mention: the venture's relationships (customers, labs, sponsors) and documents. */
const DENYLIST_MAX = 100;
/** Pending AI proposals without an embedding that one distillation embeds before deduplicating. */
const PENDING_EMBED_LIMIT = 20;
/** Lesson `source_class` of distilled drafts. */
const DISTILLED_SOURCE_CLASS = 'conversation';
/** Lessons a new draft is compared with: everything curators kept or turned down. */
const LESSON_DEDUPE_STATUSES = ['draft', 'in_review', 'published', 'withdrawn'] as const;

/** Everything one distillation reads before its model call (owner role). */
interface DistillSource {
  readonly venture: venturesRepo.VentureRecord;
  readonly persona: personasRepo.PersonaRecord;
  readonly consent: personasRepo.ConsentRecord | null;
  readonly release: personasRepo.PersonaReleaseRecord;
  readonly eirName: string | null;
  readonly founderFirstName: string | null;
  /** Completed turns the distillation reads (crisis turns left out). */
  readonly turns: readonly turnsRepo.TurnRecord[];
  /** Every turn of the conversation: memory proposals drawn from any of them belong to it. */
  readonly turnIds: readonly string[];
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

/** Vectors for deduplication: one per memory candidate, and the pending proposals embedded with them. */
interface DedupeVectors {
  readonly candidates?: (readonly number[] | null)[];
  readonly proposals: { readonly id: string; readonly embedding: readonly number[] }[];
}

type WriteResult =
  | { readonly kind: 'stale'; readonly reason: string }
  | { readonly kind: 'notebook_changed' }
  | { readonly kind: 'recorded'; readonly outcome: DistillOutcome }
  | {
      readonly kind: 'written';
      readonly notebookVersion: number | null;
      readonly memory: { readonly created: number; readonly repeated: number };
      readonly lessonsDrafted: number;
    };

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

/** How long a run holds its claim: past its deadline, so a claim never lapses while its run can still write. */
function claimSeconds(deadline: number | undefined): number {
  if (deadline === undefined) return DEFAULT_CLAIM_SECONDS;
  const remaining = Math.ceil((deadline - Date.now()) / 1000) + CLAIM_MARGIN_SECONDS;
  return Math.min(MAX_CLAIM_SECONDS, Math.max(CLAIM_MARGIN_SECONDS, remaining));
}

export function createDistillService(kit: Kit, directory: DirectoryCache): DistillService {
  const { logger } = kit.deps;
  const cfg = kit.config.distillation;

  async function enqueue(
    session: Pick<sessionsRepo.SessionRecord, 'id' | 'tenantId' | 'ventureId'>,
    turns: number,
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
        turns,
        requestId,
      },
      delaySeconds > 0 ? { delaySeconds } : {},
    );
    logger.info('distill.enqueued', { requestId, sessionId: session.id, trigger, turns, delaySeconds });
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

  /** A standard conversation and its completed turns (the caller's view), or null for any other. */
  async function standardSession(
    ctx: RequestContext,
    sessionId: string,
  ): Promise<{ session: sessionsRepo.SessionRecord; turns: number } | null> {
    return kit.inRequest(ctx, async ({ tx }) => {
      const session = await sessionsRepo.getSession(tx, sessionId);
      if (session?.privacy !== 'standard') return null;
      return { session, turns: await sessionsRepo.countCompletedTurns(tx, sessionId) };
    });
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
    const consent = persona.consentId === null ? null : await personasRepo.getConsent(sx, persona.consentId);
    const eir =
      persona.kind === 'eir_persona' && persona.eirProfileId !== null
        ? await eirRepo.getEirProfile(sx, persona.eirProfileId)
        : null;
    const founder = await principalsRepo.getPrincipal(sx, state.startedBy);
    const allTurns = await turnsRepo.listTurns(sx, state.id);
    // Crisis turns never feed notes, memory or lessons (their titles are never derived either).
    const turns = allTurns.filter((t) => t.status === 'completed' && t.riskLabel !== 'crisis');
    const byTurn = await turnsRepo.listTurnEvidence(
      sx,
      turns.map((t) => t.id),
    );
    const scope = { ventureId: venture.id, personaId: persona.id };
    const notebook = await notebooksRepo.getNotebook(sx, scope);
    const marks = await notebooksRepo.getNotebookMarks(sx, scope);
    const relationships = await memoryRepo.listMemory(sx, {
      ventureId: venture.id,
      types: ['relationship'],
      limit: DENYLIST_MAX,
      excerptChars: 0,
    });
    const lessons = await resourcesRepo.listLessons(sx, {
      tenantId: state.tenantId,
      personaId: persona.id,
      statuses: LESSON_DEDUPE_STATUSES,
    });
    const documents = await documentsRepo.listDocuments(sx, venture.id);
    return {
      venture,
      persona,
      consent,
      release,
      eirName: eir?.displayName ?? null,
      founderFirstName: firstName(founder?.displayName),
      turns,
      turnIds: allTurns.map((t) => t.id),
      evidence: sessionEvidence(turns, byTurn),
      notebook,
      pins: marks.personEdits,
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

  /**
   * Embeds the memory candidates, and the venture's pending AI proposals that have no vector yet (turns
   * propose without one), in one metered call, so a candidate restating a proposal in other words is
   * recognised. Best effort: without vectors, deduplication is lexical only.
   */
  async function dedupeVectors(
    ctx: RequestContext,
    ventureId: string,
    result: SanitizedDistill,
  ): Promise<DedupeVectors> {
    const candidates = result.memoryCandidates;
    if (candidates.length === 0) return { proposals: [] };
    try {
      const pending = await kit.system(
        (sx) => memoryRepo.listUnembeddedAiProposals(sx, { ventureId, limit: PENDING_EMBED_LIMIT }),
        { transaction: false },
      );
      const embedded = await meteredEmbed(kit, { ctx, ventureId, purpose: 'embedding' }, [
        ...candidates.map(memoryEmbeddingText),
        ...pending.map(memoryEmbeddingText),
      ]);
      const vector = (i: number): number[] | null => {
        const v = embedded.vectors[i];
        return v?.length === knowledgeRepo.EMBEDDING_DIMENSIONS ? v : null;
      };
      return {
        candidates: candidates.map((_, i) => vector(i)),
        proposals: pending.flatMap((item, j) => {
          const embedding = vector(candidates.length + j);
          return embedding === null ? [] : [{ id: item.id, embedding }];
        }),
      };
    } catch (err) {
      logger.warn('distill.embedding_deferred', {
        requestId: ctx.requestId,
        candidates: candidates.length,
        error: err instanceof Error ? err.name : 'unknown',
      });
      return { proposals: [] };
    }
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

  /**
   * Records an outcome that produced nothing to write (dropped or failed) in `sx`, so the conversation is not
   * retried until a new turn, with an audit event (ids and codes only).
   */
  async function recordWithoutDigestIn(
    sx: SqlExecutor,
    state: sessionsRepo.DistillState,
    requestId: string,
    outcome: 'dropped' | 'failed',
    reason: string,
    upTo: number = state.completedTurns,
  ): Promise<DistillOutcome> {
    await sessionsRepo.markSessionDistilled(sx, { sessionId: state.id, distillVersion: upTo });
    await auditRepo.appendAudit(sx, {
      action: outcome === 'failed' ? 'session.distill_failed' : 'session.distill_dropped',
      outcome: outcome === 'failed' ? 'failed' : 'blocked',
      tenantId: state.tenantId,
      ventureId: state.ventureId,
      objectType: 'session',
      objectId: state.id,
      requestId,
      policyReason: reason,
      metadata: { turns: upTo, personaId: state.personaId },
    });
    logger.info('distill.recorded', { requestId, sessionId: state.id, outcome, reason, turns: upTo });
    return { ...empty(state.id, outcome, reason), turns: upTo };
  }

  /**
   * Records an outcome without a digest. `upTo` (default: every completed turn) is how many turns it covers:
   * a part of the conversation that failed or was blocked is recorded alone, the parts after it stay to do.
   */
  function recordWithoutDigest(
    state: sessionsRepo.DistillState,
    requestId: string,
    outcome: 'dropped' | 'failed',
    reason: string,
    upTo?: number,
  ): Promise<DistillOutcome> {
    return kit.system((sx) => recordWithoutDigestIn(sx, state, requestId, outcome, reason, upTo));
  }

  /**
   * One run over the next part of the conversation: the earliest completed turns no digest covers yet, at
   * most MAX_DISTILL_TURNS, with the digest of the turns before them. Read, call the model, write; the digest
   * then covers exactly the turns the model saw (`distill_version` never runs ahead of them). Returns
   * `notebook_changed` (nothing written) when another distillation wrote the persona's notebook since it was
   * read: merging over it would take that run's rewordings for removals, so the caller runs again on the new
   * notebook.
   */
  async function runOnce(
    state: sessionsRepo.DistillState,
    ctx: RequestContext,
    requestId: string,
    options: DistillRunOptions,
  ): Promise<DistillOutcome | 'notebook_changed'> {
    const sessionId = state.id;
    const source = await kit.system((sx) => loadSource(sx, state), { transaction: false });
    if (source === null) return recordWithoutDigest(state, requestId, 'dropped', 'context_unavailable');
    if (!personaCanDistill(source.persona, source.consent, kit.now())) {
      return recordWithoutDigest(state, requestId, 'dropped', 'persona_inactive');
    }
    if (source.turns.length === 0) return recordWithoutDigest(state, requestId, 'dropped', 'no_content');
    // The part this run distils: what earlier runs covered stays summarised by the digest they wrote.
    const covered = Math.min(state.distillVersion, source.turns.length, state.completedTurns);
    const part = source.turns.slice(covered, Math.min(state.completedTurns, covered + MAX_DISTILL_TURNS));
    if (part.length === 0) return recordWithoutDigest(state, requestId, 'dropped', 'no_content');

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
      turns: part.map((t) => ({
        founderText: t.founderText,
        answer: t.response?.answer ?? null,
        channel: t.channel,
      })),
      earlierTurns: covered,
      previousDigest: covered > 0 ? state.digest : null,
      evidence: [...source.evidence.values()],
      previousNotebook: source.notebook
        ? { ...source.notebook.content, updatedAt: source.notebook.updatedAt }
        : null,
      today: now.toISOString().slice(0, 10),
    });
    // The turns the model sees; the digest written from its answer covers no more than these.
    const upTo = covered + prompt.turnsShown;
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
      if (!isModelGatewayError(err)) throw err;
      const failure = modelFailure(err, options.attempt ?? 1, options.maxAttempts ?? 1);
      if (failure === null) throw new RetryableDistillError(err.code);
      return recordWithoutDigest(state, requestId, 'failed', failure, upTo);
    }

    const nowIso = now.toISOString();
    const readContent = source.notebook?.content ?? null;
    const readVersion = source.notebook?.version ?? 0;
    const sanitizeFor = (
      notebook: notebooksRepo.NotebookContent | null,
      pins: readonly string[],
      removed: readonly string[],
    ): SanitizedDistill | null =>
      // sanitizeDistill drops rewrites of lines a person edited (pinned); human-help advice is kept as the EIR
      // wrote it (keepHumanAdvice), so the model cannot reword it either.
      sanitizeDistill(
        withoutAdviceRewrites(draft, new Set(humanAdviceIds(notebook))),
        sanitizeContext(state, source, nowIso, notebook, pins, removed),
      );
    const result = sanitizeFor(readContent, source.pins, []);
    if (result === null) return recordWithoutDigest(state, requestId, 'dropped', 'cross_venture', upTo);
    const vectors = await dedupeVectors(ctx, state.ventureId, result);

    const written = await kit.system(async (sx): Promise<WriteResult> => {
      const locked = await sessionsRepo.getDistillState(sx, sessionId, { lock: true });
      const stale = staleWriteReason(locked, upTo);
      if (stale !== null) return { kind: 'stale', reason: stale };
      // Consent revoked or the persona suspended while the model was answering: nothing is written for it.
      const persona = await personasRepo.getPersona(sx, state.personaId);
      if (persona?.status !== 'active') {
        return {
          kind: 'recorded',
          outcome: await recordWithoutDigestIn(sx, state, requestId, 'dropped', 'persona_inactive'),
        };
      }

      // The notebook first, written against the version read; a person's edit in between is merged, not lost.
      const scope = { ventureId: state.ventureId, personaId: state.personaId };
      let notebookVersion: number | null = null;
      let notebookIntact = true;
      let suppressedDropped = 0;
      for (let attempt = 0; attempt < NOTEBOOK_WRITE_ATTEMPTS && notebookVersion === null; attempt += 1) {
        const current = await notebooksRepo.getNotebook(sx, scope);
        // A notebook that cannot be read in full is never written over (its salvaged lines would replace
        // what could not be read); the digest, memory and lessons are still written.
        if (current !== null && !current.intact) {
          notebookIntact = false;
          break;
        }
        const marks = await notebooksRepo.getNotebookMarks(sx, scope);
        if (marks.veirVersion > readVersion) return { kind: 'notebook_changed' };
        const version = current?.version ?? 0;
        const base = version === readVersion ? readContent : (current?.content ?? null);
        const pins = version === readVersion ? source.pins : marks.personEdits;
        // Only people wrote since the read (a distillation would have bumped `veirVersion`): what changed
        // was removed or corrected by them.
        const merged =
          version === readVersion ? result : sanitizeFor(base, pins, removedSince(readContent, base));
        if (merged === null) break;
        const delta = {
          ...merged.notebookDelta,
          lastAdvice: keepHumanAdvice(
            merged.notebookDelta.lastAdvice,
            base?.lastAdvice ?? [],
            new Set(pins),
            DISTILL_LIMITS.lastAdviceMax,
          ),
        };
        const filtered = dropSuppressed(delta, current?.suppressed ?? []);
        suppressedDropped = filtered.dropped;
        if (sameNotebook(current?.content ?? notebooksRepo.EMPTY_NOTEBOOK, filtered.content)) {
          notebookVersion = version;
          break;
        }
        let saved: notebooksRepo.NotebookRecord | null;
        try {
          saved = await notebooksRepo.saveNotebook(sx, {
            tenantId: state.tenantId,
            ...scope,
            expectedVersion: version,
            content: filtered.content,
            suppressed: current?.suppressed ?? [],
            editedBy: 'veir',
            principalId: null,
            // The summary and opener drawn here record this conversation, so deleting it erases them (and
            // deleting another conversation does not).
            sourceSessionId: sessionId,
          });
        } catch (err) {
          // Permanent (the stored notebook is damaged): neither retried nor overwritten. It is thrown after a
          // successful read, so the transaction stays usable.
          if (!(err instanceof NotebookIntegrityError)) throw err;
          notebookIntact = false;
          break;
        }
        notebookVersion = saved?.version ?? null;
      }
      if (!notebookIntact) {
        logger.warn('distill.notebook_unreadable', { requestId, sessionId, personaId: state.personaId });
      }

      await sessionsRepo.setSessionDigest(sx, {
        sessionId,
        digest: result.digest,
        distillVersion: upTo,
        title: result.title,
      });

      // Vectors of pending proposals first, so candidates are compared with them by meaning.
      if (vectors.proposals.length > 0) await knowledgeRepo.setMemoryEmbeddings(sx, vectors.proposals);
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
        conversation: {
          sourceIds: new Set([sessionId, ...source.turnIds]),
          speakers: source.founderFirstName === null ? [] : [source.founderFirstName],
        },
        ...(vectors.candidates ? { embeddings: vectors.candidates } : {}),
      });

      const titles = [...source.lessonTitles];
      const lessonIds: string[] = [];
      let lessonsDuplicate = 0;
      for (const lesson of result.lessonCandidates) {
        if (titles.some((t) => isNearDuplicate(t, lesson.title))) {
          lessonsDuplicate += 1;
          continue;
        }
        const pattern = await resourcesRepo.createPattern(sx, {
          tenantId: state.tenantId,
          personaId: state.personaId,
          origin: 'distilled',
          status: 'draft',
          ownerId: null,
          sourceClass: DISTILLED_SOURCE_CLASS,
          sourceSessionId: sessionId,
          ...lesson,
        });
        titles.push(lesson.title);
        lessonIds.push(pattern.id);
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
          turns: upTo,
          fromTurn: covered + 1,
          personaId: state.personaId,
          titled: result.title !== null,
          notebookVersion,
          notebookIntact,
          pinnedKept: result.stats.pinnedKept,
          suppressedDropped: result.stats.suppressedDropped + suppressedDropped,
          duplicatesDropped: result.stats.duplicatesDropped,
          identityRewrites: result.stats.identityRewrites,
          memoryProposed: memory.created,
          memoryRepeated: memory.repeated,
          memoryDropped: memory.dropped + result.stats.memoryCandidatesDropped,
          proposalsEmbedded: vectors.proposals.length,
          lessonsDrafted: lessonIds.length,
          lessonIds,
          lessonsDropped: result.stats.lessonCandidatesDropped + lessonsDuplicate,
          lessonDropReasons: result.stats.lessonDropReasons,
        },
      });
      return { kind: 'written', notebookVersion, memory, lessonsDrafted: lessonIds.length };
    });

    if (written.kind === 'notebook_changed') return 'notebook_changed';
    if (written.kind === 'recorded') return written.outcome;
    if (written.kind === 'stale') {
      logger.info('distill.skipped', { requestId, sessionId, reason: written.reason });
      return empty(sessionId, 'skipped', written.reason);
    }
    logger.info('distill.done', {
      requestId,
      sessionId,
      turns: upTo,
      notebookVersion: written.notebookVersion,
      memoryProposed: written.memory.created,
      memoryRepeated: written.memory.repeated,
      lessonsDrafted: written.lessonsDrafted,
    });
    return {
      sessionId,
      status: 'distilled',
      reason: null,
      turns: upTo,
      notebookVersion: written.notebookVersion,
      memoryProposed: written.memory.created,
      memoryRepeated: written.memory.repeated,
      lessonsDrafted: written.lessonsDrafted,
    };
  }

  async function distillSession(
    job: DistillJobInput,
    options: DistillRunOptions = {},
  ): Promise<DistillOutcome> {
    const { sessionId, requestId } = job;
    const skipped = (reason: string): DistillOutcome => {
      logger.info('distill.skipped', { requestId, sessionId, reason });
      return empty(sessionId, 'skipped', reason);
    };
    const state = await kit.system((sx) => sessionsRepo.getDistillState(sx, sessionId), {
      transaction: false,
    });
    const skip = distillSkipReason(state, kit.now(), cfg.activeWindowSeconds, job.queuedTurns);
    if (state === null || skip !== null) return skipped(skip ?? 'not_found');
    const settings = await kit.system((sx) => settingsRepo.getPlatformSettings(sx), { transaction: false });
    if (!settings.aiEnabled) return skipped('kill_switch');
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
      if (isDomainError(err) && err.code === 'spend_cap_reached') return skipped('spend_cap');
      throw err;
    }

    // One run per conversation calls the model: overlapping jobs (a turn's, the end's, the backstop) skip.
    const claimId = kit.deps.ids.uuid();
    const claimed = await kit.system(
      (sx) =>
        sessionsRepo.claimDistillation(sx, {
          sessionId,
          claimId,
          turns: state.completedTurns,
          seconds: claimSeconds(options.deadline),
        }),
      { transaction: false },
    );
    if (!claimed) return skipped('in_progress');
    const late = (): boolean =>
      options.deadline !== undefined && options.deadline - Date.now() < MIN_DISTILL_BUDGET_MS;
    /** One part, run again on the new notebook when another distillation wrote it meanwhile. */
    const runPart = async (current: sessionsRepo.DistillState): Promise<DistillOutcome> => {
      for (let round = 1; ; round += 1) {
        const outcome = await runOnce(current, ctx, requestId, options);
        if (outcome !== 'notebook_changed') return outcome;
        if (round >= NOTEBOOK_ROUNDS || late()) throw new RetryableDistillError('notebook_changed');
        logger.info('distill.notebook_changed', { requestId, sessionId, round });
      }
    };
    /** Whether the job may distil another part: still allowed, still within the caps, time left. */
    const mayContinue = async (part: number): Promise<boolean> => {
      if (part >= MAX_PARTS_PER_JOB || late()) return false;
      const now = await kit.system((sx) => settingsRepo.getPlatformSettings(sx), { transaction: false });
      if (!now.aiEnabled) return false;
      try {
        await assertWithinSpendCaps(kit, ctx, now, { ventureId: state.ventureId, operation: 'distill' });
      } catch (err) {
        if (isDomainError(err) && err.code === 'spend_cap_reached') return false;
        throw err;
      }
      return true;
    };
    try {
      // A long conversation is distilled in parts, oldest first; each covers only the turns its model call saw.
      let current = state;
      let total: DistillOutcome | null = null;
      for (let part = 1; ; part += 1) {
        const outcome = await runPart(current);
        total =
          total === null
            ? outcome
            : {
                ...outcome,
                notebookVersion: outcome.notebookVersion ?? total.notebookVersion,
                memoryProposed: total.memoryProposed + outcome.memoryProposed,
                memoryRepeated: total.memoryRepeated + outcome.memoryRepeated,
                lessonsDrafted: total.lessonsDrafted + outcome.lessonsDrafted,
              };
        if (outcome.status !== 'distilled' || outcome.turns >= current.completedTurns) return total;
        if (!(await mayContinue(part))) {
          logger.info('distill.parts_left', { requestId, sessionId, turns: outcome.turns, parts: part });
          return total;
        }
        const next = await kit.system((sx) => sessionsRepo.getDistillState(sx, sessionId), {
          transaction: false,
        });
        if (next === null || distillSkipReason(next, kit.now(), cfg.activeWindowSeconds) !== null)
          return total;
        current = next;
      }
    } finally {
      try {
        await kit.system((sx) => sessionsRepo.releaseDistillClaim(sx, { sessionId, claimId }), {
          transaction: false,
        });
      } catch (err) {
        // The claim lapses on its own; a later job waits for it at most until then.
        logger.warn('distill.release_failed', {
          requestId,
          sessionId,
          error: err instanceof Error ? err.name : 'unknown',
        });
      }
    }
  }

  return {
    afterTurn: (ctx, sessionId) =>
      trigger(ctx, sessionId, 'turn', async () => {
        const found = await standardSession(ctx, sessionId);
        if (found !== null) {
          await enqueue(found.session, found.turns, ctx.requestId, cfg.turnDelaySeconds, 'turn');
        }
      }),

    afterEnd: (ctx, sessionId) =>
      trigger(ctx, sessionId, 'end', async () => {
        const found = await standardSession(ctx, sessionId);
        if (found !== null) await enqueue(found.session, found.turns, ctx.requestId, 0, 'end');
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
          previous.completedTurns,
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
