import { CRISIS_SPOKEN_MESSAGE } from '@foundry/ai';
import { type PlatformSettingsView, SpeechRequest } from '@foundry/contracts';
import { auditRepo, callsRepo, personasRepo, sessionsRepo, settingsRepo } from '@foundry/db';
import { type z } from 'zod';

import { type PlatformKeyCache } from '../auth/keys.js';
import { requireAssignmentActive, requireVentureAccess } from '../authz/venture-access.js';
import { type RequestContext } from '../context.js';
import { DomainError, fail, parseInput } from '../errors.js';
import { requireId, type Kit, type RequestScope } from '../internal/kit.js';
import { metered } from '../internal/metered.js';
import { assertWithinSpendCaps } from '../orchestrator/guards.js';
import { secondsUntilUtcMidnight } from '../orchestrator/sampling.js';
import { verifySpeechUnit } from '../orchestrator/speech-units.js';
import { SpeechSynthesisError, type SynthesizedSpeech } from '../ports.js';
import { refusalError, timeLimitRefusal } from './call-admission.js';
import { CALL_LIMITS, type CallCaps, callSecondsToday, callTimeLeft, speechBudget } from './call-usage.js';
import { voiceApproved } from './calls.js';
import { isCrisisMessage, speakableRunSpan, speakableText } from './spoken-text.js';
import { DEFAULT_SPEECH_VOICE, speechCostUsd, speechEngines } from './voices.js';

/**
 * Text-to-speech for calls (`POST /speech`). Calls speak only validated text:
 *  - a signed unit: a `turn.speech` unit of a turn (or the call intro, which has no turn) whose signature over
 *    `sessionId|turnId|seq|text` verifies; units of a turn that was blocked or failed are never spoken;
 *  - or, unsigned, the stored `spoken` form of a completed turn of the conversation: the whole of it, or one
 *    or more consecutive whole sentences of it (never a fragment); the stored words are what is spoken;
 *  - or the fixed crisis support message of the caller's own crisis turn of a call (below).
 * Speech belongs to the caller's live call in that conversation and speaks with the call's voice. Every
 * synthesis is metered in the usage ledger (purpose `speech`, priced per character) and checked against the
 * kill switches, the platform's daily spend cap, the call's time limits, the persona's status and its voice
 * consent. The per-person AI cap leaves speech out, so a call never ends early on a founder's chat budget;
 * speech is bounded by what calls can say instead, reserved atomically in the database before the speech
 * service is called (`callsRepo.reserveCallSpeech`):
 *  - the intro and each signed unit are synthesized once per call, a run of whole sentences of a stored reply
 *    twice; a synthesis that fails gives its play back;
 *  - a call synthesizes at most CALL_LIMITS.speechCharactersPerSecond characters per second it has lasted
 *    (plus a headroom for the intro and a reply fetched ahead), never more than that rate over its time limit
 *    (27,000 characters in a 30-minute call);
 *  - a person's calls synthesize at most that rate over the daily minute cap in a UTC day.
 *
 * Crisis support is never refused for call or budget reasons: the turn engine answers a crisis on a call with
 * the fixed CRISIS_SPOKEN_MESSAGE (no model call) and marks the turn blocked. That message is spoken for the
 * turn's author for a few minutes after the turn, a few times (counted atomically), whatever the call, the
 * switches and the spend caps say, in the call's voice while it is approved and in the platform voice
 * otherwise. It is still metered.
 */
