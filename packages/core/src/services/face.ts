import {
  AvatarSessionRequest,
  type AvatarSessionResponse,
  type FaceEndReason,
  type FaceEndRequest,
  type PlatformRole,
  type PlatformSettingsView,
} from '@foundry/contracts';
import {
  auditRepo,
  callsRepo,
  personasRepo,
  principalsRepo,
  settingsRepo,
  turnsRepo,
  twinRepo,
  usageRepo,
  type SqlExecutor,
  type SystemExecutor,
} from '@foundry/db';
import { type z } from 'zod';

import { type PlatformKeyCache } from '../auth/keys.js';
import { loadPrincipalRoles } from '../authz/roles.js';
import { requireAssignmentActive, requireVentureAccess } from '../authz/venture-access.js';
import { type RequestContext } from '../context.js';
import { DomainError, fail, parseInput } from '../errors.js';
import { audit, requireId, type AuditEvent, type Kit, type RequestScope } from '../internal/kit.js';
import { decryptControl, encryptControl, verifyFaceAudio } from '../orchestrator/face-audio.js';
import { secondsUntilUtcMidnight } from '../orchestrator/sampling.js';
import { EmbodimentSessionError, type EmbodimentProvider, type FaceSessionHandle } from '../ports.js';
import { CALL_LIMITS, callSecondsToday, callTimeLeft, remainingDailySeconds } from './call-usage.js';
import { callsPausedFor, callVoiceFor } from './calls.js';
import {
  cursorAfter,
  FACE_TRANSCRIPT_PENDING_SECONDS,
  FACE_TRANSCRIPT_UNREAD_SECONDS,
  linesAfter,
  reconcileFaceTranscript,
} from './face-text.js';
import { faceCostUsd, faceListPrice } from './media-vendors.js';
import { resolveVeir } from './veir.js';

/**
 * The face of a call (docs/architecture/calls.md §4, docs/runbooks/avatars.md): a vendor's realtime avatar behind
 * the {@link EmbodimentProvider} port, off unless the program turned faces on (`faces_enabled`). In LITE mode it is
 * the EIR's own avatar rendering audio our server made (HeyGen LiveAvatar LITE); in FULL mode a vendor's stock
 * avatar voices, with its stock voice, text our server admitted (HeyGen LiveAvatar FULL), labelled "AI avatar".
 *
 * - A face of a likeness is offered only to a persona whose face is ready under likeness consent (a stock avatar
 *   and the development stand-in draw no one and serve any); a sandbox or admins-only face only to platform admins
 *   and the people a platform admin gave video-face access;
 *   always within the person's video minutes this month and the per-call limit, and while the platform's daily
 *   spend cap allows. The vendor session ends by itself at that limit.
 * - LITE: the server holds the face's speak channel. The browser only watches (a room token that cannot publish)
 *   and hands back, at each unit's turn, audio the server synthesized from a signed unit, which the server checks
 *   against its face-audio manifest before relaying it (`speak`). So the face renders nothing the validators did
 *   not approve, and never the crisis line.
 * - LITE stock face fed by the browser (`liteRoute: 'browser'`, never a likeness: refused here as in infra and the
 *   API config): the session response hands the caller's page the vendor's speak channel (`controlUrl`, never
 *   logged). The server admits each unit as it signs it, exactly as for FULL below (`prepareFaceApproval`, or
 *   `authorizeFaceText` for the intro: once, in order, never the crisis line, within the caps), and an honest page
 *   forwards only admitted units' PCM, streamed from `/speech`. LITE has no transcript, so a modified page could make
 *   the stock face say other audio on its own screen undetected: hence stock faces only, for a chosen audience. The
 *   face's minutes, caps, kill switches and metering are the server's as for any face; barge-ins are counted
 *   (`/face/interrupt` never opens a vendor channel: one would replace the page's) and audited at the face's end.
 * - FULL: the vendor takes its commands only over the room, from the browser. The server admits each signed unit
 *   first (as the turn engine signs it, `prepareFaceApproval`, or `authorizeFaceText` for any other unit;
 *   services/speech.ts: once, in order, never the crisis line), and the browser sends
 *   the vendor only an admitted unit's words. A tampered page could still make the face say other words on its own
 *   screen, so every heartbeat reconciles the vendor's transcript against the admitted units (each said at most
 *   once) and ends the face at the first words it never admitted (`call.face_injection`), and so does every way a
 *   FULL face ends: the page reporting it off or ending it, the call's end, the daily reaper. A face whose
 *   transcript stays unread stops; one whose end could not be checked is recorded (`call.face_transcript_unchecked`).
 * - The face takes a unit's parts only in order, each once, one unit at a time: a later part must continue the
 *   unit the face is saying, exactly where the last part ended (`twinRepo.admitFacePart`), and barge-in seals
 *   it. So the parts of validated units can never be replayed, skipped, reordered or spliced together.
 * - One face per call. Faces are metered from the server's clock into the usage ledger (purpose `speech`, at
 *   the vendor's per-minute price) as heartbeats come, and when the face or the call ends, exactly once:
 *   `metered_seconds` moves only with its ledger row, and the daily maintenance bills any face whose end was not
 *   billed (a call the reaper closed).
 * - Heartbeats end the face at once when faces are switched off, likeness consent is withdrawn, the month's or
 *   the call's video minutes are used up (or cannot be read), or the browser stopped showing it: the call goes on
 *   with the presence. Ending a call ends its face.
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
  /**
   * `POST /calls/:id/face/end`: the browser stopped showing the face; the vendor session ends. `client` is the
   * page's account of why, recorded in the face's `call.face_ended` audit.
   */
  drop(ctx: RequestContext, callId: string, client?: FaceEndRequest): Promise<void>;
}

