/**
 * What the web client relies on, end to end through the Hono app against a real database:
 * - the explicit response schema of every write endpoint (`@foundry/contracts`),
 * - `x-request-id` on every response (success, error, 204, stream),
 * - body-less POSTs signed with the empty-body SHA-256 (CloudFront OAC requires the header),
 * - SSE frames as `event: <name>` + exactly one JSON `data:` line, refusals as problem+json,
 * - Retry-After on retryable errors,
 * - a public /health that never touches the database, and the admin probe that does.
 */
import { createHash } from 'node:crypto';

import {
  ApprovePersonaReleaseResponse,
  CompleteDocumentResponse,
  CreateDocumentResponse,
  CreateEscalationResponse,
  CreateMemoryResponse,
  CreatePersonaReleaseResponse,
  CreatePrincipalResponse,
  CreateProgramVentureResponse,
  CreateResourceResponse,
  CreateSessionResponse,
  EirProfileListResponse,
  EndSessionResponse,
  EscalationAssigneeListResponse,
  EscalationActionResponse,
  EscalationQueueResponse,
  HealthResponse,
  MemoryActionResponse,
  PersonaReleaseDetailResponse,
  ProblemDetails,
  ResumePersonaResponse,
  RouteEscalationResponse,
  SessionDetailResponse,
  SignInResponse,
  SuspendPersonaResponse,
  TurnStreamEvent,
  UpdateResourceResponse,
} from '@foundry/contracts';
import { DatabaseResumingError, GUIDE_DOCTRINE, GUIDE_STYLE, p } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type z } from 'zod';

import { observeDatabase } from './runtime/db-observer.js';
import {
  type ApiHarness,
  buildRequest,
  createApiHarness,
  failingDb,
  sessionTokenFrom,
} from './testing/api-harness.js';

const EMPTY_BODY_SHA256 = createHash('sha256').update('').digest('hex');
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

let api: ApiHarness;
let lead: string;
let maya: string;
let owner: string;

beforeAll(async () => {
  api = await createApiHarness();
  [lead, maya, owner] = await Promise.all([
    api.signInAs(api.h.people.lead),
    api.signInAs(api.h.people.maya),
    api.ownerToken(),
  ]);
});
afterAll(async () => {
  await api.cleanup();
});

/** Every response carries a well-formed x-request-id; returns the parsed body for `schema`. */
async function expectJson<S extends z.ZodType>(
  res: Response,
  schema: S,
  status: number,
): Promise<z.output<S>> {
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(status);
  expect(res.headers.get('x-request-id')).toMatch(REQUEST_ID);
  return schema.parse(JSON.parse(text));
}

/** A POST without a body, signed the way the web client signs every write. */
const bodyless = (cookie: string) => ({
  method: 'POST' as const,
  cookie,
  headers: { 'x-amz-content-sha256': EMPTY_BODY_SHA256 },
});

const quietquad = (): string => api.h.ventures.quietquad.id;

/** The events of an SSE body (`event:` + one JSON `data:` line per frame; comments skipped). */
function sseEvents(text: string): TurnStreamEvent[] {
  return text
    .split('\n\n')
    .filter((b) => b.trim() !== '' && !b.startsWith(':'))
    .map((block) => {
      const data = block.split('\n').find((line) => line.startsWith('data: '));
      return TurnStreamEvent.parse(JSON.parse(data?.slice('data: '.length) ?? 'null'));
    });
}

