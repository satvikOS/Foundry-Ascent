import { Writable } from 'node:stream';

import { HealthResponse, Me, SessionView, TurnStreamEvent } from '@foundry/contracts';
import { accessCodePrefix, generateAccessCode, hashAccessCode } from '@foundry/db';
import { createTestDatabase, type TestDatabase } from '@foundry/db/testing';
import type {
  CdkCustomResourceEvent,
  Context,
  LambdaFunctionURLEvent,
  SQSBatchResponse,
  SQSEvent,
  StreamifyHandler,
} from 'aws-lambda';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseSse } from '../testing/sse.js';

/**
 * The deployed handler modules, end to end: module-scope initialisation from the runtime-contract
 * environment, `hono/aws-lambda` streamHandle with a stand-in for the Lambda streaming runtime, the SQS
 * worker and the migrations custom resource, all against a real PostgreSQL database (pg driver).
 */

interface Captured {
  metadata: { statusCode: number; headers: Record<string, string>; cookies: string[] } | null;
  body: string;
}

class CaptureStream extends Writable {
  readonly captured: Captured = { metadata: null, body: '' };
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.captured.body += chunk.toString('utf8');
    callback();
  }
}

// Mirrors the Lambda Node.js runtime globals used by streaming handlers.
(globalThis as Record<string, unknown>).awslambda = {
  streamifyResponse: <T>(fn: T): T => fn,
  HttpResponseStream: {
    from: (stream: CaptureStream, metadata: Captured['metadata']) => {
      stream.captured.metadata = metadata;
      return stream;
    },
  },
};

let t: TestDatabase;
let ownerCode: string;
let api: StreamifyHandler<LambdaFunctionURLEvent, void>;
let worker: (event: SQSEvent, context: Context) => Promise<SQSBatchResponse>;
let migrate: (event: CdkCustomResourceEvent, context: Context) => Promise<{ PhysicalResourceId?: string }>;

function lambdaContext(remainingMs = 50_000): Context {
  return {
    callbackWaitsForEmptyEventLoop: false,
    functionName: 'FoundryAscent-Test',
    functionVersion: '$LATEST',
    invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:FoundryAscent-Test',
    memoryLimitInMB: '1024',
    awsRequestId: 'aws-request-1',
    logGroupName: '/aws/lambda/FoundryAscent-Test',
    logStreamName: 'stream',
    getRemainingTimeInMillis: () => remainingMs,
    done: () => undefined,
    fail: () => undefined,
    succeed: () => undefined,
  };
}

function urlEvent(
  method: string,
  path: string,
  options: { body?: unknown; cookies?: string[]; headers?: Record<string, string> } = {},
): LambdaFunctionURLEvent {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const event = {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    ...(options.cookies ? { cookies: options.cookies } : {}),
    headers: {
      host: 'abcdefg.lambda-url.us-east-1.on.aws',
      // Set by the /api/* CloudFront viewer-request function; x-forwarded-for is client-controlled.
      'x-fa-viewer-ip': '203.0.113.77',
      'x-forwarded-for': '198.51.100.250, 130.176.0.1',
      ...(body === undefined
        ? {}
        : { 'content-type': 'application/json', 'x-requested-with': 'foundry-ascent' }),
      ...options.headers,
    },
    requestContext: {
      accountId: 'anonymous',
      apiId: 'abcdefg',
      domainName: 'abcdefg.lambda-url.us-east-1.on.aws',
      domainPrefix: 'abcdefg',
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '130.176.0.1', userAgent: 'vitest' },
      requestId: 'req',
      routeKey: '$default',
      stage: '$default',
      time: '05/Oct/2026:12:00:00 +0000',
      timeEpoch: Date.now(),
    },
    isBase64Encoded: false,
    ...(body === undefined ? {} : { body }),
  };
  return event;
}

async function invoke(event: LambdaFunctionURLEvent): Promise<Captured> {
  const stream = new CaptureStream();
  await api(event, stream as unknown as awslambda.HttpResponseStream, lambdaContext());
  return stream.captured;
}

beforeAll(async () => {
  t = await createTestDatabase({ seed: true });
  ownerCode = generateAccessCode();
  Object.assign(process.env, {
    APP_ENV: 'test',
    APP_VERSION: 'handler-test',
    LOG_LEVEL: 'error',
    DB_DRIVER: 'pg',
    DATABASE_URL: t.url,
    MODEL_PROVIDER: 'mock',
    AWS_REGION: 'us-east-1',
    DOCUMENTS_BUCKET: 'foundry-ascent-documents-test',
    JOBS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/FoundryAscent-Jobs',
    // A new deploy owner code: the migrate handler binds it, the API then accepts it.
    OWNER_ACCESS_CODE_PREFIX: accessCodePrefix(ownerCode),
    OWNER_ACCESS_CODE_HASH: await hashAccessCode(ownerCode),
    OWNER_DISPLAY_NAME: 'Deploy Owner',
    HOME_TENANT_SLUG: 'ain',
    HOME_TENANT_NAME: 'Ain Foundry (test)',
  });
  api = (await import('./api.js')).handler;
  worker = (await import('./worker.js')).handler;
  migrate = (await import('./migrate.js')).handler;
});
afterAll(async () => {
  await t.cleanup();
});

