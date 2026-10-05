import type { MemoryObjectView, MemoryStatus } from '@foundry/contracts';

import type { MemoryActionInput } from '@/lib/api/hooks/memory';
import type { MemoryFilters } from '@/lib/api/query-keys';

/*
 * Pure helpers for memory lifecycle actions: which actions apply to an item, how an item looks after
 * an action (for optimistic UI), and how cached lists change. The server stays authoritative — every
 * optimistic change is reconciled by refetching once the request settles.
 */

export type MemoryActionKind = MemoryActionInput['action'];

/** Statuses a list without an explicit status filter does not show. */
const HIDDEN_BY_DEFAULT: ReadonlySet<MemoryStatus> = new Set(['deleted']);

/** The founder-facing actions allowed for an item in its current state. */
export function availableMemoryActions(
  item: Pick<MemoryObjectView, 'status' | 'pinned'>,
): MemoryActionKind[] {
  switch (item.status) {
    case 'proposed':
      return ['approve', 'reject', 'correct', 'delete'];
    case 'confirmed':
      return ['correct', item.pinned ? 'unpin' : 'pin', 'dispute', 'delete'];
    case 'disputed':
      return ['approve', 'correct', item.pinned ? 'unpin' : 'pin', 'delete'];
    case 'superseded':
    case 'expired':
    case 'rejected':
      return ['delete'];
    case 'deleted':
      return [];
  }
}

export function canApplyMemoryAction(
  item: Pick<MemoryObjectView, 'status' | 'pinned'>,
  action: MemoryActionKind,
): boolean {
  return availableMemoryActions(item).includes(action);
}

/** The item as it should look immediately after `action` (optimistic projection). */
export function applyMemoryAction(
  item: MemoryObjectView,
  action: MemoryActionInput,
  now: string = new Date().toISOString(),
): MemoryObjectView {
  switch (action.action) {
    case 'approve':
      return { ...item, status: 'confirmed', approvedAt: now, updatedAt: now };
    case 'reject':
      return { ...item, status: 'rejected', pinned: false, updatedAt: now };
    case 'dispute':
      return { ...item, status: 'disputed', updatedAt: now };
    case 'pin':
      return { ...item, pinned: true, updatedAt: now };
    case 'unpin':
      return { ...item, pinned: false, updatedAt: now };
    case 'delete':
      return { ...item, status: 'deleted', pinned: false, updatedAt: now };
    case 'correct': {
      const patch = action.patch;
      return {
        ...item,
        title: patch.title?.trim() ?? item.title,
        content: patch.content?.trim() ?? item.content,
        attributes: patch.attributes ?? item.attributes,
        visibility: patch.visibility ?? item.visibility,
        confidence: patch.confidence ?? item.confidence,
        version: item.version + 1,
        updatedAt: now,
      };
    }
  }
}

/**
 * Whether an item belongs in a list fetched with `filters`. Free-text search (`q`) is matched by the
 * server's full-text index and cannot be reproduced here, so it never removes an item optimistically.
 */
export function memoryMatchesFilters(item: MemoryObjectView, filters: MemoryFilters | undefined): boolean {
  if (filters?.type && item.type !== filters.type) return false;
  if (filters?.status) {
    if (item.status !== filters.status) return false;
  } else if (HIDDEN_BY_DEFAULT.has(item.status)) {
    return false;
  }
  if (filters?.pinned !== undefined && item.pinned !== filters.pinned) return false;
  return true;
}

/** A cached list after applying `action` to `memoryId` (items that stop matching drop out). */
export function applyMemoryActionToList(
  items: readonly MemoryObjectView[],
  memoryId: string,
  action: MemoryActionInput,
  filters: MemoryFilters | undefined,
  now?: string,
): MemoryObjectView[] {
  const next: MemoryObjectView[] = [];
  for (const item of items) {
    if (item.id !== memoryId) {
      next.push(item);
      continue;
    }
    const updated = applyMemoryAction(item, action, now);
    if (memoryMatchesFilters(updated, filters)) next.push(updated);
  }
  return next;
}

/** Toast/announcement copy for a completed action (never includes memory content). */
export function memoryActionSuccessMessage(action: MemoryActionKind): string {
  switch (action) {
    case 'approve':
      return 'Approved — now part of venture memory';
    case 'reject':
      return 'Rejected — it won’t be used as memory';
    case 'correct':
      return 'Correction saved as a new version';
    case 'dispute':
      return 'Marked as disputed';
    case 'pin':
      return 'Pinned';
    case 'unpin':
      return 'Unpinned';
    case 'delete':
      return 'Deleted from memory';
  }
}

export const MEMORY_ACTION_LABELS: Record<MemoryActionKind, string> = {
  approve: 'Approve',
  reject: 'Reject',
  correct: 'Correct',
  dispute: 'Dispute',
  pin: 'Pin',
  unpin: 'Unpin',
  delete: 'Delete',
};

/** Memory objects created from a specific turn (memory candidates become proposed objects). */
export function memoryFromTurn(items: readonly MemoryObjectView[], turnId: string): MemoryObjectView[] {
  return items.filter((item) => item.sourceRefs.some((ref) => ref.kind === 'turn' && ref.id === turnId));
}

function normaliseTitle(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Find the memory object that a response's candidate (or next action) was persisted as. */
export function findMemoryForCandidate(
  items: readonly MemoryObjectView[],
  turnId: string,
  candidate: { type: MemoryObjectView['type']; title: string },
): MemoryObjectView | null {
  const title = normaliseTitle(candidate.title);
  const fromTurn = memoryFromTurn(items, turnId);
  return (
    fromTurn.find((item) => item.type === candidate.type && normaliseTitle(item.title) === title) ??
    fromTurn.find((item) => normaliseTitle(item.title) === title) ??
    null
  );
}
