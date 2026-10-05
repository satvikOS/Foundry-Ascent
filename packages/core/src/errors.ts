import { isModelGatewayError } from '@foundry/ai';
import { ERROR_STATUS, type ErrorCode } from '@foundry/contracts';
import { DatabaseResumingError, DbError, NoRowsError, SqlState } from '@foundry/db';
import { type z } from 'zod';

export interface FieldError {
  readonly path: string;
  readonly message: string;
}

export interface DomainErrorOptions {
  readonly retryAfterSeconds?: number;
  readonly errors?: readonly FieldError[];
  /** Machine-readable reason (audit `policy_reason`, never shown with content). */
  readonly reason?: string;
  readonly cause?: unknown;
}

/**
 * The only error type services throw on purpose. `message` is safe to show to the caller and to log:
 * it never contains prompts, model output, documents, memory content or access codes. The API maps
 * it to RFC 9457 problem+json with `ERROR_STATUS[code]`.
 */
export class DomainError extends Error {
  override readonly name = 'DomainError';
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;
  readonly errors: readonly FieldError[] | undefined;
  readonly reason: string | undefined;

  constructor(code: ErrorCode, message: string, options: DomainErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.errors = options.errors;
    this.reason = options.reason;
  }

  /** Whether retrying the same request later may succeed. */
  get retryable(): boolean {
    return (
      this.code === 'database_resuming' ||
      this.code === 'model_unavailable' ||
      this.code === 'rate_limited' ||
      this.code === 'spend_cap_reached'
    );
  }
}

export function isDomainError(err: unknown): err is DomainError {
  return err instanceof DomainError;
}

/** Shorthands used throughout the services. */
export const fail = {
  notFound: (what = 'Resource', reason?: string): DomainError =>
    new DomainError('not_found', `${what} not found`, reason === undefined ? {} : { reason }),
  forbidden: (reason: string, message = 'You do not have access to this resource'): DomainError =>
    new DomainError('forbidden', message, { reason }),
  conflict: (message: string, reason?: string): DomainError =>
    new DomainError('conflict', message, reason === undefined ? {} : { reason }),
  validation: (message: string, errors?: readonly FieldError[]): DomainError =>
    new DomainError('validation_failed', message, errors === undefined ? {} : { errors }),
  badRequest: (message: string): DomainError => new DomainError('bad_request', message),
};

/** Converts a Zod error into field errors (paths and messages only, never input values). */
export function fieldErrors(error: z.ZodError): FieldError[] {
  return error.issues.slice(0, 50).map((issue) => ({
    path: issue.path.map(String).join('.') || '(root)',
    message: issue.message,
  }));
}

/** Parses service input with a contract schema; failures become `validation_failed`. */
export function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw fail.validation('The request is not valid', fieldErrors(parsed.error));
  return parsed.data;
}

/**
 * Maps infrastructure errors to DomainErrors (README §3 of @foundry/db). Unknown errors are returned
 * unchanged so the API reports them as `internal` with their stack trace (never their message content
 * from drivers, which can echo row values).
 */
export function toDomainError(err: unknown): unknown {
  if (err instanceof DomainError) return err;
  if (err instanceof DatabaseResumingError) {
    return new DomainError('database_resuming', 'Your workspace is waking up. Please retry shortly.', {
      retryAfterSeconds: err.retryAfterSeconds,
      cause: err,
    });
  }
  if (err instanceof NoRowsError) return new DomainError('not_found', 'Resource not found', { cause: err });
  if (err instanceof DbError) {
    switch (err.sqlState) {
      case SqlState.uniqueViolation:
        return new DomainError('conflict', 'The resource already exists or was changed concurrently', {
          cause: err,
          reason: 'unique_violation',
        });
      case SqlState.insufficientPrivilege:
        return new DomainError('forbidden', 'You do not have access to this resource', {
          cause: err,
          reason: 'database_policy',
        });
      case SqlState.foreignKeyViolation:
      case SqlState.checkViolation:
      case SqlState.notNullViolation:
      case SqlState.invalidTextRepresentation:
        return new DomainError('validation_failed', 'The request violates a data constraint', {
          cause: err,
          reason: err.sqlState,
        });
      case '55000':
        return new DomainError('conflict', 'The resource is not in a state that allows this action', {
          cause: err,
          reason: 'invalid_state',
        });
      case SqlState.serializationFailure:
      case SqlState.deadlockDetected:
        return new DomainError('conflict', 'The request conflicted with a concurrent change; please retry', {
          cause: err,
          reason: err.sqlState,
        });
      default:
        return err;
    }
  }
  if (isModelGatewayError(err)) {
    return new DomainError('model_unavailable', 'The coaching model is temporarily unavailable', {
      cause: err,
      reason: err.code,
      retryAfterSeconds: 5,
    });
  }
  return err;
}
