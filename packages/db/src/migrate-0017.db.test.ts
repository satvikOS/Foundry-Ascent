/**
 * Migration 0017 (the vEIR's digital twin) on top of the schema production has, with calls the previous code
 * wrote: it applies cleanly as the non-superuser owner; earlier calls keep their voice (`polly`); the switches
 * start off with the video-minute caps at 60 a month and 20 a call; a persona's face needs likeness consent and
 * its cloned voice voice consent, only curators read or write them, and the call path sees only what is ready
 * and covered; a call's face is owner-only, ends with its call and never meters past its limit; and the file
 * re-runs without changes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Db } from './db.js';
import { DbError } from './errors.js';
import { MIGRATIONS, migrate } from './migrate.js';
import { p } from './params.js';
import {
  assignmentsRepo,
  callsRepo,
  personasRepo,
  sessionsRepo,
  settingsRepo,
  twinRepo,
} from './repositories/index.js';
import { seedDatabase, type SeedConfig, type SeedResult } from './seed/seed.js';
import { splitStatements } from './sql-lexer.js';
import { createTestDatabase, makeContext, type TestDatabase } from './testing/test-database.js';

const TWIN = MIGRATIONS.find((m) => m.version === '0017_digital_twin');
const BEFORE = MIGRATIONS.filter((m) => m.version < '0017');
const CONFIG: SeedConfig = { homeTenant: { slug: 'ain', name: 'Ain Foundry (test)' }, owner: null };

let t: TestDatabase;
let seed: SeedResult;
let oldCallId: string;

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing');
  return value;
}

async function sqlState(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    if (err instanceof DbError) return err.sqlState;
    throw err;
  }
}

const ctx = (key: string) => makeContext(must(seed.principals[key]), seed.tenantId);
const lead = () => makeContext(must(seed.programLeadId), seed.tenantId);
const corin = () => must(seed.veirs.find((v) => v.eirKey === 'eir-corin'));

/** A live call of `who` in a new conversation of quietquad (Corin's vEIR). */
async function liveCall(who: ReturnType<typeof ctx>): Promise<callsRepo.CallRecord> {
  const venture = must(seed.ventures.find((v) => v.key === 'quietquad'));
  return t.db.withContext(who, async (tx) => {
    const resolved = must(await assignmentsRepo.resolveActiveAssignment(tx, venture.id));
    const session = await sessionsRepo.createSession(tx, {
      tenantId: seed.tenantId,
      ventureId: venture.id,
      assignmentId: resolved.assignment.id,
      personaReleaseId: must(resolved.release).id,
      startedBy: who.principalId,
      mode: 'coach',
      privacy: 'standard',
      policyVersion: 'test',
    });
    return callsRepo.startCall(tx, {
      tenantId: seed.tenantId,
      ventureId: venture.id,
      sessionId: session.id,
      personaId: venture.personaId,
      startedBy: who.principalId,
      provider: 'builtin',
      inputMode: 'typed',
      voiceId: 'Matthew',
      maxSeconds: 1800,
    });
  });
}

/** persona_media, the guard functions with their grants, calls' columns and call_faces: equal after a re-run. */
async function schemaFingerprint(db: Db): Promise<string> {
  return db.system(async (sx) => {
    const parts: unknown[] = [];
    for (const sql of [
      `SELECT conrelid::regclass::text AS rel, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid IN ('public.persona_media'::regclass, 'public.call_faces'::regclass,
                             'public.calls'::regclass, 'public.call_speech'::regclass)
          ORDER BY 1, 2`,
      `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, md5(p.prosrc) AS src,
                coalesce(array_to_string(p.proacl, ','), '') AS acl
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' ORDER BY 1, 2`,
      `SELECT tgrelid::regclass::text AS rel, tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2`,
      `SELECT polrelid::regclass::text AS rel, polname FROM pg_policy ORDER BY 1, 2`,
      `SELECT table_name, privilege_type FROM information_schema.table_privileges
          WHERE grantee = 'app_rls' AND table_name IN ('persona_media', 'call_faces') ORDER BY 1, 2`,
      `SELECT key, value FROM platform_settings ORDER BY key`,
    ]) {
      parts.push((await sx.query(sql)).rows);
    }
    return JSON.stringify(parts);
  });
}

