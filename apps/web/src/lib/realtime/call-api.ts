import {
  CallHeartbeatRequest,
  CallHeartbeatResponse,
  EndCallRequest,
  EndCallResponse,
  InterruptTurnRequest,
  SpeechRequest,
  StartCallRequest,
  StartCallResponse,
  SttGrantResponse,
  type CallEndReason,
} from '@foundry/contracts';
import type { z } from 'zod';

import { encodeBody } from '../api/body';
import { api, apiSend, createIdempotencyKey, path, prepareRequest, sendRequest } from '../api/client';
import { isAbortError, isApiError } from '../api/errors';
import type { SpeechFetchResult, SpeechUnitToPlay } from './playback';

/**
 * The calls API (`packages/contracts/src/calls.ts`, docs/architecture/calls.md §2) as plain functions, so
 * the engine can take them as a dependency and tests can replace them.
 */

export type StartCallResult = z.infer<typeof StartCallResponse>;
export type HeartbeatResult = z.infer<typeof CallHeartbeatResponse>;
export type EndCallResult = z.infer<typeof EndCallResponse>;
export type EndCallBody = z.input<typeof EndCallRequest>;
export type HeartbeatBody = z.input<typeof CallHeartbeatRequest>;

/** `POST /sessions/:id/calls` */
export function startCall(
  sessionId: string,
  inputMode: z.input<typeof StartCallRequest>['inputMode'],
  signal?: AbortSignal,
): Promise<StartCallResult> {
  return api.post(
    path`/sessions/${sessionId}/calls`,
    StartCallResponse,
    encodeBody(StartCallRequest, { inputMode }),
    { idempotencyKey: createIdempotencyKey(), signal },
  );
}

/** `POST /calls/:id/stt-grant` — a fresh Transcribe URL to reconnect or unmute. */
export function refreshSttGrant(callId: string, signal?: AbortSignal) {
  return api.post(path`/calls/${callId}/stt-grant`, SttGrantResponse, undefined, {
    idempotencyKey: createIdempotencyKey(),
    signal,
  });
}

/** `POST /calls/:id/heartbeat` — every 15 s; carries the kill switch and the remaining time. */
export function sendHeartbeat(callId: string, body: HeartbeatBody): Promise<HeartbeatResult> {
  return api.post(
    path`/calls/${callId}/heartbeat`,
    CallHeartbeatResponse,
    encodeBody(CallHeartbeatRequest, body),
    {
      idempotencyKey: createIdempotencyKey(),
      // A heartbeat that waits for a waking database would arrive late and count as a missed one.
      waitForResume: false,
    },
  );
}

/** `POST /calls/:id/end` — idempotent; returns the after-call summary. */
export function endCall(callId: string, body: EndCallBody): Promise<EndCallResult> {
  return api.post(path`/calls/${callId}/end`, EndCallResponse, encodeBody(EndCallRequest, body), {
    idempotencyKey: createIdempotencyKey(),
  });
}

/** `POST /turns/:id/interrupt` — the founder spoke over the vEIR; records what they actually heard. */
export function interruptTurn(turnId: string, body: z.input<typeof InterruptTurnRequest>): Promise<void> {
  return apiSend(path`/turns/${turnId}/interrupt`, {
    method: 'POST',
    body: encodeBody(InterruptTurnRequest, body),
    idempotencyKey: createIdempotencyKey(),
    waitForResume: false,
  });
}

/**
 * Audio for one validated unit (`POST /speech`, `audio/mpeg`). Signed units and the intro carry `seq` and
 * `sig`; a passage of a stored reply carries neither. 501 `speech_unavailable` means this server has no
 * synthesis (local development), which lets the browser read the validated text itself.
 */
export async function fetchSpeech(
  sessionId: string,
  unit: SpeechUnitToPlay,
  signal: AbortSignal,
): Promise<SpeechFetchResult> {
  const body = encodeBody(SpeechRequest, {
    sessionId,
    turnId: unit.turnId,
    text: unit.text,
    ...(unit.sig === undefined ? {} : { seq: unit.seq, sig: unit.sig }),
  });
  try {
    const response = await sendRequest('/speech', {
      method: 'POST',
      body,
      signal,
      accept: 'audio/mpeg, application/problem+json',
      waitForResume: false,
    });
    return { kind: 'audio', data: await response.arrayBuffer() };
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (isApiError(error) && (error.status === 501 || error.code === 'speech_unavailable')) {
      return { kind: 'unavailable' };
    }
    return { kind: 'failed' };
  }
}

/**
 * Ends a call while the page is going away. `navigator.sendBeacon` cannot send the CSRF header or the
 * payload hash CloudFront's origin access control signs, so the same beacon semantics come from a
 * `keepalive` fetch whose headers were prepared ahead of time (hashing is asynchronous, page hide is not).
 */
export interface PreparedBeacon {
  send(): void;
}

export async function prepareEndBeacon(callId: string, reason: CallEndReason): Promise<PreparedBeacon> {
  const prepared = await prepareRequest(path`/calls/${callId}/end`, {
    method: 'POST',
    body: encodeBody(EndCallRequest, { reason }),
    idempotencyKey: createIdempotencyKey(),
  });
  return {
    send: () => {
      void fetch(prepared.url, { ...prepared.init, keepalive: true, signal: null }).catch(() => undefined);
    },
  };
}
