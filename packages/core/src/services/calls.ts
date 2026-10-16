import { rewriteIdentity, textsContainOtherVenture, toSpeakable } from '@foundry/ai';
import {
  CallHeartbeatRequest,
  EndCallRequest,
  InterruptTurnRequest,
  StartCallRequest,
  type CallDetailResponse,
  type CallHeartbeatResponse,
  type CallSummary,
  type EndCallResponse,
  type NextAction,
  type SpeechUnit,
  type StartCallResponse,
  type SttGrant,
} from '@foundry/contracts';
import {
  assignmentsRepo,
  callsRepo,
  notebooksRepo,
  personasRepo,
  principalsRepo,
  sessionsRepo,
  settingsRepo,
  turnsRepo,
  type SqlExecutor,
} from '@foundry/db';
import { type z } from 'zod';

import { type PlatformKeyCache } from '../auth/keys.js';
import { checkAssignment, requireAssignmentActive, requireVentureAccess } from '../authz/venture-access.js';
import { type RequestContext } from '../context.js';
import { DomainError, fail, parseInput } from '../errors.js';
import { type DirectoryCache } from '../internal/directory.js';
import { audit, requireId, type Kit, type RequestScope } from '../internal/kit.js';
import { secondsUntilUtcMidnight } from '../orchestrator/sampling.js';
import { signSpeechUnit } from '../orchestrator/speech-units.js';
import { SttGrantError } from '../ports.js';
import {
  CALL_LIMITS,
  STOP_REASON,
  callSecondsToday,
  callStopCause,
  callTimeLeft,
  newCallMaxSeconds,
  type CallConditions,
  type CallStopCause,
} from './call-usage.js';
import { DEFAULT_SPEECH_VOICE } from './voices.js';

/**
 * Voice calls (docs/architecture/calls.md §2). A call is a mode of a conversation: what is said becomes the
 * conversation's turns (`channel: 'voice'`, through the normal turn endpoint and its validators). This service
 * starts calls (admission, the speech-to-text grant and the signed intro), keeps them alive (heartbeats carry
 * the kill switches, consent and budgets), records barge-in, and ends them with a summary.
 */
export interface CallsService {
  /** Starts a call on an active conversation (founder/team, as themselves). */
  start(
    ctx: RequestContext,
    sessionId: string,
    input: z.input<typeof StartCallRequest>,
  ): Promise<StartCallResponse>;
  /** A fresh speech-to-text grant for a live call of the caller (reconnect, unmute). */
  sttGrant(ctx: RequestContext, callId: string): Promise<SttGrant>;
  /** Liveness every 15 s: time left, or `terminate` with the reason (the call is then ended). */
  heartbeat(
    ctx: RequestContext,
    callId: string,
    input: z.input<typeof CallHeartbeatRequest>,
  ): Promise<CallHeartbeatResponse>;
  /** Ends a call of the caller (idempotent) and summarizes it. */
  end(ctx: RequestContext, callId: string, input: z.input<typeof EndCallRequest>): Promise<EndCallResponse>;
  /** A call and, once it ended, its summary (venture members). */
  get(ctx: RequestContext, callId: string): Promise<z.infer<typeof CallDetailResponse>>;
  /** Barge-in: the founder spoke over a reply after hearing units 0…`heardSeq`. */
  interrupt(ctx: RequestContext, turnId: string, input: z.input<typeof InterruptTurnRequest>): Promise<void>;
}

/** Language and audio format of speech-to-text (the browser streams 16 kHz mono PCM). */
export const STT_LANGUAGE = 'en-US';
export const STT_SAMPLE_RATE_HERTZ = 16_000;
/** Next actions listed in a call summary. */
export const SUMMARY_MAX_ACTIONS = 10;

type PersonaVoiceFacts = Pick<personasRepo.PersonaRecord, 'kind' | 'embodiment'>;

/**
 * The voice a call speaks with: the persona's own voice (an EIR persona's only while its consent covers
 * voice; the neutral guide needs none), else the platform voice. Null when an EIR persona has a voice of its
 * own that its consent no longer covers: a call never falls back to another voice.
 */
