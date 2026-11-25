import {
  PathIntake,
  PathStepView,
  PathStepStatus,
  VentureStage,
  type CriterionStatus,
} from '@foundry/contracts';
import { z } from 'zod';

import { col, type RawRow } from '../columns.js';
import { type SqlExecutor } from '../executor.js';
import { p } from '../params.js';
import { firstPart, queryFirst, queryRows, readPart, rowsPart, type ReadPart } from './common.js';

/**
 * The founder path's rows (migration 0033): the venture's stage and intake, its steps, and what it has shown. What they
 * mean is decided in core `path/`; nothing here chooses a step.
 */
type Stage = z.infer<typeof VentureStage>;
type StepStatus = z.infer<typeof PathStepStatus>;
type IntakeValue = z.infer<typeof PathIntake>;
type StepOrigin = PathStepView['origin'];
export type PathStepItem = PathStepView['items'][number];

/** A change of the idea: the day, the idea it was and the one it is, in the founder's own words ('' once erased). */
export interface PathPivot {
  readonly on: string;
  readonly from: string;
  readonly to: string;
  readonly sessionId: string | null;
}

export interface PathRecord {
  readonly ventureId: string;
  readonly stage: Stage;
  readonly intake: IntakeValue | null;
  readonly intakeBy: string | null;
  /** Changes of the idea, oldest first. */
  readonly pivots: readonly PathPivot[];
  readonly playbookVersion: string;
  readonly version: number;
}

export interface PathStepRecord {
  readonly id: string;
  readonly playId: string | null;
  readonly criterionId: string | null;
  readonly title: string;
  readonly items: PathStepItem[];
  readonly doneWhen: string;
  readonly dueOn: string | null;
  readonly status: StepStatus;
  readonly origin: StepOrigin;
  readonly evidence: string | null;
  readonly reason: string | null;
  readonly template: PathStepView['template'];
  readonly citations: PathStepView['citations'];
  readonly givenTo: string | null;
  readonly sourceSessionId: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly version: number;
}

export interface PathCriterionRecord {
  readonly criterionId: string;
  readonly status: CriterionStatus;
  readonly evidence: string | null;
  readonly stepId: string | null;
  /** The conversation its words were said in. */
  readonly sourceSessionId: string | null;
  readonly updatedAt: string;
}

/** A memory object as the path reads it: short, shared with the team, never a deleted or rejected one. */
export interface PathMemory {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly content: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly status: string;
  readonly origin: string;
  readonly pinned: boolean;
  readonly createdAt: string;
}

const Items = z.array(
  z.object({ do: z.string(), how: z.string(), minutes: z.number().int().nullable(), done: z.boolean() }),
);
const Template = PathStepView.shape.template;
const Citations = PathStepView.shape.citations;
const Pivots = z.array(
  z.object({ on: z.string(), from: z.string(), to: z.string(), sessionId: z.string().nullable() }),
);

function jsonOr<T>(schema: z.ZodType<T>, raw: unknown, column: string, otherwise: T): T {
  const value = col.json().nullable.decode(raw, column);
  if (value === null) return otherwise;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : otherwise;
}

function decodePath(r: RawRow): PathRecord {
  return {
    ventureId: col.uuid.decode(r.venture_id, 'venture_id'),
    stage: col.enum(VentureStage.options).decode(r.stage, 'stage'),
    intake: jsonOr<IntakeValue | null>(PathIntake, r.intake, 'intake', null),
    intakeBy: col.uuid.nullable.decode(r.intake_by, 'intake_by'),
    pivots: jsonOr<PathPivot[]>(Pivots, r.pivots, 'pivots', []),
    playbookVersion: col.text.decode(r.playbook_version, 'playbook_version'),
    version: col.int.decode(r.version, 'version'),
  };
}

