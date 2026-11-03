import { LearningLogResponse, LearningReflection, StudentProfileResponse } from '@foundry/contracts';
import { p } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiHarness, type ApiHarness } from './testing/api-harness.js';

let api: ApiHarness;
let maya: string;
let devin: string;
let priya: string;
let venture: string;
const data = {
  background: 'Researcher, new to commercialization',
  learningGoal: 'Distinguish user interest from purchase',
  constraints: 'Two hours on Friday; no paid advertising',
  depth: 'concise',
  masteredConcepts: ['Discovery interviewing'],
};
beforeAll(async () => {
  api = await createApiHarness();
  venture = api.h.ventures.quietquad.id;
  maya = await api.signInAs(api.h.people.maya);
  devin = await api.signInAs(api.h.people.devin);
  priya = await api.signInAs(api.h.people.priya);
});
afterAll(async () => {
  await api.cleanup();
});

describe('distinct student and learning models', () => {
  it('requires explicit approval, handles stale versions, and separates teammates', async () => {
    const path = `/ventures/${venture}/student-profile`;
    const initial = await api.request(path, { cookie: maya });
    expect(StudentProfileResponse.parse(await initial.json()).profile).toBeNull();
    const saved = await api.request(path, {
      cookie: maya,
      method: 'PATCH',
      body: { expectedVersion: 0, profile: data },
    });
    expect(saved.status).toBe(200);
    expect(StudentProfileResponse.parse(await saved.json()).profile).toMatchObject({ ...data, version: 1 });
    const stale = await api.request(path, {
      cookie: maya,
      method: 'PATCH',
      body: { expectedVersion: 0, profile: { ...data, depth: 'detailed' } },
    });
    expect(stale.status).toBe(409);
    const other = await api.request(path, { cookie: devin });
    expect(StudentProfileResponse.parse(await other.json()).profile).toBeNull();
    const denied = await api.request(path, { cookie: priya });
    expect([403, 404]).toContain(denied.status);
    const updated = await api.request(path, {
      cookie: maya,
      method: 'PATCH',
      body: { expectedVersion: 1, profile: { ...data, depth: 'detailed' } },
    });
    expect(updated.status).toBe(200);
    expect(StudentProfileResponse.parse(await updated.json()).profile?.version).toBe(2);
  });

  it('enforces person, venture and tenant isolation directly in SQL', async () => {
    const ctx = await api.h.ctxFor(api.h.people.devin);
    const rows = await api.h.t.db.withContext(ctx, (tx) =>
      tx.query('SELECT profile FROM student_profiles WHERE principal_id = :id', {
        id: p.uuid(api.h.people.maya),
      }),
    );
    expect(rows.rows).toHaveLength(0);
    const mine = await api.h.ctxFor(api.h.people.maya);
    const wrongTenant = { ...mine, tenantId: '00000000-0000-4000-8000-000000000001' };
    const cross = await api.h.t.db.withContext(wrongTenant, (tx) =>
      tx.query('SELECT profile FROM student_profiles'),
    );
    expect(cross.rows).toHaveLength(0);
  });

  it('records a student reflection separately from venture memory and refuses another student deleting it', async () => {
    const path = `/ventures/${venture}/learning-log`;
    const reflection = {
      decision: 'Whether to build a second feature',
      evidence: 'One user returned but nobody paid',
      changedThinking: 'A compliment does not prove willingness to pay',
      nextTest: 'Ask the budget owner for a paid commitment',
    };
    const res = await api.request(path, { cookie: maya, body: reflection });
    expect(res.status).toBe(201);
    const item = LearningReflection.parse(await res.json());
    const log = LearningLogResponse.parse(await (await api.request(path, { cookie: maya })).json());
    expect(log.items).toHaveLength(1);
    const others = LearningLogResponse.parse(await (await api.request(path, { cookie: devin })).json());
    expect(others.items).toHaveLength(0);
    expect((await api.request(`${path}/${item.id}`, { cookie: devin, method: 'DELETE' })).status).toBe(404);
    expect((await api.request(`${path}/${item.id}`, { cookie: maya, method: 'DELETE' })).status).toBe(204);
    expect(
      LearningLogResponse.parse(await (await api.request(path, { cookie: maya })).json()).items,
    ).toHaveLength(0);
  });

  it('does not attach another venture’s conversation to a reflection', async () => {
    const ctx = await api.h.ctxFor(api.h.people.priya);
    const session = await api.h.core.sessions.create(ctx, api.h.ventures.benchtally.id, {});
    const res = await api.request(`/ventures/${venture}/learning-log`, {
      cookie: maya,
      body: {
        decision: 'Choose one test',
        evidence: 'A reported observation',
        changedThinking: 'Need a disconfirming result',
        sessionId: session.id,
      },
    });
    expect(res.status).toBe(404);
  });

  it('clears an approved coaching profile and immediately stops returning it', async () => {
    const path = `/ventures/${venture}/student-profile`;
    expect((await api.request(path, { cookie: maya, method: 'DELETE' })).status).toBe(204);
    expect(
      StudentProfileResponse.parse(await (await api.request(path, { cookie: maya })).json()).profile,
    ).toBeNull();
  });
});
