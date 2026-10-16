import { randomUUID } from 'node:crypto';

import { type EnqueueOptions, type JobMessage, type JobQueue, MAX_JOB_DELAY_SECONDS } from '@foundry/core';

import { type JobOutcome, type WorkerJob } from '../jobs/worker.js';
import { errorFields, type Logger } from '../logging.js';

/** Runs one job (the worker's `dispatchJob`); `retry` asks for another attempt. */
export type JobProcessor = (
  job: WorkerJob,
  attempt: { readonly attempt: number; readonly maxAttempts: number; readonly requestId: string },
) => Promise<JobOutcome>;

export interface InlineJobQueueOptions {
  readonly logger: Logger;
  readonly maxAttempts?: number;
  /** Delay before a retry (ms). */
  readonly retryDelayMs?: number;
}

/**
 * In-process JobQueue for the local dev server: jobs run right after `enqueue` returns, or after their delay
 * (like the worker picking them up from SQS), with SQS-like retries when a job asks for one. `submit` also
 * runs the worker's scheduled jobs (daily maintenance). Attach the processor after creating core (core needs
 * the queue, the processor needs core).
 */
export class InlineJobQueue implements JobQueue {
  readonly #logger: Logger;
  readonly #maxAttempts: number;
  readonly #retryDelayMs: number;
  #processor: JobProcessor | null = null;
  #stopped = false;
  readonly #running = new Set<Promise<void>>();
  readonly #delayed = new Set<NodeJS.Timeout>();

  constructor(options: InlineJobQueueOptions) {
    this.#logger = options.logger;
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#retryDelayMs = options.retryDelayMs ?? 1_000;
  }

  attach(processor: JobProcessor): void {
    this.#processor = processor;
  }

  enqueue(job: JobMessage, options: EnqueueOptions = {}): Promise<void> {
    return this.submit(job, options.delaySeconds ?? 0);
  }

  /** Runs any job the worker understands, after `delaySeconds`. */
  submit(job: WorkerJob, delaySeconds = 0): Promise<void> {
    const processor = this.#processor;
    if (processor === null) return Promise.reject(new Error('InlineJobQueue has no processor attached'));
    if (this.#stopped) return Promise.reject(new Error('InlineJobQueue is stopped'));
    const delay = Math.trunc(delaySeconds);
    if (!Number.isFinite(delay) || delay < 0 || delay > MAX_JOB_DELAY_SECONDS) {
      return Promise.reject(new RangeError(`job delay must be 0–${String(MAX_JOB_DELAY_SECONDS)} seconds`));
    }
    if (delay === 0) {
      this.#start(processor, job);
      return Promise.resolve();
    }
    const timer = setTimeout(() => {
      this.#delayed.delete(timer);
      if (!this.#stopped) this.#start(processor, job);
    }, delay * 1000);
    // A pending delayed job never keeps the process alive (like an SQS message waiting for a worker).
    timer.unref();
    this.#delayed.add(timer);
    return Promise.resolve();
  }

  /** Delayed jobs that have not started yet. */
  get pending(): number {
    return this.#delayed.size;
  }

  /** Resolves when every job started so far has finished (tests, shutdown); delayed jobs are not awaited. */
  async idle(): Promise<void> {
    while (this.#running.size > 0) await Promise.all([...this.#running]);
  }

  /** Drops the delayed jobs and refuses new ones (shutdown); running jobs finish (`idle`). */
  stop(): void {
    this.#stopped = true;
    for (const timer of this.#delayed) clearTimeout(timer);
    this.#delayed.clear();
  }

  #start(processor: JobProcessor, job: WorkerJob): void {
    const run = this.#run(processor, job);
    this.#running.add(run);
    void run.finally(() => this.#running.delete(run));
  }

  async #run(processor: JobProcessor, job: WorkerJob): Promise<void> {
    const requestId = job.requestId ?? `job-${randomUUID()}`;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      let outcome: JobOutcome;
      try {
        outcome = await processor(job, { attempt, maxAttempts: this.#maxAttempts, requestId });
      } catch (err) {
        // The dispatch reports failures as outcomes; this only guards against a bug escaping it.
        this.#logger.error('jobs.inline_crash', { requestId, type: job.type, attempt, ...errorFields(err) });
        return;
      }
      if (outcome === 'done') return;
      const retry = attempt < this.#maxAttempts && !this.#stopped;
      this.#logger.warn('jobs.inline_retry', { requestId, type: job.type, attempt, retry });
      if (!retry) return;
      await new Promise((resolve) => setTimeout(resolve, this.#retryDelayMs * attempt));
    }
  }
}
