import { Alert } from '@/components/ui/alert';
import { CopyButton } from '@/components/ui/copy-button';
import { errorMessage, isApiError } from '@/lib/api/errors';

/**
 * Helpers shared by the EIR studio, Program and Admin console forms. (They live under
 * features/admin/shared because the consoles are one work stream; nothing here is admin-specific.)
 */

/** Split a "one item per line" textarea into trimmed, non-empty items. */
export function parseLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Inverse of parseLines for prefilling a textarea. */
export function joinLines(items: readonly string[]): string {
  return items.join('\n');
}

/** Split a comma-separated input ("seed, pre-seed") into trimmed, de-duplicated items. */
export function parseCommaList(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(',')) {
    const value = part.trim();
    if (value) seen.add(value);
  }
  return [...seen];
}

/** Inline, announced error for a failed mutation (with a copyable request ID for support). */
export function MutationErrorAlert({ error, title }: { error: unknown; title: string }) {
  if (!error) return null;
  const requestId = isApiError(error) ? error.requestId : undefined;
  return (
    <Alert variant="destructive" live="alert" title={title}>
      <p>{errorMessage(error)}</p>
      {requestId ? (
        <p className="mt-1 flex items-center gap-1 text-xs">
          <span>
            Request ID <code className="font-mono">{requestId}</code>
          </span>
          <CopyButton value={requestId} label="Copy request ID" size="icon-xs" />
        </p>
      ) : null}
    </Alert>
  );
}

/** Convert an <input type="date"> value (local calendar day) to an ISO timestamp at 17:00 local. */
export function dateInputToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T17:00:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Today's date as an <input type="date"> value in local time. */
export function todayDateInput(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Short, non-identifying rendering of a UUID for tables ("3f2504e0…"). */
export function shortId(id: string, length = 8): string {
  return id.length > length ? `${id.slice(0, length)}…` : id;
}
