import {
  NotebookResponse,
  UpdateNotebookRequest,
  type NotebookEdit,
  type VeirNotebook,
} from '@foundry/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { announce } from '@/components/a11y/live-announcer';
import { toast } from '@/components/ui/toast';
import { encodeBody } from '@/lib/api/body';
import { api, createIdempotencyKey, path } from '@/lib/api/client';
import { errorMessage, isApiError } from '@/lib/api/errors';
import { queryKeys } from '@/lib/api/query-keys';

import { applyNotebookEditLocally } from './notebook-edit';

/** The notebook changed under the person (another teammate, or the vEIR after a conversation). */
export function isNotebookConflict(error: unknown): boolean {
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
 * `PATCH /ventures/:id/notebook`: one person's edit, made against the version they see. Edits apply on
 * screen at once and run one after another (each sends the version the previous one produced). When the
 * notebook changed in the meantime (409) the edit is undone, the latest notebook is fetched and the
 * person is told; any other failure is undone with an error toast.
 */
export function useNotebookEdit(ventureId: string) {
  const client = useQueryClient();
  const key = queryKeys.venture.notebook(ventureId);
  return useMutation({
    scope: { id: `notebook:${ventureId}` },
    mutationFn: (edit: NotebookEdit) => {
      const expectedVersion = client.getQueryData<VeirNotebook | null>(key)?.version ?? 0;
      return api.patch(
        path`/ventures/${ventureId}/notebook`,
        NotebookResponse,
        encodeBody(UpdateNotebookRequest, { expectedVersion, edit }),
        { idempotencyKey: createIdempotencyKey() },
      );
    },
    onMutate: async (edit) => {
      await client.cancelQueries({ queryKey: key });
      const previous = client.getQueryData<VeirNotebook | null>(key) ?? null;
      if (previous) client.setQueryData<VeirNotebook>(key, applyNotebookEditLocally(previous, edit));
      return { previous };
    },
    onSuccess: (notebook, edit) => {
      client.setQueryData<VeirNotebook>(key, notebook);
      announce(DONE_MESSAGE[edit.action]);
    },
    onError: (error, _edit, context) => {
      if (context?.previous) client.setQueryData<VeirNotebook>(key, context.previous);
      if (isNotebookConflict(error)) {
        void client.invalidateQueries({ queryKey: key });
        announce('The notebook changed. It was reloaded; check it and try again.', 'assertive');
        return;
      }
      toast.error('Couldn’t save the notebook', { description: errorMessage(error) });
    },
  });
}