function decodeStep(r: RawRow): PathStepRecord {
  return {
    id: col.uuid.decode(r.id, 'id'),
    playId: col.text.nullable.decode(r.play_id, 'play_id'),
    criterionId: col.text.nullable.decode(r.criterion_id, 'criterion_id'),
    title: col.text.decode(r.title, 'title'),
    items: jsonOr(Items, r.items, 'items', []),
    doneWhen: col.text.decode(r.done_when, 'done_when'),
    dueOn: col.date.nullable.decode(r.due_on, 'due_on'),
    status: col.enum(PathStepStatus.options).decode(r.status, 'status'),
    origin: col.enum(['path', 'founder', 'coach'] as const).decode(r.origin, 'origin'),
    evidence: col.text.nullable.decode(r.evidence, 'evidence'),
    reason: col.text.nullable.decode(r.reason, 'reason'),
    template: jsonOr<PathStepView['template']>(Template, r.template, 'template', null),
    citations: jsonOr(Citations, r.citations, 'citations', []),
    givenTo: col.uuid.nullable.decode(r.given_to, 'given_to'),
    sourceSessionId: col.uuid.nullable.decode(r.source_session_id, 'source_session_id'),
    createdAt: col.ts.decode(r.created_at, 'created_at'),
    completedAt: col.ts.nullable.decode(r.completed_at, 'completed_at'),
    version: col.int.decode(r.version, 'version'),
  };
}

const PATH_COLUMNS = `pa.venture_id, pa.stage, pa.intake, pa.intake_by, pa.pivots, pa.playbook_version, pa.version`;
const STEP_COLUMNS = `s.id, s.play_id, s.criterion_id, s.title, s.items, s.done_when, s.due_on::text AS due_on, s.status,
  s.origin, s.evidence, s.reason, s.citations, s.given_to, s.source_session_id, s.created_at, s.completed_at, s.version`;

/** The path's row (null: the venture has none yet, and is read as its record says). */
export function pathPart(ventureId: string): ReadPart<PathRecord | null> {
  return firstPart(
    `SELECT ${PATH_COLUMNS}
     FROM venture_paths pa WHERE pa.venture_id = :ventureId AND pa.tenant_id = app.current_tenant()`,
    { ventureId: p.uuid(ventureId) },
    decodePath,
  );
}

/** Steps read with a path: every open one and the latest closed ones (a template only of an open step: it is long). */
const MAX_STEPS = 60;
export function stepsPart(ventureId: string): ReadPart<PathStepRecord[]> {
  return rowsPart(
    `SELECT ${STEP_COLUMNS},
            CASE WHEN s.status IN ('done', 'skipped') THEN NULL ELSE s.template END AS template
     FROM path_steps s
     WHERE s.venture_id = :ventureId AND s.tenant_id = app.current_tenant()
     ORDER BY (s.status IN ('done', 'skipped')), s.created_at DESC, s.id LIMIT :most`,
    { ventureId: p.uuid(ventureId), most: p.int(MAX_STEPS) },
    decodeStep,
  );
}

export function criteriaPart(ventureId: string): ReadPart<PathCriterionRecord[]> {
  return rowsPart(
    `SELECT c.criterion_id, c.status, c.evidence, c.step_id, c.source_session_id, c.updated_at
     FROM path_criteria c WHERE c.venture_id = :ventureId AND c.tenant_id = app.current_tenant()
     ORDER BY c.criterion_id LIMIT 60`,
    { ventureId: p.uuid(ventureId) },
    (r) => ({
      criterionId: col.text.decode(r.criterion_id, 'criterion_id'),
      status: col.enum(['open', 'claimed', 'met'] as const).decode(r.status, 'status'),
      evidence: col.text.nullable.decode(r.evidence, 'evidence'),
      stepId: col.uuid.nullable.decode(r.step_id, 'step_id'),
      sourceSessionId: col.uuid.nullable.decode(r.source_session_id, 'source_session_id'),
      updatedAt: col.ts.decode(r.updated_at, 'updated_at'),
    }),
  );
}

const MAX_MEMORY = 50;
/** Attributes the path reads (dates, results, sizes, states): a whole attribute object is never needed. */
const MEMORY_ATTRIBUTES = [
  'decided_on',
  'collected_on',
  'completed_on',
  'target_date',
  'due',
  'status',
  'result',
  'n',
  'sample_size',
  'success_criteria',
];

