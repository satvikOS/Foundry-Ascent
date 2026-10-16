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
  type IngestKnowledgeSourceJob,
} from '../ports.js';
import { chunkText, type TextChunk } from './chunker.js';

export interface IngestionResult {
  /** `ready`: chunks stored; `failed`: document/source marked failed; `skipped`: nothing to do (idempotent/no-op). */
  readonly status: 'ready' | 'failed' | 'skipped';
  /** The venture document ingested (`ingest_document` jobs). */
  readonly documentId: string | null;
  /** The persona knowledge source ingested (`ingest_knowledge_source` jobs). */
  readonly sourceId?: string | null;
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
   * Processes one queued job with the owner role. Every write is scoped by the database row the job names
   * (a venture document: its tenant and venture; a persona library upload: its tenant and persona), which
   * must match the job's ids. Throws {@link RetryableIngestionError} for transient failures; permanent
   * failures mark the document or source `failed` with a reason code.
   */
  process(job: unknown, options: IngestionProcessOptions): Promise<IngestionResult>;
}

/** What a job ingests, for audit events and spend attribution. */
interface IngestionTarget {
  readonly tenantId: string;
  readonly ventureId: string | null;
  readonly objectType: 'document' | 'knowledge_source';
  readonly objectId: string;
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

  async function markFailed(job: JobMessage, requestId: string, reason: string): Promise<void> {
    if (job.type === 'ingest_knowledge_source') {
      await kit.system(async (sx) => {
        const updated = await knowledgeRepo.setKnowledgeSourceStatus(sx, {
          sourceId: job.sourceId,
          status: 'failed',
          failureReason: reason,
          fromStatuses: ['processing'],
        });
        await systemAudit(sx, {
          action: 'knowledge.ingestion_failed',
          outcome: 'failed',
          tenantId: job.tenantId,
          objectType: 'knowledge_source',
          objectId: job.sourceId,
          requestId,
          policyReason: reason,
          metadata: { updated, personaId: job.personaId },
        });
      });
      return;
    }
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
    settings: Pick<PlatformSettingsView, 'dailyUsdCapGlobal' | 'dailyUsdCapPerPrincipal'>,
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

  /** Fetches and extracts an uploaded object (permanent failures for missing, oversized or unreadable files). */
  async function extract(
    key: string,
    contentType: Parameters<NonNullable<typeof kit.deps.textExtractor>['extract']>[1],
    target: IngestionTarget,
    requestId: string,
  ): Promise<{ text: string; data: Uint8Array }> {
    let data: Uint8Array;
    try {
      data = await kit.deps.objectStore.getObject(key, { maxBytes: MAX_DOCUMENT_BYTES });
    } catch (err) {
      if (err instanceof ObjectNotFoundError) throw new PermanentFailure('object_missing');
      if (err instanceof ObjectTooLargeError) throw new PermanentFailure('too_large');
      throw err;
    }
    if (data.byteLength > MAX_DOCUMENT_BYTES) throw new PermanentFailure('too_large');
    const extractor = kit.deps.textExtractor;
    if (!extractor) throw new PermanentFailure('extractor_unavailable');
    try {
      return { text: (await extractor.extract(data, contentType)).text, data };
    } catch (err) {
      logger.warn('ingestion.extract_failed', {
        requestId,
        [target.objectType === 'document' ? 'documentId' : 'sourceId']: target.objectId,
        error: err instanceof Error ? err.name : 'unknown',
        known: err instanceof ExtractionFailedError,
      });
      throw new PermanentFailure('extract_failed');
    }
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
    target: IngestionTarget,
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
            tenantId: target.tenantId,
            ventureId: target.ventureId,
            actorId: uploadedBy,
            objectType: target.objectType,
            objectId: target.objectId,
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
          ctx: { tenantId: target.tenantId, requestId, principalId: uploadedBy },
          ventureId: target.ventureId,
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
        logger.warn('ingestion.embeddings_capped', { requestId, objectId: target.objectId, scope: capped });
      }
      return { vectors, capped };
    } catch (err) {
      // Lexical retrieval works without vectors; the backfill embeds them later.
      logger.warn('ingestion.embeddings_deferred', {
        requestId,
        objectId: target.objectId,
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
    const target: IngestionTarget = {
      tenantId: document.tenantId,
      ventureId: document.ventureId,
      objectType: 'document',
      objectId: document.id,
    };
    const { text, data } = await extract(document.s3Key, document.contentType, target, requestId);

    // 3. Chunk and embed.
    const { chunks, truncated } = chunkText(text, {
      targetTokens: cfg.chunkTokens,
      overlapRatio: cfg.overlapRatio,
      maxChunks: cfg.maxChunks,
    });
    if (chunks.length === 0) throw new PermanentFailure('empty_text');
    const { vectors: embeddings, capped } = await embedChunks(chunks, target, document.uploadedBy, requestId);

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

  /** A persona library upload: chunks under the source's own tenant and persona (from the row). */
  async function runSource(job: IngestKnowledgeSourceJob, requestId: string): Promise<IngestionResult> {
    const source = await kit.system((sx) => knowledgeRepo.getKnowledgeSource(sx, job.sourceId), {
      transaction: false,
    });
    const skipped = (reason: string): IngestionResult => ({
      status: 'skipped',
      documentId: null,
      sourceId: job.sourceId,
      chunks: 0,
      reason,
    });
    if (source === null) return skipped('source_missing');
    if (
      source.tenantId !== job.tenantId ||
      source.scope !== 'persona' ||
      source.personaId !== job.personaId ||
      source.s3Key === null ||
      source.contentType === null
    ) {
      await kit.system(
        (sx) =>
          systemAudit(sx, {
            action: 'ingestion.rejected',
            outcome: 'denied',
            tenantId: source.tenantId,
            objectType: 'knowledge_source',
            objectId: source.id,
            requestId,
            policyReason: 'job_scope_mismatch',
          }),
        { transaction: false },
      );
      return skipped('scope_mismatch');
    }
    if (source.status !== 'processing') return skipped(`status_${source.status}`);
    const target: IngestionTarget = {
      tenantId: source.tenantId,
      ventureId: null,
      objectType: 'knowledge_source',
      objectId: source.id,
    };
    const { text, data } = await extract(source.s3Key, source.contentType, target, requestId);
    const { chunks, truncated } = chunkText(text, {
      targetTokens: cfg.chunkTokens,
      overlapRatio: cfg.overlapRatio,
      maxChunks: cfg.maxChunks,
    });
    if (chunks.length === 0) throw new PermanentFailure('empty_text');
    const uploader = source.createdBy;
    const { vectors, capped } =
      uploader === null
        ? { vectors: chunks.map(() => null), capped: null }
        : await embedChunks(chunks, target, uploader, requestId);
    const checksum = createHash('sha256').update(data).digest('hex');
    let stored: number;
    try {
      stored = await kit.system(async (sx) => {
        await knowledgeRepo.deleteChunksForSource(sx, source.id);
        const inserted = await knowledgeRepo.insertChunks(sx, {
          sourceId: source.id,
          tenantId: source.tenantId,
          scope: 'persona',
          personaId: source.personaId,
          chunks: chunks.map((c, i) => ({
            ordinal: c.ordinal,
            heading: c.heading,
            content: c.content,
            tokenCount: c.tokenCount,
            embedding: vectors[i] ?? null,
          })),
        });
        const ready = await knowledgeRepo.setKnowledgeSourceStatus(sx, {
          sourceId: source.id,
          status: 'active',
          freshnessAt: kit.now(),
          fromStatuses: ['processing'],
          checksum,
        });
        // Withdrawn (or re-queued) while we worked: roll the chunks back.
        if (!ready) throw new StatusChanged();
        await systemAudit(sx, {
          action: 'knowledge.ingested',
          outcome: 'succeeded',
          tenantId: source.tenantId,
          objectType: 'knowledge_source',
          objectId: source.id,
          requestId,
          metadata: {
            personaId: job.personaId,
            chunks: inserted,
            embedded: vectors.filter((v) => v !== null).length,
            truncated,
            bytes: data.byteLength,
            spendCapped: capped,
          },
        });
        return inserted;
      });
    } catch (err) {
      if (err instanceof StatusChanged) return skipped('status_changed');
      throw err;
    }
    return {
      status: 'ready',
      documentId: null,
      sourceId: source.id,
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
      const ids =
        job.type === 'ingest_document'
          ? { documentId: job.documentId, sourceId: null }
          : { documentId: null, sourceId: job.sourceId };
      try {
        return job.type === 'ingest_document' ? await run(job, requestId) : await runSource(job, requestId);
      } catch (err) {
        if (err instanceof PermanentFailure) {
          await markFailed(job, requestId, err.reason);
          return { status: 'failed', ...ids, chunks: 0, reason: err.reason };
        }
        const attempt = options.attempt ?? 1;
        const maxAttempts = options.maxAttempts ?? 3;
        logger.warn('ingestion.transient_failure', {
          requestId,
          documentId: ids.documentId,
          sourceId: ids.sourceId,
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
          return { status: 'failed', ...ids, chunks: 0, reason: 'retries_exhausted' };
        }
        throw new RetryableIngestionError('ingestion failed transiently', { cause: err });
      }
    },
  };
}
