import type {
  AvatarSessionResponse,
  AvatarVoicing,
  EmbodimentProviderId,
  FaceJoinStage,
} from '@foundry/contracts';
import { useSyncExternalStore } from 'react';

import {
  loadAvatarProvider,
  warmAvatarAdapter,
  type AvatarProvider,
  type FaceLoss,
  type FaceRelay,
} from '@/lib/realtime/avatar';
import { presentationCapabilities } from '@/lib/realtime/presentation';
import {
  endFace,
  interruptFace,
  sayFaceText,
  sendFaceAudio,
  startAvatarSession,
} from '@/lib/realtime/call-api';
import type { CallEngine } from '@/lib/realtime/call-engine';
import type { CallSnapshot } from '@/lib/realtime/call-state';

/**
 * The face of a live call (docs/architecture/calls.md §4): the API opens the vendor's session for this call, the
 * adapter loads (its own chunk) and joins, and only then does the call tile show its video and hand it the call's
 * audio (through the server, which relays only the audio it synthesized) or, for a FULL stock face, the validated
 * units the server admits for the vendor to say. Every face is labelled "AI avatar" on its tile.
 *
 * A video call (owner round 3, 2026-11-06: "just load the actual avatar, then the conversation starts"):
 * - **First the face.** The engine opens the call waiting for its face (`awaitingFace`): nothing is said or heard until
 *   the face's first frame arrived and its speak channel is open; then the conversation starts
 *   (`CallEngine.startConversation`) and the face says the intro. There is no stand-in presence meanwhile.
 * - **Reconnects.** A vendor session that ends during the call (the free plan's ~2 minute limit, a dropped room, a
 *   lost speak channel) is replaced by a new session of the same call (`reconnecting`): the call's speech waits for it
 *   (`CallEngine.holdForFace`), a unit the old face gave back before a word of it was heard is said by the new face,
 *   and the conversation and transcript go on. A session close to its end is replaced early, at a quiet moment (the
 *   founder's turn), so the hand-over rarely waits on a reply. The server bounds the sessions of a call (enough for its
 *   whole video limit, with every cap of a first face); the page only stops a runaway at
 *   {@link FACE_SESSIONS_PER_CALL}, counting the sessions the server actually opened.
 * - **Never a silent downgrade.** A face that cannot start, or cannot come back, is `unavailable`: the call screen says
 *   so and offers the voice call (one tap) or another try; it never turns into a voice call by itself.
 *
 * The face belongs to the call, not to the screen: it lives in the call's controller (one per call engine), so
 * minimizing the call to the mini bar keeps it, and it ends with the call. A call left on hold (the page hidden) for
 * longer than {@link FACE_HOLD_GRACE_MS} gives its face up (`paused`), since the vendor bills an idle face by the
 * minute; it comes back when the call resumes. A crisis turn ends the face for the rest of the call (a human-looking
 * face never says the crisis line; the server refuses to reopen it too), as does the server stopping it (faces off, a
 * cap, a failed check): the tile then says video is not available, with the voice call one tap away.
 */
export type CallFace =
  /** No face: a voice call (or one switched to voice). */
  | { readonly status: 'presence' }
  /** The face is joining; the conversation has not started yet (a new video call). */
  | { readonly status: 'connecting' }
  /**
   * A new vendor session replaces the one that ended (or the call is back from hold): speech waits for it. `still`:
   * the last frame of the face that ended (a data URL), shown dimmed meanwhile, or null.
   */
  | { readonly status: 'reconnecting'; readonly still: string | null }
  /** The call is on hold: its face was given up meanwhile and comes back when the call resumes. */
  | { readonly status: 'paused' }
  /**
   * The face could not start (`hadVideo` false) or could not come back (true): the call screen says video is not
   * available right now and offers the voice call.
   */
  | { readonly status: 'unavailable'; readonly hadVideo: boolean }
  | {
      readonly status: 'live';
      readonly provider: AvatarProvider;
      readonly stream: MediaStream | null;
      /**
       * The face's own element, playing its video and audio together (a vendor face): the call tile shows it, so
       * the voice is heard in step with the lips. Null: the tile shows `stream`, muted (the canvas stand-in).
       */
      readonly media: HTMLVideoElement | null;
    };

