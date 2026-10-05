/**
 * Model usage ledger (one row per model call). No `app_rls` privileges: SystemExecutor only.
 * Days are UTC calendar days: `[date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', +1 day)`.
 */
import { col } from '../columns.js';
import { type SystemExecutor } from '../executor.js';
import { p } from '../params.js';
import { clampLimit, queryNumber, queryRows } from './common.js';

export type UsagePurpose = 'turn' | 'recap' | 'classification' | 'embedding' | 'ingestion' | 'eval' | 'seed';

export interface UsageEntry {
  readonly tenantId?: string | null;
  readonly ventureId?: string | null;
  readonly principalId?: string | null;
  readonly purpose: UsagePurpose;
  readonly modelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly requestId?: string | null;
}

/** Appends one ledger row. */
export async function recordUsage(sx: SystemExecutor, entry: UsageEntry): Promise<void> {
  await sx.query(
    `INSERT INTO usage_ledger (tenant_id, venture_id, principal_id, purpose, model_id, input_tokens, output_tokens,
                               cost_usd, request_id)
     VALUES (:tenantId, :ventureId, :principalId, :purpose, :modelId, :inputTokens, :outputTokens, :costUsd, :requestId)`,
    {
      tenantId: p.nullable.uuid(entry.tenantId),
      ventureId: p.nullable.uuid(entry.ventureId),
      principalId: p.nullable.uuid(entry.principalId),
      purpose: p.text(entry.purpose),
      modelId: p.text(entry.modelId),
      inputTokens: p.int(Math.max(0, Math.round(entry.inputTokens))),
      outputTokens: p.int(Math.max(0, Math.round(entry.outputTokens))),
      costUsd: p.num(Math.max(0, Number(entry.costUsd.toFixed(6)))),
      requestId: p.nullable.text(entry.requestId),
    },
  );
}

const TODAY_START = `(date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;

/**
 * Spend so far in the current UTC day — globally, or for one principal (daily caps). Checked on session
 * create and every turn.
 */
export function spendToday(sx: SystemExecutor, args: { principalId?: string | null } = {}): Promise<number> {
  return queryNumber(
    sx,
    `SELECT coalesce(sum(cost_usd), 0) AS n FROM usage_ledger
     WHERE at >= ${TODAY_START} AND (:principalId IS NULL OR principal_id = :principalId)`,
    { principalId: p.nullable.uuid(args.principalId) },
  );
}

/** Spend over the last `days` UTC days including today. */
export function spendLastDays(sx: SystemExecutor, days: number): Promise<number> {
  return queryNumber(
    sx,
    `SELECT coalesce(sum(cost_usd), 0) AS n FROM usage_ledger
     WHERE at >= ${TODAY_START} - make_interval(days => :days - 1)`,
    { days: p.int(clampLimit(days, 30, 366)) },
  );
}

export interface UsageDay {
  /** YYYY-MM-DD (UTC). */
  readonly day: string;
  readonly usd: number;
  /** Distinct turn requests that called a model that day. */
  readonly turns: number;
}

/** One row per UTC day for the last `days` days (zero-filled), oldest first. */
export function usageByDay(sx: SystemExecutor, days = 30): Promise<UsageDay[]> {
  return queryRows(
    sx,
    `WITH bounds AS (SELECT (now() AT TIME ZONE 'UTC')::date AS today)
     , d AS (SELECT b.today - g AS day FROM bounds b, generate_series(0, :days - 1) AS g)
     SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            coalesce(sum(u.cost_usd), 0) AS usd,
            count(DISTINCT coalesce(u.request_id, u.id::text)) FILTER (WHERE u.purpose = 'turn') AS turns
     FROM d
     LEFT JOIN usage_ledger u
       ON u.at >= (d.day::timestamp AT TIME ZONE 'UTC') AND u.at < ((d.day + 1)::timestamp AT TIME ZONE 'UTC')
     GROUP BY d.day
     ORDER BY d.day`,
    { days: p.int(clampLimit(days, 30, 366)) },
    (r) => ({
      day: col.text.decode(r.day, 'day'),
      usd: col.num.decode(r.usd, 'usd'),
      turns: col.int.decode(r.turns, 'turns'),
    }),
  );
}

export interface UsageByModel {
  readonly modelId: string;
  readonly usd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly calls: number;
}

/** Totals per model over the last `days` UTC days, most expensive first. */
export function usageByModel(sx: SystemExecutor, days = 30): Promise<UsageByModel[]> {
  return queryRows(
    sx,
    `SELECT model_id, coalesce(sum(cost_usd), 0) AS usd, coalesce(sum(input_tokens), 0) AS input_tokens,
            coalesce(sum(output_tokens), 0) AS output_tokens, count(*) AS calls
     FROM usage_ledger
     WHERE at >= ${TODAY_START} - make_interval(days => :days - 1)
     GROUP BY model_id
     ORDER BY usd DESC, model_id`,
    { days: p.int(clampLimit(days, 30, 366)) },
    (r) => ({
      modelId: col.text.decode(r.model_id, 'model_id'),
      usd: col.num.decode(r.usd, 'usd'),
      inputTokens: col.int.decode(r.input_tokens, 'input_tokens'),
      outputTokens: col.int.decode(r.output_tokens, 'output_tokens'),
      calls: col.int.decode(r.calls, 'calls'),
    }),
  );
}

export interface UsageSummaryData {
  readonly todayUsd: number;
  readonly last30DaysUsd: number;
  readonly byDay: UsageDay[];
  readonly byModel: UsageByModel[];
}

/** Admin usage page data (the caller adds the configured cap to build the contract `UsageSummary`). */
export async function getUsageSummary(sx: SystemExecutor, days = 30): Promise<UsageSummaryData> {
  const [todayUsd, last30DaysUsd, byDay, byModel] = [
    await spendToday(sx),
    await spendLastDays(sx, 30),
    await usageByDay(sx, days),
    await usageByModel(sx, days),
  ];
  return { todayUsd, last30DaysUsd, byDay, byModel };
}
