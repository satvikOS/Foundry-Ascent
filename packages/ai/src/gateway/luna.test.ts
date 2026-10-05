import { describe, expect, it } from 'vitest';

import { Deadline } from './deadline.js';
import { ModelOutputInvalidError, ModelRefusalError, ModelUnavailableError } from './errors.js';
import { LunaProvider, mantleBaseUrl } from './luna.js';
import {
  Answer,
  STATIC_CREDENTIALS,
  VALID_ANSWER,
  chatCompletion,
  hangUntilAborted,
  jsonResponse,
  providerRequest,
  scriptedFetch,
  type FetchStep,
} from './test-helpers.js';

function luna(steps: FetchStep[]) {
  const { fetch, requests } = scriptedFetch(steps);
  const provider = new LunaProvider({
    modelId: 'openai.gpt-6-luna',
    region: 'us-east-1',
    credentials: STATIC_CREDENTIALS,
    fetch,
  });
  return { provider, requests };
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected rejection');
}

describe('LunaProvider', () => {
  it('uses the Mantle base URL for the region', () => {
    expect(mantleBaseUrl('us-east-1')).toBe('https://bedrock-mantle.us-east-1.api.aws/openai/v1');
  });

  it('sends a SigV4-signed strict json_schema chat completion and parses the result', async () => {
    const { provider, requests } = luna([() => chatCompletion(JSON.stringify(VALID_ANSWER))]);
    const result = await provider.generate(providerRequest(Answer));

    expect(result.value).toEqual(VALID_ANSWER);
    expect(result.modelId).toBe('openai.gpt-6-luna');
    expect(result.rawAttempts).toEqual([
      {
        provider: 'luna',
        modelId: 'openai.gpt-6-luna',
        kind: 'initial',
        outcome: 'ok',
        latencyMs: expect.any(Number) as number,
        usage: { inputTokens: 1_000, outputTokens: 200 },
        errorName: null,
      },
    ]);

    const req = requests[0];
    if (!req) throw new Error('no request');
    expect(req.url).toBe('https://bedrock-mantle.us-east-1.api.aws/openai/v1/chat/completions');
    expect(req.headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/bedrock-mantle\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(req.body.model).toBe('openai.gpt-6-luna');
    expect(req.body.max_completion_tokens).toBe(512);
    expect(req.body.messages).toEqual([
      { role: 'system', content: 'SYSTEM PROMPT SECRET' },
      { role: 'user', content: 'FOUNDER TEXT SECRET' },
    ]);
    expect(req.body.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'Answer',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            answer: { type: 'string' },
            score: { type: 'number' },
            tags: { type: 'array', items: { type: 'string' } },
            note: { type: ['string', 'null'] },
          },
          required: ['answer', 'score', 'tags', 'note'],
          additionalProperties: false,
        },
      },
    });
    expect(req.body).not.toHaveProperty('reasoning_effort');
  });

  it('performs one repair retry with validation feedback after invalid output', async () => {
    const { provider, requests } = luna([
      () => chatCompletion('{"answer": "x", "score": 7, "tags": [], "note": null}'),
      () => chatCompletion(JSON.stringify(VALID_ANSWER), { promptTokens: 1_300 }),
    ]);
    const result = await provider.generate(providerRequest(Answer));
    expect(result.value).toEqual(VALID_ANSWER);
    expect(result.rawAttempts.map((a) => [a.kind, a.outcome])).toEqual([
      ['initial', 'invalid_output'],
      ['repair', 'ok'],
    ]);
    const repairMessages = requests[1]?.body.messages as { role: string; content: string }[];
    expect(repairMessages).toHaveLength(4);
    expect(repairMessages[2]).toEqual({
      role: 'assistant',
      content: '{"answer": "x", "score": 7, "tags": [], "note": null}',
    });
    expect(repairMessages[3]?.role).toBe('user');
    expect(repairMessages[3]?.content).toContain('did not satisfy the required JSON schema "Answer"');
    expect(repairMessages[3]?.content).toContain('score');
  });

  it('does not echo an empty assistant turn in the repair request', async () => {
    const { provider, requests } = luna([
      () => chatCompletion(''),
      () => chatCompletion(JSON.stringify(VALID_ANSWER)),
    ]);
    await provider.generate(providerRequest(Answer));
    const repairMessages = requests[1]?.body.messages as { role: string }[];
    expect(repairMessages.map((m) => m.role)).toEqual(['system', 'user', 'user']);
  });

  it('repairs non-JSON output and accepts fenced JSON', async () => {
    const { provider } = luna([
      () => chatCompletion('Sure! Here is my answer.'),
      () => chatCompletion(`\`\`\`json\n${JSON.stringify(VALID_ANSWER)}\n\`\`\``),
    ]);
    const result = await provider.generate(providerRequest(Answer));
    expect(result.value).toEqual(VALID_ANSWER);
  });

  it('throws ModelOutputInvalidError after the repair also fails, with both attempts', async () => {
    const { provider } = luna([() => chatCompletion('not json'), () => chatCompletion('{"answer": 1}')]);
    const error = await captureError(provider.generate(providerRequest(Answer)));
    expect(error).toBeInstanceOf(ModelOutputInvalidError);
    const e = error as ModelOutputInvalidError;
    expect(e.rawAttempts.map((a) => a.outcome)).toEqual(['invalid_output', 'invalid_output']);
    expect(e.issues.length).toBeGreaterThan(0);
    for (const issue of e.issues) expect(issue).toMatch(/^[\w.[\]()]+: [a-z_]+$/);
    expect(e.message).not.toContain('answer');
  });

  it('flags truncated JSON when finish_reason is length', async () => {
    const { provider } = luna([
      () => chatCompletion('{"answer": "cut', { finishReason: 'length' }),
      () => chatCompletion('{"answer": "cut again', { finishReason: 'length' }),
    ]);
    const error = (await captureError(provider.generate(providerRequest(Answer)))) as ModelOutputInvalidError;
    expect(error.issues).toEqual(['(root): truncated_json']);
  });

  it('skips the repair when too little budget is left', async () => {
    const { provider, requests } = luna([() => chatCompletion('nope')]);
    const error = await captureError(
      provider.generate(providerRequest(Answer, { deadline: new Deadline(1_000) })),
    );
    expect(error).toBeInstanceOf(ModelOutputInvalidError);
    expect(requests).toHaveLength(1);
  });

  it('maps refusals to ModelRefusalError', async () => {
    const { provider } = luna([() => chatCompletion(null, { refusal: 'I cannot help with that.' })]);
    const error = await captureError(provider.generate(providerRequest(Answer)));
    expect(error).toBeInstanceOf(ModelRefusalError);
    expect((error as ModelRefusalError).source).toBe('model');
    expect((error as ModelRefusalError).rawAttempts[0]?.outcome).toBe('refusal');
  });

  it('maps content_filter finish to a refusal', async () => {
    const { provider } = luna([() => chatCompletion('', { finishReason: 'content_filter' })]);
    const error = (await captureError(provider.generate(providerRequest(Answer)))) as ModelRefusalError;
    expect(error).toBeInstanceOf(ModelRefusalError);
    expect(error.source).toBe('content_filter');
  });

  it.each([
    [429, 'throttled'],
    [500, 'server_error'],
    [503, 'server_error'],
    [400, 'client_error'],
    [403, 'client_error'],
  ] as const)(
    'maps HTTP %i to ModelUnavailableError(%s) without copying the message',
    async (status, reason) => {
      const { provider } = luna([
        () => jsonResponse({ error: { message: 'FOUNDER TEXT SECRET echoed', type: 'x' } }, status),
      ]);
      const error = (await captureError(provider.generate(providerRequest(Answer)))) as ModelUnavailableError;
      expect(error).toBeInstanceOf(ModelUnavailableError);
      expect(error.reason).toBe(reason);
      expect(error.message).not.toContain('SECRET');
      expect(error.rawAttempts[0]).toMatchObject({
        outcome: reason,
        usage: { inputTokens: 0, outputTokens: 0 },
      });
    },
  );

  it('times out via the deadline', async () => {
    const { provider } = luna([hangUntilAborted]);
    const error = (await captureError(
      provider.generate(providerRequest(Answer, { deadline: new Deadline(50) })),
    )) as ModelUnavailableError;
    expect(error).toBeInstanceOf(ModelUnavailableError);
    expect(error.reason).toBe('timeout');
    expect(error.retryable).toBe(true);
  });

  it('reports caller cancellation as aborted', async () => {
    const controller = new AbortController();
    const { provider } = luna([hangUntilAborted]);
    const pending = provider.generate(
      providerRequest(Answer, { deadline: new Deadline(5_000, controller.signal) }),
    );
    controller.abort();
    const error = (await captureError(pending)) as ModelUnavailableError;
    expect(error.reason).toBe('aborted');
  });

  it('maps network failures', async () => {
    const { provider } = luna([
      () => {
        throw new TypeError('fetch failed');
      },
    ]);
    const error = (await captureError(provider.generate(providerRequest(Answer)))) as ModelUnavailableError;
    expect(error.reason).toBe('network');
  });

  it('sends reasoning_effort only when configured', async () => {
    const { fetch, requests } = scriptedFetch([() => chatCompletion(JSON.stringify(VALID_ANSWER))]);
    const provider = new LunaProvider({
      modelId: 'openai.gpt-6-luna',
      region: 'us-east-1',
      credentials: STATIC_CREDENTIALS,
      fetch,
      reasoningEffort: 'low',
    });
    await provider.generate(providerRequest(Answer));
    expect(requests[0]?.body.reasoning_effort).toBe('low');
  });
});
