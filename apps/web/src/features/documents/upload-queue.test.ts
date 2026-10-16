import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api/errors';
import type { UploadDocumentVariables } from '@/lib/api/hooks/documents';

import {
  conversationOrigin,
  createUploadQueue,
  DOCUMENTS_ORIGIN,
  NEW_CHAT_ORIGIN,
  uploadErrorMessage,
} from './upload-queue';

describe('uploadErrorMessage', () => {
  it('shows the daily upload quota explanation from the server', () => {
    const error = new ApiError({
      status: 429,
      code: 'rate_limited',
      title: 'Too Many Requests',
      detail: 'You can upload up to 20 documents per day. Try again after midnight UTC.',
      retryAfter: 3600,
    });
    expect(uploadErrorMessage(error)).toBe(
      'You can upload up to 20 documents per day. Try again after midnight UTC.',
    );
  });

  it('falls back to the generic message for other errors', () => {
    const error = new ApiError({ status: 413, code: 'upload_too_large', title: 'Payload Too Large' });
    expect(uploadErrorMessage(error)).toBe('That file is too large. The limit is 10 MB.');
    expect(uploadErrorMessage(new Error('boom'))).toBe('Something went wrong. Please try again.');
  });
});

describe('the venture upload queue', () => {
  const file = (name: string) => new File(['# notes'], name, { type: 'text/markdown' });

  /** An upload that stays in flight until the test settles it or its signal aborts. */
  function heldUploads() {
    const started: { name: string; signal: AbortSignal | undefined; finish: () => void }[] = [];
    const upload = vi.fn(
      ({ file: f, signal }: UploadDocumentVariables) =>
        new Promise<void>((resolve, reject) => {
          started.push({ name: f.name, signal, finish: resolve });
          signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );
    return { started, upload };
  }

  it('keeps each upload’s origin, and hands one origin’s uploads to another', () => {
    const { upload } = heldUploads();
    const queue = createUploadQueue('venture-a', { upload, discard: vi.fn() });
    queue.add([{ file: file('a.md'), contentType: 'text/markdown' }], NEW_CHAT_ORIGIN);
    queue.add([{ file: file('b.md'), contentType: 'text/markdown' }], conversationOrigin('s-2'));
    queue.move(NEW_CHAT_ORIGIN, conversationOrigin('s-1'));
    expect(queue.getItems().map((item) => [item.file.name, item.origin])).toEqual([
      ['a.md', 'conversation:s-1'],
      ['b.md', 'conversation:s-2'],
    ]);
  });

  it('closing stops the upload in flight, forgets the list and accepts nothing more', async () => {
    const { started, upload } = heldUploads();
    const discard = vi.fn();
    const queue = createUploadQueue('venture-a', { upload, discard });
    queue.add(
      [
        { file: file('a.md'), contentType: 'text/markdown' },
        { file: file('b.md'), contentType: 'text/markdown' },
      ],
      DOCUMENTS_ORIGIN,
    );
    expect(started.map((s) => s.name)).toEqual(['a.md']);

    queue.close();
    expect(started[0]?.signal?.aborted).toBe(true);
    // Left, not cancelled by the person: its document is marked unfinished, not deleted.
    expect(started[0]?.signal?.reason).not.toBe('upload_cancelled');
    expect(queue.getItems()).toEqual([]);
    queue.add([{ file: file('c.md'), contentType: 'text/markdown' }], DOCUMENTS_ORIGIN);
    await Promise.resolve();
    await Promise.resolve();
    expect(queue.getItems()).toEqual([]);
    // The second file never started, and nothing started after the close.
    expect(upload).toHaveBeenCalledTimes(1);
    expect(discard).not.toHaveBeenCalled();
  });

  it('starts the next file when one finishes, whoever is looking', async () => {
    const { started, upload } = heldUploads();
    const queue = createUploadQueue('venture-a', { upload, discard: vi.fn() });
    queue.add([{ file: file('a.md'), contentType: 'text/markdown' }], conversationOrigin('s-1'));
    queue.add([{ file: file('b.md'), contentType: 'text/markdown' }], conversationOrigin('s-2'));
    started[0]?.finish();
    await vi.waitFor(() => {
      expect(started.map((s) => s.name)).toEqual(['a.md', 'b.md']);
    });
    expect(queue.getItems().map((item) => item.status)).toEqual(['done', 'uploading']);
  });
});
