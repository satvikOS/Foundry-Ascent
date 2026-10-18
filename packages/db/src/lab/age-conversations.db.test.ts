import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { col } from '../columns.js';
import { p } from '../params.js';
import { seedId } from '../seed/ids.js';
import { createTestDatabase, type TestDatabase } from '../testing/test-database.js';
import {
  ageConversationsForLab,
  agedDigest,
  agedNotebookContent,
  conversationDistilled,
} from './age-conversations.js';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase({ seed: true });
});
afterAll(async () => {
  await t.cleanup();
});

const DAY = 86_400_000;
const QUIETQUAD = seedId('ain', 'venture', 'quietquad');

interface Snapshot {
  readonly session: Record<string, string | null>;
  readonly digest: { generatedAt: string; commitments: { due: string | null }[] };
  readonly firstTurn: string;
  readonly memory: string;
  readonly otherMemory: string;
  readonly memoryEvent: string | null;
  readonly notebook: {
    updatedAt: string | null;
    lines: Record<string, { createdAt: string; due?: string | null }>;
  };
  readonly otherNotebook: string | null;
}

async function snapshot(sessionId: string, memoryId: string, otherMemoryId: string): Promise<Snapshot> {
  return t.db.system(async (sx) => {
    const s = (
      await sx.query(
        `SELECT started_at, ended_at, last_activity_at, distilled_at, digest FROM coaching_sessions WHERE id = :id`,
        { id: p.uuid(sessionId) },
      )
    ).rows[0];
    if (!s) throw new Error('no session');
    const ts = (raw: unknown, name: string) => col.ts.nullable.decode(raw, name);
    const turn = (
      await sx.query('SELECT min(created_at) AS at FROM turns WHERE session_id = :id', {
        id: p.uuid(sessionId),
      })
    ).rows[0];
    const memoryAt = async (id: string) =>
      col.ts.decode(
        (await sx.query('SELECT created_at FROM memory_objects WHERE id = :id', { id: p.uuid(id) })).rows[0]
          ?.created_at,
        'created_at',
      );
    const event = (
      await sx.query('SELECT max(at) AS at FROM memory_events WHERE memory_id = :id', {
        id: p.uuid(memoryId),
      })
    ).rows[0];
    const notebook = (
      await sx.query('SELECT content, updated_at FROM veir_notebooks WHERE venture_id = :v', {
        v: p.uuid(QUIETQUAD),
      })
    ).rows[0];
    const content = col
      .json<
        Record<
          string,
          { id: string; sourceSessionId: string | null; createdAt: string; due?: string | null }[]
        >
      >()
      .decode(notebook?.content, 'content');
    const lines: Snapshot['notebook']['lines'] = {};
    for (const list of ['founderProfile', 'openQuestions', 'lastAdvice', 'commitments']) {
      for (const line of content[list] ?? []) {
        if (line.sourceSessionId === sessionId)
          lines[`${list}/${line.id}`] = { createdAt: line.createdAt, due: line.due };
      }
    }
    const bench = (
      await sx.query('SELECT updated_at FROM veir_notebooks WHERE venture_id <> :v ORDER BY id LIMIT 1', {
        v: p.uuid(QUIETQUAD),
      })
    ).rows[0];
    return {
      session: {
        started_at: ts(s.started_at, 'started_at'),
        ended_at: ts(s.ended_at, 'ended_at'),
        last_activity_at: ts(s.last_activity_at, 'last_activity_at'),
        distilled_at: ts(s.distilled_at, 'distilled_at'),
      },
      digest: col.json<Snapshot['digest']>().decode(s.digest, 'digest'),
      firstTurn: col.ts.decode(turn?.at, 'at'),
      memory: await memoryAt(memoryId),
      otherMemory: await memoryAt(otherMemoryId),
      memoryEvent: col.ts.nullable.decode(event?.at, 'at'),
      notebook: { updatedAt: col.ts.nullable.decode(notebook?.updated_at, 'updated_at'), lines },
      otherNotebook: col.ts.nullable.decode(bench?.updated_at, 'updated_at'),
    };
  });
}

const earlier = (before: string | null, after: string | null) =>
  before === null || after === null ? null : Date.parse(before) - Date.parse(after);
const dayBefore = (date: string | null | undefined, days: number) =>
  date ? new Date(Date.parse(`${date}T00:00:00Z`) - days * DAY).toISOString().slice(0, 10) : date;

