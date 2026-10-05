import {
  CreateDocumentResponse,
  DocumentListResponse,
  DocumentView,
  EndSessionResponse,
  ProblemDetails,
  SessionDetailResponse,
  SessionListResponse,
  SessionView,
  TurnEvidenceResponse,
  TurnStreamEvent,
} from '@foundry/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ApiHarness, createApiHarness } from './testing/api-harness.js';
import { parseSse } from './testing/sse.js';

let api: ApiHarness;
let maya: string;
let jonah: string;
let graham: string;
let corin: string;

beforeAll(async () => {
  // random() = 0.99: ordinary turns are not sampled for EIR review.
  api = await createApiHarness({ random: () => 0.99 });
  [maya, jonah, graham, corin] = await Promise.all([
    api.signInAs(api.h.people.maya),
    api.signInAs(api.h.people.jonah),
    api.signInAs(api.h.people.graham),
    api.signInAs(api.h.people.eirCorin),
  ]);
});
afterAll(async () => {
  await api.cleanup();
});

const quietquad = (): string => api.h.ventures.quietquad.id;

async function json<T>(res: Response, schema: { parse: (v: unknown) => T }, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(status);
  return schema.parse(JSON.parse(text));
}

async function problemCode(res: Response, status: number): Promise<string> {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toMatch(/^application\/problem\+json/);
  return ProblemDetails.parse(await res.json()).code;
}

async function startSession(token: string, mode = 'diagnose'): Promise<SessionView> {
  return json(
    await api.request(`/ventures/${quietquad()}/sessions`, { body: { mode }, cookie: token }),
    SessionView,
    201,
  );
}

