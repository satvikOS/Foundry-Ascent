import {
  CreateDocumentRequest,
  CreateSessionRequest,
  SessionListQuery,
  TurnFeedbackRequest,
  UpdateSessionRequest,
} from '@foundry/contracts';
import { type Core } from '@foundry/core';

import { jsonBody, pathParam, queryParams } from '../http/input.js';
import { type RouteBuilder } from '../http/router.js';
import { handleTurnRequest, type TurnStreamOptions } from '../http/turn-stream.js';
import { distillAfterTurn } from '../jobs/distill-triggers.js';

/** Coaching sessions, turns (SSE) and documents (system design §6, §6.1, §8). */
export function registerSessionRoutes(
  r: RouteBuilder,
  core: Core,
  turnOptions: Omit<TurnStreamOptions, 'orchestrator'>,
): void {
  // Sessions ------------------------------------------------------------------------------------------
  r.post('/ventures/:id/sessions', async (c, ctx) => {
    const session = await core.sessions.create(ctx, pathParam(c, 'id'), jsonBody(c, CreateSessionRequest));
    // The person's previous conversation is distilled now if no trigger covered it yet.
    await core.distill.afterCreate(ctx, session);
    return c.json(session, 201);
  });
  r.get('/ventures/:id/sessions', async (c, ctx) =>
    c.json({ items: await core.sessions.list(ctx, pathParam(c, 'id')) }),
  );
  // The caller's conversations across their ventures, latest activity first (sidebar recents).
  r.get('/sessions', async (c, ctx) => {
    const page = await core.sessions.listMine(ctx, queryParams(c, SessionListQuery));
    return c.json({ items: page.items, nextCursor: page.nextCursor });
  });
  r.get('/sessions/:id', async (c, ctx) => c.json(await core.sessions.get(ctx, pathParam(c, 'id'))));
  r.patch('/sessions/:id', async (c, ctx) =>
    c.json(await core.sessions.rename(ctx, pathParam(c, 'id'), jsonBody(c, UpdateSessionRequest))),
  );
  // Erases the conversation's content (like an ended temporary chat) and removes it from every list.
  r.delete('/sessions/:id', async (c, ctx) => {
    await core.sessions.remove(ctx, pathParam(c, 'id'));
    return c.body(null, 204);
  });
  r.delete('/sessions/:id/digest', async (c, ctx) =>
    c.json(await core.sessions.deleteDigest(ctx, pathParam(c, 'id'))),
  );
  r.post(
    '/sessions/:id/turns',
    (c, ctx) =>
      handleTurnRequest(c, ctx, {
        ...turnOptions,
        orchestrator: distillAfterTurn(core.orchestrator, core.distill),
      }),
    {
      idempotency: 'turn',
    },
  );
  r.post('/sessions/:id/end', async (c, ctx) => {
    const { session, recap } = await core.sessions.end(ctx, pathParam(c, 'id'));
    await core.distill.afterEnd(ctx, session.id);
    return c.json({ session, recap });
  });
  r.post('/turns/:id/feedback', async (c, ctx) =>
    c.json(
      await core.sessions.submitFeedback(ctx, pathParam(c, 'id'), jsonBody(c, TurnFeedbackRequest)),
      201,
    ),
  );
  r.get('/turns/:id/evidence', async (c, ctx) =>
    c.json({ items: await core.sessions.getTurnEvidence(ctx, pathParam(c, 'id')) }),
  );

  // Documents -----------------------------------------------------------------------------------------
  r.post('/ventures/:id/documents', async (c, ctx) =>
    c.json(
      await core.documents.createUpload(ctx, pathParam(c, 'id'), jsonBody(c, CreateDocumentRequest)),
      201,
    ),
  );
  // 202 while ingestion runs in the worker; 200 when the document was already processed.
  r.post('/documents/:id/complete', async (c, ctx) => {
    const document = await core.documents.complete(ctx, pathParam(c, 'id'));
    return c.json(document, document.status === 'processing' ? 202 : 200);
  });
  r.get('/ventures/:id/documents', async (c, ctx) =>
    c.json({ items: await core.documents.list(ctx, pathParam(c, 'id')) }),
  );
  r.delete('/documents/:id', async (c, ctx) => {
    await core.documents.remove(ctx, pathParam(c, 'id'));
    return c.body(null, 204);
  });
}
