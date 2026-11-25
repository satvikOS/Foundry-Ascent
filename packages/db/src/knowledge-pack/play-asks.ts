/**
 * What founders ask a play for, stored for vector search: the second stage of the path's matching (core
 * `path/semantic.ts`, docs/architecture/founder-path.md). One source per tenant, one row per ask, the play it asks for
 * as its locator. The deploy's backfill embeds a new ask and a change of model re-embeds it, like any stored passage.
 *
 * They are never evidence: {@link notAnAskSql} keeps them out of the shared search (its candidates and its word counts
 * alike), and the document viewer refuses their source.
 *
 * Re-running converges on the code: with the stored version and texts nothing is written; a change replaces only the asks
 * that changed, so the others keep their vectors. A source someone withdrew stays withdrawn, and a tenant without it
 * matches by rules alone.
 */
import { createHash } from 'node:crypto';

import { SqlUsageError } from '../errors.js';
import { type SystemExecutor } from '../executor.js';
import { p } from '../params.js';
import { uuidV5 } from '../seed/ids.js';

/** `knowledge_sources.uri` of the asks. */
export const PLAY_ASKS_URI = 'playbook:asks';
/** Every ask's `knowledge_chunks.locator` is this and its play's id; no other passage's starts with it. */
export const PLAY_ASK_LOCATOR = 'play-ask:';

/** The asks of one playbook: its version, and each play's short texts. */
export interface PlayAsks {
  readonly version: string;
  readonly asks: readonly { readonly playId: string; readonly text: string }[];
}

export interface PlayAsksSyncReport {
  readonly inserted: number;
  readonly deleted: number;
  readonly unchanged: number;
  /** Someone withdrew them: left as they are. */
  readonly keptWithdrawn: boolean;
}

/** SQL: the passage `alias` is none of the asks. */
export function notAnAskSql(alias: string): string {
  return `NOT starts_with(coalesce(${alias}.locator, ''), '${PLAY_ASK_LOCATOR}')`;
}

export function playAsksSourceId(tenantId: string): string {
  return uuidV5(`${tenantId}/${PLAY_ASKS_URI}`);
}

/** Identifies a playbook's asks: a change of its version or of any text syncs them. */
export function playAsksChecksum(asks: PlayAsks): string {
  const texts = createHash('sha256')
    .update(JSON.stringify(asks.asks.map((a) => [a.playId, a.text])), 'utf8')
    .digest('hex');
  return `playbook:${asks.version}:sha256:${texts}`;
}

/** Brings a tenant's asks in line with the playbook's. Call inside a transaction. */
export async function syncPlayAsks(
  sx: SystemExecutor,
  args: { readonly tenantId: string; readonly playAsks: PlayAsks },
): Promise<PlayAsksSyncReport> {
  const { tenantId, playAsks } = args;
  const total = playAsks.asks.length;
  const keys = playAsks.asks.map((a) => `${a.playId}\n${a.text}`);
  if (new Set(keys).size !== total) throw new SqlUsageError('a play asks the same thing twice');
  const id = playAsksSourceId(tenantId);
  const checksum = playAsksChecksum(playAsks);
  const stored = await sx.query(`SELECT status, checksum FROM knowledge_sources WHERE id = :id`, {
    id: p.uuid(id),
  });
  const row = stored.rows[0];
  if (row?.status === 'withdrawn') return { inserted: 0, deleted: 0, unchanged: total, keptWithdrawn: true };
  if (row?.checksum === checksum) return { inserted: 0, deleted: 0, unchanged: total, keptWithdrawn: false };
  await sx.query(
    `INSERT INTO knowledge_sources AS k (id, tenant_id, scope, kind, title, uri, classification, checksum, status)
     VALUES (:id, :tenantId, 'public', 'document', 'What founders ask each play', :uri, 'public', :checksum, 'active')
     ON CONFLICT (id) DO UPDATE SET checksum = excluded.checksum, updated_at = now(), freshness_at = now()`,
    { id: p.uuid(id), tenantId: p.uuid(tenantId), uri: p.text(PLAY_ASKS_URI), checksum: p.text(checksum) },
  );
  const asks = p.json(
    playAsks.asks.map((a) => ({ locator: `${PLAY_ASK_LOCATOR}${a.playId}`, content: a.text })),
  );
  const gone = await sx.query(
    `DELETE FROM knowledge_chunks c
      WHERE c.source_id = :id
        AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(:asks) AS a (locator text, content text)
                        WHERE a.locator = c.locator AND a.content = c.content)`,
    { id: p.uuid(id), asks },
  );
  const added = await sx.query(
    `INSERT INTO knowledge_chunks (source_id, tenant_id, scope, ordinal, content, locator, token_count)
     SELECT :id, :tenantId, 'public',
            (SELECT coalesce(max(o.ordinal), 0) FROM knowledge_chunks o WHERE o.source_id = :id)
              + row_number() OVER (ORDER BY a.locator, a.content),
            a.content, a.locator, ceil(length(a.content) / 4.0)
     FROM jsonb_to_recordset(:asks) AS a (locator text, content text)
     WHERE NOT EXISTS (SELECT 1 FROM knowledge_chunks c
                       WHERE c.source_id = :id AND c.locator = a.locator AND c.content = a.content)`,
    { id: p.uuid(id), tenantId: p.uuid(tenantId), asks },
  );
  return {
    inserted: added.rowCount,
    deleted: gone.rowCount,
    unchanged: total - added.rowCount,
    keptWithdrawn: false,
  };
}

/** The asks in every active tenant. */
export async function syncPlayAsksToTenants(
  sx: SystemExecutor,
  playAsks: PlayAsks,
): Promise<{ readonly slug: string; readonly report: PlayAsksSyncReport }[]> {
  const tenants = await sx.query(`SELECT id, slug FROM tenants WHERE status = 'active' ORDER BY slug`);
  const out: { slug: string; report: PlayAsksSyncReport }[] = [];
  for (const row of tenants.rows)
    out.push({
      slug: String(row.slug),
      report: await syncPlayAsks(sx, { tenantId: String(row.id), playAsks }),
    });
  return out;
}
