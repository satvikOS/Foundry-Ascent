import {
  AvatarSessionRequest,
  AvatarSessionResponse,
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
import { errorMessage, isAbortError, isApiError, type ClientErrorCode } from '../api/errors';
import type { CallFailure } from './call-state';
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

/**
 * `POST /sessions/:id/calls`. `replace` ends the founder's live call in another conversation (asked first);
 * without it such a call refuses the start with 409 `conflict`.
 */
export function startCall(
  sessionId: string,
  inputMode: z.input<typeof StartCallRequest>['inputMode'],
  replace = false,
  signal?: AbortSignal,
): Promise<StartCallResult> {
  return api.post(
    path`/sessions/${sessionId}/calls`,
    StartCallResponse,
    encodeBody(StartCallRequest, replace ? { inputMode, replace: true } : { inputMode }),
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

/**
 * `POST /calls/avatar-session` — the face of a live call: a vendor's single-use session token for the browser
 * adapter, or the presence (no token). Never retried with the same key: a token is minted once.
 */
export function startAvatarSession(
  ventureId: string,
  callId: string,
  signal?: AbortSignal,
): Promise<z.infer<typeof AvatarSessionResponse>> {
  return api.post(
    path`/calls/avatar-session`,
    AvatarSessionResponse,
    encodeBody(AvatarSessionRequest, { ventureId, callId }),
    { idempotencyKey: createIdempotencyKey(), signal },
  );
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

/** A unit of the reply the founder heard to its end, as played (streamed units carry their signature). */
export interface HeardUnitBody {
  seq: number;
  text: string;
  sig?: string;
}

export type InterruptBody = z.input<typeof InterruptTurnRequest> & {
  /**
   * Units 0…`heardSeq` as played, so the server can replay exactly what was heard in the conversation's
   * history. Sent once the contract carries the field; `encodeBody` drops what the contract does not know.
   */
  heard?: HeardUnitBody[];
};

/** `POST /turns/:id/interrupt` — the founder spoke over the vEIR; records what they actually heard. */
export function interruptTurn(turnId: string, body: InterruptBody): Promise<void> {
  return apiSend(path`/turns/${turnId}/interrupt`, {
    method: 'POST',
    body: encodeBody(InterruptTurnRequest, body),
    idempotencyKey: createIdempotencyKey(),
    waitForResume: false,
  });
}

/** The face-audio manifest of a unit (`POST /speech` response, `POST /calls/:id/face/speak` request). */
export const FACE_MANIFEST_HEADER = 'x-face-manifest';
/** The first one-second chunk a face hand-over carries. */
export const FACE_PART_HEADER = 'x-face-part';
/** Bytes of one second of the face's audio (16-bit mono at 24 kHz). */
export const FACE_CHUNK_BYTES = 48_000;
/** Seconds of audio one hand-over may carry (the API reads at most 1 MiB per request). */
export const FACE_PART_CHUNKS = 18;

/**
 * `POST /calls/:id/face/speak` — hands the call's face one unit's audio (in parts of at most 18 s): the exact PCM
 * `POST /speech` returned with its manifest. The server checks every chunk before relaying it to the face.
 */
export async function sendFaceAudio(
  callId: string,
  audio: { readonly pcm: Uint8Array; readonly manifest: string },
  signal: AbortSignal,
): Promise<void> {
  const part = FACE_CHUNK_BYTES * FACE_PART_CHUNKS;
  for (let offset = 0; offset < audio.pcm.byteLength; offset += part) {
    await apiSend(path`/calls/${callId}/face/speak`, {
      method: 'POST',
      rawBody: audio.pcm.subarray(offset, Math.min(audio.pcm.byteLength, offset + part)),
      headers: {
        [FACE_MANIFEST_HEADER]: audio.manifest,
        [FACE_PART_HEADER]: String(offset / FACE_CHUNK_BYTES),
      },
      signal,
      waitForResume: false,
    });
  }
}

/** `POST /calls/:id/face/interrupt` — barge-in: the face drops what it still has to say. Best effort. */
export function interruptFace(callId: string): Promise<void> {
  return apiSend(path`/calls/${callId}/face/interrupt`, { method: 'POST', waitForResume: false });
}

/** `POST /calls/:id/face/end` — the face is no longer shown: the vendor session ends. Best effort. */
export function endFace(callId: string): Promise<void> {
  return apiSend(path`/calls/${callId}/face/end`, { method: 'POST', waitForResume: false });
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
      accept: 'audio/mpeg, audio/wav, application/problem+json',
      waitForResume: false,
    });
    const faceManifest = response.headers.get(FACE_MANIFEST_HEADER);
    const data = await response.arrayBuffer();
    return faceManifest ? { kind: 'audio', data, faceManifest } : { kind: 'audio', data };
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (!isApiError(error)) return { kind: 'failed' };
    // The problem's `reason` says which refusal of a shared code (409 `conflict`, 429 `rate_limited`) it is.
    switch (error.reason) {
      // A signed unit or the intro already voiced for this call (or the crisis support line played as often
      // as it may): it stays on screen and is never asked for again.
      case 'speech_already_played':
      case 'crisis_speech_limit':
        return { kind: 'played' };
      // The call's or the person's speech budget is used up: words only for the rest of the call.
      case 'call_speech_limit':
      case 'daily_speech_limit':
        return { kind: 'paused' };
      default:
        break;
    }
    if (error.status === 501 || error.code === 'speech_unavailable') return { kind: 'unavailable' };
    // Known refusals hold for the rest of the call; anything else (including a code this client does not
    // know yet) shows this unit as words and asks again for the next one.
    const known = error.serverCode === undefined || error.serverCode === error.code;
    return known && CALL_SPEECH_REFUSALS.has(error.code) ? { kind: 'refused' } : { kind: 'failed' };
  }
}

/**
 * Refusals that hold for the rest of the call (the kill switch, spend and minute caps, a paused vEIR or its
 * voice consent, lost access). Anything else concerns one unit (a dropped connection, a busy synthesiser, a
 * reply that can no longer be spoken) and the next unit asks again.
 */
const CALL_SPEECH_REFUSALS: ReadonlySet<ClientErrorCode> = new Set<ClientErrorCode>([
  'ai_disabled',
  'spend_cap_reached',
  'rate_limited',
  'persona_suspended',
  'assignment_inactive',
  'forbidden',
  'unauthenticated',
]);

/**
 * `DELETE /sessions/:id` — removes the conversation a call from New chat created when the call never started
 * (refused, cancelled), so a failed call leaves no empty conversation behind.
 */
export function discardConversation(sessionId: string): Promise<void> {
  return api.delete(path`/sessions/${sessionId}`, { idempotencyKey: createIdempotencyKey() });
}

/** Codes whose server message is written for the person calling and says more than the generic one. */
const CALL_DETAIL_CODES: ReadonlySet<ClientErrorCode> = new Set<ClientErrorCode>([
  'conflict',
  'ai_disabled',
  'rate_limited',
  'spend_cap_reached',
  'persona_suspended',
  'assignment_inactive',
  'session_ended',
]);

/** A failure of the calls API in plain words: the server's own message for call refusals. */
export function callErrorMessage(error: unknown): string {
  if (isApiError(error) && error.code === 'spend_cap_reached') {
    // The daily AI allowance covers typed chat as well, so say so, and that nothing was lost.
    return `${error.detail ?? 'Today’s AI allowance is used up. It resets at midnight UTC.'} Chat pauses too until then. Your conversation is saved.`;
  }
  if (isApiError(error) && error.detail && CALL_DETAIL_CODES.has(error.code)) return error.detail;
  return errorMessage(error);
}

/** Why a call ended, when it was not the founder's own choice (the summary and the mini bar say it). */
export const CALL_END_LINES: Partial<Record<CallEndReason, string>> = {
  timeout: 'The call reached its time limit.',
  disabled: 'Calls were paused by the program.',
  error: 'The connection was lost.',
};

/**
 * Why a call ended for its budget (`budget`), in plain words. The server ends a call for today's call
 * minutes or for today's AI allowance; the refreshed call settings tell which: with minutes left, it was the
 * allowance, which pauses typed chat too.
 */
export function budgetEndLine(remainingMinutesToday: number | undefined): string {
  if (remainingMinutesToday === undefined) {
    return 'Today’s call allowance is used up. Your conversation is saved.';
  }
  if (remainingMinutesToday < 1) {
    return 'Today’s call minutes are used up. Chat still works.';
  }
  return 'Today’s AI allowance is used up. Chat pauses too until midnight UTC. Your conversation is saved.';
}

/** What the founder is asked when they are already in a call in another conversation. */
export const CALL_ELSEWHERE_MESSAGE =
  'You’re in a call elsewhere. Move it here? That call ends; its transcript stays.';

/** Why a call could not start; trying again is offered only when it may help (a network or server hiccup). */
export function startFailure(error: unknown): CallFailure {
  // The one conflict a start answers: a live call in another conversation (`replace` moves it here).
  if (isApiError(error) && error.status === 409 && error.code === 'conflict') {
    return { message: CALL_ELSEWHERE_MESSAGE, retry: false, elsewhere: true };
  }
  const transient =
    !isApiError(error) ||
    error.isTransient ||
    error.code === 'database_resuming' ||
    error.code === 'internal' ||
    error.code === 'invalid_response';
  return { message: callErrorMessage(error), retry: transient };
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
