import {
  AccessCodeIssued,
  AdminPrincipalListResponse,
  AdminPrincipalRow,
  AuditListResponse,
  EirProfileListResponse,
  EscalationQueueItem,
  EscalationQueueResponse,
  PersonaListResponse,
  PersonaReleaseView,
  PersonaView,
  PlatformSettingsView,
  PortfolioSummary,
  ProblemDetails,
  ProgramVentureListResponse,
  ProgramVentureRow,
  ResourceListResponse,
  ResourceView,
  ReviewQueueResponse,
  SessionView,
  TurnStreamEvent,
  UsageSummary,
} from '@foundry/contracts';
import { GUIDE_DOCTRINE, GUIDE_STYLE } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ApiHarness, createApiHarness } from './testing/api-harness.js';
import { parseSse } from './testing/sse.js';

let api: ApiHarness;
let owner: string;
let lead: string;
let corin: string;
let ruth: string;
let maya: string;

beforeAll(async () => {
  // random() = 0: every turn is sampled for EIR calibration review.
  api = await createApiHarness({ random: () => 0 });
  owner = await api.ownerToken();
  [lead, corin, ruth, maya] = await Promise.all([
    api.signInAs(api.h.people.lead),
    api.signInAs(api.h.people.eirCorin),
    api.signInAs(api.h.people.eirRuth),
    api.signInAs(api.h.people.maya),
  ]);
});
afterAll(async () => {
  await api.cleanup();
});

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

const release = {
  doctrine: GUIDE_DOCTRINE,
  style: GUIDE_STYLE,
  disclosureText:
    'You are working with Foundry Guide, an AI coach. It is not a person, and no human EIR authored or approved these responses.',
  allowedModes: ['diagnose', 'coach', 'challenge', 'teach', 'rehearse', 'route'],
};

describe('EIR studio', () => {
  it('lists and reads personas (EIR / program lead), not founders', async () => {
    const list = await json(await api.request('/personas', { cookie: corin }), PersonaListResponse);
    expect(list.items.map((p) => p.id)).toContain(api.h.seed.personaId);
    const persona = await json(
      await api.request(`/personas/${api.h.seed.personaId}`, { cookie: lead }),
      PersonaView,
    );
    expect(persona.kind).toBe('neutral_guide');
    expect(await problemCode(await api.request('/personas', { cookie: maya }), 403)).toBe('forbidden');
    const profiles = await json(await api.request('/eir/profiles', { cookie: lead }), EirProfileListResponse);
    expect(profiles.items.length).toBeGreaterThanOrEqual(2);
  });

  it('drafts and approves a release, suspends and resumes the persona (program lead)', async () => {
    const draft = await json(
      await api.request(`/personas/${api.h.seed.personaId}/releases`, { body: release, cookie: lead }),
      PersonaReleaseView,
      201,
    );
    expect(draft.status).toBe('draft');
    expect(
      await problemCode(
        await api.request(`/persona-releases/${draft.id}/approve`, { method: 'POST', cookie: maya }),
        403,
      ),
    ).toBe('forbidden');
    const approved = await json(
      await api.request(`/persona-releases/${draft.id}/approve`, { method: 'POST', cookie: lead }),
      PersonaReleaseView,
    );
    expect(approved.status).toBe('approved');

    const suspended = await json(
      await api.request(`/personas/${api.h.seed.personaId}/suspend`, {
        body: { reason: 'Calibration review' },
        cookie: lead,
      }),
      PersonaView,
    );
    expect(suspended.status).toBe('suspended');
    // The kill switch blocks new sessions immediately.
    const blocked = await api.request(`/ventures/${api.h.ventures.quietquad.id}/sessions`, {
      body: {},
      cookie: maya,
    });
    expect(await problemCode(blocked, 423)).toBe('persona_suspended');
    const resumed = await json(
      await api.request(`/personas/${api.h.seed.personaId}/resume`, { method: 'POST', cookie: lead }),
      PersonaView,
    );
    expect(resumed.status).toBe('active');
    expect(
      await problemCode(
        await api.request(`/personas/${api.h.seed.personaId}/suspend`, {
          body: { reason: 'founder attempt' },
          cookie: maya,
        }),
        403,
      ),
    ).toBe('forbidden');
  });

  it('assigned EIRs review sampled turns; others cannot', async () => {
    const session = SessionView.parse(
      await (
        await api.request(`/ventures/${api.h.ventures.quietquad.id}/sessions`, { body: {}, cookie: maya })
      ).json(),
    );
    const stream = await api.request(`/sessions/${session.id}/turns`, {
      body: { text: 'How should we schedule the next round of student interviews?' },
      cookie: maya,
    });
    const events = parseSse(await stream.text()).frames.map((f) => TurnStreamEvent.parse(JSON.parse(f.data)));
    const done = events.at(-1);
    if (done?.event !== 'turn.completed') throw new Error('expected turn.completed');

    const queue = await json(await api.request('/eir/reviews', { cookie: corin }), ReviewQueueResponse);
    expect(queue.items.map((s) => s.turn.id)).toContain(done.turn.id);
    const scores = {
      correctness: 4,
      rigor: 4,
      specificity: 3,
      teachability: 4,
      personaFit: 5,
      escalation: 5,
    };
    const review = await api.request(`/eir/reviews/${done.turn.id}`, { body: { scores }, cookie: corin });
    expect(review.status).toBe(201);
    expect(await review.json()).toMatchObject({ turnId: done.turn.id });
    // Ruth is not assigned to QuietQuad.
    const denied = await api.request(`/eir/reviews/${done.turn.id}`, { body: { scores }, cookie: ruth });
    expect([403, 404]).toContain(denied.status);
    expect(await problemCode(await api.request('/eir/reviews', { cookie: maya }), 403)).toBe('forbidden');
  });
});

