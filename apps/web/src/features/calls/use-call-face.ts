import type { AvatarSessionResponse, AvatarVoicing, EmbodimentProviderId } from '@foundry/contracts';
import { useSyncExternalStore } from 'react';

import { loadAvatarProvider, type AvatarProvider, type FaceRelay } from '@/lib/realtime/avatar';
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
 * The face of a live call (docs/architecture/calls.md §4). The presence is the face until a vendor face is
 * live: the API opens the vendor's session for this call, the adapter loads (its own chunk) and joins, and only
 * then does the call tile show its video and hand it the call's audio (through the server, which relays only
 * the audio it synthesized) or, for a FULL stock face, the validated units the server admits for the vendor to
 * say. A stock face is labelled "AI avatar" (`stock`). Anything that fails (no face offered, no adapter, a slow or refused join, the
 * vendor dropping, the server saying stop) leaves the call on the presence and its own speakers, without a word
 * to the founder: the call itself never stops for its face.
 *
 * The face belongs to the call, not to the screen: it lives in the call's controller (one per call engine), so
 * minimizing the call to the mini bar keeps it, and it ends with the call. One face per call: a face that
 * dropped is not asked for again (the server would refuse; nothing bills unseen). A call left on hold (the page
 * hidden) for longer than {@link FACE_HOLD_GRACE_MS} gives its face up, since the vendor bills an idle face by
 * the minute; a quick look at another tab keeps it.
 */
export type CallFace =
  | { readonly status: 'presence' }
  | { readonly status: 'connecting' }
  | {
      readonly status: 'live';
      readonly provider: AvatarProvider;
      readonly stream: MediaStream | null;
      /**
       * The face's own element, playing its video and audio together (a vendor face): the call tile shows it, so
       * the voice is heard in step with the lips. Null: the tile shows `stream`, muted (the canvas stand-in).
       */
      readonly media: HTMLVideoElement | null;
      /** A vendor's stock avatar (no one's likeness): the tile labels it "AI avatar". */
      readonly stock: boolean;
    };

export interface CallFaceDeps {
  startSession(ventureId: string, callId: string, signal: AbortSignal): Promise<AvatarSessionResponse>;
  loadProvider(id: EmbodimentProviderId, voicing: AvatarVoicing): Promise<AvatarProvider | null>;
  /** The server path of the face's audio for this call. */
  relayFor(callId: string): FaceRelay;
  /** Tells the server the face is no longer shown (it ends the vendor session). */
  endFace(callId: string): Promise<void>;
  /** A face that has not shown its first frame by then is given up for this call. */
  readonly connectTimeoutMs: number;
  /** A call on hold longer than this gives its face up (default {@link FACE_HOLD_GRACE_MS}). */
  readonly holdGraceMs?: number;
}

/** How long a call may stay on hold (the page hidden) before its face is given up: the vendor bills idle faces. */
export const FACE_HOLD_GRACE_MS = 60_000;

