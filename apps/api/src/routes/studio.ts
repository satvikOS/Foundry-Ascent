import {
  AssignPersonaRequest,
  AuditQuery,
  CreateConsentRequest,
  CreateDocumentRequest,
  CreateEirPersonaRequest,
  CreateEirProfileRequest,
  CreateLessonRequest,
  CreatePersonaKnowledgeRequest,
  CreatePersonaReleaseRequest,
  CreatePrincipalRequest,
  CreateVentureRequest,
  IssueAccessCodeRequest,
  LessonAction,
  LessonQuery,
  RenameVentureRequest,
  RouteEscalationRequest,
  SubmitReviewRequest,
  SuspendPersonaRequest,
  TestTurnRequest,
  UpdateEirProfileRequest,
  UpdateEmbodimentRequest,
  UpdatePersonaKnowledgeRequest,
  UpdateSettingsRequest,
  UpsertResourceRequest,
} from '@foundry/contracts';
import { type Core, ResourceFilter, UpdateResourceRequest } from '@foundry/core';

import { jsonBody, pathParam, queryParams } from '../http/input.js';
import { type RouteBuilder } from '../http/router.js';
import { lambdaRemainingMs } from '../http/turn-stream.js';

export interface StudioRouteOptions {
  /** Budget of a test bench message outside Lambda (Lambda uses its remaining time). */
  readonly turnTimeoutMs: number;
}

/** Margin kept before the Lambda deadline so a cancelled test message still answers with a problem. */
const LAMBDA_DEADLINE_MARGIN_MS = 4_000;

