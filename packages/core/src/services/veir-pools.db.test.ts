/**
 * vEIR pools, conversations and calls through the core services: the notebook (specific pool), the persona
 * library and lessons (common pool), persona lifecycle and assignment, conversation recents/rename/delete/
 * digest, the vEIR identity and call configuration, and speech of validated replies only.
 */
import {
  ConsentView,
  LessonView,
  PersonaKnowledgeSourceView,
  SessionView,
  TurnStreamEvent,
  type TurnView,
  VeirIdentity,
  VeirNotebook,
} from '@foundry/contracts';
import { auditRepo, knowledgeRepo, p, retrievalRepo, sessionsRepo, usageRepo } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RequestContext } from '../context.js';
import { createCore } from '../core.js';
import { type CoreHarness, createCoreHarness } from '../testing/harness.js';
import { FakeSpeechSynthesizer } from '../testing/fakes.js';

let h: CoreHarness;
const speech = new FakeSpeechSynthesizer();
let maya: RequestContext;
let devin: RequestContext;
let graham: RequestContext;
let lead: RequestContext;
let corin: RequestContext;
let ruth: RequestContext;
let amara: RequestContext;
let priya: RequestContext;

const corinPersona = (): string => h.ventures.quietquad.personaId;
const ruthPersona = (): string => h.ventures.benchtally.personaId;

async function completedTurn(ctx: RequestContext, sessionId: string, text: string): Promise<TurnView> {
  const events: TurnStreamEvent[] = [];
  await h.core.orchestrator.runTurn(ctx, sessionId, { text }, (e) => {
    events.push(TurnStreamEvent.parse(e));
  });
  const last = events.at(-1);
  if (last?.event !== 'turn.completed')
    throw new Error(`expected turn.completed, got ${last?.event ?? 'none'}`);
  return last.turn;
}

async function auditActions(): Promise<string[]> {
  const page = await h.t.db.system((sx) => auditRepo.listAuditEvents(sx, { limit: 200 }));
  return page.items.map((e) => e.action);
}

beforeAll(async () => {
  h = await createCoreHarness({ speech });
  maya = await h.ctxFor(h.people.maya);
  devin = await h.ctxFor(h.people.devin);
  graham = await h.ctxFor(h.people.graham);
  lead = await h.ctxFor(h.people.lead);
  corin = await h.ctxFor(h.people.eirCorin);
  ruth = await h.ctxFor(h.people.eirRuth);
  amara = await h.ctxFor(h.people.amara);
  priya = await h.ctxFor(h.people.priya);
}, 180_000);

afterAll(async () => {
  await h.cleanup();
});

