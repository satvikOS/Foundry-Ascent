import { describe, expect, it } from 'vitest';

import type { InvokeModelFn, InvokeModelJsonInput } from './bedrock-runtime.js';
import { ModelOutputInvalidError, ModelUnavailableError } from './errors.js';
import { awsError } from './test-helpers.js';
import { TITAN_MAX_INPUT_CHARS, TitanEmbedder } from './titan.js';

function vectorFor(text: string, dims = 1024): number[] {
  const v = new Array<number>(dims).fill(0);
  v[text.length % dims] = 1;
  return v;
}

function fakeInvoke(
  options: { delayMs?: (text: string) => number; fail?: (text: string) => Error | null; dims?: number } = {},
) {
  const calls: { modelId: string; body: { inputText: string; dimensions: number; normalize: boolean } }[] =
    [];
  let inFlight = 0;
  let maxInFlight = 0;
  const invoke: InvokeModelFn = async (input: InvokeModelJsonInput) => {
    const body = JSON.parse(input.body) as { inputText: string; dimensions: number; normalize: boolean };
    calls.push({ modelId: input.modelId, body });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs?.(body.inputText) ?? 1));
      const failure = options.fail?.(body.inputText) ?? null;
      if (failure) throw failure;
      return JSON.stringify({
        embedding: vectorFor(body.inputText, options.dims),
        inputTextTokenCount: body.inputText.split(' ').length,
      });
    } finally {
      inFlight -= 1;
    }
  };
  return { invoke, calls, maxInFlight: () => maxInFlight };
}

describe('TitanEmbedder', () => {
  it('sends {inputText, dimensions: 1024, normalize: true} and keeps input order under concurrency', async () => {
    const fake = fakeInvoke({ delayMs: (t) => (t.length % 3) * 5 });
    const embedder = new TitanEmbedder({
      modelId: 'amazon.titan-embed-text-v2:0',
      region: 'us-east-1',
      invokeModel: fake.invoke,
      concurrency: 3,
    });
    const texts = ['a', 'bb bb', 'ccc', 'dddd dd', 'eeeee', 'ffffff', 'g'];
    const result = await embedder.embed(texts);

    expect(result.vectors).toEqual(texts.map((t) => vectorFor(t)));
    expect(result.modelId).toBe('amazon.titan-embed-text-v2:0');
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 0 });
    expect(result.rawAttempts).toHaveLength(texts.length);
    expect(fake.calls.every((c) => c.modelId === 'amazon.titan-embed-text-v2:0')).toBe(true);
    expect(fake.calls[0]?.body).toEqual({ inputText: 'a', dimensions: 1024, normalize: true });
    expect(fake.maxInFlight()).toBeLessThanOrEqual(3);
    expect(fake.maxInFlight()).toBeGreaterThan(1);
  });

  it('truncates inputs beyond the Titan limit', async () => {
    const fake = fakeInvoke();
    const embedder = new TitanEmbedder({
      modelId: 'amazon.titan-embed-text-v2:0',
      region: 'us-east-1',
      invokeModel: fake.invoke,
    });
    await embedder.embed(['x'.repeat(TITAN_MAX_INPUT_CHARS + 10)]);
    expect(fake.calls[0]?.body.inputText.length).toBe(TITAN_MAX_INPUT_CHARS);
  });

  it('rejects empty inputs', async () => {
    const embedder = new TitanEmbedder({
      modelId: 'm',
      region: 'us-east-1',
      invokeModel: fakeInvoke().invoke,
    });
    await expect(embedder.embed(['ok', '  '])).rejects.toThrow(TypeError);
  });

  it('rejects vectors of the wrong dimension', async () => {
    const embedder = new TitanEmbedder({
      modelId: 'm',
      region: 'us-east-1',
      invokeModel: fakeInvoke({ dims: 256 }).invoke,
    });
    const error = await embedder.embed(['a']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelOutputInvalidError);
    expect((error as ModelOutputInvalidError).rawAttempts[0]?.outcome).toBe('invalid_output');
  });

  it('maps SDK errors and records attempts made before the failure', async () => {
    const fake = fakeInvoke({
      fail: (t) => (t === 'boom' ? awsError('ThrottlingException', 'slow down', 429) : null),
    });
    const embedder = new TitanEmbedder({
      modelId: 'm',
      region: 'us-east-1',
      invokeModel: fake.invoke,
      concurrency: 1,
    });
    const error = (await embedder
      .embed(['one', 'boom', 'three'])
      .catch((e: unknown) => e)) as ModelUnavailableError;
    expect(error).toBeInstanceOf(ModelUnavailableError);
    expect(error.reason).toBe('throttled');
    expect(error.rawAttempts.map((a) => a.outcome)).toEqual(['ok', 'throttled']);
    expect(fake.calls).toHaveLength(2); // stops scheduling after the first failure
  });

  it('times out slow calls', async () => {
    const fake = fakeInvoke({ delayMs: () => 200 });
    const invoke: InvokeModelFn = (input, signal) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
        void fake.invoke(input, signal).then(resolve);
      });
    const embedder = new TitanEmbedder({
      modelId: 'm',
      region: 'us-east-1',
      invokeModel: invoke,
      timeoutMs: 20,
    });
    const error = (await embedder.embed(['slow']).catch((e: unknown) => e)) as ModelUnavailableError;
    expect(error.reason).toBe('timeout');
  });
});