/** Seconds a vendor session needs at least to be worth opening (a call about to end keeps the presence). */
export const MIN_FACE_SECONDS = 15;
/**
 * Vendor sessions one call may open (0030): its first face and the faces that replace one the vendor ended (the free
 * plan ends a session after about two minutes, so a 20-minute video call needs about ten). Every one is within the
 * same caps and metered on its own.
 */
export const FACE_SESSIONS_PER_CALL = 12;
/** Hand-overs of one unit to the face (a unit is heard once). */
export const FACE_UNIT_PLAYS = 1;
/**
 * The page's reasons for a face's end that are failures (it never joined, or the vendor's side dropped), logged as a
 * warning; the rest (a crisis turn, a call left on hold, a stock face handing over before its time limit) are not.
 */
export const FACE_FAILURE_REASONS: ReadonlySet<FaceEndReason> = new Set<FaceEndReason>([
  'video_ended',
  'video_unsubscribed',
  'room_disconnected',
  'vendor_stopped',
  'no_video',
  'connect_timeout',
  'connect_failed',
  'no_adapter',
  'control_lost',
  'speech_stalled',
]);

export type FaceSettings = Required<
  Pick<PlatformSettingsView, 'facesEnabled' | 'faceMinutesPerPrincipalMonth' | 'faceMinutesPerCall'>
>;

export type FaceRefusal =
  | 'faces_disabled'
  | 'no_provider'
  | 'sandbox_only'
  | 'admins_only'
  | 'no_face'
  | 'face_minutes'
  | 'spend_cap'
  | 'too_short';

/**
 * Whether a provider shows its face to a chosen audience only (a vendor sandbox, or an admins-only audience):
 * platform admins and the people a platform admin gave video-face access (`principals.face_access`).
 */
export function faceForAdminsOnly(provider: Pick<EmbodimentProvider, 'sandbox' | 'adminsOnly'>): boolean {
  return provider.sandbox === true || provider.adminsOnly === true;
}

/** Who is asking for a face: their active roles and their video-face access, both re-read from the database. */
export interface FaceCaller {
  readonly roles: readonly PlatformRole[];
  readonly faceAccess: boolean;
}

/** Nobody in particular: no roles and no face access (a provider for everyone needs nothing more). */
export const NO_FACE_CALLER: FaceCaller = { roles: [], faceAccess: false };

/**
 * The caller's roles and video-face access, read fresh inside the request transaction (never from the cookie), so a
 * revoked role or face access takes effect at the next decision.
 */
export async function loadFaceCaller(
  ex: SqlExecutor,
  ctx: Pick<RequestContext, 'principalId' | 'tenantId'>,
): Promise<FaceCaller> {
  return { roles: await loadPrincipalRoles(ex, ctx), faceAccess: await principalsRepo.faceAccess(ex) };
}

/**
 * Whether a provider may show a face to this caller at all: a sandbox or admins-only face only to a platform admin
 * or a person with video-face access (pure).
 */
export function faceOfferedTo(
  provider: Pick<EmbodimentProvider, 'sandbox' | 'adminsOnly'>,
  caller: FaceCaller,
): boolean {
  return !faceForAdminsOnly(provider) || caller.roles.includes('platform_admin') || caller.faceAccess;
}

/**
 * Whether a call may have a face now, and for how long at most (pure). `twinFace` is the persona's face ready
 * under likeness consent (`app.persona_twin`); a provider without likeness (a stock avatar, the stand-in) needs
 * none. A sandbox or admins-only provider serves platform admins and people with video-face access only
 * (`caller`, re-read from the database); everything else applies to them like to anyone.
 */
export function faceAllowance(input: {
  readonly settings: FaceSettings;
  readonly provider: Pick<EmbodimentProvider, 'likeness' | 'sandbox' | 'adminsOnly'> | undefined;
  readonly caller: FaceCaller;
  readonly twinFace: { readonly ref: string } | null;
  readonly monthSecondsUsed: number;
  readonly callSecondsLeft: number;
  readonly spendCapReached: boolean;
  /** Video seconds this call's earlier sessions used (0030): the per-call limit counts them. */
  readonly callFaceSecondsUsed?: number;
}):
  { readonly ok: true; readonly maxSeconds: number } | { readonly ok: false; readonly reason: FaceRefusal } {
  if (!input.settings.facesEnabled) return { ok: false, reason: 'faces_disabled' };
  if (input.provider === undefined) return { ok: false, reason: 'no_provider' };
  if (!faceOfferedTo(input.provider, input.caller)) {
    return { ok: false, reason: input.provider.sandbox === true ? 'sandbox_only' : 'admins_only' };
  }
  if (input.provider.likeness && input.twinFace === null) return { ok: false, reason: 'no_face' };
  if (input.spendCapReached) return { ok: false, reason: 'spend_cap' };
  const monthLeft = Math.max(0, input.settings.faceMinutesPerPrincipalMonth * 60 - input.monthSecondsUsed);
  if (monthLeft < MIN_FACE_SECONDS) return { ok: false, reason: 'face_minutes' };
  const callFaceLeft = Math.max(0, input.settings.faceMinutesPerCall * 60 - (input.callFaceSecondsUsed ?? 0));
  const maxSeconds = Math.floor(Math.min(input.callSecondsLeft, callFaceLeft, monthLeft));
  if (maxSeconds < MIN_FACE_SECONDS) return { ok: false, reason: 'too_short' };
  return { ok: true, maxSeconds };
}

