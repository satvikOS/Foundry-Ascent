import type { ModelAttempt, RawModelAttempt } from './types.js';

export type ModelErrorCode = 'model_unavailable' | 'model_output_invalid' | 'model_refusal';

export type UnavailableReason =
  'timeout' | 'throttled' | 'server_error' | 'client_error' | 'network' | 'aborted' | 'config';

/**
 * Base class for model failures. Messages are generic and safe to log: they never include prompt
 * text, model output, or provider error messages (which can echo request content).
 */
export abstract class ModelGatewayError extends Error {
  abstract readonly code: ModelErrorCode;
  /** Whether trying again later (or another model) may succeed. */
  abstract readonly retryable: boolean;
  /** Every network call made before the failure (billable). Filled in by providers and the router. */
  attempts: ModelAttempt[] = [];
  /** Raw attempts recorded by a provider before pricing; the router converts them to `attempts`. */
  rawAttempts: RawModelAttempt[] = [];

  constructor(
    message: string,
    readonly modelId: string | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Timeouts, throttling, 5xx, network failures, access/config problems, caller cancellation. */
export class ModelUnavailableError extends ModelGatewayError {
  readonly code = 'model_unavailable' as const;
  readonly retryable: boolean;
  /** Provider error class name (e.g. `ThrottlingException`), if any. */
  readonly errorName: string | null;

  constructor(
    readonly reason: UnavailableReason,
    modelId: string | null,
    options?: { cause?: unknown; errorName?: string | null },
  ) {
    super(`Model ${modelId ?? '(unknown)'} unavailable: ${reason}`, modelId, options);
    this.retryable =
      reason === 'timeout' || reason === 'throttled' || reason === 'server_error' || reason === 'network';
    this.errorName = options?.errorName ?? null;
  }
}

/** The model answered, but the answer does not satisfy the schema (after any repair attempt). */
export class ModelOutputInvalidError extends ModelGatewayError {
  readonly code = 'model_output_invalid' as const;
  readonly retryable = true;

  constructor(
    modelId: string | null,
    /** Validation issues as `path: code` strings. Never contains output values. */
    readonly issues: readonly string[],
    options?: { cause?: unknown },
  ) {
    super(
      `Model ${modelId ?? '(unknown)'} returned output that failed validation (${issues.length} issue(s))`,
      modelId,
      options,
    );
  }
}

/** The model declined to answer or the provider filtered the content. */
export class ModelRefusalError extends ModelGatewayError {
  readonly code = 'model_refusal' as const;
  readonly retryable = true;

  constructor(
    modelId: string | null,
    readonly source: 'model' | 'content_filter',
    options?: { cause?: unknown },
  ) {
    super(`Model ${modelId ?? '(unknown)'} refused the request (${source})`, modelId, options);
  }
}

export function isModelGatewayError(error: unknown): error is ModelGatewayError {
  return error instanceof ModelGatewayError;
}
