import type { AvatarSessionResponse, EmbodimentProviderId } from '@foundry/contracts';
import { useEffect, useState } from 'react';

import { loadAvatarProvider, type AvatarProvider } from '@/lib/realtime/avatar';
import { startAvatarSession } from '@/lib/realtime/call-api';
import type { CallEngine } from '@/lib/realtime/call-engine';

/**
 * The face of a live call (docs/architecture/calls.md §4). The presence is the face until a vendor face is
 * live: the API mints the vendor's single-use session for this call, the adapter loads (its own chunk) and
 * connects, and only then does the call tile show its video and, with voicing `audio`, hand it the call's
 * audio. Anything that fails (no token, no adapter, a slow or refused connection, the vendor dropping
 * mid-call) leaves the call on the presence and its own speakers, without a word to the founder: the call
 * itself never stops for its face.
 */
export type CallFace =
  | { readonly status: 'presence' }
  | { readonly status: 'connecting' }
  | { readonly status: 'live'; readonly provider: AvatarProvider; readonly stream: MediaStream | null };

export interface CallFaceDeps {
  startSession(ventureId: string, callId: string, signal: AbortSignal): Promise<AvatarSessionResponse>;
  loadProvider(id: EmbodimentProviderId): Promise<AvatarProvider | null>;
  /** A face that has not shown its first frame by then is given up for this call. */
  readonly connectTimeoutMs: number;
}

export const BROWSER_FACE_DEPS: CallFaceDeps = {
  startSession: startAvatarSession,
  loadProvider: loadAvatarProvider,
  connectTimeoutMs: 8_000,
};

export interface UseCallFaceOptions {
  /** Who draws the face (the call settings). `builtin` never asks for a session. */
  readonly provider: EmbodimentProviderId;
  readonly ventureId: string | null;
  /** The live call; null while it starts or after it ended. */
  readonly callId: string | null;
  readonly engine: Pick<CallEngine, 'attachFace'>;
  readonly reducedMotion: boolean;
}

const PRESENCE: CallFace = { status: 'presence' };

function timeout(ms: number, signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('The face took too long to connect'));
    }, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
    });
  });
}

export function useCallFace(
  { provider, ventureId, callId, engine, reducedMotion }: UseCallFaceOptions,
  deps: CallFaceDeps = BROWSER_FACE_DEPS,
): CallFace {
  const [face, setFace] = useState<CallFace>(PRESENCE);

  useEffect(() => {
    if (provider === 'builtin' || ventureId === null || callId === null) {
      setFace(PRESENCE);
      return undefined;
    }
    // One attempt per call: giving up (or the stage closing) aborts whatever is still in flight, so a face
    // that connects late never starts a vendor session nobody sees (and nobody should pay for).
    const controller = new AbortController();
    const { signal } = controller;
    /** Read after every await: giving up or closing may have happened meanwhile. */
    const stopped = () => signal.aborted;
    // Set by the cleanup, which may run while the attempt awaits.
    let closed = false as boolean;
    let adapter: AvatarProvider | null = null;
    let offLost: (() => void) | null = null;
    const giveUp = () => {
      controller.abort();
      engine.attachFace(null);
      offLost?.();
      offLost = null;
      adapter?.unmount();
      adapter = null;
      if (!closed) setFace(PRESENCE);
    };

    setFace({ status: 'connecting' });
    void (async () => {
      try {
        const session = await deps.startSession(ventureId, callId, signal);
        if (stopped()) return;
        if (session.token === null || session.provider === 'builtin') {
          giveUp();
          return;
        }
        const loaded = await deps.loadProvider(session.provider);
        if (stopped()) {
          loaded?.unmount();
          return;
        }
        if (loaded?.connect === undefined) {
          giveUp();
          return;
        }
        adapter = loaded;
        loaded.mount(document.createElement('div'), { reducedMotion });
        await Promise.race([loaded.connect(session, signal), timeout(deps.connectTimeoutMs, signal)]);
        if (stopped()) return;
        offLost = loaded.onLost?.(giveUp) ?? null;
        if (loaded.voicing === 'audio') engine.attachFace(loaded.renderer?.() ?? null);
        setFace({ status: 'live', provider: loaded, stream: loaded.video?.() ?? null });
      } catch {
        if (!closed) giveUp();
      }
    })();

    return () => {
      closed = true;
      giveUp();
    };
    // The face belongs to one call: a new call (or provider) starts over. Reduced motion is read at connect.
  }, [provider, ventureId, callId, engine, deps]);

  return face;
}
