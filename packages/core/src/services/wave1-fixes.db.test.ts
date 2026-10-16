/**
 * Core rules behind the wave-1 fixes: platform admins invite to a venture team and see it like program leads
 * (audited, denials too); temporary chats cannot be renamed; deleting a conversation keeps notebook text a
 * person wrote; a notebook that no longer matches its contract fails loudly (logged with ids only) instead
 * of being shown or saved as empty.
 */
import { AccessCodeIssued, type NotebookEdit, SessionView } from '@foundry/contracts';
import { NotebookIntegrityError, auditRepo, notebooksRepo, p, principalsRepo } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RequestContext } from '../context.js';
import { isDomainError } from '../errors.js';
import { type CoreHarness, createCoreHarness } from '../testing/harness.js';

let h: CoreHarness;
let maya: RequestContext;
let admin: RequestContext;
let lead: RequestContext;

async function auditOf(action: string): Promise<auditRepo.AuditPage['items']> {
  const page = await h.t.db.system((sx) => auditRepo.listAuditEvents(sx, { limit: 200 }));
  return page.items.filter((e) => e.action === action);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

beforeAll(async () => {
  h = await createCoreHarness();
  maya = await h.ctxFor(h.people.maya);
  lead = await h.ctxFor(h.people.lead);
  // A platform admin who is neither a program lead nor a member of any venture.
  const adminId = await h.t.db.system(async (sx) => {
    const created = await principalsRepo.createPrincipal(sx, {
      tenantId: h.seed.tenantId,
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
  admin = await h.ctxFor(adminId);
});
afterAll(async () => {
  await h.cleanup();
});

describe('team invitations', () => {
  it('lets a platform admin invite, with the same audit trail as a program lead', async () => {
    const ventureId = h.ventures.quietquad.id;
    const issued = AccessCodeIssued.parse(
      await h.core.team.invite(admin, ventureId, {
        displayName: 'Noor Example',
        role: 'team',
        expiresInDays: 30,
      }),
    );
    expect(issued.accessCode).toMatch(/^FA-/);
    const team = await h.core.team.list(maya, ventureId);
    expect(team.find((m) => m.principal.id === issued.principal.id)?.role).toBe('team');
    // The admin sees the team they invite to, without reading the venture itself.
    expect((await h.core.team.list(admin, ventureId)).map((m) => m.principal.id)).toEqual(
      team.map((m) => m.principal.id),
    );
    expect(isDomainError(await rejection(h.core.ventures.get(admin, ventureId)))).toBe(true);
    const invited = (await auditOf('team.invited')).find((e) => e.objectId === issued.principal.id);
    expect(invited).toMatchObject({ actorId: admin.principalId, ventureId, outcome: 'succeeded' });
    const code = (await auditOf('access_code.issued')).find((e) => e.objectId === issued.accessCodeId);
    expect(code).toMatchObject({ actorId: admin.principalId, ventureId });

    const byLead = await h.core.team.invite(lead, ventureId, { displayName: 'Lee Example', role: 'advisor' });
    expect(byLead.principal.displayName).toBe('Lee Example');
  });

  it('refuses everyone else (audited) and ventures outside the tenant', async () => {
    const denied = await rejection(
      h.core.team.invite(maya, h.ventures.quietquad.id, { displayName: 'Not Allowed', role: 'team' }),
    );
    expect(isDomainError(denied) && denied.code).toBe('forbidden');
    expect((await auditOf('authz.denied')).some((e) => e.actorId === maya.principalId)).toBe(true);
    const missing = await rejection(
      h.core.team.invite(admin, '6f1c6d0e-1a2b-4c3d-8e4f-0123456789ab', {
        displayName: 'Nobody',
        role: 'team',
      }),
    );
    expect(isDomainError(missing) && missing.code).toBe('not_found');
  });
});

describe('conversations', () => {
  it('cannot rename a temporary chat', async () => {
    const temporary = SessionView.parse(
      await h.core.sessions.create(maya, h.ventures.quietquad.id, { privacy: 'ephemeral', title: 'Ignored' }),
    );
    expect(temporary.title).toBeNull();
    const refused = await rejection(h.core.sessions.rename(maya, temporary.id, { title: 'Private' }));
    expect(isDomainError(refused) && refused.code).toBe('conflict');
  });
});

describe('deleting a conversation', () => {
  it('keeps a summary and opener a person wrote into the notebook', async () => {
    const ventureId = h.ventures.quietquad.id;
    const edit = async (version: number, e: NotebookEdit) =>
      (await h.core.notebook.update(maya, ventureId, { expectedVersion: version, edit: e })).version;
    let version = (await h.core.notebook.get(maya, ventureId)).version;
    version = await edit(version, { action: 'clear' });
    version = await edit(version, { action: 'edit_summary', summary: 'My own words about QuietQuad.' });
    await edit(version, { action: 'edit_opener', text: 'Ask me about the Tuesday library meeting.' });
    // An unrelated conversation that was distilled, which nothing in the notebook cites.
    const unrelated = SessionView.parse(await h.core.sessions.create(maya, ventureId, {}));
    await h.t.db.system((sx) =>
      sx.query('UPDATE coaching_sessions SET distilled_at = now(), distill_version = 1 WHERE id = :id', {
        id: p.uuid(unrelated.id),
      }),
    );
    await h.core.sessions.remove(maya, unrelated.id);
    expect(await h.core.notebook.get(maya, ventureId)).toMatchObject({
      summary: 'My own words about QuietQuad.',
      nextOpener: 'Ask me about the Tuesday library meeting.',
    });
  });
});

describe('notebook integrity', () => {
  it('fails loudly, logged with ids only, instead of showing or saving an unreadable notebook', async () => {
    const venture = h.ventures.emberloop;
    const jonah = await h.ctxFor(h.people.jonah);
    const before = await h.core.notebook.get(jonah, venture.id);
    const secret = 'Prefers to keep the kiln supplier private';
    await h.t.db.system(async (sx) => {
      await sx.query('ALTER TABLE veir_notebooks DROP CONSTRAINT veir_notebooks_content_check');
      await sx.query(
        `UPDATE veir_notebooks SET content = content || jsonb_build_object('founderProfile', :entries)
         WHERE venture_id = :venture`,
        {
          venture: p.uuid(venture.id),
          entries: p.json([{ id: 'fp-1', text: secret, sourceSessionId: 'row-4', createdAt: 'last week' }]),
        },
      );
    });
    try {
      expect(await rejection(h.core.notebook.get(jonah, venture.id))).toBeInstanceOf(NotebookIntegrityError);
      expect(
        await rejection(
          h.core.notebook.update(jonah, venture.id, {
            expectedVersion: before.version,
            edit: { action: 'clear' },
          }),
        ),
      ).toBeInstanceOf(NotebookIntegrityError);
      const logged = h.logger.records.filter((r) => r.event === 'notebook.integrity_failed');
      expect(logged).toHaveLength(2);
      expect(logged[0]?.fields).toMatchObject({ ventureId: venture.id, version: before.version });
      expect(h.logger.dump()).not.toContain(secret);
    } finally {
      await h.t.db.system(async (sx) => {
        await sx.query(
          `UPDATE veir_notebooks SET content = content || '{"founderProfile": []}'::jsonb WHERE venture_id = :venture`,
          { venture: p.uuid(venture.id) },
        );
        await sx.query(
          `ALTER TABLE veir_notebooks ADD CONSTRAINT veir_notebooks_content_check
             CHECK (app.notebook_content_valid(content))`,
        );
      });
    }
    const repaired = await h.t.db.system((sx) =>
      notebooksRepo.getNotebook(sx, { ventureId: venture.id, personaId: venture.personaId }),
    );
    expect(repaired?.intact).toBe(true);
  });
});
