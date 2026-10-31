import {
  CRISIS_SPOKEN_MESSAGE,
  CRISIS_SUPPORT_MESSAGE,
  POLICY_VERSION,
  SAFETY_SCREEN_CRISIS_RULE,
  buildCrisisResponse,
  buildRetrievalQuery,
  classifyRisk,
  deriveSpoken,
  riskLabel,
  withSafetyScreen,
  type HistoryTurn,
  type ModelAttempt,
  type RiskClassification,
} from '@foundry/ai';
import {
  CreateTurnRequest,
  type CoachMode,
  type TurnBlockedDetail,
  type TurnChannel,
  type TurnStreamEvent,
  type TurnView,
  type ValidatorResults,
} from '@foundry/contracts';
import {
  assignmentsRepo,
  callsRepo,
  escalationsRepo,
  memoryRepo,
  personasRepo,
  readTogether,
  sessionsRepo,
  settingsRepo,
  turnsRepo,
  venturesRepo,
  type ReadPart,
} from '@foundry/db';
import type { z } from 'zod';

import { PlatformKeyCache } from '../auth/keys.js';
import { type SessionSigningKey } from '../auth/session-token.js';
import {
  enforceAssignmentActive,
  enforceVentureAccess,
  type ActiveAssignment,
} from '../authz/venture-access.js';
import { type RequestContext } from '../context.js';
import { DomainError, fail, isDomainError, parseInput, toDomainError } from '../errors.js';
import { type DirectoryCache, type OtherVentures } from '../internal/directory.js';
import { audit, requireId, type AuditEvent, type Kit, type RequestScope } from '../internal/kit.js';
import {
  admitVoiceTurn as callsAdmission,
  isLiveCallOf,
  voiceTurnCallId,
  voiceTurnReadParts,
  type AdmitVoiceTurn,
  type VoiceTurnReads,
} from '../services/call-admission.js';
import { createDraftEscalation } from '../services/escalations.js';
import { proposeMemoryCandidates, settleKeptMemory } from '../services/memory.js';
import { statedMemory } from '../services/founder-statements.js';
import { conversationGrounding } from '../services/memory-dedupe.js';
import { historyAsHeard } from '../services/spoken-text.js';
import { answerTurn, generationError } from './answer.js';
import { blockedDetailOf, participantRiskLabel, participantTurnView, supportMessageFor } from './blocked.js';
import { leftOffThreads, loadLeftOff, withoutLeftOff, type LoadedContinuity } from './continuity.js';
import { renderLeftOffSection, type LeftOffData } from './continuity-prompt.js';
import { candidateVisibility } from './evidence.js';
import { type FaceApproval, generationTotals, SpeechStream } from './generate.js';
import { embedRetrievalQuery, privateRetrievalOwner, retrieveEvidence } from './retrieval.js';
import { safetyScreenDue, screenIndirectIdeation } from './safety-screen.js';
import { secondsUntilUtcMidnight, shouldSampleForReview } from './sampling.js';
import {
  readTurnContext,
  sameTurnContextKeys,
  TurnContextKeyring,
  type TurnContextKeys,
  type TurnContextReads,
} from './turn-context.js';

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
  /**
   * Awaited just before the turn is admitted (nothing is written for the turn before it): the API's reservation of
   * the request's Idempotency-Key, made while the turn's checks run. A rejection refuses the turn with that error
   * (a domain error as it is), before acceptance.
   */
  readonly beforeAdmission?: Promise<unknown>;
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
  /**
   * Face pre-approval (the speech service): on a call whose FULL face is live, each signed unit of a spoken turn is
   * admitted to the face as it is produced (docs/architecture/calls.md §4). Absent: every unit goes through
   * `POST /calls/:id/face/say` as before.
   */
  readonly facePreapproval?: {
    prepareFaceApproval(
      ctx: RequestContext,
      args: { readonly callId: string; readonly sessionId: string },
    ): Promise<FaceApproval | null>;
  };
  /**
   * The conversations' keys this process knows (turn-context.ts), shared with the calls service, which fills them when
   * a call starts. Default: the orchestrator's own.
   */
  readonly turnContexts?: TurnContextKeyring;
}

/**
 * The context reads a turn started beside its preflight, for the keys it expected (turn-context.ts). Its transaction
 * lives no longer than the turn: runTurn hands it to the host's after-response work (drained before a Lambda
 * invocation returns) or waits for it, on every path, used or not.
 */
interface TurnContextPrefetch {
  readonly keys: TurnContextKeys;
  /**
   * Null when the reads failed (the preflight then reads them itself). Never rejects. Resolves once they were read,
   * before their transaction commits (`ended`).
   */
  readonly reads: Promise<TurnContextReads | null>;
  /** The prefetch's transaction ended (never rejects). */
  readonly ended: Promise<void>;
  /** Whether the turn logged what became of it (prefetched, prefetch_failed, keys_changed); else it was unused. */
  accounted: boolean;
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
  readonly settings: settingsRepo.ResolvedPlatformSettings;
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
  /** How the vEIR is present to this venture's founders (first-person consent, the EIR sees the work). */
  readonly presence: Pick<personasRepo.PersonaPresence, 'firstPerson' | 'eirSeesWork'>;
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
  /**
   * "Where you left off" (orchestrator/continuity.ts), started once the preflight passed so it reads beside the
   * admission (it never waits for the distillation worker; null when it cannot be read).
   */
  readonly leftOff: Promise<LeftOffData | null>;
}

