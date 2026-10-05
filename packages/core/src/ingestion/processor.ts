import { createHash } from 'node:crypto';

import { MAX_DOCUMENT_BYTES, type PlatformSettingsView } from '@foundry/contracts';
import {
  DatabaseResumingError,
  auditRepo,
  documentsRepo,
  knowledgeRepo,
  settingsRepo,
  usageRepo,
  venturesRepo,
  type SystemExecutor,
} from '@foundry/db';

import { type Kit } from '../internal/kit.js';
import { spendCapExceeded } from '../orchestrator/guards.js';
import {
  ExtractionFailedError,
  JobMessage,
  ObjectNotFoundError,
  ObjectTooLargeError,
  type IngestDocumentJob,
} from '../ports.js';
import { chunkText, type TextChunk } from './chunker.js';

export interface IngestionResult {
  /** `ready`: chunks stored; `failed`: document marked failed; `skipped`: nothing to do (idempotent/no-op). */
  readonly status: 'ready' | 'failed' | 'skipped';
  readonly documentId: string | null;
  readonly chunks: number;
  /** Machine-readable reason for failed/skipped (never content). */
  readonly reason: string | null;
}

/** Transient failure: the worker reports the SQS message as a batch item failure so it is retried. */
export class RetryableIngestionError extends Error {
  override readonly name = 'RetryableIngestionError';
}

export interface IngestionProcessOptions {
  readonly requestId: string;
  /** SQS ApproximateReceiveCount (1-based). */
  readonly attempt?: number;
  /** Receives before the message goes to the DLQ; on the last one a transient failure marks the document failed. */
  readonly maxAttempts?: number;
}

export interface IngestionProcessor {
  /**
   * Processes one queued job with the owner role. Every write is scoped by the documents row (tenant,
   * venture), which must match the job's ids. Throws {@link RetryableIngestionError} for transient
   * failures; permanent failures mark the document `failed` with a reason code.
   */
  process(job: unknown, options: IngestionProcessOptions): Promise<IngestionResult>;
}

class PermanentFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** Thrown inside the storing transaction to roll it back when the document left `processing`. */
class StatusChanged extends Error {}

