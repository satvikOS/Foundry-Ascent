import {
  AvatarSessionRequest,
  type AvatarSessionResponse,
  type PlatformSettingsView,
} from '@foundry/contracts';
import {
  callsRepo,
  personasRepo,
  settingsRepo,
  turnsRepo,
  twinRepo,
  usageRepo,
  type SqlExecutor,
  type SystemExecutor,
} from '@foundry/db';
import { type z } from 'zod';

import { type PlatformKeyCache } from '../auth/keys.js';
import { requireAssignmentActive, requireVentureAccess } from '../authz/venture-access.js';
import { type RequestContext } from '../context.js';
import { DomainError, fail, parseInput } from '../errors.js';
import { audit, requireId, type Kit, type RequestScope } from '../internal/kit.js';
import { decryptControl, encryptControl, verifyFaceAudio } from '../orchestrator/face-audio.js';
import { secondsUntilUtcMidnight } from '../orchestrator/sampling.js';
import { type EmbodimentProvider, type FaceSessionHandle } from '../ports.js';
import { CALL_LIMITS, callSecondsToday, callTimeLeft, remainingDailySeconds } from './call-usage.js';
import { callVoiceFor } from './calls.js';
import { faceCostUsd } from './media-vendors.js';
import { resolveVeir } from './veir.js';

/**
 * The face of a call (docs/architecture/calls.md §4, docs/runbooks/avatars.md): a vendor's realtime avatar of the
 * EIR (HeyGen LiveAvatar, LITE mode) behind the {@link EmbodimentProvider} port, off unless the program turned
 * faces on (`faces_enabled`).
 *
 * - A face is offered only to a persona whose face is ready under likeness consent (the development stand-in
 *   draws no one and serves any), within the person's video minutes this month and the per-call limit, and while
 *   the platform's daily spend cap allows. The vendor session ends by itself at that limit.
 * - The server holds the face's speak channel. The browser only watches (a room token that cannot publish) and
 *   hands back, at each unit's turn, audio the server synthesized from a signed unit, which the server checks
 *   against its face-audio manifest before relaying it (`speak`). So the face renders nothing the validators did
 *   not approve, and never the crisis line.
 * - One face per call. Faces are metered from the server's clock into the usage ledger (purpose `speech`, at
 *   the vendor's per-minute price) as heartbeats come, and when the face or the call ends, exactly once.
 * - Heartbeats end the face at once when faces are switched off, likeness consent is withdrawn, the minutes are
 *   used up, or the browser stopped showing it: the call goes on with the presence. Ending a call ends its face.
 */
export interface FaceService {
  /** `POST /calls/avatar-session` (see `VeirService.avatarSession`). */
  session(ctx: RequestContext, input: z.input<typeof AvatarSessionRequest>): Promise<AvatarSessionResponse>;
  /** `POST /calls/:id/face/speak`: relays one part of a unit's verified audio to the call's face. */
  speak(
    ctx: RequestContext,
    callId: string,
    input: { readonly manifest: string; readonly firstChunk: number; readonly pcm: Uint8Array },
  ): Promise<void>;
  /** `POST /calls/:id/face/interrupt`: barge-in, the face drops what it still has to say. */
  interrupt(ctx: RequestContext, callId: string): Promise<void>;
  /** `POST /calls/:id/face/end`: the browser stopped showing the face; the vendor session ends. */
  drop(ctx: RequestContext, callId: string): Promise<void>;
}

/** Seconds a vendor session needs at least to be worth opening (a call about to end keeps the presence). */
export const MIN_FACE_SECONDS = 15;
/** Hand-overs of one unit to the face (a unit is heard once). */
export const FACE_UNIT_PLAYS = 1;

export type FaceSettings = Required<
  Pick<PlatformSettingsView, 'facesEnabled' | 'faceMinutesPerPrincipalMonth' | 'faceMinutesPerCall'>
>;

export type FaceRefusal =
  'faces_disabled' | 'no_provider' | 'no_face' | 'face_minutes' | 'spend_cap' | 'too_short';

/**
 * Whether a call may have a face now, and for how long at most (pure). `twinFace` is the persona's face ready
 * under likeness consent (`app.persona_twin`); a provider without likeness (the stand-in) needs none.
 */