/**
 * The venture's live memory, short: what its team shares (never a founder's private item), most telling kinds first.
 * RLS decides what the caller may see of it.
 */
export function memoryPart(ventureId: string): ReadPart<PathMemory[]> {
  return rowsPart(
    `SELECT m.id, m.type, m.title, left(m.content, 280) AS content, m.status, m.origin, m.pinned, m.created_at,
            coalesce((SELECT jsonb_object_agg(a.key, CASE WHEN jsonb_typeof(a.value) = 'string'
                                                          THEN to_jsonb(left(a.value #>> '{}', 200)) ELSE a.value END)
                      FROM jsonb_each(m.attributes) a
                      WHERE a.key = ANY (:attributes)
                        AND jsonb_typeof(a.value) IN ('string', 'number', 'boolean')), '{}'::jsonb) AS attributes
     FROM memory_objects m
     WHERE m.venture_id = :ventureId AND m.tenant_id = app.current_tenant()
       AND m.status IN ('confirmed', 'proposed') AND m.visibility <> 'founder_private'
       AND m.type IN ('fact', 'hypothesis', 'decision', 'experiment', 'evidence', 'milestone', 'risk', 'insight', 'relationship')
       AND (m.expires_at IS NULL OR m.expires_at > now())
     ORDER BY (m.status = 'confirmed') DESC,
              array_position(ARRAY['decision', 'evidence', 'experiment', 'milestone', 'fact', 'relationship', 'insight', 'risk', 'hypothesis'], m.type),
              m.pinned DESC, m.created_at DESC, m.id
     LIMIT :most`,
    {
      ventureId: p.uuid(ventureId),
      most: p.int(MAX_MEMORY),
      attributes: p.textArray(MEMORY_ATTRIBUTES),
    },
    (r) => ({
      id: col.uuid.decode(r.id, 'id'),
      type: col.text.decode(r.type, 'type'),
      title: col.text.decode(r.title, 'title'),
      content: col.text.decode(r.content, 'content'),
      attributes: jsonOr<Record<string, unknown>>(
        z.record(z.string(), z.unknown()),
        r.attributes,
        'attributes',
        {},
      ),
      status: col.text.decode(r.status, 'status'),
      origin: col.text.decode(r.origin, 'origin'),
      pinned: col.bool.decode(r.pinned, 'pinned'),
      createdAt: col.ts.decode(r.created_at, 'created_at'),
    }),
  );
}

/** What a turn reads of the path, folded into its context statement (`turn-context.ts`). */
export interface PathReads {
  readonly path: PathRecord | null;
  readonly steps: readonly PathStepRecord[];
  readonly criteria: readonly PathCriterionRecord[];
  readonly memory: readonly PathMemory[];
}

/** Every part of {@link PathReads}, for one statement (`readTogether`) with other reads; {@link pathReadsFrom} folds it. */
export function pathParts(ventureId: string) {
  return {
    pathRow: pathPart(ventureId),
    pathSteps: stepsPart(ventureId),
    pathCriteria: criteriaPart(ventureId),
    pathMemory: memoryPart(ventureId),
  };
}
export function pathReadsFrom(reads: {
  readonly pathRow: PathRecord | null;
  readonly pathSteps: readonly PathStepRecord[];
  readonly pathCriteria: readonly PathCriterionRecord[];
  readonly pathMemory: readonly PathMemory[];
}): PathReads {
  return {
    path: reads.pathRow,
    steps: reads.pathSteps,
    criteria: reads.pathCriteria,
    memory: reads.pathMemory,
  };
}

/** The venture's current step as a check-in names it (an opening): the open `now` step, latest first. */
export function nowStepPart(ventureId: string): ReadPart<PathStepRecord | null> {
  return firstPart(
    `SELECT ${STEP_COLUMNS}, NULL::jsonb AS template
     FROM path_steps s
     WHERE s.venture_id = :ventureId AND s.tenant_id = app.current_tenant() AND s.status = 'now'
     ORDER BY s.created_at, s.id LIMIT 1`,
    { ventureId: p.uuid(ventureId) },
    decodeStep,
  );
}
export const getNowStep = (ex: SqlExecutor, ventureId: string) => readPart(ex, nowStepPart(ventureId));

