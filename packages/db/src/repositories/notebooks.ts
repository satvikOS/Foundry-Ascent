/**
 * The vEIR notebook (`veir_notebooks`): one per venture × persona, "what <vEIR> knows about you and
 * <venture>". It holds AI notes, never facts: the venture team sees every line, corrects or removes any of
 * them, and the distillation job writes against the version it read so a correction is never silently
 * overwritten. Lines a person removed or corrected are kept as fingerprints in `suppressed` (never as text),
 * so distillation does not write them back.
 *
 * RLS: read by the founder/team and the assigned EIR (like the conversations it is distilled from); written
 * by the founder/team; distillation writes with the owner role.
 */
import { NotebookCommitment, NotebookEntry, type VeirNotebook } from '@foundry/contracts';
import { z } from 'zod';

import { col, type RawRow } from '../columns.js';
import { type SqlExecutor } from '../executor.js';
import { p } from '../params.js';
import { queryFirst } from './common.js';

/** The notebook document (`content`): the contract's sections without the view metadata. */
export const NotebookContent = z.object({
  summary: z.string().max(1200),
  founderProfile: z.array(NotebookEntry).max(40),
  commitments: z.array(NotebookCommitment).max(40),
  openQuestions: z.array(NotebookEntry).max(40),
  lastAdvice: z.array(NotebookEntry).max(40),
  nextOpener: z.string().max(300).nullable(),
});
export type NotebookContent = z.infer<typeof NotebookContent>;

export const EMPTY_NOTEBOOK: NotebookContent = {
  summary: '',
  founderProfile: [],
  commitments: [],
  openQuestions: [],
  lastAdvice: [],
  nextOpener: null,
};

/** A line a person removed or corrected: which section, and the fingerprint of its normalised text. */
export const SuppressedLine = z.object({
  section: z.enum(['summary', 'founderProfile', 'commitments', 'openQuestions', 'lastAdvice', 'nextOpener']),
  fingerprint: z.string().regex(/^[0-9a-f]{16,64}$/),
  at: z.string(),
});
export type SuppressedLine = z.infer<typeof SuppressedLine>;

/** At most this many suppressed fingerprints are kept (oldest dropped first). */
export const MAX_SUPPRESSED = 500;

export interface NotebookRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly ventureId: string;
  readonly personaId: string;
  readonly personaName: string;
  /** AI notes: content, never log it. */
  readonly content: NotebookContent;
  readonly suppressed: SuppressedLine[];
  readonly version: number;
  readonly lastEditedBy: 'veir' | 'person' | null;
  readonly updatedAt: string | null;
  readonly createdAt: string;
}

const COLUMNS = `n.id, n.tenant_id, n.venture_id, n.persona_id, n.content, n.suppressed, n.version, n.last_edited_by,
  n.updated_at, n.created_at`;

function decodeContent(raw: unknown): NotebookContent {
  const parsed = NotebookContent.safeParse(col.json().decode(raw, 'content'));
  // The CHECK constraint guarantees the shape; a stricter contract (e.g. longer ids) degrades to empty.
  return parsed.success ? parsed.data : EMPTY_NOTEBOOK;
}

