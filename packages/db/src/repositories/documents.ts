import { DocumentContentType, DocumentStatus, type DocumentView } from '@foundry/contracts';

import { camelRow, col, type CamelRow, type RawRow } from '../columns.js';
import { type SqlExecutor } from '../executor.js';
import { p } from '../params.js';
import { principalSelect, queryFirst, queryOne, queryRows, requiredPrincipalFrom } from './common.js';

const documentShape = {
  id: col.uuid,
  tenant_id: col.uuid,
  venture_id: col.uuid,
  filename: col.text,
  content_type: col.enum(DocumentContentType.options),
  size_bytes: col.int,
  s3_key: col.text,
  status: col.enum(DocumentStatus.options),
  failure_reason: col.text.nullable,
  source_id: col.uuid.nullable,
  uploaded_by: col.uuid,
  created_at: col.ts,
  updated_at: col.ts,
};
const documentCodec = camelRow(documentShape);
export type DocumentRecord = CamelRow<typeof documentShape>;
const COLUMNS =
  'id, tenant_id, venture_id, filename, content_type, size_bytes, s3_key, status, failure_reason, source_id, uploaded_by, created_at, updated_at';

export function getDocument(ex: SqlExecutor, id: string): Promise<DocumentRecord | null> {
  return queryFirst(ex, `SELECT ${COLUMNS} FROM documents WHERE id = :id`, { id: p.uuid(id) }, (r) =>
    documentCodec.decode(r),
  );
}

export interface CreateDocumentInput {
  /** Pass the id when it is part of the S3 key (`tenants/{t}/ventures/{v}/documents/{id}/{filename}`). */
  readonly id?: string;
  readonly tenantId: string;
  readonly ventureId: string;
  readonly filename: string;
  readonly contentType: DocumentRecord['contentType'];
  readonly sizeBytes: number;
  readonly s3Key: string;
  readonly uploadedBy: string;
  readonly status?: DocumentRecord['status'];
}

/** Registers an upload (status `pending_upload`). app: founder/team uploading as themselves. */
export function createDocument(ex: SqlExecutor, input: CreateDocumentInput): Promise<DocumentRecord> {
  return queryOne(
    ex,
    `INSERT INTO documents (id, tenant_id, venture_id, filename, content_type, size_bytes, s3_key, uploaded_by, status)
     VALUES (coalesce(:id, gen_random_uuid()), :tenantId, :ventureId, :filename, :contentType, :sizeBytes, :s3Key,
             :uploadedBy, coalesce(:status, 'pending_upload'))
     RETURNING ${COLUMNS}`,
    {
      id: p.nullable.uuid(input.id),
      tenantId: p.uuid(input.tenantId),
      ventureId: p.uuid(input.ventureId),
      filename: p.text(input.filename),
      contentType: p.text(input.contentType),
      sizeBytes: p.int(input.sizeBytes),
      s3Key: p.text(input.s3Key),
      uploadedBy: p.uuid(input.uploadedBy),
      status: p.nullable.text(input.status),
    },
    (r) => documentCodec.decode(r),
    'createDocument',
  );
}

export interface SetDocumentStatusInput {
  readonly documentId: string;
  readonly status: Exclude<DocumentRecord['status'], 'deleted'>;
  /** Short machine-readable reason for `failed` (never extracted text). */
  readonly failureReason?: string | null;
  readonly sourceId?: string | null;
  /** Only transition from one of these statuses (optimistic state machine). */
  readonly fromStatuses?: readonly DocumentRecord['status'][];
}

/** Moves a document through ingestion. Returns the updated record, or null when no row matched. */
export function setDocumentStatus(
  ex: SqlExecutor,
  input: SetDocumentStatusInput,
): Promise<DocumentRecord | null> {
  return queryFirst(
    ex,
    `UPDATE documents
     SET status = :status,
         failure_reason = CASE WHEN :status = 'failed' THEN :reason ELSE NULL END,
         source_id = coalesce(:sourceId, source_id),
         updated_at = now()
     WHERE id = :id AND status <> 'deleted' AND (:fromStatuses IS NULL OR status = ANY (:fromStatuses))
     RETURNING ${COLUMNS}`,
    {
      id: p.uuid(input.documentId),
      status: p.text(input.status),
      reason: p.nullable.text(input.failureReason),
      sourceId: p.nullable.uuid(input.sourceId),
      fromStatuses: p.nullable.textArray(input.fromStatuses),
    },
    (r) => documentCodec.decode(r),
  );
}

/**
 * Soft-deletes a document: status `deleted`, chunks removed from retrieval, knowledge source withdrawn.
 * Returns the S3 key to delete, or null when the document is unknown/not visible.
 */
export async function softDeleteDocument(ex: SqlExecutor, id: string): Promise<string | null> {
  const result = await ex.query('SELECT app.soft_delete_document(:id) AS s3_key', { id: p.uuid(id) });
  const first = result.rows[0];
  return first ? col.text.nullable.decode(first.s3_key, 's3_key') : null;
}

const VIEW_SELECT = `
  SELECT d.id, d.venture_id, d.filename, d.content_type, d.size_bytes, d.status, d.failure_reason, d.created_at,
         d.uploaded_by, ${principalSelect('pr', 'pr')},
         (SELECT count(*) FROM knowledge_chunks c WHERE d.source_id IS NOT NULL AND c.source_id = d.source_id) AS chunk_count
  FROM documents d LEFT JOIN principals pr ON pr.id = d.uploaded_by`;

function decodeView(r: RawRow): DocumentView {
  return {
    id: col.uuid.decode(r.id, 'id'),
    ventureId: col.uuid.decode(r.venture_id, 'venture_id'),
    filename: col.text.decode(r.filename, 'filename'),
    contentType: col.enum(DocumentContentType.options).decode(r.content_type, 'content_type'),
    sizeBytes: col.int.decode(r.size_bytes, 'size_bytes'),
    status: col.enum(DocumentStatus.options).decode(r.status, 'status'),
    failureReason: col.text.nullable.decode(r.failure_reason, 'failure_reason'),
    uploadedBy: requiredPrincipalFrom(r, 'pr', col.uuid.decode(r.uploaded_by, 'uploaded_by')),
    createdAt: col.ts.decode(r.created_at, 'created_at'),
    chunkCount: col.int.decode(r.chunk_count, 'chunk_count'),
  };
}

/** Documents of a venture (deleted ones excluded), newest first, as contract `DocumentView`s. */
export function listDocuments(ex: SqlExecutor, ventureId: string): Promise<DocumentView[]> {
  return queryRows(
    ex,
    `${VIEW_SELECT} WHERE d.venture_id = :ventureId AND d.status <> 'deleted' ORDER BY d.created_at DESC, d.id`,
    { ventureId: p.uuid(ventureId) },
    decodeView,
  );
}

export function getDocumentView(ex: SqlExecutor, id: string): Promise<DocumentView | null> {
  return queryFirst(
    ex,
    `${VIEW_SELECT} WHERE d.id = :id AND d.status <> 'deleted'`,
    { id: p.uuid(id) },
    decodeView,
  );
}
