/**
 * Distillation over HTTP: the routes queue `distill_session` after a completed turn (delayed), when a
 * conversation ends and when the next one starts; the worker's dispatch distils the queued job into the
 * conversation's digest and the vEIR notebook; and the batch review of memory proposals, with its
 * authorization (404 for non-members, 403 for read-only members).
 */
import {
  BatchMemoryActionResponse,
  ProblemDetails,
  SessionDetailResponse,
  SessionView,
  TurnStreamEvent,
  VeirNotebook,
} from '@foundry/contracts';
import { memoryRepo, p } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { dispatchJob } from './jobs/worker.js';
import { workerDepsFor } from './runtime/worker.js';
import { type ApiHarness, createApiHarness } from './testing/api-harness.js';
import { parseSse } from './testing/sse.js';

let api: ApiHarness;
let maya: string;
let priya: string;
let graham: string;

beforeAll(async () => {
  api = await createApiHarness({ random: () => 0.99 });
  [maya, priya, graham] = await Promise.all([
    api.signInAs(api.h.people.maya),
    api.signInAs(api.h.people.priya),
    api.signInAs(api.h.people.graham),
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
  return ProblemDetails.parse(await res.json()).code;
}

async function startSession(token: string): Promise<SessionView> {
  return json(
    await api.request(`/ventures/${quietquad()}/sessions`, { body: { mode: 'diagnose' }, cookie: token }),
    SessionView,
    201,
  );
}

async function turn(
  token: string,
  sessionId: string,
  text: string,
  idempotencyKey?: string,
): Promise<string> {
  const res = await api.request(`/sessions/${sessionId}/turns`, {
    body: { text },
    cookie: token,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  });
  const events = parseSse(await res.text()).frames.map((f) => TurnStreamEvent.parse(JSON.parse(f.data)));
  const last = events.at(-1);
  expect(last?.event).toBe('turn.completed');
  return res.headers.get('idempotency-replayed') ?? 'false';
}

describe('distillation triggers over HTTP', () => {
  it('queues the conversation after each completed turn, delayed 9 minutes, and never for a replay', async () => {
    const session = await startSession(maya);
    api.h.jobQueue.drain();
    await turn(maya, session.id, 'We have two libraries interested in a pilot.', 'turn-key-1');
    const [first, ...rest] = api.h.jobQueue.jobs;
    expect(rest).toEqual([]);
    expect(first).toMatchObject({
      job: {
        type: 'distill_session',
        sessionId: session.id,
        ventureId: quietquad(),
        tenantId: api.h.seed.tenantId,
        turns: 1,
      },
      delaySeconds: 540,
    });
    api.h.jobQueue.drain();
    expect(await turn(maya, session.id, 'We have two libraries interested in a pilot.', 'turn-key-1')).toBe(
      'true',
    );
    expect(api.h.jobQueue.jobs).toEqual([]);
  });

  it('a burst of turns pays for one distillation: the earlier jobs are superseded by the last', async () => {
    const session = await startSession(maya);
    api.h.jobQueue.drain();
    for (const text of ['Rooms are full on Sundays.', 'Students book and then skip.', 'No-shows cost us.']) {
      await turn(maya, session.id, text);
    }
    const jobs = api.h.jobQueue.drain();
    expect(jobs.map((j) => ('turns' in j ? j.turns : null))).toEqual([1, 2, 3]);
    await api.h.t.db.system((sx) =>
      sx.query(
        `UPDATE coaching_sessions SET last_activity_at = now() - interval '9 minutes' WHERE id = :id`,
        { id: p.uuid(session.id) },
      ),
    );
    const deps = workerDepsFor(api.h.core, {
      db: api.h.t.db,
      gateway: api.h.gateway,
      logger: api.logger,
      maxReceiveCount: 3,
    });
    const requestIds = jobs.map((_, i) => `burst-${String(i)}`);
    for (const [i, job] of jobs.entries()) {
      const ctx = {
        requestId: requestIds[i] ?? '',
        attempt: 1,
        deadline: Date.now() + 60_000,
        log: api.logger,
      };
      expect((await dispatchJob(deps, job, ctx)).outcome).toBe('done');
    }
    const billed = await api.h.t.db.system((sx) =>
      sx.query(`SELECT request_id FROM usage_ledger WHERE purpose = 'distill' AND request_id = ANY (:ids)`, {
        ids: p.textArray(requestIds),
      }),
    );
    expect(billed.rows).toEqual([{ request_id: 'burst-2' }]);
  });

  it('queues it now when the conversation ends, and the next conversation queues an undistilled previous one', async () => {
    const session = await startSession(maya);
    await turn(maya, session.id, 'I will interview five library staff before Friday.');
    api.h.jobQueue.drain();
    expect(
      (await api.request(`/sessions/${session.id}/end`, { method: 'POST', body: {}, cookie: maya })).status,
    ).toBe(200);
    expect(api.h.jobQueue.jobs.map((j) => [j.job.type, j.delaySeconds])).toEqual([['distill_session', 0]]);
    api.h.jobQueue.drain();

    // The end job was lost: starting the next conversation queues the ended, undistilled one.
    const next = await startSession(maya);
    const jobs = api.h.jobQueue.drain();
    expect(jobs.map((j) => ('sessionId' in j ? j.sessionId : null))).toEqual([session.id]);

    // The worker's dispatch (shared with the dev server) distils it into the digest and the notebook.
    const before = await json(
      await api.request(`/ventures/${quietquad()}/notebook`, { cookie: maya }),
      VeirNotebook,
    );
    const deps = workerDepsFor(api.h.core, {
      db: api.h.t.db,
      gateway: api.h.gateway,
      logger: api.logger,
      maxReceiveCount: 3,
    });
    const job = jobs[0];
    if (job === undefined) throw new Error('no job');
    const result = await dispatchJob(deps, job, {
      requestId: 'dispatch-test',
      attempt: 1,
      deadline: Date.now() + 60_000,
      log: api.logger,
    });
    expect(result.outcome).toBe('done');
    const detail = await json(
      await api.request(`/sessions/${session.id}`, { cookie: maya }),
      SessionDetailResponse,
    );
    expect(detail.session.digest?.commitments.map((c) => c.text)).toEqual([
      'Interview five library staff before Friday',
    ]);
    const after = await json(
      await api.request(`/ventures/${quietquad()}/notebook`, { cookie: maya }),
      VeirNotebook,
    );
    expect(after.version).toBe(before.version + 1);
    expect(after.lastEditedBy).toBe('veir');
    expect(after.commitments.some((c) => c.sourceSessionId === session.id)).toBe(true);
    expect(next.id).not.toBe(session.id);
    // Logs carry ids and counts, never what was said.
    expect(api.logs.join('\n')).not.toMatch(/library staff/);
  });
});

describe('POST /ventures/:id/memory/batch', () => {
  async function aiProposal(title: string): Promise<string> {
    return api.h.t.db.system(async (sx) => {
      const record = await memoryRepo.createMemory(sx, {
        tenantId: api.h.seed.tenantId,
        ventureId: quietquad(),
        type: 'fact',
        title,
        content: `${title}: proposed by the vEIR.`,
        status: 'proposed',
        visibility: 'team',
        origin: 'ai',
        createdBy: api.h.people.maya,
        sourceRefs: [{ kind: 'manual', id: 'test' }],
      });
      return record.id;
    });
  }

  it('approves several proposals at once and reports the rest as skipped', async () => {
    const a = await aiProposal('Batch A');
    const b = await aiProposal('Batch B');
    const unknown = '00000000-0000-4000-8000-0000000000bb';
    const result = await json(
      await api.request(`/ventures/${quietquad()}/memory/batch`, {
        body: { ids: [a, b, unknown], action: 'approve' },
        cookie: maya,
      }),
      BatchMemoryActionResponse,
    );
    expect(result.items.map((i) => [i.id, i.status])).toEqual([
      [a, 'confirmed'],
      [b, 'confirmed'],
    ]);
    expect(result.skippedIds).toEqual([unknown]);

    const again = await json(
      await api.request(`/ventures/${quietquad()}/memory/batch`, {
        body: { ids: [a], action: 'reject' },
        cookie: maya,
      }),
      BatchMemoryActionResponse,
    );
    expect(again).toEqual({ items: [], skippedIds: [a] });
  });

  it('answers 404 to non-members and 403 to read-only members, and changes nothing', async () => {
    const c = await aiProposal('Batch C');
    const body = { ids: [c], action: 'approve' };
    expect(
      await problemCode(
        await api.request(`/ventures/${quietquad()}/memory/batch`, { body, cookie: priya }),
        404,
      ),
    ).toBe('not_found');
    expect(
      await problemCode(
        await api.request(`/ventures/${api.h.ventures.solesignal.id}/memory/batch`, { body, cookie: graham }),
        403,
      ),
    ).toBe('forbidden');
    const status = await api.h.t.db.system((sx) =>
      sx.query('SELECT status FROM memory_objects WHERE id = :id', { id: p.uuid(c) }),
    );
    expect(status.rows).toEqual([{ status: 'proposed' }]);
  });

  it('validates the request', async () => {
    expect(
      await problemCode(
        await api.request(`/ventures/${quietquad()}/memory/batch`, {
          body: { ids: [], action: 'approve' },
          cookie: maya,
        }),
        422,
      ),
    ).toBe('validation_failed');
    expect(
      await problemCode(
        await api.request(`/ventures/${quietquad()}/memory/batch`, {
          body: { ids: ['00000000-0000-4000-8000-0000000000cc'], action: 'confirm' },
          cookie: maya,
        }),
        422,
      ),
    ).toBe('validation_failed');
  });
});
