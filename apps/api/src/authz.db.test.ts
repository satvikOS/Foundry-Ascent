import {
  AccessCodeIssued,
  CreateDocumentResponse,
  EscalationQueueResponse,
  EscalationView,
  MemoryObjectView,
  PersonaReleaseView,
  ProblemDetails,
  ResourceView,
  SessionView,
  TurnStreamEvent,
} from '@foundry/contracts';
import { GUIDE_DOCTRINE, GUIDE_STYLE } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ApiHarness, createApiHarness, type RequestOptions } from './testing/api-harness.js';
import { parseSse } from './testing/sse.js';

/**
 * Every authenticated endpoint refuses a principal without the right relationship or role, with a
 * problem document (403 forbidden, or 404 not_found where existence must not leak). Complements the
 * happy-path suites, which also cover the allowed side of each rule.
 */
let api: ApiHarness;
let tokens: Record<'maya' | 'jonah' | 'lead' | 'owner', string>;
const ids: Record<string, string> = {};

async function ok<T>(res: Response, schema: { parse: (v: unknown) => T }, status: number): Promise<T> {
  const text = await res.text();
  expect(res.status, text.slice(0, 200)).toBe(status);
  return schema.parse(JSON.parse(text));
}

beforeAll(async () => {
  api = await createApiHarness({ random: () => 0 });
  const [maya, jonah, lead] = await Promise.all([
    api.signInAs(api.h.people.maya),
    api.signInAs(api.h.people.jonah),
    api.signInAs(api.h.people.lead),
  ]);
  tokens = { maya, jonah, lead, owner: await api.ownerToken() };
  const qq = api.h.ventures.quietquad.id;
  ids.venture = qq;

  const session = await ok(
    await api.request(`/ventures/${qq}/sessions`, { body: {}, cookie: maya }),
    SessionView,
    201,
  );
  ids.session = session.id;
  const stream = await api.request(`/sessions/${session.id}/turns`, {
    body: { text: 'What is our next step?' },
    cookie: maya,
  });
  const accepted = parseSse(await stream.text())
    .frames.map((f) => TurnStreamEvent.parse(JSON.parse(f.data)))
    .find((e) => e.event === 'turn.accepted');
  if (accepted?.event !== 'turn.accepted') throw new Error('turn not accepted');
  ids.turn = accepted.turnId;
  ids.memory = (
    await ok(
      await api.request(`/ventures/${qq}/memory`, {
        body: { type: 'fact', title: 'T', content: 'C' },
        cookie: maya,
      }),
      MemoryObjectView,
      201,
    )
  ).id;
  ids.escalation = (
    await ok(
      await api.request(`/ventures/${qq}/escalations`, {
        body: { category: 'other', founderQuestion: 'Q?' },
        cookie: maya,
      }),
      EscalationView,
      201,
    )
  ).id;
  ids.document = (
    await ok(
      await api.request(`/ventures/${qq}/documents`, {
        body: { filename: 'a.txt', contentType: 'text/plain', sizeBytes: 3 },
        cookie: maya,
      }),
      CreateDocumentResponse,
      201,
    )
  ).document.id;
  ids.resource = (
    await ok(
      await api.request('/program/resources', {
        body: { name: 'R', kind: 'other', description: 'Resource for denial tests.' },
        cookie: lead,
      }),
      ResourceView,
      201,
    )
  ).id;
  ids.release = (
    await ok(
      await api.request(`/personas/${api.h.seed.personaId}/releases`, {
        body: {
          doctrine: GUIDE_DOCTRINE,
          style: GUIDE_STYLE,
          disclosureText:
            'You are working with Foundry Guide, an AI coach. It is not a person, and no human EIR authored or approved these responses.',
          allowedModes: ['diagnose'],
        },
        cookie: lead,
      }),
      PersonaReleaseView,
      201,
    )
  ).id;
  ids.code = (
    await ok(
      await api.request(`/admin/principals/${api.h.people.devin}/access-codes`, {
        body: {},
        cookie: tokens.owner,
      }),
      AccessCodeIssued,
      201,
    )
  ).accessCodeId;
  const queue = await ok(
    await api.request('/program/escalations', { cookie: lead }),
    EscalationQueueResponse,
    200,
  );
  ids.queued = queue.items[0]?.id ?? '00000000-0000-4000-8000-000000000000';
});
afterAll(async () => {
  await api.cleanup();
});

type Case = readonly [
  who: keyof typeof tokens,
  method: NonNullable<RequestOptions['method']>,
  path: string,
  body?: unknown,
];

