/**
 * The vEIR endpoints over HTTP: the notebook, conversation recents/rename/delete/digest, the vEIR identity and
 * call configuration (calls and speech: calls.db.test.ts), persona lifecycle, the persona knowledge library
 * (authored notes and uploads) and lessons. Every response parses with its contract.
 */
import {
  AvatarSessionResponse,
  CallConfigResponse,
  ConsentListResponse,
  ConsentView,
  CreatePersonaUploadResponse,
  LessonListResponse,
  LessonView,
  NotebookResponse,
  PersonaEmbodiment,
  PersonaKnowledgeListResponse,
  PersonaKnowledgeSourceView,
  PersonaReleaseView,
  PersonaView,
  ProblemDetails,
  ProgramVentureRow,
  RevokeConsentResponse,
  SessionPageResponse,
  SessionView,
  VeirIdentity,
} from '@foundry/contracts';
import { p } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ApiHarness, createApiHarness } from './testing/api-harness.js';

let api: ApiHarness;
let lead: string;
let corin: string;
let ruth: string;
let maya: string;
let devin: string;
let graham: string;

beforeAll(async () => {
  api = await createApiHarness();
  [lead, corin, ruth, maya, devin, graham] = await Promise.all([
    api.signInAs(api.h.people.lead),
    api.signInAs(api.h.people.eirCorin),
    api.signInAs(api.h.people.eirRuth),
    api.signInAs(api.h.people.maya),
    api.signInAs(api.h.people.devin),
    api.signInAs(api.h.people.graham),
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

const quietquad = (): string => api.h.ventures.quietquad.id;
const corinPersona = (): string => api.h.ventures.quietquad.personaId;
const ruthPersona = (): string => api.h.ventures.benchtally.personaId;

describe('notebook', () => {
  it('reads and edits against the version read', async () => {
    const notebook = await json(
      await api.request(`/ventures/${quietquad()}/notebook`, { cookie: maya }),
      NotebookResponse,
    );
    expect(notebook.personaName).toBe("Corin's vEIR");
    const commitment = notebook.commitments[0];
    if (!commitment) throw new Error('no commitment');
    const done = await json(
      await api.request(`/ventures/${quietquad()}/notebook`, {
        method: 'PATCH',
        cookie: devin,
        body: {
          expectedVersion: notebook.version,
          edit: { action: 'edit_commitment', id: commitment.id, status: 'done' },
        },
      }),
      NotebookResponse,
    );
    expect(done.version).toBe(notebook.version + 1);
    expect(
      await problemCode(
        await api.request(`/ventures/${quietquad()}/notebook`, {
          method: 'PATCH',
          cookie: maya,
          body: { expectedVersion: notebook.version, edit: { action: 'clear' } },
        }),
        409,
      ),
    ).toBe('conflict');
    expect(
      await problemCode(
        await api.request(`/ventures/${api.h.ventures.solesignal.id}/notebook`, { cookie: graham }),
        404,
      ),
    ).toBe('not_found');
    expect(
      await problemCode(
        await api.request(`/ventures/${quietquad()}/notebook`, {
          method: 'PATCH',
          cookie: maya,
          body: { expectedVersion: done.version, edit: { action: 'shout' } },
        }),
        422,
      ),
    ).toBe('validation_failed');
  });
});

describe('conversations', () => {
  it('pages recents, renames, deletes digests and deletes conversations', async () => {
    const created = await json(
      await api.request(`/ventures/${quietquad()}/sessions`, {
        body: { title: 'Pilot venue' },
        cookie: maya,
      }),
      SessionView,
      201,
    );
    const first = await json(await api.request('/sessions?limit=1', { cookie: maya }), SessionPageResponse);
    expect(first.items.map((s) => s.id)).toEqual([created.id]);
    expect(first.nextCursor).not.toBeNull();
    const rest = await json(
      await api.request(`/sessions?limit=50&scope=all&cursor=${encodeURIComponent(first.nextCursor ?? '')}`, {
        cookie: maya,
      }),
      SessionPageResponse,
    );
    const past = rest.items.find((s) => s.digest !== null);
    expect(past?.title).toBe('Is exam-week demand strong enough for a pilot?');
    expect(await problemCode(await api.request('/sessions?limit=0', { cookie: maya }), 422)).toBe(
      'validation_failed',
    );

    const renamed = await json(
      await api.request(`/sessions/${created.id}`, {
        method: 'PATCH',
        body: { title: 'Library pilot' },
        cookie: devin,
      }),
      SessionView,
    );
    expect(renamed.title).toBe('Library pilot');
    expect(
      await problemCode(
        await api.request(`/sessions/${created.id}`, { method: 'PATCH', body: {}, cookie: maya }),
        422,
      ),
    ).toBe('validation_failed');
    const undigested = await json(
      await api.request(`/sessions/${past?.id ?? ''}/digest`, { method: 'DELETE', cookie: maya }),
      SessionView,
    );
    expect(undigested.digest).toBeNull();
    expect(
      await problemCode(
        await api.request(`/sessions/${created.id}`, { method: 'DELETE', cookie: corin }),
        403,
      ),
    ).toBe('forbidden');
    const deleted = await api.request(`/sessions/${created.id}`, { method: 'DELETE', cookie: maya });
    expect(deleted.status).toBe(204);
    expect(await problemCode(await api.request(`/sessions/${created.id}`, { cookie: maya }), 404)).toBe(
      'not_found',
    );
  });
});

describe('vEIR identity and call configuration', () => {
  it('describes the vEIR and the call caps', async () => {
    const veir = await json(
      await api.request(`/ventures/${quietquad()}/veir`, { cookie: maya }),
      VeirIdentity,
    );
    expect(veir).toMatchObject({ name: "Corin's vEIR", shortName: 'Corin', kind: 'eir_persona' });
    const config = await json(
      await api.request(`/ventures/${quietquad()}/call-config`, { cookie: maya }),
      CallConfigResponse,
    );
    expect(config).toMatchObject({ maxMinutes: 30, remainingMinutesToday: 60, provider: 'builtin' });
    const session = await json(
      await api.request('/calls/avatar-session', { body: { ventureId: quietquad() }, cookie: maya }),
      AvatarSessionResponse,
    );
    expect(session).toEqual({ provider: 'builtin', token: null, expiresAt: null, voiceId: 'Matthew' });
  });
});

describe('persona lifecycle, knowledge library and lessons', () => {
  it('creates an EIR persona, records and revokes consent, sets its voice and assigns it', async () => {
    const ruthView = await json(
      await api.request(`/personas/${ruthPersona()}`, { cookie: lead }),
      PersonaView,
    );
    const releaseOf = await json(
      await api.request(`/persona-releases/${ruthView.activeRelease?.id ?? ''}`, { cookie: lead }),
      PersonaReleaseView,
    );
    const profileId = await api.h.t.db.system(async (sx) => {
      const principal = await sx.query(
        `INSERT INTO principals (tenant_id, display_name, synthetic) VALUES (:t, 'Ilse Example', true) RETURNING id`,
        { t: p.uuid(api.h.seed.tenantId) },
      );
      const id = String(principal.rows[0]?.id);
      await sx.query(`INSERT INTO role_grants (principal_id, tenant_id, role) VALUES (:p, :t, 'eir')`, {
        p: p.uuid(id),
        t: p.uuid(api.h.seed.tenantId),
      });
      const profile = await sx.query(
        `INSERT INTO eir_profiles (tenant_id, principal_id, display_name) VALUES (:t, :p, 'Ilse Example') RETURNING id`,
        { t: p.uuid(api.h.seed.tenantId), p: p.uuid(id) },
      );
      return String(profile.rows[0]?.id);
    });
    const body = {
      eirProfileId: profileId,
      name: "Ilse's vEIR",
      doctrine: releaseOf.doctrine,
      style: releaseOf.style,
      disclosureText:
        "You are talking with Ilse's vEIR, an AI coach. It is not a person and no human EIR wrote this.",
    };
    expect(await problemCode(await api.request('/personas', { body, cookie: corin }), 403)).toBe('forbidden');
    const persona = await json(await api.request('/personas', { body, cookie: lead }), PersonaView, 201);
    expect(persona).toMatchObject({ status: 'draft', kind: 'eir_persona' });
    const consent = await json(
      await api.request(`/personas/${persona.id}/consents`, {
        body: { assetTypes: ['doctrine', 'style', 'voice'], evidenceRef: 'Synthetic form' },
        cookie: lead,
      }),
      ConsentView,
      201,
    );
    const consents = await json(
      await api.request(`/personas/${persona.id}/consents`, { cookie: lead }),
      ConsentListResponse,
    );
    expect(consents.items.map((c) => c.id)).toEqual([consent.id]);
    const voice = await json(
      await api.request(`/personas/${persona.id}/embodiment`, {
        method: 'PATCH',
        body: { voiceId: 'Joanna' },
        cookie: lead,
      }),
      PersonaEmbodiment,
    );
    expect(voice).toMatchObject({ voiceId: 'Joanna', voiceConsented: true });
    expect(
      (
        await json(
          await api.request(`/personas/${persona.id}/embodiment`, { cookie: ruth }),
          PersonaEmbodiment,
        )
      ).voiceId,
    ).toBe('Joanna');
    await json(
      await api.request(`/persona-releases/${persona.releases[0]?.id ?? ''}/approve`, {
        method: 'POST',
        cookie: lead,
      }),
      PersonaReleaseView,
    );
    const assigned = await json(
      await api.request(`/ventures/${api.h.ventures.emberloop.id}/assignment`, {
        body: { personaId: persona.id, eirProfileId: null },
        cookie: lead,
      }),
      ProgramVentureRow,
    );
    expect(assigned.personaName).toBe("Ilse's vEIR");
    expect(
      await problemCode(
        await api.request(`/ventures/${api.h.ventures.emberloop.id}/assignment`, {
          body: { personaId: persona.id, eirProfileId: null },
          cookie: maya,
        }),
        403,
      ),
    ).toBe('forbidden');
    const revoked = await json(
      await api.request(`/consents/${consent.id}/revoke`, { method: 'POST', cookie: lead }),
      RevokeConsentResponse,
    );
    expect(revoked.suspendedPersonaIds).toEqual([persona.id]);
    await json(
      await api.request(`/ventures/${api.h.ventures.emberloop.id}/assignment`, {
        body: { personaId: ruthPersona(), eirProfileId: null },
        cookie: lead,
      }),
      ProgramVentureRow,
    );
  });

  it('curates the knowledge library: notes, uploads, edits and withdrawals', async () => {
    const note = await json(
      await api.request(`/personas/${corinPersona()}/knowledge`, {
        body: {
          kind: 'case',
          title: 'Case: the survey that sized the wrong problem',
          body: 'A team surveyed 300 students before interviewing anyone and sized a problem nobody had.',
        },
        cookie: corin,
      }),
      PersonaKnowledgeSourceView,
      201,
    );
    expect(note.chunkCount).toBeGreaterThan(0);
    expect(
      await problemCode(
        await api.request(`/personas/${corinPersona()}/knowledge`, {
          body: { kind: 'note', title: 'Not mine', body: 'An EIR writing into another persona library.' },
          cookie: ruth,
        }),
        403,
      ),
    ).toBe('forbidden');
    const edited = await json(
      await api.request(`/personas/${corinPersona()}/knowledge/${note.id}`, {
        method: 'PATCH',
        body: { title: 'Case: a survey before any interview' },
        cookie: lead,
      }),
      PersonaKnowledgeSourceView,
    );
    expect(edited.title).toBe('Case: a survey before any interview');

    const upload = await json(
      await api.request(`/personas/${corinPersona()}/knowledge/uploads`, {
        body: { filename: 'discovery-guide.md', contentType: 'text/markdown', sizeBytes: 64 },
        cookie: corin,
      }),
      CreatePersonaUploadResponse,
      201,
    );
    const key = api.h.objectStore.presigned.at(-1)?.key ?? '';
    api.h.objectStore.put(key, '# Discovery guide\n\nAsk about the last time it happened.');
    const processing = await json(
      await api.request(`/personas/${corinPersona()}/knowledge/${upload.source.id}/complete`, {
        method: 'POST',
        cookie: corin,
      }),
      PersonaKnowledgeSourceView,
      202,
    );
    expect(processing.status).toBe('processing');
    for (const job of api.h.jobQueue.drain())
      await api.h.core.ingestion.process(job, { requestId: 'test-ingest' });
    const library = await json(
      await api.request(`/personas/${corinPersona()}/knowledge`, { cookie: ruth }),
      PersonaKnowledgeListResponse,
    );
    expect(library.items.find((s) => s.id === upload.source.id)).toMatchObject({
      status: 'active',
      kind: 'document',
    });
    const removed = await api.request(`/personas/${corinPersona()}/knowledge/${note.id}`, {
      method: 'DELETE',
      cookie: corin,
    });
    expect(removed.status).toBe(204);
    expect(
      await problemCode(
        await api.request(`/personas/${corinPersona()}/knowledge/${note.id}`, {
          method: 'DELETE',
          cookie: corin,
        }),
        404,
      ),
    ).toBe('not_found');
  });

  it('drafts, publishes and withdraws lessons', async () => {
    const lesson = await json(
      await api.request(`/personas/${ruthPersona()}/lessons`, {
        body: {
          title: 'Name the next irreversible decision',
          context: 'Hardware teams before tooling.',
          signal: 'A tooling order is planned before a pilot.',
          intervention: 'List the irreversible decisions and the evidence each needs.',
          outcome: 'Tooling waited for pilot evidence.',
          limits: 'Software-only ventures rarely face this.',
        },
        cookie: ruth,
      }),
      LessonView,
      201,
    );
    expect(lesson.status).toBe('draft');
    const published = await json(
      await api.request(`/lessons/${lesson.id}/actions`, { body: { action: 'publish' }, cookie: ruth }),
      LessonView,
    );
    expect(published.status).toBe('published');
    const list = await json(
      await api.request(`/personas/${ruthPersona()}/lessons`, { cookie: corin }),
      LessonListResponse,
    );
    expect(list.items.some((l) => l.id === lesson.id)).toBe(true);
    expect(
      await problemCode(
        await api.request(`/lessons/${lesson.id}/actions`, { body: { action: 'withdraw' }, cookie: corin }),
        403,
      ),
    ).toBe('forbidden');
  });
});
