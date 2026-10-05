import type { MemoryObjectView } from '@foundry/contracts';
import { CalendarDays, Gavel, RotateCcw, UserRound } from 'lucide-react';

import { displayContent } from '@/lib/api/hooks/memory';

import { decisionAttributes, formatIsoDate } from './attributes';
import { TypedCard, TypedField, TypedMemoryPage } from './typed-page';

function decisionSortKey(memory: MemoryObjectView): number {
  const date = decisionAttributes(memory).decided_on;
  return date ? Date.parse(date) : Date.parse(memory.createdAt);
}

/** Decisions log: what was decided, by whom and why — and what would reverse it. */
export function DecisionsView() {
  return (
    <TypedMemoryPage
      kind="decision"
      title="Decisions"
      description="Decisions the team has made, with the rationale and the evidence that would change them."
      icon={Gavel}
      emptyTitle="No decisions recorded"
      emptyDescription="Record a decision with its rationale and a reversal condition, so future sessions can hold you to it — or revisit it when the evidence changes."
    >
      {(items, ctx) => (
        <ul className="grid gap-4 md:grid-cols-2" aria-label="Decisions">
          {[...items]
            .sort((a, b) => decisionSortKey(b) - decisionSortKey(a))
            .map((memory) => {
              const a = decisionAttributes(memory);
              return (
                <li key={memory.id} className="flex">
                  <TypedCard
                    memory={memory}
                    ctx={ctx}
                    className="flex-1"
                    meta={
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        {a.decided_on ? (
                          <span className="inline-flex items-center gap-1">
                            <CalendarDays aria-hidden className="size-3.5" />
                            <span className="sr-only">Decided on </span>
                            {formatIsoDate(a.decided_on)}
                          </span>
                        ) : null}
                        {a.owner ? (
                          <span className="inline-flex items-center gap-1">
                            <UserRound aria-hidden className="size-3.5" />
                            <span className="sr-only">Owner: </span>
                            {a.owner}
                          </span>
                        ) : null}
                      </span>
                    }
                  >
                    <p className="text-sm leading-6">{displayContent(memory)}</p>
                    <dl className="grid gap-3">
                      {a.rationale ? <TypedField label="Rationale">{a.rationale}</TypedField> : null}
                      {a.reversal_condition ? (
                        <TypedField label="Revisit if" icon={RotateCcw}>
                          {a.reversal_condition}
                        </TypedField>
                      ) : (
                        <TypedField label="Revisit if" icon={RotateCcw}>
                          <span className="text-muted-foreground">
                            No reversal condition yet — what would change your mind?
                          </span>
                        </TypedField>
                      )}
                      {a.alternatives && a.alternatives.length > 0 ? (
                        <TypedField label="Alternatives considered">
                          <ul className="list-disc pl-4 marker:text-subtle-foreground">
                            {a.alternatives.map((alt) => (
                              <li key={alt}>{alt}</li>
                            ))}
                          </ul>
                        </TypedField>
                      ) : null}
                    </dl>
                  </TypedCard>
                </li>
              );
            })}
        </ul>
      )}
    </TypedMemoryPage>
  );
}
