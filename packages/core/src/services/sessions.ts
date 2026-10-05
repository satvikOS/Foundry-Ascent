import { POLICY_VERSION, isModelGatewayError } from '@foundry/ai';
import {
  CreateSessionRequest,
  type SessionDetailResponse,
  TurnFeedbackRequest,
  type EvidenceItem,
  type SessionRecap,
  type SessionView,
} from '@foundry/contracts';
import { personasRepo, sessionsRepo, settingsRepo, turnsRepo, venturesRepo } from '@foundry/db';
import { type z } from 'zod';

import {
  requireAssignmentActive,
  requireModeAllowed,
  requireVentureAccess,
} from '../authz/venture-access.js';
import { type RequestContext } from '../context.js';
import { DomainError, fail, isDomainError, parseInput } from '../errors.js';
import { type DirectoryCache } from '../internal/directory.js';
import { audit, requireId, type Kit } from '../internal/kit.js';
import { assertWithinSpendCaps } from '../orchestrator/guards.js';
import { RECAP_SCHEMA_NAME, RecapDraft, buildRecapPrompt, sanitizeRecap } from '../orchestrator/recap.js';
import { persistMemoryCandidates } from './memory.js';

type SessionDetail = z.infer<typeof SessionDetailResponse>;

export interface EndSessionResult {
  readonly session: SessionView;
  readonly recap: SessionRecap | null;
}

export interface SessionsService {
  /**
   * Starts a session (founder/team). Resolves the active assignment and approved persona release
   * server-side, checks persona status, the kill switch, the mode and the daily spend caps.
   */
  create(
    ctx: RequestContext,
    ventureId: string,
    input: z.input<typeof CreateSessionRequest>,
  ): Promise<SessionView>;
  /** Sessions of a venture, newest first (founder/team). */
  list(ctx: RequestContext, ventureId: string): Promise<SessionView[]>;
  /** Session with its turns and evidence (founder/team). */
  get(ctx: RequestContext, sessionId: string): Promise<SessionDetail>;
  /**
   * Ends a session. Standard sessions get a model recap (the five session-contract objects) and its
   * memory candidates are stored as `proposed`; ephemeral sessions keep no memory and their turn content
   * is erased. The recap is skipped (null) when AI is disabled, the spend cap is reached or the model fails.
   */
  end(ctx: RequestContext, sessionId: string): Promise<EndSessionResult>;
  /** Founder/team rating of a turn. */
  submitFeedback(
    ctx: RequestContext,
    turnId: string,
    input: z.input<typeof TurnFeedbackRequest>,
  ): Promise<{ feedbackId: string }>;
  /** Evidence of a turn (founder/team, or the assigned EIR for sampled turns). */
  getTurnEvidence(ctx: RequestContext, turnId: string): Promise<EvidenceItem[]>;
}

