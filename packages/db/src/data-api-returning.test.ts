/**
 * RDS Data API typed records (R1). `formatRecordsAs: 'JSON'` is ignored for INSERT/UPDATE … RETURNING, so
 * those rows come back as typed `Field`s. Every repository function whose RETURNING list carries arrays,
 * jsonb, numeric or timestamptz columns is run here against a fake Data API that answers in that shape
 * (empty arrays as member-less or empty `arrayValue`s, numerics and timestamps as strings, jsonb as JSON
 * text), and must decode.
 */
import {
  type ExecuteStatementCommandInput,
  type ExecuteStatementCommandOutput,
  type Field,
} from '@aws-sdk/client-rds-data';
import { describe, expect, it } from 'vitest';

import { col, row } from './columns.js';
import {
  arrayValueToRaw,
  createDataApiDriver,
  decodeExecuteResult,
  fieldToRaw,
  type DataApiClient,
} from './data-api.js';
import { createDbFromDriver, type Db } from './db.js';
import {
  assignmentsRepo,
  authRepo,
  documentsRepo,
  eirRepo,
  knowledgeRepo,
  personasRepo,
  principalsRepo,
  resourcesRepo,
  sessionsRepo,
  tenantsRepo,
  turnsRepo,
  venturesRepo,
} from './repositories/index.js';

const META = { $metadata: {} };
const ID = '6f1c3a52-9d7e-4b0a-8f2e-3c5d7a9b1e04';
const ID2 = '0b8d2c11-7a4e-4f5b-9c3d-2e1f0a9b8c7d';
/** The Data API's timestamptz text (UTC, no offset). */
const TS = '2026-10-05 12:00:00.5';
const TS_ISO = '2026-10-05T12:00:00.500Z';

type FieldMap = Readonly<Record<string, Field>>;

const s = (value: string): Field => ({ stringValue: value });
const n = (value: number): Field => ({ longValue: value });
const b = (value: boolean): Field => ({ booleanValue: value });
const NULL: Field = { isNull: true };
/** The four shapes an empty PostgreSQL array has been seen to take in typed records. */
const EMPTY_ARRAYS: readonly Field[] = [
  { arrayValue: {} as never },
  { arrayValue: { stringValues: [] } },
  { arrayValue: { arrayValues: [] } },
  { arrayValue: { longValues: [] } },
];
const texts = (...values: string[]): Field => ({ arrayValue: { stringValues: values } });

/** Columns shared by many tables. Table-specific values are passed per call. */
const COMMON: FieldMap = {
  id: s(ID),
  tenant_id: s(ID),
  venture_id: s(ID),
  session_id: s(ID),
  principal_id: s(ID),
  persona_id: s(ID),
  assignment_id: s(ID),
  persona_release_id: s(ID),
  eir_profile_id: NULL,
  consent_id: NULL,
  source_id: NULL,
  author_id: s(ID),
  started_by: s(ID),
  uploaded_by: s(ID),
  subject_principal_id: s(ID),
  created_by: NULL,
  owner_id: NULL,
  created_at: s(TS),
  updated_at: s(TS),
  started_at: s(TS),
  ended_at: NULL,
  completed_at: NULL,
  expires_at: NULL,
  revoked_at: NULL,
  last_used_at: NULL,
  granted_at: s(TS),
  starts_at: s(TS),
  freshness_at: s(TS),
};

