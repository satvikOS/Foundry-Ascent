import type { MemoryObjectView } from '@foundry/contracts';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { sessionsQueryOptions } from '@/lib/api/hooks/sessions';
import { formatDate } from '@/lib/format';

/** Where a memory item came from, in one plain line, and the conversation it links to when known. */
export interface Provenance {
  readonly text: string;
  /** The conversation it was learned from, when its source names one. */
  readonly sessionId: string | null;
}

type ProvenanceSource = Pick<MemoryObjectView, 'origin' | 'createdAt' | 'createdBy' | 'sourceRefs'>;

/** The conversation an item of the vEIR's was learned from, when its sources name one. */
export function learnedFromConversation(
  memory: Pick<MemoryObjectView, 'origin' | 'sourceRefs'>,
): string | null {
  if (memory.origin !== 'ai') return null;
  return memory.sourceRefs.find((ref) => ref.kind === 'session')?.id ?? null;
}

/**
 * "Learned from the call on Oct 16, 2026" (its conversation had a call), "Learned from the conversation on …"
 * (linked), "Learned from a conversation on …" when the source names no conversation, "Added by Maya on …",
 * "Imported on …". `withCalls` holds the venture's conversations that had a call (`SessionView.hasCalls`), when
 * known. The date is when the item was first saved. The vEIR's memory is never credited to the person whose
 * conversation it came from: they did not write it.
 */
export function memoryProvenance(memory: ProvenanceSource, withCalls?: ReadonlySet<string>): Provenance {
  const on = `on ${formatDate(memory.createdAt)}`;
  switch (memory.origin) {
    case 'ai': {
      const sessionId = learnedFromConversation(memory);
      const what =
        sessionId === null ? 'a conversation' : withCalls?.has(sessionId) ? 'the call' : 'the conversation';
      return { text: `Learned from ${what} ${on}`, sessionId };
    }
    case 'founder':
    case 'eir':
      return { text: `Added by ${memory.createdBy.displayName} ${on}`, sessionId: null };
    case 'import':
      return { text: `Imported ${on}`, sessionId: null };
  }
}

/**
 * Where an item came from, for a list row (a line beside its type): "From the call · Oct 16, 2026", "From a
 * conversation · …", "Maya Okafor-Lindqvist · …", "Imported · …". `memoryProvenance` says it in full.
 */
export function shortProvenance(memory: ProvenanceSource, withCalls?: ReadonlySet<string>): string {
  const date = formatDate(memory.createdAt);
  switch (memory.origin) {
    case 'ai': {
      const sessionId = learnedFromConversation(memory);
      return `${sessionId !== null && withCalls?.has(sessionId) ? 'From the call' : 'From a conversation'} · ${date}`;
    }
    case 'founder':
    case 'eir':
      return `${memory.createdBy.displayName} · ${date}`;
    case 'import':
      return `Imported · ${date}`;
  }
}

const NONE: ReadonlySet<string> = new Set();

/**
 * The venture's conversations that had a call, for "Learned from the call on …": read from the venture's
 * conversations (`GET /ventures/:id/sessions`, the list Knowledge's Conversations shares), and only when it can
 * matter (`needed`: something shown was learned from a named conversation, and the reader can see the venture's
 * conversations). Until it loads, or when not needed, every such item reads "the conversation".
 */
export function useConversationsWithCalls(ventureId: string, needed: boolean): ReadonlySet<string> {
  const sessions = useQuery({ ...sessionsQueryOptions(ventureId), enabled: needed });
  return useMemo(
    () =>
      sessions.data
        ? new Set(sessions.data.items.filter((session) => session.hasCalls).map((session) => session.id))
        : NONE,
    [sessions.data],
  );
}
