import { describe, expect, it, vi } from 'vitest';

import { rerankCostUsd } from '../pricing.js';
import { createBedrockReranker } from './rerank.js';
import { createModelGateway, modelGatewayConfigFromEnv } from './router.js';

const answer = (results: unknown): string => JSON.stringify({ results });
const signal = AbortSignal.timeout(5_000);

describe('the reranker', () => {
  it('gives one score per passage, in the order given', async () => {
    const invokeModel = vi.fn(() =>
      Promise.resolve(
        answer([
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.2 },
        ]),
      ),
    );
    const reranker = createBedrockReranker(
      { modelId: 'amazon.rerank-v1:0', region: 'us-west-2' },
      { invokeModel },
    );
    expect(await reranker.rerank('q', ['a', 'b'], signal)).toEqual([0.2, 0.9]);
    expect(invokeModel).toHaveBeenCalledWith(
      {
        modelId: 'amazon.rerank-v1:0',
        body: JSON.stringify({ query: 'q', documents: ['a', 'b'], top_n: 2 }),
      },
      signal,
    );
  });

  it('refuses an answer that leaves a passage out, and passes a failure on', async () => {
    const of = (invokeModel: () => Promise<string>) =>
      createBedrockReranker({ modelId: 'amazon.rerank-v1:0', region: 'us-west-2' }, { invokeModel });
    await expect(
      of(() => Promise.resolve(answer([{ index: 0, relevance_score: 0.2 }]))).rerank('q', ['a', 'b'], signal),
    ).rejects.toThrow();
    await expect(of(() => Promise.reject(new Error('down'))).rerank('q', ['a'], signal)).rejects.toThrow(
      'down',
    );
  });

  it('is billed by the query of 100 passages, an unknown model as the dearest', () => {
    expect(rerankCostUsd('amazon.rerank-v1:0', 8)).toBe(0.001);
    expect(rerankCostUsd('amazon.rerank-v1:0', 101)).toBe(0.002);
    expect(rerankCostUsd('someone.rerank', 8)).toBe(0.002);
  });
});

describe('the gateway’s reranker', () => {
  const env = { APP_ENV: 'production', MODEL_PROVIDER: 'bedrock' };

  it('is none unless one is configured, with the Region that serves it', () => {
    expect(createModelGateway(modelGatewayConfigFromEnv(env)).reranker).toBeUndefined();
    expect(
      createModelGateway(modelGatewayConfigFromEnv({ ...env, MODEL_RERANK_ID: ' ' })).reranker,
    ).toBeUndefined();
    const config = modelGatewayConfigFromEnv({ ...env, MODEL_RERANK_ID: 'amazon.rerank-v1:0' });
    expect(config).toMatchObject({ reranker: { modelId: 'amazon.rerank-v1:0', region: 'us-west-2' } });
    expect(createModelGateway(config).reranker?.modelId).toBe('amazon.rerank-v1:0');
    expect(() => modelGatewayConfigFromEnv({ ...env, MODEL_RERANK_REGION: 'moon' })).toThrow(
      'MODEL_RERANK_REGION',
    );
    expect(createModelGateway({ provider: 'mock' }).reranker).toBeUndefined();
  });
});
