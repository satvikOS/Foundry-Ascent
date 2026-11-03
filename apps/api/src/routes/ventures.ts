import {
  BatchMemoryActionRequest,
  CreateEscalationRequest,
  CreateMemoryRequest,
  EscalationAction,
  InviteMemberRequest,
  MemoryAction,
  MemoryQuery,
  UpdateVentureRequest,
  SaveStudentProfile,
  LearningReflectionInput,
} from '@foundry/contracts';
import { type Core } from '@foundry/core';

import { jsonBody, pathParam, queryParams } from '../http/input.js';
import { type RouteBuilder } from '../http/router.js';

/** Ventures, memory, escalations and team (system design §6). */
export function registerVentureRoutes(r: RouteBuilder, core: Core): void {
  // Ventures ------------------------------------------------------------------------------------------
  r.get('/ventures', async (c, ctx) => c.json({ items: await core.ventures.list(ctx) }));
  r.get('/ventures/:id', async (c, ctx) => c.json(await core.ventures.get(ctx, pathParam(c, 'id'))));
  r.patch('/ventures/:id', async (c, ctx) =>
    c.json(await core.ventures.update(ctx, pathParam(c, 'id'), jsonBody(c, UpdateVentureRequest))),
  );
  r.get('/ventures/:id/overview', async (c, ctx) =>
    c.json(await core.ventures.overview(ctx, pathParam(c, 'id'))),
  );

  // Student-approved development context, independently scoped to person and venture.
  r.get('/ventures/:id/student-profile', async (c, ctx) =>
    c.json({ profile: await core.student.profile(ctx, pathParam(c, 'id')) }),
  );
  r.patch('/ventures/:id/student-profile', async (c, ctx) =>
    c.json({ profile: await core.student.save(ctx, pathParam(c, 'id'), jsonBody(c, SaveStudentProfile)) }),
  );
  r.session('DELETE', '/ventures/:id/student-profile', async (c, ctx) => {
    await core.student.forget(ctx, pathParam(c, 'id'));
    return c.body(null, 204);
  });
  r.get('/ventures/:id/learning-log', async (c, ctx) =>
    c.json({ items: await core.student.log(ctx, pathParam(c, 'id')) }),
  );
  r.post('/ventures/:id/learning-log', async (c, ctx) =>
    c.json(await core.student.reflect(ctx, pathParam(c, 'id'), jsonBody(c, LearningReflectionInput)), 201),
  );
  r.session('DELETE', '/ventures/:id/learning-log/:reflectionId', async (c, ctx) => {
    await core.student.removeReflection(ctx, pathParam(c, 'id'), pathParam(c, 'reflectionId'));
    return c.body(null, 204);
  });

  // Memory --------------------------------------------------------------------------------------------
  // One page (excerpts; `nextCursor`), so responses stay far below the Data API's 1 MB limit.
  r.get('/ventures/:id/memory', async (c, ctx) => {
    const query = queryParams(c, MemoryQuery);
    return c.json(await core.memory.list(ctx, pathParam(c, 'id'), query));
  });
  r.get('/memory/:id', async (c, ctx) => c.json(await core.memory.get(ctx, pathParam(c, 'id'))));
  r.post('/ventures/:id/memory', async (c, ctx) =>
    c.json(await core.memory.create(ctx, pathParam(c, 'id'), jsonBody(c, CreateMemoryRequest)), 201),
  );
  // approve / reject / correct (→ the new version) / dispute / pin / unpin / delete (→ 204).
  r.patch('/memory/:id', async (c, ctx) => {
    const result = await core.memory.act(ctx, pathParam(c, 'id'), jsonBody(c, MemoryAction));
    return result === null ? c.body(null, 204) : c.json(result);
  });
  // Approve or reject several pending proposals at once (the "To review" queue); `skippedIds` lists the rest.
  r.post('/ventures/:id/memory/batch', async (c, ctx) =>
    c.json(await core.memory.batch(ctx, pathParam(c, 'id'), jsonBody(c, BatchMemoryActionRequest))),
  );
  r.get('/memory/:id/history', async (c, ctx) =>
    c.json({ items: await core.memory.history(ctx, pathParam(c, 'id')) }),
  );

  // Escalations ---------------------------------------------------------------------------------------
  r.get('/ventures/:id/escalations', async (c, ctx) =>
    c.json({ items: await core.escalations.list(ctx, pathParam(c, 'id')) }),
  );
  r.post('/ventures/:id/escalations', async (c, ctx) =>
    c.json(await core.escalations.create(ctx, pathParam(c, 'id'), jsonBody(c, CreateEscalationRequest)), 201),
  );
  r.patch('/escalations/:id', async (c, ctx) =>
    c.json(await core.escalations.act(ctx, pathParam(c, 'id'), jsonBody(c, EscalationAction))),
  );
  r.get('/inbox/escalations', async (c, ctx) => c.json({ items: await core.escalations.inbox(ctx) }));

  // Team ----------------------------------------------------------------------------------------------
  r.get('/ventures/:id/team', async (c, ctx) => c.json(await core.team.list(ctx, pathParam(c, 'id'))));
  // The response carries a one-time access code: never stored for idempotent replay.
  r.post(
    '/ventures/:id/team/invitations',
    async (c, ctx) =>
      c.json(await core.team.invite(ctx, pathParam(c, 'id'), jsonBody(c, InviteMemberRequest)), 201),
    { idempotency: 'secret' },
  );
}
