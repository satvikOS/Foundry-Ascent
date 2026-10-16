import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { type EnqueueOptions, type JobMessage, type JobQueue, MAX_JOB_DELAY_SECONDS } from '@foundry/core';

export interface SqsJobQueueOptions {
  readonly queueUrl: string;
  readonly region: string;
  /** Injected client (tests). */
  readonly client?: SQSClient;
}

/** The FIFO message group of a job: jobs of one venture (or one persona library) are processed in order. */
function messageGroup(job: JobMessage): string {
  return job.type === 'ingest_knowledge_source' ? job.personaId : job.ventureId;
}

/**
 * Jobs queue adapter (core `JobQueue` port): one JSON message per job. The body carries identifiers only
 * (`JobMessage`), never content. Deduplication ids apply to FIFO queues only; the standard queue relies
 * on the worker's idempotent processing (ingestion re-checks the document status, distillation the turn
 * count). Delays use SQS `DelaySeconds` (standard queues only: FIFO queues cannot delay one message).
 */
export class SqsJobQueue implements JobQueue {
  readonly #queueUrl: string;
  readonly #client: SQSClient;
  readonly #fifo: boolean;

  constructor(options: SqsJobQueueOptions) {
    this.#queueUrl = options.queueUrl;
    this.#client = options.client ?? new SQSClient({ region: options.region });
    this.#fifo = options.queueUrl.endsWith('.fifo');
  }

  async enqueue(job: JobMessage, options: EnqueueOptions = {}): Promise<void> {
    const delay = Math.trunc(options.delaySeconds ?? 0);
    if (!Number.isFinite(delay) || delay < 0 || delay > MAX_JOB_DELAY_SECONDS) {
      throw new RangeError(`job delay must be 0–${String(MAX_JOB_DELAY_SECONDS)} seconds`);
    }
    if (delay > 0 && this.#fifo) throw new Error('a FIFO jobs queue cannot delay one message');
    await this.#client.send(
      new SendMessageCommand({
        QueueUrl: this.#queueUrl,
        MessageBody: JSON.stringify(job),
        MessageAttributes: { jobType: { DataType: 'String', StringValue: job.type } },
        ...(delay > 0 ? { DelaySeconds: delay } : {}),
        ...(this.#fifo
          ? {
              MessageGroupId: messageGroup(job),
              ...(options.deduplicationId
                ? { MessageDeduplicationId: options.deduplicationId.slice(0, 128) }
                : {}),
            }
          : {}),
      }),
    );
  }
}