export interface CallFaceDeps {
  startSession(ventureId: string, callId: string, signal: AbortSignal): Promise<AvatarSessionResponse>;
  loadProvider(
    id: EmbodimentProviderId,
    voicing: AvatarVoicing,
    options?: { readonly liteSocket?: boolean },
  ): Promise<AvatarProvider | null>;
  /** The server path of the face's audio for this call. */
  relayFor(callId: string): FaceRelay;
  /** Starts loading a vendor's adapter ahead of its session (best effort). */
  warm?(provider: EmbodimentProviderId): void;
  /** Tells the server the face is no longer shown (it ends the vendor session), and why (audited there). */
  endFace(callId: string, loss: FaceLoss): Promise<void>;
  /** A face that has not shown its first frame by then is given up for this call. */
  readonly connectTimeoutMs: number;
  /** A call on hold longer than this gives its face up (default {@link FACE_HOLD_GRACE_MS}). */
  readonly holdGraceMs?: number;
  /**
   * How long before a vendor session's end (`expiresAt`) a quiet moment is used to replace it (default
   * {@link FACE_REFRESH_LEAD_MS}), and the clock it is read against (default `Date.now`).
   */
  readonly refreshLeadMs?: number;
  readonly wallNow?: () => number;
}

/** How long a call may stay on hold (the page hidden) before its face is given up: the vendor bills idle faces. */
export const FACE_HOLD_GRACE_MS = 60_000;
/**
 * The most vendor sessions the page opens for one call: a backstop against a runaway, never the real bound. The server's
 * bound (`faceSessionsPerCall`: enough for the call's whole video limit, 20 for the default 20 minutes) refuses first,
 * and this is the most it can ever allow (`FACE_SESSIONS_MAX`, the database's own bound).
 */
export const FACE_SESSIONS_PER_CALL = 100;
/**
 * A vendor session this close to its end is replaced at the next quiet moment (the founder's turn, nothing being
 * said), so the new face is there before the next reply: a join takes a few seconds.
 */
export const FACE_REFRESH_LEAD_MS = 25_000;
/** How often a session near its end looks for a quiet moment. */
const REFRESH_POLL_MS = 500;
/** Reasons a face that went away may be replaced by a new session of the same call. */
const REPLACEABLE: ReadonlySet<FaceLoss['reason']> = new Set<FaceLoss['reason']>([
  'video_ended',
  'video_unsubscribed',
  'room_disconnected',
  'vendor_stopped',
  'control_lost',
  'speech_stalled',
  'time_limit',
]);

export const BROWSER_FACE_DEPS: CallFaceDeps = {
  startSession: startAvatarSession,
  loadProvider: loadAvatarProvider,
  warm: warmAvatarAdapter,
  relayFor: (callId) => ({
    speak: (audio, signal) => sendFaceAudio(callId, audio, signal),
    say: (unit, signal) => sayFaceText(callId, unit, signal),
    interrupt: () => {
      void interruptFace(callId).catch(() => undefined);
    },
  }),
  endFace,
  connectTimeoutMs: 8_000,
};

export interface FaceRequest {
  /** Who draws the face (the call settings). `builtin` never asks for a session. */
  readonly provider: EmbodimentProviderId;
  readonly ventureId: string;
  readonly callId: string;
  readonly reducedMotion: boolean;
}

type FaceEngine = Pick<
  CallEngine,
  | 'attachFace'
  | 'setFaceShown'
  | 'onFaceStop'
  | 'subscribe'
  | 'getSnapshot'
  | 'startConversation'
  | 'holdForFace'
  | 'setFaceReplaceable'
  | 'faceArrived'
>;

const PRESENCE: CallFace = { status: 'presence' };

/** A plain code of what a join threw: the page's own code (`face_no_video`), else the error's own name. */
function failureCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  if (/^[a-z][a-z0-9_]{0,63}$/.test(err.message)) return err.message;
  // A library's error (LiveKit's ConnectionError and its reason), never its message, which may hold a URL.
  const reasonName = (err as { reasonName?: unknown }).reasonName;
  const named =
    typeof reasonName === 'string' && /^[A-Za-z]{1,32}$/.test(reasonName)
      ? `${err.name}.${reasonName}`
      : err.name;
  return /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(named) && named !== 'Error' ? named : undefined;
}

/**
 * Why joining the face failed, from what the join threw, with the stage it stopped at (the adapter's own account
 * when it has one) and a plain code: what the page sends with the face's end, so the server logs and audits it.
 */
