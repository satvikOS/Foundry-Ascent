import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { deleteDocument, uploadDocument } from '@/lib/api/hooks/documents';

import {
  createUploadQueue,
  type QueuedUpload,
  type UploadItem,
  type UploadOrigin,
  type UploadQueue,
} from './upload-queue';

const VentureUploadsContext = createContext<UploadQueue | null>(null);

function ventureQueue(client: QueryClient, ventureId: string): UploadQueue {
  return createUploadQueue(ventureId, {
    upload: (variables) => uploadDocument(client, ventureId, variables),
    discard: (documentId) => {
      // Best effort: daily maintenance marks a leftover upload unfinished.
      deleteDocument(client, ventureId, documentId).catch(() => undefined);
    },
  });
}

/**
 * The open venture's uploads, above its pages: a file attached in one conversation keeps uploading while the
 * person opens another, and lands in the venture's Documents. Opening another venture stops and forgets every
 * upload of this one, so no file queued here can upload into the other's Documents.
 */
export function VentureUploadsProvider({ ventureId, children }: { ventureId: string; children: ReactNode }) {
  const client = useQueryClient();
  const [state, setState] = useState(() => ({ ventureId, queue: ventureQueue(client, ventureId) }));
  let queue = state.queue;
  if (state.ventureId !== ventureId) {
    // Another venture (the same route, new params): a new queue, in the same render as the new pages.
    queue = ventureQueue(client, ventureId);
    setState({ ventureId, queue });
  }
  useEffect(() => {
    queue.open();
    return () => {
      queue.close();
    };
  }, [queue]);
  return <VentureUploadsContext.Provider value={queue}>{children}</VentureUploadsContext.Provider>;
}

const NO_ITEMS: readonly UploadItem[] = [];
const noSubscription = () => () => undefined;
const noItems = () => NO_ITEMS;

export interface VentureUploads {
  /** Every upload of the venture, oldest first. */
  items: readonly UploadItem[];
  add: (candidates: readonly QueuedUpload[], origin: UploadOrigin) => void;
  cancel: (id: string) => void;
  retry: (id: string) => void;
  dismiss: (id: string) => void;
  move: (from: UploadOrigin, to: UploadOrigin) => void;
  /** Names of files still on their way (for duplicate checks). */
  activeNames: string[];
}

/**
 * The uploads of `ventureId`. A page of another venture than the provider's (only possible mid-navigation)
 * sees none and cannot add any.
 */
export function useVentureUploads(ventureId: string): VentureUploads {
  const provided = useContext(VentureUploadsContext);
  if (provided === null) throw new Error('useVentureUploads needs a VentureUploadsProvider');
  const queue = provided.ventureId === ventureId ? provided : null;
  const items = useSyncExternalStore(queue?.subscribe ?? noSubscription, queue?.getItems ?? noItems);
  // Stable while the venture stays the same, so callers can depend on them.
  const actions = useMemo(
    () => ({
      add: (candidates: readonly QueuedUpload[], origin: UploadOrigin) => {
        queue?.add(candidates, origin);
      },
      cancel: (id: string) => {
        queue?.cancel(id);
      },
      retry: (id: string) => {
        queue?.retry(id);
      },
      dismiss: (id: string) => {
        queue?.dismiss(id);
      },
      move: (from: UploadOrigin, to: UploadOrigin) => {
        queue?.move(from, to);
      },
    }),
    [queue],
  );
  const activeNames = useMemo(
    () =>
      items.filter((item) => item.status !== 'failed' && item.status !== 'cancelled').map((i) => i.file.name),
    [items],
  );
  return useMemo(() => ({ items, activeNames, ...actions }), [items, activeNames, actions]);
}
