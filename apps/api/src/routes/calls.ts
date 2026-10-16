import {
  CallHeartbeatRequest,
  EndCallRequest,
  InterruptTurnRequest,
  StartCallRequest,
} from '@foundry/contracts';
import { type Core } from '@foundry/core';

import { jsonBody, pathParam } from '../http/input.js';
import { type RouteBuilder } from '../http/router.js';

/**
 * Voice calls (docs/architecture/calls.md §2). Spoken turns use `POST /sessions/:id/turns` with
 * `channel: 'voice'` and the call id; speech of validated text is `POST /speech`.
 */
export function registerCallRoutes(r: RouteBuilder, core: Core): void {
  // The response carries a presigned speech-to-text URL (a short-lived credential), so it is never stored for
  // replay. A retry in the same conversation replaces the call the first attempt started.
  r.post(
    '/sessions/:id/calls',
    async (c, ctx) =>
      c.json(await core.calls.start(ctx, pathParam(c, 'id'), jsonBody(c, StartCallRequest)), 201),
    { idempotency: 'none' },
  );
  r.get('/calls/:id', async (c, ctx) => c.json(await core.calls.get(ctx, pathParam(c, 'id'))));
  // A fresh presigned URL on reconnect or unmute (never stored for replay).
  r.post(
    '/calls/:id/stt-grant',
    async (c, ctx) => c.json(await core.calls.sttGrant(ctx, pathParam(c, 'id'))),
    {
      idempotency: 'none',
    },
  );
  // Every 15 s: time left, or `terminate` with the reason. Each beat is new, so nothing is replayed.
  r.post(
    '/calls/:id/heartbeat',
    async (c, ctx) =>
      c.json(await core.calls.heartbeat(ctx, pathParam(c, 'id'), jsonBody(c, CallHeartbeatRequest))),
    { idempotency: 'none' },
  );
  // Idempotent: ending an ended call returns it with its summary.
  r.post('/calls/:id/end', async (c, ctx) =>
    c.json(await core.calls.end(ctx, pathParam(c, 'id'), jsonBody(c, EndCallRequest))),
  );
  // The first-call privacy notice was read: stored with the person, once (idempotent, audited the first time).
  r.post('/calls/notice/acknowledge', async (c, ctx) => c.json(await core.calls.acknowledgeNotice(ctx)));
  // Barge-in: the founder spoke over the reply; records what they heard.
  r.post('/turns/:id/interrupt', async (c, ctx) => {
    await core.calls.interrupt(ctx, pathParam(c, 'id'), jsonBody(c, InterruptTurnRequest));
    return c.body(null, 204);
  });
}
