/**
 * Founders meet Thomas everywhere (ADR-0021, amendment of 2026-11-24): the owner's coach release
 * (packages/db/src/seed/coach-releases.ts) on a running app. BenchTally's founder had a conversation, a chat still open
 * and a live call with Ruth's vEIR; after the deploy applies the release she meets Thomas in every text the server
 * writes for her, the conversations already open are refused as after any reassignment (crisis support still answers,
 * nothing reaches a model), and new ventures are Thomas's too.
 */
import { SessionView, StartCallResponse, TurnStreamEvent, VeirIdentity } from '@foundry/contracts';
import {
  accessCodePrefix,
  assignmentsRepo,
  auditRepo,
  generateAccessCode,
  hashAccessCode,
  notebooksRepo,
  p,
  parseOwnerReleases,
  personasRepo,
  seedDatabase,
  type SeedConfig,
  type SeedResult,
} from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RequestContext } from '../context.js';
import { createCoreHarness, type CoreHarness } from '../testing/harness.js';
import { type RunTurnOutcome } from '../orchestrator/run-turn.js';

/** What no founder of these ventures reads any more. */
const OLD_COACH = /vEIR|\btwins?\b|Ruth['’]s|\bRuth\b/i;

let h: CoreHarness;
let priya: RequestContext;
let ruth: RequestContext;
let corin: RequestContext;
let lead: RequestContext;
let benchtally: string;
let openChat: string;
let callChat: string;
let callId: string;
let config: SeedConfig;

const deploy = (): Promise<SeedResult> => seedDatabase(h.t.db, config);

async function turn(
  ctx: RequestContext,
  sessionId: string,
  text: string,
): Promise<{ readonly events: TurnStreamEvent[]; readonly outcome: RunTurnOutcome }> {
  const events: TurnStreamEvent[] = [];
  const outcome = await h.core.orchestrator.runTurn(ctx, sessionId, { text }, (e) => {
    events.push(TurnStreamEvent.parse(e));
  });
  return { events, outcome };
}

const rejection = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => null,
    (err: unknown) => err,
  );

beforeAll(async () => {
  h = await createCoreHarness({ random: () => 0.99 });
  priya = await h.ctxFor(h.people.priya);
  ruth = await h.ctxFor(h.people.eirRuth);
  corin = await h.ctxFor(h.people.eirCorin);
  lead = await h.ctxFor(h.people.lead);
  benchtally = h.ventures.benchtally.id;
  const code = generateAccessCode();
  config = {
    homeTenant: { slug: 'ain', name: 'Ain Foundry (test)' },
    owner: {
      displayName: 'Test Owner',
      accessCodePrefix: accessCodePrefix(code),
      accessCodeHash: await hashAccessCode(code),
    },
    ownerReleases: parseOwnerReleases('thomas-2026-11-05,thomas-everywhere-2026-11-24'),
  };

  // Before: Ruth's vEIR coaches Priya, and its notes open the next conversation.
  const chat = SessionView.parse(await h.core.sessions.create(priya, benchtally, {}));
  expect(chat.personaName).toBe("Ruth's vEIR");
  openChat = chat.id;
  expect((await turn(priya, openChat, 'Two labs pay $40 a month. What is next?')).outcome.status).toBe(
    'completed',
  );
  await h.t.db.system(async (sx) => {
    const key = { ventureId: benchtally, personaId: h.ventures.benchtally.personaId };
    const current = await notebooksRepo.getNotebook(sx, key);
    await notebooksRepo.saveNotebook(sx, {
      tenantId: h.seed.tenantId,
      ...key,
      expectedVersion: current?.version ?? 0,
      content: {
        ...notebooksRepo.EMPTY_NOTEBOOK,
        summary: "Ruth's vEIR and Priya agreed to ask both paying labs to renew.",
        commitments: [
          {
            id: 'c-renew',
            text: 'Ask both paying labs to renew',
            due: '2026-12-01',
            status: 'open',
            sourceSessionId: openChat,
            createdAt: '2026-11-20T10:00:00.000Z',
          },
        ],
        nextOpener: 'Good to see you again. Want help writing the renewal note to both paying labs?',
        nextTopic: 'the renewal note',
      },
      suppressed: [],
      editedBy: 'veir',
      sourceSessionId: openChat,
    });
  });
  callChat = SessionView.parse(await h.core.sessions.create(priya, benchtally, { openerShownAt: null })).id;
  callId = StartCallResponse.parse(await h.core.calls.start(priya, callChat, {})).call.id;

  const result = await deploy();
  expect(result.coachReleases).toMatchObject([{ outcome: 'applied', ventures: 2, notebooks: 1 }]);
}, 180_000);

