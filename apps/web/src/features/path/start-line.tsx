import type { VenturePath } from '@foundry/contracts';
import { Link } from '@tanstack/react-router';

import type { PromptSuggestion } from '@/features/chat/suggestions';
import { cn } from '@/lib/utils';

import { dueState } from './due';
import { startChips } from './start';

/** Under New chat's greeting: the step the path is on and its date, one press from the path. */
export function NowLine({
  path,
  tenant,
  ventureId,
}: {
  path: VenturePath;
  tenant: string;
  ventureId: string;
}) {
  if (!path.now) return null;
  const due = dueState(path.now.dueOn);
  return (
    <p data-testid="greeting-step" className="mt-3 max-w-xl text-small text-pretty text-muted-foreground">
      Now:{' '}
      <Link
        to="/$tenant/app/v/$ventureId/path"
        params={{ tenant, ventureId }}
        data-slot="next-step"
        className="rounded-sm font-medium text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        {path.now.title}
      </Link>
      {due ? <span className={cn('tabular', due.overdue && 'text-warning')}> · {due.text}</span> : null}
    </p>
  );
}

/** Ways to start, on one line that scrolls sideways: each fills the composer, ready to finish and send. */
export function StartChips({
  path,
  onPick,
}: {
  path: VenturePath;
  onPick: (suggestion: PromptSuggestion) => void;
}) {
  return (
    <ul
      aria-label="Start with"
      data-slot="start-chips"
      className="-mx-4 mt-4 flex gap-2 overflow-x-auto overscroll-x-contain px-4 pb-0.5 [scrollbar-width:none] sm:mx-0 sm:justify-center sm:overflow-visible sm:px-0"
    >
      {startChips(path).map((suggestion) => (
        // The step's own chip gives way (its title is on the line above); the others keep their words.
        <li
          key={suggestion.id}
          className={
            suggestion.id === 'path-continue' ? 'max-w-[75vw] min-w-0 shrink-0 sm:shrink' : 'shrink-0'
          }
        >
          <button
            type="button"
            onClick={() => {
              onPick(suggestion);
            }}
            className="glass block max-w-full truncate rounded-full border border-border px-3.5 py-1.5 text-left text-small text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11"
          >
            {suggestion.id === 'path-continue' ? (
              <>
                Continue: <span data-slot="next-step">{suggestion.label.replace(/^Continue: /, '')}</span>
              </>
            ) : (
              suggestion.label
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
