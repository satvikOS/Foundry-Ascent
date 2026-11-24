/**
 * Coach releases the platform owner approved: which persona coaches the ventures of the home tenant, changed once in a
 * database that already holds other assignments (ADR-0021, amendment of 2026-11-24: founders meet Thomas everywhere).
 * Named in the same list as the persona and story releases (`SEED_OWNER_RELEASES`, production's
 * infra/cdk/config/production.json → `homeTenant.ownerReleases`; ./owner-releases.ts), and applied after both, so the
 * mentor exists and every seeded venture has its assignment.
 *
 * - The product's own reassignment (`POST /ventures/:id/assignment`, packages/core/src/services/personas.ts
 *   `assignVenture`): the old assignment ends, a new one starts with the persona's own EIR as the venture's reviewer
 *   and the release's modes (`assignmentsRepo.createAssignment`), audited the same (`assignment.created`). So who can
 *   see a venture's work changes exactly as it does when a program lead reassigns it, never more.
 * - Conversations already open stay on the assignment they started with, as after any reassignment: their next message
 *   is refused (`assignment_changed`) with a request to start a new conversation, a live call ends at its next
 *   heartbeat, crisis support still answers, and they stay readable.
 * - The venture's notebook carries over to the new coach's when it has none ({@link carryOverNotebook}); the old row
 *   stays as it is.
 * - Scoped: active ventures of the home tenant whose active assignment is to another seeded persona (a vEIR of
 *   ./veir-content.ts or the Foundry Guide). A persona created in the studio keeps its ventures; a paused or archived
 *   venture, a suspended or expired assignment and every other tenant are left alone.
 * - Once per database: the applied release is recorded in the audit trail (`program.coach_release_applied`), so a
 *   reassignment made in the product afterwards is never undone by a redeploy, and a venture given to another persona
 *   later is never moved. Nothing is deleted; reassigning a venture in the product undoes it.
 */
import { col } from '../columns.js';
import { SqlUsageError } from '../errors.js';
import { type SystemExecutor } from '../executor.js';
import { p } from '../params.js';
import { createAssignment } from '../repositories/assignments.js';
import { appendAudit } from '../repositories/audit.js';
import {
  MAX_SUMMARY_SOURCES,
  OPENER_EDIT,
  SUMMARY_EDIT,
  getNotebook,
  getNotebookMarks,
  type NotebookContent,
} from '../repositories/notebooks.js';
import { findMentorPersona } from '../repositories/personas.js';
import { SEED_VEIRS } from './veir-content.js';

export interface CoachRelease {
  /** The key `SEED_OWNER_RELEASES` names. */
  readonly key: string;
  /** The day the owner approved it (ISO date), as recorded in the ADR. */
  readonly approvedOn: string;
  /** Seed key of the EIR whose seeded persona coaches from then on; it must be presented as a mentor. */
  readonly eirKey: string;
}

/** Founders meet Thomas everywhere (ADR-0021, amendment of 2026-11-24). */
export const THOMAS_EVERYWHERE_RELEASE: CoachRelease = {
  key: 'thomas-everywhere-2026-11-24',
  approvedOn: '2026-11-24',
  eirKey: 'eir-corin',
};

export const COACH_RELEASES: readonly CoachRelease[] = [THOMAS_EVERYWHERE_RELEASE];

/** The audit action that records an applied coach release (the marker it is applied once by). */
export const COACH_RELEASE_ACTION = 'program.coach_release_applied';

export type CoachReleaseOutcome = 'applied' | 'present' | 'no_schema' | 'no_owner' | 'no_mentor';

export interface CoachReleaseResult {
  readonly key: string;
  readonly outcome: CoachReleaseOutcome;
  /** The persona that coaches from then on (deterministic id), whatever the outcome. */
  readonly personaId: string;
  /** Ventures reassigned on this run. */
  readonly ventures: number;
  /** Notebooks carried over on this run. */
  readonly notebooks: number;
}

/** The deterministic id of the assignment a coach release gives a venture. */
export function coachAssignmentId(
  release: Pick<CoachRelease, 'key'>,
  ventureId: string,
  id: (...parts: string[]) => string,
): string {
  return id('assignment', 'owner', release.key, ventureId);
}

