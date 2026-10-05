import { DomainError, fieldErrors } from '@foundry/core';
import { type z } from 'zod';

import { httpError } from './problem.js';
import { type AppContext } from './types.js';

const JSON_CONTENT_TYPE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;

function validation(error: z.ZodError): DomainError {
  return new DomainError('validation_failed', 'The request is not valid', {
    errors: fieldErrors(error),
    reason: 'schema',
  });
}

/**
 * Parses the JSON request body with a contract schema. An empty body counts as `{}` (action endpoints
 * whose fields all have defaults). Non-JSON content types → 415, malformed JSON → 400, schema
 * violations → 422 with field paths and messages (never values).
 */
export function jsonBody<S extends z.ZodType>(c: AppContext, schema: S): z.output<S> {
  const raw = c.get('rawBody');
  let value: unknown = {};
  if (raw !== undefined && raw.byteLength > 0) {
    const contentType = c.req.header('content-type') ?? '';
    if (!JSON_CONTENT_TYPE.test(contentType)) {
      throw httpError.unsupportedMediaType('Request bodies must be application/json');
    }
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as unknown;
    } catch {
      throw httpError.badRequest('The request body is not valid JSON', 'malformed_json');
    }
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw validation(parsed.error);
  return parsed.data;
}

/**
 * Parses query parameters with a contract schema (first value of each name; empty values are treated as
 * absent). Boolean flags are the schema's business: `MemoryQuery.pinned` reads `true/false`, `1/0`,
 * `yes/no`, `on/off` and rejects other text with 422.
 */
export function queryParams<S extends z.ZodType>(c: AppContext, schema: S): z.output<S> {
  const input: Record<string, string> = {};
  for (const [name, value] of Object.entries(c.req.query())) {
    if (value.trim() !== '') input[name] = value;
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw validation(parsed.error);
  return parsed.data;
}

/** A path parameter; core rejects malformed ids as `not_found`, so no shape check here. */
export function pathParam(c: AppContext, name: string): string {
  const value = c.req.param(name);
  if (value === undefined || value === '') throw httpError.notFound();
  return value;
}
