import type { MemoryCandidate, MemoryObjectView } from '@foundry/contracts';
import { Check } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

import { handOffFocus, useFocusHandoff } from './focus-handoff';

/** A memory suggestion of an answer and the memory item it was saved as (null until found or saved). */
export interface CandidateBinding {
  candidate: MemoryCandidate;
  memory: MemoryObjectView | null;
}

export interface MemorySuggestionControls {
  /** True while the venture's memory list is loading (bindings are not known yet). */
  loading: boolean;
  /** The memory item an action is running for. */
  pendingId: string | null;
  /** Title of a candidate being saved. */
  savingTitle: string | null;
  onKeep: (memory: MemoryObjectView) => void;
  onDismiss: (memory: MemoryObjectView) => void;
  /** Save a candidate that has no memory item yet. */
  onSave: (candidate: MemoryCandidate) => void;
}

/**
 * "{Name} would like to remember: …  Keep · Not now", one compact row per suggestion. Nothing becomes
 * memory until a person keeps it; a kept item shows as kept, a declined one disappears.
 */
export function MemorySuggestions({
  personaName,
  bindings,
  controls,
}: {
  personaName: string;
  bindings: readonly CandidateBinding[];
  controls: MemorySuggestionControls;
}) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const rows = bindings.filter(
    ({ candidate, memory }) =>
      !hidden.has(candidate.title) &&
      (memory === null || memory.status === 'proposed' || memory.status === 'confirmed'),
  );
  if (rows.length === 0) return null;

  return (
    <ul aria-label="Memory suggestions" className="mt-4 grid gap-2">
      {rows.map(({ candidate, memory }, index) => {
        const busy = memory !== null && controls.pendingId === memory.id;
        const title = memory?.title ?? candidate.title;
        const content = memory?.content ?? candidate.content;
        return (
          <li
            key={`${index}-${candidate.title}`}
            className="flex flex-col gap-2 rounded-xl border border-border px-3.5 py-2.5 sm:flex-row sm:items-center sm:gap-4"
          >
            <p className="min-w-0 flex-1 text-small leading-5" title={content}>
              <span className="text-muted-foreground">{personaName} would like to remember: </span>
              <span className="font-medium [overflow-wrap:anywhere]">{title}</span>
            </p>
            <div className="flex shrink-0 items-center gap-1.5">
              {controls.loading ? (
                <Skeleton className="h-7 w-28" />
              ) : memory?.status === 'confirmed' ? (
                <Kept focusKey={`memory:${title}`} />
              ) : memory ? (
                <>
                  <Button
                    size="xs"
                    disabled={busy}
                    aria-label={`Keep: ${title}`}
                    onClick={() => {
                      handOffFocus(`memory:${title}`);
                      controls.onKeep(memory);
                    }}
                  >
                    Keep
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    aria-label={`Not now: ${title}`}
                    onClick={() => {
                      controls.onDismiss(memory);
                    }}
                  >
                    Not now
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    size="xs"
                    loading={controls.savingTitle === candidate.title}
                    aria-label={`Keep: ${title}`}
                    onClick={() => {
                      handOffFocus(`memory:${title}`);
                      controls.onSave(candidate);
                    }}
                  >
                    Keep
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={`Not now: ${title}`}
                    onClick={() => {
                      setHidden((prev) => new Set(prev).add(candidate.title));
                    }}
                  >
                    Not now
                  </Button>
                </>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** "Kept", in place of the Keep button it replaces (and taking its focus). */
function Kept({ focusKey }: { focusKey: string }) {
  const ref = useFocusHandoff<HTMLSpanElement>(focusKey);
  return (
    <span
      ref={ref}
      tabIndex={-1}
      className="inline-flex h-7 items-center gap-1 rounded-sm text-small font-medium focus-visible:outline-2 focus-visible:outline-ring"
    >
      <Check aria-hidden className="size-4 text-success" />
      Kept
    </span>
  );
}
