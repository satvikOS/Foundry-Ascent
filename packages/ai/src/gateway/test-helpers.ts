// Test-only helpers shared by gateway tests (not exported from the package index).
import { z } from 'zod';

import { Deadline } from './deadline.js';
import { toStrictJsonSchema } from './json-schema.js';
import type { ProviderRequest } from './provider.js';
import type { FetchFn } from './sigv4-fetch.js';

export const STATIC_CREDENTIALS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret-example-key' };

export const Answer = z.object({
  answer: z.string(),
  score: z.number().min(0).max(1),
  tags: z.array(z.string()),
  note: z.string().nullable(),
});
export type Answer = z.infer<typeof Answer>;

export const VALID_ANSWER: Answer = {
  answer: 'Run five interviews.',
  score: 0.5,
  tags: ['discovery'],
  note: null,
};

export function providerRequest<T>(
  schema: z.ZodType<T>,
  overrides: Partial<ProviderRequest<T>> = {},
): ProviderRequest<T> {
  return {
    system: 'SYSTEM PROMPT SECRET',
    messages: [{ role: 'user', content: 'FOUNDER TEXT SECRET' }],
    schemaName: 'Answer',
    zodSchema: schema,
    strict: toStrictJsonSchema(schema),
    maxOutputTokens: 512,
    deadline: new Deadline(5_000),
    requestId: 'req-test',
    ...overrides,
  };
}

export interface RecordedRequest {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

export type FetchStep = (
  request: RecordedRequest,
  signal: AbortSignal | undefined,
) => Promise<Response> | Response;

/** A fake `fetch` that records JSON requests and replays scripted responses in order. */
export function scriptedFetch(steps: FetchStep[]): { fetch: FetchFn; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetch: FetchFn = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const bodyText =
      typeof init?.body === 'string'
        ? init.body
        : init?.body instanceof Uint8Array
          ? new TextDecoder().decode(init.body)
          : '{}';
    const recorded: RecordedRequest = {
      url,
      headers: new Headers(init?.headers),
      body: JSON.parse(bodyText) as Record<string, unknown>,
    };
    requests.push(recorded);
    const step = steps.shift();
    if (!step) throw new Error('unexpected fetch call');
    return step(recorded, init?.signal ?? undefined);
  };
  return { fetch, requests };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function chatCompletion(
  content: string | null,
  options: {
    finishReason?: string;
    refusal?: string | null;
    promptTokens?: number;
    completionTokens?: number;
  } = {},
): Response {
  return jsonResponse({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1_760_000_000,
    model: 'openai.gpt-6-luna',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content, refusal: options.refusal ?? null },
        finish_reason: options.finishReason ?? 'stop',
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: options.promptTokens ?? 1_000,
      completion_tokens: options.completionTokens ?? 200,
      total_tokens: (options.promptTokens ?? 1_000) + (options.completionTokens ?? 200),
    },
  });
}

/** A fetch step that never resolves until the request is aborted. */
export const hangUntilAborted: FetchStep = (_request, signal) =>
  new Promise<Response>((_resolve, reject) => {
    const fail = (): void => {
      reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    };
    if (signal?.aborted) fail();
    signal?.addEventListener('abort', fail, { once: true });
  });

/** An AWS SDK–style service exception. */
export function awsError(name: string, message: string, status = 400): Error {
  return Object.assign(new Error(message), {
    name,
    $metadata: { httpStatusCode: status },
    $fault: status >= 500 ? 'server' : 'client',
  });
}
