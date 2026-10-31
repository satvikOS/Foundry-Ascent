import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  InvokeModelCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type ConverseStreamCommandInput,
  type ConverseStreamOutput,
} from '@aws-sdk/client-bedrock-runtime';

import type { Deadline } from './deadline.js';
import { ModelUnavailableError, type UnavailableReason } from './errors.js';
import { sharedAwsAgent } from './http-agent.js';
import type { AwsCredentialProvider, AwsCredentials } from './sigv4-fetch.js';

/** Converse call with cancellation. Injected in tests instead of a real client. */
export type ConverseFn = (input: ConverseCommandInput, signal: AbortSignal) => Promise<ConverseCommandOutput>;

/**
 * ConverseStream call with cancellation: resolves to the event stream once the response headers arrive.
 * Injected in tests instead of a real client.
 */
export type ConverseStreamFn = (
  input: ConverseStreamCommandInput,
  signal: AbortSignal,
) => Promise<AsyncIterable<ConverseStreamOutput>>;

export interface InvokeModelJsonInput {
  modelId: string;
  body: string;
}
/** InvokeModel returning the UTF-8 response body. Injected in tests instead of a real client. */
export type InvokeModelFn = (input: InvokeModelJsonInput, signal: AbortSignal) => Promise<string>;

export interface BedrockRuntimeTransport {
  converse: ConverseFn;
  converseStream: ConverseStreamFn;
  invokeModel: InvokeModelFn;
  /**
   * Opens (or reuses) a connection to the Bedrock runtime with requests it refuses before any model runs, so the next
   * model calls find a warm connection: a Converse of `modelId` with no messages and, with `embeddingsModelId`, an
   * InvokeModel of the embedding model with an empty body (no input text). Each is a validation error: no tokens, no
   * charge. They go one after the other, on the same kept-alive connection. Never rejects.
   */
  prewarm: (modelId: string, embeddingsModelId?: string) => Promise<void>;
}

/** How long a prewarm request may take before it is abandoned. */
export const PREWARM_TIMEOUT_MS = 3_000;

export interface BedrockRuntimeTransportOptions {
  region: string;
  credentials?: AwsCredentials | AwsCredentialProvider;
  /** SDK attempts per call (1 = no SDK retry). Default 2: one quick retry on throttling/5xx. */
  maxAttempts?: number;
  /** Another endpoint than the region's (tests: a local stand-in). */
  endpoint?: string;
}

/**
 * One shared `BedrockRuntimeClient` for Nova (Converse, ConverseStream) and Titan (InvokeModel), on the process's
 * keep-alive agent (`sharedAwsAgent`: connections kept between turns and counted).
 */
export function createBedrockRuntimeTransport(
  options: BedrockRuntimeTransportOptions,
): BedrockRuntimeTransport {
  const client = new BedrockRuntimeClient({
    region: options.region,
    maxAttempts: options.maxAttempts ?? 2,
    requestHandler: { httpsAgent: sharedAwsAgent() },
    ...(options.credentials ? { credentials: options.credentials } : {}),
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
  });
  const refused = async (
    send: (options: { abortSignal: AbortSignal }) => Promise<unknown>,
  ): Promise<void> => {
    try {
      await send({ abortSignal: AbortSignal.timeout(PREWARM_TIMEOUT_MS) });
    } catch {
      // Refused by design (or unreachable): either way the connection, if any, is now open and kept.
    }
  };
  return {
    prewarm: async (modelId, embeddingsModelId) => {
      await refused((options) => client.send(new ConverseCommand({ modelId, messages: [] }), options));
      // A turn's first Bedrock call is its query embedding (lab face run 41235680528: Titan took ~375 ms on the run's
      // first turn, ~230 ms on the next ones, after the Converse above had opened the connection).
      if (embeddingsModelId !== undefined) {
        const body = new TextEncoder().encode('{}');
        await refused((options) =>
          client.send(
            new InvokeModelCommand({
              modelId: embeddingsModelId,
              contentType: 'application/json',
              accept: 'application/json',
              body,
            }),
            options,
          ),
        );
      }
    },
    converse: (input, signal) => client.send(new ConverseCommand(input), { abortSignal: signal }),
    converseStream: async (input, signal) => {
      const output = await client.send(new ConverseStreamCommand(input), { abortSignal: signal });
      if (!output.stream)
        throw Object.assign(new Error('Empty response stream'), { name: 'ModelStreamErrorException' });
      return output.stream;
    },
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