export function getStep(ex: SqlExecutor, id: string): Promise<PathStepRecord | null> {
  return queryFirst(
    ex,
    `SELECT ${STEP_COLUMNS}, s.template FROM path_steps s
     WHERE s.id = :id AND s.tenant_id = app.current_tenant()`,
    { id: p.uuid(id) },
    decodeStep,
  );
}

/**
 * The step a turn of the venture showed under its reply, as it was shown (`turns.guidance`): what an offered step is
 * stored from when the founder takes it. Null: no turn the caller may read showed it.
 */
export function shownStep(ex: SqlExecutor, ventureId: string, stepId: string): Promise<PathStepView | null> {
  return queryFirst(
    ex,
    `SELECT t.guidance -> 'step' AS step FROM turns t
     WHERE t.venture_id = :ventureId AND t.tenant_id = app.current_tenant()
       AND t.guidance -> 'step' ->> 'id' = :stepId
     ORDER BY t.created_at DESC LIMIT 1`,
    { ventureId: p.uuid(ventureId), stepId: p.text(stepId) },
    (r) => jsonOr<PathStepView | null>(PathStepView.nullable(), r.step, 'step', null),
  );
}

// ------------------------------------------------------------------------------------------------
// Writes
// ------------------------------------------------------------------------------------------------

/** The path's row when the venture has none (an existing one is left as it is). */
export async function ensurePath(
  ex: SqlExecutor,
  args: { tenantId: string; ventureId: string; stage: Stage; playbookVersion: string },
): Promise<void> {
  await ex.query(
    `INSERT INTO venture_paths (venture_id, tenant_id, stage, playbook_version)
     VALUES (:ventureId, :tenantId, :stage, :playbook) ON CONFLICT (venture_id) DO NOTHING`,
    {
      ventureId: p.uuid(args.ventureId),
      tenantId: p.uuid(args.tenantId),
      stage: p.text(args.stage),
      playbook: p.text(args.playbookVersion),
    },
  );
}

/** Moves the stage forward (never back: `order` is the stages in order); the version counts it. */
export async function advanceStage(
  ex: SqlExecutor,
  args: { ventureId: string; stage: Stage; order: readonly Stage[]; playbookVersion: string },
): Promise<boolean> {
  const result = await ex.query(
    `UPDATE venture_paths SET stage = :stage, playbook_version = :playbook, version = version + 1, updated_at = now()
     WHERE venture_id = :ventureId
       AND array_position(:order, :stage) > array_position(:order, stage)`,
    {
      ventureId: p.uuid(args.ventureId),
      stage: p.text(args.stage),
      playbook: p.text(args.playbookVersion),
      order: p.textArray(args.order),
    },
  );
  return result.rowCount > 0;
}

/**
 * Saves the intake when the path is still at `expectedVersion` (the version the person read). Null: it changed since.
 * A venture without a row is read as version 1, so its first save expects 1 (or 0) and creates it at version 2.
 */
export function saveIntake(
  ex: SqlExecutor,
  args: {
    tenantId: string;
    ventureId: string;
    principalId: string;
    stage: Stage;
    playbookVersion: string;
    intake: IntakeValue;
    expectedVersion: number;
  },
): Promise<PathRecord | null> {
  return queryFirst(
    ex,
    `INSERT INTO venture_paths AS pa (venture_id, tenant_id, stage, playbook_version, intake, intake_by, intake_at, version)
     VALUES (:ventureId, :tenantId, :stage, :playbook, :intake, :by, now(), 2)
     ON CONFLICT (venture_id) DO UPDATE
       SET intake = :intake, intake_by = :by, intake_at = now(), idea_session_id = NULL, version = pa.version + 1, updated_at = now()
       WHERE pa.version = :expected
     RETURNING ${PATH_COLUMNS}`,
    {
      ventureId: p.uuid(args.ventureId),
      tenantId: p.uuid(args.tenantId),
      stage: p.text(args.stage),
      playbook: p.text(args.playbookVersion),
      intake: p.json(args.intake),
      by: p.uuid(args.principalId),
      expected: p.int(Math.max(1, args.expectedVersion)),
    },
    decodePath,
  );
}