export interface SpeechService {
  synthesize(
    ctx: RequestContext,
    input: z.input<typeof SpeechRequest>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SynthesizedSpeech>;
}

interface SpeechPlan {
  readonly ventureId: string;
  readonly callId: string;
  readonly voiceId: string;
  /** The words synthesized: the signed unit, or the stored words a request matched. */
  readonly text: string;
  /** What the call speaks (its syntheses are counted per call). */
  readonly unit: callsRepo.SpeechUnitKey;
  /** The daily spend caps and the speech budget; null for crisis support, which no cap stops. */
  readonly settings:
    | (Pick<PlatformSettingsView, 'dailyUsdCapGlobal' | 'dailyUsdCapPerPrincipal'> &
        Pick<CallCaps, 'dailyCallMinutesPerPrincipal'>)
    | null;
  readonly objectType: 'turn' | 'call';
  readonly objectId: string;
  readonly crisis: boolean;
}

type SpeechRefusal = Exclude<callsRepo.SpeechReservation, { ok: true }>['reason'];

function speechUnavailable(): DomainError {
  return new DomainError(
    'speech_unavailable',
    'Spoken replies are not available on this server; the browser reads replies aloud instead.',
    { reason: 'speech_not_configured' },
  );
}

/** The refusal of a reservation (`now` dates a wait until the daily reset). */
export function speechRefusal(reason: SpeechRefusal, crisis: boolean, now: Date): DomainError {
  switch (reason) {
    case 'call_not_active':
      return fail.conflict('Speech is only available during a live call.', 'call_not_active');
    case 'already_played':
      return crisis
        ? fail.conflict('This message was already played. It stays on screen.', 'crisis_speech_limit')
        : fail.conflict('This was already spoken. It stays on screen.', 'speech_already_played');
    case 'call_budget':
      return new DomainError(
        'rate_limited',
        'The vEIR has spoken as much as this call allows for now. Its replies stay on screen.',
        { reason: 'call_speech_limit', retryAfterSeconds: CALL_LIMITS.heartbeatSeconds },
      );
    case 'daily_budget':
      return new DomainError(
        'rate_limited',
        'Spoken replies reached today’s limit. Replies stay on screen; speech resets at midnight UTC.',
        { reason: 'daily_speech_limit', retryAfterSeconds: secondsUntilUtcMidnight(now) },
      );
  }
}

export function createSpeechService(kit: Kit, keys: PlatformKeyCache): SpeechService {
  const { logger } = kit.deps;

  function refuseText(scope: RequestScope, ventureId: string, turnId: string | null, reason: string): never {
    scope.deferAudit({
      action: 'speech.refused',
      outcome: 'denied',
      ventureId,
      objectType: turnId === null ? 'session' : 'turn',
      objectId: turnId,
      policyReason: reason,
    });
    throw fail.validation('Only the vEIR’s validated words can be spoken', [
      { path: reason === 'signature_invalid' ? 'sig' : 'text', message: 'Not validated text of this call' },
    ]);
  }

  /**
   * Reserves the synthesis of `plan` (`characters` long): a play of its unit and, outside crisis support, the
   * characters within the call's and the person's speech budget. A refusal is audited and thrown. Where no
   * speech service runs, a reservation that succeeded is rolled back with the 501 (the last check).
   */
  async function reserve(ctx: RequestContext, plan: SpeechPlan, characters: number): Promise<void> {
    const refusal = await kit.system(async (sx): Promise<SpeechRefusal | null> => {
      let refused: SpeechRefusal | null = null;
      if (plan.settings === null) {
        const plays = await callsRepo.reserveCrisisSpeech(sx, {
          callId: plan.callId,
          principalId: ctx.principalId,
          turnId: plan.objectId,
          characters,
          maxPlays: CALL_LIMITS.crisisSpeechReplays,
        });
        if (plays === null) refused = 'already_played';
      } else {
        const reservation = await callsRepo.reserveCallSpeech(sx, {
          callId: plan.callId,
          principalId: ctx.principalId,
          unit: plan.unit,
          characters,
          maxPlays: plan.unit.kind === 'run' ? CALL_LIMITS.speechRunPlays : CALL_LIMITS.speechUnitPlays,
          budget: speechBudget(plan.settings),
        });
        if (!reservation.ok) refused = reservation.reason;
      }
      // Thrown inside the transaction, so nothing stays reserved for a synthesis that will not happen.
      if (refused === null && kit.deps.speech === undefined) throw speechUnavailable();
      return refused;
    });
    if (refusal === null) return;
    const error = speechRefusal(refusal, plan.crisis, kit.now());
    await kit.flushDeferred(ctx, [
      {
        action: 'speech.refused',
        outcome: 'blocked',
        ventureId: plan.ventureId,
        objectType: plan.objectType,
        objectId: plan.objectId,
        policyReason: error.reason ?? error.code,
        metadata: { callId: plan.callId },
      },
    ]);
    throw error;
  }

  /**
   * Settles a reservation: `characters` billed (the counters follow the bill), or null when synthesis failed
   * (the play and the reserved characters are given back). Never throws.
   */
  async function settle(
    ctx: RequestContext,
    plan: SpeechPlan,
    reserved: number,
    characters: number | null,
  ): Promise<void> {
    try {
      await kit.system(
        (sx) =>
          callsRepo.settleCallSpeech(sx, {
            callId: plan.callId,
            unit: plan.unit,
            reservedCharacters: reserved,
            characters,
          }),
        { transaction: false },
      );
    } catch (err) {
      logger.error('speech.settle_failed', {
        requestId: ctx.requestId,
        callId: plan.callId,
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  /**
   * The plan for the crisis support message of `turn`, when the caller may hear it: their own crisis turn of a
   * call in this conversation, sent a few minutes ago at most. Null otherwise (the ordinary rules then apply).
   */
  async function crisisPlan(
    scope: RequestScope,
    turn: callsRepo.SpokenTurn,
    signatureValid: boolean,
  ): Promise<SpeechPlan | null> {
    if (
      !turn.crisisSupport ||
      turn.status !== 'blocked' ||
      turn.callId === null ||
      turn.authorId !== scope.ctx.principalId ||
      turn.ageSeconds > CALL_LIMITS.crisisSpeechWindowSeconds
    ) {
      return null;
    }
    if (!signatureValid) refuseText(scope, turn.ventureId, turn.turnId, 'signature_invalid');
    const call = await callsRepo.getCall(scope.tx, turn.callId);
    const persona = call === null ? null : await personasRepo.getPersona(scope.tx, call.personaId);
    const assets = persona === null ? [] : await personasRepo.personaConsentAssets(scope.tx, persona.id);
    const voiceId =
      call !== null && persona !== null && voiceApproved(call.voiceId, persona, assets)
        ? call.voiceId
        : DEFAULT_SPEECH_VOICE;
    return {
      ventureId: turn.ventureId,
      callId: turn.callId,
      voiceId,
      text: speakableText(CRISIS_SPOKEN_MESSAGE),
      unit: { kind: 'crisis', turnId: turn.turnId },
      settings: null,
      objectType: 'turn',
      objectId: turn.turnId,
      crisis: true,
    };
  }

  return {
    synthesize: async (ctx, rawInput, options = {}) => {
      const input = parseInput(SpeechRequest, rawInput);
      const sessionId = requireId(input.sessionId, 'Session');
      const turnId = input.turnId === null ? null : requireId(input.turnId, 'Turn');
      if ((input.seq === undefined) !== (input.sig === undefined)) {
        throw fail.validation('A speech unit carries both its sequence number and its signature', [
          { path: input.seq === undefined ? 'seq' : 'sig', message: 'Required with the other' },
        ]);
      }
      if (turnId === null && input.sig === undefined) {
        throw fail.validation('The call intro is spoken with its signature', [
          { path: 'sig', message: 'Required for the call intro' },
        ]);
      }
      const signed = input.sig !== undefined;
      const signatureValid =
        input.sig !== undefined &&
        verifySpeechUnit(
          await keys.verificationKeys(),
          { sessionId, turnId, seq: input.seq ?? 0, text: input.text },
          input.sig,
        );

      const plan = await kit.inRequest(ctx, async (scope): Promise<SpeechPlan> => {
        const { tx } = scope;
        const session = await sessionsRepo.getSession(tx, sessionId);
        if (session === null) throw fail.notFound('Session');
        await requireVentureAccess(scope, session.ventureId, 'write', {
          objectType: 'session',
          objectId: sessionId,
        });
        const turn = turnId === null ? null : await callsRepo.getSpokenTurn(tx, turnId);
        if (turnId !== null && turn?.sessionId !== sessionId) throw fail.notFound('Turn');
        if (turn !== null && isCrisisMessage(input.text)) {
          const crisis = await crisisPlan(scope, turn, !signed || signatureValid);
          if (crisis !== null) return crisis;
        }

        const settings = await settingsRepo.getPlatformSettings(tx);
        if (!settings.aiEnabled) {
          throw new DomainError(
            'ai_disabled',
            'AI coaching is paused by the program. Please try again later.',
            { reason: 'kill_switch' },
          );
        }
        if (!settings.callsEnabled) {
          throw new DomainError('ai_disabled', 'Calls are paused by the program. You can keep chatting.', {
            reason: 'calls_disabled',
          });
        }
        const active = await requireAssignmentActive(scope, session.ventureId);
        const call = await callsRepo.getLiveCallOf(tx, ctx.principalId);
        if (call?.sessionId !== sessionId || call.idleSeconds > CALL_LIMITS.staleSeconds) {
          throw fail.conflict('Speech is only available during a live call.', 'call_not_active');
        }
        const persona = await personasRepo.getPersona(tx, call.personaId);
        const assets = persona === null ? [] : await personasRepo.personaConsentAssets(tx, persona.id);
        if (
          persona === null ||
          active.persona.id !== call.personaId ||
          !voiceApproved(call.voiceId, persona, assets)
        ) {
          throw new DomainError('persona_suspended', 'This vEIR cannot speak right now.', {
            reason: 'voice_not_approved',
          });
        }
        const timeUp = timeLimitRefusal(
          callTimeLeft({
            elapsedSeconds: call.elapsedSeconds,
            maxSeconds: call.maxSeconds,
            usedSecondsToday: await callSecondsToday(tx, ctx.principalId),
            caps: settings,
          }),
        );
        if (timeUp !== null) throw refusalError(timeUp, kit.now());

        let text = speakableText(input.text);
        let unit: callsRepo.SpeechUnitKey =
          turn === null ? { kind: 'intro' } : { kind: 'unit', turnId: turn.turnId, seq: input.seq ?? 0 };
        if (turn !== null) {
          if (!signed) {
            if (turn.status !== 'completed') {
              throw fail.conflict('Only a completed reply can be spoken', 'turn_not_completed');
            }
            const stored = speakableRunSpan(input.text, turn.spoken);
            if (stored === null) refuseText(scope, session.ventureId, turnId, 'text_not_validated');
            text = stored.text;
            unit = { kind: 'run', turnId: turn.turnId, first: stored.first, last: stored.last };
          } else if (turn.status === 'blocked' || turn.status === 'failed') {
            // A unit passed the sentence gate, but the whole reply did not: it is never spoken again.
            throw fail.conflict('This reply can no longer be spoken.', 'turn_not_speakable');
          }
        }
        if (signed && !signatureValid) refuseText(scope, session.ventureId, turnId, 'signature_invalid');
        return {
          ventureId: session.ventureId,
          callId: call.id,
          voiceId: call.voiceId,
          text,
          unit,
          settings,
          objectType: turnId === null ? 'call' : 'turn',
          objectId: turnId ?? call.id,
          crisis: false,
        };
      });

      // Every check runs before the 501 below: a valid request tells the client to speak the text itself.
      if (plan.settings !== null) {
        // The platform's daily cap counts speech; the per-person AI cap does not (the speech budget does).
        await assertWithinSpendCaps(kit, ctx, plan.settings, {
          ventureId: plan.ventureId,
          operation: 'speech',
          caps: 'global',
        });
      }
      // The play and the characters are reserved before the speech service is called (one statement, so
      // concurrent requests cannot replay a unit or overrun a budget). Where no speech service runs, the
      // reservation is rolled back with the 501: it is the last check.
      const reserved = plan.text.length;
      await reserve(ctx, plan, reserved);
      const synthesizer = kit.deps.speech;
      if (synthesizer === undefined) throw speechUnavailable();

      let speech: SynthesizedSpeech;
      try {
        // Metered like every model call (one usage-ledger row, purpose `speech`, priced per character) once
        // synthesis succeeded: the service bills the characters whether or not playback finishes, and bills
        // nothing for a request it refused.
        ({ speech } = await metered(
          kit,
          { ctx, ventureId: plan.ventureId, purpose: 'speech' },
          async () => {
            const synthesized = await synthesizer.synthesize({
              text: plan.text,
              voiceId: plan.voiceId,
              engines: speechEngines(plan.voiceId),
              requestId: ctx.requestId,
              ...(options.signal === undefined ? {} : { signal: options.signal }),
            });
            return {
              speech: synthesized,
              attempts: [
                {
                  modelId: `polly:${synthesized.engine}:${synthesized.voiceId}`,
                  usage: { inputTokens: synthesized.characters, outputTokens: 0 },
                  costUsd: speechCostUsd(synthesized.characters, synthesized.engine),
                },
              ],
            };
          },
          () => [],
        ));
      } catch (err) {
        logger.warn('speech.synthesis_failed', {
          requestId: ctx.requestId,
          callId: plan.callId,
          error: err instanceof Error ? err.name : 'unknown',
        });
        // Nothing was billed: the play and the characters go back, so the client may ask again.
        await settle(ctx, plan, reserved, null);
        if (err instanceof SpeechSynthesisError || (err instanceof Error && err.name === 'AbortError')) {
          throw new DomainError(
            'model_unavailable',
            'Speech is temporarily unavailable. Try again shortly.',
            {
              reason: 'speech_failed',
              retryAfterSeconds: 5,
              cause: err,
            },
          );
        }
        throw err;
      }

      // The call's speech counter as billed, and the audit (ids and counts only).
      await settle(ctx, plan, reserved, speech.characters);
      try {
        await kit.system(
          (sx) =>
            auditRepo.appendAudit(sx, {
              action: 'speech.synthesized',
              outcome: 'succeeded',
              tenantId: ctx.tenantId,
              ventureId: plan.ventureId,
              actorId: ctx.principalId,
              requestId: ctx.requestId,
              objectType: plan.objectType,
              objectId: plan.objectId,
              ...(plan.crisis ? { policyReason: 'crisis_support' } : {}),
              metadata: {
                callId: plan.callId,
                characters: speech.characters,
                engine: speech.engine,
                voiceId: speech.voiceId,
                signed,
              },
            }),
          { transaction: false },
        );
      } catch (err) {
        logger.error('speech.record_failed', {
          requestId: ctx.requestId,
          callId: plan.callId,
          error: err instanceof Error ? err.name : 'unknown',
        });
      }
      return speech;
    },
  };
}
