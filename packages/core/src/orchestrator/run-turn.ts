import {
  CRISIS_SPOKEN_MESSAGE,
  CRISIS_SUPPORT_MESSAGE,
  POLICY_VERSION,
  SPOKEN_NARROWING_CAVEAT,
  buildCrisisResponse,
  buildRetrievalQuery,
  classifyRisk,
  deriveSpoken,
  riskLabel,
  type HistoryTurn,
  type ModelAttempt,
  type RiskClassification,
} from '@foundry/ai';
import {
  CreateTurnRequest,
  type CoachMode,
  type PlatformSettingsView,
  type TurnBlockedDetail,
  type TurnChannel,
  type TurnStreamEvent,
  type TurnView,
  type ValidatorResults,
} from '@foundry/contracts';
import {
  callsRepo,
  escalationsRepo,
  knowledgeRepo,
  personasRepo,
  sessionsRepo,
  settingsRepo,
  turnsRepo,
  venturesRepo,
} from '@foundry/db';
import type { z } from 'zod';

import { PlatformKeyCache } from '../auth/keys.js';
import { type SessionSigningKey } from '../auth/session-token.js';
import {
  requireAssignmentActive,
  requireVentureAccess,
  type ActiveAssignment,
} from '../authz/venture-access.js';
import { type RequestContext } from '../context.js';
import { DomainError, fail, isDomainError, parseInput, toDomainError } from '../errors.js';
import { type DirectoryCache, type OtherVentures } from '../internal/directory.js';
import { audit, requireId, type Kit, type RequestScope } from '../internal/kit.js';
import {
  admitVoiceTurn as callsAdmission,
  isLiveCallOf,
  type AdmitVoiceTurn,
} from '../services/call-admission.js';
import { memoryEmbeddingText } from '../internal/embeddings.js';
import { meteredEmbed } from '../internal/metered.js';
import { createDraftEscalation } from '../services/escalations.js';
import { persistMemoryCandidates } from '../services/memory.js';
import { conversationGrounding } from '../services/memory-dedupe.js';
import { historyAsHeard } from '../services/spoken-text.js';
import { answerTurn, generationError } from './answer.js';
import { blockedDetailOf, participantRiskLabel, participantTurnView, supportMessageFor } from './blocked.js';
import { leftOffThreads, loadContinuity, loadLeftOff, type LoadedContinuity } from './continuity.js';
import { renderLeftOffSection, type LeftOffData } from './continuity-prompt.js';
import { candidateVisibility } from './evidence.js';
import { generationTotals, SpeechStream } from './generate.js';
import { assertWithinSpendCaps } from './guards.js';
import { embedRetrievalQuery, privateRetrievalOwner, retrieveEvidence } from './retrieval.js';
import { secondsUntilUtcMidnight, shouldSampleForReview } from './sampling.js';

export { enforceGateBlock } from './answer.js';

/**
 * POST /sessions/:id/turns body. `expectedOrdinal` (the client's retry key) is part of the contract: when
 * a turn with this ordinal already exists for the same author and text, it is replayed from storage
 * instead of re-running. Without `mode`, the model picks the mode within the allowed ones (auto mode),
 * except that a `rehearsalCounterpart` asks for a rehearsal.
 */
export const RunTurnInput = CreateTurnRequest;
export type RunTurnInput = z.input<typeof RunTurnInput>;

/** Receives the SSE events in order; may be async (back-pressure). Errors stop further emission only. */
export type TurnEmitter = (event: TurnStreamEvent) => void | Promise<void>;

export interface RunTurnOptions {
  /** Client disconnect / Lambda deadline. Cancels the model call (no fallback) and fails the turn. */
  readonly signal?: AbortSignal;
}

export interface RunTurnOutcome {
  /**
   * `rejected`: refused before acceptance (first event is `turn.error` with turnId null; the API may map
   * `error` to a plain problem+json response). `completed` / `blocked` / `failed` after acceptance.
   */
  readonly status: 'completed' | 'blocked' | 'failed' | 'rejected';
  readonly turnId: string | null;
  /** True when the turn was answered from storage (idempotent retry). */
  readonly replayed: boolean;
  readonly error: DomainError | null;
}

export interface Orchestrator {
  /**
   * Runs one coaching turn (system design §7 steps 1–7) and emits `turn.accepted` → `turn.status`
   * (classifying, retrieving, reasoning, validating) → exactly one of `turn.completed`, `turn.blocked`,
   * `turn.error`. With streaming on, validated `turn.delta` units of the answer (and, on a call, signed
   * `turn.speech` units) come before the terminal event, which stays authoritative. Never throws for domain
   * failures: they are emitted (and returned in the outcome).
   */
  runTurn(
    ctx: RequestContext,
    sessionId: string,
    input: RunTurnInput,
    emit: TurnEmitter,
    options?: RunTurnOptions,
  ): Promise<RunTurnOutcome>;
}

export interface OrchestratorOptions {
  /** Admission of spoken turns (the calls service); replaceable in tests. */
  readonly admitVoiceTurn?: AdmitVoiceTurn;
  /** Key source for signed speech units; default the platform session-signing key. */
  readonly speechKeys?: { signingKey(): Promise<SessionSigningKey> };
}

const SAFE_INTERNAL = (cause: unknown): DomainError =>
  new DomainError('internal', 'Something went wrong while answering. Please try again.', {
    cause,
    reason: 'internal',
  });

function asDomainError(err: unknown): DomainError {
  const mapped = toDomainError(err);
  return isDomainError(mapped) ? mapped : SAFE_INTERNAL(err);
}

/**
 * `turn.error` for a domain error. Every event names the request (`requestId`, for support); a known wait
 * (`retryAfterSeconds`, e.g. a replayed turn that is still being answered) makes it retryable.
 */
export function errorEvent(
  turnId: string | null,
  error: DomainError,
  requestId: string,
): Extract<TurnStreamEvent, { event: 'turn.error' }> {
  return {
    event: 'turn.error',
    turnId,
    code: error.code,
    message: error.message,
    retryable: error.retryable || error.retryAfterSeconds !== undefined,
    ...(error.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: Math.max(1, Math.ceil(error.retryAfterSeconds)) }),
    requestId,
  };
}