describe('ageConversationsForLab', () => {
  it('moves the conversation and everything it produced back by whole days, and nothing else', async () => {
    const { sessionId, memoryId, otherMemoryId } = await t.db.system(async (sx) => {
      const s = (
        await sx.query(
          `SELECT id FROM coaching_sessions WHERE venture_id = :v AND deleted_at IS NULL AND ended_at IS NOT NULL`,
          { v: p.uuid(QUIETQUAD) },
        )
      ).rows[0];
      const m = (
        await sx.query('SELECT id FROM memory_objects WHERE venture_id = :v ORDER BY id LIMIT 2', {
          v: p.uuid(QUIETQUAD),
        })
      ).rows;
      const ids = {
        sessionId: col.uuid.decode(s?.id, 'id'),
        memoryId: col.uuid.decode(m[0]?.id, 'id'),
        otherMemoryId: col.uuid.decode(m[1]?.id, 'id'),
      };
      // Real conversations carry microseconds (the seed writes whole milliseconds).
      await sx.query(
        `UPDATE coaching_sessions SET started_at = started_at + interval '123 microseconds' WHERE id = :s`,
        { s: p.uuid(ids.sessionId) },
      );
      // One memory item learned from the conversation (and its history), one not.
      await sx.query(
        `UPDATE memory_objects SET source_refs = jsonb_build_array(jsonb_build_object('kind', 'session', 'id', CAST(:s AS text)))
         WHERE id = :m`,
        { s: p.uuid(ids.sessionId), m: p.uuid(ids.memoryId) },
      );
      await sx.query(
        `INSERT INTO memory_events (memory_id, venture_id, actor_id, action, diff)
         SELECT :m, :v, principal_id, 'created', '{}'::jsonb FROM venture_memberships WHERE venture_id = :v LIMIT 1`,
        { m: p.uuid(ids.memoryId), v: p.uuid(QUIETQUAD) },
      );
      return ids;
    });
    const before = await snapshot(sessionId, memoryId, otherMemoryId);
    expect(Object.keys(before.notebook.lines).length).toBeGreaterThan(0);

    const result = await t.db.system((sx) => ageConversationsForLab(sx, { sessionId, days: 3 }));
    expect(result).toMatchObject({ sessions: 1, memory: 1, notebooks: 1, digests: 1 });
    expect(result.turns).toBeGreaterThan(0);

    const after = await snapshot(sessionId, memoryId, otherMemoryId);
    for (const column of ['started_at', 'ended_at', 'last_activity_at', 'distilled_at'] as const) {
      expect(earlier(before.session[column] ?? null, after.session[column] ?? null), column).toBe(3 * DAY);
    }
    expect(earlier(before.digest.generatedAt, after.digest.generatedAt)).toBe(3 * DAY);
    expect(after.digest.commitments.map((c) => c.due)).toEqual(
      before.digest.commitments.map((c) => dayBefore(c.due, 3)),
    );
    expect(earlier(before.firstTurn, after.firstTurn)).toBe(3 * DAY);
    expect(earlier(before.memory, after.memory)).toBe(3 * DAY);
    expect(earlier(before.memoryEvent, after.memoryEvent)).toBe(3 * DAY);
    expect(earlier(before.notebook.updatedAt, after.notebook.updatedAt)).toBe(3 * DAY);
    for (const [key, line] of Object.entries(before.notebook.lines)) {
      expect(earlier(line.createdAt, after.notebook.lines[key]?.createdAt ?? null), key).toBe(3 * DAY);
      expect(after.notebook.lines[key]?.due, key).toBe(dayBefore(line.due, 3));
    }
    // Not learned from it, or another venture's: untouched.
    expect(after.otherMemory).toBe(before.otherMemory);
    expect(after.otherNotebook).toBe(before.otherNotebook);
  });

  it('leaves a call (its minutes count today, its start never changes) and a person-edited notebook as they are', async () => {
    const { sessionId, callStart, notebookBefore } = await t.db.system(async (sx) => {
      const s = (
        await sx.query(
          `SELECT id, tenant_id, started_by FROM coaching_sessions WHERE venture_id = :v AND deleted_at IS NULL`,
          { v: p.uuid(QUIETQUAD) },
        )
      ).rows[0];
      const id = col.uuid.decode(s?.id, 'id');
      const call = await sx.query(
        `INSERT INTO calls (tenant_id, venture_id, session_id, persona_id, started_by, status, voice_id, max_seconds,
                            ended_at, end_reason)
         SELECT tenant_id, venture_id, id, (SELECT persona_id FROM assignments WHERE venture_id = :v AND status = 'active'),
                started_by, 'ended', 'Ruth', 600, now(), 'user'
         FROM coaching_sessions WHERE id = :s
         RETURNING started_at`,
        { v: p.uuid(QUIETQUAD), s: p.uuid(id) },
      );
      await sx.query(`UPDATE veir_notebooks SET last_edited_by = 'person' WHERE venture_id = :v`, {
        v: p.uuid(QUIETQUAD),
      });
      const nb = await sx.query('SELECT content FROM veir_notebooks WHERE venture_id = :v', {
        v: p.uuid(QUIETQUAD),
      });
      return {
        sessionId: id,
        callStart: col.ts.decode(call.rows[0]?.started_at, 'started_at'),
        notebookBefore: JSON.stringify(col.json().decode(nb.rows[0]?.content, 'content')),
      };
    });
    const result = await t.db.system((sx) => ageConversationsForLab(sx, { sessionId, days: 14 }));
    expect(result.sessions).toBe(1);
    const after = await t.db.system(async (sx) => ({
      call: col.ts.decode(
        (await sx.query('SELECT started_at FROM calls WHERE session_id = :s', { s: p.uuid(sessionId) }))
          .rows[0]?.started_at,
        'started_at',
      ),
      notebook: JSON.stringify(
        col.json().decode(
          (
            await sx.query('SELECT content FROM veir_notebooks WHERE venture_id = :v', {
              v: p.uuid(QUIETQUAD),
            })
          ).rows[0]?.content,
          'content',
        ),
      ),
    }));
    expect(after.call).toBe(callStart);
    expect(after.notebook).toBe(notebookBefore);
  });

  it('refuses a conversation that is unknown, still going, or a gap that is not whole days', async () => {
    const sessionId = await t.db.system(async (sx) =>
      col.uuid.decode(
        (
          await sx.query(`SELECT id FROM coaching_sessions WHERE venture_id = :v AND deleted_at IS NULL`, {
            v: p.uuid(QUIETQUAD),
          })
        ).rows[0]?.id,
        'id',
      ),
    );
    await expect(
      t.db.system((sx) => ageConversationsForLab(sx, { sessionId: seedId('ain', 'nowhere'), days: 3 })),
    ).rejects.toThrow(/no such conversation/);
    for (const days of [0, 1.5, 366]) {
      await expect(t.db.system((sx) => ageConversationsForLab(sx, { sessionId, days }))).rejects.toThrow(
        /whole number/,
      );
    }
    await expect(
      t.db.system(async (sx) => {
        await sx.query(`UPDATE coaching_sessions SET status = 'active', ended_at = NULL WHERE id = :id`, {
          id: p.uuid(sessionId),
        });
        return ageConversationsForLab(sx, { sessionId, days: 3 });
      }),
    ).rejects.toThrow(/not ended/);
    // The refused transaction changed nothing.
    expect(await t.db.system((sx) => conversationDistilled(sx, sessionId))).toBe(true);
  });
});