/** An intake with nothing in it: what a venture's first kept idea is added to. */
const EMPTY_INTAKE: IntakeValue = PathIntake.parse({});

/**
 * Keeps the idea in the founder's own words when the intake has none yet (one they wrote, or said before, stays). True
 * when it was kept.
 */
export async function keepIdea(
  ex: SqlExecutor,
  args: {
    tenantId: string;
    ventureId: string;
    principalId: string;
    stage: Stage;
    playbookVersion: string;
    idea: string;
    sessionId: string;
  },
): Promise<boolean> {
  const result = await ex.query(
    `INSERT INTO venture_paths AS pa (venture_id, tenant_id, stage, playbook_version, intake, intake_by, intake_at,
                                      idea_session_id, version)
     VALUES (:ventureId, :tenantId, :stage, :playbook, :intake, :by, now(), :session, 2)
     ON CONFLICT (venture_id) DO UPDATE
       SET intake = jsonb_set(coalesce(pa.intake, CAST(:intake AS jsonb)), '{idea}', to_jsonb(CAST(:idea AS text))),
           intake_by = coalesce(pa.intake_by, :by), intake_at = now(), idea_session_id = :session,
           version = pa.version + 1, updated_at = now()
       WHERE coalesce(pa.intake ->> 'idea', '') = ''`,
    {
      ventureId: p.uuid(args.ventureId),
      tenantId: p.uuid(args.tenantId),
      stage: p.text(args.stage),
      playbook: p.text(args.playbookVersion),
      intake: p.json({ ...EMPTY_INTAKE, idea: args.idea }),
      idea: p.text(args.idea),
      by: p.uuid(args.principalId),
      session: p.uuid(args.sessionId),
    },
  );
  return result.rowCount > 0;
}

/** Most changes of the idea kept (the latest ones). */
const MAX_PIVOTS = 20;

/**
 * Changes the idea: the new one in the founder's words, the old one kept as a dated pivot, and the stage the path stands
 * at now (the one place a path goes back: what the old customer showed does not carry).
 */
export async function keepPivot(
  ex: SqlExecutor,
  args: {
    tenantId: string;
    ventureId: string;
    principalId: string;
    stage: Stage;
    playbookVersion: string;
    pivot: PathPivot;
    /** The idea alone, when the pivot's words say more than it ("back to the jars. A shop lends us its sink"). */
    idea?: string;
    sessionId: string;
  },
): Promise<void> {
  await ex.query(
    `INSERT INTO venture_paths AS pa (venture_id, tenant_id, stage, playbook_version, intake, intake_by, intake_at,
                                      idea_session_id, pivots, version)
     VALUES (:ventureId, :tenantId, :stage, :playbook, :intake, :by, now(), :session, CAST(:pivots AS jsonb), 2)
     ON CONFLICT (venture_id) DO UPDATE
       SET intake = jsonb_set(coalesce(pa.intake, CAST(:intake AS jsonb)), '{idea}', to_jsonb(CAST(:idea AS text))),
           idea_session_id = :session, stage = :stage, playbook_version = :playbook,
           pivots = CASE WHEN jsonb_array_length(pa.pivots) >= :most THEN (pa.pivots - 0) ELSE pa.pivots END
                    || CAST(:pivots AS jsonb),
           version = pa.version + 1, updated_at = now()`,
    {
      ventureId: p.uuid(args.ventureId),
      tenantId: p.uuid(args.tenantId),
      stage: p.text(args.stage),
      playbook: p.text(args.playbookVersion),
      intake: p.json({ ...EMPTY_INTAKE, idea: args.idea ?? args.pivot.to }),
      idea: p.text(args.idea ?? args.pivot.to),
      by: p.uuid(args.principalId),
      session: p.uuid(args.sessionId),
      pivots: p.json([args.pivot]),
      most: p.int(MAX_PIVOTS),
    },
  );
}