/** Fake Data API: every RETURNING statement answers with one typed record built from `fields`. */
function typedDb(fields: FieldMap): { db: Db; statements: string[] } {
  const statements: string[] = [];
  const execute = (input: ExecuteStatementCommandInput): Promise<ExecuteStatementCommandOutput> => {
    const sql = input.sql ?? '';
    statements.push(sql);
    const returning = /\bRETURNING\s+([\s\S]+)$/i.exec(sql);
    if (!returning?.[1]) return Promise.resolve({ ...META, numberOfRecordsUpdated: 1 });
    const names = returning[1]
      .split(',')
      .map((c) => c.trim().replace(/^[a-z]+\./, ''))
      .map((c) => /(?:\bAS\s+)?([a-z0-9_]+)$/i.exec(c)?.[1] ?? c);
    const record = names.map((name) => {
      const field = fields[name] ?? COMMON[name];
      if (field === undefined) throw new Error(`no typed value for RETURNING column ${name}`);
      return field;
    });
    return Promise.resolve({
      ...META,
      columnMetadata: names.map((label) => ({ label })),
      records: [record],
    });
  };
  const client: DataApiClient = {
    executeStatement: execute,
    beginTransaction: () => Promise.resolve({ ...META, transactionId: 'tx' }),
    commitTransaction: () => Promise.resolve({ ...META, transactionStatus: 'Transaction Committed' }),
    rollbackTransaction: () => Promise.resolve({ ...META, transactionStatus: 'Rollback Complete' }),
  };
  const driver = createDataApiDriver({
    resourceArn: 'arn:aws:rds:us-east-1:000000000000:cluster:x',
    secretArn: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:x',
    database: 'foundry',
    client,
  });
  return { db: createDbFromDriver(driver), statements };
}

describe('Data API typed records: arrays', () => {
  it('decodes every empty or member-less arrayValue to []', () => {
    for (const field of EMPTY_ARRAYS) expect(fieldToRaw(field)).toEqual([]);
    expect(arrayValueToRaw(undefined)).toEqual([]);
    expect(arrayValueToRaw(null)).toEqual([]);
  });

  it('keeps SQL NULL arrays null, and decodes text, uuid, numeric, boolean and nested arrays', () => {
    expect(fieldToRaw(NULL)).toBeNull();
    expect(fieldToRaw(texts('a', 'b "c"'))).toEqual(['a', 'b "c"']);
    expect(fieldToRaw(texts(ID, ID2))).toEqual([ID, ID2]);
    expect(fieldToRaw({ arrayValue: { longValues: [1, null, 3] } })).toEqual([1, null, 3]);
    expect(fieldToRaw({ arrayValue: { doubleValues: [0.5] } })).toEqual([0.5]);
    expect(fieldToRaw({ arrayValue: { booleanValues: [true, false] } })).toEqual([true, false]);
    expect(
      fieldToRaw({
        arrayValue: {
          arrayValues: [{ stringValues: ['a', 'b'] }, { stringValues: [] }, null, {} as never],
        },
      }),
    ).toEqual([['a', 'b'], [], null, []]);
  });

  it('decodes a typed RETURNING row with empty, null and filled arrays through the column codecs', () => {
    const codec = row({ empty: col.textArray, missing: col.textArray.nullable, tags: col.textArray });
    for (const empty of EMPTY_ARRAYS) {
      const result = decodeExecuteResult({
        ...META,
        columnMetadata: [{ label: 'empty' }, { label: 'missing' }, { label: 'tags' }],
        records: [[empty, NULL, texts('x', 'y')]],
      });
      expect(result.rows.map((r) => codec.decode(r))).toEqual([
        { empty: [], missing: null, tags: ['x', 'y'] },
      ]);
    }
  });
});

