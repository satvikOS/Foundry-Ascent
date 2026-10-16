import type { MemoryCandidate, MemoryObjectView, MemoryStatus } from '@foundry/contracts';
import { Link } from '@tanstack/react-router';
import { BookmarkCheck } from 'lucide-react';

import { pluralize } from '@/lib/format';
import { cn } from '@/lib/utils';
import { findMemoryForCandidate } from '@/features/memory/optimistic';

/** Memory the vEIR holds and uses: anything it learned that nobody has forgotten or replaced. */
const IN_USE: ReadonlySet<MemoryStatus> = new Set(['proposed', 'confirmed', 'disputed']);

/**
 * What an answer's memory candidates became: the venture's memory items saved from this turn, in the
 * candidates' order, each once. A candidate with no saved item yet (still being written, or a private chat)
 * is left out, and so is anything forgotten since: the cue only ever says what is actually in Knowledge.
 */
export function savedFromTurn(
  candidates: readonly Pick<MemoryCandidate, 'type' | 'title'>[],
  items: readonly MemoryObjectView[] | undefined,
  turnId: string,
): MemoryObjectView[] {
  if (!items) return [];
  const saved: MemoryObjectView[] = [];
  for (const candidate of candidates) {
    const memory = findMemoryForCandidate(items, turnId, candidate);
    if (memory && IN_USE.has(memory.status) && !saved.some((m) => m.id === memory.id)) saved.push(memory);
  }
  return saved;
}

/** The memory items with these ids that are still in Knowledge (a summary's or a call's saved memory). */
export function savedByIds(
  ids: readonly string[],
  items: readonly MemoryObjectView[] | undefined,
): MemoryObjectView[] {
  if (!items || ids.length === 0) return [];
  const wanted = new Set(ids);
  return items.filter((item) => wanted.has(item.id) && IN_USE.has(item.status));
}

/**
 * A quiet line under an answer when the vEIR kept something from it: "Saved to Knowledge: <title>", linking
 * to the item (or to Knowledge when it kept several). Nothing to approve: memory is kept automatically, and
 * the founder edits or forgets it in Knowledge.
 */
export function MemorySaved({
  tenant,
  ventureId,
  memories,
  onNavigate,
  className,
}: {
  tenant: string;
  ventureId: string;
  memories: readonly MemoryObjectView[];
  /** Following the link leaves this surface (an ended call's summary forgets the call). */
  onNavigate?: () => void;
  className?: string;
}) {
  const [only] = memories;
  if (!only) return null;
  const one = memories.length === 1;
  return (
    <p
      data-testid="memory-saved"
      className={cn('flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground', className)}
    >
      <BookmarkCheck aria-hidden className="size-3.5 shrink-0" />
      <span className="shrink-0">Saved to Knowledge:</span>{' '}
      <Link
        to="/$tenant/app/v/$ventureId/knowledge"
        params={{ tenant, ventureId }}
        search={one ? { m: only.id } : {}}
        onClick={onNavigate}
        className="min-w-0 truncate rounded-sm underline decoration-border-strong underline-offset-4 hover:text-foreground hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        {one ? only.title : pluralize(memories.length, 'item')}
      </Link>
    </p>
  );
}
