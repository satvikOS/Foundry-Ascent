import { DEFAULT_PERSONA_NAME, POLICY_VERSION, isModelGatewayError } from '@foundry/ai';
import {
  CreateSessionRequest,
  type ConversationOpenerResponse,
  type SessionDetailResponse,
  SessionListQuery,
  TurnFeedbackRequest,
  UpdateSessionRequest,
  type EvidenceItem,
  type SessionRecap,
  type SessionView,
} from '@foundry/contracts';
import {
  escalationsRepo,
  notebooksRepo,
  personasRepo,
  sessionsRepo,
  settingsRepo,
  turnsRepo,
  venturesRepo,
} from '@foundry/db';
import { type z } from 'zod';

import {
  requireAssignmentActive,
  requireModeAllowed,
  requireVentureAccess,
  type ActiveAssignment,
} from '../authz/venture-access.js';
import { type RequestContext } from '../context.js';
import { DomainError, fail, isDomainError, parseInput } from '../errors.js';
import { type DirectoryCache, type OtherVentures } from '../internal/directory.js';
import { audit, requireId, type Kit, type RequestScope } from '../internal/kit.js';
import { meteredStructured } from '../internal/metered.js';
import { participantTurnView, supportMessageFor } from '../orchestrator/blocked.js';
import { loadLeftOff, validatedOpener } from '../orchestrator/continuity.js';
import { continuityOpener, type LeftOffConversationData } from '../orchestrator/continuity-prompt.js';
import { assertWithinSpendCaps } from '../orchestrator/guards.js';
import { RECAP_SCHEMA_NAME, RecapDraft, buildRecapPrompt, sanitizeRecap } from '../orchestrator/recap.js';
import { persistMemoryCandidates } from './memory.js';

type SessionDetail = z.infer<typeof SessionDetailResponse>;

export interface EndSessionResult {
  readonly session: SessionView;
  readonly recap: SessionRecap | null;
}

/** One page of the caller's conversations (`GET /sessions`). */
export interface SessionPageResult {
  readonly items: SessionView[];
  readonly nextCursor: string | null;
}

export interface SessionsService {
  /**
   * Starts a session (founder/team). Resolves the active assignment and approved persona release
   * server-side, checks persona status, the kill switch, the mode and the daily spend caps. A standard
   * conversation opens with the vEIR's line, validated: the notebook's next opener, or a line picking up the
   * person's latest conversation (never for temporary chats).
   */
  create(
    ctx: RequestContext,
    ventureId: string,
    input: z.input<typeof CreateSessionRequest>,
  ): Promise<SessionView>;
  /**
   * How the vEIR would open a new standard conversation of the caller in this venture now (founder/team): the
   * opener `create` would store, and the latest earlier conversation it picks up. Nothing is written.
   */
  previewOpener(ctx: RequestContext, ventureId: string): Promise<ConversationOpenerResponse>;
  /** Sessions of a venture, latest activity first (founder/team). */
  list(ctx: RequestContext, ventureId: string): Promise<SessionView[]>;
  /**
   * The caller's conversations across every venture they work on (founder/team), latest activity first, one
   * page at a time: `mine` (started by the caller) or `all`, optionally for one venture.
   */
  listMine(ctx: RequestContext, query: z.input<typeof SessionListQuery>): Promise<SessionPageResult>;
  /**
   * Renames a conversation (founder/team); distillation never replaces a title a person chose. 409 for a
   * temporary chat, which keeps no title.
   */
  rename(
    ctx: RequestContext,
    sessionId: string,
    input: z.input<typeof UpdateSessionRequest>,
  ): Promise<SessionView>;
  /**
   * Deletes a conversation (founder/team): its content is erased like an ended temporary chat; the AI memory
   * proposals nobody kept, the escalations the founder never shared, and the notebook lines, summary and
   * opener drawn from it go too; it disappears from every list. Escalations the founder shared stay: they
   * went to a person with consent.
   */
  remove(ctx: RequestContext, sessionId: string): Promise<void>;
  /** Deletes a conversation's digest (founder/team); distillation never writes it again. */
  deleteDigest(ctx: RequestContext, sessionId: string): Promise<SessionView>;
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
  const { logger } = kit.deps;

  async function sessionView(
    tx: Parameters<typeof sessionsRepo.getSessionView>[0],
    id: string,
  ): Promise<SessionView> {
    const view = await sessionsRepo.getSessionView(tx, id);
    if (view === null) throw fail.notFound('Session');
    return view;
  }

