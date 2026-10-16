import type { TurnView } from '@foundry/contracts';

import { streamTurn } from '../api/sse';
import {
  endCall,
  fetchSpeech,
  interruptTurn,
  prepareEndBeacon,
  refreshSttGrant,
  sendHeartbeat,
  startCall,
} from './call-api';
import type { CallAudioContext, CallEngineDeps } from './call-engine';

/** The engine's dependencies in a real browser: the calls API, Web Audio, WebSocket and the clock. */
export function browserCallDeps(
  onTurnSettled: (sessionId: string, turn: TurnView | null) => void,
): CallEngineDeps {
  const mediaDevices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
  const getUserMedia =
    typeof mediaDevices?.getUserMedia === 'function'
      ? (constraints: MediaStreamConstraints) => mediaDevices.getUserMedia(constraints)
      : null;
  const synthesis = developmentSpeechSynthesis(
    import.meta.env.DEV,
    typeof window === 'undefined' ? undefined : window,
  );

  return {
    api: {
      startCall: (sessionId, inputMode, replace) => startCall(sessionId, inputMode, replace),
      refreshSttGrant: (callId) => refreshSttGrant(callId),
      heartbeat: sendHeartbeat,
      endCall,
      interruptTurn,
      streamTurn,
      fetchSpeech,
      prepareEndBeacon,
    },
    media: {
      createAudioContext: () =>
        typeof AudioContext === 'undefined' ? null : new AudioContext({ latencyHint: 'interactive' }),
      getUserMedia,
      createWorkletNode: (context: CallAudioContext, name, options) =>
        new AudioWorkletNode(context as unknown as BaseAudioContext, name, options),
      createSocket: (url) => new WebSocket(url),
      synthesis,
      createUtterance: (text) => new SpeechSynthesisUtterance(text),
    },
    clock: {
      now: () => Date.now(),
      setTimeout: (callback, ms) => window.setTimeout(callback, ms),
      clearTimeout: (handle) => {
        window.clearTimeout(handle as number);
      },
      setInterval: (callback, ms) => window.setInterval(callback, ms),
      clearInterval: (handle) => {
        window.clearInterval(handle as number);
      },
    },
    onTurnSettled,
  };
}

/**
 * The browser's speech synthesis for the call's reading fallback (a `501 speech_unavailable` from the server):
 * development builds only. In production the browser never reads the vEIR's words aloud, because its voices
 * can send the text to an online service and are not the vEIR's voice; the call shows captions instead. The
 * player further limits the fallback to voices on the device (`localEnglishVoice`).
 */
export function developmentSpeechSynthesis(
  development: boolean,
  win: Pick<Window, 'speechSynthesis'> | undefined,
): SpeechSynthesis | null {
  if (!development || win === undefined || !('speechSynthesis' in win)) return null;
  return win.speechSynthesis;
}

/**
 * Whether calls in this browser close the microphone while the vEIR speaks (call design §2.4): on iOS and
 * iPadOS, where every browser is WebKit, echo cancellation does not reliably keep the vEIR's own voice out
 * of the microphone the recogniser hears. The founder interrupts with a tap instead.
 */
export function prefersHalfDuplex(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /\b(iPhone|iPad|iPod)\b/.test(ua) || (/\bMacintosh\b/.test(ua) && navigator.maxTouchPoints > 1);
}
