import { CRISIS_SPOKEN_MESSAGE } from '@foundry/ai';
import { type PlatformSettingsView, SpeechRequest } from '@foundry/contracts';
import { auditRepo, callsRepo, personasRepo, sessionsRepo, settingsRepo, twinRepo } from '@foundry/db';
import { type z } from 'zod';

import { type PlatformKeyCache } from '../auth/keys.js';
import { requireAssignmentActive, requireVentureAccess } from '../authz/venture-access.js';
import { type RequestContext } from '../context.js';
import { DomainError, fail, parseInput } from '../errors.js';
import { requireId, type AuditEvent, type Kit, type RequestScope } from '../internal/kit.js';
import { enforceSpendCaps, readSpendState } from '../orchestrator/guards.js';
import { secondsUntilUtcMidnight } from '../orchestrator/sampling.js';
import {
  FACE_SAMPLE_RATE,
  pcmToWav,
  readAll,
  resamplePcm16,
  signFaceAudio,
  wholeSamples,
} from '../orchestrator/face-audio.js';
import { verifiedSpeechUnit, verifySpeechUnit } from '../orchestrator/speech-units.js';
import {
  SpeechSynthesisError,
  type SynthesizedSpeech,
  type VerifiedSpeechUnit,
  type VoiceProvider,
} from '../ports.js';
import { refusalError, timeLimitRefusal } from './call-admission.js';
import { CALL_LIMITS, type CallCaps, callSecondsToday, callTimeLeft, speechBudget } from './call-usage.js';
import { callCanSpeak, voiceApproved } from './calls.js';
import { voiceCostUsd } from './media-vendors.js';
import { isCrisisMessage, speakableRunSpan, speakableText } from './spoken-text.js';
import { observedAudio } from './speech-audio.js';
import { DEFAULT_SPEECH_VOICE, speechCostUsd, speechEngines } from './voices.js';

/**
 * How one unit is voiced: the EIR's cloned voice (a signed unit of a call that started with it, while cloned
 * voices are on and the voice is ready under voice consent) or an Amazon Polly voice.
 */
export type SpokenVoice =
  | { readonly kind: 'clone'; readonly provider: VoiceProvider; readonly ref: string }
  | { readonly kind: 'polly'; readonly voiceId: string };

/**
 * The voice of a planned unit (pure). The clone speaks only validated, signed words (`verified`), never the crisis
 * line, and only in a call that started with it; otherwise the call's stock voice, or the platform voice when that
 * call's clone was withdrawn and its stock voice is the EIR's own (no consent left): never someone else's voice.
 */
export function chooseVoice(args: {
  readonly call: Pick<callsRepo.CallRecord, 'voiceId' | 'voiceVendor'>;
  readonly persona: Parameters<typeof voiceApproved>[1];
  readonly assets: readonly string[];
  readonly clonedVoiceEnabled: boolean;
  readonly provider: VoiceProvider | undefined;
  readonly twinVoice: { readonly ref: string } | null;
  readonly verified: boolean;
  readonly crisis: boolean;
}): SpokenVoice {
  const { call, provider } = args;
  if (
    !args.crisis &&
    args.verified &&
    args.clonedVoiceEnabled &&
    provider?.id === call.voiceVendor &&
    args.twinVoice !== null
  ) {
    return { kind: 'clone', provider, ref: args.twinVoice.ref };
  }
  return {
    kind: 'polly',
    voiceId: voiceApproved(call.voiceId, args.persona, args.assets) ? call.voiceId : DEFAULT_SPEECH_VOICE,
  };
}

/** The most raw PCM a unit may come back as (45 s at 24 kHz with room to spare). */
const MAX_FACE_PCM_BYTES = 4 * 1024 * 1024;

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
  /** How it is voiced (crisis support: always a Polly voice). */
  readonly voice: SpokenVoice;
  /** The signed unit (or intro) whose signature verified; null for stored-reply runs and crisis support. */
  readonly verified: VerifiedSpeechUnit | null;
  /** The call's live face, when this unit may be shown on it (a verified unit; faces on; likeness in force). */
  readonly face: { readonly sessionRef: string } | null;
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