describe('Data API typed records: every RETURNING statement with arrays, jsonb, numeric or timestamps', () => {
  const ctx = { principalId: ID, tenantId: ID, requestId: 'test-typed-records' };

  it('turns: createTurn (risk_categories defaults to {}) and finishTurn (jsonb, numeric)', async () => {
    for (const empty of EMPTY_ARRAYS) {
      const { db } = typedDb({
        ordinal: n(1),
        mode: s('coach'),
        founder_text: s('hello'),
        response: NULL,
        status: s('pending'),
        risk_label: s('none'),
        risk_categories: empty,
        validator_results: s('{}'),
        model_id: NULL,
        fallback_used: b(false),
        input_tokens: n(0),
        output_tokens: n(0),
        cost_usd: s('0.000000'),
        latency_ms: NULL,
        sampled_for_review: b(false),
      });
      const turn = await db.withContext(ctx, (tx) =>
        turnsRepo.createTurn(tx, {
          tenantId: ID,
          ventureId: ID,
          sessionId: ID,
          authorId: ID,
          mode: 'coach',
          founderText: 'hello',
        }),
      );
      expect(turn).toMatchObject({ riskCategories: [], costUsd: 0, createdAt: TS_ISO, ordinal: 1 });
    }
    const { db } = typedDb({
      ordinal: n(2),
      mode: s('coach'),
      founder_text: s('hello'),
      response: NULL,
      status: s('completed'),
      risk_label: NULL,
      risk_categories: texts('legal', 'prompt_injection'),
      validator_results: s(
        JSON.stringify({
          unknownEvidenceIdsRemoved: 0,
          factsDowngraded: 1,
          groundingCoverage: 0.5,
          narrowed: false,
          escalationForced: false,
          identityViolation: false,
          crossVentureViolation: false,
          riskCategories: ['legal'],
          notes: [],
        }),
      ),
      model_id: s('us.amazon.nova-2-lite-v1:0'),
      fallback_used: b(true),
      input_tokens: n(1200),
      output_tokens: n(300),
      cost_usd: s('0.001234'),
      latency_ms: n(900),
      sampled_for_review: b(true),
      completed_at: s(TS),
    });
    const finished = await db.withContext(ctx, (tx) =>
      turnsRepo.finishTurn(tx, { turnId: ID, status: 'completed' }),
    );
    expect(finished).toMatchObject({
      riskCategories: ['legal', 'prompt_injection'],
      costUsd: 0.001234,
      validatorResults: { factsDowngraded: 1, riskCategories: ['legal'] },
      completedAt: TS_ISO,
      latencyMs: 900,
    });
  });

  it('sessions: createSession, endSession (recap jsonb), setSessionStatus, setSessionMode', async () => {
    const { db } = typedDb({
      mode: s('coach'),
      privacy: s('ephemeral'),
      goal: NULL,
      status: s('ended'),
      policy_version: s('v1'),
      recap: NULL,
      ended_at: s(TS),
    });
    await db.withContext(ctx, async (tx) => {
      const created = await sessionsRepo.createSession(tx, {
        tenantId: ID,
        ventureId: ID,
        assignmentId: ID,
        personaReleaseId: ID,
        startedBy: ID,
        mode: 'coach',
        privacy: 'ephemeral',
        policyVersion: 'v1',
      });
      expect(created).toMatchObject({ recap: null, endedAt: TS_ISO, startedAt: TS_ISO });
      expect(await sessionsRepo.endSession(tx, { sessionId: ID, recap: null })).not.toBeNull();
      expect(await sessionsRepo.setSessionStatus(tx, { sessionId: ID, status: 'ended' })).not.toBeNull();
      expect(await sessionsRepo.setSessionMode(tx, { sessionId: ID, mode: 'coach' })).not.toBeNull();
    });
  });

  it('assignments (allowed_modes), EIR profiles (tags), resources (tags, stages), consents (arrays)', async () => {
    for (const empty of EMPTY_ARRAYS) {
      const { db } = typedDb({
        allowed_modes: texts('coach', 'diagnose'),
        data_class_ceiling: s('venture_private'),
        display_name: s('Dr Example'),
        title: NULL,
        expertise_tags: empty,
        routing_intents: empty,
        synthetic: b(true),
        name: s('Lab access'),
        kind: s('lab'),
        description: s('d'),
        url: NULL,
        tags: empty,
        stages: texts('idea'),
        eligibility: NULL,
        owner: NULL,
        asset_types: texts('doctrine'),
        approved_uses: empty,
        audiences: empty,
        evidence_ref: NULL,
        status: s('active'),
      });
      await db.withContext(ctx, async (tx) => {
        const assignment = await assignmentsRepo.createAssignment(tx, {
          tenantId: ID,
          ventureId: ID,
          personaId: ID,
        });
        expect(assignment.allowedModes).toEqual(['coach', 'diagnose']);
        expect(assignment.createdAt).toBe(TS_ISO);
        const eir = await eirRepo.createEirProfile(tx, { tenantId: ID, displayName: 'Dr Example' });
        expect(eir).toMatchObject({ expertiseTags: [], routingIntents: [] });
        const resource = await resourcesRepo.createResource(tx, {
          tenantId: ID,
          name: 'Lab access',
          kind: 'lab',
          description: 'd',
        });
        expect(resource).toMatchObject({ tags: [], stages: ['idea'], freshnessAt: TS_ISO });
        const consent = await personasRepo.createConsent(tx, {
          tenantId: ID,
          subjectPrincipalId: ID,
          assetTypes: ['doctrine'],
        });
        expect(consent).toMatchObject({ assetTypes: ['doctrine'], approvedUses: [], audiences: [] });
      });
    }
  });

  it('documents, access codes, ventures, principals, knowledge sources, tenants (timestamps, enums)', async () => {
    const { db } = typedDb({
      filename: s('plan.md'),
      content_type: s('text/markdown'),
      size_bytes: n(10),
      s3_key: s('tenants/x'),
      status: s('active'),
      failure_reason: NULL,
      code_prefix: s('ABCDE'),
      label: s('access code'),
      name: s('Quiet Quad'),
      one_liner: s(''),
      stage: s('idea'),
      domain: s('general'),
      cohort: NULL,
      classification: s('synthetic'),
      current_goal: NULL,
      display_name: s('Person'),
      email: NULL,
      title: s('Source'),
      synthetic: b(false),
      scope: s('program'),
      uri: NULL,
      owner: NULL,
      checksum: NULL,
      license: NULL,
      slug: s('ain'),
      kind: s('home'),
    });
    await db.withContext(ctx, async (tx) => {
      const venture = await venturesRepo.createVenture(tx, { tenantId: ID, name: 'Quiet Quad' });
      expect(venture.createdAt).toBe(TS_ISO);
      const principal = await principalsRepo.createPrincipal(tx, { tenantId: ID, displayName: 'Person' });
      expect(principal.updatedAt).toBe(TS_ISO);
      const source = await knowledgeRepo.createKnowledgeSource(tx, {
        tenantId: ID,
        scope: 'program',
        title: 'Source',
      });
      expect(source.freshnessAt).toBe(TS_ISO);
    });
    const docs = typedDb({
      filename: s('plan.md'),
      content_type: s('text/markdown'),
      size_bytes: n(10),
      s3_key: s('tenants/x'),
      status: s('failed'),
      failure_reason: s('spend_cap_reached'),
    });
    const doc = await docs.db.withContext(ctx, (tx) =>
      documentsRepo.setDocumentStatus(tx, { documentId: ID, status: 'failed', failureReason: 'x' }),
    );
    expect(doc).toMatchObject({ status: 'failed', failureReason: 'spend_cap_reached', updatedAt: TS_ISO });
    await db.system(async (sx) => {
      const code = await authRepo.createAccessCode(sx, {
        principalId: ID,
        prefix: 'ABCDE',
        hash: 'scrypt$x',
      });
      expect(code).toMatchObject({ lastUsedAt: null, createdAt: TS_ISO });
      expect(await authRepo.revokeAccessCode(sx, ID)).not.toBeNull();
    });
    const tenants = typedDb({ slug: s('ain'), name: s('Ain'), kind: s('home'), status: s('active') });
    await tenants.db.system(async (sx) => {
      const tenant = await tenantsRepo.upsertTenant(sx, { slug: 'ain', name: 'Ain', kind: 'home' });
      expect(tenant.createdAt).toBe(TS_ISO);
    });
  });
});
