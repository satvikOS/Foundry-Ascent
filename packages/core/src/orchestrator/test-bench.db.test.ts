/**
 * The EIR studio test bench end to end with the mock model: a curator talks to the active release or a draft
 * of their vEIR through the founder pipeline's answer stage, with no venture. Nothing is stored anywhere but the
 * usage ledger (metered once, purpose `test_bench`) and two content-free audit events; only curators may use
 * it; it is admitted like a founder message (limits, caps, kill switch, suspension, consent); crisis messages
 * are always answered; and the checks are shown without revealing which names the cross-venture guard knows.
 */
import {
  CRISIS_SUPPORT_MESSAGE,
  MockModelGateway,
  mockCoachResponse,
  type EmbedOptions,
  type EmbedResult,
  type GenerateStructuredRequest,
  type GenerateStructuredResult,
  type MockGenerateContext,
  type MockModelGatewayOptions,
  type StreamTextRequest,
  type StreamTextResult,
  type TextChunkHandler,
} from '@foundry/ai';
import { TestTurnResponse } from '@foundry/contracts';
import { auditRepo, p, personasRepo, usageRepo } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type CoreConfig } from '../config.js';
import { type RequestContext } from '../context.js';
import { createCore, type Core } from '../core.js';
import { createCoreHarness, type CoreHarness } from '../testing/harness.js';
import { curatorValidator } from './test-turn.js';

let h: CoreHarness;
let corin: RequestContext;
let ruth: RequestContext;
let lead: RequestContext;
let maya: RequestContext;
let owner: RequestContext;
/** Corin's vEIR (QuietQuad's coach) and its active release. */
let personaId: string;
let activeReleaseId: string;

const CRISIS_TEXT = 'I want to end my life, I cannot do this anymore.';
const QUESTION = 'How would you test whether students pay for quiet study seats?';

/** A model that bills every call (the mock's are free), so the ledger shows what was metered. */
class PricedGateway extends MockModelGateway {
  static readonly COST = 0.01;

  override async streamText(request: StreamTextRequest, onText: TextChunkHandler): Promise<StreamTextResult> {
    const result = await super.streamText(request, onText);
    return {
      ...result,
      costUsd: PricedGateway.COST,
      attempts: result.attempts.map((a) => ({ ...a, costUsd: PricedGateway.COST })),
    };
  }

  override async generateStructured<T>(
    request: GenerateStructuredRequest<T>,
  ): Promise<GenerateStructuredResult<T>> {
    const result = await super.generateStructured(request);
    return {
      ...result,
      costUsd: PricedGateway.COST,
      attempts: result.attempts.map((a) => ({ ...a, costUsd: PricedGateway.COST })),
    };
  }

  override async embed(texts: readonly string[], options: EmbedOptions): Promise<EmbedResult> {
    return { ...(await super.embed(texts, options)), costUsd: PricedGateway.COST };
  }
}

/** A core over the harness database with its own model and turn limits. */
function benchCore(
  gateway: MockModelGateway,
  turns: Partial<CoreConfig['turns']> = {},
): { core: Core; gateway: MockModelGateway } {
  const core = createCore({
    db: h.t.db,
    gateway,
    config: { ...h.config, turns: { ...h.config.turns, ...turns } },
    objectStore: h.objectStore,
    jobQueue: h.jobQueue,
    logger: h.logger,
    random: () => 0,
  });
  return { core, gateway };
}