/** EIR studio, program console and platform admin (system design §6). */
export function registerStudioRoutes(r: RouteBuilder, core: Core, options: StudioRouteOptions): void {
  // EIR studio ----------------------------------------------------------------------------------------
  r.get('/personas', async (c, ctx) => c.json({ items: await core.eir.listPersonas(ctx) }));
  r.get('/personas/:id', async (c, ctx) => c.json(await core.eir.getPersona(ctx, pathParam(c, 'id'))));
  r.post('/personas/:id/releases', async (c, ctx) =>
    c.json(
      await core.eir.createRelease(ctx, pathParam(c, 'id'), jsonBody(c, CreatePersonaReleaseRequest)),
      201,
    ),
  );
  r.get('/persona-releases/:id', async (c, ctx) =>
    c.json(await core.eir.getRelease(ctx, pathParam(c, 'id'))),
  );
  r.post('/persona-releases/:id/approve', async (c, ctx) =>
    c.json(await core.eir.approveRelease(ctx, pathParam(c, 'id'))),
  );
  // A superseded release (or a draft) out of use; conversations still on it move to the active release.
  r.post('/persona-releases/:id/withdraw', async (c, ctx) =>
    c.json(await core.eir.withdrawRelease(ctx, pathParam(c, 'id'))),
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
  // The EIR registry (program lead or platform admin): a profile never records consent.
  r.get('/eir/candidates', async (c, ctx) => c.json({ items: await core.eirProfiles.listCandidates(ctx) }));
  r.post('/eir/profiles', async (c, ctx) =>
    c.json(await core.eirProfiles.create(ctx, jsonBody(c, CreateEirProfileRequest)), 201),
  );
  r.patch('/eir/profiles/:id', async (c, ctx) =>
    c.json(await core.eirProfiles.update(ctx, pathParam(c, 'id'), jsonBody(c, UpdateEirProfileRequest))),
  );

  // Test bench: a curator's message to a release of their vEIR (its active release or a draft), answered by the
  // founder pipeline with no venture. Nothing is stored, so the answer (model output) is never kept for an
  // idempotent replay either: a retry asks again and is metered again. A client that goes away, or the deadline,
  // cancels the model call.
  r.post(
    '/personas/:id/test-turns',
    async (c, ctx) => {
      const remaining = lambdaRemainingMs(c);
      const budget =
        remaining === null ? options.turnTimeoutMs : Math.max(1_000, remaining - LAMBDA_DEADLINE_MARGIN_MS);
      const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(budget)]);
      return c.json(
        await core.testBench.runTestTurn(ctx, pathParam(c, 'id'), jsonBody(c, TestTurnRequest), { signal }),
      );
    },
    { idempotency: 'none' },
  );

  // Persona lifecycle: EIR personas, consent, embodiment, assignment ------------------------------------
  r.post('/personas', async (c, ctx) =>
    c.json(await core.personas.createEirPersona(ctx, jsonBody(c, CreateEirPersonaRequest)), 201),
  );
  r.get('/personas/:id/consents', async (c, ctx) =>
    c.json({ items: await core.personas.listConsents(ctx, pathParam(c, 'id')) }),
  );
  r.post('/personas/:id/consents', async (c, ctx) =>
    c.json(
      await core.personas.recordConsent(ctx, pathParam(c, 'id'), jsonBody(c, CreateConsentRequest)),
      201,
    ),
  );
  // Revoking suspends every persona that relies on the consent.
  r.post('/consents/:id/revoke', async (c, ctx) =>
    c.json(await core.personas.revokeConsent(ctx, pathParam(c, 'id'))),
  );
  r.get('/personas/:id/embodiment', async (c, ctx) =>
    c.json(await core.personas.getEmbodiment(ctx, pathParam(c, 'id'))),
  );
  r.patch('/personas/:id/embodiment', async (c, ctx) =>
    c.json(
      await core.personas.updateEmbodiment(ctx, pathParam(c, 'id'), jsonBody(c, UpdateEmbodimentRequest)),
    ),
  );
  r.post('/ventures/:id/assignment', async (c, ctx) =>
    c.json(await core.personas.assignVenture(ctx, pathParam(c, 'id'), jsonBody(c, AssignPersonaRequest))),
  );

  // Common pool: knowledge library ------------------------------------------------------------------
  r.get('/personas/:id/knowledge', async (c, ctx) =>
    c.json({ items: await core.library.list(ctx, pathParam(c, 'id')) }),
  );
  r.post('/personas/:id/knowledge', async (c, ctx) =>
    c.json(
      await core.library.create(ctx, pathParam(c, 'id'), jsonBody(c, CreatePersonaKnowledgeRequest)),
      201,
    ),
  );
  r.post('/personas/:id/knowledge/uploads', async (c, ctx) =>
    c.json(await core.library.createUpload(ctx, pathParam(c, 'id'), jsonBody(c, CreateDocumentRequest)), 201),
  );
  // 202 while ingestion runs in the worker; 200 when the upload was already processed.
  r.post('/personas/:id/knowledge/:sourceId/complete', async (c, ctx) => {
    const source = await core.library.completeUpload(ctx, pathParam(c, 'id'), pathParam(c, 'sourceId'));
    return c.json(source, source.status === 'processing' ? 202 : 200);
  });
  r.patch('/personas/:id/knowledge/:sourceId', async (c, ctx) =>
    c.json(
      await core.library.update(
        ctx,
        pathParam(c, 'id'),
        pathParam(c, 'sourceId'),
        jsonBody(c, UpdatePersonaKnowledgeRequest),
      ),
    ),
  );
  r.delete('/personas/:id/knowledge/:sourceId', async (c, ctx) => {
    await core.library.remove(ctx, pathParam(c, 'id'), pathParam(c, 'sourceId'));
    return c.body(null, 204);
  });

  // Common pool: lessons ------------------------------------------------------------------------------
  r.get('/personas/:id/lessons', async (c, ctx) =>
    c.json({ items: await core.lessons.list(ctx, pathParam(c, 'id')) }),
  );
  r.post('/personas/:id/lessons', async (c, ctx) =>
    c.json(await core.lessons.create(ctx, pathParam(c, 'id'), jsonBody(c, CreateLessonRequest)), 201),
  );
  // Every vEIR the caller curates at once (the "Lessons to review" queue asks for drafts).
  r.get('/lessons', async (c, ctx) => c.json(await core.lessons.queue(ctx, queryParams(c, LessonQuery))));
  r.post('/lessons/:id/actions', async (c, ctx) =>
    c.json(await core.lessons.act(ctx, pathParam(c, 'id'), jsonBody(c, LessonAction))),
  );

  // Program -------------------------------------------------------------------------------------------
  r.get('/program/portfolio', async (c, ctx) => c.json(await core.program.portfolio(ctx)));
  r.get('/program/ventures', async (c, ctx) => c.json({ items: await core.program.listVentures(ctx) }));
  r.post('/program/ventures', async (c, ctx) =>
    c.json(await core.program.createVenture(ctx, jsonBody(c, CreateVentureRequest)), 201),
  );
  // Program staff rename any venture of the tenant (e.g. to undo a misleading rename by its team).
  r.patch('/program/ventures/:id', async (c, ctx) =>
    c.json(await core.program.renameVenture(ctx, pathParam(c, 'id'), jsonBody(c, RenameVentureRequest))),
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
  r.get('/program/assignees', async (c, ctx) => c.json({ items: await core.program.listAssignees(ctx) }));
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
