/**
 * Conversation lab only (docs/runbooks/conversation-lab.md): makes a remembered conversation days or weeks old in
 * the lab's own database, so the next conversation meets it the way a founder would after a real gap. The app has
 * no clock to move, so the lab moves the conversation instead: everything it produced is shifted back by the same
 * number of days, and every interval inside it (and between it and what came after) stays as it was.
 *
 * What moves, for the venture's live conversations up to and including the one that just ended (earlier ones move
 * with it, so a third conversation meets the first two at their own distances):
 * - the conversations: started, ended, last activity, distilled, digest deleted, the distillation claim, and the
 *   digest's own `generatedAt` and commitment due dates;
 * - their turns (created, completed, interrupted), escalations, forgotten-memory records and patterns drawn from
 *   them;
 * - memory items learned from them (created, updated, approved, kept) and their history events;
 * - the venture's notebooks when written since the earliest of them (updated_at), and the notebook lines drawn
 *   from them (`createdAt`, a commitment's due date) unless a person last edited the notebook (rewriting their
 *   lines would record them as that person's edits).
 * What stays: the usage ledger and calls (spend and call minutes count today, and a call's start never changes:
 * calls_guard), and the audit log (it records what happened).
 */
import { col } from '../columns.js';
import { SqlUsageError } from '../errors.js';
import { type SystemExecutor } from '../executor.js';
import { p } from '../params.js';

export interface AgeConversationsResult {
  readonly sessions: number;
  readonly turns: number;
  readonly memory: number;
  readonly notebooks: number;
  readonly digests: number;
}

const DAY_MS = 86_400_000;
const NOTEBOOK_LISTS = ['founderProfile', 'openQuestions', 'lastAdvice', 'commitments'] as const;

function shiftTimestamp(value: unknown, days: number): unknown {
  if (typeof value !== 'string') return value;
  const at = Date.parse(value);
  return Number.isNaN(at) ? value : new Date(at - days * DAY_MS).toISOString();
}