export function createIngestionProcessor(kit: Kit): IngestionProcessor {
  const { logger } = kit.deps;
  const cfg = kit.config.ingestion;

  async function systemAudit(sx: SystemExecutor, event: auditRepo.AuditEventInput): Promise<void> {
    await auditRepo.appendAudit(sx, event);
  }

  async function markFailed(job: IngestDocumentJob, requestId: string, reason: string): Promise<void> {
    await kit.system(async (sx) => {
      const updated = await documentsRepo.setDocumentStatus(sx, {
        documentId: job.documentId,
        status: 'failed',
        failureReason: reason,
        fromStatuses: ['processing'],
      });
      await systemAudit(sx, {
        action: 'document.ingestion_failed',
        outcome: 'failed',
        tenantId: job.tenantId,
        ventureId: job.ventureId,
        objectType: 'document',
        objectId: job.documentId,
        requestId,
        policyReason: reason,
        metadata: { updated: updated !== null },
      });
    });
  }

  /** Which daily spend cap (platform, or the uploader's) is reached right now, if any. */
  async function capReached(
    settings: PlatformSettingsView,
    uploadedBy: string,
  ): Promise<'global' | 'principal' | null> {
    const state = await kit.system(
      async (sx) => ({
        globalUsd: await usageRepo.spendToday(sx),
        principalUsd: await usageRepo.spendToday(sx, { principalId: uploadedBy }),
      }),
      { transaction: false },
    );
    return spendCapExceeded(state, settings);
  }

  /**
   * Embeds the chunks with the daily spend caps applied like a coaching turn: the platform's cap and the
   * uploader's own (usage is attributed to `documents.uploaded_by`). A cap reached before the first batch
   * fails the document with `spend_cap_reached` (the uploader retries after midnight UTC); one reached
   * part-way stops embedding, and the remaining chunks are stored without vectors (lexical retrieval finds
   * them; the backfill embeds them once the platform is under its cap).
   */
  async function embedChunks(
    chunks: readonly TextChunk[],
    job: IngestDocumentJob,
    uploadedBy: string,
    requestId: string,
  ): Promise<{ vectors: (number[] | null)[]; capped: 'global' | 'principal' | null }> {
    const settings = await kit.system((sx) => settingsRepo.getPlatformSettings(sx), { transaction: false });
    if (!settings.aiEnabled || chunks.length === 0) return { vectors: chunks.map(() => null), capped: null };
    const before = await capReached(settings, uploadedBy);
    if (before !== null) {
      await kit.system(
        (sx) =>
          systemAudit(sx, {
            action: 'spend_cap.reached',
            outcome: 'blocked',
            tenantId: job.tenantId,
            ventureId: job.ventureId,
            actorId: uploadedBy,
            objectType: 'document',
            objectId: job.documentId,
            requestId,
            policyReason: `${before}_daily_cap`,
            metadata: { scope: before, operation: 'ingestion' },
          }),
        { transaction: false },
      );
      throw new PermanentFailure('spend_cap_reached');
    }
    const vectors: (number[] | null)[] = [];
    let capped: 'global' | 'principal' | null = null;
    try {
      for (let i = 0; i < chunks.length; i += cfg.embedBatchSize) {
        if (i > 0) {
          capped = await capReached(settings, uploadedBy);
          if (capped !== null) break;
        }
        const batch = chunks.slice(i, i + cfg.embedBatchSize);
        const result = await kit.deps.gateway.embed(
          batch.map((c) => (c.heading ? `${c.heading}\n\n${c.content}` : c.content)),
          { purpose: 'ingestion', requestId },
        );
        await kit.recordUsage({
          ctx: { tenantId: job.tenantId, requestId, principalId: uploadedBy },
          ventureId: job.ventureId,
          purpose: 'ingestion',
          attempts: [{ modelId: result.modelId, usage: result.usage, costUsd: result.costUsd }],
        });
        for (let j = 0; j < batch.length; j += 1) {
          const v = result.vectors[j];
          vectors.push(v?.length === knowledgeRepo.EMBEDDING_DIMENSIONS ? v : null);
        }
      }
      while (vectors.length < chunks.length) vectors.push(null);
      if (capped !== null) {
        logger.warn('ingestion.embeddings_capped', { requestId, documentId: job.documentId, scope: capped });
      }
      return { vectors, capped };
    } catch (err) {
      // Lexical retrieval works without vectors; the backfill embeds them later.
      logger.warn('ingestion.embeddings_deferred', {
        requestId,
        documentId: job.documentId,
        error: err instanceof Error ? err.name : 'unknown',
      });
      return { vectors: chunks.map(() => null), capped };
    }
  }

  async function run(job: IngestDocumentJob, requestId: string): Promise<IngestionResult> {
    // 1. Re-validate the job against the database (the queue message is not authority).
    const loaded = await kit.system(
      async (sx) => {
        const document = await documentsRepo.getDocument(sx, job.documentId);
        const venture = document ? await venturesRepo.getVenture(sx, document.ventureId) : null;
        return { document, venture };
      },
      { transaction: false },
    );
    const { document, venture } = loaded;
    if (document === null)
      return { status: 'skipped', documentId: job.documentId, chunks: 0, reason: 'document_missing' };
    if (
      document.tenantId !== job.tenantId ||
      document.ventureId !== job.ventureId ||
      venture?.tenantId !== document.tenantId
    ) {
      await kit.system(
        (sx) =>
          systemAudit(sx, {
            action: 'ingestion.rejected',
            outcome: 'denied',
            tenantId: document.tenantId,
            ventureId: document.ventureId,
            objectType: 'document',
            objectId: document.id,
            requestId,
            policyReason: 'job_scope_mismatch',
          }),
        { transaction: false },
      );
      return { status: 'skipped', documentId: document.id, chunks: 0, reason: 'scope_mismatch' };
    }
    if (document.status !== 'processing') {
      return { status: 'skipped', documentId: document.id, chunks: 0, reason: `status_${document.status}` };
    }

    // 2. Fetch and extract.
    let data: Uint8Array;
    try {
      data = await kit.deps.objectStore.getObject(document.s3Key, { maxBytes: MAX_DOCUMENT_BYTES });
    } catch (err) {
      if (err instanceof ObjectNotFoundError) throw new PermanentFailure('object_missing');
      if (err instanceof ObjectTooLargeError) throw new PermanentFailure('too_large');
      throw err;
    }
    if (data.byteLength > MAX_DOCUMENT_BYTES) throw new PermanentFailure('too_large');
    const extractor = kit.deps.textExtractor;
    if (!extractor) throw new PermanentFailure('extractor_unavailable');
    let text: string;
    try {
      text = (await extractor.extract(data, document.contentType)).text;
    } catch (err) {
      logger.warn('ingestion.extract_failed', {
        requestId,
        documentId: document.id,
        error: err instanceof Error ? err.name : 'unknown',
        known: err instanceof ExtractionFailedError,
      });
      throw new PermanentFailure('extract_failed');
    }

    // 3. Chunk and embed.
    const { chunks, truncated } = chunkText(text, {
      targetTokens: cfg.chunkTokens,
      overlapRatio: cfg.overlapRatio,
      maxChunks: cfg.maxChunks,
    });
    if (chunks.length === 0) throw new PermanentFailure('empty_text');
    const { vectors: embeddings, capped } = await embedChunks(chunks, job, document.uploadedBy, requestId);

    // 4. Store chunks under the document's own tenant/venture (from the row, never from the message).
    const checksum = createHash('sha256').update(data).digest('hex');
    let stored: number;
    try {
      stored = await kit.system(async (sx) => {
        let sourceId = document.sourceId;
        if (sourceId) {
          await knowledgeRepo.deleteChunksForSource(sx, sourceId);
          await knowledgeRepo.setKnowledgeSourceStatus(sx, {
            sourceId,
            status: 'active',
            freshnessAt: kit.now(),
          });
        } else {
          const source = await knowledgeRepo.createKnowledgeSource(sx, {
            tenantId: document.tenantId,
            scope: 'venture',
            ventureId: document.ventureId,
            title: document.filename,
            owner: venture.name,
            classification: venture.classification,
            checksum,
            createdBy: document.uploadedBy,
          });
          sourceId = source.id;
        }
        const inserted = await knowledgeRepo.insertChunks(sx, {
          sourceId,
          tenantId: document.tenantId,
          scope: 'venture',
          ventureId: document.ventureId,
          chunks: chunks.map((c, i) => ({
            ordinal: c.ordinal,
            heading: c.heading,
            content: c.content,
            tokenCount: c.tokenCount,
            embedding: embeddings[i] ?? null,
          })),
        });
        const ready = await documentsRepo.setDocumentStatus(sx, {
          documentId: document.id,
          status: 'ready',
          sourceId,
          fromStatuses: ['processing'],
        });
        // Deleted (or re-queued) while we worked: roll the chunks back.
        if (ready === null) throw new StatusChanged();
        await systemAudit(sx, {
          action: 'document.ingested',
          outcome: 'succeeded',
          tenantId: document.tenantId,
          ventureId: document.ventureId,
          objectType: 'document',
          objectId: document.id,
          requestId,
          metadata: {
            chunks: inserted,
            embedded: embeddings.filter((e) => e !== null).length,
            truncated,
            bytes: data.byteLength,
            spendCapped: capped,
          },
        });
        return inserted;
      });
    } catch (err) {
      if (err instanceof StatusChanged)
        return { status: 'skipped', documentId: document.id, chunks: 0, reason: 'status_changed' };
      throw err;
    }
    return {
      status: 'ready',
      documentId: document.id,
      chunks: stored,
      reason: truncated ? 'truncated' : null,
    };
  }

  return {
    async process(rawJob, options) {
      const parsed = JobMessage.safeParse(rawJob);
      if (!parsed.success) {
        logger.warn('ingestion.invalid_job', {
          requestId: options.requestId,
          issues: parsed.error.issues.length,
        });
        return { status: 'skipped', documentId: null, chunks: 0, reason: 'invalid_job' };
      }
      const job = parsed.data;
      const requestId = options.requestId;
      try {
        return await run(job, requestId);
      } catch (err) {
        if (err instanceof PermanentFailure) {
          await markFailed(job, requestId, err.reason);
          return { status: 'failed', documentId: job.documentId, chunks: 0, reason: err.reason };
        }
        const attempt = options.attempt ?? 1;
        const maxAttempts = options.maxAttempts ?? 3;
        logger.warn('ingestion.transient_failure', {
          requestId,
          documentId: job.documentId,
          attempt,
          error: err instanceof Error ? err.name : 'unknown',
          resuming: err instanceof DatabaseResumingError,
        });
        if (attempt >= maxAttempts) {
          try {
            await markFailed(job, requestId, 'retries_exhausted');
          } catch {
            // The DLQ alarm covers a database that is still unavailable.
          }
          return { status: 'failed', documentId: job.documentId, chunks: 0, reason: 'retries_exhausted' };
        }
        throw new RetryableIngestionError('ingestion failed transiently', { cause: err });
      }
    },
  };
}
