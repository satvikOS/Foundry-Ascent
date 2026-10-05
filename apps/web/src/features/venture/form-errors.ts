import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';

import { isApiError } from '@/lib/api/errors';

/**
 * Map server (or local `encodeBody`) field errors onto react-hook-form fields. `aliases` maps API
 * paths (e.g. "patch.title") to form fields. Returns true when at least one field error was shown, so
 * callers can fall back to a form-level message otherwise.
 */
export function applyFieldErrors<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
  fields: readonly Path<T>[],
  aliases: Partial<Record<string, Path<T>>> = {},
): boolean {
  if (!isApiError(error) || error.fieldErrors.length === 0) return false;
  let applied = false;
  for (const fieldError of error.fieldErrors) {
    const target =
      aliases[fieldError.path] ??
      fields.find((field) => field === fieldError.path || fieldError.path.endsWith(`.${field}`));
    if (!target) continue;
    setError(target, { type: 'server', message: fieldError.message }, { shouldFocus: !applied });
    applied = true;
  }
  return applied;
}