/** Migration 0028 is applied (`personas.presentation`); notebooks (0004) came before it. */
async function hasPresentation(sx: SystemExecutor): Promise<boolean> {
  const result = await sx.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'personas' AND column_name = 'presentation')
            AS ready`,
  );
  return result.rows[0]?.ready === true;
}

/** Applies the coach releases `keys` names (see the module comment). */
export async function seedCoachReleases(
  sx: SystemExecutor,
  c: {
    readonly tenantId: string;
    readonly id: (...parts: string[]) => string;
    /** The seeded Foundry Guide of the tenant. */
    readonly guidePersonaId: string;
    /** The deploy owner (platform admin): who reassigns. Null: nothing is applied. */
    readonly ownerId: string | null;
    readonly keys: readonly string[];
    /** Where `keys` are looked up: the shipped releases. */
    readonly catalog?: readonly CoachRelease[];
  },
): Promise<CoachReleaseResult[]> {
  const results: CoachReleaseResult[] = [];
  const catalog = c.catalog ?? COACH_RELEASES;
  const ready = c.keys.length > 0 && (await hasPresentation(sx));
  for (const key of c.keys) {
    const release = catalog.find((r) => r.key === key);
    if (release === undefined) throw new SqlUsageError(`unknown coach release ${key.slice(0, 60)}`);
    const personaId = c.id('persona', 'veir', release.eirKey);
    const done = (outcome: CoachReleaseOutcome, ventures = 0, notebooks = 0): void => {
      results.push({ key, outcome, personaId, ventures, notebooks });
    };
    if (!ready) {
      done('no_schema');
      continue;
    }
    const applied = await sx.query(
      `SELECT 1 FROM audit_events
        WHERE action = :action AND tenant_id = :tenantId AND metadata ->> 'ownerRelease' = :key LIMIT 1`,
      { action: p.text(COACH_RELEASE_ACTION), tenantId: p.uuid(c.tenantId), key: p.text(key) },
    );
    if (applied.rows.length > 0) {
      done('present');
      continue;
    }
    if (c.ownerId === null) {
      done('no_owner');
      continue;
    }
    // The product's rule for an assignable persona (active, an approved release), and a mentor: never a twin.
    const mentor = await findMentorPersona(sx, { tenantId: c.tenantId, personaId });
    if (mentor === null) {
      done('no_mentor');
      continue;
    }

    const from = [
      c.guidePersonaId,
      ...SEED_VEIRS.filter((v) => v.eirKey !== release.eirKey).map((v) => c.id('persona', 'veir', v.eirKey)),
    ];
    const current = await sx.query(
      `SELECT a.id, a.venture_id, a.persona_id, pe.name, pe.kind, e.display_name AS eir_name
         FROM assignments a
         JOIN ventures v ON v.id = a.venture_id
         JOIN personas pe ON pe.id = a.persona_id
         LEFT JOIN eir_profiles e ON e.id = pe.eir_profile_id
        WHERE v.tenant_id = :tenantId AND a.tenant_id = :tenantId AND v.status = 'active'
          AND a.status = 'active' AND a.starts_at <= now() AND (a.expires_at IS NULL OR a.expires_at > now())
          AND a.persona_id = ANY (:from)
        ORDER BY v.created_at, v.id
        FOR UPDATE OF a`,
      { tenantId: p.uuid(c.tenantId), from: p.uuidArray(from) },
    );
    let notebooks = 0;
    for (const row of current.rows) {
      const ventureId = col.uuid.decode(row.venture_id, 'venture_id');
      const previousPersonaId = col.uuid.decode(row.persona_id, 'persona_id');
      const assignment = await createAssignment(sx, {
        id: coachAssignmentId(release, ventureId, c.id),
        tenantId: c.tenantId,
        ventureId,
        personaId,
        eirProfileId: mentor.eirProfileId,
        allowedModes: mentor.allowedModes,
        createdBy: c.ownerId,
      });
      const common = {
        tenantId: c.tenantId,
        actorId: c.ownerId,
        ventureId,
        outcome: 'succeeded' as const,
      };
      await appendAudit(sx, {
        ...common,
        action: 'assignment.created',
        objectType: 'assignment',
        objectId: assignment.id,
        metadata: {
          personaId,
          eirProfileId: mentor.eirProfileId,
          previousAssignmentId: col.uuid.decode(row.id, 'id'),
          via: 'owner_release',
          ownerRelease: release.key,
        },
      });
      const notebookId = await carryOverNotebook(sx, {
        id: c.id('notebook', 'owner', release.key, ventureId),
        tenantId: c.tenantId,
        ventureId,
        from: {
          personaId: previousPersonaId,
          name: col.text.decode(row.name, 'name'),
          eirName:
            col.text.decode(row.kind, 'kind') === 'eir_persona'
              ? col.text.nullable.decode(row.eir_name, 'eir_name')
              : null,
        },
        toPersonaId: personaId,
      });
      if (notebookId === null) continue;
      notebooks += 1;
      await appendAudit(sx, {
        ...common,
        action: 'notebook.carried_over',
        objectType: 'notebook',
        objectId: notebookId,
        metadata: { fromPersonaId: previousPersonaId, personaId, ownerRelease: release.key },
      });
    }
    await appendAudit(sx, {
      tenantId: c.tenantId,
      actorId: c.ownerId,
      outcome: 'succeeded',
      action: COACH_RELEASE_ACTION,
      objectType: 'persona',
      objectId: personaId,
      metadata: {
        ownerRelease: release.key,
        approvedOn: release.approvedOn,
        ventures: current.rows.length,
        notebooks,
      },
    });
    done('applied', current.rows.length, notebooks);
  }
  return results;
}

// ------------------------------------------------------------------------------------------------
// The notebook
// ------------------------------------------------------------------------------------------------

/** The persona a notebook is carried over from. */
export interface CarriedFrom {
  readonly personaId: string;
  readonly name: string;
  /** The EIR it is the twin of ("Ruth Abernathy-Song"); null for the neutral guide. */
  readonly eirName: string | null;
}

/** Notes that hold something (a seeded or just created notebook holds nothing). */
function hasNotes(n: NotebookContent): boolean {
  return (
    n.summary !== '' ||
    n.nextOpener !== null ||
    n.founderProfile.length + n.commitments.length + n.openQuestions.length + n.lastAdvice.length > 0
  );
}

const escaped = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/['’]/g, "['’]");

/**
 * AI-written notes name the coach they were written as ("Ruth's vEIR suggested…"). In the new coach's notebook they
 * say "the coach": founders meet one mentor under its own name, and nothing is put in its mouth that it did not say.
 * The neutral guide's name is left as it is.
 */
export function withoutTwinName(text: string, from: Pick<CarriedFrom, 'name' | 'eirName'>): string {
  if (from.eirName === null) return text;
  const full = from.eirName.trim();
  const first = full.split(/\s+/)[0] ?? full;
  const eir = `(?:${escaped(full)}|${escaped(first)})`;
  const twin = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:(?:your|the|my)\\s+)?(?:${escaped(from.name)}|${eir}['’]s\\s+(?:vEIR|digital\\s+twin)` +
      `|${eir}\\s*·\\s*vEIR|vEIR)(?![\\p{L}\\p{N}])`,
    'giu',
  );
  return text.replace(twin, (_match, offset: number) =>
    offset === 0 || /[.!?]\s+$/.test(text.slice(0, offset)) ? 'The coach' : 'the coach',
  );
}