describe('program console', () => {
  it('portfolio aggregates for program leads and admins only', async () => {
    const portfolio = await json(await api.request('/program/portfolio', { cookie: lead }), PortfolioSummary);
    expect(portfolio.minGroupSize).toBeGreaterThanOrEqual(2);
    expect((await api.request('/program/portfolio', { cookie: owner })).status).toBe(200);
    expect(await problemCode(await api.request('/program/portfolio', { cookie: maya }), 403)).toBe(
      'forbidden',
    );
  });

  it('enrols ventures and lists them', async () => {
    const created = await json(
      await api.request('/program/ventures', {
        body: { name: 'Tidewell Labs', stage: 'discovery' },
        cookie: lead,
      }),
      ProgramVentureRow,
      201,
    );
    expect(created.personaName).not.toBeNull();
    const list = await json(
      await api.request('/program/ventures', { cookie: lead }),
      ProgramVentureListResponse,
    );
    expect(list.items.map((v) => v.id)).toContain(created.id);
    expect(
      await problemCode(
        await api.request('/program/ventures', { body: { name: 'Nope' }, cookie: corin }),
        403,
      ),
    ).toBe('forbidden');
  });

  it('manages resources: founders read with filters, leads create/update/retire', async () => {
    const created = await json(
      await api.request('/program/resources', {
        body: {
          name: 'Prototype grant',
          kind: 'funding',
          description: 'Small grants for first prototypes.',
          tags: ['grant'],
        },
        cookie: lead,
      }),
      ResourceView,
      201,
    );
    const filtered = await json(
      await api.request('/program/resources?kind=funding&tag=grant', { cookie: maya }),
      ResourceListResponse,
    );
    expect(filtered.items.map((r) => r.id)).toContain(created.id);
    expect(filtered.items.every((r) => r.kind === 'funding')).toBe(true);
    const retired = await json(
      await api.request(`/program/resources/${created.id}`, {
        method: 'PATCH',
        body: { status: 'retired' },
        cookie: lead,
      }),
      ResourceView,
    );
    expect(retired.status).toBe('retired');
    const after = await json(
      await api.request('/program/resources?kind=funding', { cookie: maya }),
      ResourceListResponse,
    );
    expect(after.items.map((r) => r.id)).not.toContain(created.id);
    expect(
      await problemCode(await api.request('/program/resources', { body: { name: 'x' }, cookie: maya }), 422),
    ).toBe('validation_failed');
    expect(
      await problemCode(
        await api.request('/program/resources', {
          body: { name: 'Founder resource', kind: 'other', description: 'Should not be allowed.' },
          cookie: maya,
        }),
        403,
      ),
    ).toBe('forbidden');
    expect(
      await problemCode(await api.request('/program/resources?kind=spaceship', { cookie: maya }), 422),
    ).toBe('validation_failed');
  });

  it('shows the escalation queue as metadata and routes consented escalations', async () => {
    const queue = await json(
      await api.request('/program/escalations', { cookie: lead }),
      EscalationQueueResponse,
    );
    const shared = queue.items.find((e) => e.shared);
    if (shared === undefined) throw new Error('seed has no consented escalation');
    const routed = await json(
      await api.request(`/program/escalations/${shared.id}/route`, {
        body: { assigneeId: api.h.people.eirCorin },
        cookie: lead,
      }),
      EscalationQueueItem,
    );
    expect(routed.assigneeId).toBe(api.h.people.eirCorin);
    expect(await problemCode(await api.request('/program/escalations', { cookie: maya }), 403)).toBe(
      'forbidden',
    );
  });
});

