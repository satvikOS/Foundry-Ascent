import type { NextAction } from '@foundry/contracts';
import { Check, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { formatIsoDate } from '@/features/memory/typed/attributes';

export interface NextActionControls {
  /** Indexes of next actions already in the venture's actions. */
  saved: ReadonlySet<number>;
  savingIndex: number | null;
  onAdd?: (action: NextAction, index: number) => void;
}

/**
 * Suggested next steps with their owner and date, each with one "Add to actions" control (or "In actions"
 * once saved). The same list under an answer and in a conversation's summary.
 */
export function NextStepList({
  actions,
  controls,
}: {
  actions: readonly NextAction[];
  /** Null when the person cannot add actions (read-only). */
  controls: NextActionControls | null;
}) {
  return (
    <ul className="divide-y divide-border border-y border-border">
      {actions.map((action, index) => {
        const saved = controls?.saved.has(index) ?? false;
        return (
          <li
            key={`${index}-${action.action}`}
            className="flex flex-col gap-1.5 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
          >
            <div className="min-w-0">
              <p className="text-small font-medium">{action.action}</p>
              {action.owner || action.target_date ? (
                <p className="tabular text-caption text-muted-foreground">
                  {[action.owner, action.target_date ? `by ${formatIsoDate(action.target_date)}` : null]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              ) : null}
            </div>
            {saved ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-caption font-medium">
                <Check aria-hidden className="size-3.5 text-success" />
                In actions
              </span>
            ) : controls?.onAdd ? (
              <Button
                size="xs"
                variant="ghost"
                data-print="hide"
                className="shrink-0 self-start sm:self-auto"
                loading={controls.savingIndex === index}
                loadingText="Adding…"
                onClick={() => {
                  controls.onAdd?.(action, index);
                }}
              >
                <Plus aria-hidden />
                Add to actions
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
