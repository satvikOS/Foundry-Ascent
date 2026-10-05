/**
 * Security review 2026-10-05: every proof of concept of the review (scratch scripts t1–t4, run against
 * this same harness) kept as a permanent test through the public API. Each one failed before the fix.
 * The database-only PoC (t5, RLS gaps) lives in packages/db/src/security-0003.db.test.ts.
 */
import {
  DocumentListResponse,
  EscalationView,
  MemoryListResponse,
  MemoryItemResponse,
  Me,
  ProblemDetails,
  SessionView,
  TurnStreamEvent,
} from '@foundry/contracts';
import { p } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ApiHarness, createApiHarness, nextViewerIp } from './testing/api-harness.js';
import { parseSse } from './testing/sse.js';

let api: ApiHarness;
let owner: string;
let lead: string;
let maya: string; // QuietQuad founder
let devin: string; // QuietQuad team member
let corin: string; // EIR assigned to QuietQuad and BenchTally
let priya: string; // BenchTally founder

const SECRET = 'PRIVATE-XYZZY';
/** Shifts the core's clock (session revocation cache) without touching the database clock. */
let clockOffsetMs = 0;

beforeAll(async () => {
  // random() = 0: every turn is sampled for EIR review, the worst case for private content.
  api = await createApiHarness({
    random: () => 0,
    clock: { now: () => new Date(Date.now() + clockOffsetMs) },
  });
  owner = await api.ownerToken();
  [lead, maya, devin, corin, priya] = await Promise.all([
    api.signInAs(api.h.people.lead),
    api.signInAs(api.h.people.maya),
    api.signInAs(api.h.people.devin),
    api.signInAs(api.h.people.eirCorin),
    api.signInAs(api.h.people.priya),
  ]);
});
afterAll(async () => {
  await api.cleanup();
});

const quietquad = (): string => api.h.ventures.quietquad.id;
const benchtally = (): string => api.h.ventures.benchtally.id;

async function json<T>(res: Response, schema: { parse: (v: unknown) => T }, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(status);
  return schema.parse(JSON.parse(text));
}

async function problem(res: Response, status: number): Promise<ProblemDetails> {
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(status);
  return ProblemDetails.parse(JSON.parse(text));
}

async function session(token: string, ventureId: string, body: Record<string, unknown> = { mode: 'coach' }) {
  return json(
    await api.request(`/ventures/${ventureId}/sessions`, { cookie: token, body }),
    SessionView,
    201,
  );
}

async function turn(
  token: string,
  sessionId: string,
  text: string,
): Promise<{ status: number; events: TurnStreamEvent[]; raw: string }> {
  const res = await api.request(`/sessions/${sessionId}/turns`, { cookie: token, body: { text } });
  const raw = await res.text();
  if (res.headers.get('content-type')?.startsWith('text/event-stream') !== true)
    return { status: res.status, events: [], raw };
  return {
    status: res.status,
    events: parseSse(raw).frames.map((f) => TurnStreamEvent.parse(JSON.parse(f.data))),
    raw,
  };
}

async function text(token: string, path: string): Promise<string> {
  const res = await api.request(path, { cookie: token });
  expect(res.status, path).toBe(200);
  return res.text();
}

