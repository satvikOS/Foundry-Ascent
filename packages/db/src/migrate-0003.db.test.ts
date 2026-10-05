/**
 * Migration 0003 (security hardening) on top of the 0001 + 0002 state production already has: it applies
 * cleanly over existing data (including data written before its rules existed), remediates that data, and
 * re-running it — through the runner or statement by statement — changes nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Db } from './db.js';
import { MIGRATIONS, migrate } from './migrate.js';
import { p } from './params.js';
import {
  assignmentsRepo,
  escalationsRepo,
  memoryRepo,
  sessionsRepo,
  turnsRepo,
} from './repositories/index.js';
import { seedDatabase, type SeedResult } from './seed/seed.js';
import { splitStatements } from './sql-lexer.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

const BASE = MIGRATIONS.filter((m) => m.version === '0001_init' || m.version === '0002_rls_helpers');
const HARDENING = MIGRATIONS.find((m) => m.version === '0003_security_hardening');
const PRIVATE_TITLE = 'LEGACY-PRIVATE runway';

let t: TestDatabase;
let seed: SeedResult;

interface Legacy {
  readonly ventureId: string;
  readonly privateMemory: string;
  readonly teamMemory: string;
  readonly teamTitle: string;
  readonly standardTurn: string;
  readonly ephemeralTurn: string;
  readonly session: string;
  readonly candidate: string;
  readonly escalation: string;
  readonly duplicateVenture: string;
}
let legacy: Legacy;

function principal(key: string): string {
  const id = seed.principals[key];
  if (!id) throw new Error(`no principal ${key}`);
  return id;
}

/** Data as it could exist in production before 0003: private items cited as evidence, sampled ephemeral turns. */
async function writeLegacyData(db: Db): Promise<Legacy> {
  const venture = seed.ventures.find((v) => v.key === 'quietquad');
  if (!venture) throw new Error('no quietquad');
  const maya = principal('maya');
  return db.system(async (sx) => {
    const resolved = await assignmentsRepo.resolveActiveAssignment(sx, venture.id);
    if (!resolved?.release) throw new Error('no assignment');
    const privateMemory = await memoryRepo.createMemory(sx, {
      tenantId: seed.tenantId,
      ventureId: venture.id,
      type: 'fact',
      title: PRIVATE_TITLE,
      content: 'I can self-fund two more months.',
      status: 'confirmed',
      visibility: 'founder_private',
      origin: 'founder',
      createdBy: maya,
    });
    const [team] = await memoryRepo.listMemory(sx, {
      ventureId: venture.id,
      statuses: ['confirmed'],
      limit: 1,
    });
    if (!team || team.visibility === 'founder_private') throw new Error('no shared memory');
    const session = async (privacy: 'standard' | 'ephemeral') =>
      sessionsRepo.createSession(sx, {
        tenantId: seed.tenantId,
        ventureId: venture.id,
        assignmentId: resolved.assignment.id,
        personaReleaseId: resolved.release?.id ?? '',
        startedBy: maya,
        mode: 'coach',
        privacy,
        goal: null,
        policyVersion: 'legacy',
      });
    const turn = async (sessionId: string) => {
      const created = await turnsRepo.createTurn(sx, {
        tenantId: seed.tenantId,
        ventureId: venture.id,
        sessionId,
        authorId: maya,
        mode: 'coach',
        founderText: 'How long is my runway?',
      });
      await turnsRepo.finishTurn(sx, {
        turnId: created.id,
        status: 'completed',
        modelId: 'mock',
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        latencyMs: 1,
        sampledForReview: true,
      });
      return created.id;
    };
    const standard = await session('standard');
    const ephemeral = await session('ephemeral');
    const standardTurn = await turn(standard.id);
    const ephemeralTurn = await turn(ephemeral.id);
    await turnsRepo.insertTurnEvidence(sx, standardTurn, [
      {
        key: 'E1',
        kind: 'memory',
        refId: privateMemory.id,
        score: 0.9,
        title: PRIVATE_TITLE,
        ventureId: venture.id,
      },
      { key: 'E2', kind: 'memory', refId: team.id, score: 0.8, title: team.title, ventureId: venture.id },
    ]);
    await sx.query(
      `UPDATE coaching_sessions SET recap = :recap, status = 'ended', ended_at = now() WHERE id = :id`,
      {
        id: p.uuid(standard.id),
        recap: p.json({ summary: 'x', evidence: [{ title: PRIVATE_TITLE }, { title: team.title }] }),
      },
    );
    const candidate = await memoryRepo.createMemory(sx, {
      tenantId: seed.tenantId,
      ventureId: venture.id,
      type: 'insight',
      title: 'Runway is short',
      content: 'Derived from the runway turn.',
      visibility: 'team',
      origin: 'ai',
      createdBy: maya,
      sourceRefs: [{ kind: 'turn', id: standardTurn }],
    });
    const escalation = await escalationsRepo.createEscalation(sx, {
      tenantId: seed.tenantId,
      ventureId: venture.id,
      sessionId: standard.id,
      turnId: standardTurn,
      category: 'other',
      priority: 'P3',
      createdBy: maya,
      packet: {
        founderQuestion: 'Q',
        desiredDecision: null,
        sharedFacts: [
          { memoryId: privateMemory.id, text: PRIVATE_TITLE },
          { memoryId: team.id, text: team.title },
        ],
        evidenceConsidered: [],
        conflictingSignals: [],
        unknowns: [],
        reason: 'legacy',
        urgency: 'low',
        proposedNextStep: null,
        sessionSummary: null,
        aiGenerated: true,
      },
    });
    // A duplicate venture name (case and spacing differ) that predates the uniqueness rule.
    const dup = await sx.query(
      `INSERT INTO ventures (tenant_id, name) VALUES (:tenant, :name) RETURNING id`,
      { tenant: p.uuid(seed.tenantId), name: p.text(`  ${venture.name.toUpperCase()} `) },
    );
    return {
      ventureId: venture.id,
      privateMemory: privateMemory.id,
      teamMemory: team.id,
      teamTitle: team.title,
      standardTurn,
      ephemeralTurn,
      session: standard.id,
      candidate: candidate.id,
      escalation: escalation.id,
      duplicateVenture: String(dup.rows[0]?.id),
    };
  });
}

