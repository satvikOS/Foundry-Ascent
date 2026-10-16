/**
 * GET /admin/insights (Admin → Usage → Conversations and memory): platform admins only, the admin's tenant,
 * counts and timings with no conversation content.
 */
import { AdminInsights, ProblemDetails, TurnStreamEvent } from '@foundry/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ApiHarness, createApiHarness } from './testing/api-harness.js';

let api: ApiHarness;
let owner: string;
let maya: string;
const CANARY = 'Thistlewick';

beforeAll(async () => {
  api = await createApiHarness();
  owner = await api.ownerToken();
  maya = await api.signInAs(api.h.people.maya);
  const ctx = await api.h.ctxFor(api.h.people.maya);
  const session = await api.h.core.sessions.create(ctx, api.h.ventures.quietquad.id, {});
  await api.h.core.orchestrator.runTurn(ctx, session.id, { text: `${CANARY}: how do we price?` }, (e) => {
    TurnStreamEvent.parse(e);
  });
  const temporary = await api.h.core.sessions.create(ctx, api.h.ventures.quietquad.id, {
    privacy: 'ephemeral',
  });
  await api.h.core.orchestrator.runTurn(ctx, temporary.id, { text: 'Just between us.' }, (e) => {
    TurnStreamEvent.parse(e);
  });
}, 120_000);

afterAll(async () => {
  await api.cleanup();
});

describe('GET /admin/insights', () => {
  it('gives a platform admin conversations, distillation, memory and latency as numbers', async () => {
    const res = await api.request('/admin/insights', { cookie: owner });
    const text = await res.text();
    expect(res.status, text.slice(0, 200)).toBe(200);
    const insights = AdminInsights.parse(JSON.parse(text));
    expect(insights.days).toBe(30);
    const chat = insights.conversations.find((c) => c.channel === 'text');
    expect(chat?.conversations).toBeGreaterThanOrEqual(1);
    expect(insights.privateConversations).toBeGreaterThanOrEqual(1);
    expect(insights.distillation.pending + insights.distillation.upToDate).toBeGreaterThanOrEqual(1);
    expect(insights.memory.map((m) => m.ventureName)).toContain(api.h.ventures.quietquad.name);
    const latency = insights.latency.find((l) => l.channel === 'text');
    expect(latency?.turns).toBeGreaterThanOrEqual(2);
    expect(latency?.p50Ms).toEqual(expect.any(Number));
    // Counts only: nobody's words.
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain('Just between us');
  });

  it('refuses founders', async () => {
    const res = await api.request('/admin/insights', { cookie: maya });
    expect(res.status).toBe(403);
    expect(ProblemDetails.parse(await res.json()).code).toBe('forbidden');
  });
});
