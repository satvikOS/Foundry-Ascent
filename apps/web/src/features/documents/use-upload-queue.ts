import { useCallback, useEffect, useRef, useState } from 'react';

import { announce } from '@/components/a11y/live-announcer';
import { api, createIdempotencyKey, path } from '@/lib/api/client';
import { errorMessage, isAbortError, isApiError } from '@/lib/api/errors';
import { UPLOAD_CANCELLED, useUploadDocument, type UploadResume } from '@/lib/api/hooks/documents';

import type { UploadCandidate } from './upload-validation';

/**
 * The daily upload quota (429 `rate_limited`) explains itself in the problem detail (count or volume,
 * resets at midnight UTC); other errors use the generic messages.
 */
export function uploadErrorMessage(error: unknown): string {
  if (isApiError(error) && error.code === 'rate_limited' && error.detail) return error.detail;
  return errorMessage(error);
}

export type UploadItemStatus = 'queued' | 'uploading' | 'finishing' | 'done' | 'failed' | 'cancelled';

export interface UploadItem {
  id: string;
  file: File;
  status: UploadItemStatus;
  /** 0–100 */
  progress: number;
  error: string | null;
  /** The document an earlier attempt registered (Retry reuses it), or null before the first attempt. */
  resume: UploadResume | null;
}

/** A file to upload, optionally into a document whose earlier upload never finished. */
export interface QueuedUpload extends UploadCandidate {
  resume?: UploadResume | null;
}

/** Best-effort DELETE of a document whose upload the person gave up on (it has no file to keep). */
function discard(resume: UploadResume | null): void {
  if (!resume || resume.uploaded) return;
  void api
    .delete(path`/documents/${resume.documentId}`, { idempotencyKey: createIdempotencyKey() })
    .catch(() => undefined);
}

let counter = 0;
const nextId = () => `upload-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/**
 * Sequential upload queue on top of `useUploadDocument` (create → presigned PUT with progress →
 * complete). One file uploads at a time so progress is easy to follow and the API is not flooded.
 * Finished items disappear after a short delay; the documents list then shows their processing state.
 * Cancel deletes the item's document; a failure keeps it (marked unfinished) and Retry uploads into it
 * again; removing a failed item from the list deletes it; leaving the page leaves it marked unfinished.
 */
export function useUploadQueue(ventureId: string) {
  const upload = useUploadDocument(ventureId);
  const { mutateAsync } = upload;
  const [items, setItems] = useState<UploadItem[]>([]);
  // The items as last rendered, for actions that act on an item's document (never inside a state updater).
  const current = useRef(items);
  current.current = items;
  const controllers = useRef(new Map<string, AbortController>());
  const busy = useRef(false);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const patch = useCallback((id: string, next: Partial<UploadItem>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...next } : item)));
  }, []);

  const add = useCallback((candidates: readonly QueuedUpload[]) => {
    if (candidates.length === 0) return;
    setItems((prev) => [
      ...prev,
      ...candidates.map((c): UploadItem => ({
        id: nextId(),
        file: c.file,
        status: 'queued',
        progress: 0,
        error: null,
        resume: c.resume ?? null,
      })),
    ]);
    announce(candidates.length === 1 ? 'Upload queued' : `${candidates.length} uploads queued`);
  }, []);

  const cancel = useCallback(
    (id: string) => {
      const controller = controllers.current.get(id);
      if (controller) {
        // The upload deletes its document as it stops.
        controller.abort(UPLOAD_CANCELLED);
        return;
      }
      discard(current.current.find((item) => item.id === id)?.resume ?? null);
      patch(id, { status: 'cancelled', resume: null });
    },
    [patch],
  );

  const retry = useCallback(
    (id: string) => {
      patch(id, { status: 'queued', progress: 0, error: null });
    },
    [patch],
  );

  const dismiss = useCallback((id: string) => {
    const item = current.current.find((candidate) => candidate.id === id);
    if (item?.status === 'failed') discard(item.resume);
    setItems((prev) => prev.filter((candidate) => candidate.id !== id));
  }, []);

  // Process the next queued item whenever nothing is uploading.
  useEffect(() => {
    if (busy.current) return;
    const next = items.find((item) => item.status === 'queued');
    if (!next) return;
    busy.current = true;
    const controller = new AbortController();
    controllers.current.set(next.id, controller);
    patch(next.id, { status: 'uploading', progress: 0 });
    void mutateAsync({
      file: next.file,
      signal: controller.signal,
      resume: next.resume,
      onResume: (resume) => {
        patch(next.id, { resume });
      },
      onProgress: (progress) => {
        patch(next.id, {
          progress: progress.percent,
          status: progress.percent >= 100 ? 'finishing' : 'uploading',
        });
      },
    })
      .then(() => {
        patch(next.id, { status: 'done', progress: 100 });
        announce('Upload complete. The document is being processed.');
        const timer = setTimeout(() => {
          timers.current.delete(timer);
          setItems((prev) => prev.filter((item) => item.id !== next.id));
        }, 4000);
        timers.current.add(timer);
      })
      .catch((error: unknown) => {
        if (isAbortError(error) || controller.signal.aborted) {
          // Cancelled: its document was deleted, so a retry registers the file again.
          patch(next.id, { status: 'cancelled', error: null, resume: null });
          announce('Upload cancelled');
        } else {
          patch(next.id, { status: 'failed', error: uploadErrorMessage(error) });
          announce('Upload failed', 'assertive');
        }
      })
      .finally(() => {
        controllers.current.delete(next.id);
        busy.current = false;
        // Trigger the effect again for the next queued item.
        setItems((prev) => [...prev]);
      });
  }, [items, mutateAsync, patch]);

  // Abort in-flight uploads and timers on unmount.
  useEffect(() => {
    const active = controllers.current;
    const pending = timers.current;
    return () => {
      for (const controller of active.values()) controller.abort();
      for (const timer of pending) clearTimeout(timer);
    };
  }, []);

  const activeNames = items
    .filter((item) => item.status !== 'failed' && item.status !== 'cancelled')
    .map((item) => item.file.name);

  return { items, add, cancel, retry, dismiss, activeNames };
}