/** Policies, functions and triggers 0003 owns, as text: equal before and after a re-run. */
async function schemaFingerprint(db: Db): Promise<string> {
  return db.system(async (sx) => {
    const policies = await sx.query(
      `SELECT tablename, policyname, cmd, coalesce(qual, '') AS qual, coalesce(with_check, '') AS with_check
         FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname`,
    );
    const functions = await sx.query(
      `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, md5(p.prosrc) AS src,
              coalesce(array_to_string(p.proacl, ','), '') AS acl
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app' ORDER BY 1, 2`,
    );
    const triggers = await sx.query(
      `SELECT tgname, tgrelid::regclass::text AS rel FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2`,
    );
    const settings = await sx.query(`SELECT key, value::text AS value FROM platform_settings ORDER BY key`);
    return JSON.stringify([policies.rows, functions.rows, triggers.rows, settings.rows]);
  });
}

beforeAll(async () => {
  t = await createTestDatabase({ migrate: false });
  const base = await migrate(t.db, { migrations: BASE });
  expect(base.applied).toEqual(['0001_init', '0002_rls_helpers']);
  seed = await seedDatabase(t.db, { homeTenant: { slug: 'ain', name: 'Ain Foundry (test)' }, owner: null });
  legacy = await writeLegacyData(t.db);
});
afterAll(async () => {
  await t.cleanup();
});

