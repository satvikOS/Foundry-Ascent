import { isModelGatewayError, type ModelAttempt, type ModelGateway } from '@foundry/ai';

import { currentRequestMetrics, type RequestMetrics } from './request-metrics.js';

/** Counts the input tokens of a model call's attempts, whether it succeeded or failed (numbers only). */
async function counted<T extends { readonly attempts: readonly ModelAttempt[] }>(
  metrics: RequestMetrics,
  call: Promise<T>,
  firstStream = false,
): Promise<T> {
  try {
    const result = await call;
    metrics.recordModelUsage(
      result.attempts.map((a) => a.usage),
      firstStream,
    );
    return result;
  } catch (error) {
    if (isModelGatewayError(error)) {
      metrics.recordModelUsage(
        error.attempts.map((a) => a.usage),
        firstStream,
      );
    }
    throw error;
  }
}

/**
 * Wraps the model gateway so each call's timing reaches the current request's metrics: query embeddings
 * (count and time), the first streamed call's start and first text, and structured calls, and the input tokens of
 * every model call with those read from and written to the prompt cache. Nothing about the prompt or the output is
 * read. Calls outside a request pass through untouched.
 */
export function observeGateway(gateway: ModelGateway): ModelGateway {
  return {
    info: gateway.info,
    // Opening the model connection ahead of a call's first turn (LAB-P2) passes through.
    ...(gateway.prewarm ? { prewarm: () => gateway.prewarm?.() ?? Promise.resolve() } : {}),
    async embed(texts, options) {
      const metrics = currentRequestMetrics();
      const started = performance.now();
      try {
        return await gateway.embed(texts, options);
      } finally {
        if (metrics) {
          metrics.embed.calls += 1;
          metrics.embed.ms += performance.now() - started;
        }
      }
    },
    async generateStructured(request) {
      const metrics = currentRequestMetrics();
      const started = performance.now();
      try {
        const call = gateway.generateStructured(request);
        return await (metrics ? counted(metrics, call) : call);
      } finally {
        if (metrics) {
          metrics.structured.calls += 1;
          metrics.structured.ms += performance.now() - started;
        }
      }
    },
    streamText(request, onText) {
      const metrics = currentRequestMetrics();
      if (!metrics) return gateway.streamText(request, onText);
      metrics.stream.calls += 1;
      metrics.stream.startedAt ??= metrics.elapsed();
      const call = gateway.streamText(request, (text) => {
        metrics.stream.firstTokenAt ??= metrics.elapsed();
        return onText(text);
      });
      return counted(metrics, call, metrics.stream.calls === 1);
    },
  };
}
