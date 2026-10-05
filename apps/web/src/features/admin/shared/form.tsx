import type { ReactNode } from 'react';
import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';

import { Alert } from '@/components/ui/alert';
import { CopyButton } from '@/components/ui/copy-button';
import { Field } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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

/**
 * Copy server-side field errors (422 problem+json `errors[]`, or local contract validation from
 * `encodeBody`) onto react-hook-form fields. Returns true when at least one field error was placed,
 * so the caller can skip the generic form-level alert.
 */
export function applyServerFieldErrors<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
  fields: readonly Path<T>[],
  mapPath: (path: string) => string = (path) => path,
): boolean {
  if (!isApiError(error) || error.fieldErrors.length === 0) return false;
  let placed = false;
  for (const fieldError of error.fieldErrors) {
    const target = mapPath(fieldError.path);
    const field = fields.find((candidate) => candidate === target);
    if (field) {
      setError(field, { type: 'server', message: fieldError.message }, { shouldFocus: !placed });
      placed = true;
    }
  }
  return placed;
}

interface SelectFieldProps<V extends string> {
  label: ReactNode;
  value: V;
  onChange: (value: V) => void;
  onBlur?: () => void;
  options: readonly { value: V; label: string }[];
  description?: ReactNode;
  error?: string | undefined;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

/**
 * Labelled Radix select. The trigger is the Field's control, so the <label>, description and error
 * are wired to the element that receives focus.
 */
export function SelectField<V extends string>({
  label,
  value,
  onChange,
  onBlur,
  options,
  description,
  error,
  required,
  disabled,
  placeholder,
  className,
}: SelectFieldProps<V>) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const match = options.find((option) => option.value === next);
        if (match) onChange(match.value);
      }}
      disabled={disabled}
    >
      <Field label={label} description={description} error={error} required={required} className={className}>
        <SelectTrigger className="w-full" onBlur={onBlur}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
      </Field>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
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