function decodeSuppressed(raw: unknown): SuppressedLine[] {
  const value = col.json().decode(raw, 'suppressed');
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = SuppressedLine.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function decode(r: RawRow, personaName: string): NotebookRecord {
  return {
    id: col.uuid.decode(r.id, 'id'),
    tenantId: col.uuid.decode(r.tenant_id, 'tenant_id'),
    ventureId: col.uuid.decode(r.venture_id, 'venture_id'),
    personaId: col.uuid.decode(r.persona_id, 'persona_id'),
    personaName,
    content: decodeContent(r.content),
    suppressed: decodeSuppressed(r.suppressed),
    version: col.int.decode(r.version, 'version'),
    lastEditedBy: col.enum(['veir', 'person'] as const).nullable.decode(r.last_edited_by, 'last_edited_by'),
    updatedAt: col.ts.nullable.decode(r.updated_at, 'updated_at'),
    createdAt: col.ts.decode(r.created_at, 'created_at'),
  };
}

/** The notebook of a venture × persona, or null when none was written yet (or it is not visible). */
export function getNotebook(
  ex: SqlExecutor,
  args: { ventureId: string; personaId: string },
): Promise<NotebookRecord | null> {
  return queryFirst(
    ex,
    `SELECT ${COLUMNS}, pe.name AS persona_name
     FROM veir_notebooks n JOIN personas pe ON pe.id = n.persona_id
     WHERE n.venture_id = :ventureId AND n.persona_id = :personaId`,
    { ventureId: p.uuid(args.ventureId), personaId: p.uuid(args.personaId) },
    (r) => decode(r, col.text.decode(r.persona_name, 'persona_name')),
  );
}

export interface SaveNotebookInput {
  readonly tenantId: string;
  readonly ventureId: string;
  readonly personaId: string;
  /** The version the change was made against (0 when no notebook existed). */
  readonly expectedVersion: number;
  readonly content: NotebookContent;
  readonly suppressed: readonly SuppressedLine[];
  /** `person` for edits by the venture team, `veir` for distillation. */
  readonly editedBy: 'veir' | 'person';
  /** The editing person (request principal under RLS); null for distillation. */
  readonly principalId?: string | null;
}

/**
 * Writes the notebook if it is still at `expectedVersion` (optimistic concurrency: edits and distillation
 * never overwrite each other's changes silently) and bumps the version. Creates the row when none exists
 * and `expectedVersion` is 0. Returns null on a version conflict (the caller re-reads and retries or
 * reports 409).
 */
export async function saveNotebook(
  ex: SqlExecutor,
  input: SaveNotebookInput,
): Promise<NotebookRecord | null> {
  const content = NotebookContent.parse(input.content);
  const suppressed = input.suppressed.slice(-MAX_SUPPRESSED).map((line) => SuppressedLine.parse(line));
  const params = {
    tenantId: p.uuid(input.tenantId),
    ventureId: p.uuid(input.ventureId),
    personaId: p.uuid(input.personaId),
    expected: p.int(input.expectedVersion),
    content: p.json(content),
    suppressed: p.json(suppressed),
    editedBy: p.text(input.editedBy),
    principal: p.nullable.uuid(input.principalId),
  };
  let written = await queryFirst(
    ex,
    `UPDATE veir_notebooks AS n
     SET content = :content, suppressed = :suppressed, version = n.version + 1, last_edited_by = :editedBy,
         last_edited_principal = :principal, updated_at = now()
     WHERE n.venture_id = :ventureId AND n.persona_id = :personaId AND n.version = :expected
     RETURNING n.id`,
    params,
    (r) => col.uuid.decode(r.id, 'id'),
  );
  if (written === null && input.expectedVersion === 0) {
    written = await queryFirst(
      ex,
      `INSERT INTO veir_notebooks AS n (tenant_id, venture_id, persona_id, content, suppressed, version, last_edited_by,
                                        last_edited_principal, updated_at)
       VALUES (:tenantId, :ventureId, :personaId, :content, :suppressed, 1, :editedBy, :principal, now())
       ON CONFLICT (venture_id, persona_id) DO NOTHING
       RETURNING n.id`,
      params,
      (r) => col.uuid.decode(r.id, 'id'),
    );
  }
  if (written === null) return null;
  return getNotebook(ex, { ventureId: input.ventureId, personaId: input.personaId });
}

/** Contract view; an absent notebook is the empty notebook at version 0. */
export function toNotebookView(
  args: { ventureId: string; personaId: string; personaName: string },
  record: NotebookRecord | null,
): VeirNotebook {
  const content = record?.content ?? EMPTY_NOTEBOOK;
  return {
    ventureId: args.ventureId,
    personaId: args.personaId,
    personaName: record?.personaName ?? args.personaName,
    summary: content.summary,
    founderProfile: content.founderProfile,
    commitments: content.commitments,
    openQuestions: content.openQuestions,
    lastAdvice: content.lastAdvice,
    nextOpener: content.nextOpener,
    version: record?.version ?? 0,
    updatedAt: record?.updatedAt ?? null,
    lastEditedBy: record?.lastEditedBy ?? null,
  };
}

/** Pin keys of `person_edits` for the summary and the opener (entries and commitments use their ids). */
export const SUMMARY_EDIT = 'summary';
export const OPENER_EDIT = 'nextOpener';

/** What distillation needs to know about the writes since it last wrote (migration 0007, kept by a trigger). */
export interface NotebookMarks {
  /**
   * What a person wrote or changed since the vEIR last wrote the notebook: entry and commitment ids, plus
   * {@link SUMMARY_EDIT} / {@link OPENER_EDIT}.
   */
  readonly personEdits: string[];
  /** The notebook version the vEIR last wrote (0 before its first write). */
  readonly veirVersion: number;
}

/** The notebook's {@link NotebookMarks}; empty marks when there is no notebook. */
export async function getNotebookMarks(
  ex: SqlExecutor,
  args: { ventureId: string; personaId: string },
): Promise<NotebookMarks> {
  const marks = await queryFirst(
    ex,
    `SELECT n.person_edits, n.veir_version FROM veir_notebooks n
     WHERE n.venture_id = :ventureId AND n.persona_id = :personaId`,
    { ventureId: p.uuid(args.ventureId), personaId: p.uuid(args.personaId) },
    (r) => {
      const edits = col.json().decode(r.person_edits, 'person_edits');
      return {
        personEdits: Array.isArray(edits) ? edits.filter((id): id is string => typeof id === 'string') : [],
        veirVersion: col.int.decode(r.veir_version, 'veir_version'),
      };
    },
  );
  return marks ?? { personEdits: [], veirVersion: 0 };
}
