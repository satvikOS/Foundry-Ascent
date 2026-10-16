import { announce } from '@/components/a11y/live-announcer';
import { errorMessage, isAbortError, isApiError } from '@/lib/api/errors';
import { UPLOAD_CANCELLED, type UploadDocumentVariables, type UploadResume } from '@/lib/api/hooks/documents';

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

/**
 * Where an upload was started: the Documents page, New chat, or one conversation. A composer shows only the
 * uploads started from it; Documents shows them all.
 */
export type UploadOrigin = string;

export const DOCUMENTS_ORIGIN: UploadOrigin = 'documents';
export const NEW_CHAT_ORIGIN: UploadOrigin = 'new-chat';
export function conversationOrigin(sessionId: string): UploadOrigin {
  return `conversation:${sessionId}`;
}

export interface UploadItem {
  id: string;
  file: File;
  origin: UploadOrigin;
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

/** An item still on its way: waiting its turn, uploading, or finishing. */
export function isActiveUpload(item: Pick<UploadItem, 'status'>): boolean {
  return item.status === 'queued' || item.status === 'uploading' || item.status === 'finishing';
}

export interface UploadQueueDeps {
  /** Uploads one file into the venture's Documents (see `uploadDocument`). */
  upload: (variables: UploadDocumentVariables) => Promise<unknown>;
  /** Deletes a document whose upload the person gave up on (best effort). */
  discard: (documentId: string) => void;
}

/**
 * One venture's uploads, kept outside any page so an upload goes on while the person moves between
 * conversations and pages of the venture. Closing it (leaving the venture) stops everything at once.
 */
export interface UploadQueue {
  readonly ventureId: string;
  subscribe: (listener: () => void) => () => void;
  getItems: () => readonly UploadItem[];
  add: (candidates: readonly QueuedUpload[], origin: UploadOrigin) => void;
  cancel: (id: string) => void;
  retry: (id: string) => void;
  dismiss: (id: string) => void;
  /** Hands the uploads started in one place to another (New chat's, to the conversation it opened). */
  move: (from: UploadOrigin, to: UploadOrigin) => void;
  /** Accepts uploads (a new queue already does; again after `close`, for React's development remount). */
  open: () => void;
  /**
   * Stops every upload (each document is left marked unfinished, for a retry), forgets the list and refuses
   * new files until opened again: nothing queued for this venture can reach another.
   */
  close: () => void;
}

let counter = 0;
const nextId = () => `upload-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** How long a finished upload stays in the list before the documents list carries it on its own. */
export const DONE_LINGER_MS = 4000;

/**
 * Sequential upload queue (create → presigned PUT with progress → complete). One file uploads at a time so
 * progress is easy to follow and the API is not flooded. Finished items disappear after a short delay; the
 * documents list then shows their processing state. Cancel deletes the item's document; a failure keeps it
 * (marked unfinished) and Retry uploads into it again; removing a failed item from the list deletes it;
 * closing the queue (leaving the venture) leaves it marked unfinished.
 */
export function createUploadQueue(ventureId: string, deps: UploadQueueDeps): UploadQueue {
  let items: readonly UploadItem[] = [];
  let closed = false;
  // Bumped by `close`: an upload settling after it belongs to a list that no longer exists.
  let generation = 0;
  let busy = false;
  const controllers = new Map<string, AbortController>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  const set = (next: readonly UploadItem[]) => {
    items = next;
    emit();
  };
  const patch = (id: string, next: Partial<UploadItem>) => {
    if (!items.some((item) => item.id === id)) return;
    set(items.map((item) => (item.id === id ? { ...item, ...next } : item)));
  };

  /**
   * Deletes the document of an upload the person gave up on, when its file never arrived (best effort: daily
   * maintenance marks a leftover unfinished). A document whose file arrived is kept: it can still be processed.
   */
  const discard = (resume: UploadResume | null) => {
    if (resume && !resume.uploaded) deps.discard(resume.documentId);
  };

  // Start the next queued item whenever nothing is uploading.
  const pump = () => {
    if (closed || busy) return;
    const next = items.find((item) => item.status === 'queued');
    if (!next) return;
    busy = true;
    const round = generation;
    const current = () => round === generation;
    const controller = new AbortController();
    controllers.set(next.id, controller);
    patch(next.id, { status: 'uploading', progress: 0 });
    deps
      .upload({
        file: next.file,
        signal: controller.signal,
        resume: next.resume,
        onResume: (resume) => {
          if (current()) patch(next.id, { resume });
        },
        onProgress: (progress) => {
          if (!current()) return;
          patch(next.id, {
            progress: progress.percent,
            status: progress.percent >= 100 ? 'finishing' : 'uploading',
          });
        },
      })
      .then(
        () => {
          if (!current()) return;
          patch(next.id, { status: 'done', progress: 100 });
          announce('Upload complete. The document is being processed.');
          const timer = setTimeout(() => {
            timers.delete(timer);
            set(items.filter((item) => item.id !== next.id));
          }, DONE_LINGER_MS);
          timers.add(timer);
        },
        (error: unknown) => {
          if (!current()) return;
          if (isAbortError(error) || controller.signal.aborted) {
            // Cancelled: its document was deleted, so a retry registers the file again.
            patch(next.id, { status: 'cancelled', error: null, resume: null });
            announce('Upload cancelled');
          } else {
            patch(next.id, { status: 'failed', error: uploadErrorMessage(error) });
            announce('Upload failed', 'assertive');
          }
        },
      )
      .finally(() => {
        if (!current()) return;
        controllers.delete(next.id);
        busy = false;
        pump();
      });
  };

  return {
    ventureId,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getItems: () => items,
    add: (candidates, origin) => {
      if (closed || candidates.length === 0) return;
      set([
        ...items,
        ...candidates.map((c): UploadItem => ({
          id: nextId(),
          file: c.file,
          origin,
          status: 'queued',
          progress: 0,
          error: null,
          resume: c.resume ?? null,
        })),
      ]);
      announce(candidates.length === 1 ? 'Upload queued' : `${candidates.length} uploads queued`);
      pump();
    },
    cancel: (id) => {
      const controller = controllers.get(id);
      if (controller) {
        // The upload deletes its document as it stops.
        controller.abort(UPLOAD_CANCELLED);
        return;
      }
      discard(items.find((item) => item.id === id)?.resume ?? null);
      patch(id, { status: 'cancelled', resume: null });
    },
    retry: (id) => {
      if (closed) return;
      patch(id, { status: 'queued', progress: 0, error: null });
      pump();
    },
    dismiss: (id) => {
      const item = items.find((candidate) => candidate.id === id);
      if (!item) return;
      if (item.status === 'failed') discard(item.resume);
      set(items.filter((candidate) => candidate.id !== id));
    },
    move: (from, to) => {
      if (from === to || !items.some((item) => item.origin === from)) return;
      set(items.map((item) => (item.origin === from ? { ...item, origin: to } : item)));
    },
    open: () => {
      closed = false;
    },
    close: () => {
      closed = true;
      generation += 1;
      busy = false;
      // No reason given: the upload marks its document unfinished (only a person's Cancel deletes it).
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      set([]);
    },
  };
}