describe('the vEIR notebook', () => {
  it('shows the seeded notes to the team and the assigned EIR, never to advisors', async () => {
    const notebook = VeirNotebook.parse(await h.core.notebook.get(maya, h.ventures.quietquad.id));
    expect(notebook).toMatchObject({ personaName: "Corin's vEIR", version: 1, lastEditedBy: 'veir' });
    expect(notebook.nextOpener).toMatch(/library-staff interviews/);
    expect((await h.core.notebook.get(corin, h.ventures.quietquad.id)).version).toBe(1);
    await expect(h.core.notebook.get(graham, h.ventures.solesignal.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(h.core.notebook.get(amara, h.ventures.quietquad.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('applies founder edits against the version read and refuses stale ones', async () => {
    const before = await h.core.notebook.get(devin, h.ventures.quietquad.id);
    const line = before.founderProfile[0];
    if (!line) throw new Error('no line');
    const edited = await h.core.notebook.update(devin, h.ventures.quietquad.id, {
      expectedVersion: before.version,
      edit: {
        action: 'edit_entry',
        section: 'founderProfile',
        id: line.id,
        text: 'Wants the reasoning first.',
      },
    });
    expect(edited).toMatchObject({ version: before.version + 1, lastEditedBy: 'person' });
    expect(edited.founderProfile[0]?.text).toBe('Wants the reasoning first.');
    await expect(
      h.core.notebook.update(maya, h.ventures.quietquad.id, {
        expectedVersion: before.version,
        edit: { action: 'clear' },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      h.core.notebook.update(corin, h.ventures.quietquad.id, {
        expectedVersion: edited.version,
        edit: { action: 'clear' },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // The corrected line is suppressed for distillation (fingerprint only, never its text).
    const stored = await h.t.db.system((sx) =>
      sx.query('SELECT suppressed::text AS s FROM veir_notebooks WHERE venture_id = :v AND persona_id = :p', {
        v: p.uuid(h.ventures.quietquad.id),
        p: p.uuid(corinPersona()),
      }),
    );
    expect(String(stored.rows[0]?.s)).not.toContain(line.text);
    expect(JSON.parse(String(stored.rows[0]?.s))).toHaveLength(1);
    const cleared = await h.core.notebook.update(maya, h.ventures.quietquad.id, {
      expectedVersion: edited.version,
      edit: { action: 'clear' },
    });
    expect(cleared).toMatchObject({ summary: '', founderProfile: [], commitments: [], nextOpener: null });
    expect(await auditActions()).toContain('notebook.edited');
    expect(h.logger.dump()).not.toContain('Wants the reasoning first');
  });
});

describe('conversations', () => {
  it('lists recents across ventures, renames, deletes digests and deletes conversations', async () => {
    const created = await h.core.sessions.create(maya, h.ventures.quietquad.id, {
      title: 'Pricing the pilot',
    });
    expect(created).toMatchObject({ title: 'Pricing the pilot', personaId: corinPersona(), hasCalls: false });
    const temporary = await h.core.sessions.create(maya, h.ventures.quietquad.id, {
      privacy: 'ephemeral',
      title: 'Never kept',
    });
    expect(temporary.title).toBeNull();
    const page = await h.core.sessions.listMine(maya, { limit: 2 });
    expect(page.items.map((s) => s.id)).toEqual([temporary.id, created.id]);
    expect(page.nextCursor).not.toBeNull();
    const next = await h.core.sessions.listMine(maya, { limit: 2, cursor: page.nextCursor ?? undefined });
    // The seeded past conversation with Corin's vEIR (and its digest).
    expect(next.items.some((s) => s.digest !== null)).toBe(true);
    await expect(h.core.sessions.listMine(maya, { cursor: 'garbage' })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(
      h.core.sessions.listMine(maya, { ventureId: h.ventures.benchtally.id }),
    ).rejects.toMatchObject({ code: 'not_found' });

    const renamed = SessionView.parse(
      await h.core.sessions.rename(devin, created.id, { title: 'Pilot price' }),
    );
    expect(renamed.title).toBe('Pilot price');
    await expect(h.core.sessions.rename(corin, created.id, { title: 'x' })).rejects.toMatchObject({
      code: 'forbidden',
    });

    const past = next.items.find((s) => s.digest !== null);
    if (!past) throw new Error('no seeded digest');
    const undigested = await h.core.sessions.deleteDigest(maya, past.id);
    expect(undigested.digest).toBeNull();

    await h.core.sessions.remove(maya, created.id);
    await expect(h.core.sessions.get(maya, created.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(h.core.sessions.remove(maya, created.id)).rejects.toMatchObject({ code: 'not_found' });
    const actions = await auditActions();
    expect(actions).toEqual(
      expect.arrayContaining(['session.renamed', 'session.digest_deleted', 'session.deleted']),
    );
  });
});

describe('the persona common pool', () => {
  it('curators author notes that are chunked, retrievable, editable and withdrawable', async () => {
    const note = PersonaKnowledgeSourceView.parse(
      await h.core.library.create(corin, corinPersona(), {
        kind: 'faq',
        title: 'FAQ: When should we charge for a pilot?',
        body: '## Short answer\n\nCharge from the first pilot, even a token fee, credited against the contract.',
      }),
    );
    expect(note).toMatchObject({ kind: 'faq', status: 'active', personaId: corinPersona() });
    expect(note.chunkCount).toBeGreaterThan(0);
    expect(note.summary).toMatch(/Charge from the first pilot/);
    // Another EIR, and founders, never curate this persona's library.
    await expect(
      h.core.library.create(ruth, corinPersona(), { kind: 'note', title: 'Ruth note', body: 'x'.repeat(40) }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(h.core.library.list(maya, corinPersona())).rejects.toMatchObject({ code: 'forbidden' });
    // The persona's ventures retrieve it as doctrine evidence; another persona's ventures do not.
    const search = (ctx: RequestContext, personaId: string) =>
      h.t.db.withContext(
        { principalId: ctx.principalId, tenantId: ctx.tenantId, requestId: ctx.requestId },
        (tx) =>
          retrievalRepo.searchSharedChunks(tx, {
            tenantId: ctx.tenantId,
            personaId,
            query: 'token fee credited contract pilot',
            embedding: null,
            limit: 10,
          }),
      );
    expect((await search(maya, corinPersona())).some((i) => i.sourceId === note.id)).toBe(true);
    expect((await search(priya, ruthPersona())).some((i) => i.sourceId === note.id)).toBe(false);

    const updated = await h.core.library.update(lead, corinPersona(), note.id, {
      body: '## Short answer\n\nAlways charge something. A paid pilot attracts serious partners.',
    });
    expect(updated.body).toMatch(/Always charge something/);
    const chunks = await h.t.db.system((sx) => knowledgeRepo.listChunkTexts(sx, note.id));
    expect(chunks.map((c) => c.text).join(' ')).toMatch(/Always charge something/);
    expect(chunks.map((c) => c.text).join(' ')).not.toMatch(/token fee/);

    await h.core.library.remove(corin, corinPersona(), note.id);
    expect((await h.core.library.list(corin, corinPersona())).some((s) => s.id === note.id)).toBe(false);
    expect((await search(maya, corinPersona())).some((i) => i.sourceId === note.id)).toBe(false);
  });

  it('ingests uploaded documents through the worker path', async () => {
    const created = await h.core.library.createUpload(ruth, ruthPersona(), {
      filename: 'pilot-playbook.md',
      contentType: 'text/markdown',
      sizeBytes: 120,
    });
    expect(created.source).toMatchObject({ kind: 'document', status: 'processing', chunkCount: 0 });
    const presigned = h.objectStore.presigned.at(-1);
    expect(presigned?.key).toMatch(
      new RegExp(`^tenants/${h.seed.tenantId}/personas/${ruthPersona()}/sources/`),
    );
    h.objectStore.put(
      presigned?.key ?? '',
      '# Pilot playbook\n\nA pilot needs a budget owner and a written metric.',
    );
    const completed = await h.core.library.completeUpload(ruth, ruthPersona(), created.source.id);
    expect(completed.status).toBe('processing');
    const [job] = h.jobQueue.drain();
    expect(job).toMatchObject({ type: 'ingest_knowledge_source', sourceId: created.source.id });
    const result = await h.core.ingestion.process(job, { requestId: 'test-ingest' });
    expect(result).toMatchObject({ status: 'ready', sourceId: created.source.id });
    const library = await h.core.library.list(ruth, ruthPersona());
    expect(library.find((s) => s.id === created.source.id)).toMatchObject({ status: 'active' });
    expect(library.find((s) => s.id === created.source.id)?.chunkCount).toBeGreaterThan(0);
  });

  it('lessons are drafted, reviewed and published by curators only', async () => {
    const draft = LessonView.parse(
      await h.core.lessons.create(corin, corinPersona(), {
        title: 'Ask for the next rung',
        context: 'Promising discovery conversations.',
        signal: 'The founder reports enthusiasm but no commitment.',
        intervention: 'Ask for exactly one rung higher on the commitment ladder.',
        outcome: 'Real demand separated from politeness within a week.',
        limits: 'Not for regulated purchases.',
      }),
    );
    expect(draft).toMatchObject({ status: 'draft', origin: 'authored', personaId: corinPersona() });
    await expect(h.core.lessons.act(ruth, draft.id, { action: 'publish' })).rejects.toMatchObject({
      code: 'not_found',
    });
    const edited = await h.core.lessons.act(corin, draft.id, {
      action: 'edit',
      title: 'Ask for one rung higher',
    });
    expect(edited.title).toBe('Ask for one rung higher');
    expect((await h.core.lessons.act(lead, draft.id, { action: 'publish' })).status).toBe('published');
    const visible = await h.core.lessons.list(ruth, corinPersona());
    expect(visible.some((l) => l.id === draft.id)).toBe(true);
    expect((await h.core.lessons.act(corin, draft.id, { action: 'withdraw' })).status).toBe('withdrawn');
  });
});

describe('persona lifecycle', () => {
  it('creates an EIR persona, records consent, activates it, assigns it and suspends it on revocation', async () => {
    const profile = (await h.core.eir.listEirProfiles(lead)).find(
      (e) => e.displayName === 'Ruth Abernathy-Song',
    );
    if (!profile) throw new Error('no profile');
    const release = await h.core.eir.getRelease(
      lead,
      (await h.core.eir.getPersona(lead, ruthPersona())).activeRelease?.id ?? '',
    );
    // Ruth already has a persona: a second one is refused.
    await expect(
      h.core.personas.createEirPersona(lead, {
        eirProfileId: profile.id,
        name: 'Ruth second vEIR',
        doctrine: release.doctrine,
        style: release.style,
        disclosureText: release.disclosureText,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      h.core.personas.createEirPersona(corin, {
        eirProfileId: profile.id,
        name: 'Not allowed',
        doctrine: release.doctrine,
        style: release.style,
        disclosureText: release.disclosureText,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // A new synthetic EIR (a principal without an access code, like the seeded ones).
    const { profileId } = await h.t.db.system(async (sx) => {
      const principal = await sx.query(
        `INSERT INTO principals (tenant_id, display_name, synthetic) VALUES (:t, 'Noor Example', true) RETURNING id`,
        { t: p.uuid(h.seed.tenantId) },
      );
      const principalId = String(principal.rows[0]?.id);
      await sx.query(`INSERT INTO role_grants (principal_id, tenant_id, role) VALUES (:p, :t, 'eir')`, {
        p: p.uuid(principalId),
        t: p.uuid(h.seed.tenantId),
      });
      const created = await sx.query(
        `INSERT INTO eir_profiles (tenant_id, principal_id, display_name, synthetic) VALUES (:t, :p, 'Noor Example', true)
         RETURNING id`,
        { t: p.uuid(h.seed.tenantId), p: p.uuid(principalId) },
      );
      return { profileId: String(created.rows[0]?.id) };
    });
    const persona = await h.core.personas.createEirPersona(lead, {
      eirProfileId: profileId,
      name: "Noor's vEIR",
      doctrine: release.doctrine,
      style: release.style,
      disclosureText:
        "You are talking with Noor's vEIR, an AI coach. It is not a person, and no human EIR wrote these.",
    });
    expect(persona).toMatchObject({ kind: 'eir_persona', status: 'draft', hasConsent: false });
    await expect(
      h.core.personas.assignVenture(lead, h.ventures.emberloop.id, {
        personaId: persona.id,
        eirProfileId: null,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    // Approval needs a consent covering doctrine.
    const draftId = persona.releases[0]?.id ?? '';
    await expect(h.core.eir.approveRelease(lead, draftId)).rejects.toMatchObject({ code: 'forbidden' });
    // A voice needs a consent covering voice.
    await expect(
      h.core.personas.updateEmbodiment(lead, persona.id, { voiceId: 'Stephen' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const consent = ConsentView.parse(
      await h.core.personas.recordConsent(lead, persona.id, {
        assetTypes: ['doctrine', 'style', 'voice'],
        evidenceRef: 'Synthetic consent form (test)',
      }),
    );
    expect(consent.assetTypes).toEqual(['doctrine', 'style', 'voice']);
    expect(await h.core.personas.listConsents(lead, persona.id)).toHaveLength(1);
    await expect(
      h.core.personas.updateEmbodiment(lead, persona.id, { voiceId: 'Robot' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      h.core.personas.updateEmbodiment(lead, persona.id, { provider: 'heygen' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(await h.core.personas.updateEmbodiment(lead, persona.id, { voiceId: 'Stephen' })).toMatchObject({
      voiceId: 'Stephen',
      voiceConsented: true,
    });
    await h.core.eir.approveRelease(lead, draftId);
    const row = await h.core.personas.assignVenture(lead, h.ventures.emberloop.id, {
      personaId: persona.id,
      eirProfileId: null,
    });
    expect(row.personaName).toBe("Noor's vEIR");
    const jonah = await h.ctxFor(h.people.jonah);
    const identity = VeirIdentity.parse(await h.core.veir.identity(jonah, h.ventures.emberloop.id));
    expect(identity).toMatchObject({
      shortName: 'Noor',
      kind: 'eir_persona',
      eirDisplayName: 'Noor Example',
    });
    expect(identity.embodiment.voiceId).toBe('Stephen');

    // Revoking the consent suspends the persona: the venture's coach is paused.
    const revoked = await h.core.personas.revokeConsent(lead, consent.id);
    expect(revoked.suspendedPersonaIds).toEqual([persona.id]);
    await expect(h.core.sessions.create(jonah, h.ventures.emberloop.id, {})).rejects.toMatchObject({
      code: 'persona_suspended',
    });
    // Back to Ruth's vEIR.
    await h.core.personas.assignVenture(lead, h.ventures.emberloop.id, {
      personaId: ruthPersona(),
      eirProfileId: null,
    });
    expect((await h.core.veir.identity(jonah, h.ventures.emberloop.id)).name).toBe("Ruth's vEIR");
    expect(await auditActions()).toEqual(
      expect.arrayContaining([
        'persona.created',
        'consent.recorded',
        'consent.revoked',
        'assignment.created',
      ]),
    );
  });
});

describe('calls', () => {
  it('describes the vEIR and the call caps', async () => {
    const identity = VeirIdentity.parse(await h.core.veir.identity(graham, h.ventures.solesignal.id));
    expect(identity).toMatchObject({ name: "Corin's vEIR", shortName: 'Corin', kind: 'eir_persona' });
    expect(identity.embodiment).toMatchObject({
      provider: 'builtin',
      voiceId: 'Matthew',
      voiceConsented: true,
    });
    expect(identity.disclosure).toMatch(/not a person/);
    const config = await h.core.veir.callConfig(maya, h.ventures.quietquad.id);
    expect(config).toMatchObject({
      provider: 'builtin',
      maxMinutes: 30,
      remainingMinutesToday: 60,
      aiEnabled: true,
    });
    await expect(h.core.veir.callConfig(graham, h.ventures.solesignal.id)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(await h.core.veir.avatarSession(maya, { ventureId: h.ventures.quietquad.id })).toEqual({
      provider: 'builtin',
      token: null,
      expiresAt: null,
      voiceId: 'Matthew',
    });
  });

  it('speaks only validated replies of the conversation, metered as speech', async () => {
    const session = await h.core.sessions.create(maya, h.ventures.quietquad.id, {});
    const turn = await completedTurn(maya, session.id, 'What should we test before the pilot?');
    const answer = turn.response?.answer ?? '';
    const passage = answer.replace(/\[E\d+\]/g, '').split(/(?<=[.?!])\s+/)[0] ?? '';
    expect(passage.length).toBeGreaterThan(0);
    const spoken = await h.core.speech.synthesize(maya, {
      sessionId: session.id,
      turnId: turn.id,
      text: passage,
    });
    expect(spoken).toMatchObject({ contentType: 'audio/mpeg', voiceId: 'Matthew', engine: 'generative' });
    expect(new TextDecoder().decode(await new Response(spoken.audio).arrayBuffer())).toMatch(/^MP3:/);
    expect(speech.calls.at(-1)?.engines).toEqual(['generative', 'neural']);
    const usage = await h.t.db.system((sx) =>
      sx.query(`SELECT model_id, input_tokens, cost_usd FROM usage_ledger WHERE purpose = 'speech'`),
    );
    expect(usage.rows).toHaveLength(1);
    expect(usage.rows[0]).toMatchObject({ model_id: 'polly:generative:Matthew' });

    await expect(
      h.core.speech.synthesize(maya, {
        sessionId: session.id,
        turnId: turn.id,
        text: 'You are a genius, invest now.',
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const other = await h.core.sessions.create(maya, h.ventures.quietquad.id, {});
    await expect(
      h.core.speech.synthesize(maya, { sessionId: other.id, turnId: turn.id, text: passage }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      h.core.speech.synthesize(graham, { sessionId: session.id, turnId: turn.id, text: passage }),
    ).rejects.toMatchObject({ code: 'not_found' });
    speech.failNext = true;
    await expect(
      h.core.speech.synthesize(maya, { sessionId: session.id, turnId: turn.id, text: passage }),
    ).rejects.toMatchObject({ code: 'model_unavailable' });
    expect(h.logger.dump()).not.toContain(passage);

    // The daily call-minute cap: an hour of spoken turns earlier today.
    await h.t.db.system(async (sx) => {
      await sx.query(
        `INSERT INTO turns (tenant_id, venture_id, session_id, ordinal, author_id, mode, founder_text, status, channel,
                            created_at)
         SELECT :t, :v, :s, 100 + g, :maya, 'coach', 'spoken', 'completed', 'voice',
                greatest(date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', now() - interval '3 hours')
                  + make_interval(mins => g * 5)
         FROM generate_series(0, 13) AS g`,
        {
          t: p.uuid(h.seed.tenantId),
          v: p.uuid(h.ventures.quietquad.id),
          s: p.uuid(other.id),
          maya: p.uuid(h.people.maya),
        },
      );
    });
    expect((await h.core.veir.callConfig(maya, h.ventures.quietquad.id)).remainingMinutesToday).toBe(0);
    await expect(
      h.core.speech.synthesize(maya, { sessionId: session.id, turnId: turn.id, text: passage }),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(
      h.core.veir.avatarSession(maya, { ventureId: h.ventures.quietquad.id }),
    ).rejects.toMatchObject({
      code: 'rate_limited',
    });
    const otherSession = await h.t.db.system((sx) => sessionsRepo.getSession(sx, other.id));
    expect(otherSession?.hasCalls).toBe(true);
  });

  it('answers speech_unavailable without a synthesizer, and respects the kill switch and spend caps', async () => {
    const devinSession = await h.core.sessions.create(devin, h.ventures.quietquad.id, {});
    const turn = await completedTurn(devin, devinSession.id, 'How do we pick the second library?');
    const passage = (turn.response?.answer ?? '').split(/(?<=[.?!])\s+/)[0] ?? '';
    // A core without a speech port (local development, MODEL_PROVIDER=mock) answers 501.
    const bare = createCore({
      db: h.t.db,
      gateway: h.gateway,
      config: h.config,
      objectStore: h.objectStore,
      jobQueue: h.jobQueue,
      logger: h.logger,
    });
    await expect(
      bare.speech.synthesize(devin, { sessionId: devinSession.id, turnId: turn.id, text: passage }),
    ).rejects.toMatchObject({ code: 'speech_unavailable', status: 501 });
    await h.t.db.system((sx) =>
      sx.query(`UPDATE platform_settings SET value = 'false' WHERE key = 'ai_enabled'`),
    );
    try {
      await expect(
        h.core.speech.synthesize(devin, { sessionId: devinSession.id, turnId: turn.id, text: passage }),
      ).rejects.toMatchObject({ code: 'ai_disabled' });
    } finally {
      await h.t.db.system((sx) =>
        sx.query(`UPDATE platform_settings SET value = 'true' WHERE key = 'ai_enabled'`),
      );
    }
    await h.t.db.system((sx) =>
      usageRepo.recordUsage(sx, {
        tenantId: h.seed.tenantId,
        principalId: h.people.devin,
        purpose: 'turn',
        modelId: 'test',
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 5,
      }),
    );
    await expect(
      h.core.speech.synthesize(devin, { sessionId: devinSession.id, turnId: turn.id, text: passage }),
    ).rejects.toMatchObject({ code: 'spend_cap_reached' });
  });
});
