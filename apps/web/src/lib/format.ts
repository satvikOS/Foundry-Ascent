const LOCALE = undefined; // the person's locale

const relativeFormatter = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });
const dateFormatter = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium' });
const dateTimeFormatter = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short' });
const numberFormatter = new Intl.NumberFormat(LOCALE);
const compactFormatter = new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 });

function toDate(value: string | number | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/** "3 hours ago", "yesterday", "in 2 days", "just now". */
export function formatRelative(value: string | number | Date | null | undefined, now = Date.now()): string {
  if (value === null || value === undefined) return 'never';
  const seconds = Math.round((toDate(value).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return 'just now';
  for (const [unit, size] of UNITS) {
    if (abs >= size || unit === 'minute') return relativeFormatter.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

export function formatDate(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return dateFormatter.format(toDate(value));
}

export function formatDateTime(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return dateTimeFormatter.format(toDate(value));
}

/** ISO string for <time dateTime>. */
export function isoString(value: string | number | Date): string {
  return toDate(value).toISOString();
}

export function formatNumber(value: number): string {
  return numberFormatter.format(value);
}

export function formatCompact(value: number): string {
  return compactFormatter.format(value);
}

export function formatUsd(value: number, fractionDigits = 2): string {
  return new Intl.NumberFormat(LOCALE, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: Math.max(
      fractionDigits,
      value !== 0 && Math.abs(value) < 0.01 ? 4 : fractionDigits,
    ),
  }).format(value);
}

export function formatPercent(value: number, fractionDigits = 0): string {
  return new Intl.NumberFormat(LOCALE, { style: 'percent', maximumFractionDigits: fractionDigits }).format(
    value,
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit] ?? 'GB'}`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatNumber(count)} ${count === 1 ? singular : plural}`;
}

/** Time-of-day greeting for the home page. */
export function greeting(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 5) return 'Good evening';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