describe('admin console', () => {
  it('manages principals and access codes (platform admin)', async () => {
    const list = await json(
      await api.request('/admin/principals', { cookie: owner }),
      AdminPrincipalListResponse,
    );
    expect(list.items.length).toBeGreaterThan(5);
    const created = await json(
      await api.request('/admin/principals', {
        body: { displayName: 'Synthetic Analyst', roles: [] },
        cookie: owner,
      }),
      AdminPrincipalRow,
      201,
    );
    const issued = await json(
      await api.request(`/admin/principals/${created.principal.id}/access-codes`, {
        body: { label: 'laptop' },
        cookie: owner,
        idempotencyKey: 'issue-code-0001',
      }),
      AccessCodeIssued,
      201,
    );
    // The new principal can sign in with the one-time code.
    const signIn = await api.request('/auth/sign-in', {
      body: { accessCode: issued.accessCode },
      headers: { 'x-fa-viewer-ip': '192.0.2.44' },
    });
    expect(signIn.status).toBe(200);
    const revoked = await api.request(`/admin/access-codes/${issued.accessCodeId}`, {
      method: 'DELETE',
      cookie: owner,
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({
      accessCodeId: issued.accessCodeId,
      revokedAt: expect.any(String) as unknown,
    });
    // Non-admins are refused.
    expect(await problemCode(await api.request('/admin/principals', { cookie: maya }), 403)).toBe(
      'forbidden',
    );
    expect(
      await problemCode(
        await api.request('/admin/principals', { body: { displayName: 'X' }, cookie: corin }),
        403,
      ),
    ).toBe('forbidden');
  });

  it('reads and updates settings; the kill switch stops new sessions', async () => {
    const settings = await json(
      await api.request('/admin/settings', { cookie: owner }),
      PlatformSettingsView,
    );
    expect(settings.aiEnabled).toBe(true);
    const off = await json(
      await api.request('/admin/settings', { method: 'PATCH', body: { aiEnabled: false }, cookie: owner }),
      PlatformSettingsView,
    );
    expect(off.aiEnabled).toBe(false);
    const blocked = await api.request(`/ventures/${api.h.ventures.quietquad.id}/sessions`, {
      body: {},
      cookie: maya,
    });
    expect(await problemCode(blocked, 503)).toBe('ai_disabled');
    await json(
      await api.request('/admin/settings', { method: 'PATCH', body: { aiEnabled: true }, cookie: owner }),
      PlatformSettingsView,
    );
    expect(
      await problemCode(
        await api.request('/admin/settings', { method: 'PATCH', body: { aiEnabled: false }, cookie: lead }),
        403,
      ),
    ).toBe('forbidden');
    expect(
      await problemCode(
        await api.request('/admin/settings', {
          method: 'PATCH',
          body: { dailyUsdCapGlobal: -1 },
          cookie: owner,
        }),
        422,
      ),
    ).toBe('validation_failed');
  });

  it('pages the audit log and summarises usage', async () => {
    const page = await json(await api.request('/admin/audit?limit=3', { cookie: owner }), AuditListResponse);
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).not.toBeNull();
    const next = await json(
      await api.request(`/admin/audit?limit=3&cursor=${encodeURIComponent(page.nextCursor ?? '')}`, {
        cookie: owner,
      }),
      AuditListResponse,
    );
    expect(next.items[0]?.id).toBeLessThan(page.items[2]?.id ?? 0);
    const engaged = await json(
      await api.request('/admin/audit?action=kill_switch.engaged', { cookie: owner }),
      AuditListResponse,
    );
    expect(engaged.items.length).toBeGreaterThanOrEqual(1);
    const usage = await json(await api.request('/admin/usage', { cookie: owner }), UsageSummary);
    expect(usage.byDay.length).toBeGreaterThan(0);
    expect(await problemCode(await api.request('/admin/audit', { cookie: lead }), 403)).toBe('forbidden');
    expect(await problemCode(await api.request('/admin/usage', { cookie: maya }), 403)).toBe('forbidden');
  });
});
