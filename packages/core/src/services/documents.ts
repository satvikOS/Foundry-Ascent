import { CreateDocumentRequest, type CreateDocumentResponse, type DocumentView } from '@foundry/contracts';
import { documentsRepo } from '@foundry/db';
import { type z } from 'zod';

import { requireVentureAccess } from '../authz/venture-access.js';
import { type RequestContext } from '../context.js';
import { DomainError, fail, parseInput } from '../errors.js';
import { audit, requireId, type Kit } from '../internal/kit.js';

type CreateDocumentResult = z.infer<typeof CreateDocumentResponse>;

export interface DocumentsService {
  /**
   * Registers an upload (`pending_upload`) under `tenants/{t}/ventures/{v}/documents/{id}/{filename}` and
   * returns a presigned PUT from the ObjectStore port (founder/team).
   */
  createUpload(
    ctx: RequestContext,
    ventureId: string,
    input: z.input<typeof CreateDocumentRequest>,
  ): Promise<CreateDocumentResult>;
  /** Marks the upload complete (`processing`, or retry after `failed`) and enqueues ingestion (founder/team). */
  complete(ctx: RequestContext, documentId: string): Promise<DocumentView>;
  /** Documents of a venture, newest first (read). */
  list(ctx: RequestContext, ventureId: string): Promise<DocumentView[]>;
  /** Soft-deletes a document (chunks removed from retrieval) and deletes the object (founder/team). */
  remove(ctx: RequestContext, documentId: string): Promise<void>;
}

/** S3-safe file name segment (the original name is kept in the database for display). */
export function storageFilename(filename: string): string {
  const cleaned = filename
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^A-Za-z0-9._ ()-]+/g, '_')
    .replace(/\s+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 120);
  return cleaned === '' ? 'document' : cleaned;
}

/** Venture-scoped object key (runtime contract). */
export function documentKey(args: {
  tenantId: string;
  ventureId: string;
  documentId: string;
  filename: string;
}): string {
  return `tenants/${args.tenantId}/ventures/${args.ventureId}/documents/${args.documentId}/${storageFilename(args.filename)}`;
}

export function createDocumentsService(kit: Kit): DocumentsService {
  const { objectStore, jobQueue } = kit.deps;

  return {
    createUpload: async (ctx, rawVentureId, rawInput) => {
      const ventureId = requireId(rawVentureId, 'Venture');
      const input = parseInput(CreateDocumentRequest, rawInput);
      const documentId = kit.deps.ids.uuid();
      const key = documentKey({ tenantId: ctx.tenantId, ventureId, documentId, filename: input.filename });
      const document = await kit.inRequest(ctx, async (scope) => {
        await requireVentureAccess(scope, ventureId, 'write', { objectType: 'document' });
        await documentsRepo.createDocument(scope.tx, {
          id: documentId,
          tenantId: ctx.tenantId,
          ventureId,
          filename: input.filename,
          contentType: input.contentType,
          sizeBytes: input.sizeBytes,
          s3Key: key,
          uploadedBy: ctx.principalId,
        });
        await audit(scope, {
          action: 'document.upload_requested',
          outcome: 'succeeded',
          ventureId,
          objectType: 'document',
          objectId: documentId,
          metadata: { contentType: input.contentType, sizeBytes: input.sizeBytes },
        });
        const view = await documentsRepo.getDocumentView(scope.tx, documentId);
        if (view === null) throw fail.notFound('Document');
        return view;
      });
      const presigned = await objectStore.presignPut({
        key,
        contentType: input.contentType,
        contentLength: input.sizeBytes,
        expiresInSeconds: kit.config.uploads.presignTtlSeconds,
      });
      return {
        document,
        upload: {
          url: presigned.url,
          method: 'PUT',
          headers: { ...presigned.headers },
          expiresAt: presigned.expiresAt,
        },
      };
    },

    complete: async (ctx, rawDocumentId) => {
      const documentId = requireId(rawDocumentId, 'Document');
      const doc = await kit.inRequest(ctx, async (scope) => {
        const current = await documentsRepo.getDocument(scope.tx, documentId);
        if (current === null || current.status === 'deleted') throw fail.notFound('Document');
        await requireVentureAccess(scope, current.ventureId, 'write', {
          objectType: 'document',
          objectId: documentId,
        });
        if (current.status === 'processing' || current.status === 'ready') return current;
        const updated = await documentsRepo.setDocumentStatus(scope.tx, {
          documentId,
          status: 'processing',
          fromStatuses: ['pending_upload', 'failed'],
        });
        if (updated === null) throw fail.conflict('The document cannot be processed in its current state');
        await audit(scope, {
          action: 'document.ingestion_requested',
          outcome: 'succeeded',
          ventureId: current.ventureId,
          objectType: 'document',
          objectId: documentId,
          metadata: { retry: current.status === 'failed' },
        });
        return updated;
      });
      if (doc.status === 'processing') {
        try {
          await jobQueue.enqueue(
            {
              type: 'ingest_document',
              documentId: doc.id,
              tenantId: doc.tenantId,
              ventureId: doc.ventureId,
              requestId: ctx.requestId,
            },
            { deduplicationId: `${doc.id}:${doc.updatedAt}` },
          );
        } catch (err) {
          await kit.inRequest(ctx, async (scope) => {
            await documentsRepo.setDocumentStatus(scope.tx, {
              documentId: doc.id,
              status: 'failed',
              failureReason: 'enqueue_failed',
              fromStatuses: ['processing'],
            });
          });
          throw new DomainError('internal', 'Document processing could not be started; please retry', {
            reason: 'enqueue_failed',
            cause: err,
          });
        }
      }
      return kit.inRequest(ctx, async ({ tx }) => {
        const view = await documentsRepo.getDocumentView(tx, doc.id);
        if (view === null) throw fail.notFound('Document');
        return view;
      });
    },

    list: async (ctx, rawVentureId) => {
      const ventureId = requireId(rawVentureId, 'Venture');
      return await kit.inRequest(ctx, async (scope) => {
        await requireVentureAccess(scope, ventureId, 'read', { objectType: 'document' });
        return documentsRepo.listDocuments(scope.tx, ventureId);
      });
    },

    remove: async (ctx, rawDocumentId) => {
      const documentId = requireId(rawDocumentId, 'Document');
      const key = await kit.inRequest(ctx, async (scope) => {
        const current = await documentsRepo.getDocument(scope.tx, documentId);
        if (current === null) throw fail.notFound('Document');
        await requireVentureAccess(scope, current.ventureId, 'write', {
          objectType: 'document',
          objectId: documentId,
        });
        const s3Key = await documentsRepo.softDeleteDocument(scope.tx, documentId);
        if (s3Key === null) throw fail.notFound('Document');
        await audit(scope, {
          action: 'document.deleted',
          outcome: 'succeeded',
          ventureId: current.ventureId,
          objectType: 'document',
          objectId: documentId,
        });
        return s3Key;
      });
      try {
        await objectStore.delete(key);
      } catch (err) {
        // The row is already deleted and its chunks removed; the bucket lifecycle catches leftovers.
        kit.deps.logger.warn('document.object_delete_failed', {
          requestId: ctx.requestId,
          documentId,
          error: err instanceof Error ? err.name : 'unknown',
        });
      }
    },
  };
}