export function createSessionsService(kit: Kit, directory: DirectoryCache): SessionsService {
  const { logger, gateway } = kit.deps;

  async function sessionView(
    tx: Parameters<typeof sessionsRepo.getSessionView>[0],
    id: string,
  ): Promise<SessionView> {
    const view = await sessionsRepo.getSessionView(tx, id);
    if (view === null) throw fail.notFound('Session');
    return view;
  }

  return {
    create: async (ctx, rawVentureId, rawInput) => {
      const ventureId = requireId(rawVentureId, 'Venture');
      const input = parseInput(CreateSessionRequest, rawInput);
      const settings = await kit.inRequest(ctx, async (scope) => {
        await requireVentureAccess(scope, ventureId, 'write', { objectType: 'session' });
        const current = await settingsRepo.getPlatformSettings(scope.tx);
        if (!current.aiEnabled) {
          scope.deferAudit({
            action: 'session.rejected',
            outcome: 'blocked',
            ventureId,
            objectType: 'session',
            policyReason: 'kill_switch',
          });
          throw new DomainError(
            'ai_disabled',
            'AI coaching is paused by the program. Please try again later.',
            {
              reason: 'kill_switch',
            },
          );
        }
        requireModeAllowed(await requireAssignmentActive(scope, ventureId), input.mode);
        return current;
      });
      await assertWithinSpendCaps(kit, ctx, settings, { ventureId, operation: 'session' });
      return kit.inRequest(ctx, async (scope) => {
        // Re-resolved in the writing transaction: a suspension in between still blocks the session.
        const active = await requireAssignmentActive(scope, ventureId);
        requireModeAllowed(active, input.mode);
        const session = await sessionsRepo.createSession(scope.tx, {
          tenantId: ctx.tenantId,
          ventureId,
          assignmentId: active.assignment.id,
          personaReleaseId: active.release.id,
          startedBy: ctx.principalId,
          mode: input.mode,
          privacy: input.privacy,
          goal: input.goal,
          policyVersion: POLICY_VERSION,
        });
        await audit(scope, {
          action: 'session.started',
          outcome: 'succeeded',
          ventureId,
          objectType: 'session',
          objectId: session.id,
          metadata: {
            mode: input.mode,
            privacy: input.privacy,
            personaId: active.persona.id,
            releaseVersion: active.release.version,
            assignmentId: active.assignment.id,
          },
        });
        return sessionView(scope.tx, session.id);
      });
    },

    list: async (ctx, rawVentureId) => {
      const ventureId = requireId(rawVentureId, 'Venture');
      return await kit.inRequest(ctx, async (scope) => {
        await requireVentureAccess(scope, ventureId, 'write', { objectType: 'session' });
        return sessionsRepo.listSessionViews(scope.tx, { ventureId, limit: 100 });
      });
    },

    get: async (ctx, rawSessionId) => {
      const sessionId = requireId(rawSessionId, 'Session');
      return await kit.inRequest(ctx, async (scope) => {
        const session = await sessionsRepo.getSession(scope.tx, sessionId);
        if (session === null) throw fail.notFound('Session');
        await requireVentureAccess(scope, session.ventureId, 'write', {
          objectType: 'session',
          objectId: sessionId,
        });
        return {
          session: await sessionView(scope.tx, sessionId),
          turns: await turnsRepo.listTurnViews(scope.tx, sessionId),
        };
      });
    },

    end: async (ctx, rawSessionId) => {
      const sessionId = requireId(rawSessionId, 'Session');
      const loaded = await kit.inRequest(ctx, async (scope) => {
        const { tx } = scope;
        const session = await sessionsRepo.getSession(tx, sessionId);
        if (session === null) throw fail.notFound('Session');
        await requireVentureAccess(scope, session.ventureId, 'write', {
          objectType: 'session',
          objectId: sessionId,
        });
        if (session.status !== 'active') {
          throw new DomainError('session_ended', 'This session has already ended', {
            reason: `session_${session.status}`,
          });
        }
        const settings = await settingsRepo.getPlatformSettings(tx);
        const venture = await venturesRepo.getVenture(tx, session.ventureId);
        const release = await personasRepo.getRelease(tx, session.personaReleaseId);
        const persona = release ? await personasRepo.getPersona(tx, release.personaId) : null;
        const turns = (await turnsRepo.listTurns(tx, sessionId)).filter((t) => t.status === 'completed');
        const evidenceByTurn = await turnsRepo.listTurnEvidence(
          tx,
          turns.map((t) => t.id),
        );
        return { session, settings, venture, release, persona, turns, evidenceByTurn };
      });
      const { session, settings, venture, release, persona, turns, evidenceByTurn } = loaded;

      // Session-level evidence: unique references across turns, re-keyed E1…En.
      const evidence = new Map<string, EvidenceItem>();
      const seenRefs = new Set<string>();
      for (const t of turns) {
        for (const item of evidenceByTurn.get(t.id) ?? []) {
          const ref = `${item.kind}:${item.refId}`;
          if (seenRefs.has(ref) || evidence.size >= 20) continue;
          seenRefs.add(ref);
          const key = `E${evidence.size + 1}`;
          evidence.set(key, { ...item, key });
        }
      }

      let draft: ReturnType<typeof sanitizeRecap> = null;
      let recapSkipped: string | null = null;
      if (session.privacy === 'ephemeral') recapSkipped = 'ephemeral';
      else if (turns.length === 0) recapSkipped = 'no_turns';
      else if (!settings.aiEnabled) recapSkipped = 'kill_switch';
      else if (venture === null || release === null) recapSkipped = 'context_unavailable';
      if (recapSkipped === null && venture !== null && release !== null) {
        try {
          await assertWithinSpendCaps(kit, ctx, settings, {
            ventureId: session.ventureId,
            operation: 'recap',
          });
          const others = await directory.others(ctx.tenantId, session.ventureId);
          const personaName = persona?.name ?? 'Foundry Guide';
          const prompt = buildRecapPrompt({
            personaName,
            disclosure: release.disclosureText,
            venture: {
              name: venture.name,
              stage: venture.stage,
              domain: venture.domain,
              currentGoal: venture.currentGoal,
            },
            sessionGoal: session.goal,
            turns: turns.map((t) => ({ founderText: t.founderText, answer: t.response?.answer ?? null })),
            evidence: [...evidence.values()],
            today: kit.now().toISOString().slice(0, 10),
          });
          const result = await gateway
            .generateStructured({
              purpose: 'recap',
              system: prompt.system,
              messages: prompt.messages,
              schemaName: RECAP_SCHEMA_NAME,
              zodSchema: RecapDraft,
              requestId: ctx.requestId,
              timeoutMs: kit.config.turns.modelTimeoutMs,
            })
            .catch(async (err: unknown) => {
              if (isModelGatewayError(err)) {
                await kit.recordUsage({
                  ctx,
                  ventureId: session.ventureId,
                  purpose: 'recap',
                  attempts: err.attempts,
                });
              }
              throw err;
            });
          await kit.recordUsage({
            ctx,
            ventureId: session.ventureId,
            purpose: 'recap',
            attempts: result.attempts,
          });
          draft = sanitizeRecap(result.value, {
            evidence,
            otherVentureNames: others.names,
            otherVentureCanaries: others.canaries,
            otherVentureMemberNames: others.memberNames,
            personaName,
            eirNames: (await directory.get(ctx.tenantId)).eirNames,
          });
          if (draft === null) recapSkipped = 'cross_venture_blocked';
        } catch (err) {
          recapSkipped = isDomainError(err) ? err.code : isModelGatewayError(err) ? err.code : 'recap_failed';
          logger.warn('session.recap_skipped', {
            requestId: ctx.requestId,
            sessionId,
            reason: recapSkipped,
            error: err instanceof Error ? err.name : 'unknown',
          });
        }
      }

      return kit.inRequest(ctx, async (scope) => {
        const { tx } = scope;
        let recap: SessionRecap | null = null;
        let candidateCount = 0;
        if (draft !== null) {
          const created = await persistMemoryCandidates(tx, {
            tenantId: ctx.tenantId,
            ventureId: session.ventureId,
            createdBy: ctx.principalId,
            candidates: draft.candidates,
            evidence,
            source: { kind: 'session', id: sessionId },
          });
          candidateCount = created.length;
          recap = {
            ...draft.recap,
            memory_candidate_ids: created.map((m) => m.id),
            generated_at: kit.now().toISOString(),
          };
        }
        const ended = await sessionsRepo.endSession(tx, { sessionId, recap });
        if (ended === null) {
          throw new DomainError('session_ended', 'This session has already ended', {
            reason: 'concurrent_end',
          });
        }
        // Ephemeral sessions keep no conversation content beyond security records (audit, usage).
        const redacted =
          session.privacy === 'ephemeral' ? await turnsRepo.redactSessionTurns(tx, sessionId) : 0;
        await audit(scope, {
          action: 'session.ended',
          outcome: 'succeeded',
          ventureId: session.ventureId,
          objectType: 'session',
          objectId: sessionId,
          metadata: {
            turns: turns.length,
            recap: recap !== null,
            recapSkipped,
            memoryCandidates: candidateCount,
            privacy: session.privacy,
            redactedTurns: redacted,
          },
        });
        return { session: await sessionView(tx, sessionId), recap };
      });
    },

    submitFeedback: async (ctx, rawTurnId, rawInput) => {
      const turnId = requireId(rawTurnId, 'Turn');
      const input = parseInput(TurnFeedbackRequest, rawInput);
      return await kit.inRequest(ctx, async (scope) => {
        const turn = await turnsRepo.getTurn(scope.tx, turnId);
        if (turn === null) throw fail.notFound('Turn');
        await requireVentureAccess(scope, turn.ventureId, 'write', { objectType: 'turn', objectId: turnId });
        const feedbackId = await turnsRepo.upsertFeedback(scope.tx, {
          turnId,
          ventureId: turn.ventureId,
          principalId: ctx.principalId,
          rating: input.rating,
          flags: input.flags,
          comment: input.comment,
        });
        await audit(scope, {
          action: 'turn.feedback',
          outcome: 'succeeded',
          ventureId: turn.ventureId,
          objectType: 'turn',
          objectId: turnId,
          metadata: { rating: input.rating, flags: input.flags },
        });
        return { feedbackId };
      });
    },

    getTurnEvidence: async (ctx, rawTurnId) => {
      const turnId = requireId(rawTurnId, 'Turn');
      return await kit.inRequest(ctx, async (scope) => {
        const turn = await turnsRepo.getTurn(scope.tx, turnId);
        if (turn === null) throw fail.notFound('Turn');
        const decision = await requireVentureAccess(scope, turn.ventureId, 'read', {
          objectType: 'turn',
          objectId: turnId,
        });
        if (!decision.canWrite && !(decision.isAssignedEir && turn.sampledForReview)) {
          scope.deferAudit({
            action: 'venture.access',
            outcome: 'denied',
            ventureId: turn.ventureId,
            objectType: 'turn',
            objectId: turnId,
            policyReason: 'turn_not_shared',
          });
          throw fail.notFound('Turn');
        }
        return (await turnsRepo.listTurnEvidence(scope.tx, [turnId])).get(turnId) ?? [];
      });
    },
  };
}
