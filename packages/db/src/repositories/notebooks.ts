/**
 * The vEIR notebook (`veir_notebooks`): one per venture × persona, "what <vEIR> knows about you and
 * <venture>". It holds AI notes, never facts: the venture team sees every line, corrects or removes any of
 * them, and the distillation job writes against the version it read so a correction is never silently
 * overwritten. Lines a person removed or corrected are kept as fingerprints in `suppressed` (never as text),
 * so distillation does not write them back.
 *
 * RLS: read by the founder/team and the assigned EIR (like the conversations it is distilled from); written
 * by the founder/team; distillation writes with the owner role.
 *
 * The summary and the opener record the conversations they were drawn from (`summarySources`,
 * `nextOpenerSource`), so deleting a conversation clears them (`app.soft_delete_session`). Absent sources
 * mean "unknown": deleting any distilled conversation of the persona then clears them.
 */
import { Id, NotebookCommitment, NotebookEntry, type VeirNotebook } from '@foundry/contracts';
import { z } from 'zod';

import { col, type RawRow } from '../columns.js';
import { NotebookIntegrityError } from '../errors.js';
import { type SqlExecutor } from '../executor.js';
import { p } from '../params.js';
import { queryFirst } from './common.js';

/** At most this many conversations are recorded as the sources of the summary (oldest dropped first). */
export const MAX_SUMMARY_SOURCES = 50;

/** The notebook document (`content`): the contract's sections without the view metadata. */
export const NotebookContent = z.object({
  summary: z.string().max(1200),
  founderProfile: z.array(NotebookEntry).max(40),
  commitments: z.array(NotebookCommitment).max(40),
  openQuestions: z.array(NotebookEntry).max(40),
  lastAdvice: z.array(NotebookEntry).max(40),
  nextOpener: z.string().max(300).nullable(),
  /** Conversations the summary was drawn from (absent: unknown). */
  summarySources: z.array(Id).max(MAX_SUMMARY_SOURCES).optional(),
  /** Conversation the opener was drawn from (absent or null: unknown). */
  nextOpenerSource: Id.nullable().optional(),
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
  /**
   * False when the stored document does not match the contract: `content` then holds what could be read,
   * and writes at this version are refused (`NotebookIntegrityError`).
   */
  readonly intact: boolean;
  readonly suppressed: SuppressedLine[];
  readonly version: number;
  readonly lastEditedBy: 'veir' | 'person' | null;
  readonly updatedAt: string | null;
  readonly createdAt: string;
}

const COLUMNS = `n.id, n.tenant_id, n.venture_id, n.persona_id, n.content, n.suppressed, n.version, n.last_edited_by,
  n.updated_at, n.created_at`;

function validItems<T>(schema: z.ZodType<T>, raw: unknown): T[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const parsed = schema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Decodes the stored document. The CHECK constraint keeps it in the contract's shape; should a row still
 * not match (a later, stricter contract), the readable lines are kept and the record is marked not intact,
 * never shown empty at the live version (which an edit would then overwrite).
 */
export function decodeNotebookContent(raw: unknown): { content: NotebookContent; intact: boolean } {
  const value = col.json().decode(raw, 'content');
  const parsed = NotebookContent.safeParse(value);
  if (parsed.success) return { content: parsed.data, intact: true };
  const doc: Record<string, unknown> =
    typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {};
  const summary = z.string().max(1200).safeParse(doc.summary);
  const opener = z.string().max(300).safeParse(doc.nextOpener);
  return {
    content: {
      summary: summary.success ? summary.data : '',
      founderProfile: validItems(NotebookEntry, doc.founderProfile).slice(0, 40),
      commitments: validItems(NotebookCommitment, doc.commitments).slice(0, 40),
      openQuestions: validItems(NotebookEntry, doc.openQuestions).slice(0, 40),
      lastAdvice: validItems(NotebookEntry, doc.lastAdvice).slice(0, 40),
      nextOpener: opener.success ? opener.data : null,
    },
    intact: false,
  };
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
  const { content, intact } = decodeNotebookContent(r.content);
  return {
    id: col.uuid.decode(r.id, 'id'),
    tenantId: col.uuid.decode(r.tenant_id, 'tenant_id'),
    ventureId: col.uuid.decode(r.venture_id, 'venture_id'),
    personaId: col.uuid.decode(r.persona_id, 'persona_id'),
    personaName,
    content,
    intact,
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
  /**
   * Distillation: the conversation this write was drawn from. A changed summary or opener is recorded as
   * drawn from it ({@link withDistilledSources}); without it they are recorded as of unknown origin.
   */
  readonly sourceSessionId?: string | null;
}

/**
 * Where a distillation write's summary and opener came from, given the document it replaces. An unchanged
 * summary or opener keeps its recorded sources. A rewritten summary adds `sourceSessionId` to the earlier
 * summary's sources (unknown stays unknown: the rewrite may carry the earlier text). A new opener is drawn
 * from `sourceSessionId`. Pure (unit tested).
 */
export function withDistilledSources(
  previous: NotebookContent | null,
  next: NotebookContent,
  sourceSessionId: string | null,
): NotebookContent {
  const before = previous ?? EMPTY_NOTEBOOK;
  const out: NotebookContent = {
    summary: next.summary,
    founderProfile: next.founderProfile,
    commitments: next.commitments,
    openQuestions: next.openQuestions,
    lastAdvice: next.lastAdvice,
    nextOpener: next.nextOpener,
  };
  if (next.summary === before.summary) {
    if (before.summarySources !== undefined) out.summarySources = before.summarySources;
  } else if (next.summary !== '' && sourceSessionId !== null) {
    const known = before.summary === '' ? [] : before.summarySources;
    if (known !== undefined) {
      out.summarySources = [...known.filter((id) => id !== sourceSessionId), sourceSessionId].slice(
        -MAX_SUMMARY_SOURCES,
      );
    }
  }
  if (next.nextOpener === before.nextOpener) {
    if (before.nextOpenerSource !== undefined) out.nextOpenerSource = before.nextOpenerSource;
  } else if (next.nextOpener !== null) {
    out.nextOpenerSource = sourceSessionId;
  }
  return out;
}

/**
 * Writes the notebook if it is still at `expectedVersion` (optimistic concurrency: edits and distillation
 * never overwrite each other's changes silently) and bumps the version. Creates the row when none exists
 * and `expectedVersion` is 0. Returns null on a version conflict (the caller re-reads and retries or
 * reports 409). Throws {@link NotebookIntegrityError} when the stored document at that version does not
 * match the contract: a write never replaces content that could not be read.
 */
export async function saveNotebook(
  ex: SqlExecutor,
  input: SaveNotebookInput,
): Promise<NotebookRecord | null> {
  const stored = await queryFirst(
    ex,
    `SELECT n.id, n.content FROM veir_notebooks n
     WHERE n.venture_id = :ventureId AND n.persona_id = :personaId AND n.version = :expected`,
    {
      ventureId: p.uuid(input.ventureId),
      personaId: p.uuid(input.personaId),
      expected: p.int(input.expectedVersion),
    },
    (r) => ({ id: col.uuid.decode(r.id, 'id'), ...decodeNotebookContent(r.content) }),
  );
  if (stored !== null && !stored.intact) throw new NotebookIntegrityError(stored.id);
  const parsed = NotebookContent.parse(input.content);
  const content =
    input.editedBy === 'veir'
      ? withDistilledSources(stored?.content ?? null, parsed, input.sourceSessionId ?? null)
      : parsed;
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