describe('the aged JSON', () => {
  it('moves only the lines drawn from the aged conversations', () => {
    const content = {
      summary: 's',
      founderProfile: [
        { id: 'a', sourceSessionId: 's1', createdAt: '2026-10-10T12:00:00.000Z' },
        { id: 'b', sourceSessionId: 'other', createdAt: '2026-10-10T12:00:00.000Z' },
        { id: 'c', sourceSessionId: null, createdAt: '2026-10-10T12:00:00.000Z' },
      ],
      commitments: [
        { id: 'k', sourceSessionId: 's1', createdAt: '2026-10-10T12:00:00.000Z', due: '2026-10-14' },
      ],
      openQuestions: [],
      lastAdvice: [],
      nextOpener: null,
    };
    expect(agedNotebookContent(content, new Set(['s1']), 14)).toEqual({
      ...content,
      founderProfile: [
        { id: 'a', sourceSessionId: 's1', createdAt: '2026-09-26T12:00:00.000Z' },
        content.founderProfile[1],
        content.founderProfile[2],
      ],
      commitments: [
        { id: 'k', sourceSessionId: 's1', createdAt: '2026-09-26T12:00:00.000Z', due: '2026-09-30' },
      ],
    });
    expect(
      agedDigest(
        {
          summary: 'x',
          topics: [],
          commitments: [
            { text: 't', due: '2026-03-01' },
            { text: 'u', due: null },
          ],
          openQuestions: [],
          generatedAt: '2026-03-02T00:00:00.000Z',
        },
        3,
      ),
    ).toEqual({
      summary: 'x',
      topics: [],
      commitments: [
        { text: 't', due: '2026-02-26' },
        { text: 'u', due: null },
      ],
      openQuestions: [],
      generatedAt: '2026-02-27T00:00:00.000Z',
    });
  });
});