beforeAll(async () => {
  t = await createTestDatabase({ migrate: false });
  await migrate(t.db, { migrations: BEFORE });
  seed = await seedDatabase(t.db, CONFIG);
  // A call the previous code wrote (no voice vendor yet), ended before the upgrade.
  const venture = must(seed.ventures.find((v) => v.key === 'quietquad'));
  const maya = ctx('maya');
  oldCallId = await t.db.withContext(maya, async (tx) => {
    const resolved = must(await assignmentsRepo.resolveActiveAssignment(tx, venture.id));
    const session = await sessionsRepo.createSession(tx, {
      tenantId: seed.tenantId,
      ventureId: venture.id,
      assignmentId: resolved.assignment.id,
      personaReleaseId: must(resolved.release).id,
      startedBy: maya.principalId,
      mode: 'coach',
      privacy: 'standard',
      policyVersion: 'test',
    });
    const r = await tx.query(
      `INSERT INTO calls (tenant_id, venture_id, session_id, persona_id, started_by, voice_id, max_seconds)
       VALUES (:t, :v, :s, :persona, :me, 'Matthew', 1800) RETURNING id`,
      {
        t: p.uuid(seed.tenantId),
        v: p.uuid(venture.id),
        s: p.uuid(session.id),
        persona: p.uuid(venture.personaId),
        me: p.uuid(maya.principalId),
      },
    );
    return String(r.rows[0]?.id);
  });
  await t.db.system((sx) =>
    sx.query(`UPDATE calls SET status = 'ended', end_reason = 'user' WHERE id = :id`, {
      id: p.uuid(oldCallId),
    }),
  );
}, 120_000);
afterAll(async () => {
  await t.cleanup();
});

