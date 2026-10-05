/**
 * API Lambda (Function URL, invoke mode RESPONSE_STREAM, behind CloudFront OAC).
 *
 * Cold start: configuration, clients, core and the Hono app are built once per container at module
 * scope (no network I/O). Each invocation is served by `hono/aws-lambda` `streamHandle`; afterwards the
 * handler drains background work (a turn whose client went away still persists its outcome before the
 * execution environment is frozen).
 */
import type { LambdaFunctionURLEvent, StreamifyHandler } from 'aws-lambda';
import { streamHandle } from 'hono/aws-lambda';

import { createApiRuntime } from '../runtime/api.js';

/** Time kept after the response to drain background work before Lambda's own deadline. */
const DRAIN_MARGIN_MS = 1_000;

// The AWS SDK (lambda-invoke-store) may create an empty `awslambda` object, so check for the streaming API.
const lambda = (globalThis as { awslambda?: Partial<typeof awslambda> }).awslambda;
if (typeof lambda?.streamifyResponse !== 'function') {
  throw new Error(
    'The API handler must run in the AWS Lambda Node.js runtime (awslambda.streamifyResponse is missing).',
  );
}
const streamifyResponse = lambda.streamifyResponse;

const runtime = createApiRuntime(process.env);

// streamHandle() returns an `awslambda.streamifyResponse` handler; its declared type is the plain
// (event, context) shape, so it is re-typed to what the runtime actually calls.
// eslint-disable-next-line @typescript-eslint/no-deprecated -- the runtime contract mandates hono/aws-lambda streamHandle (Hono 4); move to @hono/aws-lambda with Hono 5.
const serve = streamHandle(runtime.app) as unknown as StreamifyHandler<LambdaFunctionURLEvent, void>;

export const handler = streamifyResponse<LambdaFunctionURLEvent>(async (event, responseStream, context) => {
  await serve(event, responseStream, context);
  const pending = await runtime.inflight.drain(
    Math.max(0, context.getRemainingTimeInMillis() - DRAIN_MARGIN_MS),
  );
  if (pending > 0)
    runtime.logger.warn('lambda.inflight_abandoned', { pending, awsRequestId: context.awsRequestId });
});