/** What the coach is before its conversation context (presence, notes) joins it ({@link Coach}). */
type CoachBase = Omit<Coach, 'personaEirName' | 'presence' | 'memory' | 'leftOff'>;

/** A turn past the preflight's checks, before its conversation context is in hand (turn-context.ts). */
interface Checked extends Omit<Proceed, 'kind' | 'venture' | 'coach'> {
  readonly kind: 'checked';
  /** A crisis turn's venture (it reads no coach context); null otherwise. */
  readonly crisisVenture: venturesRepo.VentureRecord | null;
  readonly coach: CoachBase | null;
  /** The keys the turn's checks resolved to (null on the crisis path). */
  readonly keys: TurnContextKeys | null;
  /** Read in the preflight, or the prefetch under way for the same keys (null on the crisis path). */
  readonly context: { readonly read: TurnContextReads } | { readonly prefetched: TurnContextPrefetch } | null;
}

/** The vEIR's last message as the founder heard it: the previous answer, or the opener on the first turn. */
function previousReplyOf(coach: Coach | null): string | null {
  if (coach === null) return null;
  return coach.heardHistory.length > 0 ? (coach.heardHistory.at(-1)?.answer ?? null) : coach.opener;
}

interface Replay {
  readonly kind: 'replay';
  readonly turn: turnsRepo.TurnRecord;
  readonly view: TurnView;
  readonly escalationId: string | null;
}