describe('write endpoints answer with their contract response schema', () => {
  it('sessions, memory, documents and escalations (founder) with body-less POSTs', async () => {
    const session = await expectJson(
      await api.request(`/ventures/${quietquad()}/sessions`, { body: {}, cookie: maya }),
      CreateSessionResponse,
      201,
    );
    const memory = await expectJson(
      await api.request(`/ventures/${quietquad()}/memory`, {
        body: {
          type: 'decision',
          title: 'Start in the science library',
          content: 'Longest exam-week queues.',
        },
        cookie: maya,
      }),
      CreateMemoryResponse,
      201,
    );
    const pinned = await expectJson(
      await api.request(`/memory/${memory.id}`, { method: 'PATCH', body: { action: 'pin' }, cookie: maya }),
      MemoryActionResponse,
      200,
    );
    expect(pinned.pinned).toBe(true);
    const deleted = await api.request(`/memory/${memory.id}`, {
      method: 'PATCH',
      body: { action: 'delete' },
      cookie: maya,
    });
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe('');
    expect(deleted.headers.get('x-request-id')).toMatch(REQUEST_ID);

    const upload = await expectJson(
      await api.request(`/ventures/${quietquad()}/documents`, {
        body: { filename: 'notes.md', contentType: 'text/markdown', sizeBytes: 20 },
        cookie: maya,
      }),
      CreateDocumentResponse,
      201,
    );
    api.h.objectStore.put(api.h.objectStore.presigned.at(-1)?.key ?? '', '# Notes\n\nShort.');
    const completed = await expectJson(
      await api.request(`/documents/${upload.document.id}/complete`, bodyless(maya)),
      CompleteDocumentResponse,
      202,
    );
    expect(completed.status).toBe('processing');

    const escalation = await expectJson(
      await api.request(`/ventures/${quietquad()}/escalations`, {
        body: {
          category: 'legal',
          requestedRole: 'specialist',
          founderQuestion: 'Can the library pilot agreement be signed as is?',
        },
        cookie: maya,
      }),
      CreateEscalationResponse,
      201,
    );
    const shared = await expectJson(
      await api.request(`/escalations/${escalation.id}`, {
        method: 'PATCH',
        body: { action: 'approve_sharing' },
        cookie: maya,
      }),
      EscalationActionResponse,
      200,
    );
    expect(shared.sharingConsentAt).not.toBeNull();
    // Consented, nobody assigned yet: it waits for the program team (system design §6.2).
    expect(shared).toMatchObject({ status: 'awaiting_assignment', assignee: null });
    const queue = await expectJson(
      await api.request('/program/escalations', { cookie: lead }),
      EscalationQueueResponse,
      200,
    );
    expect(queue.items.find((q) => q.id === escalation.id)).toMatchObject({
      status: 'awaiting_assignment',
      shared: true,
    });
    // The routing dialog's people list: tenant EIRs and program leads only, program staff only.
    const assignees = await expectJson(
      await api.request('/program/assignees', { cookie: lead }),
      EscalationAssigneeListResponse,
      200,
    );
    expect(assignees.items.map((a) => a.principal.id)).toContain(api.h.people.eirRuth);
    expect(assignees.items.map((a) => a.principal.id)).not.toContain(api.h.people.maya);
    const denied = await expectJson(
      await api.request('/program/assignees', { cookie: maya }),
      ProblemDetails,
      403,
    );
    expect(denied.code).toBe('forbidden');
    const routed = await expectJson(
      await api.request(`/program/escalations/${escalation.id}/route`, {
        body: { assigneeId: api.h.people.eirRuth },
        cookie: lead,
      }),
      RouteEscalationResponse,
      200,
    );
    expect(routed).toMatchObject({ assigneeId: api.h.people.eirRuth, status: 'routed' });

    const ended = await expectJson(
      await api.request(`/sessions/${session.id}/end`, bodyless(maya)),
      EndSessionResponse,
      200,
    );
    expect(ended.session.status).toBe('ended');
  });

  it('EIR studio, program and admin (program lead / owner) with body-less POSTs', async () => {
    const draft = await expectJson(
      await api.request(`/personas/${api.h.seed.personaId}/releases`, {
        body: {
          doctrine: GUIDE_DOCTRINE,
          style: GUIDE_STYLE,
          disclosureText:
            'You are working with Foundry Guide, an AI coach. It is not a person, and no human EIR authored or approved these responses.',
          allowedModes: ['diagnose', 'coach', 'challenge', 'teach', 'rehearse', 'route'],
        },
        cookie: lead,
      }),
      CreatePersonaReleaseResponse,
      201,
    );
    // The full draft for review before approval (program lead), never for founders.
    const detail = await expectJson(
      await api.request(`/persona-releases/${draft.id}`, { cookie: lead }),
      PersonaReleaseDetailResponse,
      200,
    );
    expect(detail).toMatchObject({ id: draft.id, status: 'draft', doctrine: GUIDE_DOCTRINE });
    await expectJson(
      await api.request(`/persona-releases/${draft.id}`, { cookie: maya }),
      ProblemDetails,
      403,
    );
    await expectJson(
      await api.request(`/persona-releases/${draft.id}/approve`, bodyless(lead)),
      ApprovePersonaReleaseResponse,
      200,
    );
    await expectJson(
      await api.request(`/personas/${api.h.seed.personaId}/suspend`, {
        body: { reason: 'Calibration review' },
        cookie: lead,
      }),
      SuspendPersonaResponse,
      200,
    );
    const resumed = await expectJson(
      await api.request(`/personas/${api.h.seed.personaId}/resume`, bodyless(lead)),
      ResumePersonaResponse,
      200,
    );
    expect(resumed.status).toBe('active');
    await expectJson(await api.request('/eir/profiles', { cookie: lead }), EirProfileListResponse, 200);

    const resource = await expectJson(
      await api.request('/program/resources', {
        body: { name: 'Legal clinic hours', kind: 'legal_clinic', description: 'Weekly drop-in.' },
        cookie: lead,
      }),
      CreateResourceResponse,
      201,
    );
    const updated = await expectJson(
      await api.request(`/program/resources/${resource.id}`, {
        method: 'PATCH',
        body: { status: 'stale' },
        cookie: lead,
      }),
      UpdateResourceResponse,
      200,
    );
    expect(updated.status).toBe('stale');
    await expectJson(
      await api.request('/program/ventures', { body: { name: 'Contract Zephyrine Venture' }, cookie: lead }),
      CreateProgramVentureResponse,
      201,
    );
    await expectJson(
      await api.request('/admin/principals', { body: { displayName: 'Contract Tester' }, cookie: owner }),
      CreatePrincipalResponse,
      201,
    );
  });

  it('sign-in answers with Me, sign-out accepts the empty-body hash', async () => {
    const issued = await api.h.core.admin.issueAccessCode(
      await api.h.ctxFor(api.h.people.owner),
      api.h.people.devin,
      {
        label: 'contract',
      },
    );
    const signIn = await api.request('/auth/sign-in', {
      body: { accessCode: issued.accessCode },
      headers: { 'x-fa-viewer-ip': '192.0.2.201' },
    });
    const me = await expectJson(signIn.clone(), SignInResponse, 200);
    expect(me.principal.id).toBe(api.h.people.devin);
    const out = await api.request('/auth/sign-out', bodyless(sessionTokenFrom(signIn) ?? ''));
    expect(out.status).toBe(204);
    expect(out.headers.get('x-request-id')).toMatch(REQUEST_ID);
  });
});

