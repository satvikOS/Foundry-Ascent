import {
  NotebookResponse,
  UpdateNotebookRequest,
  type NotebookEdit,
  type VeirNotebook,
} from '@foundry/contracts';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { announce } from '@/components/a11y/live-announcer';
import { toast } from '@/components/ui/toast';
import { encodeBody } from '@/lib/api/body';
import { api, createIdempotencyKey, path } from '@/lib/api/client';
import { errorMessage, isApiError } from '@/lib/api/errors';
import { queryKeys } from '@/lib/api/query-keys';

import { applyNotebookEditLocally } from './notebook-edit';

/**
 * A queued edit that was never sent because an earlier edit in the same run failed: it was made on top
 * of that edit, so it is dropped with it. `cause` is the earlier failure.
 */
export class NotebookEditCancelled extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super('An earlier notebook edit failed, so this one was not sent');
    this.name = 'NotebookEditCancelled';
    this.cause = cause;
  }
}

/** The notebook changed under the person (another teammate, or the vEIR after a conversation). */
export function isNotebookConflict(error: unknown): boolean {
  if (error instanceof NotebookEditCancelled) return isNotebookConflict(error.cause);
  return isApiError(error) && error.status === 409;
}

const DONE_MESSAGE: Record<NotebookEdit['action'], string> = {
  edit_summary: 'Summary saved',
  edit_entry: 'Note saved',
  remove_entry: 'Note removed',
  edit_commitment: 'Commitment saved',
  remove_commitment: 'Commitment removed',
  edit_opener: 'Opening line saved',
  remove_opener: 'Opening line removed',
  clear: 'Notebook cleared',
};

/**
 * One person's run of edits: edits made while earlier ones are still saving build on them, so they are
 * sent one after another and fail together.
 */
interface EditRun {
  /** The notebook as the server last confirmed it: what the person saw when the run began, then each response. */
  base: VeirNotebook | null;
  /** Edits made in this run and not yet settled, oldest first. */
  queue: NotebookEdit[];
  /** The failure that ended the run; queued edits are dropped with it. */
  failure: { error: unknown } | null;
}

const runs = new WeakMap<QueryClient, Map<string, EditRun>>();

function editRun(client: QueryClient, ventureId: string): EditRun {
  let byVenture = runs.get(client);
  if (!byVenture) {
    byVenture = new Map();
    runs.set(client, byVenture);
  }
  let run = byVenture.get(ventureId);
  if (!run) {
    run = { base: null, queue: [], failure: null };
    byVenture.set(ventureId, run);
  }
  return run;
}

function settle(run: EditRun, edit: NotebookEdit): void {
  const index = run.queue.indexOf(edit);
  if (index !== -1) run.queue.splice(index, 1);
}

/** The notebook with the run's unsaved edits applied on top, as the person sees it. */
function onScreen(run: EditRun): VeirNotebook | null {
  if (!run.base) return null;
  let notebook = run.base;
  for (const edit of run.queue) notebook = applyNotebookEditLocally(notebook, edit);
  return notebook;
}

/**
 * `PATCH /ventures/:id/notebook`: one person's edit, made against the version they see. Edits apply on
 * screen at once and are sent one after another: the first carries the version on screen when it was
 * made, each later one the version the previous edit produced. When an edit fails, the edits queued
 * behind it are dropped (they built on it), the screen returns to the last saved notebook and the latest
 * is fetched. A 409 (the notebook changed meanwhile) is announced; any other failure gets an error toast.
 */
export function useNotebookEdit(ventureId: string) {
  const client = useQueryClient();
  const key = queryKeys.venture.notebook(ventureId);
  return useMutation({
    scope: { id: `notebook:${ventureId}` },
    mutationFn: (edit: NotebookEdit) => {
      const run = editRun(client, ventureId);
      if (run.failure) return Promise.reject(new NotebookEditCancelled(run.failure.error));
      return api.patch(
        path`/ventures/${ventureId}/notebook`,
        NotebookResponse,
        encodeBody(UpdateNotebookRequest, { expectedVersion: run.base?.version ?? 0, edit }),
        { idempotencyKey: createIdempotencyKey() },
      );
    },
    onMutate: async (edit) => {
      const run = editRun(client, ventureId);
      if (run.queue.length === 0) {
        // A new run starts from what is on screen now.
        run.base = client.getQueryData<VeirNotebook | null>(key) ?? null;
        run.failure = null;
      }
      run.queue.push(edit);
      await client.cancelQueries({ queryKey: key });
      const shown = onScreen(run);
      if (shown) client.setQueryData<VeirNotebook>(key, shown);
    },
    onSuccess: (notebook, edit) => {
      const run = editRun(client, ventureId);
      run.base = notebook;
      settle(run, edit);
      client.setQueryData<VeirNotebook>(key, onScreen(run) ?? notebook);
      announce(DONE_MESSAGE[edit.action]);
    },
    onError: (error, edit) => {
      const run = editRun(client, ventureId);
      settle(run, edit);
      // Every edit still queued was made on top of this one and will be dropped: show the last saved
      // notebook (never an older snapshot) and fetch the latest.
      run.failure ??= { error };
      if (run.base) client.setQueryData<VeirNotebook>(key, run.base);
      void client.invalidateQueries({ queryKey: key });
      if (error instanceof NotebookEditCancelled) return;
      if (isNotebookConflict(error)) {
        announce('The notebook changed. It was reloaded; check it and try again.', 'assertive');
        return;
      }
      // A refused opening line is shown under the line itself (the caller re-opens its editor).
      if (edit.action === 'edit_opener' && openerRefusal(error) !== null) return;
      toast.error('Couldn’t save the notebook', { description: errorMessage(error) });
    },
  });
}

/**
 * Why the server refused an opening line a person wrote (422 at `edit.text`: the vEIR says it, so it may not
 * name an EIR or another venture, and must be one plain line), or null for any other failure.
 */
export function openerRefusal(error: unknown): string | null {
  if (!isApiError(error) || error.code !== 'validation_failed') return null;
  return error.fieldErrors.find((field) => field.path === 'edit.text')?.message ?? null;
}
