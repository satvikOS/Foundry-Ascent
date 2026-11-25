import { rerankCostUsd } from '../pricing.js';
import { createBedrockRuntimeTransport, type InvokeModelFn } from './bedrock-runtime.js';
import { ModelOutputInvalidError } from './errors.js';
import { parseRerank, rerankBody } from './retrieval-models.js';
import type { AwsCredentialProvider, AwsCredentials } from './sigv4-fetch.js';
import type { Reranker } from './types.js';

export interface RerankerConfig {
  /** e.g. `amazon.rerank-v1:0`. */
  readonly modelId: string;
  /** Where it is served: rerankers are not in every Region the app's other models are. */
  readonly region: string;
}

/** A Bedrock reranker (`InvokeModel`). One attempt: its caller waits half a second and has an answer without it. */
export function createBedrockReranker(
  config: RerankerConfig,
  options: {
    readonly credentials?: AwsCredentials | AwsCredentialProvider;
    readonly invokeModel?: InvokeModelFn;
  } = {},
): Reranker {
  const { modelId, region } = config;
  let invoke = options.invokeModel;
  return {
    modelId,
    costUsd: (documents) => rerankCostUsd(modelId, documents),
    rerank: async (query, documents, signal) => {
      invoke ??= createBedrockRuntimeTransport({
        region,
        maxAttempts: 1,
        ...(options.credentials ? { credentials: options.credentials } : {}),
      }).invokeModel;
      const raw = await invoke({ modelId, body: rerankBody(modelId, query, documents) }, signal);
      const scores = new Array<number>(documents.length).fill(Number.NaN);
      for (const { index, score } of parseRerank(modelId, raw, documents.length)) scores[index] = score;
      if (scores.some((s) => Number.isNaN(s)))
        throw new ModelOutputInvalidError(modelId, ['rerank: missing_results']);
      return scores;
    },
  };
}