afterAll(async () => {
  await h.cleanup();
});

describe('a conversation already open when its venture moved', () => {
  it('is refused at its next message, as after any reassignment: no model call, nothing stored', async () => {
    const calls = h.gateway.calls.length;
    const { events, outcome } = await turn(priya, openChat, 'And what should I charge?');
    expect(outcome).toMatchObject({ status: 'rejected' });
    expect(events.at(-1)).toMatchObject({ event: 'turn.error', code: 'assignment_inactive' });
    expect(JSON.stringify(events)).not.toMatch(OLD_COACH);
    expect(h.gateway.calls.length).toBe(calls);
    const detail = await h.core.sessions.get(priya, openChat);
    expect(detail.turns).toHaveLength(1);
    const page = await h.t.db.system((sx) => auditRepo.listAuditEvents(sx, { limit: 50 }));
    expect(page.items.find((e) => e.action === 'turn.rejected')).toMatchObject({
      objectId: openChat,
      policyReason: 'assignment_changed',
    });
  });

  it('still answers a crisis message with human support', async () => {
    const { events, outcome } = await turn(priya, openChat, 'I want to kill myself tonight.');
    expect(outcome.status).toBe('blocked');
    expect(events.at(-1)).toMatchObject({ event: 'turn.blocked', reason: 'crisis_support' });
  });

  it('ends a live call, and refuses a new one in it', async () => {
    const beat = await h.core.calls.heartbeat(priya, callId, { state: 'idle', micOpenSeconds: 0 });
    expect(beat).toMatchObject({ action: 'terminate', reason: 'disabled' });
    expect(await rejection(h.core.calls.start(priya, callChat, {}))).toMatchObject({
      code: 'assignment_inactive',
      reason: 'assignment_changed',
    });
  });
});

