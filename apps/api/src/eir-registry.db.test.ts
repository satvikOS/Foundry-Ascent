/**
 * The EIR registry, the lesson queue and evidence sources over HTTP: who may call each route, 422 field errors
 * the studio forms place on their fields, and the contract shapes the web parses.
 */
import {
  DocumentListResponse,
  EirCandidateListResponse,
  EirProfileListResponse,
  EirProfileView,
  LessonListResponse,
  ProblemDetails,
  TurnEvidenceResponse,
} from '@foundry/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ApiHarness, createApiHarness } from './testing/api-harness.js';

let api: ApiHarness;
let owner: string;
let lead: string;
let corin: string;
let maya: string;

beforeAll(async () => {
  api = await createApiHarness();
  owner = await api.ownerToken();
  [lead, corin, maya] = await Promise.all([
    api.signInAs(api.h.people.lead),
    api.signInAs(api.h.people.eirCorin),
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

async function problem(res: Response, status: number): Promise<ProblemDetails> {
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(status);
  return ProblemDetails.parse(JSON.parse(text));
}

/** A person with the EIR role, added in the admin console (the access-code flow then invites them). */
async function invitedEir(displayName: string): Promise<string> {
  const res = await api.request('/admin/principals', {
    body: { displayName, roles: ['eir'] },
    cookie: owner,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { principal: { id: string } }).principal.id;
}

describe('EIR registry', () => {
  it('adds, lists and edits an EIR (program lead or platform admin)', async () => {
    const principalId = await invitedEir('Noor Haddad');
    const candidates = await json(
      await api.request('/eir/candidates', { cookie: lead }),
      EirCandidateListResponse,
    );
    expect(candidates.items.map((c) => c.id)).toContain(principalId);
    expect((await problem(await api.request('/eir/candidates', { cookie: corin }), 403)).code).toBe(
      'forbidden',
    );

    const created = await json(
      await api.request('/eir/profiles', {
        cookie: lead,
        body: {
          principalId,
          displayName: 'Noor Haddad',
          title: 'Climate EIR',
          expertiseTags: ['Climate Tech'],
          bio: 'Founded a grid-storage company.',
        },
      }),
      EirProfileView,
      201,
    );
    expect(created).toMatchObject({
      expertiseTags: ['climate-tech'],
      principal: { id: principalId, displayName: 'Noor Haddad' },
    });
    const listed = await json(await api.request('/eir/profiles', { cookie: corin }), EirProfileListResponse);
    expect(listed.items.find((p) => p.id === created.id)?.bio).toBe('Founded a grid-storage company.');

    const edited = await json(
      await api.request(`/eir/profiles/${created.id}`, {
        method: 'PATCH',
        cookie: owner,
        body: { title: 'Climate and energy EIR' },
      }),
      EirProfileView,
    );
    expect(edited.title).toBe('Climate and energy EIR');
    expect(
      (
        await problem(
          await api.request(`/eir/profiles/${created.id}`, {
            method: 'PATCH',
            cookie: corin,
            body: { title: 'x' },
          }),
          403,
        )
      ).code,
    ).toBe('forbidden');
    expect(
      (
        await problem(
          await api.request('/eir/profiles/00000000-0000-4000-8000-000000000000', {
            method: 'PATCH',
            cookie: lead,
            body: { title: 'x' },
          }),
          404,
        )
      ).code,
    ).toBe('not_found');
  });

  it('answers 422 and 409 with errors at the fields the form shows them on', async () => {
    const invalid = await problem(
      await api.request('/eir/profiles', {
        cookie: lead,
        body: { principalId: 'nobody', displayName: '', expertiseTags: ['x'], bio: 'y'.repeat(2001) },
      }),
      422,
    );
    expect(invalid.code).toBe('validation_failed');
    expect(invalid.errors?.map((e) => e.path).sort()).toEqual([
      'bio',
      'displayName',
      'expertiseTags.0',
      'principalId',
    ]);

    const notAnEir = (
      (await (
        await api.request('/admin/principals', { body: { displayName: 'Plain Person' }, cookie: owner })
      ).json()) as { principal: { id: string } }
    ).principal.id;
    const refused = await problem(
      await api.request('/eir/profiles', {
        cookie: lead,
        body: { principalId: notAnEir, displayName: 'Plain' },
      }),
      422,
    );
    expect(refused.errors).toEqual([
      {
        path: 'principalId',
        message: 'Plain Person doesn’t have the EIR role. A platform admin gives it under People & access.',
      },
    ]);

    const twice = await problem(
      await api.request('/eir/profiles', {
        cookie: lead,
        body: { principalId: api.h.people.eirCorin, displayName: 'Corin Halvorsen' },
      }),
      409,
    );
    expect(twice.errors).toEqual([
      { path: 'principalId', message: 'Corin Halvorsen already has an EIR profile.' },
    ]);
    expect(
      (
        await problem(
          await api.request('/eir/profiles', {
            method: 'PATCH',
            cookie: lead,
            body: { principalId: api.h.people.eirCorin, displayName: 'x' },
          }),
          404,
        )
      ).code,
    ).toBe('not_found');
    expect(
      (
        await problem(
          await api.request('/eir/profiles', {
            cookie: maya,
            body: { principalId: notAnEir, displayName: 'Plain Person' },
          }),
          403,
        )
      ).code,
    ).toBe('forbidden');
  });
});

describe('GET /lessons', () => {
  it('lists the drafts of every vEIR the caller curates, with how many', async () => {
    const created = await api.request(`/personas/${api.h.ventures.quietquad.personaId}/lessons`, {
      cookie: corin,
      body: {
        title: 'Count commitments, not compliments',
        context: 'Early discovery.',
        signal: 'Compliments counted as demand.',
        intervention: 'Ask for a commitment.',
        outcome: 'Signals that hold up.',
        limits: 'Less useful after paid pilots.',
      },
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    for (const cookie of [lead, corin]) {
      const queue = await json(
        await api.request('/lessons?status=draft,in_review', { cookie }),
        LessonListResponse,
      );
      expect(queue.items.map((l) => l.id)).toContain(id);
      expect(queue.items.every((l) => l.status === 'draft' || l.status === 'in_review')).toBe(true);
      expect(queue.total).toBe(queue.items.length);
    }
    const bad = await problem(await api.request('/lessons?status=drafts', { cookie: lead }), 422);
    expect(bad.errors?.map((e) => e.path)).toEqual(['status']);
    expect((await problem(await api.request('/lessons?status=draft', { cookie: maya }), 403)).code).toBe(
      'forbidden',
    );
  });
});

describe('evidence sources', () => {
  it('name the knowledge source of each cited passage, and documents carry theirs', async () => {
    const ventureId = api.h.ventures.quietquad.id;
    const ctx = await api.h.ctxFor(api.h.people.maya);
    const session = await api.h.core.sessions.create(ctx, ventureId, { mode: 'coach' });
    const turn = await api.h.core.orchestrator.runTurn(
      ctx,
      session.id,
      { text: 'Which library should host the pilot during finals week?' },
      () => undefined,
    );
    const evidence = await json(
      await api.request(`/turns/${turn.turnId ?? ''}/evidence`, { cookie: maya }),
      TurnEvidenceResponse,
    );
    const passages = evidence.items.filter((i) => i.kind === 'chunk' && i.source?.scope === 'venture');
    expect(passages.length).toBeGreaterThan(0);
    expect(evidence.items.filter((i) => i.kind === 'memory').every((i) => i.source === null)).toBe(true);
    const documents = await json(
      await api.request(`/ventures/${ventureId}/documents`, { cookie: maya }),
      DocumentListResponse,
    );
    const sources = new Set(documents.items.map((d) => d.sourceId));
    for (const passage of passages) expect(sources.has(passage.source?.id ?? null)).toBe(true);
  });
});
