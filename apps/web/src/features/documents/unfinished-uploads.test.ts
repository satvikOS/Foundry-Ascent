import type { DocumentView } from '@foundry/contracts';
import { describe, expect, it } from 'vitest';

import { documentsQueryOptions, isInFlight, isStaleUpload, STALE_UPLOAD_MS } from '@/lib/api/hooks/documents';
import { IDS, makeDocument } from '@/features/knowledge/testing';

import { isUnfinishedUpload, resumableUpload } from './unfinished-uploads';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const pending = (createdAt: string) => makeDocument({ status: 'pending_upload', chunkCount: 0, createdAt });

/** What the list's refetchInterval answers for these documents (3000 = keep polling). */
function polling(items: DocumentView[]): unknown {
  const interval = documentsQueryOptions(IDS.venture).refetchInterval as unknown as (query: {
    state: { data: { items: DocumentView[] } | undefined };
  }) => number | false;
  return interval({ state: { data: { items } } });
}

describe('unfinished uploads', () => {
  it('treats an upload still pending long after it began as left, not in flight', () => {
    const fresh = pending(ago(60_000));
    const left = pending(ago(STALE_UPLOAD_MS + 1_000));
    expect(isStaleUpload(fresh, NOW)).toBe(false);
    expect(isInFlight(fresh, NOW)).toBe(true);
    expect(isStaleUpload(left, NOW)).toBe(true);
    expect(isInFlight(left, NOW)).toBe(false);
    expect(isInFlight(makeDocument({ status: 'processing', createdAt: ago(STALE_UPLOAD_MS * 4) }), NOW)).toBe(
      true,
    );
  });

  it('stops polling the list when only settled or left uploads remain', () => {
    const left = pending(new Date(Date.now() - STALE_UPLOAD_MS - 1_000).toISOString());
    const failed = makeDocument({ status: 'failed', failureReason: 'upload_incomplete' });
    expect(polling([makeDocument(), failed, left])).toBe(false);
    expect(polling([makeDocument(), pending(new Date().toISOString())])).toBe(3000);
    expect(polling([makeDocument({ status: 'processing' })])).toBe(3000);
  });

  it('knows which documents never got their file', () => {
    expect(
      isUnfinishedUpload(makeDocument({ status: 'failed', failureReason: 'upload_incomplete' }), NOW),
    ).toBe(true);
    expect(isUnfinishedUpload(makeDocument({ status: 'failed', failureReason: 'object_missing' }), NOW)).toBe(
      true,
    );
    expect(isUnfinishedUpload(makeDocument({ status: 'failed', failureReason: 'extract_failed' }), NOW)).toBe(
      false,
    );
    expect(isUnfinishedUpload(pending(ago(STALE_UPLOAD_MS + 1)), NOW)).toBe(true);
    expect(isUnfinishedUpload(pending(ago(1_000)), NOW)).toBe(false);
  });

  it('uploads a picked file into the unfinished document of the same name, size and type', () => {
    const file = new File(['12345'], 'Interviews.md', { type: 'text/markdown' });
    const unfinished = makeDocument({
      id: IDS.document,
      filename: 'interviews.md',
      sizeBytes: 5,
      contentType: 'text/markdown',
      status: 'failed',
      failureReason: 'upload_incomplete',
    });
    const candidate = { file, contentType: 'text/markdown' as const };
    expect(resumableUpload(candidate, [unfinished], NOW)).toEqual({
      documentId: IDS.document,
      uploaded: false,
    });
    // A different size would not match the signed PUT: a new document instead.
    expect(resumableUpload(candidate, [{ ...unfinished, sizeBytes: 6 }], NOW)).toBeNull();
    expect(
      resumableUpload(candidate, [{ ...unfinished, status: 'ready', failureReason: null }], NOW),
    ).toBeNull();
  });
});