export function faceAllowance(input: {
  readonly settings: FaceSettings;
  readonly provider: Pick<EmbodimentProvider, 'likeness'> | undefined;
  readonly twinFace: { readonly ref: string } | null;
  readonly monthSecondsUsed: number;
  readonly callSecondsLeft: number;
  readonly spendCapReached: boolean;
}):
  { readonly ok: true; readonly maxSeconds: number } | { readonly ok: false; readonly reason: FaceRefusal } {
  if (!input.settings.facesEnabled) return { ok: false, reason: 'faces_disabled' };
  if (input.provider === undefined) return { ok: false, reason: 'no_provider' };
  if (input.provider.likeness && input.twinFace === null) return { ok: false, reason: 'no_face' };
  if (input.spendCapReached) return { ok: false, reason: 'spend_cap' };
  const monthLeft = Math.max(0, input.settings.faceMinutesPerPrincipalMonth * 60 - input.monthSecondsUsed);
  if (monthLeft < MIN_FACE_SECONDS) return { ok: false, reason: 'face_minutes' };
  const maxSeconds = Math.floor(
    Math.min(input.callSecondsLeft, input.settings.faceMinutesPerCall * 60, monthLeft),
  );
  if (maxSeconds < MIN_FACE_SECONDS) return { ok: false, reason: 'too_short' };
  return { ok: true, maxSeconds };
}

/** Why a live face has to stop, or null (pure; the heartbeat applies it). */
export function faceStopCause(input: {
  readonly settings: Pick<FaceSettings, 'facesEnabled' | 'faceMinutesPerPrincipalMonth'>;
  readonly provider: Pick<EmbodimentProvider, 'likeness'> | undefined;
  readonly twinFace: { readonly ref: string } | null;
  readonly monthSecondsUsed: number;
  readonly spendCapReached: boolean;
  /** The browser reports the face is no longer shown. */
  readonly clientOff: boolean;
}): 'faces_disabled' | 'likeness_withdrawn' | 'face_minutes' | 'spend_cap' | 'face_dropped' | null {
  if (!input.settings.facesEnabled || input.provider === undefined) return 'faces_disabled';
  if (input.provider.likeness && input.twinFace === null) return 'likeness_withdrawn';
  if (input.spendCapReached) return 'spend_cap';
  if (input.monthSecondsUsed >= input.settings.faceMinutesPerPrincipalMonth * 60) return 'face_minutes';
  if (input.clientOff) return 'face_dropped';
  return null;
}

/** The vendor's metered model id for a face (`<provider>:face`). */
export function faceModelId(provider: Pick<EmbodimentProvider, 'id'>): string {
  return provider.id === 'heygen' ? 'heygen:liveavatar-lite' : `${provider.id}:face`;
}

/** What binds a face's control channel ciphertext to its call (AES-GCM associated data). */
function controlAad(callId: string, sessionRef: string): string {
  return `face-control|${callId.toLowerCase()}|${sessionRef}`;
}

/** The persona's face ready under likeness consent, if the provider needs one. */
export async function twinFaceFor(
  ex: SqlExecutor,
  provider: EmbodimentProvider | undefined,
  personaId: string,
): Promise<{ readonly ref: string } | null> {
  if (provider === undefined) return null;
  const twin = await twinRepo.personaTwin(ex, personaId);
  return twin.face;
}

/**
 * Face-related work the calls service runs: heartbeat checks with metering, and closing the vendor session when a
 * call ends. Never throws.
 */
export interface FaceHooks {
  /**
   * After a heartbeat of a live call: meters the face's seconds and, when it has to stop (`stopCause`), ends it.
   * Returns what the heartbeat answers (`continue`/`stop`), or undefined when the call has no live face.
   */
  heartbeat(
    ctx: RequestContext,
    call: { readonly id: string; readonly ventureId: string },
    stopCause: string | null,
  ): Promise<'continue' | 'stop' | undefined>;
  /** After a call ended (any path): meters the face to its end and stops the vendor session. */
  afterCallEnded(
    ctx: RequestContext,
    call: { readonly id: string; readonly ventureId: string },
  ): Promise<void>;
  /** The inputs of {@link faceStopCause} the heartbeat reads inside its own transaction. */
  stopInputs(
    scope: RequestScope,
    call: { readonly personaId: string },
    settings: FaceSettings,
  ): Promise<{ readonly twinFace: { readonly ref: string } | null }>;
}

