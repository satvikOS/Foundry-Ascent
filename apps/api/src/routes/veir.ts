import { AvatarSessionRequest, SpeechRequest, UpdateNotebookRequest } from '@foundry/contracts';
import { type Core } from '@foundry/core';

import { jsonBody, pathParam } from '../http/input.js';
import { httpError } from '../http/problem.js';
import { type RouteBuilder } from '../http/router.js';

/** The face-audio manifest of a unit (`POST /speech` response, `POST /calls/:id/face/speak` request). */
export const FACE_MANIFEST_HEADER = 'x-face-manifest';
/** The first one-second chunk a face hand-over carries. */
export const FACE_PART_HEADER = 'x-face-part';

/** The venture's vEIR: its notebook (specific pool), identity, calls and speech (knowledge pools, §3.4). */
export function registerVeirRoutes(r: RouteBuilder, core: Core): void {
  // Notebook ------------------------------------------------------------------------------------------
  r.get('/ventures/:id/notebook', async (c, ctx) => c.json(await core.notebook.get(ctx, pathParam(c, 'id'))));
  // Every edit carries the version it was made against: 409 `conflict` when the notebook changed meanwhile.
  r.patch('/ventures/:id/notebook', async (c, ctx) =>
    c.json(await core.notebook.update(ctx, pathParam(c, 'id'), jsonBody(c, UpdateNotebookRequest))),
  );

  // Identity and calls --------------------------------------------------------------------------------
  r.get('/ventures/:id/veir', async (c, ctx) => c.json(await core.veir.identity(ctx, pathParam(c, 'id'))));
  r.get('/ventures/:id/call-config', async (c, ctx) =>
    c.json(await core.veir.callConfig(ctx, pathParam(c, 'id'))),
  );
  // The call's face: a vendor room token (a credential) is never stored for idempotent replay.
  r.post(
    '/calls/avatar-session',
    async (c, ctx) => c.json(await core.veir.avatarSession(ctx, jsonBody(c, AvatarSessionRequest))),
    { idempotency: 'none' },
  );
  // Audio of a validated reply (audio/mpeg, streamed as it is synthesized; audio/wav with its face-audio manifest
  // when the call's face may show it). Not replayable: a retry synthesizes again (and is metered again), so
  // clients cache the audio they received.
  r.post(
    '/speech',
    async (c, ctx) => {
      const speech = await core.speech.synthesize(ctx, jsonBody(c, SpeechRequest), {
        signal: c.req.raw.signal,
      });
      return new Response(speech.audio, {
        status: 200,
        headers: {
          'content-type': speech.contentType,
          'x-speech-characters': String(speech.characters),
          ...(speech.faceManifest === undefined ? {} : { [FACE_MANIFEST_HEADER]: speech.faceManifest }),
        },
      });
    },
    { idempotency: 'none' },
  );

  // The face of a call (docs/architecture/calls.md §4). Never replayed: each is an action on a live session.
  // Hands the face one part of a unit's audio: the exact bytes `POST /speech` returned (raw PCM, the WAV's
  // payload) with their manifest; anything else is refused before the vendor sees it.
  r.post(
    '/calls/:id/face/speak',
    async (c, ctx) => {
      const manifest = c.req.header(FACE_MANIFEST_HEADER) ?? '';
      const part = Number(c.req.header(FACE_PART_HEADER) ?? '0');
      if (manifest === '' || !Number.isInteger(part) || part < 0) {
        throw httpError.badRequest('A face hand-over names its manifest and part', 'face_part_invalid');
      }
      await core.face.speak(ctx, pathParam(c, 'id'), {
        manifest,
        firstChunk: part,
        pcm: c.get('rawBody') ?? new Uint8Array(0),
      });
      return c.body(null, 204);
    },
    { idempotency: 'none' },
  );
  r.post(
    '/calls/:id/face/interrupt',
    async (c, ctx) => {
      await core.face.interrupt(ctx, pathParam(c, 'id'));
      return c.body(null, 204);
    },
    { idempotency: 'none' },
  );
  // The browser stopped showing the face (it dropped): the vendor session ends, so it stops billing.
  r.post(
    '/calls/:id/face/end',
    async (c, ctx) => {
      await core.face.drop(ctx, pathParam(c, 'id'));
      return c.body(null, 204);
    },
    { idempotency: 'none' },
  );
}