export interface InsertStepInput {
  readonly tenantId: string;
  readonly ventureId: string;
  readonly step: Pick<
    PathStepRecord,
    | 'id'
    | 'playId'
    | 'criterionId'
    | 'title'
    | 'items'
    | 'doneWhen'
    | 'dueOn'
    | 'status'
    | 'origin'
    | 'template'
    | 'citations'
  >;
  readonly givenTo: string | null;
  /** The conversation a step in the founder's own words was said in (a program's step has none). */
  readonly givenSessionId?: string | null;
}

/** The step, unless it is already there (its id is derived: two turns that give it at once insert one row). */
export async function insertStep(ex: SqlExecutor, input: InsertStepInput): Promise<boolean> {
  const { step } = input;
  const result = await ex.query(
    `INSERT INTO path_steps (id, tenant_id, venture_id, play_id, criterion_id, title, items, done_when, due_on, status,
                             origin, template, citations, given_to, given_session_id)
     VALUES (:id, :tenantId, :ventureId, :playId, :criterionId, :title, :items, :doneWhen, CAST(:dueOn AS date), :status,
             :origin, :template, :citations, :givenTo, :givenSession)
     ON CONFLICT (id) DO NOTHING`,
    {
      id: p.uuid(step.id),
      tenantId: p.uuid(input.tenantId),
      ventureId: p.uuid(input.ventureId),
      playId: p.nullable.text(step.playId),
      criterionId: p.nullable.text(step.criterionId),
      title: p.text(step.title),
      items: p.json(step.items),
      doneWhen: p.text(step.doneWhen),
      dueOn: p.nullable.text(step.dueOn),
      status: p.text(step.status),
      origin: p.text(step.origin),
      template: p.nullable.json(step.template),
      citations: p.json(step.citations),
      givenTo: p.nullable.uuid(input.givenTo),
      givenSession: p.nullable.uuid(input.givenSessionId),
    },
  );
  return result.rowCount > 0;
}

/** Any other step that was `now` waits as `next` (there is one current step). */
export async function demoteOtherSteps(
  ex: SqlExecutor,
  args: { ventureId: string; keepId: string },
): Promise<void> {
  await ex.query(
    `UPDATE path_steps SET status = 'next', version = version + 1, updated_at = now()
     WHERE venture_id = :ventureId AND status = 'now' AND id <> :keep`,
    { ventureId: p.uuid(args.ventureId), keep: p.uuid(args.keepId) },
  );
}

export interface StepChange {
  readonly status?: StepStatus;
  readonly items?: readonly PathStepItem[];
  readonly doneWhen?: string;
  readonly dueOn?: string | null;
  readonly evidence?: string | null;
  readonly reason?: string | null;
  readonly givenTo?: string | null;
  readonly sourceSessionId?: string | null;
  /** Who finished it (status `done`). */
  readonly completedBy?: string | null;
}

/** Changes a step still at `expectedVersion`; null when it changed since (or is not visible). */
export function updateStep(
  ex: SqlExecutor,
  args: { id: string; expectedVersion: number; change: StepChange },
): Promise<PathStepRecord | null> {
  const { change } = args;
  const sets: string[] = ['version = version + 1', 'updated_at = now()'];
  const params: Record<string, ReturnType<typeof p.text>> = {
    id: p.uuid(args.id),
    expected: p.int(args.expectedVersion),
  };
  const set = (sql: string, name: string, param: ReturnType<typeof p.text>): void => {
    sets.push(sql);
    params[name] = param;
  };
  if (change.status !== undefined) {
    set('status = :status', 'status', p.text(change.status));
    if (change.status === 'done') {
      sets.push('completed_at = now()');
      set('completed_by = :completedBy', 'completedBy', p.nullable.uuid(change.completedBy));
    } else {
      sets.push('completed_at = NULL', 'completed_by = NULL');
    }
  }
  if (change.items !== undefined) set('items = :items', 'items', p.json(change.items));
  if (change.doneWhen !== undefined) set('done_when = :doneWhen', 'doneWhen', p.text(change.doneWhen));
  if (change.dueOn !== undefined)
    set('due_on = CAST(:dueOn AS date)', 'dueOn', p.nullable.text(change.dueOn));
  if (change.evidence !== undefined)
    set('evidence = :evidence', 'evidence', p.nullable.text(change.evidence));
  if (change.reason !== undefined) set('reason = :reason', 'reason', p.nullable.text(change.reason));
  if (change.givenTo !== undefined) set('given_to = :givenTo', 'givenTo', p.nullable.uuid(change.givenTo));
  if (change.sourceSessionId !== undefined)
    set('source_session_id = :source', 'source', p.nullable.uuid(change.sourceSessionId));
  return queryFirst(
    ex,
    `UPDATE path_steps AS s SET ${sets.join(', ')}
     WHERE s.id = :id AND s.version = :expected AND s.tenant_id = app.current_tenant()
     RETURNING ${STEP_COLUMNS}, s.template`,
    params,
    decodeStep,
  );
}