export function callVoiceFor(persona: PersonaVoiceFacts, consentAssets: readonly string[]): string | null {
  const own = persona.embodiment.voiceId;
  if (own === null) return DEFAULT_SPEECH_VOICE;
  return persona.kind === 'neutral_guide' || consentAssets.includes('voice') ? own : null;
}

/** Whether a call's voice is still approved: the platform voice always; an EIR's own voice under consent. */
export function voiceApproved(
  voiceId: string,
  persona: PersonaVoiceFacts,
  consentAssets: readonly string[],
): boolean {
  return (
    voiceId === DEFAULT_SPEECH_VOICE || persona.kind === 'neutral_guide' || consentAssets.includes('voice')
  );
}

/** The founder's first name for a greeting (null when the display name does not start with a plain name). */
export function greetingName(displayName: string): string | null {
  const first = displayName.trim().split(/\s+/)[0] ?? '';
  return /^\p{L}[\p{L}'’-]{0,39}$/u.test(first) ? first : null;
}

/**
 * The words a call opens with (plain text): a greeting that says the vEIR is an AI, then the notebook opener
 * on a fresh conversation, or an invitation to continue one already under way.
 */
export function callIntroText(args: {
  readonly firstName: string | null;
  readonly personaName: string;
  readonly opener: string | null;
  readonly conversationStarted: boolean;
}): string {
  const hello =
    args.firstName === null
      ? `Hi, this is ${args.personaName}, an AI coach.`
      : `Hi ${args.firstName}, this is ${args.personaName}, an AI coach.`;
  const next =
    args.opener ??
    (args.conversationStarted ? 'Where would you like to pick up?' : 'What would you like to work on?');
  return `${hello} ${next}`;
}

/** Next actions of a call's replies without repeats (by their words), at most {@link SUMMARY_MAX_ACTIONS}. */
export function distinctActions(actions: readonly NextAction[]): NextAction[] {
  const seen = new Set<string>();
  const out: NextAction[] = [];
  for (const action of actions) {
    const key = action.action.normalize('NFKC').toLowerCase().replace(/\W+/gu, ' ').trim();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(action);
    if (out.length === SUMMARY_MAX_ACTIONS) break;
  }
  return out;
}

async function summarize(ex: SqlExecutor, call: callsRepo.CallRecord): Promise<CallSummary> {
  const turns = await callsRepo.listCallTurns(ex, call.id);
  const followUps = await callsRepo.callFollowUps(ex, {
    ventureId: call.ventureId,
    turnIds: turns.map((t) => t.id),
  });
  return {
    turnCount: turns.length,
    durationSeconds: call.elapsedSeconds,
    memoryProposalIds: followUps.memoryProposalIds,
    nextActions: distinctActions(turns.flatMap((t) => t.nextActions)),
    escalationIds: followUps.escalationIds,
  };
}

const CALLS_PAUSED = 'Calls are paused by the program. You can keep chatting.';

interface Started {
  readonly call: callsRepo.CallRecord;
  readonly ventureId: string;
  readonly personaName: string;
  readonly firstName: string | null;
  /** The notebook opener, offered only on a conversation without turns yet. */
  readonly opener: string | null;
  readonly conversationStarted: boolean;
}

export function createCallsService(
  kit: Kit,
  directory: DirectoryCache,
  keys: PlatformKeyCache,
): CallsService {
  const { logger } = kit.deps;

  /** The caller's own call; anyone else's (or none) is reported as not found. */
  async function ownCall(scope: RequestScope, callId: string): Promise<callsRepo.CallRecord> {
    const call = await callsRepo.getCall(scope.tx, callId);
    if (call?.startedBy !== scope.ctx.principalId) {
      scope.deferAudit({
        action: 'call.access',
        outcome: 'denied',
        ventureId: call?.ventureId ?? null,
        objectType: 'call',
        objectId: callId,
        policyReason: call === null ? 'call_not_visible' : 'not_call_owner',
      });
      throw fail.notFound('Call');
    }
    return call;
  }

  async function conditions(scope: RequestScope, call: callsRepo.CallRecord): Promise<CallConditions> {
    const { tx } = scope;
    const settings = await settingsRepo.getPlatformSettings(tx);
    const session = await sessionsRepo.getSession(tx, call.sessionId);
    const assignment = checkAssignment(await assignmentsRepo.resolveActiveAssignment(tx, call.ventureId));
    const persona = await personasRepo.getPersona(tx, call.personaId);
    const assets = persona === null ? [] : await personasRepo.personaConsentAssets(tx, call.personaId);
    const spendCap = await turnsRepo.spendCapState(tx, {
      globalUsd: settings.dailyUsdCapGlobal,
      principalUsd: settings.dailyUsdCapPerPrincipal,
    });
    return {
      aiEnabled: settings.aiEnabled,
      callsEnabled: settings.callsEnabled,
      sessionActive: session?.status === 'active',
      personaAvailable:
        !(assignment instanceof DomainError) &&
        assignment.persona.id === call.personaId &&
        assignment.assignment.id === session?.assignmentId,
      voiceApproved: persona !== null && voiceApproved(call.voiceId, persona, assets),
      idleSeconds: call.idleSeconds,
      spendCapReached: spendCap !== null,
      timeLeft: callTimeLeft({
        elapsedSeconds: call.elapsedSeconds,
        maxSeconds: call.maxSeconds,
        usedSecondsToday: await callSecondsToday(tx, scope.ctx.principalId),
        caps: settings,
      }),
    };
  }

  /** Ends a live call for `cause` (audited with the change); returns the call as it now stands. */
  async function stop(
    scope: RequestScope,
    call: callsRepo.CallRecord,
    cause: CallStopCause | 'replaced',
  ): Promise<callsRepo.CallRecord> {
    const ended = await callsRepo.endCall(scope.tx, {
      callId: call.id,
      reason: cause === 'replaced' ? 'navigated' : STOP_REASON[cause],
      detail: cause,
      ...(cause === 'stale_heartbeat'
        ? { atLastHeartbeat: { graceSeconds: CALL_LIMITS.staleGraceSeconds } }
        : {}),
    });
    if (ended === null) return (await callsRepo.getCall(scope.tx, call.id)) ?? call;
    await audit(scope, {
      action: cause === 'replaced' ? 'call.ended' : 'call.terminated',
      outcome: cause === 'replaced' ? 'succeeded' : 'blocked',
      ventureId: call.ventureId,
      objectType: 'call',
      objectId: call.id,
      policyReason: cause,
      metadata: { durationSeconds: ended.elapsedSeconds, reason: ended.endReason },
    });
    return ended;
  }

  /** The signed intro (null when it cannot be produced; the call then simply starts listening). */
  async function introFor(ctx: RequestContext, started: Started): Promise<SpeechUnit | null> {
    try {
      const { eirNames } = await directory.get(ctx.tenantId);
      const others = await directory.others(ctx.tenantId, started.ventureId);
      const safe = (text: string): boolean =>
        rewriteIdentity(text, { personaName: started.personaName, eirNames, checkHumanClaims: true }).findings
          .length === 0 &&
        !textsContainOtherVenture([text], others.names, others.canaries, others.memberNames);
      const opener = started.opener === null ? '' : toSpeakable(started.opener).trim();
      const base = { firstName: started.firstName, personaName: started.personaName };
      const candidates = [
        ...(opener === '' || !safe(opener)
          ? []
          : [callIntroText({ ...base, opener, conversationStarted: started.conversationStarted })]),
        callIntroText({ ...base, opener: null, conversationStarted: started.conversationStarted }),
      ];
      const text = candidates.find((candidate) => candidate.length <= 600 && safe(candidate));
      if (text === undefined) return null;
      const key = await keys.signingKey();
      return {
        text,
        sig: signSpeechUnit(key, { sessionId: started.call.sessionId, turnId: null, seq: 0, text }),
      };
    } catch (err) {
      logger.warn('call.intro_failed', {
        requestId: ctx.requestId,
        callId: started.call.id,
        error: err instanceof Error ? err.name : 'unknown',
      });
      return null;
    }
  }

  /** Mints a speech-to-text grant (already counted against the call). */
  async function mint(ctx: RequestContext, callId: string): Promise<SttGrant> {
    const issuer = kit.deps.sttGrants;
    if (issuer === undefined) {
      throw new DomainError(
        'speech_unavailable',
        'Speech recognition is not available on this server. You can type instead.',
        { reason: 'stt_not_configured' },
      );
    }
    try {
      const grant = await issuer.issue({
        languageCode: STT_LANGUAGE,
        sampleRateHertz: STT_SAMPLE_RATE_HERTZ,
        expiresInSeconds: CALL_LIMITS.sttGrantSeconds,
        requestId: ctx.requestId,
      });
      return {
        url: grant.url,
        expiresAt: grant.expiresAt,
        languageCode: STT_LANGUAGE,
        sampleRateHertz: STT_SAMPLE_RATE_HERTZ,
        mediaEncoding: 'pcm',
      };
    } catch (err) {
      logger.warn('call.stt_grant_failed', {
        requestId: ctx.requestId,
        callId,
        error: err instanceof Error ? err.name : 'unknown',
      });
      throw new DomainError(
        'model_unavailable',
        'Speech recognition is temporarily unavailable. You can type instead.',
        {
          reason: 'stt_grant_failed',
          retryAfterSeconds: 5,
          cause: err instanceof SttGrantError ? err : undefined,
        },
      );
    }
  }

  return {
    start: async (ctx, rawSessionId, rawInput) => {
      const sessionId = requireId(rawSessionId, 'Session');
      const input = parseInput(StartCallRequest, rawInput);
      const transcribe = input.inputMode === 'transcribe' && kit.deps.sttGrants !== undefined;
      const started = await kit.inRequest(ctx, async (scope): Promise<Started> => {
        const { tx } = scope;
        const session = await sessionsRepo.getSession(tx, sessionId);
        if (session === null) throw fail.notFound('Session');
        await requireVentureAccess(scope, session.ventureId, 'write', {
          objectType: 'session',
          objectId: sessionId,
        });
        const ventureId = session.ventureId;
        const refuse = (error: DomainError): DomainError => {
          scope.deferAudit({
            action: 'call.refused',
            outcome: 'blocked',
            ventureId,
            objectType: 'session',
            objectId: sessionId,
            policyReason: error.reason ?? error.code,
          });
          return error;
        };
        if (session.status !== 'active') {
          throw refuse(
            new DomainError('session_ended', 'This conversation has ended. Start a new one to call.', {
              reason: `session_${session.status}`,
            }),
          );
        }
        const settings = await settingsRepo.getPlatformSettings(tx);
        if (!settings.aiEnabled) {
          throw refuse(
            new DomainError('ai_disabled', 'AI coaching is paused by the program. Please try again later.', {
              reason: 'kill_switch',
            }),
          );
        }
        if (!settings.callsEnabled) {
          throw refuse(new DomainError('ai_disabled', CALLS_PAUSED, { reason: 'calls_disabled' }));
        }
        const active = await requireAssignmentActive(scope, ventureId);
        if (active.assignment.id !== session.assignmentId) {
          throw refuse(
            new DomainError(
              'assignment_inactive',
              'The coaching assignment for this venture changed. Start a new conversation to call.',
              { reason: 'assignment_changed' },
            ),
          );
        }
        const persona = await personasRepo.getPersona(tx, active.persona.id);
        if (persona === null) throw fail.notFound('Coach');
        const voiceId = callVoiceFor(persona, await personasRepo.personaConsentAssets(tx, persona.id));
        if (voiceId === null) {
          throw refuse(
            new DomainError(
              'persona_suspended',
              'This vEIR’s voice consent is not in force, so calls are paused.',
              {
                reason: 'voice_consent',
              },
            ),
          );
        }
        const spendCap = await turnsRepo.spendCapState(tx, {
          globalUsd: settings.dailyUsdCapGlobal,
          principalUsd: settings.dailyUsdCapPerPrincipal,
        });
        if (spendCap !== null) {
          throw refuse(
            new DomainError(
              'spend_cap_reached',
              spendCap === 'global'
                ? 'The daily AI budget for the platform has been reached. Coaching resumes tomorrow (UTC).'
                : 'You have reached your daily AI coaching budget. It resets at midnight UTC.',
              { reason: `${spendCap}_daily_cap`, retryAfterSeconds: secondsUntilUtcMidnight(kit.now()) },
            ),
          );
        }

        // One live call per person, serialised with the person's turn admission: a call whose client went
        // away is closed, a call in this conversation is replaced (a reload or a second tab), a live call
        // elsewhere is refused.
        await turnsRepo.lockTurnAdmission(tx, ctx.principalId);
        const previous = await callsRepo.getLiveCallOf(tx, ctx.principalId);
        if (previous !== null) {
          if (previous.idleSeconds > CALL_LIMITS.staleSeconds) await stop(scope, previous, 'stale_heartbeat');
          else if (previous.sessionId === sessionId) await stop(scope, previous, 'replaced');
          else {
            throw refuse(
              fail.conflict(
                'You are already in a call in another conversation. End it to start this one.',
                'call_in_progress',
              ),
            );
          }
        }
        const maxSeconds = newCallMaxSeconds(await callSecondsToday(tx, ctx.principalId), settings);
        if (maxSeconds < CALL_LIMITS.minStartSeconds) {
          throw refuse(
            new DomainError(
              'rate_limited',
              'You have used today’s call minutes. Calls reset at midnight UTC.',
              {
                reason: 'daily_call_minutes',
                retryAfterSeconds: secondsUntilUtcMidnight(kit.now()),
              },
            ),
          );
        }
        const inserted = await callsRepo.startCall(tx, {
          tenantId: ctx.tenantId,
          ventureId,
          sessionId,
          personaId: persona.id,
          startedBy: ctx.principalId,
          provider: persona.embodiment.provider,
          inputMode: transcribe ? 'transcribe' : 'typed',
          voiceId,
          maxSeconds,
        });
        const call = transcribe
          ? ((await callsRepo.recordSttGrant(tx, {
              callId: inserted.id,
              maxGrants: CALL_LIMITS.sttGrantsPerCall,
            })) ?? inserted)
          : inserted;
        await audit(scope, {
          action: 'call.started',
          outcome: 'succeeded',
          ventureId,
          objectType: 'call',
          objectId: call.id,
          metadata: {
            sessionId,
            provider: call.provider,
            inputMode: call.inputMode,
            maxSeconds,
            replacedCallId: previous?.sessionId === sessionId ? previous.id : null,
          },
        });
        const turnCount = await turnsRepo.countSessionTurns(tx, sessionId);
        const notebook =
          turnCount === 0 ? await notebooksRepo.getNotebook(tx, { ventureId, personaId: persona.id }) : null;
        const principal = await principalsRepo.getPrincipal(tx, ctx.principalId);
        return {
          call,
          ventureId,
          personaName: persona.name,
          firstName: principal === null ? null : greetingName(principal.displayName),
          opener: notebook?.content.nextOpener ?? null,
          conversationStarted: turnCount > 0,
        };
      });

      const intro = await introFor(ctx, started);
      let sttGrant: SttGrant | null = null;
      if (started.call.inputMode === 'transcribe') {
        // The call works without it (typed input); the client can ask again through `stt-grant`.
        sttGrant = await mint(ctx, started.call.id).catch(() => null);
      }
      return { call: callsRepo.toCallView(started.call), sttGrant, intro };
    },

    sttGrant: async (ctx, rawCallId) => {
      const callId = requireId(rawCallId, 'Call');
      await kit.inRequest(ctx, async (scope) => {
        const call = await ownCall(scope, callId);
        if (call.status !== 'live' || call.idleSeconds > CALL_LIMITS.staleSeconds) {
          throw fail.conflict('This call has ended.', 'call_not_active');
        }
        const settings = await settingsRepo.getPlatformSettings(scope.tx);
        if (!settings.aiEnabled || !settings.callsEnabled) {
          throw new DomainError('ai_disabled', CALLS_PAUSED, {
            reason: settings.aiEnabled ? 'calls_disabled' : 'kill_switch',
          });
        }
        if (kit.deps.sttGrants === undefined) return;
        const counted = await callsRepo.recordSttGrant(scope.tx, {
          callId,
          maxGrants: CALL_LIMITS.sttGrantsPerCall,
        });
        if (counted === null) {
          throw new DomainError('rate_limited', 'This call reconnected too often. Start a new call.', {
            reason: 'stt_grant_limit',
            retryAfterSeconds: 60,
          });
        }
        await audit(scope, {
          action: 'call.stt_granted',
          outcome: 'succeeded',
          ventureId: call.ventureId,
          objectType: 'call',
          objectId: callId,
          metadata: { grants: counted.sttGrants },
        });
      });
      return mint(ctx, callId);
    },

    heartbeat: async (ctx, rawCallId, rawInput) => {
      const callId = requireId(rawCallId, 'Call');
      const input = parseInput(CallHeartbeatRequest, rawInput);
      return kit.inRequest(ctx, async (scope): Promise<CallHeartbeatResponse> => {
        const call = await ownCall(scope, callId);
        if (call.status === 'ended')
          return { remainingSeconds: 0, action: 'terminate', reason: call.endReason };
        const state = await conditions(scope, call);
        const cause = callStopCause(state);
        if (cause !== null) {
          const ended = await stop(scope, call, cause);
          return { remainingSeconds: 0, action: 'terminate', reason: ended.endReason ?? STOP_REASON[cause] };
        }
        const beat = await callsRepo.recordHeartbeat(scope.tx, {
          callId,
          state: input.state,
          micOpenSeconds: input.micOpenSeconds,
        });
        if (beat === null) return { remainingSeconds: 0, action: 'terminate', reason: 'user' };
        return { remainingSeconds: state.timeLeft.seconds, action: 'continue', reason: null };
      });
    },

    end: async (ctx, rawCallId, rawInput) => {
      const callId = requireId(rawCallId, 'Call');
      const input = parseInput(EndCallRequest, rawInput);
      return kit.inRequest(ctx, async (scope): Promise<EndCallResponse> => {
        const { tx } = scope;
        let call = await ownCall(scope, callId);
        if (call.status === 'live') {
          const ended = await callsRepo.endCall(tx, {
            callId,
            reason: input.reason,
            detail: `client_${input.reason}`,
            ...(input.clientStats === undefined ? {} : { clientStats: input.clientStats }),
            // A client that went away and came back is charged until it went away.
            ...(call.idleSeconds > CALL_LIMITS.staleSeconds
              ? { atLastHeartbeat: { graceSeconds: CALL_LIMITS.staleGraceSeconds } }
              : {}),
          });
          if (ended !== null) {
            await audit(scope, {
              action: 'call.ended',
              outcome: 'succeeded',
              ventureId: call.ventureId,
              objectType: 'call',
              objectId: callId,
              metadata: { reason: input.reason, durationSeconds: ended.elapsedSeconds },
            });
          }
          call = ended ?? (await callsRepo.getCall(tx, callId)) ?? call;
        }
        return { call: callsRepo.toCallView(call), summary: await summarize(tx, call) };
      });
    },

    get: async (ctx, rawCallId) => {
      const callId = requireId(rawCallId, 'Call');
      return kit.inRequest(ctx, async (scope) => {
        const call = await callsRepo.getCall(scope.tx, callId);
        if (call === null) throw fail.notFound('Call');
        await requireVentureAccess(scope, call.ventureId, 'read', { objectType: 'call', objectId: callId });
        return {
          call: callsRepo.toCallView(call),
          summary: call.status === 'ended' ? await summarize(scope.tx, call) : null,
        };
      });
    },

    interrupt: async (ctx, rawTurnId, rawInput) => {
      const turnId = requireId(rawTurnId, 'Turn');
      const input = parseInput(InterruptTurnRequest, rawInput);
      const callId = requireId(input.callId, 'Call');
      if (input.heardSeq > callsRepo.MAX_SPEECH_SEQ) {
        throw fail.validation('The request is not valid', [{ path: 'heardSeq', message: 'Too large' }]);
      }
      await kit.inRequest(ctx, async (scope) => {
        const call = await ownCall(scope, callId);
        if (call.status !== 'live') throw fail.conflict('This call has ended.', 'call_not_active');
        const marked = await callsRepo.markTurnInterrupted(scope.tx, {
          turnId,
          callId,
          authorId: ctx.principalId,
          heardSeq: input.heardSeq,
        });
        if (marked === null) throw fail.notFound('Turn');
        await audit(scope, {
          action: 'turn.interrupted',
          outcome: 'succeeded',
          ventureId: call.ventureId,
          objectType: 'turn',
          objectId: turnId,
          metadata: { callId, heardSeq: marked.heardSeq },
        });
      });
    },
  };
}
