import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { type JobMessage, type JobQueue } from '@foundry/core';

export interface SqsJobQueueOptions {
  readonly queueUrl: string;
  readonly region: string;
  /** Injected client (tests). */
  readonly client?: SQSClient;
}

/**
 * Jobs queue adapter (core `JobQueue` port): one JSON message per job. The body carries identifiers only
 * (`JobMessage`), never content. Deduplication ids apply to FIFO queues only; the standard queue relies
 * on the worker's idempotent processing (ingestion re-checks the document status).
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

  async enqueue(job: JobMessage, options: { readonly deduplicationId?: string } = {}): Promise<void> {
    await this.#client.send(
      new SendMessageCommand({
        QueueUrl: this.#queueUrl,
        MessageBody: JSON.stringify(job),
        MessageAttributes: { jobType: { DataType: 'String', StringValue: job.type } },
        ...(this.#fifo
          ? {
              MessageGroupId: job.ventureId,
              ...(options.deduplicationId
                ? { MessageDeduplicationId: options.deduplicationId.slice(0, 128) }
                : {}),
            }
          : {}),
      }),
    );
  }
}