describe('migrate handler', () => {
  it('Create re-applies nothing, re-seeds idempotently and binds the deploy owner code', async () => {
    const response = await migrate(
      {
        RequestType: 'Create',
        ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:provider',
        ResponseURL: 'https://example.invalid/response',
        StackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/FoundryAscent-App/1',
        RequestId: 'req-1',
        LogicalResourceId: 'Migrations',
        ResourceType: 'Custom::FoundryMigrations',
        ResourceProperties: { ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:provider' },
      },
      lambdaContext(9 * 60_000),
    );
    expect(response.PhysicalResourceId).toBe('foundry-ascent-schema');
  });
});

describe('api handler (Function URL, RESPONSE_STREAM)', () => {
  it('serves /health through streamHandle', async () => {
    const { metadata, body } = await invoke(urlEvent('GET', '/api/v1/health'));
    expect(metadata?.statusCode).toBe(200);
    expect(metadata?.headers['content-type']).toMatch(/^application\/json/);
    expect(metadata?.headers['cache-control']).toBe('no-store');
    // Liveness only: this container has not queried the database yet, so `db` is absent.
    const health = HealthResponse.parse(JSON.parse(body));
    expect(health).toMatchObject({ status: 'ok', version: 'handler-test' });
    expect(health).not.toHaveProperty('db');
  });

  it('signs in (cookie in the streaming metadata) and streams a turn as SSE', async () => {
    const signIn = await invoke(
      urlEvent('POST', '/api/v1/auth/sign-in', { body: { accessCode: ownerCode } }),
    );
    expect(signIn.metadata?.statusCode).toBe(200);
    expect(Me.parse(JSON.parse(signIn.body)).principal.displayName).toBe('Deploy Owner');
    const cookie = signIn.metadata?.cookies.find((c) => c.startsWith('fa_session=')) ?? '';
    expect(cookie).toContain('HttpOnly');
    const token = cookie.split(';')[0] ?? '';

    // The owner is not a venture member, so use a seeded founder's code issued through the admin API.
    const principals = await invoke(urlEvent('GET', '/api/v1/admin/principals', { cookies: [token] }));
    expect(principals.metadata?.statusCode).toBe(200);
    const rows = (
      JSON.parse(principals.body) as { items: { principal: { id: string; displayName: string } }[] }
    ).items;
    const maya = rows.find((r) => r.principal.displayName.startsWith('Maya'))?.principal.id ?? '';
    const issued = await invoke(
      urlEvent('POST', `/api/v1/admin/principals/${maya}/access-codes`, {
        body: { label: 'handler test' },
        cookies: [token],
      }),
    );
    expect(issued.metadata?.statusCode).toBe(201);
    const code = (JSON.parse(issued.body) as { accessCode: string }).accessCode;
    const mayaSignIn = await invoke(urlEvent('POST', '/api/v1/auth/sign-in', { body: { accessCode: code } }));
    const mayaToken = (mayaSignIn.metadata?.cookies[0] ?? '').split(';')[0] ?? '';
    const me = Me.parse(JSON.parse(mayaSignIn.body));
    const ventureId = me.memberships[0]?.ventureId ?? '';

    const created = await invoke(
      urlEvent('POST', `/api/v1/ventures/${ventureId}/sessions`, { body: {}, cookies: [mayaToken] }),
    );
    expect(created.metadata?.statusCode).toBe(201);
    const session = SessionView.parse(JSON.parse(created.body));
    const turn = await invoke(
      urlEvent('POST', `/api/v1/sessions/${session.id}/turns`, {
        body: { text: 'What is our riskiest assumption right now?' },
        cookies: [mayaToken],
      }),
    );
    expect(turn.metadata?.statusCode).toBe(200);
    expect(turn.metadata?.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(turn.metadata?.headers['transfer-encoding']).toBeUndefined();
    const events = parseSse(turn.body).frames.map((f) => TurnStreamEvent.parse(JSON.parse(f.data)));
    expect(events[0]?.event).toBe('turn.accepted');
    expect(events.at(-1)?.event).toBe('turn.completed');

    // After real traffic, the public health reports the observed state (still without a query).
    const health = await invoke(urlEvent('GET', '/api/v1/health'));
    expect(HealthResponse.parse(JSON.parse(health.body)).db).toBe('awake');
  });
});

describe('worker handler (SQS batch)', () => {
  it('drops malformed messages, skips stale jobs and runs embedding backfills', async () => {
    const record = (messageId: string, body: string) => ({
      messageId,
      receiptHandle: 'r',
      body,
      attributes: {
        ApproximateReceiveCount: '1',
        SentTimestamp: '0',
        SenderId: 'x',
        ApproximateFirstReceiveTimestamp: '0',
      },
      messageAttributes: {},
      md5OfBody: '',
      eventSource: 'aws:sqs',
      eventSourceARN: 'arn:aws:sqs:us-east-1:123456789012:FoundryAscent-Jobs',
      awsRegion: 'us-east-1',
    });
    const result = await worker(
      {
        Records: [
          record('m1', 'not json'),
          record('m2', JSON.stringify({ type: 'unknown_job' })),
          record(
            'm3',
            JSON.stringify({
              type: 'ingest_document',
              documentId: '00000000-0000-4000-8000-000000000001',
              tenantId: '00000000-0000-4000-8000-000000000002',
              ventureId: '00000000-0000-4000-8000-000000000003',
              requestId: 'req-x',
            }),
          ),
          record('m4', JSON.stringify({ type: 'backfill_embeddings', maxItems: 20 })),
        ],
      },
      lambdaContext(100_000),
    );
    expect(result.batchItemFailures).toEqual([]);
  });
});