/** The default answer, recording what the model saw. */
function recording(seen: MockGenerateContext[]): NonNullable<MockModelGatewayOptions['streamFixture']> {
  return (context) => {
    seen.push(context);
    return mockCoachResponse(context).answer;
  };
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Row counts of every table (only the ledger and the audit log may change). */
async function tableCounts(): Promise<Record<string, number>> {
  return h.t.db.system(async (sx) => {
    const tables = await sx.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
    );
    const counts: Record<string, number> = {};
    for (const row of tables.rows) {
      const name = String(row.table_name);
      if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unexpected table name ${name}`);
      const r = await sx.query(`SELECT count(*)::int AS n FROM ${name}`);
      counts[name] = Number(r.rows[0]?.n);
    }
    return counts;
  });
}

function changed(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.keys(after)
      .filter((table) => after[table] !== before[table])
      .map((table) => [table, (after[table] ?? 0) - (before[table] ?? 0)]),
  );
}

async function ledger(
  requestId: string,
): Promise<{ purpose: string; principalId: string | null; ventureId: string | null; costUsd: number }[]> {
  const r = await h.t.db.system((sx) =>
    sx.query(
      `SELECT purpose, principal_id, venture_id, cost_usd FROM usage_ledger WHERE request_id = :rid ORDER BY id`,
      { rid: p.text(requestId) },
    ),
  );
  return r.rows.map((row) => ({
    purpose: String(row.purpose),
    principalId: textOrNull(row.principal_id),
    ventureId: textOrNull(row.venture_id),
    costUsd: Number(row.cost_usd),
  }));
}

async function audits(requestId: string): Promise<
  {
    action: string;
    outcome: string;
    objectType: string | null;
    objectId: string | null;
    policyReason: string | null;
    metadata: Record<string, unknown>;
  }[]
> {
  const r = await h.t.db.system((sx) =>
    sx.query(
      `SELECT action, outcome, object_type, object_id, policy_reason, metadata FROM audit_events
        WHERE request_id = :rid ORDER BY id`,
      { rid: p.text(requestId) },
    ),
  );
  return r.rows.map((row) => ({
    action: String(row.action),
    outcome: String(row.outcome),
    objectType: textOrNull(row.object_type),
    objectId: textOrNull(row.object_id),
    policyReason: textOrNull(row.policy_reason),
    metadata: (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) as Record<
      string,
      unknown
    >,
  }));
}

/** A fresh request (its own request id) of the same person. */
async function again(ctx: RequestContext): Promise<RequestContext> {
  return h.ctxFor(ctx.principalId);
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; reason: string | undefined }> {
  try {
    await promise;
  } catch (err) {
    const e = err as { code?: string; reason?: string };
    return { code: String(e.code), reason: e.reason };
  }
  throw new Error('expected a refusal');
}

beforeAll(async () => {
  h = await createCoreHarness({ gatewayOptions: { streamDelayMs: 0 } });
  corin = await h.ctxFor(h.people.eirCorin);
  ruth = await h.ctxFor(h.people.eirRuth);
  lead = await h.ctxFor(h.people.lead);
  maya = await h.ctxFor(h.people.maya);
  owner = await h.ctxFor(h.people.owner);
  personaId = h.ventures.quietquad.personaId;
  const active = await h.t.db.system((sx) => personasRepo.getActiveRelease(sx, personaId));
  if (active === null) throw new Error('Corin’s vEIR has no active release');
  activeReleaseId = active.id;
}, 180_000);

afterAll(async () => {
  await h.cleanup();
});

describe('test bench: what it runs and what it leaves', () => {
  it('answers through the founder pipeline with no venture, stores nothing, and meters each call once', async () => {
    const seen: MockGenerateContext[] = [];
    const { core, gateway } = benchCore(
      new PricedGateway({ streamDelayMs: 0, streamFixture: recording(seen) }),
    );
    const before = await tableCounts();
    const ctx = await again(corin);
    const result = TestTurnResponse.parse(
      await core.testBench.runTestTurn(ctx, personaId, { releaseId: activeReleaseId, text: QUESTION }),
    );
    expect(result).toMatchObject({
      status: 'completed',
      blocked: null,
      release: { id: activeReleaseId, version: 1, status: 'approved' },
    });
    expect(result.response?.answer.length).toBeGreaterThan(20);
    // The common pool only: never venture memory, and nothing of any venture.
    expect(result.evidence.every((e) => e.kind !== 'memory')).toBe(true);
    for (const venture of Object.values(h.ventures)) {
      expect(JSON.stringify(result)).not.toContain(venture.canary);
    }

    // Nothing is stored but the ledger rows and the two audit events.
    expect(changed(before, await tableCounts())).toEqual({ usage_ledger: 3, audit_events: 2 });

    // Every model call of the message, metered once, under test_bench, to the curator, with no venture.
    const calls = gateway.calls.filter((c) => c.requestId === ctx.requestId);
    expect(calls.map((c) => `${c.kind}:${c.purpose}`)).toEqual([
      'embed:test_bench',
      'stream:test_bench',
      'generate:test_bench',
    ]);
    const rows = await ledger(ctx.requestId);
    expect(rows).toEqual(
      calls.map(() => ({
        purpose: 'test_bench',
        principalId: corin.principalId,
        ventureId: null,
        costUsd: PricedGateway.COST,
      })),
    );

    // The prompt: the release's doctrine and the vEIR's own EIR, no venture, no notes about anyone.
    const prompt = seen[0]?.system ?? '';
    expect(prompt).toContain('# Persona doctrine (approved release v1)');
    expect(prompt).toContain('(none: no venture is attached to this conversation.');
    expect(prompt).toContain('Corin Halvorsen');
    for (const venture of Object.values(h.ventures)) expect(prompt).not.toContain(venture.name);
    expect(seen[0]?.messages.map((m) => m.content).join('\n')).not.toContain('<your_notes>');

    // Audited as used and answered, ids and counts only.
    const events = await audits(ctx.requestId);
    expect(events.map((e) => `${e.action}:${e.outcome}`)).toEqual([
      'test_bench.used:succeeded',
      'test_bench.answered:succeeded',
    ]);
    expect(events[0]?.objectId).toBe(events[1]?.objectId);
    expect(events[0]).toMatchObject({
      objectType: 'test_bench_run',
      metadata: { personaId, releaseId: activeReleaseId, releaseVersion: 1, releaseStatus: 'approved' },
    });
    const logged = JSON.stringify(events);
    expect(logged).not.toContain('quiet study seats');
    expect(logged).not.toContain(result.response?.answer.slice(0, 40) ?? '<none>');
  });

  it('tries a draft with the draft’s doctrine, never a withdrawn release or another persona’s', async () => {
    const active = await h.t.db.system((sx) => personasRepo.getRelease(sx, activeReleaseId));
    if (active === null) throw new Error('missing release');
    const draft = await h.core.eir.createRelease(lead, personaId, {
      doctrine: { ...active.doctrine, summary: 'DRAFT-MARKER: price before you build.' },
      style: active.style,
      disclosureText: active.disclosureText,
      allowedModes: ['coach', 'challenge'],
    });
    const seen: MockGenerateContext[] = [];
    const { core } = benchCore(new MockModelGateway({ streamDelayMs: 0, streamFixture: recording(seen) }));
    const result = await core.testBench.runTestTurn(await again(corin), personaId, {
      releaseId: draft.id,
      text: QUESTION,
      history: [
        { text: 'Hi there.', answer: 'Hello. What are you testing this week?' },
        { text: 'Pricing.', answer: null },
      ],
    });
    expect(result.release).toEqual({ id: draft.id, version: draft.version, status: 'draft' });
    expect(seen[0]?.system).toContain(`(approved release v${String(draft.version)})`);
    expect(seen[0]?.system).toContain('DRAFT-MARKER');
    // The client's earlier exchanges are the model's history (only answered ones).
    expect(seen[0]?.historyTurns).toBe(1);
    // The draft's modes apply.
    expect(['coach', 'challenge']).toContain(result.response?.mode);
    expect(
      await refusal(
        core.testBench.runTestTurn(await again(corin), personaId, {
          releaseId: draft.id,
          text: QUESTION,
          mode: 'teach',
        }),
      ),
    ).toEqual({ code: 'forbidden', reason: 'mode_not_allowed' });

    await h.core.eir.withdrawRelease(lead, draft.id);
    expect(
      await refusal(
        core.testBench.runTestTurn(await again(corin), personaId, { releaseId: draft.id, text: QUESTION }),
      ),
    ).toEqual({ code: 'conflict', reason: 'release_not_testable' });
    // Ruth's vEIR's release is not this persona's.
    const ruthsRelease = await h.t.db.system((sx) =>
      personasRepo.getActiveRelease(sx, h.ventures.emberloop.personaId),
    );
    expect(
      await refusal(
        core.testBench.runTestTurn(await again(lead), personaId, {
          releaseId: ruthsRelease?.id ?? '',
          text: QUESTION,
        }),
      ),
    ).toMatchObject({ code: 'not_found' });
  });
});

describe('test bench: who may use it', () => {
  it('admits the persona’s own EIR and program leads; refuses another EIR, founders and admins who curate nothing', async () => {
    const { core, gateway } = benchCore(new MockModelGateway({ streamDelayMs: 0 }));
    const input = { releaseId: activeReleaseId, text: QUESTION };
    for (const who of [corin, lead, owner]) {
      expect((await core.testBench.runTestTurn(await again(who), personaId, input)).status).toBe('completed');
    }
    // A platform admin of the platform, without a program-lead role or a persona of their own.
    const adminId = await h.t.db.system(async (sx) => {
      const created = await sx.query(
        `INSERT INTO principals (tenant_id, display_name, synthetic) VALUES (:t, 'Ada Admin', true) RETURNING id`,
        { t: p.uuid(h.seed.tenantId) },
      );
      const id = String(created.rows[0]?.id);
      await sx.query(
        `INSERT INTO role_grants (principal_id, tenant_id, role) VALUES (:p, NULL, 'platform_admin')`,
        {
          p: p.uuid(id),
        },
      );
      return id;
    });
    const admin = await h.ctxFor(adminId);
    expect(admin.roles).toContain('platform_admin');
    const calls = gateway.calls.length;
    const before = await tableCounts();
    for (const who of [ruth, maya, admin]) {
      const ctx = await again(who);
      expect(await refusal(core.testBench.runTestTurn(ctx, personaId, input))).toEqual({
        code: 'forbidden',
        reason: 'requires_persona_curator',
      });
      // Even a crisis message: the bench is a curator's tool (founders reach support in their own chat).
      expect(
        await refusal(
          core.testBench.runTestTurn(await again(who), personaId, { ...input, text: CRISIS_TEXT }),
        ),
      ).toMatchObject({ code: 'forbidden' });
      expect((await audits(ctx.requestId)).map((e) => `${e.action}:${e.policyReason ?? ''}`)).toEqual([
        'authz.denied:requires_persona_curator',
      ]);
    }
    expect(gateway.calls.length).toBe(calls);
    expect(changed(before, await tableCounts())).toEqual({ audit_events: 6 });
    expect(
      await refusal(
        core.testBench.runTestTurn(await again(lead), '00000000-0000-4000-8000-000000000000', input),
      ),
    ).toMatchObject({ code: 'not_found' });
  });
});

describe('test bench: admission like a founder message', () => {
  it('enforces the per-person message limit and the in-flight limit', async () => {
    const { core, gateway } = benchCore(new MockModelGateway({ streamDelayMs: 0 }), {
      rateLimit: 2,
      rateWindowSeconds: 3600,
    });
    // Ruth curates her own vEIR; earlier messages of other people never count.
    const ruthsPersona = h.ventures.emberloop.personaId;
    const release = await h.t.db.system((sx) => personasRepo.getActiveRelease(sx, ruthsPersona));
    const input = { releaseId: release?.id ?? '', text: QUESTION };
    await core.testBench.runTestTurn(await again(ruth), ruthsPersona, input);
    await core.testBench.runTestTurn(await again(ruth), ruthsPersona, input);
    const calls = gateway.calls.length;
    expect(await refusal(core.testBench.runTestTurn(await again(ruth), ruthsPersona, input))).toEqual({
      code: 'rate_limited',
      reason: 'turn_rate_limit',
    });
    expect(gateway.calls.length).toBe(calls);
    // A crisis message is still answered past the limit, without a model call.
    const crisis = await core.testBench.runTestTurn(await again(ruth), ruthsPersona, {
      ...input,
      text: CRISIS_TEXT,
    });
    expect(crisis.blocked?.reason).toBe('crisis_support');
    expect(gateway.calls.length).toBe(calls);

    // In flight: a message admitted and not answered yet (a request still running) holds the only slot.
    const busy = benchCore(new MockModelGateway({ streamDelayMs: 0 }), { maxInFlight: 1 });
    await h.t.db.withContext(await again(lead), (tx) =>
      auditRepo.appendAudit(tx, {
        action: 'test_bench.used',
        outcome: 'succeeded',
        objectType: 'test_bench_run',
        objectId: '99999999-9999-4999-8999-999999999999',
      }),
    );
    expect(await refusal(busy.core.testBench.runTestTurn(await again(lead), ruthsPersona, input))).toEqual({
      code: 'rate_limited',
      reason: 'turns_in_flight',
    });
    expect(busy.gateway.calls).toEqual([]);
  });

  it('counts its spend against the curator’s own daily cap and the platform’s', async () => {
    const { core, gateway } = benchCore(new PricedGateway({ streamDelayMs: 0 }));
    const settings = await h.core.admin.getSettings(owner);
    const spentBefore = await h.t.db.system((sx) =>
      usageRepo.spendToday(sx, { principalId: corin.principalId }),
    );
    // One message costs three calls (0.03): within the cap once more, past it after the second.
    await h.core.admin.updateSettings(owner, { dailyUsdCapPerPrincipal: spentBefore + 0.05 });
    try {
      const input = { releaseId: activeReleaseId, text: QUESTION };
      await core.testBench.runTestTurn(await again(corin), personaId, input);
      await core.testBench.runTestTurn(await again(corin), personaId, input);
      const spent = await h.t.db.system((sx) => usageRepo.spendToday(sx, { principalId: corin.principalId }));
      expect(spent - spentBefore).toBeCloseTo(0.06, 6);
      const calls = gateway.calls.length;
      const ctx = await again(corin);
      expect(await refusal(core.testBench.runTestTurn(ctx, personaId, input))).toEqual({
        code: 'spend_cap_reached',
        reason: 'principal_daily_cap',
      });
      expect(gateway.calls.length).toBe(calls);
      expect((await audits(ctx.requestId)).map((e) => e.action)).toEqual(['spend_cap.reached']);
      // Another curator is within their own cap; the platform's cap stops everyone.
      expect((await core.testBench.runTestTurn(await again(lead), personaId, input)).status).toBe(
        'completed',
      );
      await h.core.admin.updateSettings(owner, { dailyUsdCapGlobal: 0.01 });
      expect(await refusal(core.testBench.runTestTurn(await again(lead), personaId, input))).toEqual({
        code: 'spend_cap_reached',
        reason: 'global_daily_cap',
      });
      // A crisis message is answered whatever the caps.
      const crisis = await core.testBench.runTestTurn(await again(corin), personaId, {
        ...input,
        text: CRISIS_TEXT,
      });
      expect(crisis.blocked).toEqual({ reason: 'crisis_support', supportMessage: CRISIS_SUPPORT_MESSAGE });
    } finally {
      await h.core.admin.updateSettings(owner, {
        dailyUsdCapPerPrincipal: settings.dailyUsdCapPerPrincipal,
        dailyUsdCapGlobal: settings.dailyUsdCapGlobal,
      });
    }
  });

  it('stops at the AI kill switch and a suspended vEIR, and needs consent; crisis support answers anyway', async () => {
    const { core, gateway } = benchCore(new MockModelGateway({ streamDelayMs: 0 }));
    const input = { releaseId: activeReleaseId, text: QUESTION };
    await h.core.admin.updateSettings(owner, { aiEnabled: false });
    try {
      expect(await refusal(core.testBench.runTestTurn(await again(corin), personaId, input))).toEqual({
        code: 'ai_disabled',
        reason: 'kill_switch',
      });
      const before = await tableCounts();
      const ctx = await again(corin);
      const crisis = TestTurnResponse.parse(
        await core.testBench.runTestTurn(ctx, personaId, { ...input, text: CRISIS_TEXT }),
      );
      expect(crisis).toMatchObject({
        status: 'blocked',
        response: null,
        evidence: [],
        blocked: { reason: 'crisis_support', supportMessage: CRISIS_SUPPORT_MESSAGE },
        validator: { notes: ['crisis_support', 'no_model_call'] },
      });
      // No escalation, no turn, no usage: only the two audit events.
      expect(changed(before, await tableCounts())).toEqual({ audit_events: 2 });
      expect((await audits(ctx.requestId)).map((e) => `${e.action}:${e.policyReason ?? ''}`)).toEqual([
        'test_bench.used:',
        'test_bench.answered:crisis',
      ]);
    } finally {
      await h.core.admin.updateSettings(owner, { aiEnabled: true });
    }

    await h.core.eir.suspendPersona(lead, personaId, { reason: 'Doctrine under review' });
    try {
      expect(await refusal(core.testBench.runTestTurn(await again(corin), personaId, input))).toEqual({
        code: 'persona_suspended',
        reason: 'persona_suspended',
      });
    } finally {
      await h.core.eir.resumePersona(lead, personaId);
    }

    // A new vEIR whose EIR has not consented yet: its draft v1 cannot answer.
    const profileId = await h.t.db.system(async (sx) => {
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
        `INSERT INTO eir_profiles (tenant_id, principal_id, display_name, synthetic)
         VALUES (:t, :p, 'Noor Example', true) RETURNING id`,
        { t: p.uuid(h.seed.tenantId), p: p.uuid(principalId) },
      );
      return String(created.rows[0]?.id);
    });
    const release = await h.t.db.system((sx) => personasRepo.getRelease(sx, activeReleaseId));
    if (release === null) throw new Error('missing release');
    const noor = await h.core.personas.createEirPersona(lead, {
      eirProfileId: profileId,
      name: "Noor's vEIR",
      doctrine: release.doctrine,
      style: release.style,
      disclosureText:
        "You are talking with Noor's vEIR, an AI coach. It is not a person, and no human EIR wrote these.",
    });
    const draftId = noor.releases[0]?.id ?? '';
    expect(
      await refusal(
        core.testBench.runTestTurn(await again(lead), noor.id, { releaseId: draftId, text: QUESTION }),
      ),
    ).toEqual({ code: 'forbidden', reason: 'consent_required' });
    await h.core.personas.recordConsent(lead, noor.id, {
      assetTypes: ['doctrine', 'style'],
      evidenceRef: 'Synthetic consent form (test)',
    });
    const answered = await core.testBench.runTestTurn(await again(lead), noor.id, {
      releaseId: draftId,
      text: QUESTION,
    });
    expect(answered).toMatchObject({ status: 'completed', release: { id: draftId, status: 'draft' } });
    expect(gateway.calls.filter((c) => c.kind === 'stream')).toHaveLength(1);
  });
});

describe('test bench: the checks a curator sees', () => {
  it('blocks a sign-off as the EIR and says it was the identity guard', async () => {
    const { core } = benchCore(
      new MockModelGateway({
        streamDelayMs: 0,
        streamFixture: () => 'Good luck with the interviews this week.\n\nBest,\nCorin',
      }),
    );
    const result = await core.testBench.runTestTurn(await again(corin), personaId, {
      releaseId: activeReleaseId,
      text: QUESTION,
    });
    expect(result).toMatchObject({ status: 'blocked', response: null, blocked: { reason: 'identity' } });
    expect(result.validator.identityViolation).toBe(true);
    expect(result.validator.notes).toContain('stream_gate_blocked');
  });

  it('rewrites an endorsement it claims for the EIR in an answer it keeps, and lists the rewrite', async () => {
    const answer = 'Corin has reviewed your plan. Run the pilot in two libraries first.';
    const { core } = benchCore(
      new MockModelGateway({
        streamDelayMs: 0,
        fixtures: { CoachResponse: (context) => ({ ...mockCoachResponse(context), answer }) },
      }),
    );
    await h.core.admin.updateSettings(owner, { streamingEnabled: false });
    try {
      const result = await core.testBench.runTestTurn(await again(corin), personaId, {
        releaseId: activeReleaseId,
        text: QUESTION,
      });
      expect(result.status).toBe('completed');
      expect(result.validator.identityViolation).toBe(true);
      expect(result.validator.notes).toContain('identity_rewritten:1:endorsement');
      expect(result.response?.answer).not.toContain('Corin has reviewed');
      expect(result.response?.answer).toContain('Run the pilot in two libraries first.');
    } finally {
      await h.core.admin.updateSettings(owner, { streamingEnabled: true });
    }
  });

  it('never reveals which ventures or people the cross-venture guard knows', async () => {
    const venture = h.ventures.emberloop;
    const { core } = benchCore(
      new MockModelGateway({
        streamDelayMs: 0,
        streamFixture: () => `You could compare notes with ${venture.name}, who solved this last term.`,
      }),
    );
    const result = await core.testBench.runTestTurn(await again(corin), personaId, {
      releaseId: activeReleaseId,
      text: `What did ${venture.name} learn about pricing?`,
    });
    expect(result).toMatchObject({ status: 'blocked', response: null, blocked: { reason: 'policy' } });
    expect(result.validator.crossVentureViolation).toBe(false);
    expect(result.validator.riskCategories).not.toContain('cross_venture_request');
    expect(result.validator.notes.filter((n) => n.startsWith('cross_venture'))).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(venture.name);
  });

  it('keeps every other check: risk categories of the message, forced escalations, grounding', () => {
    const shown = curatorValidator({
      unknownEvidenceIdsRemoved: 1,
      factsDowngraded: 2,
      groundingCoverage: 0.5,
      narrowed: true,
      escalationForced: true,
      identityViolation: false,
      crossVentureViolation: true,
      riskCategories: ['legal', 'cross_venture_request'],
      notes: ['facts_downgraded:2', 'escalation_forced:legal', 'cross_venture_blocked', 'narrowed'],
    });
    expect(shown).toEqual({
      unknownEvidenceIdsRemoved: 1,
      factsDowngraded: 2,
      groundingCoverage: 0.5,
      narrowed: true,
      escalationForced: true,
      identityViolation: false,
      crossVentureViolation: false,
      riskCategories: ['legal'],
      notes: ['facts_downgraded:2', 'escalation_forced:legal', 'narrowed'],
    });
  });
});