export function createFaceHooks(kit: Kit): FaceHooks {
  const { logger } = kit.deps;

  /** Meters a face's new seconds and records them in the ledger, in one transaction (exactly once). */
  async function meter(
    ctx: RequestContext,
    callId: string,
    ventureId: string,
    vendor: 'heygen' | 'fake',
  ): Promise<void> {
    const provider = kit.deps.embodiment;
    const usdPerMinute = provider?.id === vendor ? provider.usdPerMinute : 0;
    const modelId = vendor === 'heygen' ? 'heygen:liveavatar-lite' : `${vendor}:face`;
    try {
      await kit.system(async (sx) => {
        const added = await twinRepo.meterCallFace(sx, callId);
        if (added <= 0) return;
        await usageRepo.recordUsage(sx, {
          tenantId: ctx.tenantId,
          ventureId,
          principalId: ctx.principalId,
          purpose: 'speech',
          modelId,
          inputTokens: added,
          outputTokens: 0,
          costUsd: faceCostUsd(added, usdPerMinute),
          requestId: ctx.requestId,
        });
      });
    } catch (err) {
      logger.error('call.face_meter_failed', {
        requestId: ctx.requestId,
        callId,
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  async function stopVendor(
    ctx: RequestContext,
    face: twinRepo.CallFaceRecord,
    reason: 'call_ended' | 'face_stopped' | 'face_dropped',
  ): Promise<void> {
    const provider = kit.deps.embodiment;
    if (provider?.id !== face.vendor) return;
    try {
      await provider.end({ sessionRef: face.sessionRef, control: null, requestId: ctx.requestId }, reason);
    } catch (err) {
      logger.warn('call.face_end_failed', {
        requestId: ctx.requestId,
        callId: face.callId,
        provider: provider.id,
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  return {
    stopInputs: async (scope, call, settings) => ({
      twinFace: settings.facesEnabled
        ? await twinFaceFor(scope.tx, kit.deps.embodiment, call.personaId)
        : null,
    }),

    heartbeat: async (ctx, call, stopCause) => {
      try {
        const face = await kit.system((sx) => twinRepo.getCallFace(sx, call.id), { transaction: false });
        if (face?.endedAt !== null) return undefined;
        await meter(ctx, call.id, call.ventureId, face.vendor);
        if (stopCause === null) {
          // An idle LITE session times out at the vendor; a heartbeat now and then keeps it.
          const provider = kit.deps.embodiment;
          if (provider?.id === face.vendor && face.lasted % 60 < CALL_LIMITS.heartbeatSeconds) {
            await provider
              .keepAlive({ sessionRef: face.sessionRef, control: null, requestId: ctx.requestId })
              .catch(() => undefined);
          }
          return 'continue';
        }
        const ended = await kit.system((sx) =>
          twinRepo.endCallFace(sx, { callId: call.id, reason: stopCause }),
        );
        if (ended !== null) {
          await meter(ctx, call.id, call.ventureId, ended.vendor);
          await stopVendor(ctx, ended, stopCause === 'face_dropped' ? 'face_dropped' : 'face_stopped');
          await kit.flushDeferred(ctx, [
            {
              action: 'call.face_ended',
              outcome: stopCause === 'face_dropped' ? 'succeeded' : 'blocked',
              ventureId: call.ventureId,
              objectType: 'call',
              objectId: call.id,
              policyReason: stopCause,
              metadata: { provider: ended.vendor, seconds: ended.lasted },
            },
          ]);
        }
        return 'stop';
      } catch (err) {
        logger.error('call.face_heartbeat_failed', {
          requestId: ctx.requestId,
          callId: call.id,
          error: err instanceof Error ? err.name : 'unknown',
        });
        return undefined;
      }
    },

    afterCallEnded: async (ctx, call) => {
      try {
        const face = await kit.system((sx) => twinRepo.getCallFace(sx, call.id), { transaction: false });
        // The call's end ended the face in the database (calls_end_face); the vendor session ends now.
        if (face?.endReason !== 'call_ended') return;
        await meter(ctx, call.id, call.ventureId, face.vendor);
        await stopVendor(ctx, face, 'call_ended');
      } catch (err) {
        logger.warn('call.face_close_failed', {
          requestId: ctx.requestId,
          callId: call.id,
          error: err instanceof Error ? err.name : 'unknown',
        });
      }
    },
  };
}

/** Settings a face reads, with every optional field present. */
function faceSettings(settings: settingsRepo.ResolvedPlatformSettings): FaceSettings {
  return {
    facesEnabled: settings.facesEnabled,
    faceMinutesPerPrincipalMonth: settings.faceMinutesPerPrincipalMonth,
    faceMinutesPerCall: settings.faceMinutesPerCall,
  };
}

/** Video seconds the caller used this month (owner role: `call_faces` is closed to app_rls). */
export function faceSecondsThisMonth(kit: Kit, principalId: string): Promise<number> {
  return kit.system((sx: SystemExecutor) => twinRepo.faceSecondsThisMonth(sx, principalId), {
    transaction: false,
  });
}

export function createFaceService(kit: Kit, keys: PlatformKeyCache, hooks: FaceHooks): FaceService {
  const { logger } = kit.deps;

  /** The caller's own live call with a live face, the provider driving it, and its decrypted control channel. */
  async function liveFace(
    ctx: RequestContext,
    rawCallId: string,
    options: { readonly forSpeech: boolean },
  ): Promise<{
    readonly call: callsRepo.CallRecord;
    readonly face: twinRepo.CallFaceRecord;
    readonly provider: EmbodimentProvider;
    readonly handle: FaceSessionHandle;
  }> {
    const callId = requireId(rawCallId, 'Call');
    const provider = kit.deps.embodiment;
    const call = await kit.inRequest(ctx, async (scope) => {
      const found = await callsRepo.getCall(scope.tx, callId);
      if (found?.startedBy !== ctx.principalId) throw fail.notFound('Call');
      if (found.status !== 'live') throw fail.conflict('This call has ended.', 'call_not_active');
      if (options.forSpeech) {
        // Faces off, or the likeness consent withdrawn: the face takes nothing more, at once.
        const settings = await settingsRepo.getPlatformSettings(scope.tx);
        const twinFace = await twinFaceFor(scope.tx, provider, found.personaId);
        if (!settings.facesEnabled || (provider?.likeness === true && twinFace === null)) {
          throw fail.conflict('The face of this call has ended.', 'face_not_active');
        }
      }
      return found;
    });
    const face = await kit.system((sx) => twinRepo.getCallFace(sx, call.id), { transaction: false });
    if (face?.endedAt !== null || provider?.id !== face.vendor) {
      throw fail.conflict('The face of this call has ended.', 'face_not_active');
    }
    let control: string | null = null;
    if (face.control !== null) {
      control = decryptControl(
        await keys.verificationKeys(),
        face.control,
        controlAad(call.id, face.sessionRef),
      );
      if (control === null) throw fail.conflict('The face of this call has ended.', 'face_not_active');
    }
    return {
      call,
      face,
      provider,
      handle: { sessionRef: face.sessionRef, control, requestId: ctx.requestId },
    };
  }

  function faceFailed(err: unknown): DomainError {
    return new DomainError('model_unavailable', 'The face is not available right now.', {
      reason: 'face_failed',
      retryAfterSeconds: 5,
      cause: err instanceof Error ? err : undefined,
    });
  }

  return {
    session: async (ctx, rawInput) => {
      const input = parseInput(AvatarSessionRequest, rawInput);
      const ventureId = requireId(input.ventureId, 'Venture');
      const callId = input.callId === undefined ? null : requireId(input.callId, 'Call');
      const provider = kit.deps.embodiment;
      const plan = await kit.inRequest(ctx, async (scope) => {
        await requireVentureAccess(scope, ventureId, 'write', { objectType: 'call' });
        const settings = await settingsRepo.getPlatformSettings(scope.tx);
        if (!settings.aiEnabled) {
          throw new DomainError(
            'ai_disabled',
            'AI coaching is paused by the program. Please try again later.',
            {
              reason: 'kill_switch',
            },
          );
        }
        if (!settings.callsEnabled) {
          throw new DomainError('ai_disabled', 'Calls are paused by the program. You can keep chatting.', {
            reason: 'calls_disabled',
          });
        }
        const active = await requireAssignmentActive(scope, ventureId);
        const veir = await resolveVeir(scope.tx, ventureId);
        if (veir === null) {
          throw new DomainError('assignment_inactive', 'This venture has no active coaching assignment', {
            reason: 'no_active_assignment',
          });
        }
        const { identity } = veir;
        const persona = await personasRepo.getPersona(scope.tx, active.persona.id);
        // The same voice rule as calls: an EIR's own voice only under voice consent, never another voice.
        const voiceId =
          persona === null
            ? null
            : callVoiceFor(persona, await personasRepo.personaConsentAssets(scope.tx, persona.id));
        if (voiceId === null) {
          throw new DomainError(
            'persona_suspended',
            'This vEIR’s voice consent is not in force, so calls are paused.',
            {
              reason: 'voice_consent',
            },
          );
        }
        const used = await callSecondsToday(scope.tx, ctx.principalId);
        if (
          remainingDailySeconds(used, settings.dailyCallMinutesPerPrincipal) < CALL_LIMITS.minStartSeconds
        ) {
          throw new DomainError(
            'rate_limited',
            'You have used today’s call minutes. Calls reset at midnight UTC.',
            {
              reason: 'daily_call_minutes',
              retryAfterSeconds: secondsUntilUtcMidnight(kit.now()),
            },
          );
        }
        const presence: AvatarSessionResponse = {
          provider: identity.embodiment.provider,
          token: null,
          expiresAt: null,
          voiceId,
          voicing: 'engine',
          url: null,
        };
        if (provider === undefined || callId === null) {
          await audit(scope, {
            action: 'call.avatar_session',
            outcome: 'succeeded',
            ventureId,
            objectType: 'persona',
            objectId: identity.personaId,
            metadata: { provider: identity.embodiment.provider },
          });
          return { presence, face: null };
        }
        // A vendor session belongs to a live call: the caller's own, in this venture, with this vEIR. It ends
        // with the call's time left (and the person's video minutes), so the vendor stops billing by itself.
        const call = await callsRepo.getCall(scope.tx, callId);
        if (
          call?.status !== 'live' ||
          call.startedBy !== ctx.principalId ||
          call.ventureId !== ventureId ||
          call.personaId !== identity.personaId
        ) {
          throw fail.conflict('The face of a call opens only during your live call.', 'call_not_active');
        }
        const left = callTimeLeft({
          elapsedSeconds: call.elapsedSeconds,
          maxSeconds: call.maxSeconds,
          usedSecondsToday: used,
          caps: settings,
        });
        const spendCap = await turnsRepo.spendCapState(scope.tx, {
          globalUsd: settings.dailyUsdCapGlobal,
          principalUsd: settings.dailyUsdCapPerPrincipal,
        });
        return {
          presence: { ...presence, provider: 'builtin' as const },
          face: {
            callId: call.id,
            personaId: identity.personaId,
            settings: faceSettings(settings),
            twinFace: await twinFaceFor(scope.tx, provider, identity.personaId),
            callSecondsLeft: left.seconds,
            // Only the platform's cap stops a face (speech never counts against a person's AI budget).
            spendCapReached: spendCap === 'global',
          },
        };
      });
      const { presence, face } = plan;
      if (face === null || provider === undefined) return presence;

      const record = async (outcome: 'succeeded' | 'failed' | 'denied', reason: string | null) => {
        await kit.flushDeferred(ctx, [
          {
            action: 'call.avatar_session',
            outcome,
            ventureId: input.ventureId,
            objectType: 'call',
            objectId: face.callId,
            ...(reason === null ? {} : { policyReason: reason }),
            // Identifiers only: tokens and the control channel are credentials and are never recorded.
            metadata: { provider: provider.id, voicing: provider.voicing },
          },
        ]);
      };

      const existing = await kit.system((sx) => twinRepo.getCallFace(sx, face.callId), {
        transaction: false,
      });
      if (existing !== null) {
        // One face per call: a face that dropped is not opened again (nothing bills unseen).
        await record('denied', 'face_already_used');
        return presence;
      }
      const allowance = faceAllowance({
        settings: face.settings,
        provider,
        twinFace: face.twinFace,
        monthSecondsUsed: await faceSecondsThisMonth(kit, ctx.principalId),
        callSecondsLeft: face.callSecondsLeft,
        spendCapReached: face.spendCapReached,
      });
      if (!allowance.ok) {
        await record('denied', allowance.reason);
        return presence;
      }

      // Outside the transaction: a vendor round trip never holds the database. Any failure keeps the presence.
      let started;
      try {
        started = await provider.createSession({
          callId: face.callId,
          personaId: face.personaId,
          avatarRef: face.twinFace?.ref ?? null,
          maxSeconds: allowance.maxSeconds,
          requestId: ctx.requestId,
        });
      } catch (err) {
        logger.warn('call.avatar_session_failed', {
          requestId: ctx.requestId,
          callId: face.callId,
          provider: provider.id,
          error: err instanceof Error ? err.name : 'unknown',
        });
        await record('failed', 'vendor_unavailable');
        return presence;
      }
      const key = await keys.signingKey();
      const stored = await kit
        .system((sx) =>
          twinRepo.startCallFace(sx, {
            callId: face.callId,
            startedBy: ctx.principalId,
            vendor: provider.id,
            sessionRef: started.sessionRef,
            control:
              started.control === null
                ? null
                : encryptControl(key, started.control, controlAad(face.callId, started.sessionRef)),
            maxSeconds: allowance.maxSeconds,
          }),
        )
        .catch(() => null);
      if (stored === null) {
        // The call ended meanwhile, or another face won the race: this vendor session must not run unseen.
        await provider
          .end(
            { sessionRef: started.sessionRef, control: started.control, requestId: ctx.requestId },
            'face_stopped',
          )
          .catch(() => undefined);
        await record('denied', 'call_not_active');
        return presence;
      }
      await record('succeeded', null);
      return {
        provider: provider.id,
        token: started.browser.token,
        expiresAt: started.browser.expiresAt,
        voiceId: presence.voiceId,
        voicing: provider.voicing,
        url: started.browser.url,
      };
    },

    speak: async (ctx, rawCallId, input) => {
      const { call, face, provider, handle } = await liveFace(ctx, rawCallId, { forSpeech: true });
      const check = verifyFaceAudio(
        await keys.verificationKeys(),
        input.manifest,
        { callId: call.id, sessionRef: face.sessionRef },
        { firstChunk: input.firstChunk, pcm: input.pcm },
      );
      const refuse = async (reason: string): Promise<never> => {
        await kit.flushDeferred(ctx, [
          {
            action: 'call.face_refused',
            outcome: 'denied',
            ventureId: call.ventureId,
            objectType: 'call',
            objectId: call.id,
            policyReason: reason,
          },
        ]);
        throw fail.validation('Only the vEIR’s validated speech can be shown', [
          { path: 'audio', message: 'Not validated speech of this call' },
        ]);
      };
      if (!check.ok) return refuse(check.reason);
      // Each unit is handed to the face once (its first part counts it); later parts follow that one.
      const counted = await kit.system(async (sx) =>
        input.firstChunk === 0
          ? twinRepo.reserveFacePlay(sx, { callId: call.id, unit: check.unit, maxPlays: FACE_UNIT_PLAYS })
          : (await twinRepo.facePlays(sx, { callId: call.id, unit: check.unit })) >= 1,
      );
      if (!counted) return refuse('already_shown');
      try {
        await provider.speak(handle, check.audio);
      } catch (err) {
        logger.warn('call.face_speak_failed', {
          requestId: ctx.requestId,
          callId: call.id,
          provider: provider.id,
          error: err instanceof Error ? err.name : 'unknown',
        });
        throw faceFailed(err);
      }
    },

    interrupt: async (ctx, rawCallId) => {
      const { call, provider, handle } = await liveFace(ctx, rawCallId, { forSpeech: false });
      try {
        await provider.interrupt(handle);
      } catch (err) {
        logger.warn('call.face_interrupt_failed', {
          requestId: ctx.requestId,
          callId: call.id,
          provider: provider.id,
          error: err instanceof Error ? err.name : 'unknown',
        });
        throw faceFailed(err);
      }
    },

    drop: async (ctx, rawCallId) => {
      const callId = requireId(rawCallId, 'Call');
      const call = await kit.inRequest(ctx, async (scope) => {
        const found = await callsRepo.getCall(scope.tx, callId);
        if (found?.startedBy !== ctx.principalId) throw fail.notFound('Call');
        return found;
      });
      // Idempotent: a face already gone (or none) is fine.
      await hooks.heartbeat(ctx, { id: call.id, ventureId: call.ventureId }, 'face_dropped');
    },
  };
}