/** Why a live face has to stop (the heartbeat applies it). */
export type FaceStopCause =
  | 'faces_disabled'
  | 'likeness_withdrawn'
  | 'face_minutes'
  | 'face_limit'
  | 'face_check_failed'
  | 'spend_cap'
  | 'face_dropped'
  | 'face_injection';

/**
 * The video-minute causes, from the face itself (pure): its per-call limit (the vendor session ends there too,
 * but the server never relies on that), the month's minutes, and a month that could not be read (`null`), which
 * stops the face rather than wave it through.
 */
export function faceMinutesCause(input: {
  readonly lasted: number;
  readonly maxSeconds: number;
  readonly monthSecondsUsed: number | null;
  readonly monthMinutes: number;
}): 'face_limit' | 'face_minutes' | 'face_check_failed' | null {
  if (input.lasted >= input.maxSeconds) return 'face_limit';
  if (input.monthSecondsUsed === null) return 'face_check_failed';
  if (input.monthSecondsUsed >= input.monthMinutes * 60) return 'face_minutes';
  return null;
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
}): Exclude<FaceStopCause, 'face_limit' | 'face_check_failed' | 'face_injection'> | null {
  if (!input.settings.facesEnabled || input.provider === undefined) return 'faces_disabled';
  if (input.provider.likeness && input.twinFace === null) return 'likeness_withdrawn';
  if (input.spendCapReached) return 'spend_cap';
  if (input.monthSecondsUsed >= input.settings.faceMinutesPerPrincipalMonth * 60) return 'face_minutes';
  if (input.clientOff) return 'face_dropped';
  return null;
}

/**
 * Who feeds a provider's LITE face our audio: `browser` only for a LITE **stock** face whose provider asks for it;
 * `server` for everything else. A provider that asks for the browser route with a real person's likeness (or in
 * FULL) is a misconfiguration infra and the API config refuse already: core refuses it too (`null`), so such a
 * face never starts.
 */
export function faceRouteOf(
  provider: Pick<EmbodimentProvider, 'mode' | 'likeness' | 'liteRoute'>,
): 'server' | 'browser' | null {
  if (provider.liteRoute !== 'browser') return 'server';
  return provider.mode === 'lite' && !provider.likeness ? 'browser' : null;
}

/**
 * Whether the server admits a face's units as text (`call_face_texts`, face pre-approval and `face/say`): a FULL
 * face, or a LITE stock face the browser feeds. Both the wired provider and the face record must say so.
 */
export function faceAdmitsText(
  provider: Pick<EmbodimentProvider, 'id' | 'mode' | 'likeness' | 'liteRoute'> | undefined,
  face: Pick<twinRepo.CallFaceRecord, 'vendor' | 'mode' | 'route'>,
): boolean {
  if (provider?.id !== face.vendor || provider.mode !== face.mode) return false;
  if (face.mode === 'full') return true;
  return face.route === 'browser' && faceRouteOf(provider) === 'browser';
}

/** The vendor's metered model id for a face in its mode (`heygen:liveavatar-<mode>`, `<provider>:face`). */
export function faceModelId(face: {
  readonly id: 'heygen' | 'fake';
  readonly mode: 'lite' | 'full';
}): string {
  return face.id === 'heygen' ? `heygen:liveavatar-${face.mode}` : `${face.id}:face`;
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
   * After a heartbeat of a live call: meters the face's seconds and ends it when it has to stop: `stopCause`
   * (switches, consent, the browser), or its video minutes (the call's limit, the month's `monthMinutes`).
   * Returns what the heartbeat answers (`continue`/`stop`), or undefined when the call has no live face.
   */
  heartbeat(
    ctx: RequestContext,
    call: { readonly id: string; readonly ventureId: string },
    decision: {
      readonly stopCause: FaceStopCause | null;
      readonly monthMinutes: number | null;
      /** The page's own account of why it stopped showing the face (`POST /calls/:id/face/end`), audited. */
      readonly client?: FaceEndRequest;
    },
  ): Promise<'continue' | 'stop' | undefined>;
  /**
   * After a call ended (any path): meters the face to its end, checks what a FULL face said to its end, and stops
   * the vendor session.
   */
  afterCallEnded(
    ctx: RequestContext,
    call: { readonly id: string; readonly ventureId: string },
  ): Promise<void>;
  /**
   * After the daily maintenance closed calls whose page went away: the same for their faces, as the system (the
   * worker may wire no vendor: then a FULL face is recorded as unchecked).
   */
  afterCallsReaped(
    requestId: string,
    calls: readonly { readonly callId: string; readonly ventureId: string }[],
  ): Promise<void>;
  /**
   * A spoken turn whose units were pre-approved for the call's live FULL face was then blocked or failed: reads the
   * face's transcript now (the heartbeat's check, recording what the face said) and withdraws the turn's
   * pre-approved units it has not shown, but the first of them (`twinRepo.withdrawFaceTexts`), so a page that hands
   * the face more of the turn afterwards ends the face at the next check (`call.face_injection`), as `face/say`
   * refuses such a turn. Returns the withdrawn units' `seq`; null when nothing was withdrawn because the face is not
   * live, or its transcript could not be read to its end or already shows words never admitted (the heartbeat
   * decides those). Never throws.
   */
  withdrawTurn(requestId: string, callId: string, turnId: string): Promise<readonly number[] | null>;
  /** The inputs of {@link faceStopCause} the heartbeat reads inside its own transaction. */
  stopInputs(
    scope: RequestScope,
    call: { readonly personaId: string },
    settings: FaceSettings,
  ): Promise<{ readonly twinFace: { readonly ref: string } | null }>;
}