const ventureCases = (): Case[] => {
  const v = ids.venture ?? '';
  return [
    ['jonah', 'GET', `/ventures/${v}`],
    ['jonah', 'PATCH', `/ventures/${v}`, { name: 'Jonah Zephyrine' }],
    ['jonah', 'GET', `/ventures/${v}/overview`],
    ['jonah', 'GET', `/ventures/${v}/memory`],
    ['jonah', 'POST', `/ventures/${v}/memory`, { type: 'fact', title: 'x', content: 'y' }],
    ['jonah', 'GET', `/memory/${ids.memory ?? ''}`],
    ['jonah', 'PATCH', `/memory/${ids.memory ?? ''}`, { action: 'pin' }],
    ['jonah', 'GET', `/memory/${ids.memory ?? ''}/history`],
    ['jonah', 'GET', `/ventures/${v}/escalations`],
    ['jonah', 'POST', `/ventures/${v}/escalations`, { category: 'other', founderQuestion: 'x' }],
    ['jonah', 'PATCH', `/escalations/${ids.escalation ?? ''}`, { action: 'withdraw' }],
    ['jonah', 'GET', `/ventures/${v}/team`],
    ['jonah', 'POST', `/ventures/${v}/team/invitations`, { displayName: 'x', role: 'team' }],
    ['jonah', 'POST', `/ventures/${v}/sessions`, {}],
    ['jonah', 'GET', `/ventures/${v}/sessions`],
    ['jonah', 'GET', `/sessions/${ids.session ?? ''}`],
    ['jonah', 'POST', `/sessions/${ids.session ?? ''}/turns`, { text: 'hello' }],
    ['jonah', 'POST', `/sessions/${ids.session ?? ''}/end`],
    ['jonah', 'POST', `/turns/${ids.turn ?? ''}/feedback`, { rating: 5 }],
    ['jonah', 'GET', `/turns/${ids.turn ?? ''}/evidence`],
    [
      'jonah',
      'POST',
      `/ventures/${v}/documents`,
      { filename: 'a.txt', contentType: 'text/plain', sizeBytes: 3 },
    ],
    ['jonah', 'POST', `/documents/${ids.document ?? ''}/complete`],
    ['jonah', 'GET', `/ventures/${v}/documents`],
    ['jonah', 'DELETE', `/documents/${ids.document ?? ''}`],
  ];
};

const studioCases = (): Case[] => [
  ['maya', 'GET', '/personas'],
  ['maya', 'GET', `/personas/${api.h.seed.personaId}`],
  ['maya', 'GET', '/eir/profiles'],
  [
    'maya',
    'POST',
    `/personas/${api.h.seed.personaId}/releases`,
    { doctrine: GUIDE_DOCTRINE, style: GUIDE_STYLE, disclosureText: 'x'.repeat(50), allowedModes: ['coach'] },
  ],
  ['maya', 'POST', `/persona-releases/${ids.release ?? ''}/approve`],
  ['maya', 'POST', `/personas/${api.h.seed.personaId}/suspend`, { reason: 'founder attempt' }],
  ['maya', 'POST', `/personas/${api.h.seed.personaId}/resume`],
  ['maya', 'GET', '/eir/reviews'],
  [
    'maya',
    'POST',
    `/eir/reviews/${ids.turn ?? ''}`,
    { scores: { correctness: 1, rigor: 1, specificity: 1, teachability: 1, personaFit: 1, escalation: 1 } },
  ],
  ['maya', 'GET', '/program/portfolio'],
  ['maya', 'GET', '/program/ventures'],
  ['maya', 'POST', '/program/ventures', { name: 'Maya Zephyrine' }],
  ['maya', 'PATCH', `/program/ventures/${ids.venture ?? ''}`, { name: 'Maya Zephyrine Rename' }],
  ['maya', 'POST', '/program/resources', { name: 'x', kind: 'other', description: 'y' }],
  ['maya', 'PATCH', `/program/resources/${ids.resource ?? ''}`, { status: 'retired' }],
  ['maya', 'GET', '/program/escalations'],
  ['maya', 'POST', `/program/escalations/${ids.queued ?? ''}/route`, { assigneeId: api.h.people.maya }],
  ['maya', 'GET', '/admin/principals'],
  ['maya', 'POST', '/admin/principals', { displayName: 'x' }],
  ['maya', 'POST', `/admin/principals/${api.h.people.devin}/access-codes`, {}],
  ['maya', 'DELETE', `/admin/access-codes/${ids.code ?? ''}`],
  ['lead', 'GET', '/admin/settings'],
  ['lead', 'PATCH', '/admin/settings', { aiEnabled: false }],
  ['lead', 'GET', '/admin/audit'],
  ['lead', 'GET', '/admin/usage'],
  ['lead', 'POST', `/admin/principals/${api.h.people.owner}/access-codes`, {}],
  // Re-issuing a code for a founder who already has one takes over their account: platform admins only.
  ['lead', 'POST', `/admin/principals/${api.h.people.maya}/access-codes`, {}],
];

describe('authorization denials', () => {
  it('another venture’s founder is refused on every venture-scoped endpoint', async () => {
    for (const [who, method, path, body] of ventureCases()) {
      const res = await api.request(path, {
        method,
        cookie: tokens[who],
        ...(body === undefined ? {} : { body }),
      });
      const text = await res.text();
      expect([403, 404], `${method} ${path}: ${text.slice(0, 160)}`).toContain(res.status);
      expect(['forbidden', 'not_found']).toContain(ProblemDetails.parse(JSON.parse(text)).code);
    }
  });

  it('founders and program leads are refused on EIR, program and admin endpoints beyond their role', async () => {
    for (const [who, method, path, body] of studioCases()) {
      const res = await api.request(path, {
        method,
        cookie: tokens[who],
        ...(body === undefined ? {} : { body }),
      });
      const text = await res.text();
      expect([403, 404], `${who} ${method} ${path}: ${text.slice(0, 160)}`).toContain(res.status);
      expect(['forbidden', 'not_found']).toContain(ProblemDetails.parse(JSON.parse(text)).code);
    }
  });
});