export const BROWSER_FACE_DEPS: CallFaceDeps = {
  startSession: startAvatarSession,
  loadProvider: loadAvatarProvider,
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
  'attachFace' | 'setFaceShown' | 'onFaceStop' | 'subscribe' | 'getSnapshot'
>;

const PRESENCE: CallFace = { status: 'presence' };

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

export class CallFaceController {
  private face: CallFace = PRESENCE;
  private readonly listeners = new Set<() => void>();
  /** Calls that already asked for their face (once per call). */
  private readonly asked = new Set<string>();
  private current: {
    readonly callId: string;
    readonly controller: AbortController;
    adapter: AvatarProvider | null;
    offLost: (() => void) | null;
  } | null = null;
  /** Runs out when the call stayed on hold too long. */
  private holdTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly engine: FaceEngine,
    private readonly deps: CallFaceDeps = BROWSER_FACE_DEPS,
  ) {
    // The call ending (or moving to another call) ends its face; a crisis turn drops it to the presence: a
    // human-looking face never says the crisis line.
    engine.subscribe(() => {
      this.follow(engine.getSnapshot());
    });
    engine.onFaceStop(() => {
      // The server already ended it (faces off, likeness withdrawn, minutes used up).
      this.close(false);
    });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): CallFace => this.face;

  /** Asks for the face of this live call, once (a call that already asked, or has one, is left as it is). */
  request({ provider, ventureId, callId, reducedMotion }: FaceRequest): void {
    if (provider === 'builtin' || this.asked.has(callId)) return;
    const snapshot = this.engine.getSnapshot();
    if (snapshot.phase !== 'live' || snapshot.call?.id !== callId) return;
    this.asked.add(callId);
    const controller = new AbortController();
    const { signal } = controller;
    /** Read after every await: giving up or the call ending may have happened meanwhile. */
    const stopped = () => signal.aborted;
    const attempt = {
      callId,
      controller,
      adapter: null as AvatarProvider | null,
      offLost: null as (() => void) | null,
    };
    this.current = attempt;
    this.set({ status: 'connecting' });
    void (async () => {
      try {
        const session = await this.deps.startSession(ventureId, callId, signal);
        if (stopped()) return;
        if (session.token === null || session.provider === 'builtin') {
          this.close(false);
          return;
        }
        const loaded = await this.deps.loadProvider(session.provider, session.voicing);
        if (stopped()) {
          loaded?.unmount();
          return;
        }
        if (loaded?.connect === undefined) {
          this.close(true);
          return;
        }
        attempt.adapter = loaded;
        loaded.mount(document.createElement('div'), { reducedMotion });
        await Promise.race([
          loaded.connect(session, signal, this.deps.relayFor(callId)),
          timeout(this.deps.connectTimeoutMs, signal),
        ]);
        if (stopped()) return;
        attempt.offLost =
          loaded.onLost?.(() => {
            this.close(true);
          }) ?? null;
        if (loaded.voicing === 'audio' || loaded.voicing === 'text') {
          this.engine.attachFace(loaded.renderer?.() ?? null);
        }
        this.engine.setFaceShown(true);
        const media = loaded.media?.() ?? null;
        this.set({
          status: 'live',
          provider: loaded,
          stream: loaded.video?.() ?? null,
          media: media instanceof HTMLVideoElement ? media : null,
          stock: session.stockFace,
        });
      } catch {
        if (!stopped()) this.close(true);
      }
    })();
  }

  /**
   * Gives the face up (the presence again). `tellServer`: the server does not know yet (the face dropped, or
   * was given up while joining), so the vendor session is ended there too.
   */
  close(tellServer: boolean): void {
    this.clearHold();
    const attempt = this.current;
    this.current = null;
    if (attempt !== null) {
      attempt.controller.abort();
      attempt.offLost?.();
      attempt.adapter?.unmount();
      this.engine.attachFace(null);
      // Heartbeats say the face is gone, so the server stops a session it still holds.
      this.engine.setFaceShown(false);
      if (tellServer) void this.deps.endFace(attempt.callId).catch(() => undefined);
    }
    this.set(PRESENCE);
  }

  private follow(snapshot: CallSnapshot): void {
    const attempt = this.current;
    if (attempt === null) return;
    if (snapshot.phase !== 'live' || snapshot.call?.id !== attempt.callId) {
      // The call ended: its face ended with it on the server.
      this.close(false);
      this.engine.setFaceShown(null);
      return;
    }
    if (snapshot.blocked?.reason === 'crisis_support') {
      this.close(true);
      return;
    }
    if (!snapshot.held) {
      this.clearHold();
      return;
    }
    // On hold nobody watches the face, and the vendor bills it by the minute: past the grace it ends there too.
    this.holdTimer ??= setTimeout(() => {
      this.holdTimer = null;
      if (this.current === attempt) this.close(true);
    }, this.deps.holdGraceMs ?? FACE_HOLD_GRACE_MS);
  }

  private clearHold(): void {
    if (this.holdTimer === null) return;
    clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  private set(face: CallFace): void {
    if (face === this.face) return;
    this.face = face;
    for (const listener of [...this.listeners]) listener();
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