describe('what the founder meets now', () => {
  it('is Thomas in every text the server writes: identity, welcome, opener, conversation, reply and call', async () => {
    const identity = VeirIdentity.parse(await h.core.veir.identity(priya, benchtally));
    expect(identity).toMatchObject({ name: 'Thomas', shortName: 'Thomas', presentation: 'mentor' });
    const venture = await h.core.ventures.get(priya, benchtally);
    expect(venture.persona).toMatchObject({ name: 'Thomas', presentation: 'mentor' });
    const overview = await h.core.ventures.overview(priya, benchtally);
    expect(overview.venture.persona).toEqual(venture.persona);

    // The welcome: Thomas is not introduced yet, and reading it introduces him.
    const key = `${identity.personaId}:mentor`;
    expect((await h.core.me.get(priya)).veirWelcomeIntroductions).not.toContain(key);
    const read = await h.core.me.acknowledgeVeirWelcome(priya, { personaId: identity.personaId });
    expect(read.introductions).toContain(key);

    // The opener comes from the notes carried over: where she left off, without a reunion with someone she never met.
    const opener = 'Want help writing the renewal note to both paying labs?';
    const preview = await h.core.sessions.previewOpener(priya, benchtally);
    expect(preview.opener).toBe(opener);
    const notebook = await h.core.notebook.get(priya, benchtally);
    expect(notebook.personaName).toBe('Thomas');
    expect(notebook.summary).toBe('The coach and Priya agreed to ask both paying labs to renew.');

    const session = SessionView.parse(await h.core.sessions.create(priya, benchtally, {}));
    expect(session).toMatchObject({ personaName: 'Thomas', personaPresentation: 'mentor', opener });
    const started = StartCallResponse.parse(await h.core.calls.start(priya, session.id, {}));
    expect(started.intro?.text).toBe(`Hi Priya, ${opener.charAt(0).toLowerCase()}${opener.slice(1)}`);
    await h.core.calls.end(priya, started.call.id, { reason: 'user' });
    const { events, outcome } = await turn(priya, session.id, 'Yes, draft it. Are you a bot?');
    expect(outcome.status).toBe('completed');

    expect(
      JSON.stringify([
        identity,
        venture.persona,
        overview.venture.persona,
        preview,
        notebook,
        session,
        started.intro,
        events,
      ]),
    ).not.toMatch(OLD_COACH);
  });

  it('introduces Thomas by his own name on a first call, in a venture nobody talked in before', async () => {
    const founder = await h.ctxFor(h.people.ines);
    const session = SessionView.parse(await h.core.sessions.create(founder, h.ventures.emberloop.id, {}));
    const started = StartCallResponse.parse(await h.core.calls.start(founder, session.id, {}));
    expect(started.intro?.text).toMatch(/^Hi Ines, I'm Thomas\. /);
    expect(JSON.stringify([session, started.intro])).not.toMatch(OLD_COACH);
    await h.core.calls.end(founder, started.call.id, { reason: 'user' });
  });
});

describe('who can see the work', () => {
  it('is who a program lead’s reassignment would give: Corin, whose persona Thomas is, and no longer Ruth', async () => {
    expect(await rejection(h.core.ventures.get(ruth, benchtally))).toMatchObject({ code: 'not_found' });
    const seen = await h.core.ventures.get(corin, benchtally);
    expect(seen.assignedEir?.displayName).toBe('Corin Halvorsen');
    // The same venture moved by a program lead in the product ends in the same assignment, reviewer included.
    const released = await h.t.db.system((sx) => assignmentsRepo.resolveActiveAssignment(sx, benchtally));
    await h.core.personas.assignVenture(lead, benchtally, {
      personaId: h.ventures.benchtally.personaId,
      eirProfileId: null,
    });
    await h.core.personas.assignVenture(lead, benchtally, {
      personaId: released?.persona.id ?? '',
      eirProfileId: null,
    });
    const byLead = await h.t.db.system((sx) => assignmentsRepo.resolveActiveAssignment(sx, benchtally));
    const shape = (a: typeof released) =>
      a && {
        personaId: a.assignment.personaId,
        eirProfileId: a.assignment.eirProfileId,
        allowedModes: a.assignment.allowedModes,
        dataClassCeiling: a.assignment.dataClassCeiling,
        expiresAt: a.assignment.expiresAt,
      };
    expect(shape(byLead)).toEqual(shape(released));
    // And a redeploy leaves the program lead's assignment as it is.
    expect((await deploy()).coachReleases.map((r) => r.outcome)).toEqual(['present']);
    const after = await h.t.db.system((sx) => assignmentsRepo.resolveActiveAssignment(sx, benchtally));
    expect(after?.assignment.id).toBe(byLead?.assignment.id);
  });
});

describe('a new venture', () => {
  it('is coached by the mentor, with the EIR its persona is built from as its reviewer', async () => {
    const row = await h.core.program.createVenture(lead, { name: 'Fresh Harbour' });
    expect(row).toMatchObject({ name: 'Fresh Harbour', personaName: 'Thomas' });
    const active = await h.t.db.system((sx) => assignmentsRepo.resolveActiveAssignment(sx, row.id));
    expect(active?.eir?.displayName).toBe('Corin Halvorsen');
    const created = await h.t.db.system(async (sx) =>
      sx.query(
        `SELECT metadata::text AS metadata FROM audit_events
          WHERE action = 'venture.created' AND object_id = :id`,
        { id: p.text(row.id) },
      ),
    );
    expect(JSON.parse(String(created.rows[0]?.metadata))).toEqual({
      assignmentId: active?.assignment.id,
      personaId: active?.persona.id,
      eirProfileId: active?.assignment.eirProfileId,
      stage: 'idea',
    });
  });

  it('is coached by the neutral guide, with no reviewer, while the mentor is suspended', async () => {
    const thomas = (await h.core.veir.identity(priya, benchtally)).personaId;
    await h.t.db.system((sx) =>
      personasRepo.setPersonaStatus(sx, { personaId: thomas, status: 'suspended', reason: 'test' }),
    );
    const row = await h.core.program.createVenture(lead, { name: 'Copper Field' });
    expect(row.personaName).toBe('Foundry Guide');
    const active = await h.t.db.system((sx) => assignmentsRepo.resolveActiveAssignment(sx, row.id));
    expect(active?.assignment.eirProfileId).toBeNull();
    await h.t.db.system((sx) => personasRepo.setPersonaStatus(sx, { personaId: thomas, status: 'active' }));
  });
});
