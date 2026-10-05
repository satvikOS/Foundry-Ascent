import {
  AuditQuery,
  CreatePersonaReleaseRequest,
  CreatePrincipalRequest,
  CreateVentureRequest,
  IssueAccessCodeRequest,
  RouteEscalationRequest,
  SubmitReviewRequest,
  SuspendPersonaRequest,
  UpdateSettingsRequest,
  UpsertResourceRequest,
} from '@foundry/contracts';
import { type Core, ResourceFilter, UpdateResourceRequest } from '@foundry/core';

import { jsonBody, pathParam, queryParams } from '../http/input.js';
import { type RouteBuilder } from '../http/router.js';

/** EIR studio, program console and platform admin (system design §6). */
export function registerStudioRoutes(r: RouteBuilder, core: Core): void {
  // EIR studio ----------------------------------------------------------------------------------------
  r.get('/personas', async (c, ctx) => c.json({ items: await core.eir.listPersonas(ctx) }));
  r.get('/personas/:id', async (c, ctx) => c.json(await core.eir.getPersona(ctx, pathParam(c, 'id'))));
  r.post('/personas/:id/releases', async (c, ctx) =>
    c.json(
      await core.eir.createRelease(ctx, pathParam(c, 'id'), jsonBody(c, CreatePersonaReleaseRequest)),
      201,
    ),
  );
  r.post('/persona-releases/:id/approve', async (c, ctx) =>
    c.json(await core.eir.approveRelease(ctx, pathParam(c, 'id'))),
  );
  r.post('/personas/:id/suspend', async (c, ctx) =>
    c.json(await core.eir.suspendPersona(ctx, pathParam(c, 'id'), jsonBody(c, SuspendPersonaRequest))),
  );
  r.post('/personas/:id/resume', async (c, ctx) =>
    c.json(await core.eir.resumePersona(ctx, pathParam(c, 'id'))),
  );
  r.get('/eir/reviews', async (c, ctx) => c.json({ items: await core.eir.reviewQueue(ctx) }));
  r.post('/eir/reviews/:turnId', async (c, ctx) =>
    c.json(await core.eir.submitReview(ctx, pathParam(c, 'turnId'), jsonBody(c, SubmitReviewRequest)), 201),
  );
  r.get('/eir/profiles', async (c, ctx) => c.json({ items: await core.eir.listEirProfiles(ctx) }));

  // Program -------------------------------------------------------------------------------------------
  r.get('/program/portfolio', async (c, ctx) => c.json(await core.program.portfolio(ctx)));
  r.get('/program/ventures', async (c, ctx) => c.json({ items: await core.program.listVentures(ctx) }));
  r.post('/program/ventures', async (c, ctx) =>
    c.json(await core.program.createVenture(ctx, jsonBody(c, CreateVentureRequest)), 201),
  );
  r.get('/program/resources', async (c, ctx) =>
    c.json({ items: await core.program.listResources(ctx, queryParams(c, ResourceFilter)) }),
  );
  r.post('/program/resources', async (c, ctx) =>
    c.json(await core.program.createResource(ctx, jsonBody(c, UpsertResourceRequest)), 201),
  );
  r.patch('/program/resources/:id', async (c, ctx) =>
    c.json(await core.program.updateResource(ctx, pathParam(c, 'id'), jsonBody(c, UpdateResourceRequest))),
  );
  r.get('/program/escalations', async (c, ctx) => c.json({ items: await core.program.escalationQueue(ctx) }));
  r.post('/program/escalations/:id/route', async (c, ctx) =>
    c.json(await core.program.routeEscalation(ctx, pathParam(c, 'id'), jsonBody(c, RouteEscalationRequest))),
  );

  // Admin ---------------------------------------------------------------------------------------------
  r.get('/admin/principals', async (c, ctx) => c.json({ items: await core.admin.listPrincipals(ctx) }));
  r.post('/admin/principals', async (c, ctx) =>
    c.json(await core.admin.createPrincipal(ctx, jsonBody(c, CreatePrincipalRequest)), 201),
  );
  // One-time access code in the response: never stored for idempotent replay.
  r.post(
    '/admin/principals/:id/access-codes',
    async (c, ctx) =>
      c.json(
        await core.admin.issueAccessCode(ctx, pathParam(c, 'id'), jsonBody(c, IssueAccessCodeRequest)),
        201,
      ),
    { idempotency: 'secret' },
  );
  r.delete('/admin/access-codes/:id', async (c, ctx) =>
    c.json(await core.admin.revokeAccessCode(ctx, pathParam(c, 'id'))),
  );
  r.get('/admin/settings', async (c, ctx) => c.json(await core.admin.getSettings(ctx)));
  r.patch('/admin/settings', async (c, ctx) =>
    c.json(await core.admin.updateSettings(ctx, jsonBody(c, UpdateSettingsRequest))),
  );
  r.get('/admin/audit', async (c, ctx) => {
    const page = await core.admin.listAudit(ctx, queryParams(c, AuditQuery));
    return c.json({ items: page.items, nextCursor: page.nextCursor });
  });
  r.get('/admin/usage', async (c, ctx) => c.json(await core.admin.usageSummary(ctx)));
}
