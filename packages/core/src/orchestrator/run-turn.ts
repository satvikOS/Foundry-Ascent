import {
  COACH_RESPONSE_SCHEMA_NAME,
  CRISIS_SUPPORT_MESSAGE,
  POLICY_VERSION,
  buildCrisisResponse,
  buildSystemPrompt,
  classifyRisk,
  isModelGatewayError,
  riskLabel,
  validateCoachResponse,
  type GenerateStructuredResult,
  type HistoryTurn,
  type ModelAttempt,
  type RiskClassification,
} from '@foundry/ai';
import {
  CoachResponse,
  CreateTurnRequest,
  type CoachMode,
  type PlatformSettingsView,
  type TurnStreamEvent,
  type TurnView,
  type ValidatorResults,
} from '@foundry/contracts';
import { escalationsRepo, sessionsRepo, settingsRepo, turnsRepo, venturesRepo } from '@foundry/db';
import type { z } from 'zod';

import {
  requireAssignmentActive,
  requireVentureAccess,
  type ActiveAssignment,
} from '../authz/venture-access.js';
import { type RequestContext } from '../context.js';
import { DomainError, fail, isDomainError, parseInput, toDomainError } from '../errors.js';
import { type DirectoryCache, type OtherVentures } from '../internal/directory.js';
import { audit, requireId, type Kit } from '../internal/kit.js';
import { createDraftEscalation } from '../services/escalations.js';
import { persistMemoryCandidates } from '../services/memory.js';
import { assembleContext } from './context-budget.js';
import { type KeyedEvidence } from './evidence.js';
import { assertWithinSpendCaps } from './guards.js';
import { retrieveEvidence } from './retrieval.js';
import { shouldSampleForReview } from './sampling.js';

/**
 * POST /sessions/:id/turns body. `expectedOrdinal` (the client's retry key) is part of the contract: when
 * a turn with this ordinal already exists for the same author and text, it is replayed from storage
 * instead of re-running.
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
   * `turn.error`. Never throws for domain failures: they are emitted (and returned in the outcome).
   */
  runTurn(
    ctx: RequestContext,
    sessionId: string,
    input: RunTurnInput,
    emit: TurnEmitter,
    options?: RunTurnOptions,
  ): Promise<RunTurnOutcome>;
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

function errorEvent(turnId: string | null, error: DomainError): TurnStreamEvent {
  return {
    event: 'turn.error',
    turnId,
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  };
}

