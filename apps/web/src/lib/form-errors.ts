import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';

import { isApiError } from '@/lib/api/errors';

/**
 * The one way forms show field errors from the server (422 problem+json `errors[]`) or from local contract
 * validation (`encodeBody`): each error lands on its react-hook-form field. An API path is matched to a field
 * of the same name, to a field it ends with (`patch.title` → `title`), or through `aliases` (a map of API
 * paths, or a function, e.g. `expiresAt` → `expires`). Returns true when at least one error was placed, so
 * the caller can fall back to a form-level message otherwise. The first placed field takes focus.
 */
export function applyFieldErrors<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
  fields: readonly Path<T>[],
  aliases: Partial<Record<string, Path<T>>> | ((path: string) => string) = {},
): boolean {
  if (!isApiError(error) || error.fieldErrors.length === 0) return false;
  let placed = false;
  for (const fieldError of error.fieldErrors) {
    const aliased =
      typeof aliases === 'function'
        ? aliases(fieldError.path)
        : (aliases[fieldError.path] ?? fieldError.path);
    const target = fields.find(
      (field) => field === aliased || aliased.endsWith(`.${field}`) || fieldError.path.endsWith(`.${field}`),
    );
    if (!target) continue;
    setError(target, { type: 'server', message: fieldError.message }, { shouldFocus: !placed });
    placed = true;
  }
  return placed;
}