  /**
   * The vEIR's opening line for a new standard conversation (its first bubble, and what a call says after
   * introducing itself), in this order:
   * 1. the notebook's next opener when a person wrote it (they chose what to open with);
   * 2. the notebook's next opener when distillation drew it from the person's latest conversation, or the
   *    notebook was written after that conversation's last turn (nothing was said since it was written);
   * 3. a line that picks up the person's latest conversation itself (when it was, what it was about), built
   *    without any model call from what was said, so it is right even before distillation ran
   *    (orchestrator/continuity-prompt.ts);
   * 4. an older notebook opener.
   * Every line must pass the opener checks (identity, cross-venture); one that fails is skipped. `opener` is
   * null when there is none (a first conversation). The phrasing of 3 follows the conversation it picks up (and
   * the person), so a preview and the conversation created next say the same, and each new conversation after
   * another one opens differently.
   */
  async function openerFor(
    scope: RequestScope,
    ventureId: string,
    active: ActiveAssignment,
    guards: { readonly others: OtherVentures; readonly eirNames: readonly string[] },
  ): Promise<{
    readonly opener: {
      readonly text: string;
      readonly sourceSessionId: string | null;
      readonly byPerson: boolean;
    } | null;
    readonly latest: LeftOffConversationData | null;
  }> {
    const notebook = await notebooksRepo.getNotebook(scope.tx, { ventureId, personaId: active.persona.id });
    const openerGuards = {
      personaName: active.persona.name,
      personaEirName: await personasRepo.getPersonaEirName(scope.tx, active.persona.id),
      eirNames: guards.eirNames,
      otherVentureNames: guards.others.names,
      otherVentureCanaries: guards.others.canaries,
      otherVentureMemberNames: guards.others.memberNames,
    };
    const next = notebook?.content.nextOpener ?? null;
    const stored = next === null ? null : validatedOpener(next, openerGuards);
    // The conversation it was drawn from, so deleting that conversation erases this copy too. A null source
    // means a person wrote it (the copy stays); a missing one means its origin is unknown, and deleting any
    // conversation of the venture erases the copy.
    const source = notebook?.content.nextOpenerSource;
    const last = await loadLeftOff(scope.tx, {
      ventureId,
      personaId: active.persona.id,
      sessionId: null,
      principalId: scope.ctx.principalId,
      privacy: 'standard',
      ownOnly: true,
    });
    const latest = last?.conversations[0] ?? null;
    const found = (
      opener: {
        readonly text: string;
        readonly sourceSessionId: string | null;
        readonly byPerson: boolean;
      } | null,
    ) => ({ opener, latest });
    if (stored !== null && source === null) {
      return found({ text: stored, sourceSessionId: null, byPerson: true });
    }
    const current =
      latest === null ||
      source === latest.sessionId ||
      (notebook?.updatedAt != null && Date.parse(notebook.updatedAt) > Date.parse(latest.lastActivityAt));
    if (stored !== null && current) {
      return found({ text: stored, sourceSessionId: source ?? null, byPerson: false });
    }
    if (latest !== null) {
      const seed = `${latest.sessionId}:${scope.ctx.principalId}`;
      const lines = continuityOpener(latest, { now: kit.now(), seed });
      for (const candidate of [lines.withTopic, lines.generic]) {
        const text = candidate === null ? null : validatedOpener(candidate, openerGuards);
        if (text !== null) return found({ text, sourceSessionId: latest.sessionId, byPerson: false });
      }
    }
    return found(stored === null ? null : { text: stored, sourceSessionId: source ?? null, byPerson: false });
  }

  /** The opener's guards, from the tenant directory (owner role, cached): read before a request transaction. */
  async function openerGuards(
    ctx: RequestContext,
    ventureId: string,
  ): Promise<{ readonly others: OtherVentures; readonly eirNames: readonly string[] }> {
    return {
      others: await directory.others(ctx.tenantId, ventureId),
      eirNames: (await directory.get(ctx.tenantId)).eirNames,
    };
  }