describe('migration 0017_digital_twin', () => {
  it('applies cleanly on top of the earlier migrations with existing data, as the non-superuser owner', async () => {
    const report = await migrate(t.db);
    expect(report.applied).toEqual(MIGRATIONS.map((m) => m.version).filter((v) => v >= '0017'));
    expect(report.applied[0]).toBe('0017_digital_twin');
    expect(TWIN && splitStatements(TWIN.sql).length).toBeGreaterThanOrEqual(20);
    const old = await t.db.system((sx) => callsRepo.getCall(sx, oldCallId));
    expect(old?.voiceVendor).toBe('polly');
  });

  it('starts with faces and cloned voices off, 60 video minutes a month and 20 a call', async () => {
    const settings = await t.db.withContext(ctx('maya'), (tx) => settingsRepo.getPlatformSettings(tx));
    expect(settings).toMatchObject({
      facesEnabled: false,
      clonedVoiceEnabled: false,
      faceMinutesPerPrincipalMonth: 60,
      faceMinutesPerCall: 20,
    });
  });

  it('gives a face only under likeness consent and a cloned voice under voice consent', async () => {
    const corinEir = ctx('eir-corin');
    const write = (kind: 'face' | 'voice', status: 'pending' | 'ready', who = corinEir) =>
      t.db.withContext(who, (tx) =>
        twinRepo.upsertPersonaMedia(tx, {
          personaId: corin().personaId,
          tenantId: seed.tenantId,
          kind,
          vendor: kind === 'face' ? 'heygen' : 'elevenlabs',
          vendorRef: kind === 'face' ? 'dd73ea75-1218-4ef3-92ce-606d5f7fbc0a' : 'VoiceClone01',
          status,
          updatedBy: who.principalId,
        }),
      );
    // The seeded consent covers voice, not likeness.
    expect(await sqlState(write('face', 'ready'))).toBe('23514');
    expect(await sqlState(write('face', 'pending'))).toBeNull();
    expect(await sqlState(write('voice', 'ready'))).toBeNull();
    // A program lead curates it too.
    expect(await sqlState(write('voice', 'ready', lead()))).toBeNull();
    // The call path sees the ready voice only.
    const twin = await t.db.withContext(ctx('maya'), (tx) => twinRepo.personaTwin(tx, corin().personaId));
    expect(twin).toEqual({ face: null, voice: { vendor: 'elevenlabs', ref: 'VoiceClone01' } });
  });

  it('refuses a mismatched vendor, a malformed id, a guide, and anyone who does not curate the persona', async () => {
    const insert = (sql: string, who = lead()) => t.db.withContext(who, (tx) => tx.query(sql));
    const base = (kind: string, vendor: string, ref: string, persona = corin().personaId) =>
      `INSERT INTO persona_media (persona_id, tenant_id, kind, vendor, vendor_ref, status, updated_by)
       VALUES ('${persona}', '${seed.tenantId}', '${kind}', '${vendor}', '${ref}', 'pending',
               '${must(seed.programLeadId)}')
       ON CONFLICT (persona_id, kind) DO UPDATE SET vendor = EXCLUDED.vendor, vendor_ref = EXCLUDED.vendor_ref`;
    expect(await sqlState(insert(base('face', 'elevenlabs', 'abc')))).toBe('23514');
    expect(await sqlState(insert(base('face', 'heygen', 'bad id with spaces')))).toBe('23514');
    expect(await sqlState(insert(base('face', 'heygen', 'abc', seed.personaId)))).toBe('23514');
    // Founders neither read nor write the twin (they see what calls use through app.persona_twin only).
    const mayaReads = await t.db.withContext(ctx('maya'), (tx) =>
      twinRepo.listPersonaMedia(tx, corin().personaId),
    );
    expect(mayaReads).toEqual([]);
    const maya = ctx('maya');
    expect(
      await sqlState(
        t.db.withContext(maya, (tx) =>
          twinRepo.upsertPersonaMedia(tx, {
            personaId: corin().personaId,
            tenantId: seed.tenantId,
            kind: 'voice',
            vendor: 'elevenlabs',
            vendorRef: 'Hijack',
            status: 'pending',
            updatedBy: maya.principalId,
          }),
        ),
      ),
    ).toBe('42501');
    // Another EIR does not curate Corin's vEIR.
    expect(
      await t.db.withContext(ctx('eir-ruth'), (tx) => twinRepo.listPersonaMedia(tx, corin().personaId)),
    ).toEqual([]);
  });

  it('withdraws what a new consent no longer covers, and a revoked consent leaves the call path nothing', async () => {
    const persona = corin().personaId;
    const corinEir = ctx('eir-corin');
    // A narrower consent (no voice) replaces the link: the voice is withdrawn by the database.
    const narrower = await t.db.withContext(corinEir, (tx) =>
      personasRepo.createConsent(tx, {
        tenantId: seed.tenantId,
        subjectPrincipalId: corinEir.principalId,
        assetTypes: ['doctrine', 'style', 'likeness'],
      }),
    );
    await t.db.system(async (sx) => {
      await personasRepo.setPersonaEmbodiment(sx, {
        personaId: persona,
        embodiment: { provider: 'builtin', voiceId: null, portraitKey: null },
      });
      await personasRepo.setPersonaConsent(sx, { personaId: persona, consentId: narrower.id });
    });
    const after = await t.db.withContext(corinEir, (tx) => twinRepo.listPersonaMedia(tx, persona));
    expect(after.find((m) => m.kind === 'voice')?.status).toBe('withdrawn');
    // Likeness is covered now: the face may become ready.
    await t.db.withContext(corinEir, (tx) =>
      twinRepo.upsertPersonaMedia(tx, {
        personaId: persona,
        tenantId: seed.tenantId,
        kind: 'face',
        vendor: 'heygen',
        vendorRef: 'dd73ea75-1218-4ef3-92ce-606d5f7fbc0a',
        status: 'ready',
        updatedBy: corinEir.principalId,
      }),
    );
    expect((await t.db.withContext(ctx('maya'), (tx) => twinRepo.personaTwin(tx, persona))).face).toEqual({
      vendor: 'heygen',
      ref: 'dd73ea75-1218-4ef3-92ce-606d5f7fbc0a',
    });
    // Revoked: nothing for calls, at once (the row itself is unchanged).
    const consentId = must(
      (await t.db.system((sx) => personasRepo.getPersona(sx, persona)))?.consentId ?? null,
    );
    await t.db.system((sx) =>
      sx.query('UPDATE consents SET revoked_at = now() WHERE id = :id', { id: p.uuid(consentId) }),
    );
    expect(await t.db.withContext(ctx('maya'), (tx) => twinRepo.personaTwin(tx, persona))).toEqual({
      face: null,
      voice: null,
    });
    await t.db.system((sx) =>
      sx.query('UPDATE consents SET revoked_at = NULL WHERE id = :id', { id: p.uuid(consentId) }),
    );
  });

  it('keeps a call’s face owner-only, one per live call, metered within its limit, ended with its call', async () => {
    const maya = ctx('maya');
    const call = await liveCall(maya);
    expect(call.voiceVendor).toBe('polly');
    // app_rls has no privileges on call_faces.
    expect(await sqlState(t.db.withContext(maya, (tx) => tx.query('SELECT * FROM call_faces')))).toBe(
      '42501',
    );
    // Only the starter's live call gets a face, and only one.
    const someoneElse = await t.db.system((sx) =>
      twinRepo.startCallFace(sx, {
        callId: call.id,
        startedBy: must(seed.principals.devin),
        vendor: 'fake',
        sessionRef: 's-1',
        control: null,
        maxSeconds: 60,
      }),
    );
    expect(someoneElse).toBeNull();
    const face = must(
      await t.db.system((sx) =>
        twinRepo.startCallFace(sx, {
          callId: call.id,
          startedBy: maya.principalId,
          vendor: 'heygen',
          sessionRef: 'sess-1',
          control: Buffer.from('ciphertext').toString('base64'),
          maxSeconds: 5,
        }),
      ),
    );
    expect(face.control).toBe(Buffer.from('ciphertext').toString('base64'));
    expect(
      await t.db.system((sx) =>
        twinRepo.startCallFace(sx, {
          callId: call.id,
          startedBy: maya.principalId,
          vendor: 'heygen',
          sessionRef: 'sess-2',
          control: null,
          maxSeconds: 5,
        }),
      ),
    ).toBeNull();
    // Metered from the server's clock, never beyond the face's limit.
    await t.db.system((sx) =>
      sx.query(`UPDATE call_faces SET started_at = now() - interval '30 seconds' WHERE call_id = :id`, {
        id: p.uuid(call.id),
      }),
    );
    expect(await t.db.system((sx) => twinRepo.meterCallFace(sx, call.id))).toBe(5);
    expect(await t.db.system((sx) => twinRepo.meterCallFace(sx, call.id))).toBe(0);
    expect(await t.db.system((sx) => twinRepo.faceSecondsThisMonth(sx, maya.principalId))).toBe(5);
    // Ending the call ends the face and erases the control channel.
    await t.db.withContext(maya, (tx) =>
      callsRepo.endCall(tx, { callId: call.id, reason: 'user', detail: 'client_user' }),
    );
    const ended = must(await t.db.system((sx) => twinRepo.getCallFace(sx, call.id)));
    expect(ended).toMatchObject({ endReason: 'call_ended', control: null, meteredSeconds: 5 });
    expect(ended.endedAt).not.toBeNull();
    // A call's voice vendor never changes.
    expect(
      await sqlState(
        t.db.system((sx) =>
          sx.query(`UPDATE calls SET voice_vendor = 'elevenlabs' WHERE id = :id`, { id: p.uuid(call.id) }),
        ),
      ),
    ).toBe('55000');
  });

  it('hands a unit to the face only after the call synthesized it, and only as often as allowed', async () => {
    const maya = ctx('maya');
    const call = await liveCall(maya);
    const unit = 'intro';
    const reserve = () =>
      t.db.system((sx) => twinRepo.reserveFacePlay(sx, { callId: call.id, unit, maxPlays: 1 }));
    expect(await reserve()).toBe(false);
    await t.db.system((sx) =>
      sx.query(`INSERT INTO call_speech (call_id, unit, plays, characters) VALUES (:id, 'intro', 1, 10)`, {
        id: p.uuid(call.id),
      }),
    );
    expect(await reserve()).toBe(true);
    expect(await reserve()).toBe(false);
    await t.db.withContext(maya, (tx) =>
      callsRepo.endCall(tx, { callId: call.id, reason: 'user', detail: 'client_user' }),
    );
  });

  it('is idempotent: re-running every statement, then the runner, changes nothing', async () => {
    if (!TWIN) throw new Error('0017 missing');
    const before = await schemaFingerprint(t.db);
    await t.db.system(async (sx) => {
      for (const statement of splitStatements(TWIN.sql)) await sx.query(statement);
    });
    expect(await schemaFingerprint(t.db)).toBe(before);
    expect((await migrate(t.db)).applied).toEqual([]);
  });
});