/**
 * The per-minute price a face of `vendor` in `mode` is billed at: the wired provider's when it is that vendor in
 * that mode, else the price file (the worker, which meters faces the reaper closed, wires no vendor; a face started
 * before the deployment changed mode); the stand-in costs nothing.
 */
export function faceUsdPerMinute(
  provider: Pick<EmbodimentProvider, 'id' | 'mode' | 'usdPerMinute'> | undefined,
  vendor: 'heygen' | 'fake',
  mode: 'lite' | 'full',
): number {
  if (provider?.id === vendor && provider.mode === mode) return provider.usdPerMinute;
  return faceListPrice(vendor, mode);
}

/**
 * Bills a face's seconds not yet billed into the usage ledger (purpose `speech`, at the vendor's per-minute price),
 * in one transaction with its counter, so each second is billed exactly once whoever meters it (a heartbeat, the
 * call's end, the daily maintenance). Returns the seconds it billed.
 */
export async function meterFace(kit: Kit, callId: string, requestId: string): Promise<number> {
  return kit.system(async (sx) => {
    const metered = await twinRepo.meterCallFace(sx, callId);
    if (metered === null || metered.added <= 0) return 0;
    await usageRepo.recordUsage(sx, {
      tenantId: metered.tenantId,
      ventureId: metered.ventureId,
      principalId: metered.startedBy,
      purpose: 'speech',
      modelId: faceModelId({ id: metered.vendor, mode: metered.mode }),
      inputTokens: metered.added,
      outputTokens: 0,
      costUsd: faceCostUsd(
        metered.added,
        faceUsdPerMinute(kit.deps.embodiment, metered.vendor, metered.mode),
      ),
      requestId,
    });
    return metered.added;
  });
}

/** Attempts at stopping a vendor session before it is left to the vendor's idle timeout. */
const VENDOR_STOP_ATTEMPTS = 2;

