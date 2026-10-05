import { useCallback, useEffect, useRef, useState } from 'react';

import { announce } from '@/components/a11y/live-announcer';
import { errorMessage, isAbortError } from '@/lib/api/errors';
import { useUploadDocument } from '@/lib/api/hooks/documents';

import type { UploadCandidate } from './upload-validation';

export type UploadItemStatus = 'queued' | 'uploading' | 'finishing' | 'done' | 'failed' | 'cancelled';

export interface UploadItem {
  id: string;
  file: File;
  status: UploadItemStatus;
  /** 0–100 */
  progress: number;
  error: string | null;
}

let counter = 0;
const nextId = () => `upload-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/**
 * Sequential upload queue on top of `useUploadDocument` (create → presigned PUT with progress →
 * complete). One file uploads at a time so progress is easy to follow and the API is not flooded.
 * Finished items disappear after a short delay; the documents list then shows their processing state.
 */
export function useUploadQueue(ventureId: string) {
  const upload = useUploadDocument(ventureId);
  const { mutateAsync } = upload;
  const [items, setItems] = useState<UploadItem[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const busy = useRef(false);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const patch = useCallback((id: string, next: Partial<UploadItem>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...next } : item)));
  }, []);

  const add = useCallback((candidates: readonly UploadCandidate[]) => {
    if (candidates.length === 0) return;
    setItems((prev) => [
      ...prev,
      ...candidates.map((c): UploadItem => ({
        id: nextId(),
        file: c.file,
        status: 'queued',
        progress: 0,
        error: null,
      })),
    ]);
    announce(candidates.length === 1 ? 'Upload queued' : `${candidates.length} uploads queued`);
  }, []);

  const cancel = useCallback(
    (id: string) => {
      const controller = controllers.current.get(id);
      if (controller) controller.abort();
      else patch(id, { status: 'cancelled' });
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
    setItems((prev) => prev.filter((item) => item.id !== id));
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
          patch(next.id, { status: 'cancelled', error: null });
          announce('Upload cancelled');
        } else {
          patch(next.id, { status: 'failed', error: errorMessage(error) });
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