const NO_TWIN: twinRepo.PersonaTwin = { face: null, voice: null };

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export function createSpeechService(kit: Kit, keys: PlatformKeyCache): SpeechService {
  const { logger } = kit.deps;

  /** Whether something can voice the plan here (the clone, or Amazon Polly). */
  function voiceAvailable(plan: SpeechPlan): boolean {
    return plan.voice.kind === 'clone' || kit.deps.speech !== undefined;
  }

  /**
   * The call's live face, when a unit may be shown on it now: faces on, the provider that started it still wired,
   * and (for a real likeness) the persona's face ready under likeness consent.
   */
  async function liveFaceFor(
    callId: string,
    now: { readonly facesEnabled: boolean; readonly twinFace: { readonly ref: string } | null },
  ): Promise<{ readonly sessionRef: string } | null> {
    const provider = kit.deps.embodiment;
    if (provider === undefined || !now.facesEnabled || (provider.likeness && now.twinFace === null))
      return null;
    const face = await kit.system((sx) => twinRepo.getCallFace(sx, callId), { transaction: false });
    return face?.endedAt === null && face.vendor === provider.id ? { sessionRef: face.sessionRef } : null;
  }

  /**
   * Synthesizes a plan with its voice. For a unit the face may show, the audio is 24 kHz PCM in a WAV container,
   * with its face-audio manifest (the browser plays the WAV itself whenever the face cannot render it).
   */
  async function synthesizePlan(
    ctx: RequestContext,
    plan: SpeechPlan,
    signal: AbortSignal | undefined,
  ): Promise<SynthesizedSpeech> {
    const forFace = plan.face !== null;
    let speech: SynthesizedSpeech;
    if (plan.voice.kind === 'clone') {
      // The clone is handed only a unit this request verified (chooseVoice never picks it otherwise).
      if (plan.verified === null)
        throw new SpeechSynthesisError('the cloned voice speaks only verified units');
      speech = await plan.voice.provider.synthesize({
        unit: plan.verified,
        voiceRef: plan.voice.ref,
        format: forFace ? 'pcm_24000' : 'mp3',
        requestId: ctx.requestId,
        ...(signal === undefined ? {} : { signal }),
      });
    } else {
      const synthesizer = kit.deps.speech;
      if (synthesizer === undefined) throw speechUnavailable();
      speech = await synthesizer.synthesize({
        text: plan.text,
        voiceId: plan.voice.voiceId,
        engines: speechEngines(plan.voice.voiceId),
        requestId: ctx.requestId,
        format: forFace ? 'pcm_16000' : 'mp3',
        ...(signal === undefined ? {} : { signal }),
      });
    }
    if (plan.face === null || speech.contentType !== 'audio/pcm') return speech;
    const raw = wholeSamples(await readAll(speech.audio, MAX_FACE_PCM_BYTES));
    const pcm = resamplePcm16(
      raw,
      speech.sampleRateHertz ?? (plan.voice.kind === 'clone' ? FACE_SAMPLE_RATE : 16_000),
      FACE_SAMPLE_RATE,
    );
    const manifest = signFaceAudio(
      await keys.signingKey(),
      { callId: plan.callId, sessionRef: plan.face.sessionRef, unit: callsRepo.speechUnitKey(plan.unit) },
      pcm,
    );
    return {
      ...speech,
      audio: streamOf(pcmToWav(pcm, FACE_SAMPLE_RATE)),
      contentType: 'audio/wav',
      sampleRateHertz: FACE_SAMPLE_RATE,
      ...(manifest === null ? {} : { faceManifest: manifest }),
    };
  }

  /** The validation error for text that is not this call's validated words. */
  function notValidatedText(reason: string): DomainError {
    return fail.validation('Only the vEIR’s validated words can be spoken', [
      { path: reason === 'signature_invalid' ? 'sig' : 'text', message: 'Not validated text of this call' },
    ]);
  }

  /** Refuses text inside a request transaction (the audit is appended after its rollback). */
  function refuseTextIn(
    scope: RequestScope,
    ventureId: string,
    turnId: string | null,
    reason: string,
  ): never {
    scope.deferAudit(textRefusal(ventureId, turnId, reason));
    throw notValidatedText(reason);
  }

  /** Refuses text after the checks' transactions (audited first). */
  async function refuseText(
    ctx: RequestContext,
    ventureId: string,
    turnId: string | null,
    reason: string,
  ): Promise<never> {
    await kit.flushDeferred(ctx, [textRefusal(ventureId, turnId, reason)]);
    throw notValidatedText(reason);
  }

  function textRefusal(ventureId: string, turnId: string | null, reason: string): AuditEvent {
    return {
      action: 'speech.refused',
      outcome: 'denied',
      ventureId,
      objectType: turnId === null ? 'session' : 'turn',
      objectId: turnId,
      policyReason: reason,
    };
  }

  /**
   * Reserves the synthesis of `plan` (`characters` long): a play of its unit and, outside crisis support, the
   * characters within the call's and the person's speech budget. A refusal is audited and thrown. Where no
   * speech service runs, a reservation that succeeded is rolled back with the 501 (the last check).
   */
  async function reserve(ctx: RequestContext, plan: SpeechPlan, characters: number): Promise<void> {
    // Each reservation is one statement, atomic on its own (the call row is locked inside it), so where a
    // speech service runs it autocommits: a transaction around it would only add two Data API round trips
    // before the first audio. Without one, the transaction carries the 501 that rolls the reservation back.
    const refusal = await kit.system(
      async (sx): Promise<SpeechRefusal | null> => {
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
        if (refused === null && !voiceAvailable(plan)) throw speechUnavailable();
        return refused;
      },
      voiceAvailable(plan) ? { transaction: false } : {},
    );
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
    if (!signatureValid) refuseTextIn(scope, turn.ventureId, turn.turnId, 'signature_invalid');
    const call = await callsRepo.getCall(scope.tx, turn.callId);
    const persona = call === null ? null : await personasRepo.getPersona(scope.tx, call.personaId);
    const assets = persona === null ? [] : await personasRepo.personaConsentAssets(scope.tx, persona.id);
    const voiceId =
      call !== null && persona !== null && voiceApproved(call.voiceId, persona, assets)
        ? call.voiceId
        : DEFAULT_SPEECH_VOICE;
    // Never the cloned voice and never the face: crisis resources come in a stock voice, from no human-looking face.
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
      voice: { kind: 'polly', voiceId },
      verified: null,
      face: null,
    };
  }

  return {
    synthesize: async (ctx, rawInput, options = {}) => {
      // Stage times for the `speech.timing` log line (docs/runbooks/latency.md): numbers only.
      const started = performance.now();
      const stages: Record<string, number> = {};
      const stage = (name: string): void => {
        stages[name] = Math.round(performance.now() - started);
      };
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
      const verificationKeys = await keys.verificationKeys();
      const claims = { sessionId, turnId, seq: input.seq ?? 0, text: input.text };
      const signatureValid = input.sig !== undefined && verifySpeechUnit(verificationKeys, claims, input.sig);
      stage('verifiedMs');

      // The platform's spend today is read alongside the checks below (it needs none of them), and compared
      // with the caps once they are known.
      const spend = readSpendState(kit, ctx, true);
      spend.catch(() => undefined); // awaited below unless a check refuses first

      // The caller's live call, its vEIR's voice and today's call time are read in a transaction of their own
      // while the conversation's checks run in another (neither waits for the other: a Data API transaction
      // runs one statement at a time). Every check is then applied in the order it always had, so a refused
      // request is refused for the same reason as before.
      const twinWired = kit.deps.clonedVoice !== undefined || kit.deps.embodiment !== undefined;
      const callSide = kit.inRequest(ctx, async ({ tx }) => {
        const call = await callsRepo.getLiveCallOf(tx, ctx.principalId);
        if (call === null) return null;
        const persona = await personasRepo.getPersona(tx, call.personaId);
        const assets = persona === null ? [] : await personasRepo.personaConsentAssets(tx, persona.id);
        // The persona's face and cloned voice, ready under their consent scopes right now (withdrawn: gone).
        const twin = twinWired && persona !== null ? await twinRepo.personaTwin(tx, persona.id) : NO_TWIN;
        return { call, persona, assets, twin, usedSecondsToday: await callSecondsToday(tx, ctx.principalId) };
      });
      callSide.catch(() => undefined); // awaited below unless a check refuses first

      const checked = await kit.inRequest(ctx, async (scope) => {
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
          if (crisis !== null) return { kind: 'crisis' as const, plan: crisis };
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
        return { kind: 'checked' as const, session, turn, settings, active };
      });

      let plan: SpeechPlan;
      if (checked.kind === 'crisis') plan = checked.plan;
      else {
        const { session, turn, settings, active } = checked;
        const side = await callSide;
        const call = side?.call ?? null;
        if (side === null || call?.sessionId !== sessionId || call.idleSeconds > CALL_LIMITS.staleSeconds) {
          throw fail.conflict('Speech is only available during a live call.', 'call_not_active');
        }
        const { persona, assets } = side;
        if (
          persona === null ||
          active.persona.id !== call.personaId ||
          !callCanSpeak(call, persona, assets)
        ) {
          throw new DomainError('persona_suspended', 'This vEIR cannot speak right now.', {
            reason: 'voice_not_approved',
          });
        }
        const timeUp = timeLimitRefusal(
          callTimeLeft({
            elapsedSeconds: call.elapsedSeconds,
            maxSeconds: call.maxSeconds,
            usedSecondsToday: side.usedSecondsToday,
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
            if (stored === null) {
              return refuseText(ctx, session.ventureId, turnId, 'text_not_validated');
            }
            text = stored.text;
            unit = { kind: 'run', turnId: turn.turnId, first: stored.first, last: stored.last };
          } else if (turn.status === 'blocked' || turn.status === 'failed') {
            // A unit passed the sentence gate, but the whole reply did not: it is never spoken again.
            throw fail.conflict('This reply can no longer be spoken.', 'turn_not_speakable');
          }
        }
        if (signed && !signatureValid) return refuseText(ctx, session.ventureId, turnId, 'signature_invalid');
        // Only a signed unit whose signature verified (the validators approved its words) may reach the cloned
        // voice or the face; a passage of a stored reply is spoken in the stock voice, on the call's speakers.
        const verified = signed ? verifiedSpeechUnit(verificationKeys, claims, input.sig) : null;
        const voice = chooseVoice({
          call,
          persona,
          assets,
          clonedVoiceEnabled: settings.clonedVoiceEnabled,
          provider: kit.deps.clonedVoice,
          twinVoice: side.twin.voice,
          verified: verified !== null,
          crisis: false,
        });
        plan = {
          ventureId: session.ventureId,
          callId: call.id,
          voiceId: voice.kind === 'polly' ? voice.voiceId : call.voiceId,
          text,
          unit,
          settings,
          objectType: turnId === null ? 'call' : 'turn',
          objectId: turnId ?? call.id,
          crisis: false,
          voice,
          verified,
          face:
            verified === null
              ? null
              : await liveFaceFor(call.id, {
                  facesEnabled: settings.facesEnabled,
                  twinFace: side.twin.face,
                }),
        };
      }

      stage('plannedMs');
      // Every check runs before the 501 below: a valid request tells the client to speak the text itself.
      if (plan.settings !== null) {
        // The platform's daily cap counts speech; the per-person AI cap does not (the speech budget does).
        await enforceSpendCaps(kit, ctx, await spend, plan.settings, {
          ventureId: plan.ventureId,
          operation: 'speech',
        });
      }
      // The play and the characters are reserved before the speech service is called (one statement, so
      // concurrent requests cannot replay a unit or overrun a budget). Where no speech service runs, the
      // reservation is rolled back with the 501: it is the last check.
      stage('capsCheckedMs');
      const reserved = plan.text.length;
      await reserve(ctx, plan, reserved);
      stage('reservedMs');
      let speech: SynthesizedSpeech;
      try {
        speech = await synthesizePlan(ctx, plan, options.signal);
        stage('synthesizedMs');
      } catch (err) {
        logger.warn('speech.synthesis_failed', {
          requestId: ctx.requestId,
          callId: plan.callId,
          voice: plan.voice.kind,
          error: err instanceof Error ? err.name : 'unknown',
        });
        // Nothing was billed (the service bills nothing for a request it refused): the play and the characters
        // go back, so the client may ask again.
        await settle(ctx, plan, reserved, null);
        if (err instanceof DomainError) throw err;
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

      // The bookkeeping of a synthesis that succeeded runs while its audio streams, and the response ends
      // only once it is done (a Lambda invocation is not frozen while its response is open): metered like
      // every model call (one usage-ledger row, purpose `speech`, priced per character, billed whether or
      // not playback finishes), the call's speech counter as billed, and the audit (ids and counts only).
      // None of it can change what is spoken, so the first audio bytes no longer wait for three writes.
      const billed = speech;
      const bookkeeping = Promise.all([
        kit.recordUsage({
          ctx,
          ventureId: plan.ventureId,
          purpose: 'speech',
          attempts: [
            plan.voice.kind === 'clone'
              ? {
                  modelId: `${plan.voice.provider.id}:${plan.voice.provider.model}`,
                  usage: { inputTokens: billed.characters, outputTokens: 0 },
                  costUsd: voiceCostUsd(billed.characters, plan.voice.provider.usdPer1kCharacters),
                }
              : {
                  modelId: `polly:${billed.engine}:${billed.voiceId}`,
                  usage: { inputTokens: billed.characters, outputTokens: 0 },
                  costUsd: speechCostUsd(
                    billed.characters,
                    billed.engine === 'clone' ? 'neural' : billed.engine,
                  ),
                },
          ],
        }),
        settle(ctx, plan, reserved, billed.characters),
        kit
          .system(
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
                  characters: billed.characters,
                  engine: billed.engine,
                  // A cloned voice is named by its vendor (its id at the vendor is the EIR's, not needed here).
                  voiceId: plan.voice.kind === 'clone' ? `${plan.voice.provider.id}:clone` : billed.voiceId,
                  signed,
                  face: billed.faceManifest !== undefined,
                },
              }),
            { transaction: false },
          )
          .catch((err: unknown) => {
            logger.error('speech.record_failed', {
              requestId: ctx.requestId,
              callId: plan.callId,
              error: err instanceof Error ? err.name : 'unknown',
            });
          }),
      ]).then(() => undefined);
      return {
        ...billed,
        audio: observedAudio(billed.audio, {
          onFirstChunk: () => {
            stage('firstAudioMs');
            logger.info('speech.timing', {
              requestId: ctx.requestId,
              callId: plan.callId,
              signed,
              characters: billed.characters,
              ...stages,
            });
          },
          beforeClose: () => bookkeeping,
        }),
      };
    },
  };
}