/** "Good to see you again.", "Welcome back.": a greeting that says the speaker met the person before. */
const RETURN_GREETING =
  /^(?:(?:hi|hello|hey)\b[^.!?]{0,30}[,.!]\s*)?(?:(?:it['’]s\s+)?(?:so\s+)?(?:good|great|nice|lovely)\s+to\s+(?:see|have|hear|talk|speak|be)\b[^.!?]{0,30}\b(?:again|back)\b[^.!?]{0,20}|welcome\s+back\b[^.!?]{0,30})[.!]\s+(?=\S)/iu;

/** The opener without a greeting that claims an earlier meeting: the new coach has not met the person yet. */
export function withoutReturnGreeting(opener: string): string {
  return opener.replace(RETURN_GREETING, '');
}

/**
 * Whether the opener drawn from `sessionId` is still where its person left off: that conversation stands, and they had
 * no later one in the venture. Anything else is stale, so it is not carried over.
 */
async function openerIsCurrent(sx: SystemExecutor, ventureId: string, sessionId: string): Promise<boolean> {
  const result = await sx.query(
    `SELECT 1 FROM coaching_sessions s
      WHERE s.id = :sessionId AND s.venture_id = :ventureId AND s.deleted_at IS NULL AND s.privacy = 'standard'
        AND NOT EXISTS (
          SELECT 1 FROM coaching_sessions later
           WHERE later.venture_id = s.venture_id AND later.started_by = s.started_by AND later.id <> s.id
             AND later.deleted_at IS NULL AND later.privacy = 'standard'
             AND later.last_activity_at > s.last_activity_at
             AND EXISTS (SELECT 1 FROM turns t WHERE t.session_id = later.id AND t.status = 'completed'))`,
    { sessionId: p.uuid(sessionId), ventureId: p.uuid(ventureId) },
  );
  return result.rows.length > 0;
}

/** The venture's standard conversations with a persona, oldest first; null when there are too many to record. */
async function conversationsWith(
  sx: SystemExecutor,
  ventureId: string,
  personaId: string,
): Promise<string[] | null> {
  const result = await sx.query(
    `SELECT s.id FROM coaching_sessions s JOIN persona_releases r ON r.id = s.persona_release_id
      WHERE s.venture_id = :ventureId AND r.persona_id = :personaId AND s.deleted_at IS NULL
        AND s.privacy = 'standard'
      ORDER BY s.last_activity_at, s.id LIMIT :limit`,
    { ventureId: p.uuid(ventureId), personaId: p.uuid(personaId), limit: p.int(MAX_SUMMARY_SOURCES + 1) },
  );
  return result.rows.length > MAX_SUMMARY_SOURCES
    ? null
    : result.rows.map((r) => col.uuid.decode(r.id, 'id'));
}

/**
 * Copies a venture's notebook with one persona to its notebook with another, when that one holds nothing: returns the
 * new notebook's id, or null when there was nothing to copy or the target has notes of its own. The source row is never
 * changed.
 *
 * - Every line keeps its id, text, source conversations and dates, so deleting a conversation still erases what was
 *   drawn from it, in both notebooks. A summary of unknown origin gets the conversations it can have been drawn from
 *   (the old coach's: unknown would otherwise mean the new coach's, and outlive their deletion).
 * - What a person wrote or changed stays theirs, word for word (`person_edits`), and so do the lines they removed
 *   (`suppressed`).
 * - AI-written lines no longer name the old twin ({@link withoutTwinName}).
 * - The opener is kept when a person wrote it, or when it is drawn from its person's latest conversation (without a
 *   greeting that claims an earlier meeting); else it is left out and a new conversation greets without one.
 */
export async function carryOverNotebook(
  sx: SystemExecutor,
  args: {
    readonly id: string;
    readonly tenantId: string;
    readonly ventureId: string;
    readonly from: CarriedFrom;
    readonly toPersonaId: string;
  },
): Promise<string | null> {
  const { ventureId } = args;
  const source = await getNotebook(sx, { ventureId, personaId: args.from.personaId });
  if (source === null || (!hasNotes(source.content) && source.suppressed.length === 0)) return null;
  const target = await getNotebook(sx, { ventureId, personaId: args.toPersonaId });
  // A notebook nobody wrote (version 0, empty) is none.
  if (target !== null && (target.version > 0 || hasNotes(target.content))) return null;

  const marks = await getNotebookMarks(sx, { ventureId, personaId: args.from.personaId });
  const person = new Set(marks.personEdits);
  const said = (text: string, max: number): string => withoutTwinName(text, args.from).slice(0, max);
  const lines = <T extends { readonly id: string; readonly text: string }>(
    items: readonly T[],
    max: number,
  ): T[] => items.map((item) => (person.has(item.id) ? item : { ...item, text: said(item.text, max) }));

  const old = source.content;
  let summary = person.has(SUMMARY_EDIT) ? old.summary : said(old.summary, 1200);
  let summarySources = old.summarySources;
  if (summarySources === undefined && summary !== '') {
    const all = await conversationsWith(sx, ventureId, args.from.personaId);
    summarySources = all ?? [];
    if (all === null) summary = '';
  }
  const byPerson = old.nextOpenerSource === null || person.has(OPENER_EDIT);
  const keepOpener =
    old.nextOpener !== null &&
    (byPerson ||
      (typeof old.nextOpenerSource === 'string' &&
        (await openerIsCurrent(sx, ventureId, old.nextOpenerSource))));
  const opener =
    old.nextOpener === null || !keepOpener
      ? null
      : byPerson
        ? old.nextOpener
        : withoutReturnGreeting(said(old.nextOpener, 300));
  const content: NotebookContent = {
    summary,
    founderProfile: lines(old.founderProfile, 400),
    commitments: lines(old.commitments, 300),
    openQuestions: lines(old.openQuestions, 400),
    lastAdvice: lines(old.lastAdvice, 400),
    nextOpener: opener,
    nextTopic: opener === null ? null : (old.nextTopic ?? null),
    ...(summarySources === undefined ? {} : { summarySources }),
    ...(opener === null
      ? { nextOpenerSource: null }
      : old.nextOpenerSource === undefined
        ? {}
        : { nextOpenerSource: old.nextOpenerSource }),
  };

  // The person's edits are derived from the writes (`app.notebook_track_person_edits`): first what the old coach wrote,
  // as it last wrote it, then the whole notebook as the person left it, which marks exactly their lines as theirs.
  const others = <T extends { readonly id: string }>(items: readonly T[]): T[] =>
    items.filter((item) => !person.has(item.id));
  const written: NotebookContent = {
    ...content,
    summary: person.has(SUMMARY_EDIT) ? '' : content.summary,
    founderProfile: others(content.founderProfile),
    commitments: others(content.commitments),
    openQuestions: others(content.openQuestions),
    lastAdvice: others(content.lastAdvice),
    nextOpener: person.has(OPENER_EDIT) ? null : content.nextOpener,
  };
  const inserted = await sx.query(
    `INSERT INTO veir_notebooks (id, tenant_id, venture_id, persona_id, content, suppressed, version, last_edited_by,
                                 updated_at)
     VALUES (:id, :tenantId, :ventureId, :personaId, :content, :suppressed, :version, 'veir', :updatedAt)
     ON CONFLICT (venture_id, persona_id) DO UPDATE
       SET content = EXCLUDED.content, suppressed = EXCLUDED.suppressed, version = EXCLUDED.version,
           last_edited_by = EXCLUDED.last_edited_by, updated_at = EXCLUDED.updated_at
       WHERE veir_notebooks.version = 0
     RETURNING id`,
    {
      id: p.uuid(args.id),
      tenantId: p.uuid(args.tenantId),
      ventureId: p.uuid(ventureId),
      personaId: p.uuid(args.toPersonaId),
      content: p.json(written),
      suppressed: p.json(source.suppressed),
      version: p.int(marks.veirVersion),
      // Never fresher than it is: an opener of unknown origin is judged by when the notebook was written.
      updatedAt: p.nullable.ts(source.updatedAt),
    },
  );
  const row = inserted.rows[0];
  if (row === undefined) return null;
  const notebookId = col.uuid.decode(row.id, 'id');
  if (source.lastEditedBy === 'person') {
    await sx.query(
      `UPDATE veir_notebooks n
          SET content = :content, version = :version, last_edited_by = 'person',
              last_edited_principal = o.last_edited_principal
         FROM veir_notebooks o
        WHERE n.id = :id AND o.id = :sourceId`,
      {
        id: p.uuid(notebookId),
        sourceId: p.uuid(source.id),
        content: p.json(content),
        version: p.int(source.version),
      },
    );
  }
  return notebookId;
}