describe('x-request-id and Retry-After on error responses', () => {
  it.each([
    ['no session', () => api.request('/ventures'), 401],
    [
      'missing CSRF header',
      () => api.request('/program/ventures', { body: { name: 'x' }, cookie: lead, csrf: false }),
      403,
    ],
    ['unknown route', () => api.request('/nope', { cookie: lead }), 404],
    [
      'body hash mismatch',
      () =>
        api.request('/program/ventures', {
          body: { name: 'x' },
          cookie: lead,
          headers: { 'x-amz-content-sha256': EMPTY_BODY_SHA256 },
        }),
      400,
    ],
    [
      'non-JSON body',
      () =>
        api.request('/program/ventures', {
          body: 'name=x',
          cookie: lead,
          headers: { 'content-type': 'text/plain' },
        }),
      415,
    ],
  ] as const)('%s → %i problem+json with x-request-id', async (_label, send, status) => {
    const res = await send();
    const problem = await expectJson(res, ProblemDetails, status);
    expect(res.headers.get('content-type')).toMatch(/^application\/problem\+json/);
    expect(problem.requestId).toBe(res.headers.get('x-request-id'));
  });

  it('echoes a well-formed client request id', async () => {
    const res = await api.request('/health', { headers: { 'x-request-id': 'web-0f8fad5b-d9cb' } });
    expect(res.headers.get('x-request-id')).toBe('web-0f8fad5b-d9cb');
  });

  it('database_resuming carries Retry-After and retryAfterSeconds', async () => {
    // The idempotency reservation is the first database call of this write; the cluster is "resuming".
    const db = failingDb(
      api.h.t.db,
      () => true,
      () => new DatabaseResumingError({ waitedMs: 40_000 }),
    );
    const res = await api.appWith({ db }).request(
      buildRequest('/program/ventures', {
        body: { name: 'While paused' },
        cookie: lead,
        idempotencyKey: 'resume-test-0001',
      }),
    );
    const problem = await expectJson(res, ProblemDetails, 503);
    expect(problem.code).toBe('database_resuming');
    expect(problem.retryAfterSeconds).toBeGreaterThan(0);
    expect(res.headers.get('retry-after')).toBe(String(problem.retryAfterSeconds));
  });
});

