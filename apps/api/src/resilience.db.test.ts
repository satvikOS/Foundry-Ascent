import {
  HealthResponse,
  MemoryListResponse,
  ProblemDetails,
  SessionView,
  TurnStreamEvent,
} from '@foundry/contracts';
import { type Core, createCore } from '@foundry/core';
import { DatabaseResumingError, p } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { requestHash } from './http/idempotency.js';
import { observeDatabase } from './runtime/db-observer.js';
import {
  type ApiHarness,
  buildRequest,
  createApiHarness,
  failingDb,
  nextViewerIp,
  sessionTokenFrom,
} from './testing/api-harness.js';
import { parseSse } from './testing/sse.js';

let api: ApiHarness;
let maya: string;

beforeAll(async () => {
  api = await createApiHarness({ random: () => 0.99 });
  maya = await api.signInAs(api.h.people.maya);
});
afterAll(async () => {
  await api.cleanup();
});

const quietquad = (): string => api.h.ventures.quietquad.id;

async function problem(res: Response, status: number): Promise<ProblemDetails> {
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(status);
  expect(res.headers.get('content-type')).toMatch(/^application\/problem\+json/);
  return ProblemDetails.parse(JSON.parse(text));
}

describe('database resuming (Aurora auto-pause)', () => {
  it('maps DatabaseResumingError to 503 database_resuming with Retry-After, and health to resuming', async () => {
    let failing = false;
    // Observed like the deployed runtime: /health reports what real requests saw, without a query.
    const { db, state: dbState } = observeDatabase(
      failingDb(
        api.h.t.db,
        () => failing,
        () => new DatabaseResumingError({ waitedMs: 45_000, retryAfterSeconds: 12 }),
      ),
    );
    const core = createCore({
      db,
      gateway: api.h.gateway,
      config: api.h.config,
      objectStore: api.h.objectStore,
      jobQueue: api.h.jobQueue,
    });
    const app = api.appWith({ core, db, dbState });
    const signIn = await app.request(
      buildRequest('/auth/sign-in', {
        body: { accessCode: api.h.t.ownerAccessCode ?? '' },
        headers: { 'x-fa-viewer-ip': nextViewerIp() },
      }),
    );
    const token = sessionTokenFrom(signIn) ?? '';
    expect(signIn.status).toBe(200);

    failing = true;
    for (const req of [
      buildRequest('/ventures', { cookie: token }),
      buildRequest('/program/ventures', { body: { name: 'While paused' }, cookie: token }),
      buildRequest('/auth/sign-in', { body: { accessCode: api.h.t.ownerAccessCode ?? '' } }),
    ]) {
      const res = await app.request(req);
      const body = await problem(res, 503);
      expect(body.code).toBe('database_resuming');
      expect(body.retryAfterSeconds).toBe(12);
      expect(res.headers.get('retry-after')).toBe('12');
    }
    const health = await app.request(buildRequest('/health'));
    expect(health.status).toBe(200);
    expect(HealthResponse.parse(await health.json())).toMatchObject({ status: 'degraded', db: 'resuming' });

    failing = false;
    expect((await app.request(buildRequest('/ventures', { cookie: token }))).status).toBe(200);
  });
});

describe('unexpected errors', () => {
  it('answer 500 internal without leaking messages, and log the error name only', async () => {
    const canary = 'LEAKY-ROW-CONTENT-7f3a';
    const core: Core = {
      ...api.h.core,
      ventures: {
        ...api.h.core.ventures,
        list: () => Promise.reject(new TypeError(`cannot read ${canary}`)),
      },
    };
    const app = api.appWith({ core });
    const before = api.logs.length;
    const res = await app.request(buildRequest('/ventures', { cookie: maya }));
    const body = await problem(res, 500);
    expect(body.code).toBe('internal');
    expect(JSON.stringify(body)).not.toContain(canary);
    const logs = api.logs.slice(before).join('\n');
    expect(logs).toContain('http.unhandled_error');
    expect(logs).toContain('TypeError');
    expect(logs).not.toContain(canary);
  });
});

describe('model failures during a turn', () => {
  it('stream turn.error (after acceptance) when the model is unavailable', async () => {
    const session = SessionView.parse(
      await (await api.request(`/ventures/${quietquad()}/sessions`, { body: {}, cookie: maya })).json(),
    );
    api.h.gateway.scriptNext('unavailable');
    const res = await api.request(`/sessions/${session.id}/turns`, {
      body: { text: 'What should we test next?' },
      cookie: maya,
    });
    expect(res.status).toBe(200);
    const events = parseSse(await res.text()).frames.map((f) => TurnStreamEvent.parse(JSON.parse(f.data)));
    expect(events[0]?.event).toBe('turn.accepted');
    const last = events.at(-1);
    expect(last).toMatchObject({ event: 'turn.error', code: 'model_unavailable', retryable: true });
    if (last?.event === 'turn.error') expect(last.turnId).not.toBeNull();
  });
});

describe('idempotency under concurrency', () => {
  const body = { type: 'insight', title: 'Concurrent insight', content: 'Two tabs submitted the same form.' };

  it('executes a key once even when two requests race', async () => {
    const key = 'race-key-00000001';
    const [a, b] = await Promise.all([
      api.request(`/ventures/${quietquad()}/memory`, { body, cookie: maya, idempotencyKey: key }),
      api.request(`/ventures/${quietquad()}/memory`, { body, cookie: maya, idempotencyKey: key }),
    ]);
    const statuses = [a.status, b.status].sort();
    // Either the loser saw the in-progress reservation (409) or the stored response (201 replay).
    expect([
      [201, 201],
      [201, 409],
    ]).toContainEqual(statuses);
    const list = MemoryListResponse.parse(
      await (await api.request(`/ventures/${quietquad()}/memory?type=insight`, { cookie: maya })).json(),
    );
    expect(list.items.filter((m) => m.title === 'Concurrent insight')).toHaveLength(1);
  });

  it('reports an in-flight key as 409 conflict with Retry-After, and takes over stale reservations', async () => {
    const path = `/api/v1/ventures/${quietquad()}/memory`;
    const raw = new TextEncoder().encode(JSON.stringify({ ...body, title: 'Reserved insight' }));
    const hash = requestHash('POST', path, raw);
    const reserve = (key: string, ageSeconds: number) =>
      api.h.t.db.system((sx) =>
        sx.query(
          `INSERT INTO idempotency_keys (key, principal_id, route, response, status_code, request_hash, created_at)
           VALUES (:key, :principal, 'POST /ventures/:id/memory', '{"state":"in_progress"}', 0, :hash,
                   now() - make_interval(secs => :age))`,
          {
            key: p.text(key),
            principal: p.uuid(api.h.people.maya),
            hash: p.text(hash),
            age: p.num(ageSeconds),
          },
        ),
      );
    await reserve('inflight-key-0001', 1);
    const inFlight = await api.request(path, {
      body: new TextDecoder().decode(raw),
      cookie: maya,
      idempotencyKey: 'inflight-key-0001',
    });
    const problemBody = await problem(inFlight, 409);
    expect(problemBody.code).toBe('conflict');
    expect(inFlight.headers.get('retry-after')).toBe('2');

    await reserve('stale-key-00000001', 600);
    const takeover = await api.request(path, {
      body: new TextDecoder().decode(raw),
      cookie: maya,
      idempotencyKey: 'stale-key-00000001',
    });
    expect(takeover.status).toBe(201);
  });
});