async function streamTurn(
  token: string,
  sessionId: string,
  body: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<{ res: Response; events: TurnStreamEvent[]; comments: string[] }> {
  const res = await api.request(`/sessions/${sessionId}/turns`, {
    body,
    cookie: token,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  });
  const text = await res.text();
  const { frames, comments } = parseSse(text);
  const events = frames.map((f) => {
    const event = TurnStreamEvent.parse(JSON.parse(f.data));
    expect(f.event).toBe(event.event);
    return event;
  });
  return { res, events, comments };
}

describe('coaching sessions', () => {
  it('creates, lists and reads sessions (founder)', async () => {
    const session = await startSession(maya);
    expect(session).toMatchObject({
      ventureId: quietquad(),
      mode: 'diagnose',
      status: 'active',
      turnCount: 0,
    });
    const list = await json(
      await api.request(`/ventures/${quietquad()}/sessions`, { cookie: maya }),
      SessionListResponse,
    );
    expect(list.items.map((s) => s.id)).toContain(session.id);
    const detail = await json(
      await api.request(`/sessions/${session.id}`, { cookie: maya }),
      SessionDetailResponse,
    );
    expect(detail.session.id).toBe(session.id);
    expect(detail.turns).toEqual([]);
  });

  it('denies other ventures and non-writers', async () => {
    // Founder of another venture: no relationship → 404 (no existence leak).
    expect(
      await problemCode(
        await api.request(`/ventures/${quietquad()}/sessions`, { body: {}, cookie: jonah }),
        404,
      ),
    ).toBe('not_found');
    // Advisor of SoleSignal cannot start sessions there (read-only relationship).
    const sole = api.h.ventures.solesignal.id;
    const code = await problemCode(
      await api.request(`/ventures/${sole}/sessions`, { body: {}, cookie: graham }),
      403,
    );
    expect(code).toBe('forbidden');
    // Malformed ids are not found.
    expect(await problemCode(await api.request('/sessions/not-a-uuid', { cookie: maya }), 404)).toBe(
      'not_found',
    );
    // Schema violations are 422 with field paths.
    const bad = await api.request(`/ventures/${quietquad()}/sessions`, {
      body: { mode: 'shout' },
      cookie: maya,
    });
    expect(bad.status).toBe(422);
    expect(ProblemDetails.parse(await bad.json()).errors?.[0]?.path).toBe('mode');
  });
});

describe('POST /sessions/:id/turns (SSE)', () => {
  it('streams accepted → status phases → completed, each frame a valid TurnStreamEvent', async () => {
    const session = await startSession(maya);
    const { res, events } = await streamTurn(maya, session.id, {
      text: 'What did the library staff interviews tell us about quiet seat demand during exam weeks?',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('transfer-encoding')).toBeNull();
    expect(events.map((e) => (e.event === 'turn.status' ? `status:${e.phase}` : e.event))).toEqual([
      'turn.accepted',
      'status:classifying',
      'status:retrieving',
      'status:retrieving',
      'status:reasoning',
      'status:validating',
      'turn.completed',
    ]);
    const last = events.at(-1);
    if (last?.event !== 'turn.completed') throw new Error('expected turn.completed');
    expect(last.turn).toMatchObject({ sessionId: session.id, ordinal: 1, status: 'completed' });
    expect(last.turn.response?.answer.length).toBeGreaterThan(0);
    expect(last.turn.evidence.length).toBeGreaterThan(0);
    const accepted = events[0];
    if (accepted?.event !== 'turn.accepted') throw new Error('expected turn.accepted');
    expect(accepted.turnId).toBe(last.turn.id);

    // The turn is persisted and visible in the session; evidence is served separately too.
    const detail = await json(
      await api.request(`/sessions/${session.id}`, { cookie: maya }),
      SessionDetailResponse,
    );
    expect(detail.turns.map((t) => t.id)).toEqual([last.turn.id]);
    const evidence = await json(
      await api.request(`/turns/${last.turn.id}/evidence`, { cookie: maya }),
      TurnEvidenceResponse,
    );
    expect(evidence.items.map((e) => e.key)).toEqual(last.turn.evidence.map((e) => e.key));

    // Feedback on the turn (founder), denied for another venture's founder.
    const feedback = await api.request(`/turns/${last.turn.id}/feedback`, {
      body: { rating: 4 },
      cookie: maya,
    });
    expect(feedback.status).toBe(201);
    expect(await feedback.json()).toMatchObject({ feedbackId: expect.any(String) as unknown });
    expect(
      await problemCode(
        await api.request(`/turns/${last.turn.id}/feedback`, { body: { rating: 4 }, cookie: jonah }),
        404,
      ),
    ).toBe('not_found');
  });

  it('answers a crisis message with turn.blocked and a support message, without a model call', async () => {
    const session = await startSession(maya);
    const generateCalls = api.h.gateway.calls.filter((c) => c.kind === 'generate').length;
    const { events } = await streamTurn(maya, session.id, {
      text: 'I feel like I want to end my life, I cannot cope anymore.',
    });
    const last = events.at(-1);
    expect(last?.event).toBe('turn.blocked');
    if (last?.event === 'turn.blocked') {
      expect(last.reason).toBe('crisis_support');
      expect(last.supportMessage).toEqual(expect.any(String));
    }
    expect(api.h.gateway.calls.filter((c) => c.kind === 'generate').length).toBe(generateCalls);
  });

  it('answers refusals before acceptance with plain problem+json, not a stream', async () => {
    const session = await startSession(maya);
    await json(
      await api.request(`/sessions/${session.id}/end`, { method: 'POST', cookie: maya }),
      EndSessionResponse,
    );
    const ended = await api.request(`/sessions/${session.id}/turns`, {
      body: { text: 'Anyone there?' },
      cookie: maya,
    });
    expect(await problemCode(ended, 409)).toBe('session_ended');

    const notMine = await api.request(`/sessions/${session.id}/turns`, {
      body: { text: 'Hello' },
      cookie: jonah,
    });
    expect(await problemCode(notMine, 404)).toBe('not_found');

    const empty = await api.request(`/sessions/${session.id}/turns`, { body: { text: '' }, cookie: maya });
    expect(await problemCode(empty, 422)).toBe('validation_failed');
  });

  it('replays a turn for a retried Idempotency-Key without calling the model again', async () => {
    const session = await startSession(maya);
    const body = { text: 'Which experiment should we run next on the seat map?' };
    const first = await streamTurn(maya, session.id, body, 'turn-key-0001');
    const done = first.events.at(-1);
    if (done?.event !== 'turn.completed') throw new Error('expected turn.completed');
    const generateCalls = api.h.gateway.calls.filter((c) => c.kind === 'generate').length;

    const retry = await streamTurn(maya, session.id, body, 'turn-key-0001');
    expect(retry.res.headers.get('idempotency-replayed')).toBe('true');
    const replayed = retry.events.at(-1);
    if (replayed?.event !== 'turn.completed') throw new Error('expected turn.completed');
    expect(replayed.turn.id).toBe(done.turn.id);
    expect(api.h.gateway.calls.filter((c) => c.kind === 'generate').length).toBe(generateCalls);
    const detail = await json(
      await api.request(`/sessions/${session.id}`, { cookie: maya }),
      SessionDetailResponse,
    );
    expect(detail.turns).toHaveLength(1);

    // Same key, different text → conflict.
    const misuse = await api.request(`/sessions/${session.id}/turns`, {
      body: { text: 'Something else entirely' },
      cookie: maya,
      idempotencyKey: 'turn-key-0001',
    });
    expect(await problemCode(misuse, 409)).toBe('idempotency_conflict');
  });

  it('ends a session with a recap (standard privacy)', async () => {
    const session = await startSession(maya);
    await streamTurn(maya, session.id, { text: 'Summarise what we know about exam-week demand.' });
    const ended = await json(
      await api.request(`/sessions/${session.id}/end`, { method: 'POST', cookie: maya }),
      EndSessionResponse,
    );
    expect(ended.session.status).toBe('ended');
    expect(ended.recap).not.toBeNull();
  });
});

describe('documents', () => {
  it('registers an upload with a presigned PUT, completes it (202, job enqueued), lists and deletes', async () => {
    const created = await json(
      await api.request(`/ventures/${quietquad()}/documents`, {
        body: { filename: 'pilot notes.md', contentType: 'text/markdown', sizeBytes: 120 },
        cookie: maya,
      }),
      CreateDocumentResponse,
      201,
    );
    expect(created.upload.method).toBe('PUT');
    expect(created.upload.headers['content-type']).toBe('text/markdown');
    const presigned = api.h.objectStore.presigned.at(-1);
    expect(presigned).toMatchObject({
      contentType: 'text/markdown',
      contentLength: 120,
      expiresInSeconds: 300,
    });
    expect(presigned?.key).toMatch(
      new RegExp(`^tenants/${api.h.seed.tenantId}/ventures/${quietquad()}/documents/${created.document.id}/`),
    );

    api.h.objectStore.put(presigned?.key ?? '', '# Pilot\n\nNotes.');
    const completed = await api.request(`/documents/${created.document.id}/complete`, {
      method: 'POST',
      cookie: maya,
    });
    expect(completed.status).toBe(202);
    expect(DocumentView.parse(await completed.json()).status).toBe('processing');
    const job = api.h.jobQueue.jobs.at(-1)?.job;
    expect(job).toMatchObject({
      type: 'ingest_document',
      documentId: created.document.id,
      ventureId: quietquad(),
    });

    const list = await json(
      await api.request(`/ventures/${quietquad()}/documents`, { cookie: maya }),
      DocumentListResponse,
    );
    expect(list.items.map((d) => d.id)).toContain(created.document.id);
    // An assigned EIR can read the list but not delete.
    expect((await api.request(`/ventures/${quietquad()}/documents`, { cookie: corin })).status).toBe(200);
    expect(
      await problemCode(
        await api.request(`/documents/${created.document.id}`, { method: 'DELETE', cookie: corin }),
        403,
      ),
    ).toBe('forbidden');

    const deleted = await api.request(`/documents/${created.document.id}`, {
      method: 'DELETE',
      cookie: maya,
    });
    expect(deleted.status).toBe(204);
    expect(api.h.objectStore.deleted).toContain(presigned?.key);
  });

  it('validates uploads (type, size, filename) with 422', async () => {
    for (const body of [
      { filename: 'a.exe', contentType: 'application/x-msdownload', sizeBytes: 10 },
      { filename: 'big.pdf', contentType: 'application/pdf', sizeBytes: 10 * 1024 * 1024 + 1 },
      { filename: '../etc/passwd', contentType: 'text/plain', sizeBytes: 10 },
    ]) {
      const res = await api.request(`/ventures/${quietquad()}/documents`, { body, cookie: maya });
      expect(await problemCode(res, 422)).toBe('validation_failed');
    }
  });
});
