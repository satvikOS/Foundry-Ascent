import { randomUUID } from 'node:crypto';

import { type JobMessage, type JobQueue, RetryableIngestionError } from '@foundry/core';

import { errorFields, type Logger } from '../logging.js';

export type JobProcessor = (
  job: JobMessage,
  attempt: { readonly attempt: number; readonly maxAttempts: number; readonly requestId: string },
) => Promise<void>;

export interface InlineJobQueueOptions {
  readonly logger: Logger;
  readonly maxAttempts?: number;
  /** Delay before a retry (ms). */
  readonly retryDelayMs?: number;
}

/**
 * In-process JobQueue for the local dev server: jobs run right after `enqueue` returns (like a worker
 * picking them up immediately), with SQS-like retries for `RetryableIngestionError`. Attach the
 * processor after creating core (core needs the queue, the processor needs core).
 */
export class InlineJobQueue implements JobQueue {
  readonly #logger: Logger;
  readonly #maxAttempts: number;
  readonly #retryDelayMs: number;
  #processor: JobProcessor | null = null;
  readonly #running = new Set<Promise<void>>();

  constructor(options: InlineJobQueueOptions) {
    this.#logger = options.logger;
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#retryDelayMs = options.retryDelayMs ?? 1_000;
  }

  attach(processor: JobProcessor): void {
    this.#processor = processor;
  }

  enqueue(job: JobMessage): Promise<void> {
    const processor = this.#processor;
    if (processor === null) return Promise.reject(new Error('InlineJobQueue has no processor attached'));
    const run = this.#run(processor, job);
    this.#running.add(run);
    void run.finally(() => this.#running.delete(run));
    return Promise.resolve();
  }

  /** Resolves when every job enqueued so far has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.#running.size > 0) await Promise.all([...this.#running]);
  }

  async #run(processor: JobProcessor, job: JobMessage): Promise<void> {
    const requestId = job.requestId ?? `job-${randomUUID()}`;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      try {
        await processor(job, { attempt, maxAttempts: this.#maxAttempts, requestId });
        return;
      } catch (err) {
        const retry = err instanceof RetryableIngestionError && attempt < this.#maxAttempts;
        this.#logger.warn('jobs.inline_failure', {
          requestId,
          type: job.type,
          attempt,
          retry,
          ...errorFields(err),
        });
        if (!retry) return;
        await new Promise((resolve) => setTimeout(resolve, this.#retryDelayMs * attempt));
      }
    }
  }
}
