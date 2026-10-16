import { MemoryType, type MemoryObjectView, type MemoryStatus } from '@foundry/contracts';

/*
 * Pure rules for the memory list on the Knowledge page. It shows everything the vEIR knows: memory is kept
 * automatically, so an item the vEIR saved before that (still marked as a suggestion) is listed like any
 * other. Older states (replaced, expired) appear only through a `status` link.
 */

/** Statuses of memory in use: what the vEIR knows and the list shows without a status filter. */
const IN_USE: ReadonlySet<MemoryStatus> = new Set(['proposed', 'confirmed', 'disputed']);

/** Memory the vEIR knows (and uses): kept, disputed, or saved as a suggestion before memory was automatic. */
export function isInUse(item: Pick<MemoryObjectView, 'status'>): boolean {
  return IN_USE.has(item.status);
}

/**
 * The rows of the memory list. Without a status filter the server returns every active item and all of it
 * is listed; with one, only that status. Pinned items come first, then the most recently updated.
 */
export function memoryListRows(
  items: readonly MemoryObjectView[],
  status: MemoryStatus | undefined,
): MemoryObjectView[] {
  const rows = status === undefined ? items.filter(isInUse) : items.filter((item) => item.status === status);
  return [...rows].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
}

export interface TypeChip {
  type: MemoryType;
  count: number;
}

/**
 * One chip per type the vEIR knows something of (in the contract's order), with its count. The selected
 * type always has a chip, even at zero, so the filter can be seen and cleared.
 */
export function typeChips(items: readonly MemoryObjectView[], selected: MemoryType | undefined): TypeChip[] {
  const counts = new Map<MemoryType, number>();
  for (const item of items) {
    if (isInUse(item)) counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
  }
  return MemoryType.options
    .filter((type) => counts.has(type) || type === selected)
    .map((type) => ({ type, count: counts.get(type) ?? 0 }));
}