function shiftDate(value: unknown, days: number): unknown {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Date(Date.parse(`${value}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A digest with its generation time and commitment due dates moved back `days`. */
export function agedDigest(digest: unknown, days: number): unknown {
  const d = record(digest);
  if (d === null) return digest;
  const commitments = Array.isArray(d.commitments)
    ? d.commitments.map((c: unknown) => {
        const r = record(c);
        return r === null ? c : { ...r, due: shiftDate(r.due, days) };
      })
    : d.commitments;
  return { ...d, generatedAt: shiftTimestamp(d.generatedAt, days), commitments };
}

/** Notebook content with the lines drawn from `sessions` moved back `days` (when noted; a commitment's due date). */
export function agedNotebookContent(content: unknown, sessions: ReadonlySet<string>, days: number): unknown {
  const c = record(content);
  if (c === null) return content;
  const out: Record<string, unknown> = { ...c };
  for (const list of NOTEBOOK_LISTS) {
    const lines = c[list];
    if (!Array.isArray(lines)) continue;
    out[list] = lines.map((line: unknown) => {
      const r = record(line);
      if (r === null || typeof r.sourceSessionId !== 'string' || !sessions.has(r.sourceSessionId))
        return line;
      const moved: Record<string, unknown> = { ...r, createdAt: shiftTimestamp(r.createdAt, days) };
      if (list === 'commitments') moved.due = shiftDate(r.due, days);
      return moved;
    });
  }
  return out;
}

/**
 * Moves the conversation `sessionId` (ended, not deleted) and the venture's earlier live conversations back
 * `days` days, with everything they produced (call inside a system transaction; lab databases only).
 */
export async function ageConversationsForLab(
  sx: SystemExecutor,
  args: { readonly sessionId: string; readonly days: number },
): Promise<AgeConversationsResult> {
  const { days } = args;
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new SqlUsageError('days must be a whole number from 1 to 365');
  }
  const target = (
    await sx.query(
      `SELECT venture_id, started_at, ended_at, deleted_at FROM coaching_sessions WHERE id = :id FOR UPDATE`,
      { id: p.uuid(args.sessionId) },
    )
  ).rows[0];
  if (!target) throw new SqlUsageError('no such conversation');
  if (target.deleted_at !== null) throw new SqlUsageError('the conversation is deleted');
  if (target.ended_at === null) throw new SqlUsageError('the conversation has not ended');
  const ventureId = col.uuid.decode(target.venture_id, 'venture_id');
  const startedAt = col.ts.decode(target.started_at, 'started_at');

  // Compared in the database: a timestamp read back here keeps milliseconds only, the column has microseconds.
  const live = await sx.query(
    `SELECT id, started_at FROM coaching_sessions
     WHERE venture_id = :ventureId AND deleted_at IS NULL
       AND started_at <= (SELECT started_at FROM coaching_sessions WHERE id = :id)
     ORDER BY started_at`,
    { ventureId: p.uuid(ventureId), id: p.uuid(args.sessionId) },
  );
  const ids = live.rows.map((r) => col.uuid.decode(r.id, 'id'));
  const earliest = live.rows[0] ? col.ts.decode(live.rows[0].started_at, 'started_at') : startedAt;
  const params = { ids: p.uuidArray(ids), days: p.int(days) };
  const shift = (column: string) =>
    `${column} = CASE WHEN ${column} IS NULL THEN NULL ELSE ${column} - make_interval(days => :days) END`;

  const turns = await sx.query(
    `UPDATE turns SET ${shift('created_at')}, ${shift('completed_at')}, ${shift('interrupted_at')}
     WHERE session_id = ANY(:ids)`,
    params,
  );
  await sx.query(
    `UPDATE escalations SET ${shift('created_at')}, ${shift('updated_at')}, ${shift('sharing_consent_at')},
       ${shift('due_at')}
     WHERE session_id = ANY(:ids)`,
    params,
  );
  await sx.query(`UPDATE memory_forgotten SET ${shift('created_at')} WHERE session_id = ANY(:ids)`, params);
  await sx.query(
    `UPDATE patterns SET ${shift('created_at')}, ${shift('updated_at')} WHERE source_session_id = ANY(:ids)`,
    params,
  );
  const learned = `SELECT m.id FROM memory_objects m
     WHERE m.venture_id = :ventureId AND jsonb_typeof(m.source_refs) = 'array'
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(m.source_refs) AS r (ref)
                   WHERE r.ref ->> 'kind' = 'session' AND r.ref ->> 'id' = ANY(CAST(:ids AS text[])))`;
  await sx.query(`UPDATE memory_events SET ${shift('at')} WHERE memory_id IN (${learned})`, {
    ...params,
    ventureId: p.uuid(ventureId),
  });
  const memory = await sx.query(
    `UPDATE memory_objects SET ${shift('created_at')}, ${shift('updated_at')}, ${shift('approved_at')},
       ${shift('auto_kept_at')}
     WHERE id IN (${learned})`,
    { ...params, ventureId: p.uuid(ventureId) },
  );

  const sessions = new Set(ids);
  const notebooks = await sx.query(
    `SELECT id, content, updated_at, last_edited_by FROM veir_notebooks WHERE venture_id = :ventureId FOR UPDATE`,
    { ventureId: p.uuid(ventureId) },
  );
  let notebooksMoved = 0;
  for (const row of notebooks.rows) {
    const updatedAt = col.ts.nullable.decode(row.updated_at, 'updated_at');
    const writtenSince = updatedAt !== null && Date.parse(updatedAt) >= Date.parse(earliest);
    await sx.query(
      `UPDATE veir_notebooks SET content = :content,
         updated_at = CASE WHEN :since THEN updated_at - make_interval(days => :days) ELSE updated_at END
       WHERE id = :id`,
      {
        id: p.uuid(col.uuid.decode(row.id, 'id')),
        content: p.json(
          row.last_edited_by === 'person'
            ? col.json().decode(row.content, 'content')
            : agedNotebookContent(col.json().decode(row.content, 'content'), sessions, days),
        ),
        since: p.bool(writtenSince),
        days: p.int(days),
      },
    );
    if (writtenSince) notebooksMoved += 1;
  }

  const digests = await sx.query(
    `SELECT id, digest FROM coaching_sessions WHERE id = ANY(:ids) AND digest IS NOT NULL`,
    params,
  );
  for (const row of digests.rows) {
    await sx.query('UPDATE coaching_sessions SET digest = :digest WHERE id = :id', {
      id: p.uuid(col.uuid.decode(row.id, 'id')),
      digest: p.json(agedDigest(col.json().decode(row.digest, 'digest'), days)),
    });
  }
  const moved = await sx.query(
    `UPDATE coaching_sessions SET ${shift('started_at')}, ${shift('ended_at')}, ${shift('last_activity_at')},
       ${shift('distilled_at')}, ${shift('digest_deleted_at')}, ${shift('distill_claimed_until')}
     WHERE id = ANY(:ids)`,
    params,
  );
  return {
    sessions: moved.rowCount,
    turns: turns.rowCount,
    memory: memory.rowCount,
    notebooks: notebooksMoved,
    digests: digests.rows.length,
  };
}

/** Whether the conversation's distillation has finished (it writes the digest, notebook and memory). */
export async function conversationDistilled(sx: SystemExecutor, sessionId: string): Promise<boolean> {
  const row = (
    await sx.query(
      `SELECT privacy, distilled_at, distill_claimed_until FROM coaching_sessions WHERE id = :id`,
      { id: p.uuid(sessionId) },
    )
  ).rows[0];
  if (!row) return false;
  // A private (one-off) conversation is never distilled: nothing to wait for.
  if (row.privacy !== 'standard') return true;
  return row.distilled_at !== null && row.distill_claimed_until === null;
}
