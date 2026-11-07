import { CreateRecordingRequest, RecordingListQuery } from '@foundry/contracts';
import { type Core } from '@foundry/core';

import { jsonBody, pathParam, queryParams } from '../http/input.js';
import { type RouteBuilder } from '../http/router.js';

/**
 * Call recordings (ADR-0023, docs/architecture/calls.md §7): the caller's own recordings only. The files never pass
 * through the API: it issues presigned PUTs for the upload and presigned GETs for replay, after checking ownership.
 */
export function registerRecordingRoutes(r: RouteBuilder, core: Core): void {
  // The response carries presigned upload URLs (short-lived, one key each): never stored for replay, so a retry
  // registers a fresh recording rather than re-sending another request's URLs.
  r.post(
    '/calls/:id/recordings',
    async (c, ctx) =>
      c.json(await core.recordings.create(ctx, pathParam(c, 'id'), jsonBody(c, CreateRecordingRequest)), 201),
    { idempotency: 'none' },
  );
  // Idempotent: completing a ready recording returns it.
  r.post('/recordings/:id/complete', async (c, ctx) =>
    c.json(await core.recordings.complete(ctx, pathParam(c, 'id'))),
  );
  r.get('/recordings', async (c, ctx) =>
    c.json(await core.recordings.list(ctx, queryParams(c, RecordingListQuery))),
  );
  // Presigned GETs (a credential for as long as the recording lasts): each request issues fresh ones.
  r.get('/recordings/:id/playback', async (c, ctx) =>
    c.json(await core.recordings.playback(ctx, pathParam(c, 'id'))),
  );
  r.delete('/recordings/:id', async (c, ctx) => {
    await core.recordings.remove(ctx, pathParam(c, 'id'));
    return c.body(null, 204);
  });
}
