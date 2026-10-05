import {
  BedrockRuntimeClient,
  ConverseCommand,
  InvokeModelCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';

import type { Deadline } from './deadline.js';
import { ModelUnavailableError, type UnavailableReason } from './errors.js';
import type { AwsCredentialProvider, AwsCredentials } from './sigv4-fetch.js';

/** Converse call with cancellation. Injected in tests instead of a real client. */
export type ConverseFn = (input: ConverseCommandInput, signal: AbortSignal) => Promise<ConverseCommandOutput>;

export interface InvokeModelJsonInput {
  modelId: string;
  body: string;
}
/** InvokeModel returning the UTF-8 response body. Injected in tests instead of a real client. */
export type InvokeModelFn = (input: InvokeModelJsonInput, signal: AbortSignal) => Promise<string>;

export interface BedrockRuntimeTransport {
  converse: ConverseFn;
  invokeModel: InvokeModelFn;
}

export interface BedrockRuntimeTransportOptions {
  region: string;
  credentials?: AwsCredentials | AwsCredentialProvider;
  /** SDK attempts per call (1 = no SDK retry). Default 2: one quick retry on throttling/5xx. */
  maxAttempts?: number;
}

/** One shared `BedrockRuntimeClient` for Nova (Converse) and Titan (InvokeModel). */
export function createBedrockRuntimeTransport(
  options: BedrockRuntimeTransportOptions,
): BedrockRuntimeTransport {
  const client = new BedrockRuntimeClient({
    region: options.region,
    maxAttempts: options.maxAttempts ?? 2,
    ...(options.credentials ? { credentials: options.credentials } : {}),
  });
  return {
    converse: (input, signal) => client.send(new ConverseCommand(input), { abortSignal: signal }),
    invokeModel: async (input, signal) => {
      const output = await client.send(
        new InvokeModelCommand({
          modelId: input.modelId,
          contentType: 'application/json',
          accept: 'application/json',
          body: new TextEncoder().encode(input.body),
        }),
        { abortSignal: signal },
      );
      return output.body.transformToString('utf-8');
    },
  };
}

const THROTTLED = new Set([
  'ThrottlingException',
  'ServiceQuotaExceededException',
  'TooManyRequestsException',
]);
const SERVER = new Set([
  'InternalServerException',
  'ServiceUnavailableException',
  'ModelNotReadyException',
  'ModelErrorException',
  'ModelStreamErrorException',
]);
const TIMEOUT = new Set([
  'ModelTimeoutException',
  'TimeoutError',
  'RequestTimeout',
  'RequestTimeoutException',
]);
const CLIENT = new Set([
  'ValidationException',
  'AccessDeniedException',
  'ResourceNotFoundException',
  'ConflictException',
  'UnrecognizedClientException',
  'ExpiredTokenException',
]);

function httpStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('$metadata' in error)) return null;
  const metadata = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata;
  return typeof metadata?.httpStatusCode === 'number' ? metadata.httpStatusCode : null;
}

export function awsErrorName(error: unknown): string | null {
  return error instanceof Error ? error.name : null;
}

/** Maps AWS SDK v3 failures to typed gateway errors without copying provider messages. */
export function mapAwsError(error: unknown, deadline: Deadline, modelId: string): ModelUnavailableError {
  const name = awsErrorName(error);
  const make = (reason: UnavailableReason): ModelUnavailableError =>
    new ModelUnavailableError(reason, modelId, { cause: error, errorName: name });
  if (deadline.timedOut) return make('timeout');
  if (deadline.callerAborted) return make('aborted');
  if (name === 'AbortError') return make('aborted');
  if (name === 'CredentialsProviderError') return make('config');
  if (name !== null && THROTTLED.has(name)) return make('throttled');
  if (name !== null && TIMEOUT.has(name)) return make('timeout');
  if (name !== null && SERVER.has(name)) return make('server_error');
  if (name !== null && CLIENT.has(name)) return make('client_error');
  const status = httpStatus(error);
  if (status === 429) return make('throttled');
  if (status !== null && status >= 500) return make('server_error');
  if (status !== null && status >= 400) return make('client_error');
  return make('network');
}
