/**
 * Deterministic, idempotent synthetic seed — safe to run on every deploy (migrate custom resource).
 *
 * - Every object has a deterministic id (UUIDv5 of tenant slug + key); rows are inserted with
 *   ON CONFLICT DO NOTHING, so re-running never duplicates data and never overwrites changes made in the
 *   product (a suspended persona stays suspended, a deleted memory item stays deleted). A knowledge source's
 *   chunks are inserted only together with the source (`insertSourceWithChunks`), so an edited or withdrawn
 *   corpus and a deleted document never get their seeded chunks back.
 * - Corpora are authored notes (kind `note` with their text as `body`) once migration 0004 is applied, as
 *   migrations 0004 and 0005 convert the corpora of databases seeded earlier.
 * - The owner principal (platform_admin + program_lead) is bound to OWNER_ACCESS_CODE_PREFIX/HASH; the
 *   owner's display name and code hash follow the deploy configuration. Demo principals get no codes.
 * - Documents and knowledge chunks are stored without embeddings; the migrate handler backfills them
 *   (`knowledgeRepo.listChunksMissingEmbeddings` / `setChunkEmbeddings`).
 * - Demo ventures are coached by vEIR personas built from the synthetic EIRs (`./veir.ts`); Foundry Guide
 *   stays the program's neutral guide for new ventures.
 */
import { col } from '../columns.js';
import { type Db, type EnvLike } from '../db.js';
import { SqlUsageError } from '../errors.js';
import { type SystemExecutor } from '../executor.js';
import { p } from '../params.js';
import { isAccessCodeHash } from './access-code.js';
import {
  GUIDE_DISCLOSURE,
  GUIDE_DOCTRINE,
  GUIDE_PERSONA_NAME,
  GUIDE_STYLE,
  PROGRAM_METHOD_SOURCE,
} from './doctrine.js';
import { seedId, ventureCanary } from './ids.js';
import { bodyFromSections, insertRows, insertSourceWithChunks } from './insert.js';
import { SEED_PATTERNS, SEED_RESOURCES } from './resources.js';
import { hasVeirSchema, seedVeirs, type SeededVeir } from './veir.js';
import {
  SEED_EIRS,
  SEED_FOUNDERS,
  SEED_PROGRAM_LEAD,
  buildSeedVentures,
  type SeedDocument,
  type SeedVenture,
} from './ventures.js';

export interface SeedConfig {
  readonly homeTenant: { readonly slug: string; readonly name: string };
  /** The deploy owner (required in production). */
  readonly owner: {
    readonly displayName: string;
    readonly accessCodePrefix: string;
    readonly accessCodeHash: string;
  } | null;
  /** Synthetic demo ventures, people, resources and patterns (default true). */
  readonly includeDemoData?: boolean;
  /** Clock for relative dates in demo data (tests). */
  readonly now?: Date;
}

export interface SeededVenture {
  readonly key: string;
  readonly id: string;
  readonly name: string;
  readonly canary: string;
  readonly members: readonly { readonly key: string; readonly principalId: string; readonly role: string }[];
  /** EIR of the venture's active assignment (the EIR its vEIR is built from). */
  readonly eirKey: string;
  /** The venture's active assignment (its vEIR's, once re-pointed). */
  readonly assignmentId: string;
  /** Persona of the active assignment. */
  readonly personaId: string;
  readonly documentIds: readonly string[];
  readonly memoryIds: Readonly<Record<string, string>>;
}

export interface SeedResult {
  readonly tenantId: string;
  readonly ownerId: string | null;
  readonly programLeadId: string | null;
  readonly personaId: string;
  readonly releaseId: string;
  /** Principal ids by seed key (founders, EIRs, program lead, `owner`). */
  readonly principals: Readonly<Record<string, string>>;
  readonly eirs: readonly {
    readonly key: string;
    readonly profileId: string;
    readonly principalId: string;
  }[];
  readonly ventures: readonly SeededVenture[];
  /** vEIR personas (empty without demo data or before migration 0004). */
  readonly veirs: readonly SeededVeir[];
}