describe('migration 0003_security_hardening', () => {
  it('is bundled after 0001 and 0002, which it never changes', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual([
      '0001_init',
      '0002_rls_helpers',
      '0003_security_hardening',
    ]);
    expect(HARDENING).toBeDefined();
  });

  it('applies cleanly on top of 0001 and 0002 with existing data, as the non-superuser owner', async () => {
    const report = await migrate(t.db);
    expect(report.applied).toEqual(['0003_security_hardening']);
    expect(report.alreadyApplied).toEqual(['0001_init', '0002_rls_helpers']);
    const role = await t.db.system((sx) =>
      sx.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user'),
    );
    expect(role.rows[0]).toMatchObject({ rolsuper: false });
  });

  it('removes founder_private items from everything other people read', async () => {
    const state = await t.db.system(async (sx) => {
      const evidence = await sx.query(
        'SELECT ref_id FROM turn_evidence WHERE turn_id = :turn ORDER BY evidence_key',
        { turn: p.uuid(legacy.standardTurn) },
      );
      const turns = await sx.query('SELECT id, sampled_for_review FROM turns WHERE id IN (:a, :b)', {
        a: p.uuid(legacy.standardTurn),
        b: p.uuid(legacy.ephemeralTurn),
      });
      const candidate = await sx.query('SELECT visibility FROM memory_objects WHERE id = :id', {
        id: p.uuid(legacy.candidate),
      });
      const recap = await sx.query(
        `SELECT recap -> 'evidence' AS evidence FROM coaching_sessions WHERE id = :id`,
        {
          id: p.uuid(legacy.session),
        },
      );
      const packet = await sx.query(
        `SELECT packet -> 'sharedFacts' AS facts FROM escalations WHERE id = :id`,
        {
          id: p.uuid(legacy.escalation),
        },
      );
      return { evidence, turns, candidate, recap, packet };
    });
    expect(state.evidence.rows.map((r) => r.ref_id)).toEqual([legacy.teamMemory]);
    expect(state.turns.rows.every((r) => r.sampled_for_review === false)).toBe(true);
    expect(state.candidate.rows[0]?.visibility).toBe('founder_private');
    // jsonb comes back as text (both drivers).
    expect(JSON.parse(String(state.recap.rows[0]?.evidence))).toEqual([{ title: legacy.teamTitle }]);
    expect(JSON.parse(String(state.packet.rows[0]?.facts))).toEqual([
      { memoryId: legacy.teamMemory, text: legacy.teamTitle },
    ]);
    // The private item itself is untouched (its owner still sees it).
    const own = await t.db.system((sx) => memoryRepo.getMemory(sx, legacy.privateMemory));
    expect(own).toMatchObject({ visibility: 'founder_private', status: 'confirmed' });
  });

  it('keeps venture names that were duplicated before the rule, and enforces it for new or changed names', async () => {
    const dup = await t.db.system((sx) =>
      sx.query('SELECT name FROM ventures WHERE id = :id', { id: p.uuid(legacy.duplicateVenture) }),
    );
    expect(dup.rows).toHaveLength(1);
    // Re-saving the same name (only case or spacing changes) is allowed; taking another venture's name is not.
    await t.db.system((sx) =>
      sx.query('UPDATE ventures SET name = upper(name) WHERE id = :id', {
        id: p.uuid(legacy.duplicateVenture),
      }),
    );
    await expect(
      t.db.system((sx) =>
        sx.query(`INSERT INTO ventures (tenant_id, name) VALUES (:tenant, 'quietquad')`, {
          tenant: p.uuid(seed.tenantId),
        }),
      ),
    ).rejects.toMatchObject({ sqlState: '23505' });
  });

  it('seeds the upload quota defaults', async () => {
    const rows = await t.db.system((sx) =>
      sx.query(
        `SELECT key, value::text AS value FROM platform_settings
          WHERE key IN ('daily_upload_documents_per_principal', 'daily_upload_bytes_per_principal') ORDER BY key`,
      ),
    );
    expect(rows.rows).toEqual([
      { key: 'daily_upload_bytes_per_principal', value: '52428800' },
      { key: 'daily_upload_documents_per_principal', value: '20' },
    ]);
  });

  it('is idempotent: re-running every statement, then the runner, changes nothing', async () => {
    if (!HARDENING) throw new Error('0003 missing');
    const before = await schemaFingerprint(t.db);
    const statements = splitStatements(HARDENING.sql);
    expect(statements.length).toBeGreaterThan(40);
    // One statement per call, as the Data API runs them.
    await t.db.system(async (sx) => {
      for (const statement of statements) await sx.query(statement);
    });
    expect(await schemaFingerprint(t.db)).toBe(before);
    const again = await migrate(t.db);
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied).toEqual(['0001_init', '0002_rls_helpers', '0003_security_hardening']);
    const rows = await t.db.system((sx) =>
      sx.query('SELECT version, checksum FROM schema_migrations ORDER BY version'),
    );
    expect(rows.rows).toEqual(MIGRATIONS.map((m) => ({ version: m.version, checksum: m.checksum })));
  });
});