describe('finding 1: founder_private memory never reaches other readers (PoC t1)', () => {
  let privateId: string;
  let sessionId: string;
  let turnId: string;

  beforeAll(async () => {
    const created = await api.request(`/ventures/${quietquad()}/memory`, {
      cookie: maya,
      body: {
        type: 'fact',
        title: `${SECRET} personal runway`,
        content: `${SECRET}: I can only self-fund two more months and am considering leaving the venture.`,
        visibility: 'founder_private',
      },
    });
    expect(created.status).toBe(201);
    privateId = ((await created.json()) as { id: string }).id;
    sessionId = (await session(maya, quietquad())).id;
    const result = await turn(
      maya,
      sessionId,
      'How long is my personal runway and should I keep self-funding?',
    );
    const done = result.events.at(-1);
    expect(done?.event).toBe('turn.completed');
    turnId = done?.event === 'turn.completed' ? done.turn.id : '';
  });

  it('is not used as evidence, so a team member reading the session sees nothing of it', async () => {
    expect(await text(devin, `/sessions/${sessionId}`)).not.toContain(SECRET);
    expect(await text(devin, `/turns/${turnId}/evidence`)).not.toContain(SECRET);
    // Not even its author's evidence cites it: retrieval excludes founder_private items entirely.
    expect(await text(maya, `/turns/${turnId}/evidence`)).not.toContain(privateId);
  });

  it('never reaches the assigned EIR’s review queue', async () => {
    const queue = await text(corin, '/eir/reviews');
    expect(queue).toContain(turnId);
    expect(queue).not.toContain(SECRET);
    expect(queue).not.toContain(privateId);
  });

  it('never reaches proposed memory, recaps or escalation packets', async () => {
    const ended = await api.request(`/sessions/${sessionId}/end`, { cookie: maya, body: {} });
    expect(ended.status).toBe(200);
    expect(await text(devin, `/sessions/${sessionId}`)).not.toContain(SECRET);
    expect(await text(devin, `/ventures/${quietquad()}/memory?status=proposed`)).not.toContain(SECRET);
    const escalation = await json(
      await api.request(`/ventures/${quietquad()}/escalations`, {
        cookie: maya,
        body: { category: 'other', founderQuestion: 'Should I keep self-funding the venture?' },
      }),
      EscalationView,
      201,
    );
    const shared = await api.request(`/escalations/${escalation.id}`, {
      method: 'PATCH',
      cookie: maya,
      body: { action: 'approve_sharing', sharedMemoryIds: [privateId] },
    });
    expect((await problem(shared, 422)).code).toBe('validation_failed');
    expect(await text(devin, `/ventures/${quietquad()}/escalations`)).not.toContain(SECRET);
    expect(await text(lead, '/program/escalations')).not.toContain(SECRET);
  });

  it('stays readable by its author', async () => {
    const own = await json(await api.request(`/memory/${privateId}`, { cookie: maya }), MemoryItemResponse);
    expect(own.content).toContain(SECRET);
    expect((await api.request(`/memory/${privateId}`, { cookie: devin })).status).toBe(404);
  });
});

describe('finding 5: the classifier is no cross-venture oracle (PoC t1)', () => {
  it('labels another venture’s name or member exactly like an unknown one, and never says cross_venture', async () => {
    const s = await session(maya, quietquad());
    const detail = async (message: string) => {
      const result = await turn(maya, s.id, message);
      expect(result.raw).not.toMatch(/cross_venture/);
      const classifying = result.events.find((e) => e.event === 'turn.status' && e.phase === 'classifying');
      return classifying?.event === 'turn.status' ? classifying.detail : 'missing';
    };
    expect(await detail('What do you think about BenchTally as a name?')).toBe(
      await detail('What do you think about Zorblax Widgets as a name?'),
    );
    expect(await detail('I had coffee with Priya Ramaswamy-Holt yesterday.')).toBe(
      await detail('I had coffee with Jane Q Randomperson yesterday.'),
    );
  });
});

describe('finding 3: venture names cannot deny service to other ventures (PoC t3)', () => {
  const victimTurn = async (): Promise<string> => {
    const s = await session(priya, benchtally());
    const result = await turn(priya, s.id, 'How should I price the pilot for the lab managers?');
    return result.events.at(-1)?.event ?? `status ${String(result.status)}`;
  };

  it('refuses common-word names from the team, and the other venture keeps coaching', async () => {
    expect(await victimTurn()).toBe('turn.completed');
    for (const name of ['the', 'Pilot', 'Customer Discovery', 'ab']) {
      const res = await api.request(`/ventures/${quietquad()}`, {
        method: 'PATCH',
        cookie: devin,
        body: { name },
      });
      expect((await problem(res, 422)).code, name).toBe('validation_failed');
    }
    expect(await victimTurn()).toBe('turn.completed');
  });

  it('ignores a common-word name that predates the rule', async () => {
    await api.h.t.db.system((sx) =>
      sx.query(`UPDATE ventures SET name = 'the' WHERE id = :id`, { id: p.uuid(quietquad()) }),
    );
    try {
      expect(await victimTurn()).toBe('turn.completed');
    } finally {
      // Program staff repair it through the API.
      const res = await api.request(`/program/ventures/${quietquad()}`, {
        method: 'PATCH',
        cookie: lead,
        body: { name: api.h.ventures.quietquad.name },
      });
      expect(res.status).toBe(200);
    }
  });

  it('lets program leads and platform admins rename any venture of the tenant, uniquely', async () => {
    const rename = (token: string, name: string) =>
      api.request(`/program/ventures/${benchtally()}`, { method: 'PATCH', cookie: token, body: { name } });
    expect((await rename(lead, 'BenchTally Labs')).status).toBe(200);
    expect((await rename(owner, api.h.ventures.benchtally.name)).status).toBe(200);
    const taken = await problem(await rename(lead, api.h.ventures.quietquad.name.toUpperCase()), 409);
    expect(taken.code).toBe('conflict');
    expect((await problem(await rename(priya, 'Priya Zephyrine'), 403)).code).toBe('forbidden');
    const own = await api.request(`/ventures/${benchtally()}`, {
      method: 'PATCH',
      cookie: priya,
      body: { name: ` ${api.h.ventures.quietquad.name} ` },
    });
    expect((await problem(own, 409)).code).toBe('conflict');
  });
});

