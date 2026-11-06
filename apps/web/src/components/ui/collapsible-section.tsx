import { ChevronRight } from 'lucide-react';
import { useCallback, useId, useState, type ReactNode } from 'react';

import { safeStorage, STORAGE_KEYS } from '@/lib/storage';
import { cn } from '@/lib/utils';

/** The person's own choice per section id ("1" unfolded, "0" folded); absent: the section's default. */
function storedChoices(): Record<string, '0' | '1'> {
  try {
    const parsed: unknown = JSON.parse(safeStorage.get(STORAGE_KEYS.panelSections) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, '0' | '1'] => entry[1] === '0' || entry[1] === '1',
      ),
    );
  } catch {
    return {};
  }
}

/** Whether section `id` is unfolded: the person's last choice in this browser, else `defaultOpen`. */
export function sectionOpen(id: string, defaultOpen: boolean): boolean {
  const choice = storedChoices()[id];
  return choice === undefined ? defaultOpen : choice === '1';
}

function rememberSection(id: string, open: boolean): void {
  safeStorage.set(STORAGE_KEYS.panelSections, JSON.stringify({ ...storedChoices(), [id]: open ? '1' : '0' }));
}

interface CollapsibleSectionProps {
  /** Stable id: the folded or unfolded choice is remembered under it, per browser. */
  id: string;
  title: string;
  /** Shown after the title, also while folded (a count). */
  meta?: ReactNode;
  /** Its name for screen readers when `meta` alone would be unclear ("3 due"). */
  metaLabel?: string;
  /** Unfolded until the person folds it. */
  defaultOpen?: boolean;
  /** One control at the end of the heading row (outside the toggle), shown while unfolded. */
  action?: ReactNode;
  /** The side panel's own tones (`sidebar`) or the right panel's (`panel`). */
  tone?: 'panel' | 'sidebar';
  /** The heading's level in the page's outline (default 3, under a panel's own heading). */
  headingLevel?: 2 | 3;
  className?: string;
  children: ReactNode;
}

/**
 * A section of a side panel that folds away: its heading is a disclosure button (Enter or Space folds and unfolds it,
 * `aria-expanded` says which, `aria-controls` names the content), with an optional count beside the title and one
 * action at the end of the row. Folded, its content is not rendered at all (nothing in it is fetched). The choice is
 * remembered per browser. Plain React (the side panel is in the first page load, which has a script budget).
 */
export function CollapsibleSection({
  id,
  title,
  meta,
  metaLabel,
  defaultOpen = true,
  action,
  tone = 'panel',
  headingLevel = 3,
  className,
  children,
}: CollapsibleSectionProps) {
  const headingId = useId();
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const [open, setOpenState] = useState(() => sectionOpen(id, defaultOpen));
  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      rememberSection(id, next);
    },
    [id],
  );
  const sidebar = tone === 'sidebar';
  const contentId = `${headingId}-content`;
  return (
    <section
      aria-labelledby={headingId}
      data-slot="panel-section"
      data-section={id}
      data-state={open ? 'open' : 'closed'}
      className={cn('grid gap-1.5', className)}
    >
      <div className="flex min-h-7 items-center gap-1">
        <Heading id={headingId} className="m-0 min-w-0 flex-1">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open ? contentId : undefined}
            data-state={open ? 'open' : 'closed'}
            onClick={() => {
              setOpen(!open);
            }}
            className={cn(
              'group/section -ml-1 flex w-full min-w-0 items-center gap-1 rounded-sm px-1 py-0.5 text-left',
              'focus-visible:outline-2 focus-visible:outline-ring',
              sidebar
                ? 'text-caption font-medium text-sidebar-muted hover:text-sidebar-foreground'
                : 'section-label hover:text-foreground',
            )}
          >
            <span className="truncate">{title}</span>
            {meta !== undefined && meta !== null ? (
              <span className="tabular">
                {meta}
                {metaLabel ? <span className="sr-only"> {metaLabel}</span> : null}
              </span>
            ) : null}
            <ChevronRight
              aria-hidden
              className="size-3.5 shrink-0 opacity-70 transition-transform duration-(--dur-hover) group-data-[state=open]/section:rotate-90 motion-reduce:transition-none"
            />
          </button>
        </Heading>
        {open && action ? <div className="flex shrink-0 items-center">{action}</div> : null}
      </div>
      {open ? <div id={contentId}>{children}</div> : null}
    </section>
  );
}
