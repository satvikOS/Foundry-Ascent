import type { MemoryObjectView } from '@foundry/contracts';

import { formatDate } from '@/lib/format';

/** Where a memory item came from, in one plain line, and the conversation it links to when known. */
export interface Provenance {
  readonly text: string;
  /** The conversation it was learned from, when its source names one. */
  readonly sessionId: string | null;
}

/** The channel a source names in its label ("call" or "chat"), when the server records one. */
function channelOf(memory: Pick<MemoryObjectView, 'sourceRefs'>): 'call' | 'chat' | null {
  for (const ref of memory.sourceRefs) {
    const label = ref.label?.trim().toLowerCase();
    if (label === 'call' || label === 'chat') return label;
  }
  return null;
}

/**
 * "Learned from the call on Oct 16, 2026", "Learned from the conversation on …" (linked), "Learned from a
 * conversation on …" when the source names no conversation, "Added by Maya on …", "Imported on …". The date
 * is when the item was first saved. The vEIR's memory is never credited to the person whose conversation it
 * came from: they did not write it.
 */
export function memoryProvenance(
  memory: Pick<MemoryObjectView, 'origin' | 'createdAt' | 'createdBy' | 'sourceRefs'>,
): Provenance {
  const on = `on ${formatDate(memory.createdAt)}`;
  switch (memory.origin) {
    case 'ai': {
      const session = memory.sourceRefs.find((ref) => ref.kind === 'session') ?? null;
      const channel = channelOf(memory);
      const what =
        channel === 'call'
          ? session
            ? 'the call'
            : 'a call'
          : session
            ? 'the conversation'
            : 'a conversation';
      return { text: `Learned from ${what} ${on}`, sessionId: session?.id ?? null };
    }
    case 'founder':
    case 'eir':
      return { text: `Added by ${memory.createdBy.displayName} ${on}`, sessionId: null };
    case 'import':
      return { text: `Imported ${on}`, sessionId: null };
  }
}