describe('SSE turn stream framing', () => {
  it('sends each event as `event: <name>` plus exactly one JSON data line', async () => {
    const session = await expectJson(
      await api.request(`/ventures/${quietquad()}/sessions`, { body: {}, cookie: maya }),
      CreateSessionResponse,
      201,
    );
    const res = await api.request(`/sessions/${session.id}/turns`, {
      body: { text: 'What should we test first in the library pilot?\nTwo lines on purpose.' },
      cookie: maya,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(res.headers.get('x-request-id')).toMatch(REQUEST_ID);
    const blocks = (await res.text()).split('\n\n').filter((b) => b.trim() !== '' && !b.startsWith(':'));
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    for (const block of blocks) {
      const lines = block.split('\n');
      expect(lines, block.slice(0, 200)).toHaveLength(2);
      const [eventLine, dataLine] = lines;
      expect(eventLine).toMatch(/^event: turn\.[a-z]+$/);
      expect(dataLine).toMatch(/^data: \{/);
      const event = TurnStreamEvent.parse(JSON.parse(dataLine?.slice('data: '.length) ?? ''));
      expect(eventLine).toBe(`event: ${event.event}`);
    }
  });

  it('a reloaded session shows a crisis-blocked turn with its support message and request', async () => {
    const session = await expectJson(
      await api.request(`/ventures/${quietquad()}/sessions`, { body: {}, cookie: maya }),
      CreateSessionResponse,
      201,
    );
    const text = "I don't want to be alive anymore and I keep thinking about ending it.";
    const res = await api.request(`/sessions/${session.id}/turns`, { body: { text }, cookie: maya });
    const events = sseEvents(await res.text());
    const blocked = events.at(-1);
    if (blocked?.event !== 'turn.blocked') throw new Error(`expected turn.blocked, got ${blocked?.event}`);
    expect(blocked.reason).toBe('crisis_support');

    const detail = await expectJson(
      await api.request(`/sessions/${session.id}`, { cookie: maya }),
      SessionDetailResponse,
      200,
    );
    const turn = detail.turns.find((t) => t.id === blocked.turnId);
    expect(turn).toMatchObject({
      status: 'blocked',
      blocked: {
        reason: 'crisis_support',
        supportMessage: blocked.supportMessage,
        escalationId: blocked.escalationId,
      },
    });
    expect(turn?.blocked?.supportMessage).toContain('988');
    // The founder's words appear once, as the founder's own message, never in the blocked detail.
    expect(JSON.stringify(turn?.blocked)).not.toContain('ending it');
  });

  it('turn.error carries the request id, and a replay of a pending turn says when to retry', async () => {
    const session = await expectJson(
      await api.request(`/ventures/${quietquad()}/sessions`, { body: {}, cookie: maya }),
      CreateSessionResponse,
      201,
    );
    const body = { text: 'Which interview notes should we revisit first?' };
    const key = 'contract-pending-replay-0001';
    const first = sseEvents(
      await (
        await api.request(`/sessions/${session.id}/turns`, { body, cookie: maya, idempotencyKey: key })
      ).text(),
    );
    const accepted = first[0];
    if (accepted?.event !== 'turn.accepted') throw new Error('expected turn.accepted');
    // Simulate the original request still running (e.g. another Lambda is answering it).
    await api.h.t.db.system((sx) =>
      sx.query(`UPDATE turns SET status = 'pending', completed_at = NULL WHERE id = :id`, {
        id: p.uuid(accepted.turnId),
      }),
    );
    const res = await api.request(`/sessions/${session.id}/turns`, {
      body,
      cookie: maya,
      idempotencyKey: key,
    });
    expect(res.headers.get('idempotency-replayed')).toBe('true');
    const requestId = res.headers.get('x-request-id');
    const events = sseEvents(await res.text());
    expect(events.at(-1)).toEqual({
      event: 'turn.error',
      turnId: accepted.turnId,
      code: 'conflict',
      message: 'This message is still being answered. Please wait.',
      retryable: true,
      retryAfterSeconds: 5,
      requestId,
    });
  });

  it('answers a refusal before acceptance as problem+json, not a stream', async () => {
    const res = await api.request('/sessions/00000000-0000-4000-8000-000000000000/turns', {
      body: { text: 'Hello?' },
      cookie: maya,
    });
    const problem = await expectJson(res, ProblemDetails, 404);
    expect(problem.code).toBe('not_found');
    expect(res.headers.get('content-type')).toMatch(/^application\/problem\+json/);
  });
});

describe('health', () => {
  it('public /health never touches the database (bots cannot keep Aurora awake)', async () => {
    let calls = 0;
    const counting = failingDb(
      api.h.t.db,
      () => {
        calls += 1;
        return false;
      },
      () => new Error('unused'),
    );
    const observed = observeDatabase(counting);
    const app = api.appWith({ db: observed.db, dbState: observed.state });
    for (let i = 0; i < 5; i += 1) {
      const res = await app.request(new Request('http://localhost/api/v1/health'));
      const body = await expectJson(res, HealthResponse, 200);
      expect(body).toMatchObject({ status: 'ok', version: 'test-version' });
      expect(body).not.toHaveProperty('db');
    }
    expect(calls).toBe(0);

    // Real traffic through the same instance is what the health route reports.
    await observed.db.ping();
    const awake = await expectJson(
      await app.request(new Request('http://localhost/api/v1/health')),
      HealthResponse,
      200,
    );
    expect(awake.db).toBe('awake');
  });

  it('reports a resume seen by recent requests as degraded', async () => {
    const resuming = observeDatabase(
      failingDb(
        api.h.t.db,
        () => true,
        () => new DatabaseResumingError({ waitedMs: 40_000 }),
      ),
    );
    await expect(resuming.db.ping()).rejects.toBeInstanceOf(DatabaseResumingError);
    const body = await expectJson(
      await api
        .appWith({ db: resuming.db, dbState: resuming.state })
        .request(new Request('http://localhost/api/v1/health')),
      HealthResponse,
      200,
    );
    expect(body).toMatchObject({ status: 'degraded', db: 'resuming' });
  });

  it('GET /admin/health probes the database, platform admins only', async () => {
    const body = await expectJson(await api.request('/admin/health', { cookie: owner }), HealthResponse, 200);
    expect(body).toMatchObject({ status: 'ok', db: 'awake' });
    const denied = await expectJson(
      await api.request('/admin/health', { cookie: maya }),
      ProblemDetails,
      403,
    );
    expect(denied.code).toBe('forbidden');
  });
});