describe('finding 4: ingestion obeys the spend caps and uploads have a daily quota (PoC t2a)', () => {
  const setSettings = async (body: Record<string, unknown>) => {
    const res = await api.request('/admin/settings', { method: 'PATCH', cookie: owner, body });
    expect(res.status, await res.clone().text()).toBe(200);
  };
  const upload = async (token: string, content: string, filename: string) => {
    const res = await api.request(`/ventures/${quietquad()}/documents`, {
      cookie: token,
      body: {
        filename,
        contentType: 'text/markdown',
        sizeBytes: new TextEncoder().encode(content).byteLength,
      },
    });
    return res;
  };

  it('embeds nothing past a reached cap and tells the uploader why', async () => {
    await setSettings({ dailyUsdCapGlobal: 0, dailyUsdCapPerPrincipal: 0 });
    try {
      const embeds = () =>
        api.h.gateway.calls.filter((c) => c.kind === 'embed').reduce((n, c) => n + c.count, 0);
      const before = embeds();
      const content = Array.from(
        { length: 40 },
        (_, i) => `## Section ${String(i)}\n` + 'lorem ipsum '.repeat(80),
      ).join('\n\n');
      const res = await upload(maya, content, 'capped.md');
      expect(res.status).toBe(201);
      const created = (await res.json()) as { document: { id: string } };
      api.h.objectStore.put(api.h.objectStore.presigned.at(-1)?.key ?? '', content);
      expect(
        (await api.request(`/documents/${created.document.id}/complete`, { cookie: maya, body: {} })).status,
      ).toBe(202);
      for (const job of api.h.jobQueue.drain())
        await api.h.core.ingestion.process(job, { requestId: 'test-capped' });
      expect(embeds() - before).toBe(0);
      const list = await json(
        await api.request(`/ventures/${quietquad()}/documents`, { cookie: maya }),
        DocumentListResponse,
      );
      expect(list.items.find((d) => d.id === created.document.id)).toMatchObject({
        status: 'failed',
        failureReason: 'spend_cap_reached',
      });
    } finally {
      await setSettings({ dailyUsdCapGlobal: 2, dailyUsdCapPerPrincipal: 0.5 });
    }
  });

  it('attributes ingestion spend to the uploader', async () => {
    const content = '## Notes\nShort document about exam-week seating.';
    const res = await upload(devin, content, 'attributed.md');
    const created = (await res.json()) as { document: { id: string } };
    api.h.objectStore.put(api.h.objectStore.presigned.at(-1)?.key ?? '', content);
    await api.request(`/documents/${created.document.id}/complete`, { cookie: devin, body: {} });
    for (const job of api.h.jobQueue.drain())
      await api.h.core.ingestion.process(job, { requestId: 'test-attributed' });
    const rows = await api.h.t.db.system((sx) =>
      sx.query(
        `SELECT DISTINCT principal_id FROM usage_ledger WHERE purpose = 'ingestion' AND request_id = 'test-attributed'`,
      ),
    );
    expect(rows.rows.map((r) => r.principal_id)).toEqual([api.h.people.devin]);
  });

  it('refuses uploads beyond the per-person daily quota with 429 and Retry-After', async () => {
    const used = await api.h.t.db.system(async (sx) =>
      Number(
        (
          await sx.query(
            `SELECT count(*) AS n FROM documents WHERE uploaded_by = :p AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
            { p: p.uuid(api.h.people.devin) },
          )
        ).rows[0]?.n,
      ),
    );
    await setSettings({ dailyUploadDocumentsPerPrincipal: used + 1 });
    try {
      const first = await upload(devin, 'x', 'quota-1.md');
      expect(first.status, await first.clone().text()).toBe(201);
      const refused = await upload(devin, 'x', 'quota-2.md');
      expect(refused.headers.get('retry-after')).toMatch(/^\d+$/);
      expect((await problem(refused, 429)).code).toBe('rate_limited');
    } finally {
      await setSettings({ dailyUploadDocumentsPerPrincipal: 20 });
    }
  });
});

describe('finding 7: a locked-out network is answered from memory (PoC t2b)', () => {
  it('stops writing audit rows for repeated locked-out attempts and answers 429 with Retry-After', async () => {
    const ip = nextViewerIp();
    const attempt = (accessCode: string) =>
      api.request('/auth/sign-in', { body: { accessCode }, headers: { 'x-fa-viewer-ip': ip } });
    const statuses: number[] = [];
    // The database locks the network out after ipFailureLimit failures in the window.
    for (let i = 0; i <= api.h.config.signIn.ipFailureLimit; i += 1)
      statuses.push((await attempt('FA-AAAAA-BBBBB-CCCCC-DDDDD')).status);
    expect(statuses.at(-1)).toBe(429);
    const audit = () =>
      api.h.t.db.system(async (sx) =>
        Number((await sx.query('SELECT count(*) AS n FROM audit_events')).rows[0]?.n),
      );
    const before = await audit();
    for (let i = 0; i < 25; i += 1) {
      const res = await attempt('FA-AAAAA-BBBBB-CCCCC-DDDDD');
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toMatch(/^\d+$/);
    }
    expect((await audit()) - before).toBeLessThanOrEqual(1);
  });
});

describe('finding 6: parallel turns cannot overshoot the rate limit (PoC t4)', () => {
  it('admits at most the configured number of turns out of 40 parallel requests', async () => {
    const tomasz = await api.signInAs(api.h.people.tomasz);
    const sessions = [];
    for (let i = 0; i < 40; i += 1) sessions.push((await session(tomasz, benchtally())).id);
    const before = api.h.gateway.calls.filter((c) => c.kind === 'generate').length;
    const outcomes = await Promise.all(
      sessions.map((s) => turn(tomasz, s, 'What should I test next with lab managers?')),
    );
    const completed = outcomes.filter((o) => o.events.at(-1)?.event === 'turn.completed').length;
    const limit = api.h.config.turns.rateLimit;
    expect(completed).toBeGreaterThan(0);
    expect(completed).toBeLessThanOrEqual(limit);
    expect(api.h.gateway.calls.filter((c) => c.kind === 'generate').length - before).toBeLessThanOrEqual(
      limit,
    );
    const rows = await api.h.t.db.system(async (sx) =>
      Number(
        (
          await sx.query('SELECT count(*) AS n FROM turns WHERE author_id = :a', {
            a: p.uuid(api.h.people.tomasz),
          })
        ).rows[0]?.n,
      ),
    );
    expect(rows).toBeLessThanOrEqual(limit);
    for (const o of outcomes.filter((x) => x.status !== 200)) expect(o.status).toBe(429);
  });
});

describe('finding 11b: ephemeral sessions stay out of EIR review', () => {
  it('never samples an ephemeral turn for the assigned EIR', async () => {
    const s = await session(maya, quietquad(), { mode: 'coach', privacy: 'ephemeral' });
    const result = await turn(maya, s.id, 'Private brainstorm: what would make me quit?');
    const done = result.events.at(-1);
    expect(done?.event).toBe('turn.completed');
    const id = done?.event === 'turn.completed' ? done.turn.id : '';
    expect(await text(corin, '/eir/reviews')).not.toContain(id);
  });
});

describe('finding 12: account and consent controls', () => {
  it('a: only a platform admin re-issues a founder’s code, and the founder is told at the next sign-in', async () => {
    const denied = await api.request(`/admin/principals/${api.h.people.maya}/access-codes`, {
      cookie: lead,
      body: {},
    });
    expect((await problem(denied, 403)).code).toBe('forbidden');
    const issued = await api.request(`/admin/principals/${api.h.people.maya}/access-codes`, {
      cookie: owner,
      body: {},
    });
    expect(issued.status).toBe(201);
    const code = ((await issued.json()) as { accessCode: string }).accessCode;
    const res = await api.request('/auth/sign-in', {
      body: { accessCode: code },
      headers: { 'x-fa-viewer-ip': nextViewerIp() },
    });
    const me = await json(res, Me);
    expect(me.notices).toEqual([{ kind: 'access_code_issued', at: expect.any(String) as unknown }]);
    const audit = await api.h.t.db.system((sx) =>
      sx.query(`SELECT count(*) AS n FROM audit_events WHERE action = 'access_code.reissued'`),
    );
    expect(Number(audit.rows[0]?.n)).toBeGreaterThan(0);
  });

  it('b: only the person who asked for help can approve sharing', async () => {
    const escalation = await json(
      await api.request(`/ventures/${quietquad()}/escalations`, {
        cookie: maya,
        body: { category: 'legal', founderQuestion: 'Can we use the university logo?' },
      }),
      EscalationView,
      201,
    );
    const approve = (token: string) =>
      api.request(`/escalations/${escalation.id}`, {
        method: 'PATCH',
        cookie: token,
        body: { action: 'approve_sharing', sharedMemoryIds: [] },
      });
    expect((await problem(await approve(devin), 403)).code).toBe('forbidden');
    expect((await approve(maya)).status).toBe(200);
  });

  it('c: suspending a tenant ends its sessions at the next request', async () => {
    const tenantId = api.h.seed.tenantId;
    expect((await api.request('/me', { cookie: devin })).status).toBe(200);
    await api.h.t.db.system((sx) =>
      sx.query(`UPDATE tenants SET status = 'suspended' WHERE id = :id`, { id: p.uuid(tenantId) }),
    );
    try {
      // Verified sessions are cached for revocationCacheSeconds (60 s); the first request after that
      // re-reads the session together with its tenant's status.
      clockOffsetMs = (api.h.config.session.revocationCacheSeconds + 1) * 1000;
      expect((await problem(await api.request('/me', { cookie: devin }), 401)).code).toBe('unauthenticated');
    } finally {
      clockOffsetMs = 0;
      await api.h.t.db.system((sx) =>
        sx.query(`UPDATE tenants SET status = 'active' WHERE id = :id`, { id: p.uuid(tenantId) }),
      );
    }
  });
});

describe('R2: memory lists stay small (excerpt + paging) and items load in full', () => {
  it('pages with a cursor and returns at most 400 characters of content per item', async () => {
    const long = 'Long note. '.repeat(500);
    const created = await api.request(`/ventures/${quietquad()}/memory`, {
      cookie: maya,
      body: { type: 'insight', title: 'Long insight', content: long },
    });
    const id = ((await created.json()) as { id: string }).id;
    const first = await json(
      await api.request(`/ventures/${quietquad()}/memory?limit=2`, { cookie: maya }),
      MemoryListResponse,
    );
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await json(
      await api.request(`/ventures/${quietquad()}/memory?limit=2&cursor=${first.nextCursor ?? ''}`, {
        cookie: maya,
      }),
      MemoryListResponse,
    );
    expect(second.items.map((m) => m.id)).not.toContain(first.items[0]?.id);
    const all = await json(
      await api.request(`/ventures/${quietquad()}/memory?limit=100`, { cookie: maya }),
      MemoryListResponse,
    );
    const listed = all.items.find((m) => m.id === id);
    expect(listed?.content.length).toBeLessThanOrEqual(400);
    expect(listed?.contentLength).toBe(long.trim().length);
    const full = await json(await api.request(`/memory/${id}`, { cookie: maya }), MemoryItemResponse);
    expect(full.content).toBe(long.trim());
  });
});