export function createOrchestrator(
  kit: Kit,
  directory: DirectoryCache,
  options: OrchestratorOptions = {},
): Orchestrator {
  const cfg = kit.config;
  const { logger } = kit.deps;
  const admitVoiceTurn = options.admitVoiceTurn ?? callsAdmission;
  const facePreapproval = options.facePreapproval;
  const speechKeys =
    options.speechKeys ??
    new PlatformKeyCache(kit, Math.max(cfg.session.keyGraceSeconds, cfg.session.ttlSeconds));
  const turnContexts = options.turnContexts ?? new TurnContextKeyring();

  /**
   * Starts the conversation's context reads in a transaction of their own, beside the preflight, when the process knows
   * the conversation's keys (turn-context.ts); null otherwise. A crisis message reads no coach context.
   */
  function prefetchTurnContext(ctx: RequestContext, sessionId: string): TurnContextPrefetch | null {
    const keys = turnContexts.get(ctx.tenantId, ctx.principalId, sessionId);
    if (keys === null) return null;
    // The reads are used once read; the transaction's commit is not waited for (it only read).
    const read = kit.readInRequest(ctx, ({ tx }) => readTurnContext(tx, keys));
    return {
      keys,
      reads: read.then(
        (r) => r.value,
        () => null,
      ),
      ended: read.then(
        (r) => r.ended,
        () => undefined,
      ),
      accounted: false,
    };
  }

  /**
   * Ties a prefetch to the turn's life, whatever became of the turn (refused, replayed, failed, completed): its
   * transaction is handed to the host's after-response work, which a Lambda invocation drains before it returns, or the
   * turn waits for it (tests; never rejects, at most the prefetch's own round trips). A prefetch the turn never reached
   * is logged as `unused`, so its cost is visible.
   */
  async function endPrefetch(ctx: RequestContext, prefetch: TurnContextPrefetch | null): Promise<void> {
    if (prefetch === null) return;
    if (!prefetch.accounted) logger.info('turn.context', { requestId: ctx.requestId, source: 'unused' });
    await kit.later(Promise.all([prefetch.reads, prefetch.ended]));
  }

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
   * "Where you left off" for a turn (orchestrator/continuity.ts): null for a temporary chat, and when it cannot
   * be read (logged without content; the turn goes on without it).
   */
  async function loadLeftOffFor(
    ctx: RequestContext,
    session: sessionsRepo.SessionRecord,
    personaId: string,
  ): Promise<LeftOffData | null> {
    if (session.privacy !== 'standard') return null;
    try {
      return await kit.inRequest(ctx, ({ tx }) =>
        loadLeftOff(tx, {
          ventureId: session.ventureId,
          personaId,
          sessionId: session.id,
          principalId: ctx.principalId,
          privacy: session.privacy,
        }),
      );
    } catch (err) {
      logger.warn('turn.left_off_unavailable', {
        requestId: ctx.requestId,
        sessionId: session.id,
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
    /** The release the conversation is pinned to, as read with the preflight's other reads. */
    pinned: personasRepo.PersonaReleaseRecord | null,
  ): Promise<personasRepo.PersonaReleaseRecord> {
    if (session.personaReleaseId === active.release.id) return active.release;
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
   * Whether the per-person message limit applies to a turn. It counts typed messages and crisis messages on any
   * channel (`turnsRepo.countRecentTurnsByAuthorPart` with `channel: 'text'`, `includeCrisis`, read with the turn's
   * other checks); other spoken turns are limited by the calls service. Only an ordinary typed message is refused
   * for it: a crisis message is always answered (see {@link admitTurn}).
   */
  function messageLimitApplies(args: { readonly channel: TurnChannel; readonly crisis: boolean }): boolean {
    return args.channel === 'text' || args.crisis;
  }

  const MESSAGE_LIMIT_TEXT = 'You are sending messages very quickly. Please wait a few minutes.';

  /**
   * Step 1: authorize and check every gate except spend caps (owner-only ledger). `prefetch`: the conversation's
   * context reads already under way (turn-context.ts), used when the turn's own checks resolve to the same keys.
   */
  async function preflight(
    ctx: RequestContext,
    sessionId: string,
    input: z.output<typeof RunTurnInput>,
    crisis: boolean,
    prefetch: TurnContextPrefetch | null,
    tails: Promise<void>[],
  ): Promise<Proceed | Replay> {
    const { value: checked, ended } = await checkTurn(ctx, sessionId, input, crisis, prefetch);
    // Its commit is not waited for (it only read, or the result already waited for it: `wrote`).
    tails.push(kit.later(ended));
    return checked.kind === 'replay' ? checked : withContext(ctx, checked, tails);
  }

  /**
   * The preflight's transaction. When the prefetched context matches the turn's keys it is not waited for here: a
   * transaction that holds a connection never waits on another that needs one (a pool of N deadlocks under N such
   * turns); {@link withContext} waits for it once this transaction's work is done.
   *
   * Its reads are two statements (each one round trip on the Data API, where a transaction runs one statement at a
   * time): the conversation with everything the checks decide on, then the history. Every check runs on them in the
   * same order, with the same audits and errors, as when each was its own statement. Its result is used without
   * waiting for the commit, unless it wrote (a conversation re-pinned to the current release).
   */
  function checkTurn(
    ctx: RequestContext,
    sessionId: string,
    input: z.output<typeof RunTurnInput>,
    crisis: boolean,
    prefetch: TurnContextPrefetch | null,
  ): Promise<{ readonly value: Checked | Replay; readonly ended: Promise<void> }> {
    return kit.readInRequest(ctx, async (scope) => {
      const { tx } = scope;
      // The conversation, the caller's relationship to its venture, the settings, its turn count, the person's typed
      // messages in the rate window, the venture's active assignment with its release, and the release the
      // conversation is pinned to: keyed by the conversation, so one statement reads them all.
      const ventureRef = sessionsRepo.sessionVentureRef(sessionId);
      const first = await readTogether(tx, {
        session: sessionsRepo.sessionPart(sessionId),
        access: venturesRepo.ventureAccessPart({ ventureId: ventureRef, principalId: ctx.principalId }),
        settings: settingsRepo.platformSettingsPart(),
        turnCount: turnsRepo.countSessionTurnsPart(sessionId),
        typedRecently: turnsRepo.countRecentTurnsByAuthorPart({
          authorId: ctx.principalId,
          windowSeconds: cfg.turns.rateWindowSeconds,
          channel: 'text',
          includeCrisis: true,
        }),
        assignment: assignmentsRepo.activeAssignmentPart(ventureRef),
        release: personasRepo.activeReleasePart(assignmentsRepo.assignmentPersonaRef(ventureRef)),
        pinned: personasRepo.releasePart(sessionsRepo.sessionReleaseRef(sessionId)),
      });
      const { session } = first;
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
      enforceVentureAccess(scope, session.ventureId, first.access, 'write', {
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
      const { settings } = first;
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
      let coach: CoachBase | null = null;
      let context: Checked['context'] = null;
      let keys: TurnContextKeys | null = null;
      if (!crisis) {
        if (!settings.aiEnabled) {
          throw reject(
            'ai_disabled',
            'AI coaching is paused by the program. Please try again later.',
            'kill_switch',
          );
        }
        active = enforceAssignmentActive(
          scope,
          session.ventureId,
          first.assignment === null ? null : { ...first.assignment, release: first.release },
        );
        if (active.assignment.id !== session.assignmentId) {
          throw reject(
            'assignment_inactive',
            'The coaching assignment for this venture changed. Please start a new session.',
            'assignment_changed',
          );
        }
        const release = await conversationRelease(scope, session, active, first.pinned);
        // Re-pinned (written and audited): the result waits for the commit.
        if (release.id !== session.personaReleaseId) scope.wrote();
        const allowedModes = active.assignment.allowedModes.filter((m) => release.allowedModes.includes(m));
        if (mode !== null && !allowedModes.includes(mode)) {
          throw reject('forbidden', `Mode "${mode}" is not enabled for this venture`, 'mode_not_allowed');
        }
        if (allowedModes.length === 0) {
          throw reject('forbidden', 'No coaching mode is enabled for this venture', 'no_modes_allowed');
        }
        // The history in one statement: its ids, the newest rows (one batch: the Data API's 1 MB response) and the
        // interruptions among them; older rows, beyond the batch, in batches of their own.
        const recent = { sessionId, limit: cfg.turns.historyTurns };
        const historyRead = await readTogether(tx, {
          ...turnsRepo.recentTurnsParts(recent),
          interruptions: callsRepo.turnInterruptionsPart(turnsRepo.recentTurnIdsSubquery(recent)),
        });
        const history = await turnsRepo.recentTurnsFrom(tx, historyRead);
        const { interruptions } = historyRead;
        // The persona's presence (its EIR, first-person consent, whether that EIR is the venture's), the founder, the
        // notes, the earlier conversations and the venture: read beside this transaction when the keys were known and
        // still match, else here (turn-context.ts). The same reads either way.
        keys = {
          tenantId: ctx.tenantId,
          principalId: ctx.principalId,
          sessionId,
          ventureId: session.ventureId,
          personaId: active.persona.id,
          assignedEirProfileId: active.eir?.id ?? null,
          privacy: session.privacy,
        };
        if (prefetch !== null && sameTurnContextKeys(prefetch.keys, keys)) context = { prefetched: prefetch };
        else {
          if (prefetch !== null) prefetch.accounted = true;
          context = { read: await readTurnContext(tx, keys) };
          logger.info('turn.context', {
            requestId: ctx.requestId,
            source: prefetch === null ? 'read' : 'keys_changed',
          });
        }
        turnContexts.remember(keys);
        coach = {
          release,
          allowedModes,
          history,
          heardHistory: historyAsHeard(history, interruptions),
          // The opener is the conversation's first message: replayed while the history reaches back to it.
          opener:
            session.opener !== null && (history.length < cfg.turns.historyTurns || history[0]?.ordinal === 1)
              ? session.opener
              : null,
        };
      }
      const { turnCount } = first;
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
      // The per-person message limit (only an ordinary typed message is refused for it: see messageLimitApplies).
      if (!crisis && messageLimitApplies({ channel, crisis }) && first.typedRecently >= cfg.turns.rateLimit) {
        throw reject('rate_limited', MESSAGE_LIMIT_TEXT, 'turn_rate_limit', cfg.turns.rateWindowSeconds);
      }
      // A crisis turn reads no coach context: the venture is read here.
      const crisisVenture = crisis ? await venturesRepo.getVenture(tx, session.ventureId) : null;
      if (crisis && crisisVenture === null) throw fail.notFound('Venture');
      return {
        kind: 'checked',
        session,
        settings,
        active,
        mode,
        turnMode: mode ?? session.mode,
        channel,
        crisisVenture,
        coach,
        keys,
        context,
      };
    });
  }

  /**
   * Completes a checked turn with its context: the reads made in the preflight, or the prefetched ones (read again in a
   * transaction of their own if the prefetch failed). The coach and the venture are built from them alike.
   */
  async function withContext(
    ctx: RequestContext,
    checked: Checked,
    tails: Promise<void>[],
  ): Promise<Proceed> {
    const { session, coach: base, keys } = checked;
    let reads: TurnContextReads | null = null;
    if (checked.context !== null && keys !== null) {
      if ('read' in checked.context) reads = checked.context.read;
      else {
        const { prefetched } = checked.context;
        reads = await prefetched.reads;
        prefetched.accounted = true;
        logger.info('turn.context', {
          requestId: ctx.requestId,
          source: reads === null ? 'prefetch_failed' : 'prefetched',
        });
        reads ??= await kit.inRequest(ctx, ({ tx }) => readTurnContext(tx, keys));
      }
    }
    const venture = reads === null ? checked.crisisVenture : reads.venture;
    if (venture === null) throw fail.notFound('Venture');
    let coach: Coach | null = null;
    if (base !== null && reads !== null && checked.active !== null) {
      const { presence } = reads;
      // Read beside the admission, in its own transaction; it never outlives the turn.
      const leftOff = loadLeftOffFor(ctx, session, checked.active.persona.id);
      tails.push(kit.later(leftOff));
      coach = {
        ...base,
        personaEirName: presence.eirName,
        // A private conversation is one the EIR never reads (turns_read RLS, 0003): the vEIR never says there that its
        // EIR sees the work.
        presence: { ...presence, eirSeesWork: presence.eirSeesWork && session.privacy !== 'ephemeral' },
        memory: reads.memory,
        leftOff,
      };
    }
    return {
      kind: 'proceed',
      session,
      settings: checked.settings,
      active: checked.active,
      mode: checked.mode,
      turnMode: checked.turnMode,
      channel: checked.channel,
      venture,
      coach,
    };
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

  /**
   * A turn blocked or failed after its units may have been pre-approved for the call's FULL face (a streamed reply
   * admits each unit as it is sent, before the whole-reply check): withdraws what the face has not said. Called once
   * the page was told (`turn.blocked` / `turn.error`), so an honest page has stopped handing units over. Never throws.
   */
  async function withdrawFaceUnits(face: Promise<FaceApproval | null> | null): Promise<void> {
    if (face === null) return;
    const approval = await face.catch(() => null);
    await approval?.withdraw().catch(() => undefined);
  }

  /**
   * Signed `turn.speech` units of one voice turn (none once `signal`, the caller's, is aborted), each admitted to the
   * call's live FULL face as it is signed when `face` resolves to a pre-approval.
   */
  function speechStream(
    ctx: RequestContext,
    ids: { readonly sessionId: string; readonly turnId: string },
    emit: (e: TurnStreamEvent) => Promise<void>,
    key: Promise<SessionSigningKey>,
    signal?: AbortSignal,
    face: Promise<FaceApproval | null> | null = null,
  ): SpeechStream {
    return new SpeechStream(
      key,
      { ...ids, requestId: ctx.requestId },
      emit,
      (fields) => {
        logger.error('turn.speech_unsigned', fields);
      },
      signal,
      { face },
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
    // Found by the safety screen (indirect ideation the rules do not flag), not by a crisis rule.
    const screened = risk.matchedRules.includes(SAFETY_SCREEN_CRISIS_RULE);
    const validator: ValidatorResults = {
      unknownEvidenceIdsRemoved: 0,
      factsDowngraded: 0,
      groundingCoverage: null,
      narrowed: false,
      escalationForced: true,
      identityViolation: false,
      crossVentureViolation: false,
      riskCategories: risk.categories,
      notes: screened
        ? ['crisis_support', 'no_model_call', 'safety_screen']
        : ['crisis_support', 'no_model_call'],
    };
    const escalationId = await kit.inRequest(ctx, async (scope) => {
      const finished = await turnsRepo.finishTurn(scope.tx, {
        turnId: turn.id,
        status: 'blocked',
        response,
        // A screened crisis was admitted under the rules' label: the turn keeps the final one.
        ...(screened ? { riskLabel: riskLabel(risk), riskCategories: risk.categories } : {}),
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
        metadata: {
          escalationId: escalation.id,
          modelCalled: false,
          channel: pre.channel,
          ...(screened ? { safetyScreen: true } : {}),
        },
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
    /** The deterministic rules' classification the turn was admitted with (accepted() adds the safety screen's). */
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
    /**
     * The call's FULL face pre-approval, started while the turn was admitted (null: not a spoken turn of a call, or
     * no pre-approval wired). The crisis path never uses it: the crisis line never goes to a face.
     */
    readonly faceApproval: Promise<FaceApproval | null> | null;
    readonly emit: (e: TurnStreamEvent) => Promise<void>;
    readonly signal: AbortSignal | undefined;
    readonly startedAt: number;
    /** Work the turn hands to the host ({@link Kit.later}); runTurn waits for it before it returns when there is none. */
    readonly tails: Promise<void>[];
  }

  async function accepted(a: Accepted): Promise<RunTurnOutcome> {
    const { ctx, turn, pre, input, others, eirNames, addressees, emit, signal } = a;
    const ventureId = pre.session.ventureId;
    // Indirect ideation the crisis rules do not flag ("I'm thinking about ending it", "this is my last message"): a
    // prefilter hit asks the safety screen, which can only add a flag (safety-screen.ts). It runs only here, once the
    // turn is admitted: every gate (the message and in-flight limits, call admission, the spend caps) has refused a
    // request before it buys a call, as on main. Rare, so the common path pays nothing. Only with
    // `turns.safetyScreen` (CORE_SAFETY_SCREEN=on): off, the turn runs exactly as without it.
    const screen = cfg.turns.safetyScreen
      ? await screenIndirectIdeation(kit, {
          meter: { ctx, ventureId, purpose: 'classification' },
          founderText: input.text,
          previousReply: previousReplyOf(pre.coach),
          crisis: a.crisis || a.risk.crisis,
          ...(signal ? { signal } : {}),
        })
      : null;
    const risk = screen === null ? a.risk : withSafetyScreen(a.risk, screen);
    const label = riskLabel(risk);
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
    // were said when not distilled yet) has been loading since the preflight, in its own transaction: it never waits
    // for the distillation worker, and the turn never waits for it longer than for retrieval.
    await emit({ event: 'turn.status', phase: 'retrieving', detail: null, evidenceCount: null });
    const embedding =
      a.embedding ?? embedRetrievalQuery(kit, ctx, { purpose: 'turn', ventureId }, a.query, signal, a.tails);
    // The retrieval transaction opens while the query is embedded (its begin and context run beside the embedding,
    // which needs no database connection), and the search is used without waiting for the commit: it only reads.
    const { value: retrieved, ended } = await kit.readInRequest(ctx, async (scope) => {
      const vector = await embedding;
      const evidencePack = await retrieveEvidence(scope.tx, {
        tenantId: ctx.tenantId,
        ventureId,
        personaId: active.persona.id,
        stage: pre.venture.stage,
        query: a.query,
        embedding: vector,
        dataClassCeiling: active.assignment.dataClassCeiling,
        budgets: cfg.retrieval,
        channel: pre.channel,
        // Always null today: no session is readable by its author alone (see privateRetrievalOwner).
        privateOwnerId: privateRetrievalOwner(pre.session, ctx.principalId),
      });
      return { evidencePack, lexicalOnly: vector === null };
    });
    a.tails.push(kit.later(ended));
    const pack = retrieved.evidencePack;
    // What was retrieved for the turn is audited as before, written beside the reply rather than ahead of it (the
    // events are the request's: its tenant, person and request id).
    a.tails.push(
      kit.later(
        kit.flushDeferred(ctx, [
          {
            action: 'retrieval.authorized',
            outcome: 'allowed',
            ventureId,
            objectType: 'turn',
            objectId: turn.id,
            metadata: { ...pack.counts, lexicalOnly: retrieved.lexicalOnly },
          },
          ...(pack.dropped > 0
            ? [
                {
                  action: 'retrieval.denied',
                  outcome: 'denied' as const,
                  ventureId,
                  objectType: 'turn',
                  objectId: turn.id,
                  policyReason: 'isolation_filter',
                  metadata: { dropped: pack.dropped },
                },
              ]
            : []),
        ]),
      ),
    );
    await emit({
      event: 'turn.status',
      phase: 'retrieving',
      detail: `memory:${pack.counts.memory},documents:${pack.counts.chunks},library:${pack.counts.shared + pack.counts.resources + pack.counts.patterns}`,
      evidenceCount: pack.items.length,
    });
    const leftOffData = await coach.leftOff;
    const leftOffSection = renderLeftOffSection(leftOffData, {
      now: kit.now(),
      threads: leftOffThreads(coach.memory.continuity),
    });
    // The notes' earlier conversations, without the ones "Where you left off" already shows.
    const continuity = withoutLeftOff(coach.memory.continuity, leftOffData);

    // Steps 4–6: assemble the prompt, generate, validate (shared with the EIR studio's test bench).
    const answered = await answerTurn({
      kit,
      ctx,
      meter: { purpose: 'turn', ventureId },
      ids: { sessionId: pre.session.id, turnId: turn.id },
      release: coach.release,
      personaName: active.persona.name,
      personaEirName: coach.personaEirName,
      presence: coach.presence,
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
      continuity,
      leftOff: leftOffSection,
      evidence: pack.items,
      history: coach.heardHistory,
      opener: coach.opener,
      founderText: input.text,
      guards: { eirNames, addressees, others },
      emit,
      speechKey: a.speechKey,
      faceApproval: a.faceApproval,
      signal,
      startedAt: a.startedAt,
    });
    if (answered.kind === 'generation_failed') {
      const error = generationError(answered.cause);
      await failTurn(ctx, turn, error, answered.attempts);
      await emit(errorEvent(turn.id, error, ctx.requestId));
      await withdrawFaceUnits(a.faceApproval);
      return { status: 'failed', turnId: turn.id, replayed: false, error };
    }
    const { context, shown, generation, checked } = answered;
    const status = checked.blocked ? 'blocked' : 'completed';
    // What the turn taught is kept automatically, checked by its words now; its meaning is settled after the turn
    // completed (settleKeptMemory), so the reply never waits for an embedding. A decision, goal or constraint the
    // founder stated in plain first-person words is kept with it too when the model's candidates do not say it
    // (founder-statements.ts, LAB-K1: no model call; a chat is otherwise distilled only after nine idle minutes).
    const proposed = checked.response.memory_candidates;
    const stated =
      !checked.blocked && pre.session.privacy === 'standard'
        ? statedMemory(turn.founderText, {
            founderName: coach.memory.continuity.founderFirstName ?? null,
            modelCandidates: proposed,
          })
        : [];
    const keepable = !checked.blocked && pre.session.privacy === 'standard' ? [...proposed, ...stated] : [];
    // What the founder stated is recorded with the turn's own candidates: the answer's "Saved to Knowledge" line reads
    // them (LAB-K1: a decision kept from the founder's words showed no saved line, since only the model's candidates
    // were on the turn).
    const recorded =
      stated.length === 0 ? checked.response : { ...checked.response, memory_candidates: keepable };
    // A call ends a streamed reply with its last unit; a narrowed answer adds nothing aloud (Sources & reasoning
    // says it: LAB-M14). A reply written whole (streaming off, or a stream that broke, was empty or was not prose)
    // is said as its validated spoken form. A blocked turn says nothing more.
    const stream = generation.stream;
    const speech =
      stream?.speech ??
      (a.speechKey === null
        ? null
        : speechStream(
            ctx,
            { sessionId: pre.session.id, turnId: turn.id },
            emit,
            a.speechKey,
            signal,
            a.faceApproval,
          ));
    // True as well when nothing was streamed (`stream` null).
    const writtenWhole = stream?.fallback !== null;
    if (speech !== null) {
      if (checked.blocked) speech.discard();
      else if (writtenWhole) {
        await speech.queue(checked.response.spoken ?? deriveSpoken(checked.response.answer));
        await speech.finish();
      } else await speech.finish();
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
    const grounding = conversationGrounding([
      ...coach.history.map((t) => ({ founder: t.founderText, answer: t.response?.answer ?? null })),
      { founder: turn.founderText, answer: checked.response.answer },
    ]);
    const persisted = await kit.inRequest(ctx, async (scope) => {
      const { tx } = scope;
      const finished = await turnsRepo.finishTurn(tx, {
        turnId: turn.id,
        status,
        response: recorded,
        // The safety screen's wellbeing flag came after admission: the turn keeps the final classification.
        ...(screen !== null ? { riskLabel: label, riskCategories: risk.categories } : {}),
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
      const kept =
        keepable.length > 0
          ? await proposeMemoryCandidates(tx, {
              tenantId: ctx.tenantId,
              ventureId,
              createdBy: ctx.principalId,
              candidates: keepable,
              evidence: evidenceIndex,
              source: { kind: 'turn', id: turn.id, sessionId: pre.session.id },
              visibility: candidateVisibility(pack),
              // The coach's own advice is never kept as a fact unless the founder said or agreed to it.
              grounding,
              forgotten: await memoryRepo.listForgottenMemory(tx, { ventureId }),
            })
          : null;
      const candidates = kept?.records ?? [];
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
          digests: continuity.recentDigests?.length ?? 0,
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
      return { view, blocked: view.blocked, kept: kept?.createdRecords ?? [] };
    });

    if (persisted.blocked !== null) {
      await emit({ event: 'turn.blocked', turnId: turn.id, ...persisted.blocked });
      await withdrawFaceUnits(a.faceApproval);
      return { status: 'blocked', turnId: turn.id, replayed: false, error: null };
    }
    await emit({ event: 'turn.completed', turn: persisted.view });
    // Only now, with the reply complete: what the turn kept is settled by meaning (never throws). That embeds it, so
    // it runs after the response (LAB-P1: the stream stayed open, and the API busy, for a Titan call after every
    // turn that kept something): the host keeps the process alive for it, or the turn waits for it (tests).
    if (persisted.kept.length > 0) {
      const settling = settleKeptMemory(kit, ctx, {
        ventureId,
        sessionId: pre.session.id,
        items: persisted.kept,
        grounding,
      });
      if (kit.deps.afterResponse === undefined) await settling;
      else kit.deps.afterResponse(settling);
    }
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
      readonly settings: settingsRepo.ResolvedPlatformSettings;
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
      metadata?: AuditEvent['metadata'],
    ) => {
      scope.deferAudit({
        action: code === 'spend_cap_reached' ? 'spend_cap.reached' : 'turn.rejected',
        outcome: 'blocked',
        ventureId: args.ventureId,
        objectType: code === 'spend_cap_reached' ? 'turn' : 'session',
        objectId: code === 'spend_cap_reached' ? null : args.sessionId,
        policyReason: reason,
        ...(metadata === undefined ? {} : { metadata }),
      });
      return new DomainError(code, message, { reason, retryAfterSeconds });
    };
    // The person's admission lock, then the conversation's row (one statement). Preflight read the conversation in
    // its own transaction. Deleting or ending it since then must win: the conversation is re-checked under the lock
    // its delete and end take, so a turn admitted just after a delete is refused, and a delete that comes later waits
    // for this turn and erases it with the rest.
    if (
      !(await turnsRepo.lockTurnAdmissionAndSession(tx, {
        principalId: ctx.principalId,
        sessionId: args.sessionId,
      }))
    ) {
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
    // Every check's reads in one statement, read under the lock (a statement after the one that took it, so a turn
    // the person's previous admission just added is counted). The checks then run in their usual order.
    const countsMessages = messageLimitApplies(args);
    const voiceCall = !args.crisis && args.channel === 'voice' ? voiceTurnCallId(args.callId) : null;
    const parts: Record<string, ReadPart<unknown>> = {};
    if (countsMessages) {
      parts.recentMessages = turnsRepo.countRecentTurnsByAuthorPart({
        authorId: ctx.principalId,
        windowSeconds: cfg.turns.rateWindowSeconds,
        channel: 'text',
        includeCrisis: true,
      });
    }
    if (!args.crisis) {
      parts.inFlight = turnsRepo.countPendingTurnsByAuthorPart({
        authorId: ctx.principalId,
        withinSeconds: cfg.turns.inFlightWindowSeconds,
      });
      // Spend recorded by turns still in flight is not in the ledger yet; the in-flight limit bounds that.
      parts.spendCap = turnsRepo.spendCapStatePart({
        globalUsd: args.settings.dailyUsdCapGlobal,
        principalUsd: args.settings.dailyUsdCapPerPrincipal,
      });
    }
    if (voiceCall !== null) Object.assign(parts, voiceTurnReadParts(ctx.principalId, voiceCall));
    const reads = (await readTogether(tx, parts)) as {
      readonly recentMessages?: number;
      readonly inFlight?: number;
      readonly spendCap?: 'global' | 'principal' | null;
    } & Partial<VoiceTurnReads>;
    // The per-person message limit: typed messages and crisis messages on any channel (see messageLimitApplies).
    const overLimit = countsMessages && (reads.recentMessages ?? 0) >= cfg.turns.rateLimit;
    if (args.crisis) return overLimit && args.channel === 'voice' ? 'text' : args.channel;
    if (overLimit) {
      throw reject('rate_limited', MESSAGE_LIMIT_TEXT, 'turn_rate_limit', cfg.turns.rateWindowSeconds);
    }
    if ((reads.inFlight ?? 0) >= cfg.turns.maxInFlight) {
      throw reject(
        'rate_limited',
        'Please wait for the answers you are already waiting for.',
        'turns_in_flight',
        5,
      );
    }
    if (args.channel === 'voice') {
      await admitVoiceTurn(scope, {
        sessionId: args.sessionId,
        callId: args.callId,
        now: kit.now(),
        settings: args.settings,
        ...(voiceCall === null
          ? {}
          : {
              reads: {
                call: reads.call ?? null,
                usedSecondsToday: reads.usedSecondsToday ?? 0,
                recentVoiceTurns: reads.recentVoiceTurns ?? 0,
                callTurns: reads.callTurns ?? 0,
              },
            }),
      });
    }
    const cap = reads.spendCap ?? null;
    if (cap !== null) {
      throw reject(
        'spend_cap_reached',
        cap === 'global'
          ? 'The daily AI budget for the platform has been reached. Coaching resumes tomorrow (UTC).'
          : 'You have reached your daily AI coaching budget. It resets at midnight UTC.',
        `${cap}_daily_cap`,
        secondsUntilUtcMidnight(kit.now()),
        { scope: cap },
      );
    }
    return args.channel;
  }

  return {
    async runTurn(ctx, rawSessionId, rawInput, rawEmit, options = {}) {
      let prefetch: TurnContextPrefetch | null = null;
      // Work handed to the host's after-response work (Kit.later); without that hook, waited for before returning.
      const tails: Promise<void>[] = [];
      try {
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
        let faceApproval: Promise<FaceApproval | null> | null = null;
        let crisis = false;
        try {
          const sessionId = requireId(rawSessionId, 'Session');
          input = parseInput(RunTurnInput, rawInput);
          // Crisis detection does not depend on venture names; it decides which gates apply.
          crisis = classifyRisk(input.text).crisis;
          prefetch = crisis ? null : prefetchTurnContext(ctx, sessionId);
          const checked = await preflight(ctx, sessionId, input, crisis, prefetch, tails);
          if (checked.kind === 'replay') return await replay(ctx, emit, checked);
          pre = checked;
          // The spend caps are enforced by the admission, under its lock (the same refusal and audit as the check that
          // ran here, on one read of the day's spend).
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
          query = buildRetrievalQuery({
            founderText: parsed.text,
            previousAnswer: previousReplyOf(pre.coach),
            currentGoal: session.goal ?? pre.venture.currentGoal,
          });
          // Latency: the speech key loads while the turn is admitted.
          if (pre.channel === 'voice') {
            speechKey = speechKeys.signingKey();
            speechKey.catch(() => undefined); // a failure surfaces when a unit is signed
            // The call's FULL face, read once for the turn (a face that joins later takes its units via face/say).
            if (!crisis && parsed.callId !== undefined && facePreapproval !== undefined) {
              faceApproval = facePreapproval
                .prepareFaceApproval(ctx, { callId: parsed.callId, sessionId: session.id })
                .catch(() => null);
            }
          }
          const turnMode = pre.turnMode;
          let channel = pre.channel;
          // Nothing is written for the turn before this (the API's Idempotency-Key reservation).
          if (options.beforeAdmission !== undefined) await options.beforeAdmission;
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
            // The pending turn and its `turn.accepted` audit (its id and ordinal) in one statement.
            const created = await turnsRepo.createAuditedTurn(
              scope.tx,
              {
                tenantId: ctx.tenantId,
                ventureId: session.ventureId,
                sessionId: session.id,
                authorId: ctx.principalId,
                mode: turnMode,
                founderText: parsed.text,
                riskLabel: label,
                riskCategories: risk.categories,
                channel,
              },
              {
                action: 'turn.accepted',
                outcome: 'succeeded',
                ventureId: session.ventureId,
                metadata: {
                  sessionId: session.id,
                  mode: turnMode,
                  autoMode: pre.mode === null,
                  channel,
                  riskLabel: label,
                  riskRules: risk.matchedRules.slice(0, 20),
                },
              },
            );
            // Rolled back with its audit.
            if (parsed.expectedOrdinal !== undefined && created.ordinal !== parsed.expectedOrdinal) {
              throw fail.conflict(
                'The conversation changed in another window. Reload the session.',
                'ordinal_mismatch',
              );
            }
            return created;
          });
          // A spoken crisis message admitted as a typed one (past the message limit) says nothing on the call.
          if (channel !== pre.channel) {
            pre = { ...pre, channel };
            speechKey = null;
            faceApproval = null;
          }
          // The query embedding starts once the turn is admitted (a refused request buys no model call) and
          // overlaps the accepted and classifying events. A message the safety screen will read waits for its verdict
          // (accepted() embeds it then): a screened crisis makes no retrieval call.
          if (!crisis && !risk.crisis && !(cfg.turns.safetyScreen && safetyScreenDue(input.text))) {
            embedding = embedRetrievalQuery(
              kit,
              ctx,
              { purpose: 'turn', ventureId: session.ventureId },
              query,
              options.signal,
              tails,
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
            faceApproval,
            emit,
            signal: options.signal,
            startedAt,
            tails,
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
          await withdrawFaceUnits(faceApproval);
          return { status: 'failed', turnId: turn.id, replayed: false, error };
        }
      } finally {
        await endPrefetch(ctx, prefetch);
        await Promise.all(tails);
      }
    },
  };
}