interface Proceed {
  readonly kind: 'proceed';
  readonly session: sessionsRepo.SessionRecord;
  readonly settings: PlatformSettingsView;
  /** Null only on the crisis path, which makes no model call and needs no coach. */
  readonly active: ActiveAssignment | null;
  /** The fixed mode of this turn, or null when the model picks one (auto mode). */
  readonly mode: CoachMode | null;
  /** The mode the turn is created with (the fixed mode, else the conversation's current one). */
  readonly turnMode: CoachMode;
  readonly channel: TurnChannel;
  readonly venture: venturesRepo.VentureRecord;
  /** The coach of this turn (null on the crisis path). */
  readonly coach: Coach | null;
}

/** Everything the model call needs about who answers and what they remember (non-crisis turns). */
interface Coach {
  /** The conversation's release (or, when that was withdrawn, the current approved one). */
  readonly release: personasRepo.PersonaReleaseRecord;
  /** Modes allowed by both the assignment and that release. */
  readonly allowedModes: readonly CoachMode[];
  readonly personaEirName: string | null;
  /** Earlier completed turns, oldest first (at most `historyTurns`). */
  readonly history: readonly turnsRepo.TurnRecord[];
  /**
   * The same turns as the founder heard them: a reply they spoke over during a call is replayed as the
   * verified words they heard, or left out when they heard none of it (docs/architecture/calls.md §2.6).
   */
  readonly heardHistory: readonly HistoryTurn[];
  /** The stored opener, when the history reaches back to the start of the conversation. */
  readonly opener: string | null;
  readonly memory: LoadedContinuity;
}

interface Replay {
  readonly kind: 'replay';
  readonly turn: turnsRepo.TurnRecord;
  readonly view: TurnView;
  readonly escalationId: string | null;
}

/** How long a turn waits for its memory candidates' vectors before keeping them without (lexical dedupe). */
const CANDIDATE_EMBED_TIMEOUT_MS = 2_000;