function dayFn(now: Date): (offsetDays: number) => string {
  return (offsetDays) => new Date(now.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function documentText(doc: SeedDocument, canary: string | null): { heading: string; content: string }[] {
  const sections = doc.sections.map((s) => ({ heading: s.heading, content: s.content }));
  if (canary) {
    sections.push({
      heading: 'Workspace reference',
      content: `Internal reference for this workspace (do not share outside the venture): ${canary}`,
    });
  }
  return sections;
}

/** Runs the seed inside one owner transaction. */
export function seedDatabase(db: Db, config: SeedConfig): Promise<SeedResult> {
  return db.system((sx) => seed(sx, config));
}

/** Seeds through an existing system executor (call inside a transaction). */
export async function seed(sx: SystemExecutor, config: SeedConfig): Promise<SeedResult> {
  const slug = config.homeTenant.slug;
  const demo = config.includeDemoData ?? true;
  const id = (...parts: string[]): string => seedId(slug, ...parts);
  if (config.owner) {
    if (!/^[0-9A-HJKMNP-TV-Z]{5}$/.test(config.owner.accessCodePrefix)) {
      throw new SqlUsageError('OWNER_ACCESS_CODE_PREFIX must be 5 Crockford base32 characters');
    }
    if (!isAccessCodeHash(config.owner.accessCodeHash)) {
      throw new SqlUsageError('OWNER_ACCESS_CODE_HASH must be scrypt$N=32768,r=8,p=1$<salt>$<key>');
    }
  } else if (!demo) {
    throw new SqlUsageError('seed needs an owner or demo data (someone must approve the guide release)');
  }

  // Tenant ----------------------------------------------------------------------------------------
  const tenantId = await (async () => {
    const result = await sx.query(
      `INSERT INTO tenants (id, slug, name, kind) VALUES (:id, :slug, :name, 'home')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      { id: p.uuid(id('tenant')), slug: p.text(slug), name: p.text(config.homeTenant.name) },
    );
    const row = result.rows[0];
    if (!row) throw new SqlUsageError('tenant upsert returned no row');
    return col.uuid.decode(row.id, 'id');
  })();

  // Principals ------------------------------------------------------------------------------------
  const principals: Record<string, string> = {};
  let ownerId: string | null = null;
  if (config.owner) {
    ownerId = id('principal', 'owner');
    principals.owner = ownerId;
    await sx.query(
      `INSERT INTO principals (id, tenant_id, display_name, title, synthetic)
       VALUES (:id, :tenantId, :name, 'Platform owner', false)
       ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()`,
      { id: p.uuid(ownerId), tenantId: p.uuid(tenantId), name: p.text(config.owner.displayName) },
    );
    // The deploy owner always holds both roles (break-glass: a redeploy restores revoked owner access).
    await sx.query(
      `INSERT INTO role_grants (principal_id, tenant_id, role)
       SELECT :owner, x.tenant_id, x.role
       FROM (VALUES (NULL::uuid, 'platform_admin'), (CAST(:tenantId AS uuid), 'program_lead')) AS x (tenant_id, role)
       WHERE NOT EXISTS (SELECT 1 FROM role_grants g WHERE g.principal_id = :owner AND g.role = x.role
                           AND g.revoked_at IS NULL AND g.tenant_id IS NOT DISTINCT FROM x.tenant_id)`,
      { owner: p.uuid(ownerId), tenantId: p.uuid(tenantId) },
    );
    await bindOwnerCode(sx, {
      ownerId,
      codeId: id('access-code', config.owner.accessCodePrefix),
      prefix: config.owner.accessCodePrefix,
      hash: config.owner.accessCodeHash,
    });
  }

  let programLeadId: string | null = null;
  const eirs: { key: string; profileId: string; principalId: string }[] = [];
  let ventures: SeededVenture[] = [];
  let veirs: readonly SeededVeir[] = [];

  if (demo) {
    const people = [SEED_PROGRAM_LEAD, ...SEED_EIRS, ...SEED_FOUNDERS];
    for (const person of people) principals[person.key] = id('principal', person.key);
    programLeadId = principals[SEED_PROGRAM_LEAD.key] ?? null;
    await insertRows(
      sx,
      'principals',
      { id: 'uuid', tenant_id: 'uuid', display_name: 'text', title: 'text', synthetic: 'boolean' },
      people.map((person) => ({
        id: principals[person.key],
        tenant_id: tenantId,
        display_name: person.displayName,
        title: person.title,
        synthetic: true,
      })),
    );
    // Demo grants respect later revocations (only granted if never granted before).
    await sx.query(
      `INSERT INTO role_grants (principal_id, tenant_id, role)
       SELECT x.principal_id, x.tenant_id, x.role
       FROM jsonb_to_recordset(:rows) AS x (principal_id uuid, tenant_id uuid, role text)
       WHERE NOT EXISTS (SELECT 1 FROM role_grants g WHERE g.principal_id = x.principal_id AND g.role = x.role
                           AND g.tenant_id IS NOT DISTINCT FROM x.tenant_id)`,
      {
        rows: p.json([
          { principal_id: programLeadId, tenant_id: tenantId, role: 'program_lead' },
          ...SEED_EIRS.map((e) => ({ principal_id: principals[e.key], tenant_id: tenantId, role: 'eir' })),
        ]),
      },
    );
    await insertRows(
      sx,
      'eir_profiles',
      {
        id: 'uuid',
        tenant_id: 'uuid',
        principal_id: 'uuid',
        display_name: 'text',
        title: 'text',
        expertise_tags: 'text[]',
        routing_intents: 'text[]',
        synthetic: 'boolean',
      },
      SEED_EIRS.map((e) => ({
        id: id('eir-profile', e.key),
        tenant_id: tenantId,
        principal_id: principals[e.key],
        display_name: e.displayName,
        title: e.title,
        expertise_tags: e.expertiseTags,
        routing_intents: e.routingIntents,
        synthetic: true,
      })),
    );
    for (const e of SEED_EIRS) {
      eirs.push({ key: e.key, profileId: id('eir-profile', e.key), principalId: principals[e.key] ?? '' });
    }
  }

  // Foundry Guide persona + approved release v1 ----------------------------------------------------
  const personaId = id('persona', 'foundry-guide');
  const releaseId = id('persona-release', 'foundry-guide', 'v1');
  const approver = ownerId ?? programLeadId;
  await insertRows(
    sx,
    'personas',
    { id: 'uuid', tenant_id: 'uuid', name: 'text', kind: 'text', status: 'text' },
    [
      {
        id: personaId,
        tenant_id: tenantId,
        name: GUIDE_PERSONA_NAME,
        kind: 'neutral_guide',
        status: 'active',
      },
    ],
  );
  await insertRows(
    sx,
    'persona_releases',
    {
      id: 'uuid',
      persona_id: 'uuid',
      version: 'integer',
      doctrine: 'jsonb',
      style: 'jsonb',
      disclosure_text: 'text',
      allowed_modes: 'text[]',
      status: 'text',
      created_by: 'uuid',
      approved_by: 'uuid',
      approved_at: 'timestamptz',
    },
    [
      {
        id: releaseId,
        persona_id: personaId,
        version: 1,
        doctrine: GUIDE_DOCTRINE,
        style: GUIDE_STYLE,
        disclosure_text: GUIDE_DISCLOSURE,
        allowed_modes: ['diagnose', 'challenge', 'coach', 'teach', 'rehearse', 'route'],
        status: 'approved',
        created_by: approver,
        approved_by: approver,
        approved_at: new Date().toISOString(),
      },
    ],
  );

  // Shared knowledge: program method + guide doctrine corpus ---------------------------------------
  const veirSchema = await hasVeirSchema(sx);
  const programSourceId = id('knowledge-source', PROGRAM_METHOD_SOURCE.key);
  const doctrineSourceId = id('knowledge-source', 'foundry-guide-doctrine');
  const doctrineChunks = [
    ...GUIDE_DOCTRINE.frameworks.map((f) => ({
      heading: f.name,
      content: `${f.whenToUse}\n\nKey questions:\n${f.keyQuestions.map((q) => `- ${q}`).join('\n')}`,
    })),
    { heading: 'Evidence standard', content: GUIDE_DOCTRINE.evidenceStandard },
    {
      heading: 'Red lines and escalation',
      content:
        `Red lines:\n${GUIDE_DOCTRINE.redLines.map((r) => `- ${r}`).join('\n')}\n\n` +
        `Escalate to a human for:\n${GUIDE_DOCTRINE.escalationTopics.map((t) => `- ${t}`).join('\n')}\n\n` +
        `Referral destinations:\n${GUIDE_DOCTRINE.referralDestinations.map((d) => `- ${d}`).join('\n')}`,
    },
  ];
  const corpora = [
    {
      sourceId: programSourceId,
      scope: 'program',
      personaId: null,
      title: PROGRAM_METHOD_SOURCE.title,
      owner: PROGRAM_METHOD_SOURCE.owner,
      sections: PROGRAM_METHOD_SOURCE.chunks,
    },
    {
      sourceId: doctrineSourceId,
      scope: 'persona',
      personaId,
      title: 'Foundry Guide doctrine (release v1)',
      owner: 'Program office',
      sections: doctrineChunks,
    },
  ];
  for (const corpus of corpora) {
    await insertSourceWithChunks(sx, {
      sourceColumns: {
        id: 'uuid',
        tenant_id: 'uuid',
        scope: 'text',
        persona_id: 'uuid',
        title: 'text',
        owner: 'text',
        classification: 'text',
        created_by: 'uuid',
        // Authored notes once 0004 is applied (before it, sources have no kind or body).
        ...(veirSchema ? ({ kind: 'text', body: 'text' } as const) : {}),
      },
      source: {
        id: corpus.sourceId,
        tenant_id: tenantId,
        scope: corpus.scope,
        persona_id: corpus.personaId,
        title: corpus.title,
        owner: corpus.owner,
        classification: 'program_internal',
        created_by: approver,
        ...(veirSchema ? { kind: 'note', body: bodyFromSections(corpus.sections) } : {}),
      },
      chunkColumns: {
        source_id: 'uuid',
        tenant_id: 'uuid',
        scope: 'text',
        persona_id: 'uuid',
        ordinal: 'integer',
        heading: 'text',
        content: 'text',
        token_count: 'integer',
      },
      chunks: corpus.sections.map((c, i) => ({
        source_id: corpus.sourceId,
        tenant_id: tenantId,
        scope: corpus.scope,
        persona_id: corpus.personaId,
        ordinal: i + 1,
        heading: c.heading,
        content: c.content,
        token_count: Math.ceil(c.content.length / 4),
      })),
    });
  }

  if (demo) {
    const now = config.now ?? new Date();
    const day = dayFn(now);
    const seedVentures = buildSeedVentures(day);
    for (const v of seedVentures)
      ventures.push(await seedVenture(sx, { v, tenantId, id, principals, personaId, approver }));
    await seedResources(sx, { tenantId, id, ownerOrLead: approver });
    if (veirSchema) {
      const result = await seedVeirs(sx, {
        tenantId,
        id,
        principals,
        eirs: SEED_EIRS,
        guidePersonaId: personaId,
        approver,
        ventures,
        memoryIds: Object.fromEntries(ventures.map((v) => [v.key, v.memoryIds])),
        day,
        now,
      });
      veirs = result.veirs;
      ventures = ventures.map((v) => {
        const active = result.assignments[v.key];
        const veir = active ? result.veirs.find((x) => x.personaId === active.personaId) : undefined;
        return active && veir
          ? { ...v, assignmentId: active.id, personaId: active.personaId, eirKey: veir.eirKey }
          : v;
      });
    }
  }

  return { tenantId, ownerId, programLeadId, personaId, releaseId, principals, eirs, ventures, veirs };
}

async function bindOwnerCode(
  sx: SystemExecutor,
  args: { ownerId: string; codeId: string; prefix: string; hash: string },
): Promise<void> {
  // A revoked deploy code stays revoked (rotate by deploying a new prefix/hash); the hash follows config.
  await sx.query(
    `INSERT INTO access_codes (id, principal_id, code_prefix, code_hash, label)
     VALUES (:id, :owner, :prefix, :hash, 'owner (deploy)')
     ON CONFLICT (code_prefix) DO UPDATE SET code_hash = EXCLUDED.code_hash
       WHERE access_codes.principal_id = EXCLUDED.principal_id AND access_codes.revoked_at IS NULL`,
    {
      id: p.uuid(args.codeId),
      owner: p.uuid(args.ownerId),
      prefix: p.text(args.prefix),
      hash: p.text(args.hash),
    },
  );
  const holder = await sx.query('SELECT principal_id FROM access_codes WHERE code_prefix = :prefix', {
    prefix: p.text(args.prefix),
  });
  const row = holder.rows[0];
  if (!row || col.uuid.decode(row.principal_id, 'principal_id') !== args.ownerId) {
    throw new SqlUsageError(
      'OWNER_ACCESS_CODE_PREFIX is already used by another principal; issue a new owner code',
    );
  }
  // Older deploy codes of the owner are retired when the configured prefix changes.
  await sx.query(
    `UPDATE access_codes SET revoked_at = now()
     WHERE principal_id = :owner AND label = 'owner (deploy)' AND code_prefix <> :prefix AND revoked_at IS NULL`,
    { owner: p.uuid(args.ownerId), prefix: p.text(args.prefix) },
  );
}

async function seedVenture(
  sx: SystemExecutor,
  args: {
    v: SeedVenture;
    tenantId: string;
    id: (...parts: string[]) => string;
    principals: Readonly<Record<string, string>>;
    personaId: string;
    approver: string | null;
  },
): Promise<SeededVenture> {
  const { v, tenantId, id, principals } = args;
  const ventureId = id('venture', v.key);
  const canary = ventureCanary(v.key);
  const person = (key: string): string => {
    const value = principals[key];
    if (!value) throw new SqlUsageError(`seed references unknown person ${key}`);
    return value;
  };

  await insertRows(
    sx,
    'ventures',
    {
      id: 'uuid',
      tenant_id: 'uuid',
      name: 'text',
      one_liner: 'text',
      stage: 'text',
      domain: 'text',
      cohort: 'text',
      classification: 'text',
      current_goal: 'text',
    },
    [
      {
        id: ventureId,
        tenant_id: tenantId,
        name: v.name,
        one_liner: v.oneLiner,
        stage: v.stage,
        domain: v.domain,
        cohort: v.cohort,
        classification: 'synthetic',
        current_goal: v.currentGoal,
      },
    ],
  );
  await insertRows(
    sx,
    'venture_memberships',
    { id: 'uuid', venture_id: 'uuid', principal_id: 'uuid', role: 'text', granted_by: 'uuid' },
    v.members.map((m) => ({
      id: id('membership', v.key, m.person),
      venture_id: ventureId,
      principal_id: person(m.person),
      role: m.role,
      granted_by: args.approver,
    })),
  );
  const assignmentId = id('assignment', v.key, 'v1');
  await insertRows(
    sx,
    'assignments',
    {
      id: 'uuid',
      tenant_id: 'uuid',
      venture_id: 'uuid',
      persona_id: 'uuid',
      eir_profile_id: 'uuid',
      created_by: 'uuid',
    },
    [
      {
        id: assignmentId,
        tenant_id: tenantId,
        venture_id: ventureId,
        persona_id: args.personaId,
        eir_profile_id: id('eir-profile', v.eir),
        created_by: args.approver,
      },
    ],
  );

  // Documents → knowledge sources → chunks (no embeddings; backfilled later).
  const documentIds: string[] = [];
  for (const doc of v.documents) {
    const docId = id('document', v.key, doc.key);
    const sourceId = id('knowledge-source', v.key, doc.key);
    documentIds.push(docId);
    const sections = documentText(doc, doc.canary ? canary : null);
    const fullText = sections.map((s) => `## ${s.heading}\n\n${s.content}`).join('\n\n');
    // A document the founder deleted keeps its withdrawn source without chunks.
    await insertSourceWithChunks(sx, {
      sourceColumns: {
        id: 'uuid',
        tenant_id: 'uuid',
        scope: 'text',
        venture_id: 'uuid',
        title: 'text',
        owner: 'text',
        classification: 'text',
        created_by: 'uuid',
      },
      source: {
        id: sourceId,
        tenant_id: tenantId,
        scope: 'venture',
        venture_id: ventureId,
        title: doc.title,
        owner: v.name,
        classification: 'synthetic',
        created_by: person(doc.uploadedBy),
      },
      chunkColumns: {
        source_id: 'uuid',
        tenant_id: 'uuid',
        scope: 'text',
        venture_id: 'uuid',
        ordinal: 'integer',
        heading: 'text',
        content: 'text',
        token_count: 'integer',
      },
      chunks: sections.map((s, i) => ({
        source_id: sourceId,
        tenant_id: tenantId,
        scope: 'venture',
        venture_id: ventureId,
        ordinal: i + 1,
        heading: s.heading,
        content: s.content,
        token_count: Math.ceil(s.content.length / 4),
      })),
    });
    await insertRows(
      sx,
      'documents',
      {
        id: 'uuid',
        tenant_id: 'uuid',
        venture_id: 'uuid',
        filename: 'text',
        content_type: 'text',
        size_bytes: 'integer',
        s3_key: 'text',
        status: 'text',
        source_id: 'uuid',
        uploaded_by: 'uuid',
      },
      [
        {
          id: docId,
          tenant_id: tenantId,
          venture_id: ventureId,
          filename: doc.filename,
          content_type: 'text/markdown',
          size_bytes: Buffer.byteLength(fullText, 'utf8'),
          s3_key: `seed/tenants/${tenantId}/ventures/${ventureId}/documents/${docId}/${doc.filename}`,
          status: 'ready',
          source_id: sourceId,
          uploaded_by: person(doc.uploadedBy),
        },
      ],
    );
  }

  // Memory (+ one creation event per newly inserted item).
  const memoryIds: Record<string, string> = {};
  const memoryRows = v.memory.map((m) => {
    const memoryId = id('memory', v.key, m.key);
    memoryIds[m.key] = memoryId;
    const author = person(m.author);
    // Founder approval: AI/EIR items stay proposed unless confirmed by a founder of the venture.
    const firstFounder = v.members.find((x) => x.role === 'founder')?.person ?? m.author;
    const approved = m.status === 'confirmed' || m.status === 'disputed';
    const approvedBy = approved ? (m.origin === 'founder' ? author : person(firstFounder)) : null;
    return {
      id: memoryId,
      tenant_id: tenantId,
      venture_id: ventureId,
      type: m.type,
      title: m.title,
      content: m.canary ? `${m.content} ${canary}` : m.content,
      attributes: m.attributes,
      status: m.status,
      visibility: m.visibility,
      confidence: m.confidence,
      source_refs: [{ kind: 'manual', id: 'seed', label: 'Synthetic seed data' }],
      origin: m.origin,
      created_by: author,
      approved_by: approvedBy,
      approved_at: approvedBy ? new Date().toISOString() : null,
      pinned: m.pinned ?? false,
    };
  });
  await sx.query(
    `WITH ins AS (
       INSERT INTO memory_objects (id, tenant_id, venture_id, type, title, content, attributes, status, visibility,
                                   confidence, source_refs, origin, created_by, approved_by, approved_at, pinned)
       SELECT id, tenant_id, venture_id, type, title, content, attributes, status, visibility, confidence, source_refs,
              origin, created_by, approved_by, approved_at, pinned
       FROM jsonb_to_recordset(:rows) AS x (id uuid, tenant_id uuid, venture_id uuid, type text, title text, content text,
            attributes jsonb, status text, visibility text, confidence numeric, source_refs jsonb, origin text,
            created_by uuid, approved_by uuid, approved_at timestamptz, pinned boolean)
       ON CONFLICT DO NOTHING
       RETURNING id, venture_id, created_by, status, origin, type)
     INSERT INTO memory_events (memory_id, venture_id, actor_id, action, diff)
     SELECT id, venture_id, created_by, CASE WHEN status = 'proposed' THEN 'proposed' ELSE 'created' END,
            jsonb_build_object('status', status, 'origin', origin, 'type', type, 'seed', true)
     FROM ins`,
    { rows: p.json(memoryRows) },
  );

  if (v.escalation) {
    const e = v.escalation;
    const creator = person(e.createdBy);
    await insertRows(
      sx,
      'escalations',
      {
        id: 'uuid',
        tenant_id: 'uuid',
        venture_id: 'uuid',
        category: 'text',
        priority: 'text',
        status: 'text',
        requested_role: 'text',
        packet: 'jsonb',
        created_by: 'uuid',
        sharing_consent_at: 'timestamptz',
        sharing_consent_by: 'uuid',
      },
      [
        {
          id: id('escalation', v.key, e.key),
          tenant_id: tenantId,
          venture_id: ventureId,
          category: e.category,
          priority: e.priority,
          // Consented without an assignee: waiting in the program team's routing queue.
          status: e.consented ? 'awaiting_assignment' : 'awaiting_consent',
          requested_role: 'specialist',
          packet: e.packet,
          created_by: creator,
          sharing_consent_at: e.consented ? new Date().toISOString() : null,
          sharing_consent_by: e.consented ? creator : null,
        },
      ],
    );
  }

  return {
    key: v.key,
    id: ventureId,
    name: v.name,
    canary,
    members: v.members.map((m) => ({ key: m.person, principalId: person(m.person), role: m.role })),
    eirKey: v.eir,
    assignmentId,
    personaId: args.personaId,
    documentIds,
    memoryIds,
  };
}

async function seedResources(
  sx: SystemExecutor,
  args: { tenantId: string; id: (...parts: string[]) => string; ownerOrLead: string | null },
): Promise<void> {
  await insertRows(
    sx,
    'resources',
    {
      id: 'uuid',
      tenant_id: 'uuid',
      name: 'text',
      kind: 'text',
      description: 'text',
      tags: 'text[]',
      stages: 'text[]',
      eligibility: 'text',
      owner: 'text',
    },
    SEED_RESOURCES.map((r) => ({
      id: args.id('resource', r.key),
      tenant_id: args.tenantId,
      name: r.name,
      kind: r.kind,
      description: r.description,
      tags: r.tags,
      stages: r.stages,
      eligibility: r.eligibility,
      owner: r.owner,
    })),
  );
  await insertRows(
    sx,
    'patterns',
    {
      id: 'uuid',
      tenant_id: 'uuid',
      title: 'text',
      context: 'text',
      signal: 'text',
      intervention: 'text',
      outcome: 'text',
      limits: 'text',
      source_class: 'text',
      status: 'text',
      owner_id: 'uuid',
    },
    SEED_PATTERNS.map((pt) => ({
      id: args.id('pattern', pt.key),
      tenant_id: args.tenantId,
      title: pt.title,
      context: pt.context,
      signal: pt.signal,
      intervention: pt.intervention,
      outcome: pt.outcome,
      limits: pt.limits,
      source_class: 'synthetic',
      status: 'published',
      owner_id: args.ownerOrLead,
    })),
  );
}

/**
 * Seed configuration from the runtime contract: HOME_TENANT_SLUG, HOME_TENANT_NAME, OWNER_DISPLAY_NAME,
 * OWNER_ACCESS_CODE_PREFIX, OWNER_ACCESS_CODE_HASH. The owner is omitted when prefix/hash are unset
 * (allowed outside production only).
 */
export function seedConfigFromEnv(env: EnvLike = process.env): SeedConfig {
  const prefix = env.OWNER_ACCESS_CODE_PREFIX?.trim();
  const hash = env.OWNER_ACCESS_CODE_HASH?.trim();
  if (env.APP_ENV === 'production' && (!prefix || !hash)) {
    throw new SqlUsageError('OWNER_ACCESS_CODE_PREFIX and OWNER_ACCESS_CODE_HASH are required in production');
  }
  const value = (name: string): string | undefined => {
    const v = env[name]?.trim();
    return v === undefined || v === '' ? undefined : v;
  };
  return {
    homeTenant: {
      slug: value('HOME_TENANT_SLUG') ?? 'ain',
      name: value('HOME_TENANT_NAME') ?? 'Ain Foundry',
    },
    owner:
      prefix && hash
        ? {
            displayName: value('OWNER_DISPLAY_NAME') ?? 'Platform Owner',
            accessCodePrefix: prefix,
            accessCodeHash: hash,
          }
        : null,
  };
}