export function createFaceHooks(kit: Kit): FaceHooks {
  const { logger } = kit.deps;

  /** Meters a face's new seconds into the ledger (exactly once); never throws. */
  async function meter(ctx: RequestContext, callId: string): Promise<void> {
    try {
      await meterFace(kit, callId, ctx.requestId);
    } catch (err) {
      logger.error('call.face_meter_failed', {
        requestId: ctx.requestId,
        callId,
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  async function stopVendor(
    requestId: string,
    face: twinRepo.CallFaceRecord,
    reason: 'call_ended' | 'face_stopped' | 'face_dropped',
  ): Promise<void> {
    const provider = kit.deps.embodiment;
    if (provider?.id !== face.vendor) return;
    // Once more on a failure: a session left open bills until the vendor's idle timeout (5 minutes).
    for (let attempt = 1; attempt <= VENDOR_STOP_ATTEMPTS; attempt += 1) {
      try {
        await provider.end({ sessionRef: face.sessionRef, control: null, requestId }, reason);
        return;
      } catch (err) {
        logger.warn('call.face_end_failed', {
          requestId,
          callId: face.callId,
          provider: provider.id,
          attempt,
          error: err instanceof Error ? err.name : 'unknown',
        });
      }
    }
  }

  /**
   * FULL: reads the vendor's transcript of the face after the lines earlier checks verified, and checks each avatar
   * line is words of a unit the server admitted and the face had not said yet (face-text.ts).
   * - `injected`: words never admitted, an admitted unit said again, or last lines still unmatched a heartbeat
   *   later (`final`: at once, since the face is ending and nothing more of a unit will come).
   * - `unread`: the vendor could not be read (or this deployment does not drive the face's vendor), or not to its
   *   end (its page limit). A live face records the lines it did verify; one left unread too long stops.
   * - `ok` otherwise. A live check records where it stopped, so the next reads only newer lines.
   */
  async function checkTranscript(
    requestId: string,
    face: twinRepo.CallFaceRecord,
    options: { readonly final: boolean },
  ): Promise<
    | { readonly result: 'ok' }
    | {
        readonly result: 'injected';
        readonly why: 'words_not_admitted' | 'said_again' | 'words_left_unmatched';
      }
    | {
        readonly result: 'unread';
        readonly why: 'vendor_not_wired' | 'vendor_unreadable' | 'transcript_incomplete';
      }
  > {
    if (face.mode !== 'full') return { result: 'ok' };
    const provider = kit.deps.embodiment;
    if (
      provider?.id !== face.vendor ||
      provider.mode !== face.mode ||
      provider.transcriptSince === undefined
    ) {
      return { result: 'unread', why: 'vendor_not_wired' };
    }
    const from = { at: face.transcriptCursor, skip: face.transcriptSkip };
    let read;
    try {
      read = await provider.transcriptSince(
        { sessionRef: face.sessionRef, control: null, requestId },
        from.at,
      );
    } catch (err) {
      logger.warn('call.face_transcript_unread', {
        requestId,
        callId: face.callId,
        error: err instanceof Error ? err.name : 'unknown',
      });
      return { result: 'unread', why: 'vendor_unreadable' };
    }
    const units = await kit.system((sx) => twinRepo.faceTextUnits(sx, face.callId), { transaction: false });
    const lines = linesAfter(read.lines, from);
    const verdict = reconcileFaceTranscript({ callId: face.callId, lines, units });
    if (verdict.verdict === 'mismatch') return { result: 'injected', why: verdict.why };
    if (options.final) {
      if (verdict.verdict === 'pending') return { result: 'injected', why: 'words_left_unmatched' };
    } else {
      const recorded = await kit.system((sx) =>
        twinRepo.recordFaceTranscript(sx, {
          callId: face.callId,
          from,
          cursor: cursorAfter(from, lines, verdict.verified),
          added: verdict.verified,
          said: verdict.said,
          pending: verdict.verdict === 'pending',
          complete: read.complete,
        }),
      );
      // Lines a check already saw unmatched, still unmatched now (a heartbeat later).
      if ((recorded?.pending ?? -1) >= FACE_TRANSCRIPT_PENDING_SECONDS) {
        return { result: 'injected', why: 'words_left_unmatched' };
      }
    }
    if (!read.complete) {
      logger.warn('call.face_transcript_incomplete', {
        requestId,
        callId: face.callId,
        lines: read.lines.length,
      });
      return { result: 'unread', why: 'transcript_incomplete' };
    }
    return { result: 'ok' };
  }

  /** The audit of a FULL face whose transcript showed words it never admitted (never the words). */
  function injectionEvent(
    face: twinRepo.CallFaceRecord,
    ventureId: string,
    why: string,
    final: boolean,
  ): AuditEvent {
    return {
      action: 'call.face_injection',
      outcome: 'blocked',
      ventureId,
      objectType: 'call',
      objectId: face.callId,
      policyReason: 'words_not_admitted',
      metadata: { provider: face.vendor, mode: face.mode, check: why, atEnd: final },
    };
  }

  /** The audit of a FULL face that ended without its transcript read to its end. */
  function uncheckedEvent(face: twinRepo.CallFaceRecord, ventureId: string, why: string): AuditEvent {
    return {
      action: 'call.face_transcript_unchecked',
      outcome: 'failed',
      ventureId,
      objectType: 'call',
      objectId: face.callId,
      policyReason: why,
      metadata: { provider: face.vendor, mode: face.mode },
    };
  }

  /**
   * A face the call's end already ended in the database (calls_end_face): checks what a FULL face said to its end
   * (before the vendor session stops, while the vendor still serves it), bills its seconds and stops the vendor
   * session. Returns the audit events to write.
   */
  async function closeEndedFace(
    requestId: string,
    face: twinRepo.CallFaceRecord,
    ventureId: string,
  ): Promise<AuditEvent[]> {
    const events: AuditEvent[] = [];
    const check = await checkTranscript(requestId, face, { final: true });
    if (check.result === 'injected') events.push(injectionEvent(face, ventureId, check.why, true));
    if (check.result === 'unread') events.push(uncheckedEvent(face, ventureId, check.why));
    try {
      await meterFace(kit, face.callId, requestId);
    } catch (err) {
      logger.error('call.face_meter_failed', {
        requestId,
        callId: face.callId,
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
    await stopVendor(requestId, face, 'call_ended');
    // A LITE face the browser fed: its end is audited with what it was allowed to say and how often it was cut off.
    if (face.route === 'browser') {
      events.push({
        action: 'call.face_ended',
        outcome: 'succeeded',
        ventureId,
        objectType: 'call',
        objectId: face.callId,
        policyReason: 'call_ended',
        metadata: {
          provider: face.vendor,
          mode: face.mode,
          seconds: face.lasted,
          ...(await faceCounts(face)),
        },
      });
    }
    return events;
  }

  /**
   * The counts a face's end audit carries for a LITE face the browser fed (identifiers and numbers only): its
   * route, the units the server admitted to it, and the barge-ins the page reported. Empty for any other face.
   */
  async function faceCounts(
    face: twinRepo.CallFaceRecord,
  ): Promise<{ route?: string; admitted?: number; interrupts?: number }> {
    if (face.route !== 'browser') return {};
    let admitted = -1;
    try {
      admitted = (await kit.system((sx) => twinRepo.faceTextUnits(sx, face.callId), { transaction: false }))
        .length;
    } catch {
      // Unread: recorded as -1, the end is audited all the same.
    }
    return { route: face.route, admitted, interrupts: face.interrupts };
  }

  return {
    withdrawTurn: async (requestId, callId, turnId) => {
      try {
        const face = await kit.system((sx) => twinRepo.getCallFace(sx, callId), { transaction: false });
        if (face?.endedAt !== null || face.mode !== 'full') return null;
        // What the face said up to now is recorded first, so only units it has not shown are withdrawn.
        const check = await checkTranscript(requestId, face, { final: false });
        if (check.result !== 'ok') {
          logger.warn('call.face_withdraw_skipped', { requestId, callId, reason: check.result });
          return null;
        }
        return await kit.system((sx) =>
          twinRepo.withdrawFaceTexts(sx, {
            callId,
            sessionRef: face.sessionRef,
            turnKey: turnId.toLowerCase(),
          }),
        );
      } catch (err) {
        logger.warn('call.face_withdraw_failed', {
          requestId,
          callId,
          error: err instanceof Error ? err.name : 'unknown',
        });
        return null;
      }
    },

    stopInputs: async (scope, call, settings) => ({
      twinFace: settings.facesEnabled
        ? await twinFaceFor(scope.tx, kit.deps.embodiment, call.personaId)
        : null,
    }),

    heartbeat: async (ctx, call, decision) => {
      try {
        const face = await kit.system((sx) => twinRepo.getCallFace(sx, call.id), { transaction: false });
        if (face?.endedAt !== null) return undefined;
        await meter(ctx, call.id);
        let stopCause: FaceStopCause | null = decision.stopCause;
        if (stopCause === null && decision.monthMinutes !== null) {
          // Video minutes this month (owner role: call_faces is closed to app_rls). A read that fails stops
          // the face: it never goes on unchecked.
          let used: number | null;
          try {
            used = await faceSecondsThisMonth(kit, ctx.principalId);
          } catch (err) {
            logger.error('call.face_minutes_unread', {
              requestId: ctx.requestId,
              callId: call.id,
              error: err instanceof Error ? err.name : 'unknown',
            });
            used = null;
          }
          stopCause = faceMinutesCause({
            lasted: face.lasted,
            maxSeconds: face.maxSeconds,
            monthSecondsUsed: used,
            monthMinutes: decision.monthMinutes,
          });
        }
        // FULL: what the face said is checked at every heartbeat, and also when this one ends it (whatever the
        // cause: the page reporting the face off or ending it never skips the check).
        const final = stopCause !== null;
        const check = await checkTranscript(ctx.requestId, face, { final });
        const events: AuditEvent[] = [];
        if (check.result === 'injected') {
          stopCause = 'face_injection';
          events.push(injectionEvent(face, call.ventureId, check.why, final));
        } else if (check.result === 'unread') {
          if (final) {
            events.push(uncheckedEvent(face, call.ventureId, check.why));
          } else if (face.transcriptUnchecked >= FACE_TRANSCRIPT_UNREAD_SECONDS) {
            // Never a face that goes on unchecked.
            logger.error('call.face_transcript_unchecked', {
              requestId: ctx.requestId,
              callId: call.id,
              reason: check.why,
              seconds: face.transcriptUnchecked,
            });
            stopCause = 'face_check_failed';
          }
        }
        if (stopCause === null) {
          // An idle session times out at the vendor; a heartbeat now and then keeps it.
          const provider = kit.deps.embodiment;
          if (provider?.id === face.vendor && face.lasted % 60 < CALL_LIMITS.heartbeatSeconds) {
            await provider
              .keepAlive({ sessionRef: face.sessionRef, control: null, requestId: ctx.requestId })
              .catch(() => undefined);
          }
          return 'continue';
        }
        const cause: FaceStopCause = stopCause;
        const ended = await kit.system((sx) => twinRepo.endCallFace(sx, { callId: call.id, reason: cause }));
        if (ended !== null) {
          await meter(ctx, call.id);
          await stopVendor(ctx.requestId, ended, cause === 'face_dropped' ? 'face_dropped' : 'face_stopped');
          events.push({
            action: 'call.face_ended',
            outcome: cause === 'face_dropped' ? 'succeeded' : 'blocked',
            ventureId: call.ventureId,
            objectType: 'call',
            objectId: call.id,
            policyReason: cause,
            metadata: {
              provider: ended.vendor,
              mode: ended.mode,
              seconds: ended.lasted,
              ...(await faceCounts(ended)),
              // Which of the page's triggers ended it (the video ended, the room dropped, the vendor stopped it...).
              ...(decision.client?.reason === undefined ? {} : { clientReason: decision.client.reason }),
              ...(decision.client?.vendorReason === undefined
                ? {}
                : { vendorReason: decision.client.vendorReason }),
              // A face that never showed: the join stage it stopped at, and the page's plain code of what failed.
              ...(decision.client?.stage === undefined ? {} : { clientStage: decision.client.stage }),
              ...(decision.client?.detail === undefined ? {} : { clientDetail: decision.client.detail }),
            },
          });
        }
        await kit.flushDeferred(ctx, events);
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
        // The call's end ended the face in the database (calls_end_face): checked, billed and stopped now.
        if (face?.endReason !== 'call_ended') return;
        await kit.flushDeferred(ctx, await closeEndedFace(ctx.requestId, face, call.ventureId));
      } catch (err) {
        logger.warn('call.face_close_failed', {
          requestId: ctx.requestId,
          callId: call.id,
          error: err instanceof Error ? err.name : 'unknown',
        });
      }
    },

    afterCallsReaped: async (requestId, calls) => {
      for (const call of calls) {
        try {
          const face = await kit.system((sx) => twinRepo.getCallFace(sx, call.callId), {
            transaction: false,
          });
          if (face?.endReason !== 'call_ended') continue;
          const events = await closeEndedFace(requestId, face, call.ventureId);
          if (events.length === 0) continue;
          await kit.system(async (sx) => {
            for (const event of events) {
              await auditRepo.appendAudit(sx, {
                ...event,
                tenantId: face.tenantId,
                actorId: null,
                requestId,
              });
            }
          });
        } catch (err) {
          logger.warn('call.face_close_failed', {
            requestId,
            callId: call.callId,
            error: err instanceof Error ? err.name : 'unknown',
          });
        }
      }
    },
  };
}

/**
 * Why a call may not open a vendor session now, given its face so far (null: it may). A call without a face may open
 * its first. A face still live is not opened twice. A face the page dropped (`face_dropped`: the vendor ended its
 * session, the room dropped, the call was on hold) is replaced while the call opened fewer than
 * {@link FACE_SESSIONS_PER_CALL}; a face the server ended (a cap, the switches, a failed or injected transcript, the
 * call's end) is never opened again in that call.
 */
export function reconnectRefusal(
  face: Pick<twinRepo.CallFaceRecord, 'endedAt' | 'endReason' | 'sessions'> | null,
): 'face_already_used' | 'face_sessions' | null {
  if (face === null) return null;
  if (face.endedAt === null || face.endReason !== 'face_dropped') return 'face_already_used';
  if (face.sessions >= FACE_SESSIONS_PER_CALL) return 'face_sessions';
  return null;
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
    options: {
      readonly forSpeech: boolean;
      readonly mode?: 'lite' | 'full';
      readonly route?: 'server' | 'browser';
    },
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
    if (
      face?.endedAt !== null ||
      provider?.id !== face.vendor ||
      provider.mode !== face.mode ||
      (options.mode !== undefined && face.mode !== options.mode) ||
      (options.route !== undefined && face.route !== options.route)
    ) {
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
          throw new DomainError('persona_suspended', callsPausedFor(persona?.name ?? null), {
            reason: 'voice_consent',
          });
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
          stockFace: false,
          controlUrl: null,
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
            caller: faceForAdminsOnly(provider) ? await loadFaceCaller(scope.tx, ctx) : NO_FACE_CALLER,
            callSecondsLeft: left.seconds,
            // Only the platform's cap stops a face (speech never counts against a person's AI budget).
            spendCapReached: spendCap === 'global',
          },
        };
      });
      const { presence, face } = plan;
      if (face === null || provider === undefined) return presence;

      const record = async (
        outcome: 'succeeded' | 'failed' | 'denied',
        reason: string | null,
        extra: { readonly session?: number } = {},
      ) => {
        await kit.flushDeferred(ctx, [
          {
            action: 'call.avatar_session',
            outcome,
            ventureId: input.ventureId,
            objectType: 'call',
            objectId: face.callId,
            ...(reason === null ? {} : { policyReason: reason }),
            // Identifiers only: tokens and the control channel are credentials and are never recorded.
            metadata: {
              provider: provider.id,
              mode: provider.mode,
              voicing: provider.voicing,
              ...(provider.mode === 'lite' ? { route: faceRouteOf(provider) ?? 'refused' } : {}),
              // A reconnect (0030): which of the call's vendor sessions this is; each is metered on its own.
              ...(extra.session === undefined ? {} : { session: extra.session }),
            },
          },
        ]);
      };

      let existing = await kit.system((sx) => twinRepo.getCallFace(sx, face.callId), {
        transaction: false,
      });
      const refusal = reconnectRefusal(existing);
      if (refusal !== null) {
        await record('denied', refusal);
        return presence;
      }
      if (existing !== null) {
        // A face the page dropped (the vendor ended its session) is replaced: its seconds are billed to its end first,
        // so the replacement can count them and never bills a second twice. A metering that fails opens nothing.
        try {
          await meterFace(kit, face.callId, ctx.requestId);
          existing = await kit.system((sx) => twinRepo.getCallFace(sx, face.callId), { transaction: false });
        } catch (err) {
          logger.error('call.face_meter_failed', {
            requestId: ctx.requestId,
            callId: face.callId,
            error: err instanceof Error ? err.name : 'unknown',
          });
          await record('failed', 'face_unbilled');
          return presence;
        }
        const again = reconnectRefusal(existing);
        if (again !== null) {
          await record('denied', again);
          return presence;
        }
      }
      /** Which of the call's vendor sessions this is (1: its first face). */
      const sessionNo = existing === null ? 1 : existing.sessions + 1;
      // A real person's likeness is never fed by the browser (infra and the API config refuse it too).
      const route = faceRouteOf(provider);
      if (route === null) {
        logger.error('call.face_route_refused', { requestId: ctx.requestId, callId: face.callId });
        await record('denied', 'likeness_browser_route');
        return presence;
      }
      const allowance = faceAllowance({
        settings: face.settings,
        provider,
        caller: face.caller,
        twinFace: face.twinFace,
        monthSecondsUsed: await faceSecondsThisMonth(kit, ctx.principalId),
        callSecondsLeft: face.callSecondsLeft,
        spendCapReached: face.spendCapReached,
        callFaceSecondsUsed: existing === null ? 0 : existing.earlierSeconds + existing.meteredSeconds,
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
          // A face of the EIR's likeness is the persona's avatar; a stock face is the provider's own.
          avatarRef: provider.likeness ? (face.twinFace?.ref ?? null) : null,
          maxSeconds: allowance.maxSeconds,
          requestId: ctx.requestId,
        });
      } catch (err) {
        logger.warn('call.avatar_session_failed', {
          requestId: ctx.requestId,
          callId: face.callId,
          provider: provider.id,
          error: err instanceof Error ? err.name : 'unknown',
          // The vendor's sanitised reason for refusing the session (no conversation content is in that request).
          ...(err instanceof EmbodimentSessionError && err.vendorDetail !== null
            ? { vendorDetail: err.vendorDetail }
            : {}),
        });
        await record('failed', 'vendor_unavailable');
        return presence;
      }
      const controlUrl = route === 'browser' ? (started.browser.controlUrl ?? null) : null;
      if (route === 'browser' && controlUrl === null) {
        // A browser-fed face without its speak channel could never speak: nothing runs unseen.
        logger.warn('call.avatar_session_failed', {
          requestId: ctx.requestId,
          callId: face.callId,
          provider: provider.id,
          error: 'no_control_channel',
        });
        await provider
          .end({ sessionRef: started.sessionRef, control: null, requestId: ctx.requestId }, 'face_stopped')
          .catch(() => undefined);
        await record('failed', 'vendor_unavailable');
        return presence;
      }
      const key = await keys.signingKey();
      const session = {
        callId: face.callId,
        startedBy: ctx.principalId,
        vendor: provider.id,
        mode: provider.mode,
        route,
        sessionRef: started.sessionRef,
        control:
          started.control === null
            ? null
            : encryptControl(key, started.control, controlAad(face.callId, started.sessionRef)),
        maxSeconds: allowance.maxSeconds,
      };
      const stored = await kit
        .system((sx) =>
          existing === null
            ? twinRepo.startCallFace(sx, session)
            : twinRepo.restartCallFace(sx, { ...session, maxSessions: FACE_SESSIONS_PER_CALL }),
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
      await record('succeeded', null, sessionNo > 1 ? { session: sessionNo } : {});
      return {
        provider: provider.id,
        token: started.browser.token,
        expiresAt: started.browser.expiresAt,
        voiceId: presence.voiceId,
        voicing: provider.voicing,
        url: started.browser.url,
        stockFace: provider.stock === true,
        // The page's speak channel, only for a LITE stock face (a credential: in this response alone, never logged).
        controlUrl,
      };
    },

    speak: async (ctx, rawCallId, input) => {
      // Audio only for a LITE face: a FULL face voices admitted text with its own voice.
      // A LITE face the browser feeds takes nothing from this relay (the page forwards admitted units itself).
      const { call, face, provider, handle } = await liveFace(ctx, rawCallId, {
        forSpeech: true,
        mode: 'lite',
        route: 'server',
      });
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
        throw fail.validation('Only speech this call validated can be shown', [
          { path: 'audio', message: 'Not validated speech of this call' },
        ]);
      };
      if (!check.ok) return refuse(check.reason);
      // Each unit is handed to the face once, part after part in order, one unit at a time (one statement under
      // the face's row lock): a replayed, skipped, reordered or spliced part is refused before the vendor sees it.
      const admitted = await kit.system(
        (sx) =>
          twinRepo.admitFacePart(sx, {
            callId: call.id,
            sessionRef: face.sessionRef,
            unit: check.unit,
            first: input.firstChunk,
            chunks: check.partChunks,
            total: check.chunks,
            maxPlays: FACE_UNIT_PLAYS,
          }),
        { transaction: false },
      );
      if (!admitted) return refuse(input.firstChunk === 0 ? 'already_shown' : 'part_out_of_order');
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
      // FULL: the browser interrupts the vendor over the room; this seals the server's side all the same.
      const { call, face, provider, handle } = await liveFace(ctx, rawCallId, { forSpeech: false });
      // What the face was saying is over: no later part of it is taken, even if the vendor cannot be reached.
      // Counted for the face's end audit.
      await kit.system((sx) => twinRepo.sealFaceUtterance(sx, call.id, { count: true }), {
        transaction: false,
      });
      // A LITE face the browser feeds: the page interrupted the vendor over its own speak channel. The server
      // never opens a channel of its own here: the vendor keeps one per session, and a second would replace the
      // page's (cutting the face off).
      if (face.route === 'browser') return;
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

    drop: async (ctx, rawCallId, client) => {
      const callId = requireId(rawCallId, 'Call');
      const call = await kit.inRequest(ctx, async (scope) => {
        const found = await callsRepo.getCall(scope.tx, callId);
        if (found?.startedBy !== ctx.principalId) throw fail.notFound('Call');
        return found;
      });
      // The page's own account, logged as well as audited: a face that failed (never joined, or dropped) says where
      // and why in the service's logs (plain tokens only: the contract allows nothing else).
      const fields = {
        requestId: ctx.requestId,
        callId: call.id,
        reason: client?.reason ?? null,
        stage: client?.stage ?? null,
        detail: client?.detail ?? null,
        vendorReason: client?.vendorReason ?? null,
      };
      if (client?.reason !== undefined && FACE_FAILURE_REASONS.has(client.reason)) {
        logger.warn('call.face_failed', fields);
      } else {
        logger.info('call.face_dropped', fields);
      }
      // Idempotent: a face already gone (or none) is fine.
      await hooks.heartbeat(
        ctx,
        { id: call.id, ventureId: call.ventureId },
        { stopCause: 'face_dropped', monthMinutes: null, ...(client === undefined ? {} : { client }) },
      );
    },
  };
}
