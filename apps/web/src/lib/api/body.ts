import type { z } from 'zod';

import { ApiError } from './errors';

/**
 * Validate (and normalise: trim, defaults, upper-casing) a request body against its shared contract
 * before sending. Invalid input fails locally as `validation_failed` with field errors, exactly like a
 * server 422, so forms handle both the same way.
 */
export function encodeBody<S extends z.ZodType>(schema: S, input: z.input<S>): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new ApiError({
    status: 422,
    code: 'validation_failed',
    title: 'Validation failed',
    detail: result.error.issues[0]?.message ?? 'Some fields need attention.',
    fieldErrors: result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  });
}
