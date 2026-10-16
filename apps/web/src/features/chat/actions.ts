import type { MemoryObjectView, NextAction, SourceRef } from '@foundry/contracts';
import { useState } from 'react';

import { announce } from '@/components/a11y/live-announcer';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api/errors';
import { useCreateVentureMemory } from '@/features/memory/api';

const TITLE_MAX = 200;

function normalised(title: string): string {
  return title.slice(0, TITLE_MAX).trim().toLowerCase();
}

/**
 * Whether a suggested next step is already one of the venture's actions: an action item with the same
 * title that came from the same answer (turn) or conversation (session).
 */
export function isActionSaved(
  memory: readonly MemoryObjectView[] | undefined,
  action: Pick<NextAction, 'action'>,
  source: Pick<SourceRef, 'kind' | 'id'>,
): boolean {
  const title = normalised(action.action);
  return (
    memory?.some(
      (item) =>
        item.type === 'action' &&
        normalised(item.title) === title &&
        item.sourceRefs.some((ref) => ref.kind === source.kind && ref.id === source.id),
    ) ?? false
  );
}

/** "Add to actions": saves a suggested next step as an open action item with its source. */
export function useAddAction(ventureId: string) {
  const { createMemory } = useCreateVentureMemory(ventureId);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const add = async (action: NextAction, sourceRefs: SourceRef[], key: string) => {
    setSavingKey(key);
    try {
      await createMemory({
        type: 'action',
        title: action.action.slice(0, TITLE_MAX),
        content: action.action,
        attributes: {
          owner: action.owner || undefined,
          due: action.target_date ?? undefined,
          status: 'open',
        },
        sourceRefs,
      });
      toast.success('Added to actions');
      announce('Added to actions');
    } catch (error) {
      toast.error('Couldn’t add the action', { description: errorMessage(error) });
    } finally {
      setSavingKey(null);
    }
  };

  return { add, savingKey };
}