/**
 * What the venture has shown of a criterion. A claim never lowers one already met, and progress towards it (`open`, with
 * words) never lowers one claimed or met.
 */
export async function setCriterion(
  ex: SqlExecutor,
  args: {
    tenantId: string;
    ventureId: string;
    criterionId: string;
    status: CriterionStatus;
    evidence: string | null;
    stepId: string | null;
    sourceSessionId: string | null;
    principalId: string;
  },
): Promise<void> {
  await ex.query(
    `INSERT INTO path_criteria AS c (venture_id, criterion_id, tenant_id, status, evidence, step_id, source_session_id,
                                     updated_by, updated_at)
     VALUES (:ventureId, :criterionId, :tenantId, :status, :evidence, :stepId, :source, :by, now())
     ON CONFLICT (venture_id, criterion_id) DO UPDATE
       SET status = EXCLUDED.status, evidence = EXCLUDED.evidence, step_id = EXCLUDED.step_id,
           source_session_id = EXCLUDED.source_session_id, updated_by = EXCLUDED.updated_by, updated_at = now()
       WHERE NOT (EXCLUDED.status = 'claimed' AND c.status = 'met')
         AND NOT (EXCLUDED.status = 'open' AND EXCLUDED.evidence IS NOT NULL AND c.status <> 'open')`,
    {
      ventureId: p.uuid(args.ventureId),
      criterionId: p.text(args.criterionId),
      tenantId: p.uuid(args.tenantId),
      status: p.text(args.status),
      evidence: p.nullable.text(args.evidence),
      stepId: p.nullable.uuid(args.stepId),
      source: p.nullable.uuid(args.sourceSessionId),
      by: p.uuid(args.principalId),
    },
  );
}

// ------------------------------------------------------------------------------------------------
// A program lead's view
// ------------------------------------------------------------------------------------------------

const Overview = z.object({
  stage: VentureStage.nullable(),
  venture_stage: VentureStage,
  version: z.number().int().nullable(),
  criteria: z.array(z.object({ id: z.string(), status: z.enum(['open', 'claimed', 'met']) })),
  steps: z.array(
    z.object({
      id: z.string(),
      play_id: z.string().nullable(),
      criterion_id: z.string().nullable(),
      origin: z.enum(['path', 'founder', 'coach']),
      title: z.string(),
      due_on: z.string().nullable(),
      status: PathStepStatus,
      completed_at: z.string().nullable(),
      created_at: z.string(),
      version: z.number().int(),
    }),
  ),
});
export type PathOverview = z.infer<typeof Overview>;

/** The shape of a venture's path (`app.path_overview`): program leads only, never a founder's words. */
export async function pathOverview(ex: SqlExecutor, ventureId: string): Promise<PathOverview | null> {
  const rows = await queryRows(
    ex,
    'SELECT app.path_overview(:ventureId) AS overview',
    { ventureId: p.uuid(ventureId) },
    (r) => col.json().nullable.decode(r.overview, 'overview'),
  );
  const value = rows[0] ?? null;
  return value === null ? null : Overview.parse(value);
}
