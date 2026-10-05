import {
  AccessCodeIssued,
  EscalationListResponse,
  EscalationView,
  MemoryHistoryResponse,
  MemoryListResponse,
  MemoryObjectView,
  ProblemDetails,
  TeamResponse,
  VentureDetailResponse,
  VentureListResponse,
  VentureOverview,
} from '@foundry/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ApiHarness, createApiHarness } from './testing/api-harness.js';

let api: ApiHarness;
let maya: string;
let devin: string;
let jonah: string;
let corin: string;
let lead: string;

beforeAll(async () => {
  api = await createApiHarness();
  [maya, devin, jonah, corin, lead] = await Promise.all([
    api.signInAs(api.h.people.maya),
    api.signInAs(api.h.people.devin),
    api.signInAs(api.h.people.jonah),
    api.signInAs(api.h.people.eirCorin),
    api.signInAs(api.h.people.lead),
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
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(status);
  return ProblemDetails.parse(JSON.parse(text)).code;
}

describe('ventures', () => {
  it('lists only the caller’s ventures', async () => {
    const mine = await json(await api.request('/ventures', { cookie: maya }), VentureListResponse);
    expect(mine.items.map((v) => v.id)).toEqual([quietquad()]);
    expect(mine.items[0]?.myRole).toBe('founder');
    const eir = await json(await api.request('/ventures', { cookie: corin }), VentureListResponse);
    expect(eir.items.map((v) => v.id).sort()).toEqual(
      [api.h.ventures.quietquad.id, api.h.ventures.benchtally.id].sort(),
    );
  });

  it('reads detail and overview; other ventures are not found', async () => {
    const detail = await json(
      await api.request(`/ventures/${quietquad()}`, { cookie: maya }),
      VentureDetailResponse,
    );
    expect(detail.id).toBe(quietquad());
    const overview = await json(
      await api.request(`/ventures/${quietquad()}/overview`, { cookie: maya }),
      VentureOverview,
    );
    expect(overview.venture.id).toBe(quietquad());
    expect(await problemCode(await api.request(`/ventures/${quietquad()}`, { cookie: jonah }), 404)).toBe(
      'not_found',
    );
    expect(
      await problemCode(await api.request(`/ventures/${quietquad()}/overview`, { cookie: lead }), 404),
    ).toBe('not_found');
  });

  it('updates (founder/team) but not as the assigned EIR', async () => {
    const updated = await json(
      await api.request(`/ventures/${quietquad()}`, {
        method: 'PATCH',
        body: { currentGoal: 'Run the exam-week pilot' },
        cookie: devin,
      }),
      VentureDetailResponse,
    );
    expect(updated.currentGoal).toBe('Run the exam-week pilot');
    expect(
      await problemCode(
        await api.request(`/ventures/${quietquad()}`, {
          method: 'PATCH',
          body: { name: 'Hijack' },
          cookie: corin,
        }),
        403,
      ),
    ).toBe('forbidden');
    expect(
      await problemCode(
        await api.request(`/ventures/${quietquad()}`, { method: 'PATCH', body: {}, cookie: maya }),
        422,
      ),
    ).toBe('validation_failed');
  });
});

describe('memory', () => {
  it('lists with filters, creates, acts and shows history', async () => {
    const all = await json(
      await api.request(`/ventures/${quietquad()}/memory`, { cookie: maya }),
      MemoryListResponse,
    );
    expect(all.items.length).toBeGreaterThan(5);
    const decisions = await json(
      await api.request(`/ventures/${quietquad()}/memory?type=decision&pinned=false`, { cookie: maya }),
      MemoryListResponse,
    );
    expect(decisions.items.every((m) => m.type === 'decision' && !m.pinned)).toBe(true);
    expect(
      await problemCode(
        await api.request(`/ventures/${quietquad()}/memory?pinned=maybe`, { cookie: maya }),
        422,
      ),
    ).toBe('validation_failed');

    const created = await json(
      await api.request(`/ventures/${quietquad()}/memory`, {
        body: {
          type: 'fact',
          title: 'Library opening hours',
          content: 'The main library opens at 07:30 on weekdays.',
        },
        cookie: maya,
        idempotencyKey: 'memory-create-0001',
      }),
      MemoryObjectView,
      201,
    );
    expect(created).toMatchObject({ status: 'confirmed', origin: 'founder', ventureId: quietquad() });

    const pinned = await json(
      await api.request(`/memory/${created.id}`, { method: 'PATCH', body: { action: 'pin' }, cookie: maya }),
      MemoryObjectView,
    );
    expect(pinned.pinned).toBe(true);
    const corrected = await json(
      await api.request(`/memory/${created.id}`, {
        method: 'PATCH',
        body: { action: 'correct', patch: { content: 'The main library opens at 07:00 on weekdays.' } },
        cookie: maya,
      }),
      MemoryObjectView,
    );
    expect(corrected.supersedesId).toBe(created.id);
    const history = await json(
      await api.request(`/memory/${corrected.id}/history`, { cookie: maya }),
      MemoryHistoryResponse,
    );
    expect(history.items.map((e) => e.action)).toEqual(
      expect.arrayContaining(['created', 'pinned', 'corrected']),
    );

    // Another venture's founder cannot touch it; the assigned EIR cannot act on it.
    expect(
      await problemCode(
        await api.request(`/memory/${corrected.id}`, {
          method: 'PATCH',
          body: { action: 'pin' },
          cookie: jonah,
        }),
        404,
      ),
    ).toBe('not_found');
    const eirCode = await problemCode(
      await api.request(`/memory/${corrected.id}`, {
        method: 'PATCH',
        body: { action: 'unpin' },
        cookie: corin,
      }),
      403,
    );
    expect(eirCode).toBe('forbidden');

    const deleted = await api.request(`/memory/${corrected.id}`, {
      method: 'PATCH',
      body: { action: 'delete' },
      cookie: maya,
    });
    expect(deleted.status).toBe(204);
    expect(
      await problemCode(
        await api.request(`/memory/${corrected.id}`, {
          method: 'PATCH',
          body: { action: 'pin' },
          cookie: maya,
        }),
        404,
      ),
    ).toBe('not_found');
  });

  it('replays a create for a retried Idempotency-Key and rejects key reuse with another body', async () => {
    const body = { type: 'risk', title: 'Wi-Fi outages', content: 'Library Wi-Fi drops during peak hours.' };
    const first = await api.request(`/ventures/${quietquad()}/memory`, {
      body,
      cookie: maya,
      idempotencyKey: 'memory-create-0002',
    });
    expect(first.status).toBe(201);
    const original = MemoryObjectView.parse(await first.json());
    const again = await api.request(`/ventures/${quietquad()}/memory`, {
      body,
      cookie: maya,
      idempotencyKey: 'memory-create-0002',
    });
    expect(again.status).toBe(201);
    expect(again.headers.get('idempotency-replayed')).toBe('true');
    expect(MemoryObjectView.parse(await again.json()).id).toBe(original.id);
    const list = await json(
      await api.request(`/ventures/${quietquad()}/memory?q=Wi-Fi`, { cookie: maya }),
      MemoryListResponse,
    );
    expect(list.items.filter((m) => m.title === 'Wi-Fi outages')).toHaveLength(1);

    const reuse = await api.request(`/ventures/${quietquad()}/memory`, {
      body: { ...body, title: 'Different' },
      cookie: maya,
      idempotencyKey: 'memory-create-0002',
    });
    expect(await problemCode(reuse, 409)).toBe('idempotency_conflict');
    // Keys are per principal: the same key from a teammate is a new request.
    const teammate = await api.request(`/ventures/${quietquad()}/memory`, {
      body,
      cookie: devin,
      idempotencyKey: 'memory-create-0002',
    });
    expect(teammate.status).toBe(201);
    expect(teammate.headers.get('idempotency-replayed')).toBeNull();
    // Malformed keys are rejected.
    const malformed = await api.request(`/ventures/${quietquad()}/memory`, {
      body,
      cookie: maya,
      idempotencyKey: 'short',
    });
    expect(await problemCode(malformed, 400)).toBe('bad_request');
  });

  it('does not store failed attempts: a retry after a 4xx executes again', async () => {
    const key = 'memory-create-0003';
    const invalid = await api.request(`/ventures/${quietquad()}/memory`, {
      body: { type: 'fact' },
      cookie: maya,
      idempotencyKey: key,
    });
    expect(invalid.status).toBe(422);
    const again = await api.request(`/ventures/${quietquad()}/memory`, {
      body: { type: 'fact' },
      cookie: maya,
      idempotencyKey: key,
    });
    expect(again.status).toBe(422);
    expect(again.headers.get('idempotency-replayed')).toBeNull();
  });
});

describe('escalations', () => {
  it('founder creates and approves sharing; the assigned EIR sees it in the inbox and resolves it', async () => {
    const created = await json(
      await api.request(`/ventures/${quietquad()}/escalations`, {
        body: { category: 'expert_judgment', founderQuestion: 'Should we price per seat or per building?' },
        cookie: maya,
      }),
      EscalationView,
      201,
    );
    expect(created.status).toBe('awaiting_consent');
    const list = await json(
      await api.request(`/ventures/${quietquad()}/escalations`, { cookie: devin }),
      EscalationListResponse,
    );
    expect(list.items.map((e) => e.id)).toContain(created.id);
    // The EIR cannot act before consent.
    expect(
      await problemCode(
        await api.request(`/escalations/${created.id}`, {
          method: 'PATCH',
          body: { action: 'acknowledge' },
          cookie: corin,
        }),
        404,
      ),
    ).toBe('not_found');

    const shared = await json(
      await api.request(`/escalations/${created.id}`, {
        method: 'PATCH',
        body: { action: 'approve_sharing' },
        cookie: maya,
      }),
      EscalationView,
    );
    expect(shared.status).toBe('routed');
    const inbox = await json(
      await api.request('/inbox/escalations', { cookie: corin }),
      EscalationListResponse,
    );
    expect(inbox.items.map((e) => e.id)).toContain(created.id);
    const acknowledged = await json(
      await api.request(`/escalations/${created.id}`, {
        method: 'PATCH',
        body: { action: 'acknowledge' },
        cookie: corin,
      }),
      EscalationView,
    );
    expect(acknowledged.status).toBe('acknowledged');
    const resolved = await json(
      await api.request(`/escalations/${created.id}`, {
        method: 'PATCH',
        body: {
          action: 'resolve',
          resolution: { summary: 'Per building first.', nextSteps: ['Draft pricing page'] },
        },
        cookie: corin,
      }),
      EscalationView,
    );
    expect(resolved.status).toBe('resolved');
    // Other founders see nothing.
    expect(
      await problemCode(await api.request(`/ventures/${quietquad()}/escalations`, { cookie: jonah }), 404),
    ).toBe('not_found');
  });
});

describe('team', () => {
  it('lists members and lets a program lead invite (one-time code, never replayed)', async () => {
    const team = await json(
      await api.request(`/ventures/${quietquad()}/team`, { cookie: maya }),
      TeamResponse,
    );
    expect(team.items.map((m) => m.principal.id)).toEqual(
      expect.arrayContaining([api.h.people.maya, api.h.people.devin]),
    );

    const body = { displayName: 'Synthetic Teammate', role: 'team' };
    const invited = await api.request(`/ventures/${quietquad()}/team/invitations`, {
      body,
      cookie: lead,
      idempotencyKey: 'invite-key-0001',
    });
    expect(invited.status).toBe(201);
    const issued = AccessCodeIssued.parse(await invited.json());
    expect(issued.accessCode).toMatch(/^FA-/);
    const retry = await api.request(`/ventures/${quietquad()}/team/invitations`, {
      body,
      cookie: lead,
      idempotencyKey: 'invite-key-0001',
    });
    expect(await problemCode(retry, 409)).toBe('idempotency_conflict');
    // The plaintext code is not stored with the idempotency record.
    const stored = await api.h.t.db.system((sx) =>
      sx.query("SELECT response::text AS r FROM idempotency_keys WHERE key = 'invite-key-0001'"),
    );
    expect(JSON.stringify(stored.rows)).not.toContain(issued.accessCode);

    // Founders cannot invite.
    expect(
      await problemCode(
        await api.request(`/ventures/${quietquad()}/team/invitations`, { body, cookie: maya }),
        403,
      ),
    ).toBe('forbidden');
  });
});
