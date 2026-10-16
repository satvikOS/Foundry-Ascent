import { MemoryType, type MemoryObjectView, type MemoryStatus } from '@foundry/contracts';

/*
 * Pure rules for the memory list on the Knowledge page. Proposals wait in the "To review" queue, so the
 * list shows what the team kept; a status filter shows the rest of the history.
 */

/** Statuses offered by the memory list's status filter (proposals have their own queue). */
export const MEMORY_LIST_STATUSES = [
  'confirmed',
  'disputed',
  'superseded',
  'rejected',
  'expired',
] as const satisfies readonly MemoryStatus[];
export type MemoryListStatus = (typeof MEMORY_LIST_STATUSES)[number];

/** Kept knowledge: what the list shows without a status filter. */
export function isKept(item: Pick<MemoryObjectView, 'status'>): boolean {
  return item.status === 'confirmed' || item.status === 'disputed';
}

/**
 * The rows of the memory list. Without a status filter the server returns every active item
 * (proposed, confirmed, disputed) and proposals are left to the review queue. Pinned items come first,
 * then the most recently updated.
 */
export function memoryListRows(
  items: readonly MemoryObjectView[],
  status: MemoryStatus | undefined,
): MemoryObjectView[] {
  const rows = status === undefined ? items.filter(isKept) : items.filter((item) => item.status === status);
  return [...rows].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
}

export interface TypeChip {
  type: MemoryType;
  count: number;
}

/**
 * One chip per type the venture has kept knowledge of (in the contract's order), with its count. The
 * selected type always has a chip, even at zero, so the filter can be seen and cleared.
 */
export function typeChips(items: readonly MemoryObjectView[], selected: MemoryType | undefined): TypeChip[] {
  const counts = new Map<MemoryType, number>();
  for (const item of items) {
    if (isKept(item)) counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
  }
  return MemoryType.options
    .filter((type) => counts.has(type) || type === selected)
    .map((type) => ({ type, count: counts.get(type) ?? 0 }));
}
