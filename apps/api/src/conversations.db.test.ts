/**
 * Conversations and the notebook over HTTP after the wave-1 fixes: recents across ventures with the right
 * venture and title rules, temporary chats that cannot be renamed, the notebook opener edited and removed
 * against the version read, and team invitations by a platform admin.
 */
import {
  AccessCodeIssued,
  NotebookResponse,
  ProblemDetails,
  SessionPageResponse,
  SessionView,
  TurnStreamEvent,
} from '@foundry/contracts';
import { p, principalsRepo } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ApiHarness, createApiHarness } from './testing/api-harness.js';
import { parseSse } from './testing/sse.js';

let api: ApiHarness;
let maya: string;
let devin: string;
let corin: string;

beforeAll(async () => {
  api = await createApiHarness();
  // Maya also works on BenchTally, so her recents span two ventures.
  await api.h.t.db.system((sx) =>
    sx.query(
      `INSERT INTO venture_memberships (venture_id, principal_id, role) VALUES (:venture, :maya, 'team')`,
      { venture: p.uuid(api.h.ventures.benchtally.id), maya: p.uuid(api.h.people.maya) },
    ),
  );
  [maya, devin, corin] = await Promise.all([
    api.signInAs(api.h.people.maya),
    api.signInAs(api.h.people.devin),
    api.signInAs(api.h.people.eirCorin),
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

async function startConversation(
  cookie: string,
  ventureId: string,
  text: string,
  privacy: 'standard' | 'ephemeral' = 'standard',
): Promise<SessionView> {
  const session = await json(
    await api.request(`/ventures/${ventureId}/sessions`, { body: { privacy }, cookie }),
    SessionView,
    201,
  );
  const res = await api.request(`/sessions/${session.id}/turns`, {
    body: { text },
    cookie,
    idempotencyKey: `turn-${session.id}`,
  });
  const events = parseSse(await res.text()).frames.map((f) => TurnStreamEvent.parse(JSON.parse(f.data)));
  expect(events.at(-1)?.event).toBe('turn.completed');
  return session;
}

describe('GET /sessions', () => {
  it('lists my conversations across ventures, each with its own venture and title rules', async () => {
    const quietquad = api.h.ventures.quietquad.id;
    const benchtally = api.h.ventures.benchtally.id;
    const inQuietQuad = await startConversation(maya, quietquad, 'Which library fills up first?');
    const inBenchTally = await startConversation(maya, benchtally, 'Who signs the purchase order?');
    const temporary = await startConversation(maya, benchtally, 'A private question', 'ephemeral');
    const devins = await startConversation(devin, quietquad, 'What should Devin ask staff?');

    const mine = await json(
      await api.request('/sessions?scope=mine&limit=50', { cookie: maya }),
      SessionPageResponse,
    );
    const byId = new Map(mine.items.map((s) => [s.id, s]));
    expect(byId.get(inQuietQuad.id)).toMatchObject({
      ventureId: quietquad,
      title: 'Which library fills up first?',
      personaName: "Corin's vEIR",
    });
    expect(byId.get(inBenchTally.id)).toMatchObject({
      ventureId: benchtally,
      title: 'Who signs the purchase order?',
      personaName: "Ruth's vEIR",
    });
    expect(byId.get(temporary.id)).toMatchObject({
      ventureId: benchtally,
      title: null,
      privacy: 'ephemeral',
    });
    expect(byId.has(devins.id)).toBe(false);
    // Latest activity first, across ventures.
    const order = mine.items.map((s) => s.id);
    expect(order.indexOf(temporary.id)).toBeLessThan(order.indexOf(inBenchTally.id));
    expect(order.indexOf(inBenchTally.id)).toBeLessThan(order.indexOf(inQuietQuad.id));

    const all = await json(
      await api.request(`/sessions?scope=all&ventureId=${quietquad}&limit=50`, { cookie: maya }),
      SessionPageResponse,
    );
    expect(all.items.every((s) => s.ventureId === quietquad)).toBe(true);
    expect(all.items.find((s) => s.id === devins.id)?.title).toBe('What should Devin ask staff?');

    // The assigned EIR works on no venture as a member: no recents, and no titles anywhere.
    const eir = await json(await api.request('/sessions?scope=all', { cookie: corin }), SessionPageResponse);
    expect(eir.items).toEqual([]);
  });

  it('refuses to rename a temporary chat', async () => {
    const temporary = await startConversation(maya, api.h.ventures.quietquad.id, 'Quick one', 'ephemeral');
    expect(
      await problemCode(
        await api.request(`/sessions/${temporary.id}`, {
          method: 'PATCH',
          body: { title: 'Private' },
          cookie: maya,
        }),
        409,
      ),
    ).toBe('conflict');
  });
});

describe('PATCH /ventures/:id/notebook', () => {
  it('edits and removes the opener against the version read', async () => {
    const path = `/ventures/${api.h.ventures.quietquad.id}/notebook`;
    const notebook = await json(await api.request(path, { cookie: maya }), NotebookResponse);
    expect(notebook.nextOpener).toMatch(/library-staff interviews/);
    const edited = await json(
      await api.request(path, {
        method: 'PATCH',
        cookie: devin,
        body: {
          expectedVersion: notebook.version,
          edit: { action: 'edit_opener', text: 'How did the staff interviews go?' },
        },
      }),
      NotebookResponse,
    );
    expect(edited).toMatchObject({
      nextOpener: 'How did the staff interviews go?',
      version: notebook.version + 1,
      lastEditedBy: 'person',
    });
    expect(
      await problemCode(
        await api.request(path, {
          method: 'PATCH',
          cookie: maya,
          body: { expectedVersion: notebook.version, edit: { action: 'remove_opener' } },
        }),
        409,
      ),
    ).toBe('conflict');
    const removed = await json(
      await api.request(path, {
        method: 'PATCH',
        cookie: maya,
        body: { expectedVersion: edited.version, edit: { action: 'remove_opener' } },
      }),
      NotebookResponse,
    );
    expect(removed).toMatchObject({ nextOpener: null, version: edited.version + 1 });
    expect(
      await problemCode(
        await api.request(path, {
          method: 'PATCH',
          cookie: maya,
          body: { expectedVersion: removed.version, edit: { action: 'edit_opener', text: '' } },
        }),
        422,
      ),
    ).toBe('validation_failed');
    // The assigned EIR reads the notebook but never edits it.
    expect(
      await problemCode(
        await api.request(path, {
          method: 'PATCH',
          cookie: corin,
          body: { expectedVersion: removed.version, edit: { action: 'edit_opener', text: 'Hello' } },
        }),
        403,
      ),
    ).toBe('forbidden');
  });
});

describe('PATCH /ventures/:id/notebook: the opener the vEIR will say', () => {
  it('refuses an opener the vEIR could not say, with the reason at edit.text', async () => {
    const path = `/ventures/${api.h.ventures.quietquad.id}/notebook`;
    const { version } = await json(await api.request(path, { cookie: maya }), NotebookResponse);
    const refused = async (text: string) => {
      const res = await api.request(path, {
        method: 'PATCH',
        cookie: maya,
        body: { expectedVersion: version, edit: { action: 'edit_opener', text } },
      });
      const body = await res.text();
      expect(res.status, body.slice(0, 300)).toBe(422);
      const problem = ProblemDetails.parse(JSON.parse(body));
      expect(problem.code).toBe('validation_failed');
      expect(problem.errors?.[0]?.path).toBe('edit.text');
      return problem.errors?.[0]?.message ?? '';
    };
    // Speaks as, names or claims the EIR's approval: the opener is the vEIR's first bubble and call intro.
    expect(await refused('Corin here. I approve your pilot plan.')).toMatch(/can’t name an EIR/);
    expect(await refused('Corin asked me to check in on your pilot.')).toMatch(/can’t name an EIR/);
    // Names another venture, or its canary.
    expect(await refused('How is BenchTally pricing its pilot?')).toMatch(/another venture/);
    expect(await refused(`Remember ${api.h.ventures.emberloop.canary}?`)).toMatch(/another venture/);
    // Not one plain line.
    expect(await refused('How did it go?\nTell me everything.')).toMatch(/plain text on one line/);
    expect(await refused('How did <b>the interviews</b> go?')).toMatch(/plain text on one line/);
    // Nothing was saved.
    const after = await json(await api.request(path, { cookie: maya }), NotebookResponse);
    expect(after.version).toBe(version);
  });
});

describe('POST /ventures/:id/team/invitations', () => {
  it('accepts a platform admin as well as a program lead', async () => {
    const adminId = await api.h.t.db.system(async (sx) => {
      const created = await principalsRepo.createPrincipal(sx, {
        tenantId: api.h.seed.tenantId,
        displayName: 'Ada Admin',
        synthetic: true,
      });
      await sx.query(
        `INSERT INTO role_grants (principal_id, tenant_id, role) VALUES (:p, NULL, 'platform_admin')`,
        {
          p: p.uuid(created.id),
        },
      );
      return created.id;
    });
    const admin = await api.signInAs(adminId);
    const path = `/ventures/${api.h.ventures.emberloop.id}/team/invitations`;
    const issued = await json(
      await api.request(path, { body: { displayName: 'Noor Example', role: 'team' }, cookie: admin }),
      AccessCodeIssued,
      201,
    );
    expect(issued.principal.displayName).toBe('Noor Example');
    expect(
      await problemCode(
        await api.request(path, { body: { displayName: 'Not Allowed', role: 'team' }, cookie: maya }),
        403,
      ),
    ).toBe('forbidden');
  });
});