function sumAttempts(attempts: readonly ModelAttempt[]): {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
} {
  return attempts.reduce(
    (acc, a) => ({
      inputTokens: acc.inputTokens + a.usage.inputTokens,
      outputTokens: acc.outputTokens + a.usage.outputTokens,
      costUsd: acc.costUsd + a.costUsd,
    }),
    { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  );
}

interface Proceed {
  readonly kind: 'proceed';
  readonly session: sessionsRepo.SessionRecord;
  readonly settings: PlatformSettingsView;
  /** Null only on the crisis path, which makes no model call and needs no coach. */
  readonly active: ActiveAssignment | null;
  readonly mode: CoachMode;
  readonly venture: venturesRepo.VentureRecord;
}

interface Replay {
  readonly kind: 'replay';
  readonly turn: turnsRepo.TurnRecord;
  readonly view: TurnView;
  readonly escalationId: string | null;
}

export function createOrchestrator(kit: Kit, directory: DirectoryCache): Orchestrator {
  const cfg = kit.config;
  const { logger, gateway } = kit.deps;

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
          const escalation = (
            await escalationsRepo.listVentureEscalations(tx, { ventureId: session.ventureId })
          ).find((e) => e.turnId === existing.id);
          return {
            kind: 'replay',
            turn: existing,
            view: turnsRepo.toTurnView(existing, evidence),
            escalationId: escalation?.id ?? null,
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
      const mode = input.mode ?? session.mode;
      // The crisis path answers with a fixed human-support message and makes no model call, so the AI
      // gates (kill switch, coach persona/assignment, mode) never stand between a founder and support.
      let active: ActiveAssignment | null = null;
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
        if (!active.allowedModes.includes(mode)) {
          throw reject('forbidden', `Mode "${mode}" is not enabled for this venture`, 'mode_not_allowed');
        }
      }
      const turnCount = await turnsRepo.countSessionTurns(tx, sessionId);
      if (turnCount >= settings.maxTurnsPerSession) {
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
      const recent = await turnsRepo.countRecentTurnsByAuthor(tx, {
        authorId: ctx.principalId,
        windowSeconds: cfg.turns.rateWindowSeconds,
      });
      if (recent >= cfg.turns.rateLimit) {
        throw reject(
          'rate_limited',
          'You are sending messages very quickly. Please wait a few minutes.',
          'turn_rate_limit',
          cfg.turns.rateWindowSeconds,
        );
      }
      const venture = await venturesRepo.getVenture(tx, session.ventureId);
      if (venture === null) throw fail.notFound('Venture');
      return { kind: 'proceed', session, settings, active, mode, venture };
    });
  }

  async function replay(emit: (e: TurnStreamEvent) => Promise<void>, r: Replay): Promise<RunTurnOutcome> {
    await emit({ event: 'turn.accepted', turnId: r.turn.id, ordinal: r.turn.ordinal });
    switch (r.turn.status) {
      case 'completed':
        await emit({ event: 'turn.completed', turn: r.view });
        return { status: 'completed', turnId: r.turn.id, replayed: true, error: null };
      case 'blocked': {
        const crisis = r.turn.riskLabel === 'crisis';
        await emit({
          event: 'turn.blocked',
          turnId: r.turn.id,
          reason: crisis
            ? 'crisis_support'
            : r.turn.validatorResults?.crossVentureViolation
              ? 'cross_venture'
              : 'identity',
          escalationId: r.escalationId,
          supportMessage: crisis ? CRISIS_SUPPORT_MESSAGE : null,
        });
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
        await emit(errorEvent(r.turn.id, error));
        return { status: 'failed', turnId: r.turn.id, replayed: true, error };
      }
      case 'pending': {
        const error = new DomainError('conflict', 'This message is still being answered. Please wait.', {
          reason: 'turn_pending',
          retryAfterSeconds: 5,
        });
        await emit(errorEvent(r.turn.id, error));
        return { status: 'failed', turnId: r.turn.id, replayed: true, error };
      }
    }
  }

  /** Marks an accepted turn failed (never throws) and records billable attempts. */
  async function failTurn(
    ctx: RequestContext,
    turn: turnsRepo.TurnRecord,
    error: DomainError,
    attempts: readonly ModelAttempt[],
  ): Promise<void> {
    const totals = sumAttempts(attempts);
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

  async function crisisPath(
    ctx: RequestContext,
    turn: turnsRepo.TurnRecord,
    pre: Proceed,
    risk: RiskClassification,
    emit: (e: TurnStreamEvent) => Promise<void>,
  ): Promise<RunTurnOutcome> {
    const response = buildCrisisResponse(pre.mode);
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
        mode: pre.mode,
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
        metadata: { escalationId: escalation.id, modelCalled: false },
      });
      return escalation.id;
    });
    await emit({
      event: 'turn.blocked',
      turnId: turn.id,
      reason: 'crisis_support',
      escalationId,
      supportMessage: CRISIS_SUPPORT_MESSAGE,
    });
    return { status: 'blocked', turnId: turn.id, replayed: false, error: null };
  }

  async function embedQuery(
    ctx: RequestContext,
    ventureId: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<number[] | null> {
    try {
      const result = await gateway.embed([text.slice(0, 8_000)], {
        purpose: 'embedding',
        requestId: ctx.requestId,
        ...(signal ? { signal } : {}),
      });
      await kit.recordUsage({
        ctx,
        ventureId,
        purpose: 'embedding',
        attempts: [{ modelId: result.modelId, usage: result.usage, costUsd: result.costUsd }],
      });
      return result.vectors[0] ?? null;
    } catch (err) {
      logger.warn('turn.query_embedding_failed', {
        requestId: ctx.requestId,
        error: err instanceof Error ? err.name : 'unknown',
      });
      return null;
    }
  }

  async function accepted(
    ctx: RequestContext,
    turn: turnsRepo.TurnRecord,
    pre: Proceed,
    input: z.output<typeof RunTurnInput>,
    risk: RiskClassification,
    others: OtherVentures,
    eirNames: readonly string[],
    emit: (e: TurnStreamEvent) => Promise<void>,
    signal: AbortSignal | undefined,
  ): Promise<RunTurnOutcome> {
    const label = riskLabel(risk);
    const ventureId = pre.session.ventureId;
    await emit({
      event: 'turn.status',
      phase: 'classifying',
      detail: label === 'none' ? null : label,
      evidenceCount: null,
    });

    // Step 2: crisis → human support, no model call.
    if (risk.crisis) return crisisPath(ctx, turn, pre, risk, emit);
    const active = pre.active;
    if (active === null)
      throw new DomainError('assignment_inactive', 'No active coach', { reason: 'no_assignment' });

    // Step 3: authorized, scoped retrieval.
    await emit({ event: 'turn.status', phase: 'retrieving', detail: null, evidenceCount: null });
    const embedding = await embedQuery(ctx, ventureId, input.text, signal);
    const { pack, history } = await kit.inRequest(ctx, async (scope) => {
      const evidencePack = await retrieveEvidence(scope.tx, {
        tenantId: ctx.tenantId,
        ventureId,
        personaId: active.persona.id,
        stage: pre.venture.stage,
        query: input.text,
        embedding,
        dataClassCeiling: active.assignment.dataClassCeiling,
        budgets: cfg.retrieval,
      });
      const recent = await turnsRepo.listRecentTurns(scope.tx, {
        sessionId: pre.session.id,
        limit: cfg.turns.historyTurns,
        beforeOrdinal: turn.ordinal,
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
      return {
        pack: evidencePack,
        history: recent.map((t): HistoryTurn => ({
          founderText: t.founderText,
          answer: t.response?.answer ?? null,
        })),
      };
    });
    await emit({
      event: 'turn.status',
      phase: 'retrieving',
      detail: `memory:${pack.counts.memory},documents:${pack.counts.chunks},library:${pack.counts.shared + pack.counts.resources + pack.counts.patterns}`,
      evidenceCount: pack.items.length,
    });

    // Step 4: assemble context (≤ maxInputTokens).
    const today = kit.now().toISOString().slice(0, 10);
    const system = buildSystemPrompt({
      release: {
        version: active.release.version,
        doctrine: active.release.doctrine,
        style: active.release.style,
        disclosureText: active.release.disclosureText,
        personaName: active.persona.name,
      },
      mode: pre.mode,
      policy: {
        riskCategories: risk.categories,
        groundingThreshold: pre.settings.groundingCoverageThreshold,
        crisis: false,
      },
      ventureContext: {
        name: pre.venture.name,
        stage: pre.venture.stage,
        domain: pre.venture.domain,
        currentGoal: pre.venture.currentGoal,
      },
      rehearsalCounterpart: pre.mode === 'rehearse' ? (input.rehearsalCounterpart ?? null) : null,
      today,
    });
    const context = assembleContext({
      system,
      evidence: pack.items.map((k) => k.item),
      history,
      founderText: input.text,
      maxInputTokens: cfg.turns.maxInputTokens,
      maxHistoryTurns: cfg.turns.historyTurns,
    });
    const shown: KeyedEvidence[] = pack.items.filter((k) => context.shownKeys.has(k.item.key));

    // Step 5: generate.
    await emit({ event: 'turn.status', phase: 'reasoning', detail: null, evidenceCount: shown.length });
    let result: GenerateStructuredResult<CoachResponse>;
    try {
      result = await gateway.generateStructured({
        purpose: 'turn',
        system,
        messages: context.messages,
        schemaName: COACH_RESPONSE_SCHEMA_NAME,
        zodSchema: CoachResponse,
        requestId: ctx.requestId,
        timeoutMs: cfg.turns.modelTimeoutMs,
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      const attempts = isModelGatewayError(err) ? err.attempts : [];
      await kit.recordUsage({ ctx, ventureId, purpose: 'turn', attempts });
      const error = isModelGatewayError(err)
        ? new DomainError('model_unavailable', 'The coach could not answer right now. Please try again.', {
            reason: err.code,
            retryAfterSeconds: 5,
            cause: err,
          })
        : asDomainError(err);
      await failTurn(ctx, turn, error, attempts);
      await emit(errorEvent(turn.id, error));
      return { status: 'failed', turnId: turn.id, replayed: false, error };
    }
    await kit.recordUsage({ ctx, ventureId, purpose: 'turn', attempts: result.attempts });

    // Step 6: deterministic validation.
    await emit({ event: 'turn.status', phase: 'validating', detail: null, evidenceCount: shown.length });
    const checked = validateCoachResponse(result.value, {
      evidenceKeys: new Set(shown.map((k) => k.item.key)),
      preRisk: risk,
      otherVentureNames: others.names,
      otherVentureCanaries: others.canaries,
      otherVentureMemberNames: others.memberNames,
      personaName: active.persona.name,
      coverageThreshold: pre.settings.groundingCoverageThreshold,
      expectedMode: pre.mode,
      eirNames,
    });
    const status = checked.blocked ? 'blocked' : 'completed';
    const sampled = shouldSampleForReview({
      status,
      riskLabel: label,
      validator: checked.results,
      response: checked.response,
      rate: cfg.turns.reviewSampleRate,
      random: kit.deps.random,
    });

    // Step 7: persist turn, evidence, memory candidates, escalation draft, audit.
    const evidenceIndex = new Map(shown.map((k) => [k.item.key, k.item] as const));
    const persisted = await kit.inRequest(ctx, async (scope) => {
      const { tx } = scope;
      const finished = await turnsRepo.finishTurn(tx, {
        turnId: turn.id,
        status,
        response: checked.response,
        validatorResults: checked.results,
        modelId: result.modelId,
        fallbackUsed: result.fallbackUsed,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costUsd: result.costUsd,
        latencyMs: Math.round(result.latencyMs),
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
        })),
      );
      const candidates =
        !checked.blocked && pre.session.privacy === 'standard'
          ? await persistMemoryCandidates(tx, {
              tenantId: ctx.tenantId,
              ventureId,
              createdBy: ctx.principalId,
              candidates: checked.response.memory_candidates,
              evidence: evidenceIndex,
              source: { kind: 'turn', id: turn.id },
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
          modelId: result.modelId,
          fallbackUsed: result.fallbackUsed,
          attempts: result.attempts.length,
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
        },
      });
      const evidence = (await turnsRepo.listTurnEvidence(tx, [turn.id])).get(turn.id) ?? [];
      return { view: turnsRepo.toTurnView(finished, evidence), escalationId };
    });

    if (checked.blocked) {
      await emit({
        event: 'turn.blocked',
        turnId: turn.id,
        reason: checked.blockReason ?? 'blocked',
        escalationId: persisted.escalationId,
        supportMessage: null,
      });
      return { status: 'blocked', turnId: turn.id, replayed: false, error: null };
    }
    await emit({ event: 'turn.completed', turn: persisted.view });
    return { status: 'completed', turnId: turn.id, replayed: false, error: null };
  }

  return {
    async runTurn(ctx, rawSessionId, rawInput, rawEmit, options = {}) {
      const emit = safeEmitter(rawEmit, ctx.requestId);
      let turn: turnsRepo.TurnRecord;
      let pre: Proceed;
      let input: z.output<typeof RunTurnInput>;
      let risk: RiskClassification;
      let others: OtherVentures;
      let eirNames: readonly string[];
      try {
        const sessionId = requireId(rawSessionId, 'Session');
        input = parseInput(RunTurnInput, rawInput);
        // Crisis detection does not depend on venture names; it decides which gates apply.
        const crisis = classifyRisk(input.text).crisis;
        const checked = await preflight(ctx, sessionId, input, crisis);
        if (checked.kind === 'replay') return await replay(emit, checked);
        pre = checked;
        if (!crisis) {
          await assertWithinSpendCaps(kit, ctx, pre.settings, {
            ventureId: pre.session.ventureId,
            operation: 'turn',
          });
        }
        others = await directory.others(ctx.tenantId, pre.session.ventureId);
        eirNames = (await directory.get(ctx.tenantId)).eirNames;
        risk = classifyRisk(input.text, {
          otherVentureNames: others.names,
          otherVentureMemberNames: others.memberNames,
        });
        const label = riskLabel(risk);
        const parsed = input;
        turn = await kit.inRequest(ctx, async (scope) => {
          const created = await turnsRepo.createTurn(scope.tx, {
            tenantId: ctx.tenantId,
            ventureId: pre.session.ventureId,
            sessionId: pre.session.id,
            authorId: ctx.principalId,
            mode: pre.mode,
            founderText: parsed.text,
            riskLabel: label,
            riskCategories: risk.categories,
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
            ventureId: pre.session.ventureId,
            objectType: 'turn',
            objectId: created.id,
            metadata: {
              sessionId: pre.session.id,
              ordinal: created.ordinal,
              mode: pre.mode,
              riskLabel: label,
              riskRules: risk.matchedRules.slice(0, 20),
            },
          });
          return created;
        });
      } catch (err) {
        const error = asDomainError(err);
        if (error.code === 'internal') {
          logger.error('turn.preflight_failed', {
            requestId: ctx.requestId,
            error: err instanceof Error ? err.name : 'unknown',
          });
        }
        await emit(errorEvent(null, error));
        return { status: 'rejected', turnId: null, replayed: false, error };
      }

      await emit({ event: 'turn.accepted', turnId: turn.id, ordinal: turn.ordinal });
      try {
        return await accepted(ctx, turn, pre, input, risk, others, eirNames, emit, options.signal);
      } catch (err) {
        const error = asDomainError(err);
        logger.error('turn.failed', {
          requestId: ctx.requestId,
          turnId: turn.id,
          code: error.code,
          error: err instanceof Error ? err.name : 'unknown',
        });
        await failTurn(ctx, turn, error, []);
        await emit(errorEvent(turn.id, error));
        return { status: 'failed', turnId: turn.id, replayed: false, error };
      }
    },
  };
}
