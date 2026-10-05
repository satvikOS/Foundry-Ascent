/**
 * k-anonymity helpers for portfolio aggregates. The API returns `null` for any group smaller than
 * k (`PortfolioSummary.minGroupSize`) so a small group can't be traced to a specific venture. The UI
 * must never turn a suppressed value into a number (not 0, not k−1, not a total that includes it).
 */

export interface AggregateDatum {
  key: string;
  label: string;
  /** null = suppressed (fewer than k). */
  value: number | null;
}

export function suppressedLabel(k: number): string {
  return `Fewer than ${k}`;
}

/** Short explanation used in footnotes, tooltips and table captions. */
export function kAnonymityExplanation(k: number, unit = 'ventures'): string {
  return `Groups with fewer than ${k} ${unit} are shown as “fewer than ${k}” instead of an exact count, so no individual venture can be singled out (k-anonymity, k = ${k}).`;
}

/** Display text for one aggregate value. */
export function formatAggregate(value: number | null, k: number): string {
  return value === null ? suppressedLabel(k) : new Intl.NumberFormat().format(value);
}

/**
 * Turn an API record into ordered rows. Keys listed in `order` come first in that order; any other
 * keys follow, largest first (suppressed last). Only keys the API returned are shown — a missing key
 * is not assumed to be zero.
 */
export function toAggregateRows(
  record: Record<string, number | null>,
  labelFor: (key: string) => string,
  order: readonly string[] = [],
): AggregateDatum[] {
  const keys = Object.keys(record);
  const known = order.filter((key) => keys.includes(key));
  const rest = keys
    .filter((key) => !order.includes(key))
    .sort((a, b) => {
      const av = record[a] ?? null;
      const bv = record[b] ?? null;
      if (av === bv) return a.localeCompare(b);
      if (av === null) return 1;
      if (bv === null) return -1;
      return bv - av;
    });
  return [...known, ...rest].map((key) => ({ key, label: labelFor(key), value: record[key] ?? null }));
}

/**
 * Sum of the visible (non-suppressed) values and whether any were suppressed. A total that excludes
 * suppressed groups must be labelled as such ("at least N").
 */
export function visibleTotal(rows: readonly AggregateDatum[]): { total: number; partial: boolean } {
  let total = 0;
  let partial = false;
  for (const row of rows) {
    if (row.value === null) partial = true;
    else total += row.value;
  }
  return { total, partial };
}
