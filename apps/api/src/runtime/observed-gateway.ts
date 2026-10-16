import { type ModelGateway } from '@foundry/ai';

import { currentRequestMetrics } from './request-metrics.js';

/**
 * Wraps the model gateway so each call's timing reaches the current request's metrics: query embeddings
 * (count and time), the first streamed call's start and first text, and structured calls. Nothing about
 * the prompt or the output is read. Calls outside a request pass through untouched.
 */
export function observeGateway(gateway: ModelGateway): ModelGateway {
  return {
    info: gateway.info,
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
        return await gateway.generateStructured(request);
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
      return gateway.streamText(request, (text) => {
        metrics.stream.firstTokenAt ??= metrics.elapsed();
        return onText(text);
      });
    },
  };
}
