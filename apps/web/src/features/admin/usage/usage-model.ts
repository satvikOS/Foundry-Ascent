import type { Usage } from '@/lib/api/hooks/admin';

export interface DayPoint {
  /** YYYY-MM-DD (UTC calendar day, as recorded in the usage ledger). */
  day: string;
  usd: number;
  turns: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * A continuous series of `days` UTC days ending today (or at the latest day in the data, if later).
 * The ledger has no rows for days without usage, so missing days are real zeros.
 */
export function fillDays(byDay: Usage['byDay'], days = 30, now = Date.now()): DayPoint[] {
  const known = new Map<string, DayPoint>();
  for (const point of byDay) {
    const key = point.day.slice(0, 10);
    const existing = known.get(key);
    known.set(key, {
      day: key,
      usd: (existing?.usd ?? 0) + point.usd,
      turns: (existing?.turns ?? 0) + point.turns,
    });
  }
  const latestKnown = [...known.keys()].sort().at(-1);
  const today = utcDay(now);
  const end =
    latestKnown && latestKnown > today
      ? Date.parse(`${latestKnown}T00:00:00Z`)
      : Date.parse(`${today}T00:00:00Z`);
  const series: DayPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = utcDay(end - i * DAY_MS);
    series.push(known.get(key) ?? { day: key, usd: 0, turns: 0 });
  }
  return series;
}

/** Round a maximum up to a clean axis value (1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8 × 10ⁿ). */
export function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  for (const step of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (value <= step * base + 1e-12) return step * base;
  }
  return 10 * base;
}

export type CapState = 'ok' | 'approaching' | 'reached';

export function capState(spent: number, cap: number): CapState {
  if (cap <= 0) return spent > 0 ? 'reached' : 'ok';
  const ratio = spent / cap;
  if (ratio >= 1) return 'reached';
  if (ratio >= 0.8) return 'approaching';
  return 'ok';
}

/**
 * Production routing (infra/cdk/config/production.json): Amazon Nova 2 Lite through the US inference
 * profile is the primary reasoning model and the global profile is its fallback; Titan Text Embeddings V2
 * embeds. GPT-6 Luna is configured but disabled (`models.luna.enabled=false`) because Bedrock gates it for
 * this account; it only appears here if it is ever enabled and used.
 */
const MODEL_NAMES: [RegExp, string, string][] = [
  [/^us\.amazon\.nova-2-lite/i, 'Nova 2 Lite (US profile)', 'Primary reasoning'],
  [/^global\.amazon\.nova-2-lite/i, 'Nova 2 Lite (global profile)', 'Fallback reasoning'],
  [/nova-2-lite/i, 'Nova 2 Lite', 'Reasoning'],
  [/gpt-6-luna/i, 'GPT-6 Luna', 'Reasoning (disabled: not available for this account)'],
  [/titan-embed/i, 'Titan Text Embeddings V2', 'Embeddings'],
  [/^mock-fallback/i, 'Mock provider (fallback)', 'Tests and offline dev'],
  [/^mock/i, 'Mock provider', 'Tests and offline dev'],
];

export function describeModel(modelId: string): { name: string; role: string } {
  const match = MODEL_NAMES.find(([pattern]) => pattern.test(modelId));
  return match ? { name: match[1], role: match[2] } : { name: modelId, role: 'Other' };
}

/** "Oct 5" in UTC (ledger days are UTC; local formatting could shift them by a day). */
export function formatDay(day: string, style: 'short' | 'long' = 'short'): string {
  const date = new Date(`${day}T00:00:00Z`);
  return new Intl.DateTimeFormat(undefined, {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    ...(style === 'long' ? { weekday: 'short', year: 'numeric' } : {}),
  }).format(date);
}
