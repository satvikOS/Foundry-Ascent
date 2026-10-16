import { AvatarSessionRequest, SpeechRequest, UpdateNotebookRequest } from '@foundry/contracts';
import { type Core } from '@foundry/core';

import { jsonBody, pathParam } from '../http/input.js';
import { type RouteBuilder } from '../http/router.js';

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
  // Reserved for single-use vendor avatar tokens: never stored for idempotent replay.
  r.post(
    '/calls/avatar-session',
    async (c, ctx) => c.json(await core.veir.avatarSession(ctx, jsonBody(c, AvatarSessionRequest))),
    { idempotency: 'none' },
  );
  // Audio of a validated reply (audio/mpeg, streamed as it is synthesized). Not replayable: a retry
  // synthesizes again (and is metered again), so clients cache the audio they received.
  r.post(
    '/speech',
    async (c, ctx) => {
      const speech = await core.speech.synthesize(ctx, jsonBody(c, SpeechRequest), {
        signal: c.req.raw.signal,
      });
      return new Response(speech.audio, {
        status: 200,
        headers: { 'content-type': speech.contentType, 'x-speech-characters': String(speech.characters) },
      });
    },
    { idempotency: 'none' },
  );
}
