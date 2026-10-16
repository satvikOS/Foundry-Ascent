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
  const synthesis =
    typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;

  return {
    api: {
      startCall: (sessionId, inputMode) => startCall(sessionId, inputMode),
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
 * Whether calls in this browser close the microphone while the vEIR speaks (call design §2.4): on iOS and
 * iPadOS, where every browser is WebKit, echo cancellation does not reliably keep the vEIR's own voice out
 * of the microphone the recogniser hears. The founder interrupts with a tap instead.
 */
export function prefersHalfDuplex(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /\b(iPhone|iPad|iPod)\b/.test(ua) || (/\bMacintosh\b/.test(ua) && navigator.maxTouchPoints > 1);
}