  /** The session (RLS-visible) of a founder/team request, or 404/403. */
  async function writableSession(
    scope: RequestScope,
    sessionId: string,
  ): Promise<sessionsRepo.SessionRecord> {
    const session = await sessionsRepo.getSession(scope.tx, sessionId);
    if (session === null) throw fail.notFound('Session');
    await requireVentureAccess(scope, session.ventureId, 'write', {
      objectType: 'session',
      objectId: sessionId,
    });
    return session;
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
      // The opener's guards come from the tenant directory (owner role), read before the writing transaction.
      const guards = input.privacy === 'standard' ? await openerGuards(ctx, ventureId) : null;
      return kit.inRequest(ctx, async (scope) => {
        // Re-resolved in the writing transaction: a suspension in between still blocks the session.
        const active = await requireAssignmentActive(scope, ventureId);
        requireModeAllowed(active, input.mode);
        const opener = guards === null ? null : (await openerFor(scope, ventureId, active, guards)).opener;
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
          // Temporary chats keep no title (their content is erased when they end).
          title: input.privacy === 'ephemeral' ? null : input.title,
          opener: opener?.text ?? null,
          openerSourceSessionId: opener?.sourceSessionId ?? null,
          openerByPerson: opener?.byPerson ?? false,
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
            opener: opener !== null,
          },
        });
        return sessionView(scope.tx, session.id);
      });
    },

    previewOpener: async (ctx, rawVentureId) => {
      const ventureId = requireId(rawVentureId, 'Venture');
      const guards = await openerGuards(ctx, ventureId);
      return kit.inRequest(ctx, async (scope) => {
        await requireVentureAccess(scope, ventureId, 'write', { objectType: 'session' });
        const { opener, latest } = await openerFor(
          scope,
          ventureId,
          await requireAssignmentActive(scope, ventureId),
          guards,
        );
        return {
          opener: opener?.text ?? null,
          lastConversation:
            latest === null
              ? null
              : {
                  sessionId: latest.sessionId,
                  lastActivityAt: latest.lastActivityAt,
                  channel: latest.channel,
                  title: latest.title,
                },
        };
      });
    },

    list: async (ctx, rawVentureId) => {
      const ventureId = requireId(rawVentureId, 'Venture');
      return await kit.inRequest(ctx, async (scope) => {
        await requireVentureAccess(scope, ventureId, 'write', { objectType: 'session' });
        return sessionsRepo.listSessionViews(scope.tx, { ventureId, limit: 100 });
      });
    },

    listMine: async (ctx, rawQuery) => {
      const query = parseInput(SessionListQuery, rawQuery);
      const ventureId = query.ventureId === undefined ? null : requireId(query.ventureId, 'Venture');
      if (query.cursor !== undefined && sessionsRepo.decodeSessionCursor(query.cursor) === null) {
        throw fail.validation('The page cursor is not valid', [
          { path: 'cursor', message: 'Invalid cursor' },
        ]);
      }
      return await kit.inRequest(ctx, async (scope) => {
        if (ventureId !== null) {
          await requireVentureAccess(scope, ventureId, 'write', { objectType: 'session' });
        }
        return sessionsRepo.listSessionPage(scope.tx, {
          principalId: ctx.principalId,
          scope: query.scope,
          ventureId,
          cursor: query.cursor ?? null,
          limit: query.limit,
        });
      });
    },

    rename: async (ctx, rawSessionId, rawInput) => {
      const sessionId = requireId(rawSessionId, 'Session');
      const input = parseInput(UpdateSessionRequest, rawInput);
      return await kit.inRequest(ctx, async (scope) => {
        const session = await writableSession(scope, sessionId);
        if (session.privacy !== 'standard') {
          throw fail.conflict('Temporary chats keep no title', 'temporary_chat');
        }
        if (input.title !== undefined) {
          await sessionsRepo.renameSession(scope.tx, { sessionId, title: input.title });
        }
        await audit(scope, {
          action: 'session.renamed',
          outcome: 'succeeded',
          ventureId: session.ventureId,
          objectType: 'session',
          objectId: sessionId,
        });
        return sessionView(scope.tx, sessionId);
      });
    },

    remove: async (ctx, rawSessionId) => {
      const sessionId = requireId(rawSessionId, 'Session');
      await kit.inRequest(ctx, async (scope) => {
        const session = await writableSession(scope, sessionId);
        if (!(await sessionsRepo.softDeleteSession(scope.tx, sessionId))) throw fail.notFound('Session');
        await audit(scope, {
          action: 'session.deleted',
          outcome: 'succeeded',
          ventureId: session.ventureId,
          objectType: 'session',
          objectId: sessionId,
          metadata: { privacy: session.privacy, status: session.status, hadDigest: session.digest !== null },
        });
      });
    },

    deleteDigest: async (ctx, rawSessionId) => {
      const sessionId = requireId(rawSessionId, 'Session');
      return await kit.inRequest(ctx, async (scope) => {
        const session = await writableSession(scope, sessionId);
        await sessionsRepo.deleteSessionDigest(scope.tx, sessionId);
        await audit(scope, {
          action: 'session.digest_deleted',
          outcome: 'succeeded',
          ventureId: session.ventureId,
          objectType: 'session',
          objectId: sessionId,
          metadata: { hadDigest: session.digest !== null },
        });
        return sessionView(scope.tx, sessionId);
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
          // Blocked turns carry their reason, support message and drafted escalation, so a reload shows
          // what the live stream showed (participant view: no risk categories or cross-venture detail).
          // Each turn names its author and carries the caller's own rating (thumbs survive a reload).
          turns: (await turnsRepo.listTurnViews(scope.tx, sessionId, supportMessageFor, ctx.principalId)).map(
            participantTurnView,
          ),
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
          const personaName = persona?.name ?? DEFAULT_PERSONA_NAME;
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
          const result = await meteredStructured(
            kit,
            { ctx, ventureId: session.ventureId, purpose: 'recap' },
            {
              system: prompt.system,
              messages: prompt.messages,
              schemaName: RECAP_SCHEMA_NAME,
              zodSchema: RecapDraft,
              timeoutMs: kit.config.turns.modelTimeoutMs,
            },
          );
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
            // Turn evidence can never cite a founder_private item (retrieval excludes them and the
            // turn_evidence insert policy rejects them), so a recap's candidates are team items.
            visibility: 'team',
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
        // Ephemeral sessions keep no conversation content beyond security records (audit, usage): the turns,
        // and the escalations drawn from them that the founder never shared, are erased.
        const temporary = session.privacy === 'ephemeral';
        const redacted = temporary ? await turnsRepo.redactSessionTurns(tx, sessionId) : 0;
        const escalationsErased = temporary
          ? await escalationsRepo.eraseUnsharedEscalations(tx, sessionId)
          : 0;
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
            escalationsErased,
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