function joinFailure(err: unknown, stage: FaceJoinStage): FaceLoss {
  const message = err instanceof Error ? err.message : '';
  const reason: FaceLoss['reason'] =
    message === 'face_timeout'
      ? 'connect_timeout'
      : message === 'face_no_video'
        ? 'no_video'
        : 'connect_failed';
  const detail = failureCode(err);
  return { reason, stage, ...(detail === undefined ? {} : { detail }) };
}

function timeout(ms: number, signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('face_timeout'));
    }, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
    });
  });
}

/** One join of the call's face (its first, or a session replacing one that ended). */
interface Attempt {
  readonly callId: string;
  readonly ventureId: string;
  readonly provider: EmbodimentProviderId;
  readonly reducedMotion: boolean;
  readonly controller: AbortController;
  adapter: AvatarProvider | null;
  offLost: (() => void) | null;
  /** When the vendor session ends by itself (epoch ms), if it said. */
  expiresAt: number | null;
}

export class CallFaceController {
  private face: CallFace = PRESENCE;
  private readonly listeners = new Set<() => void>();
  /** Vendor sessions the server opened for each call (at most {@link FACE_SESSIONS_PER_CALL}). */
  private readonly sessions = new Map<string, number>();
  /** Calls whose face showed (so a face no longer shown stopped, rather than never started). */
  private readonly shown = new Set<string>();
  /** Calls whose face ended for good (a crisis turn, the server stopping it): never asked for again. */
  private readonly over = new Set<string>();
  /** The face of the current call (joining or live), or null. */
  private current: Attempt | null = null;
  /** What the call asked for last: how a reconnect or another try asks again. */
  private last: FaceRequest | null = null;
  /** Runs out when the call stayed on hold too long. */
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  /** Looks for a quiet moment to replace a session close to its end. */
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly engine: FaceEngine,
    private readonly deps: CallFaceDeps = BROWSER_FACE_DEPS,
  ) {
    // The call ending (or moving to another call) ends its face; a crisis turn ends it for the rest of the call: a
    // human-looking face never says the crisis line.
    engine.subscribe(() => {
      this.follow(engine.getSnapshot());
    });
    engine.onFaceStop(() => {
      // The server already ended it (faces off, likeness withdrawn, minutes used up): it does not come back.
      const callId = this.current?.callId ?? this.last?.callId ?? null;
      if (callId === null) return;
      this.over.add(callId);
      // No face (a voice call, or one switched to voice): it stays as it is; switched back to video, its tile says video
      // is not available (`canAsk` is false now, `videoPending`), never that it is connecting.
      if (this.current === null && this.face.status === 'presence') return;
      this.unavailable(false);
    });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): CallFace => this.face;

  /**
   * Whether this call may ask for a face (again): it has vendor sessions left, and its face did not end for good (a
   * crisis turn, the server stopping it).
   */
  canAsk(callId: string): boolean {
    return !this.over.has(callId) && (this.sessions.get(callId) ?? 0) < FACE_SESSIONS_PER_CALL;
  }

  /**
   * Asks for the face of this live call (a video call, or a voice call switched to video). A call whose face is
   * joining, live, paused or unavailable is left as it is (another try is {@link retry}).
   */
  request(request: FaceRequest): void {
    const { provider, callId } = request;
    if (provider === 'builtin' || this.face.status !== 'presence') return;
    if (this.current !== null || !this.canAsk(callId)) return;
    const snapshot = this.engine.getSnapshot();
    if (snapshot.phase !== 'live' || snapshot.call?.id !== callId) return;
    this.last = request;
    // A new video call's conversation waits for its face; a call already talking (switched to video) keeps talking on
    // its speakers until the face is there.
    this.join('connecting', false);
  }

  /**
   * A video call is about to ask for its face: the vendor's adapter starts loading now, while the call and its avatar
   * session are being opened (the join then waits on neither chunk).
   */
  warm(provider: EmbodimentProviderId): void {
    if (provider === 'builtin') return;
    this.deps.warm?.(provider);
  }

  /** Another try after the face could not start or come back (the call screen's Try again). */
  retry(callId: string): void {
    if (this.face.status !== 'unavailable' || this.last?.callId !== callId || !this.canAsk(callId)) return;
    const snapshot = this.engine.getSnapshot();
    if (snapshot.phase !== 'live' || snapshot.call?.id !== callId) return;
    this.join('connecting', false);
  }

  /**
   * Gives the face up for this call (the founder switched to a voice call): the server ends the vendor session, the
   * call goes on as a voice call (its conversation starts now if it was still waiting for the face), and a later
   * switch back to video asks for a new session.
   */
  switchedToVoice(): void {
    this.giveUp(true, { reason: 'switched_to_voice' });
    this.set(PRESENCE);
    this.engine.startConversation();
  }

  /** Joins a vendor session for the last request: the call's first face, or one replacing a face that ended. */
  private join(status: 'connecting' | 'reconnecting', hold: boolean, still: string | null = null): void {
    const request = this.last;
    if (request === null) return;
    const { callId, ventureId, provider, reducedMotion } = request;
    const controller = new AbortController();
    const { signal } = controller;
    /** Read after every await: giving up or the call ending may have happened meanwhile. */
    const stopped = () => signal.aborted || this.current !== attempt;
    const attempt: Attempt = {
      callId,
      ventureId,
      provider,
      reducedMotion,
      controller,
      adapter: null,
      offLost: null,
      expiresAt: null,
    };
    this.current = attempt;
    // A face that may go away mid-call is replaced: units it gives back unheard wait for the next one.
    this.engine.setFaceReplaceable(true);
    if (hold) this.engine.holdForFace(true);
    this.set(status === 'connecting' ? { status } : { status, still });
    /** Where the join is (the adapter's own stage once it is connecting). */
    let stage: FaceJoinStage = 'session';
    void (async () => {
      try {
        // Bounded like the join itself: a call whose speech waits for the face never waits on a slow API for long.
        const session = await Promise.race([
          this.deps.startSession(ventureId, callId, signal),
          timeout(this.deps.connectTimeoutMs, signal),
        ]);
        if (session.token === null || session.provider === 'builtin') {
          // Not offered now (credits, minutes, caps, the switches): nothing opened, nothing to end on the server.
          if (!stopped()) this.unavailable(false);
          return;
        }
        // A session the server opened (and meters): counted, whether or not it joins.
        this.sessions.set(callId, (this.sessions.get(callId) ?? 0) + 1);
        if (stopped()) return;
        stage = 'adapter';
        const loaded = await this.deps.loadProvider(session.provider, session.voicing, {
          liteSocket: session.controlUrl !== null,
        });
        if (stopped()) {
          loaded?.unmount();
          return;
        }
        if (loaded?.connect === undefined) {
          this.unavailable(true, { reason: 'no_adapter', stage });
          return;
        }
        attempt.adapter = loaded;
        const expires = session.expiresAt === null ? NaN : Date.parse(session.expiresAt);
        attempt.expiresAt = Number.isFinite(expires) ? expires : null;
        stage = 'room';
        loaded.mount(document.createElement('div'), { reducedMotion });
        await Promise.race([
          loaded.connect(session, signal, this.deps.relayFor(callId)),
          timeout(this.deps.connectTimeoutMs, signal),
        ]);
        if (stopped()) return;
        attempt.offLost =
          loaded.onLost?.((loss) => {
            this.lost(attempt, loss);
          }) ?? null;
        if (presentationCapabilities(loaded).audioOwner === 'presentation') {
          this.engine.attachFace(loaded.renderer?.() ?? null);
        }
        this.engine.setFaceShown(true);
        this.shown.add(callId);
        const media = loaded.media?.() ?? null;
        this.set({
          status: 'live',
          provider: loaded,
          stream: loaded.video?.() ?? null,
          media: media instanceof HTMLVideoElement ? media : null,
        });
        // The face is there: its first frame timed, the speech that waited for it goes on (to it), and a new call's
        // conversation starts (the face says the intro).
        this.engine.faceArrived();
        this.engine.holdForFace(false);
        this.engine.startConversation();
        this.watchExpiry(attempt);
      } catch (err) {
        // Read before the face is given up (which unmounts the adapter): how far its join got.
        if (!stopped()) this.unavailable(true, joinFailure(err, attempt.adapter?.joinStage?.() ?? stage));
      }
    })();
  }

  /**
   * The live face went away: a vendor session that ended (its limit, a dropped room or channel) is replaced at once,
   * the call's speech waiting for the new face; anything else gives the face up.
   */
  private lost(attempt: Attempt, loss: FaceLoss): void {
    if (this.current !== attempt) return;
    const { callId } = attempt;
    const snapshot = this.engine.getSnapshot();
    const replace =
      REPLACEABLE.has(loss.reason) &&
      snapshot.phase === 'live' &&
      snapshot.call?.id === callId &&
      snapshot.blocked?.reason !== 'crisis_support' &&
      !snapshot.held &&
      this.canAsk(callId);
    if (replace) {
      this.replace(attempt, loss);
      return;
    }
    if (snapshot.held && snapshot.phase === 'live' && REPLACEABLE.has(loss.reason) && this.canAsk(callId)) {
      // Dropped while on hold: it comes back when the call resumes.
      this.giveUp(true, loss);
      this.set({ status: 'paused' });
      return;
    }
    this.unavailable(true, loss);
  }

  /** Ends the current face on the server, then joins the next session of the call; speech waits meanwhile. */
  private replace(attempt: Attempt, loss: FaceLoss): void {
    // First, synchronously: the units the face is giving back wait for the next face (`holdForFace`).
    this.engine.holdForFace(true);
    const still = lastFrame(attempt.adapter);
    this.release(attempt);
    // Neither shown nor off: the old session is ended explicitly below, and a heartbeat reporting "off" meanwhile
    // would end the new session as it joins.
    this.engine.setFaceShown(null);
    this.set({ status: 'reconnecting', still });
    const { callId } = attempt;
    void this.deps
      .endFace(callId, loss)
      .catch(() => undefined)
      .then(() => {
        // The call may have ended, or the founder switched to voice, while the server ended the old session.
        if (this.face.status !== 'reconnecting' || this.current !== null) return;
        const snapshot = this.engine.getSnapshot();
        if (snapshot.phase !== 'live' || snapshot.call?.id !== callId) return;
        this.join('reconnecting', true, still);
      });
  }

  /**
   * The face could not start or come back: the call screen says video is not available right now and offers the
   * voice call. `tellServer`: the vendor session (if one opened) is ended there, with why. Speech that waited for the
   * face goes on, on the speakers; a call still waiting for its face keeps waiting (for the founder's choice).
   */
  private unavailable(tellServer: false): void;
  private unavailable(tellServer: true, loss: FaceLoss): void;
  private unavailable(tellServer: boolean, loss?: FaceLoss): void {
    const callId = this.current?.callId ?? this.last?.callId ?? null;
    if (tellServer && loss !== undefined) this.giveUp(true, loss);
    else this.giveUp(false);
    this.set({ status: 'unavailable', hadVideo: callId !== null && this.shown.has(callId) });
  }

  /** Releases the current face: its adapter, the engine's hand-over to it, and (`tellServer`) its vendor session. */
  private giveUp(tellServer: false): void;
  private giveUp(tellServer: true, loss: FaceLoss): void;
  private giveUp(tellServer: boolean, loss?: FaceLoss): void {
    this.clearHold();
    const attempt = this.current;
    if (attempt !== null) {
      this.release(attempt);
      // Heartbeats say the face is gone, so the server stops a session it still holds.
      this.engine.setFaceShown(false);
      if (tellServer && loss !== undefined) {
        void this.deps.endFace(attempt.callId, loss).catch(() => undefined);
      }
    }
    // Whatever waited for the face goes on without it.
    this.engine.holdForFace(false);
  }

  private release(attempt: Attempt): void {
    this.clearRefresh();
    if (this.current === attempt) this.current = null;
    attempt.controller.abort();
    attempt.offLost?.();
    attempt.offLost = null;
    attempt.adapter?.unmount();
    this.engine.attachFace(null);
  }

  /**
   * A live session close to its end (`expiresAt`) is replaced at the first quiet moment in its last
   * {@link FACE_REFRESH_LEAD_MS}: the founder's turn, nothing being said or prepared, so no reply waits on the join.
   * Without a quiet moment, the face hands over when the vendor ends it.
   */
  private watchExpiry(attempt: Attempt): void {
    this.clearRefresh();
    if (attempt.expiresAt === null) return;
    const now = this.deps.wallNow ?? Date.now;
    const lead = this.deps.refreshLeadMs ?? FACE_REFRESH_LEAD_MS;
    const check = () => {
      this.refreshTimer = null;
      if (this.current !== attempt || this.face.status !== 'live' || attempt.expiresAt === null) return;
      const left = attempt.expiresAt - now();
      if (left > lead) {
        this.refreshTimer = setTimeout(check, Math.min(left - lead, 60_000));
        return;
      }
      if (left <= 0) return;
      const s = this.engine.getSnapshot();
      const quiet =
        s.phase === 'live' &&
        !s.held &&
        !s.awaitingFace &&
        s.activity === 'listening' &&
        s.queued === 0 &&
        s.blocked === null;
      if (quiet && this.canAsk(attempt.callId)) {
        this.replace(attempt, { reason: 'time_limit' });
        return;
      }
      this.refreshTimer = setTimeout(check, REFRESH_POLL_MS);
    };
    check();
  }

  private clearRefresh(): void {
    if (this.refreshTimer === null) return;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  private follow(snapshot: CallSnapshot): void {
    // The call's face, else the live call itself: a voice call that never asked for a face still keeps a crisis turn
    // (switched to video later, it gets no face).
    const live = snapshot.phase === 'live' ? (snapshot.call?.id ?? null) : null;
    const callId = this.current?.callId ?? this.last?.callId ?? live;
    if (callId === null) {
      if (this.face.status !== 'presence') this.set(PRESENCE);
      return;
    }
    if (snapshot.phase !== 'live' || snapshot.call?.id !== callId) {
      // The call ended: its face ended with it on the server.
      if (this.current !== null || this.face.status !== 'presence') {
        this.giveUp(false);
        this.engine.setFaceShown(null);
        this.set(PRESENCE);
      }
      this.last = null;
      return;
    }
    if (snapshot.blocked?.reason === 'crisis_support') {
      if (this.over.has(callId)) return;
      this.over.add(callId);
      // A call that had (or was getting) a face: once the crisis support is read, its tile says video is not available
      // and offers the voice call (no Try again: `canAsk` is false now). A voice call stays a voice call.
      const hadFace = this.current !== null || this.face.status !== 'presence';
      if (this.current !== null) this.giveUp(true, { reason: 'crisis' });
      else this.giveUp(false);
      this.set(hadFace ? { status: 'unavailable', hadVideo: this.shown.has(callId) } : PRESENCE);
      return;
    }
    if (!snapshot.held) {
      this.clearHold();
      // Back from hold: the face given up meanwhile comes back.
      if (this.face.status === 'paused' && this.canAsk(callId)) this.join('reconnecting', false);
      return;
    }
    if (this.current === null) return;
    const attempt = this.current;
    // On hold nobody watches the face, and the vendor bills it by the minute: past the grace it ends there too.
    this.holdTimer ??= setTimeout(() => {
      this.holdTimer = null;
      if (this.current !== attempt) return;
      this.giveUp(true, { reason: 'on_hold' });
      this.set({ status: 'paused' });
    }, this.deps.holdGraceMs ?? FACE_HOLD_GRACE_MS);
  }

  private clearHold(): void {
    if (this.holdTimer === null) return;
    clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  private set(face: CallFace): void {
    if (face === this.face) return;
    if (face.status === this.face.status && face.status !== 'live' && face.status !== 'unavailable') return;
    this.face = face;
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * The last frame a face showed (a small JPEG data URL), kept on its tile while a new session replaces it; null when
 * there is none to read (no element of its own, no frame yet). Best effort.
 */
function lastFrame(adapter: AvatarProvider | null): string | null {
  try {
    const media = adapter?.media?.() ?? null;
    if (!(media instanceof HTMLVideoElement) || media.videoWidth === 0 || media.videoHeight === 0)
      return null;
    const width = Math.min(640, media.videoWidth);
    const height = Math.round((width * media.videoHeight) / media.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (context === null) return null;
    context.drawImage(media, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    return null;
  }
}

const NO_FACE = (): CallFace => PRESENCE;
const NO_SUBSCRIPTION = () => () => undefined;

/** The call's face as React sees it (the presence without a controller). */
export function useCallFace(controller: CallFaceController | null): CallFace {
  return useSyncExternalStore(
    controller?.subscribe ?? NO_SUBSCRIPTION,
    controller?.getSnapshot ?? NO_FACE,
    controller?.getSnapshot ?? NO_FACE,
  );
}