export function createOrchestrator(
  kit: Kit,
  directory: DirectoryCache,
  options: OrchestratorOptions = {},
): Orchestrator {
  const cfg = kit.config;
  const { logger } = kit.deps;
  const admitVoiceTurn = options.admitVoiceTurn ?? callsAdmission;
  const speechKeys =
    options.speechKeys ??
    new PlatformKeyCache(kit, Math.max(cfg.session.keyGraceSeconds, cfg.session.ttlSeconds));

  function safeEmitter(emit: TurnEmitter, requestId: string): (event: TurnStreamEvent) => Promise<void> {
    let broken = false;
    return async (event) => {
      if (broken) return;
      try {
        await emit(event);
      } catch (err) {
        broken = true;
        logger.warn('turn.emit_failed', {
          requestId,
          event: event.event,
          error: err instanceof Error ? err.name : 'unknown',
        });
      }
    };
  }

  /**
   * Vectors of a turn's memory candidates (one metered call), so they are deduplicated by meaning before they are
   * kept and found by meaning later. Best effort and bounded: without them (a failure, or slower than
   * {@link CANDIDATE_EMBED_TIMEOUT_MS}), deduplication is lexical and distillation embeds them later.
   */
  async function embedCandidates(
    ctx: RequestContext,
    ventureId: string,
    candidates: readonly { readonly title: string; readonly content: string }[],
  ): Promise<(number[] | null)[] | undefined> {
    if (candidates.length === 0) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const embedded = await Promise.race([
        meteredEmbed(kit, { ctx, ventureId, purpose: 'embedding' }, candidates.map(memoryEmbeddingText)),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => {
            resolve(null);
          }, CANDIDATE_EMBED_TIMEOUT_MS);
        }),
      ]);
      if (embedded === null) return undefined;
      return candidates.map((_, i) => {
        const vector = embedded.vectors[i];
        return vector?.length === knowledgeRepo.EMBEDDING_DIMENSIONS ? vector : null;
      });
    } catch (err) {
      logger.warn('turn.memory_embedding_deferred', {
        requestId: ctx.requestId,
        candidates: candidates.length,
        error: err instanceof Error ? err.name : 'unknown',
      });
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * "Where you left off" for a turn (orchestrator/continuity.ts): null for a temporary chat, and when it cannot
   * be read (logged without content; the turn goes on without it).
   */
  async function loadLeftOffFor(
    ctx: RequestContext,
    pre: Proceed,
    personaId: string,
  ): Promise<LeftOffData | null> {
    if (pre.session.privacy !== 'standard') return null;
    try {
      return await kit.inRequest(ctx, ({ tx }) =>
        loadLeftOff(tx, {
          ventureId: pre.session.ventureId,
          personaId,
          sessionId: pre.session.id,
          principalId: ctx.principalId,
          privacy: pre.session.privacy,
        }),
      );
    } catch (err) {
      logger.warn('turn.left_off_unavailable', {
        requestId: ctx.requestId,
        sessionId: pre.session.id,
        error: err instanceof Error ? err.name : 'unknown',
      });
      return null;
    }
  }

  /**
   * The release a conversation runs on: the one it started with while that stays approved (or superseded by
   * a newer one: new releases apply to new conversations), else the current approved release, to which the
   * conversation is then re-pinned (audited).
   */
  async function conversationRelease(
    scope: RequestScope,
    session: sessionsRepo.SessionRecord,
    active: ActiveAssignment,
  ): Promise<personasRepo.PersonaReleaseRecord> {
    if (session.personaReleaseId === active.release.id) return active.release;
    const pinned = await personasRepo.getRelease(scope.tx, session.personaReleaseId);
    const usable =
      pinned !== null &&
      pinned.personaId === active.persona.id &&
      (pinned.status === 'approved' || pinned.status === 'superseded') &&
      (pinned.expiresAt === null || Date.parse(pinned.expiresAt) > kit.now().getTime());
    if (usable) return pinned;
    await sessionsRepo.setSessionRelease(scope.tx, { sessionId: session.id, releaseId: active.release.id });
    await audit(scope, {
      action: 'session.release_repinned',
      outcome: 'succeeded',
      ventureId: session.ventureId,
      objectType: 'session',
      objectId: session.id,
      policyReason: pinned === null ? 'release_missing' : `release_${pinned.status}`,
      metadata: { fromVersion: pinned?.version ?? null, toVersion: active.release.version },
    });
    return active.release;
  }

  /**
   * Whether the per-person message limit is reached. It counts typed messages and crisis messages on any
   * channel; other spoken turns are limited by the calls service. Only an ordinary typed message is refused
   * for it: a crisis message is always answered (see {@link admitTurn}).
   */
  async function overMessageLimit(
    scope: RequestScope,
    args: { readonly channel: TurnChannel; readonly crisis: boolean },
  ): Promise<boolean> {
    if (args.channel !== 'text' && !args.crisis) return false;
    const recent = await turnsRepo.countRecentTurnsByAuthor(scope.tx, {
      authorId: scope.ctx.principalId,
      windowSeconds: cfg.turns.rateWindowSeconds,
      channel: 'text',
      includeCrisis: true,
    });
    return recent >= cfg.turns.rateLimit;
  }

  const MESSAGE_LIMIT_TEXT = 'You are sending messages very quickly. Please wait a few minutes.';

  /** Step 1: authorize and check every gate except spend caps (owner-only ledger). */
  function preflight(
    ctx: RequestContext,
    sessionId: string,
    input: z.output<typeof RunTurnInput>,
    crisis: boolean,
  ): Promise<Proceed | Replay> {
    return kit.inRequest(ctx, async (scope) => {
      const { tx } = scope;
      const session = await sessionsRepo.getSession(tx, sessionId);
      if (session === null) {
        scope.deferAudit({
          action: 'turn.rejected',
          outcome: 'denied',
          objectType: 'session',
          objectId: sessionId,
          policyReason: 'session_not_visible',
        });
        throw fail.notFound('Session');
      }
      await requireVentureAccess(scope, session.ventureId, 'write', {
        objectType: 'session',
        objectId: sessionId,
      });
      const reject = (
        code: DomainError['code'],
        message: string,
        reason: string,
        retryAfterSeconds?: number,
      ): DomainError => {
        scope.deferAudit({
          action: 'turn.rejected',
          outcome: 'blocked',
          ventureId: session.ventureId,
          objectType: 'session',
          objectId: sessionId,
          policyReason: reason,
        });
        return new DomainError(
          code,
          message,
          retryAfterSeconds === undefined ? { reason } : { reason, retryAfterSeconds },
        );
      };

      if (input.expectedOrdinal !== undefined) {
        const existing = (await turnsRepo.listTurns(tx, sessionId)).find(
          (t) => t.ordinal === input.expectedOrdinal,
        );
        if (existing) {
          if (existing.authorId !== ctx.principalId || existing.founderText !== input.text) {
            throw reject(
              'idempotency_conflict',
              'A different message already has this position in the session',
              'ordinal_reused',
            );
          }
          const evidence = (await turnsRepo.listTurnEvidence(tx, [existing.id])).get(existing.id) ?? [];
          const escalationId =
            (await escalationsRepo.escalationIdsByTurn(tx, [existing.id])).get(existing.id) ?? null;
          const extras = (await turnsRepo.turnViewExtras(tx, [existing], null)).get(existing.id);
          return {
            kind: 'replay',
            turn: existing,
            view: turnsRepo.toTurnView(existing, evidence, blockedDetailOf(existing, escalationId), extras),
            escalationId,
          };
        }
      }

      if (session.status !== 'active') {
        throw reject(
          'session_ended',
          'This session has ended. Start a new session to continue.',
          `session_${session.status}`,
        );
      }
      const settings = await settingsRepo.getPlatformSettings(tx);
      // A counterpart is only used in a rehearsal, so sending one without a mode asks for that mode.
      const mode = input.mode ?? (input.rehearsalCounterpart ? 'rehearse' : null);
      // A spoken crisis message skips call admission (support is never refused for call reasons), so it is
      // recorded as spoken only when it names the caller's live call here; otherwise it is a typed message: no
      // call is marked on the conversation, no voice turn is counted and no speech unit is sent.
      const channel: TurnChannel =
        input.channel === 'voice' &&
        crisis &&
        !(await isLiveCallOf(scope, { sessionId, callId: input.callId }))
          ? 'text'
          : (input.channel ?? 'text');
      // The crisis path answers with a fixed human-support message and makes no model call, so the AI
      // gates (kill switch, coach persona/assignment, mode) never stand between a founder and support.
      let active: ActiveAssignment | null = null;
      let coach: Coach | null = null;
      if (!crisis) {
        if (!settings.aiEnabled) {
          throw reject(
            'ai_disabled',
            'AI coaching is paused by the program. Please try again later.',
            'kill_switch',
          );
        }
        active = await requireAssignmentActive(scope, session.ventureId);
        if (active.assignment.id !== session.assignmentId) {
          throw reject(
            'assignment_inactive',
            'The coaching assignment for this venture changed. Please start a new session.',
            'assignment_changed',
          );
        }
        const release = await conversationRelease(scope, session, active);
        const allowedModes = active.assignment.allowedModes.filter((m) => release.allowedModes.includes(m));
        if (mode !== null && !allowedModes.includes(mode)) {
          throw reject('forbidden', `Mode "${mode}" is not enabled for this venture`, 'mode_not_allowed');
        }
        if (allowedModes.length === 0) {
          throw reject('forbidden', 'No coaching mode is enabled for this venture', 'no_modes_allowed');
        }
        const history = await turnsRepo.listRecentTurns(tx, { sessionId, limit: cfg.turns.historyTurns });
        const interruptions = await callsRepo.listTurnInterruptions(
          tx,
          history.map((t) => t.id),
        );
        coach = {
          release,
          allowedModes,
          personaEirName: await personasRepo.getPersonaEirName(tx, active.persona.id),
          history,
          heardHistory: historyAsHeard(history, interruptions),
          // The opener is the conversation's first message: replayed while the history reaches back to it.
          opener:
            session.opener !== null && (history.length < cfg.turns.historyTurns || history[0]?.ordinal === 1)
              ? session.opener
              : null,
          memory: await loadContinuity(tx, {
            ventureId: session.ventureId,
            personaId: active.persona.id,
            sessionId,
            principalId: ctx.principalId,
            privacy: session.privacy,
          }),
        };
      }
      const turnCount = await turnsRepo.countSessionTurns(tx, sessionId);
      // The session turn limit stops runaway conversations, never a founder in crisis (no model call).
      if (!crisis && turnCount >= settings.maxTurnsPerSession) {
        throw reject(
          'session_turn_limit',
          'This session reached its turn limit. Please end it and start a new one.',
          'turn_limit',
        );
      }
      if (input.expectedOrdinal !== undefined && input.expectedOrdinal !== turnCount + 1) {
        throw reject(
          'conflict',
          'The conversation changed in another window. Reload the session.',
          'ordinal_mismatch',
        );
      }
      if (!crisis && (await overMessageLimit(scope, { channel, crisis }))) {
        throw reject('rate_limited', MESSAGE_LIMIT_TEXT, 'turn_rate_limit', cfg.turns.rateWindowSeconds);
      }
      const venture = await venturesRepo.getVenture(tx, session.ventureId);
      if (venture === null) throw fail.notFound('Venture');
      return {
        kind: 'proceed',
        session,
        settings,
        active,
        mode,
        turnMode: mode ?? session.mode,
        channel,
        venture,
        coach,
      };
    });
  }

  async function replay(
    ctx: RequestContext,
    emit: (e: TurnStreamEvent) => Promise<void>,
    r: Replay,
  ): Promise<RunTurnOutcome> {
    await emit({ event: 'turn.accepted', turnId: r.turn.id, ordinal: r.turn.ordinal });
    const view = participantTurnView(r.view);
    switch (r.turn.status) {
      case 'completed':
        await emit({ event: 'turn.completed', turn: view });
        return { status: 'completed', turnId: r.turn.id, replayed: true, error: null };
      case 'blocked': {
        const blocked = view.blocked ?? {
          reason: 'blocked',
          supportMessage: null,
          escalationId: r.escalationId,
        };
        await emit({ event: 'turn.blocked', turnId: r.turn.id, ...blocked });
        return { status: 'blocked', turnId: r.turn.id, replayed: true, error: null };
      }
      case 'failed': {
        const error = new DomainError(
          'model_unavailable',
          'This message could not be answered. Please send it again.',
          {
            reason: 'replayed_failure',
          },
        );
        await emit(errorEvent(r.turn.id, error, ctx.requestId));
        return { status: 'failed', turnId: r.turn.id, replayed: true, error };
      }
      case 'pending': {
        const error = new DomainError('conflict', 'This message is still being answered. Please wait.', {
          reason: 'turn_pending',
          retryAfterSeconds: 5,
        });
        await emit(errorEvent(r.turn.id, error, ctx.requestId));
        return { status: 'failed', turnId: r.turn.id, replayed: true, error };
      }
    }
  }

  /** Marks an accepted turn failed (never throws) and records its billable totals on the turn. */
  async function failTurn(
    ctx: RequestContext,
    turn: turnsRepo.TurnRecord,
    error: DomainError,
    attempts: readonly ModelAttempt[],
  ): Promise<void> {
    const totals = attempts.reduce(
      (acc, a) => ({
        inputTokens: acc.inputTokens + a.usage.inputTokens,
        outputTokens: acc.outputTokens + a.usage.outputTokens,
        costUsd: acc.costUsd + a.costUsd,
      }),
      { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    );
    try {
      await kit.inRequest(ctx, async (scope) => {
        await turnsRepo.finishTurn(scope.tx, {
          turnId: turn.id,
          status: 'failed',
          modelId: attempts.at(-1)?.modelId ?? null,
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          costUsd: totals.costUsd,
        });
        await audit(scope, {
          action: 'turn.failed',
          outcome: 'failed',
          ventureId: turn.ventureId,
          objectType: 'turn',
          objectId: turn.id,
          policyReason: error.reason ?? error.code,
          metadata: { code: error.code, attempts: attempts.length },
        });
      });
    } catch (err) {
      logger.error('turn.fail_persist_failed', {
        requestId: ctx.requestId,
        turnId: turn.id,
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  /** Signed `turn.speech` units of one voice turn (none once `signal`, the caller's, is aborted). */
  function speechStream(
    ctx: RequestContext,
    ids: { readonly sessionId: string; readonly turnId: string },
    emit: (e: TurnStreamEvent) => Promise<void>,
    key: Promise<SessionSigningKey>,
    signal?: AbortSignal,
  ): SpeechStream {
    return new SpeechStream(
      key,
      { ...ids, requestId: ctx.requestId },
      emit,
      (fields) => {
        logger.error('turn.speech_unsigned', fields);
      },
      signal,
    );
  }

  async function crisisPath(
    ctx: RequestContext,
    turn: turnsRepo.TurnRecord,
    pre: Proceed,
    risk: RiskClassification,
    emit: (e: TurnStreamEvent) => Promise<void>,
    speechKey: Promise<SessionSigningKey> | null,
  ): Promise<RunTurnOutcome> {
    const response = buildCrisisResponse(pre.turnMode, pre.channel);
    const validator: ValidatorResults = {
      unknownEvidenceIdsRemoved: 0,
      factsDowngraded: 0,
      groundingCoverage: null,
      narrowed: false,
      escalationForced: true,
      identityViolation: false,
      crossVentureViolation: false,
      riskCategories: risk.categories,
      notes: ['crisis_support', 'no_model_call'],
    };
    const escalationId = await kit.inRequest(ctx, async (scope) => {
      const finished = await turnsRepo.finishTurn(scope.tx, {
        turnId: turn.id,
        status: 'blocked',
        response,
        validatorResults: validator,
        sampledForReview: false,
        mode: pre.turnMode,
      });
      if (finished === null) throw fail.conflict('The turn is no longer pending', 'turn_not_pending');
      const escalation = await createDraftEscalation(scope, {
        ventureId: pre.session.ventureId,
        sessionId: pre.session.id,
        turnId: turn.id,
        founderText: turn.founderText,
        category: 'safety_wellbeing',
        priority: 'P1',
        requestedRole: 'university_support',
        response,
        evidence: [],
        reason: response.escalation.reason,
      });
      await audit(scope, {
        action: 'turn.crisis_support',
        outcome: 'blocked',
        ventureId: pre.session.ventureId,
        objectType: 'turn',
        objectId: turn.id,
        policyReason: 'crisis',
        metadata: { escalationId: escalation.id, modelCalled: false, channel: pre.channel },
      });
      return escalation.id;
    });
    // On a call, the fixed spoken support message is said before the blocked panel appears.
    if (speechKey !== null) {
      const speech = speechStream(ctx, { sessionId: pre.session.id, turnId: turn.id }, emit, speechKey);
      await speech.queue(CRISIS_SPOKEN_MESSAGE);
      await speech.finish();
    }
    await emit({
      event: 'turn.blocked',
      turnId: turn.id,
      reason: 'crisis_support',
      escalationId,
      supportMessage: CRISIS_SUPPORT_MESSAGE,
    });
    return { status: 'blocked', turnId: turn.id, replayed: false, error: null };
  }

  interface Accepted {
    readonly ctx: RequestContext;
    readonly turn: turnsRepo.TurnRecord;
    readonly pre: Proceed;
    readonly input: z.output<typeof RunTurnInput>;
    readonly risk: RiskClassification;
    /** Whether the admission treated the message as a crisis (no limits, no coach, no model call). */
    readonly crisis: boolean;
    readonly others: OtherVentures;
    readonly eirNames: readonly string[];
    /** The founder and their team: names the reply may address ("Thanks, Ruth."). */
    readonly addressees: readonly string[];
    /** The retrieval query (founder text, the previous question for short replies, the goal). */
    readonly query: string;
    /** Started while the turn was admitted. */
    readonly embedding: Promise<number[] | null> | null;
    readonly speechKey: Promise<SessionSigningKey> | null;
    readonly emit: (e: TurnStreamEvent) => Promise<void>;
    readonly signal: AbortSignal | undefined;
    readonly startedAt: number;
  }

  async function accepted(a: Accepted): Promise<RunTurnOutcome> {
    const { ctx, turn, pre, input, risk, others, eirNames, addressees, emit, signal } = a;
    const label = riskLabel(risk);
    const ventureId = pre.session.ventureId;
    // The detail is a participant-safe label: which names the cross-venture guard knows is never revealed.
    await emit({
      event: 'turn.status',
      phase: 'classifying',
      detail: participantRiskLabel(label),
      evidenceCount: null,
    });

    // Step 2: crisis → human support, no model call. The admission decided on the same classification (the
    // gates a crisis skips were skipped for it), so a turn admitted as a crisis always takes this path.
    if (a.crisis || risk.crisis) return crisisPath(ctx, turn, pre, risk, emit, a.speechKey);
    const { active, coach } = pre;
    if (active === null || coach === null)
      throw new DomainError('assignment_inactive', 'No active coach', { reason: 'no_assignment' });

    // Step 3: authorized, scoped retrieval. "Where you left off" (the latest earlier conversations, read as they
    // were said when not distilled yet) loads alongside, in its own transaction: it never waits for the
    // distillation worker, and the turn never waits for it longer than for retrieval.
    await emit({ event: 'turn.status', phase: 'retrieving', detail: null, evidenceCount: null });
    const leftOff = loadLeftOffFor(ctx, pre, active.persona.id);
    const embedding = await (a.embedding ??
      embedRetrievalQuery(kit, ctx, { purpose: 'turn', ventureId }, a.query, signal));
    const pack = await kit.inRequest(ctx, async (scope) => {
      const evidencePack = await retrieveEvidence(scope.tx, {
        tenantId: ctx.tenantId,
        ventureId,
        personaId: active.persona.id,
        stage: pre.venture.stage,
        query: a.query,
        embedding,
        dataClassCeiling: active.assignment.dataClassCeiling,
        budgets: cfg.retrieval,
        // Always null today: no session is readable by its author alone (see privateRetrievalOwner).
        privateOwnerId: privateRetrievalOwner(pre.session, ctx.principalId),
      });
      await audit(scope, {
        action: 'retrieval.authorized',
        outcome: 'allowed',
        ventureId,
        objectType: 'turn',
        objectId: turn.id,
        metadata: { ...evidencePack.counts, lexicalOnly: embedding === null },
      });
      if (evidencePack.dropped > 0) {
        await audit(scope, {
          action: 'retrieval.denied',
          outcome: 'denied',
          ventureId,
          objectType: 'turn',
          objectId: turn.id,
          policyReason: 'isolation_filter',
          metadata: { dropped: evidencePack.dropped },
        });
      }
      return evidencePack;
    });
    await emit({
      event: 'turn.status',
      phase: 'retrieving',
      detail: `memory:${pack.counts.memory},documents:${pack.counts.chunks},library:${pack.counts.shared + pack.counts.resources + pack.counts.patterns}`,
      evidenceCount: pack.items.length,
    });
    const leftOffData = await leftOff;
    const leftOffSection = renderLeftOffSection(leftOffData, {
      now: kit.now(),
      threads: leftOffThreads(coach.memory.continuity),
    });

    // Steps 4–6: assemble the prompt, generate, validate (shared with the EIR studio's test bench).
    const answered = await answerTurn({
      kit,
      ctx,
      meter: { purpose: 'turn', ventureId },
      ids: { sessionId: pre.session.id, turnId: turn.id },
      release: coach.release,
      personaName: active.persona.name,
      personaEirName: coach.personaEirName,
      mode: pre.mode,
      allowedModes: coach.allowedModes,
      fallbackMode: coach.allowedModes.includes(pre.session.mode)
        ? pre.session.mode
        : (coach.allowedModes[0] ?? pre.session.mode),
      risk,
      settings: pre.settings,
      venture: {
        name: pre.venture.name,
        stage: pre.venture.stage,
        domain: pre.venture.domain,
        currentGoal: pre.venture.currentGoal,
      },
      conversationGoal: pre.session.goal,
      rehearsalCounterpart: input.rehearsalCounterpart ?? null,
      channel: pre.channel,
      continuity: coach.memory.continuity,
      leftOff: leftOffSection,
      evidence: pack.items,
      history: coach.heardHistory,
      opener: coach.opener,
      founderText: input.text,
      guards: { eirNames, addressees, others },
      emit,
      speechKey: a.speechKey,
      signal,
      startedAt: a.startedAt,
    });
    if (answered.kind === 'generation_failed') {
      const error = generationError(answered.cause);
      await failTurn(ctx, turn, error, answered.attempts);
      await emit(errorEvent(turn.id, error, ctx.requestId));
      return { status: 'failed', turnId: turn.id, replayed: false, error };
    }
    const { context, shown, generation, checked } = answered;
    const status = checked.blocked ? 'blocked' : 'completed';
    // What the turn taught is kept automatically: embedded first (best effort, bounded, while the reply is still
    // being said) so it is compared with the venture's memory by meaning before it is kept.
    const keepable =
      !checked.blocked && pre.session.privacy === 'standard' ? checked.response.memory_candidates : [];
    const candidateVectors = embedCandidates(ctx, ventureId, keepable);
    // A call ends a streamed reply with its last unit (and a caveat when the answer was narrowed). A reply
    // written whole (streaming off, or a stream that broke, was empty or was not prose) is said as its
    // validated spoken form. A blocked turn says nothing more.
    const stream = generation.stream;
    const speech =
      stream?.speech ??
      (a.speechKey === null
        ? null
        : speechStream(ctx, { sessionId: pre.session.id, turnId: turn.id }, emit, a.speechKey, signal));
    // True as well when nothing was streamed (`stream` null).
    const writtenWhole = stream?.fallback !== null;
    if (speech !== null) {
      if (checked.blocked) speech.discard();
      else if (writtenWhole) {
        await speech.queue(checked.response.spoken ?? deriveSpoken(checked.response.answer));
        await speech.finish();
      } else await speech.finish(checked.results.narrowed ? SPOKEN_NARROWING_CAVEAT : undefined);
    }
    // Ephemeral sessions are never shared with the assigned EIR (RLS turns_read enforces it as well).
    const sampled =
      pre.session.privacy !== 'ephemeral' &&
      shouldSampleForReview({
        status,
        riskLabel: label,
        validator: checked.results,
        response: checked.response,
        rate: cfg.turns.reviewSampleRate,
        random: kit.deps.random,
      });

    // Step 7: persist turn, evidence, memory candidates, escalation draft, audit.
    const evidenceIndex = new Map(shown.map((k) => [k.item.key, k.item] as const));
    const totals = generationTotals(generation);
    const firstTokenMs = generation.stream?.firstDeltaMs ?? null;
    const vectors = await candidateVectors;
    const persisted = await kit.inRequest(ctx, async (scope) => {
      const { tx } = scope;
      const finished = await turnsRepo.finishTurn(tx, {
        turnId: turn.id,
        status,
        response: checked.response,
        validatorResults: checked.results,
        modelId: generation.modelId,
        fallbackUsed: generation.fallbackUsed,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        costUsd: totals.costUsd,
        latencyMs: generation.latencyMs,
        firstTokenMs,
        sampledForReview: sampled,
        mode: checked.response.mode,
      });
      if (finished === null) throw fail.conflict('The turn is no longer pending', 'turn_not_pending');
      await turnsRepo.insertTurnEvidence(
        tx,
        turn.id,
        shown.map((k) => ({
          key: k.item.key,
          kind: k.item.kind,
          refId: k.item.refId,
          score: k.item.score,
          title: k.item.title,
          ventureId: k.ventureId,
          source: k.item.source ?? null,
        })),
      );
      const candidates =
        keepable.length > 0
          ? await persistMemoryCandidates(tx, {
              tenantId: ctx.tenantId,
              ventureId,
              createdBy: ctx.principalId,
              candidates: keepable,
              evidence: evidenceIndex,
              source: { kind: 'turn', id: turn.id, sessionId: pre.session.id },
              visibility: candidateVisibility(pack),
              // The coach's own advice is never kept as a fact unless the founder said or agreed to it.
              grounding: conversationGrounding([
                ...coach.history.map((t) => ({ founder: t.founderText, answer: t.response?.answer ?? null })),
                { founder: turn.founderText, answer: checked.response.answer },
              ]),
              ...(vectors === undefined ? {} : { embeddings: vectors }),
            })
          : [];
      const esc = checked.response.escalation;
      let escalationId: string | null = null;
      if (
        esc.required &&
        esc.category !== null &&
        esc.priority !== null &&
        (checked.results.escalationForced || esc.priority === 'P0' || esc.priority === 'P1')
      ) {
        const draft = await createDraftEscalation(scope, {
          ventureId,
          sessionId: pre.session.id,
          turnId: turn.id,
          founderText: turn.founderText,
          category: esc.category,
          priority: esc.priority,
          requestedRole: esc.requested_role ?? 'eir',
          response: checked.blocked ? null : checked.response,
          evidence: shown.map((k) => k.item),
          reason: esc.reason,
        });
        escalationId = draft.id;
      }
      if (checked.response.mode !== pre.session.mode) {
        await sessionsRepo.setSessionMode(tx, { sessionId: pre.session.id, mode: checked.response.mode });
      }
      await audit(scope, {
        action: checked.blocked ? 'turn.blocked' : 'turn.completed',
        outcome: checked.blocked ? 'blocked' : 'succeeded',
        ventureId,
        objectType: 'turn',
        objectId: turn.id,
        policyReason: checked.blockReason ?? null,
        metadata: {
          ordinal: turn.ordinal,
          policyVersion: POLICY_VERSION,
          releaseVersion: coach.release.version,
          modelId: generation.modelId,
          fallbackUsed: generation.fallbackUsed,
          attempts: generation.attempts.length,
          channel: pre.channel,
          autoMode: pre.mode === null,
          mode: checked.response.mode,
          evidence: shown.length,
          factsDowngraded: checked.results.factsDowngraded,
          unknownEvidenceIdsRemoved: checked.results.unknownEvidenceIdsRemoved,
          narrowed: checked.results.narrowed,
          escalationForced: checked.results.escalationForced,
          identityViolation: checked.results.identityViolation,
          crossVentureViolation: checked.results.crossVentureViolation,
          sampled,
          memoryCandidates: candidates.length,
          escalationId,
          inputTokensEstimate: context.estimatedInputTokens,
          notebook: coach.memory.notebook,
          digests: coach.memory.digests,
          openerReplayed: context.openerReplayed,
          // How the reply reached the founder: off (one whole reply), streamed, stopped by the gate, or the
          // reason a stream was replaced by a whole reply.
          stream:
            stream === null
              ? 'off'
              : (stream.fallback ??
                (stream.interrupted
                  ? 'interrupted'
                  : generation.gateBlocked === null
                    ? 'streamed'
                    : 'gate_blocked')),
          firstTokenMs,
          modelFirstTokenMs: stream?.modelFirstTokenMs ?? null,
          totalMs: Math.round(performance.now() - a.startedAt),
          modelMs: generation.latencyMs,
          deltas: stream?.deltas ?? 0,
          speechUnits: speech?.sent ?? 0,
          gateIdentityRewrites: stream?.gate.identityRewrites ?? 0,
          gateWithheld: stream?.gate.withheld ?? 0,
        },
      });
      const evidence = (await turnsRepo.listTurnEvidence(tx, [turn.id])).get(turn.id) ?? [];
      const reason = checked.blocked ? (checked.blockReason ?? 'blocked') : null;
      const blocked: TurnBlockedDetail | null =
        reason === null ? null : { reason, supportMessage: supportMessageFor(reason), escalationId };
      // A turn just answered: its author, and no rating yet.
      const extras = (await turnsRepo.turnViewExtras(tx, [finished], null)).get(finished.id);
      const view = participantTurnView(turnsRepo.toTurnView(finished, evidence, blocked, extras));
      return { view, blocked: view.blocked };
    });

    if (persisted.blocked !== null) {
      await emit({ event: 'turn.blocked', turnId: turn.id, ...persisted.blocked });
      return { status: 'blocked', turnId: turn.id, replayed: false, error: null };
    }
    await emit({ event: 'turn.completed', turn: persisted.view });
    return { status: 'completed', turnId: turn.id, replayed: false, error: null };
  }

  /**
   * Per-principal turn admission inside the turn-creating transaction (see runTurn). Rejections are
   * audited after the rollback (deferred) and thrown as DomainErrors. Spoken turns are admitted by the calls
   * service (live call, call caps, voice rate limit) instead of the typed-message rate limit.
   *
   * A crisis message is never refused for a limit: not the message limit, the in-flight limit, call
   * admission or the spend caps (nor, in preflight, the session turn limit). It always gets the fixed support
   * response and its escalation draft. This stays safe because the crisis path makes no model call and
   * spends nothing; crisis messages are serialised per person by the admission lock and count towards the
   * message limit, so a burst of them still stops that person's ordinary messages. Past the message limit a
   * spoken crisis message is answered as a typed one (the support text stays on screen; its spoken form is
   * not synthesised again), so a burst cannot become a burst of speech synthesis either. Returns the channel
   * the turn is recorded with.
   */
  async function admitTurn(
    scope: RequestScope,
    args: {
      readonly crisis: boolean;
      readonly ventureId: string;
      readonly sessionId: string;
      readonly settings: PlatformSettingsView;
      readonly channel: TurnChannel;
      readonly callId: string | undefined;
    },
  ): Promise<TurnChannel> {
    const { tx, ctx } = scope;
    const reject = (
      code: DomainError['code'],
      message: string,
      reason: string,
      retryAfterSeconds: number,
    ) => {
      scope.deferAudit({
        action: code === 'spend_cap_reached' ? 'spend_cap.reached' : 'turn.rejected',
        outcome: 'blocked',
        ventureId: args.ventureId,
        objectType: code === 'spend_cap_reached' ? 'turn' : 'session',
        objectId: code === 'spend_cap_reached' ? null : args.sessionId,
        policyReason: reason,
      });
      return new DomainError(code, message, { reason, retryAfterSeconds });
    };
    await turnsRepo.lockTurnAdmission(tx, ctx.principalId);
    // Preflight read the conversation in its own transaction. Deleting or ending it since then must win: the
    // conversation is re-checked under the lock its delete and end take, so a turn admitted just after a
    // delete is refused, and a delete that comes later waits for this turn and erases it with the rest.
    if (!(await sessionsRepo.lockSessionForTurn(tx, args.sessionId))) {
      scope.deferAudit({
        action: 'turn.rejected',
        outcome: 'blocked',
        ventureId: args.ventureId,
        objectType: 'session',
        objectId: args.sessionId,
        policyReason: 'session_not_active',
      });
      throw new DomainError('session_ended', 'This session has ended. Start a new session to continue.', {
        reason: 'session_not_active',
      });
    }
    const overLimit = await overMessageLimit(scope, { channel: args.channel, crisis: args.crisis });
    if (args.crisis) return overLimit && args.channel === 'voice' ? 'text' : args.channel;
    if (overLimit) {
      throw reject('rate_limited', MESSAGE_LIMIT_TEXT, 'turn_rate_limit', cfg.turns.rateWindowSeconds);
    }
    const inFlight = await turnsRepo.countPendingTurnsByAuthor(tx, {
      authorId: ctx.principalId,
      withinSeconds: cfg.turns.inFlightWindowSeconds,
    });
    if (inFlight >= cfg.turns.maxInFlight) {
      throw reject(
        'rate_limited',
        'Please wait for the answers you are already waiting for.',
        'turns_in_flight',
        5,
      );
    }
    if (args.channel === 'voice') {
      await admitVoiceTurn(scope, { sessionId: args.sessionId, callId: args.callId, now: kit.now() });
    }
    // Spend recorded by turns still in flight is not in the ledger yet; the in-flight limit bounds that.
    const cap = await turnsRepo.spendCapState(tx, {
      globalUsd: args.settings.dailyUsdCapGlobal,
      principalUsd: args.settings.dailyUsdCapPerPrincipal,
    });
    if (cap !== null) {
      throw reject(
        'spend_cap_reached',
        cap === 'global'
          ? 'The daily AI budget for the platform has been reached. Coaching resumes tomorrow (UTC).'
          : 'You have reached your daily AI coaching budget. It resets at midnight UTC.',
        `${cap}_daily_cap`,
        secondsUntilUtcMidnight(kit.now()),
      );
    }
    return args.channel;
  }

  return {
    async runTurn(ctx, rawSessionId, rawInput, rawEmit, options = {}) {
      const startedAt = performance.now();
      const emit = safeEmitter(rawEmit, ctx.requestId);
      let turn: turnsRepo.TurnRecord;
      let pre: Proceed;
      let input: z.output<typeof RunTurnInput>;
      let risk: RiskClassification;
      let others: OtherVentures;
      let eirNames: readonly string[];
      let addressees: readonly string[];
      let query: string;
      let embedding: Promise<number[] | null> | null = null;
      let speechKey: Promise<SessionSigningKey> | null = null;
      let crisis = false;
      try {
        const sessionId = requireId(rawSessionId, 'Session');
        input = parseInput(RunTurnInput, rawInput);
        // Crisis detection does not depend on venture names; it decides which gates apply.
        crisis = classifyRisk(input.text).crisis;
        const checked = await preflight(ctx, sessionId, input, crisis);
        if (checked.kind === 'replay') return await replay(ctx, emit, checked);
        pre = checked;
        if (!crisis) {
          await assertWithinSpendCaps(kit, ctx, pre.settings, {
            ventureId: pre.session.ventureId,
            operation: 'turn',
          });
        }
        others = await directory.others(ctx.tenantId, pre.session.ventureId);
        eirNames = (await directory.get(ctx.tenantId)).eirNames;
        addressees = await directory.addressees(ctx.tenantId, pre.session.ventureId);
        risk = classifyRisk(input.text, {
          otherVentureNames: others.names,
          otherVentureMemberNames: others.memberNames,
        });
        const label = riskLabel(risk);
        const parsed = input;
        const settings = pre.settings;
        const session = pre.session;
        // A short reply answers the vEIR's last message: the previous answer as the founder heard it, or the
        // opener on the first turn.
        const coach = pre.coach;
        query = buildRetrievalQuery({
          founderText: parsed.text,
          previousAnswer:
            coach === null
              ? null
              : coach.heardHistory.length > 0
                ? (coach.heardHistory.at(-1)?.answer ?? null)
                : coach.opener,
          currentGoal: session.goal ?? pre.venture.currentGoal,
        });
        // Latency: the speech key loads while the turn is admitted.
        if (pre.channel === 'voice') {
          speechKey = speechKeys.signingKey();
          speechKey.catch(() => undefined); // a failure surfaces when a unit is signed
        }
        const turnMode = pre.turnMode;
        let channel = pre.channel;
        turn = await kit.inRequest(ctx, async (scope) => {
          // Admission is atomic per principal: the rate limit, the in-flight limit and the spend caps are
          // checked under a transaction-scoped advisory lock in the same transaction that inserts the
          // pending turn, so parallel requests cannot all pass the checks before any turn exists.
          channel = await admitTurn(scope, {
            crisis,
            ventureId: session.ventureId,
            sessionId: session.id,
            settings,
            channel: pre.channel,
            callId: parsed.callId,
          });
          const created = await turnsRepo.createTurn(scope.tx, {
            tenantId: ctx.tenantId,
            ventureId: session.ventureId,
            sessionId: session.id,
            authorId: ctx.principalId,
            mode: turnMode,
            founderText: parsed.text,
            riskLabel: label,
            riskCategories: risk.categories,
            channel,
          });
          if (parsed.expectedOrdinal !== undefined && created.ordinal !== parsed.expectedOrdinal) {
            throw fail.conflict(
              'The conversation changed in another window. Reload the session.',
              'ordinal_mismatch',
            );
          }
          await audit(scope, {
            action: 'turn.accepted',
            outcome: 'succeeded',
            ventureId: session.ventureId,
            objectType: 'turn',
            objectId: created.id,
            metadata: {
              sessionId: session.id,
              ordinal: created.ordinal,
              mode: turnMode,
              autoMode: pre.mode === null,
              channel,
              riskLabel: label,
              riskRules: risk.matchedRules.slice(0, 20),
            },
          });
          return created;
        });
        // A spoken crisis message admitted as a typed one (past the message limit) says nothing on the call.
        if (channel !== pre.channel) {
          pre = { ...pre, channel };
          speechKey = null;
        }
        // The query embedding starts once the turn is admitted (a refused request buys no model call) and
        // overlaps the accepted and classifying events.
        if (!crisis && !risk.crisis) {
          embedding = embedRetrievalQuery(
            kit,
            ctx,
            { purpose: 'turn', ventureId: session.ventureId },
            query,
            options.signal,
          );
        }
      } catch (err) {
        const error = asDomainError(err);
        if (error.code === 'internal') {
          logger.error('turn.preflight_failed', {
            requestId: ctx.requestId,
            error: err instanceof Error ? err.name : 'unknown',
          });
        }
        await emit(errorEvent(null, error, ctx.requestId));
        return { status: 'rejected', turnId: null, replayed: false, error };
      }

      await emit({ event: 'turn.accepted', turnId: turn.id, ordinal: turn.ordinal });
      try {
        return await accepted({
          ctx,
          turn,
          pre,
          input,
          risk,
          crisis,
          others,
          eirNames,
          addressees,
          query,
          embedding,
          speechKey,
          emit,
          signal: options.signal,
          startedAt,
        });
      } catch (err) {
        const error = asDomainError(err);
        logger.error('turn.failed', {
          requestId: ctx.requestId,
          turnId: turn.id,
          code: error.code,
          error: err instanceof Error ? err.name : 'unknown',
        });
        await failTurn(ctx, turn, error, []);
        await emit(errorEvent(turn.id, error, ctx.requestId));
        return { status: 'failed', turnId: turn.id, replayed: false, error };
      }
    },
  };
}
