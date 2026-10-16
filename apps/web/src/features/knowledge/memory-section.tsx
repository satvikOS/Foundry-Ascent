import type { MemoryObjectView } from '@foundry/contracts';
import { MoreHorizontal, Pencil, Pin, Plus, Search, SearchX, Trash } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Input } from '@/components/ui/input';
import { HairlineSkeleton } from '@/components/ui/page-section';
import { getStatusDefinition } from '@/components/ui/status-badge';
import { displayContent, useMemory } from '@/lib/api/hooks/memory';
import { pluralize } from '@/lib/format';
import { MEMORY_TYPE_LABELS, VISIBILITY_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';
import { memoryProvenance } from '@/features/memory/provenance';
import { availableMemoryActions } from '@/features/memory/optimistic';
import {
  actionAttributes,
  daysUntil,
  decisionAttributes,
  experimentAttributes,
  formatIsoDate,
  humaniseValue,
  milestoneAttributes,
} from '@/features/memory/typed/attributes';

import { memoryListRows, typeChips } from './memory-filters';
import type { KnowledgeSearch } from './search';

interface MemorySectionProps {
  ventureId: string;
  search: KnowledgeSearch;
  setSearch: (patch: Partial<KnowledgeSearch>, replace?: boolean) => void;
  onSelect: (memoryId: string) => void;
  canEdit: boolean;
  onCreate: () => void;
  /** Label of the create button for the selected type ("Add decision"). */
  createLabel: string;
  /** Edit an item from its row. */
  onEdit?: ((memory: MemoryObjectView) => void) | undefined;
  /** Forget an item from its row (asks first). */
  onForget?: ((memory: MemoryObjectView) => void) | undefined;
  /** The vEIR's name ("Corin's vEIR"), for the empty list. */
  veirName?: string | undefined;
}

/**
 * Everything the vEIR knows about the venture: what it learned from conversations (kept automatically) and
 * what the team added, with search and type chips over one hairline list. Each row says where it came from
 * and offers Edit and Forget; selecting it opens its detail (sources, history) in the side panel.
 */
export function MemorySection({
  ventureId,
  search,
  setSearch,
  onSelect,
  canEdit,
  onCreate,
  createLabel,
  onEdit,
  onForget,
  veirName = 'your vEIR',
}: MemorySectionProps) {
  const [query, setQuery] = useState(search.q ?? '');
  const pushed = useRef(search.q);

  // Follow the URL when it changes from outside (back button, a link with ?q=).
  useEffect(() => {
    if (search.q !== pushed.current) {
      pushed.current = search.q;
      setQuery(search.q ?? '');
    }
  }, [search.q]);

  // Debounce typing into the URL (the list query follows the URL).
  useEffect(() => {
    const handle = setTimeout(() => {
      const next = query.trim() === '' ? undefined : query.trim();
      if (next !== search.q) {
        pushed.current = next;
        setSearch({ q: next });
      }
    }, 250);
    return () => {
      clearTimeout(handle);
    };
  }, [query, search.q, setSearch]);

  // Chips count what the venture has kept; the list itself is filtered by the server.
  const all = useMemory(ventureId);
  const memory = useMemory(ventureId, {
    type: search.type,
    status: search.status,
    q: search.q,
    pinned: search.pinned,
  });
  const chips = useMemo(() => typeChips(all.data ?? [], search.type), [all.data, search.type]);
  const pinnedCount = useMemo(
    () => memoryListRows(all.data ?? [], undefined).filter((item) => item.pinned).length,
    [all.data],
  );
  const rows = useMemo(() => memoryListRows(memory.data ?? [], search.status), [memory.data, search.status]);

  const filtered =
    search.type !== undefined ||
    search.status !== undefined ||
    search.pinned !== undefined ||
    search.q !== undefined;
  const clear = () => {
    setQuery('');
    pushed.current = undefined;
    setSearch({ type: undefined, status: undefined, pinned: undefined, q: undefined });
  };

  return (
    <div className="grid gap-5">
      <div role="search" aria-label="Filter memory" className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[12rem] flex-1">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              aria-label="Search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              placeholder="Search memory"
              className="pl-9"
              maxLength={200}
            />
          </div>
        </div>
        {chips.length > 0 || pinnedCount > 0 ? (
          <div
            role="group"
            aria-label="Type"
            className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none] sm:flex-wrap sm:overflow-visible"
          >
            <Chip
              pressed={search.type === undefined && search.pinned === undefined}
              onClick={() => {
                setSearch({ type: undefined, pinned: undefined });
              }}
            >
              All
            </Chip>
            {pinnedCount > 0 || search.pinned ? (
              <Chip
                pressed={search.pinned === true}
                count={pinnedCount}
                onClick={() => {
                  setSearch({ pinned: search.pinned ? undefined : true });
                }}
              >
                <Pin aria-hidden className="size-3" />
                Pinned
              </Chip>
            ) : null}
            {chips.map((chip) => (
              <Chip
                key={chip.type}
                pressed={search.type === chip.type}
                count={chip.count}
                onClick={() => {
                  setSearch({ type: search.type === chip.type ? undefined : chip.type });
                }}
              >
                {MEMORY_TYPE_LABELS[chip.type].label}
              </Chip>
            ))}
          </div>
        ) : null}
      </div>

      <div className="flex min-h-5 items-center justify-between gap-3 text-small text-muted-foreground">
        <p role="status" aria-live="polite">
          {memory.isPending ? 'Loading…' : memory.isError ? '' : pluralize(rows.length, 'item')}
        </p>
        {filtered ? (
          <Button variant="link" size="xs" onClick={clear}>
            Clear filters
          </Button>
        ) : null}
      </div>

      {memory.isError ? (
        <ErrorState error={memory.error} onRetry={() => void memory.refetch()} headingLevel={2} />
      ) : memory.isPending ? (
        <HairlineSkeleton rows={5} label="Loading memory…" />
      ) : rows.length === 0 ? (
        filtered ? (
          <EmptyState
            icon={SearchX}
            headingLevel={2}
            title="No memory matches"
            description="Try another type or status, or clear the search."
            action={
              <Button variant="secondary" size="sm" onClick={clear}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            headingLevel={2}
            title="Nothing yet"
            description={`What ${veirName} learns in your conversations shows up here on its own. You can add things yourself too.`}
            action={
              canEdit ? (
                <Button size="sm" onClick={onCreate}>
                  <Plus aria-hidden />
                  {createLabel}
                </Button>
              ) : null
            }
          />
        )
      ) : (
        <ul aria-label="Memory" className="divide-y divide-border border-y border-border">
          {rows.map((item) => (
            <li key={item.id} className="group/row relative">
              <MemoryRow
                item={item}
                selected={item.id === search.m}
                onSelect={() => {
                  onSelect(item.id);
                }}
              />
              {canEdit && onEdit && onForget ? (
                <RowActions item={item} onEdit={onEdit} onForget={onForget} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Chip({
  pressed,
  count,
  onClick,
  children,
}: {
  pressed: boolean;
  count?: number;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-[13px] whitespace-nowrap transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        pressed
          ? 'border-foreground bg-foreground text-background'
          : 'border-border bg-transparent text-muted-foreground hover:border-border-strong hover:text-foreground',
      )}
    >
      {children}
      {count !== undefined ? (
        <>
          {/* The space keeps the accessible name readable ("Decision 1"); flex layout ignores it. */}{' '}
          <span
            className={cn('tabular text-[12px]', pressed ? 'text-background/75' : 'text-subtle-foreground')}
          >
            {count}
          </span>
        </>
      ) : null}
    </button>
  );
}

/** The one typed detail worth seeing in the list (decision date, experiment stage, due date). */
export function typedSummary(item: MemoryObjectView): string | null {
  switch (item.type) {
    case 'decision': {
      const decided = decisionAttributes(item).decided_on;
      return decided ? `Decided ${formatIsoDate(decided)}` : null;
    }
    case 'experiment': {
      const status = experimentAttributes(item).status;
      return status ? humaniseValue(status) : null;
    }
    case 'milestone': {
      const a = milestoneAttributes(item);
      return dueSummary(a.target_date, a.status, ['done', 'missed']);
    }
    case 'action': {
      const a = actionAttributes(item);
      return dueSummary(a.due, a.status, ['done', 'dropped']);
    }
    default:
      return null;
  }
}

function dueSummary(date: string | undefined, status: string | undefined, closed: string[]): string | null {
  const parts: string[] = [];
  if (status) parts.push(humaniseValue(status));
  if (date) {
    const overdue = daysUntil(date) < 0 && !closed.includes(status ?? '');
    parts.push(`${overdue ? 'Overdue since' : 'Due'} ${formatIsoDate(date)}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Edit and Forget for one row, in a small menu that shows on hover or focus (always on touch screens). */
function RowActions({
  item,
  onEdit,
  onForget,
}: {
  item: MemoryObjectView;
  onEdit: (memory: MemoryObjectView) => void;
  onForget: (memory: MemoryObjectView) => void;
}) {
  const actions = availableMemoryActions(item);
  if (!actions.includes('correct') && !actions.includes('delete')) return null;
  return (
    <div className="absolute top-2.5 right-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Actions for ${item.title}`}
            className="opacity-100 transition-opacity data-[state=open]:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within/row:opacity-100 [@media(hover:hover)]:group-hover/row:opacity-100"
          >
            <MoreHorizontal aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          {actions.includes('correct') ? (
            <DropdownMenuItem
              onSelect={() => {
                onEdit(item);
              }}
            >
              <Pencil aria-hidden />
              Edit
            </DropdownMenuItem>
          ) : null}
          {actions.includes('delete') ? (
            <DropdownMenuItem
              destructive
              onSelect={() => {
                onForget(item);
              }}
            >
              <Trash aria-hidden />
              Forget…
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function MemoryRow({
  item,
  selected,
  onSelect,
}: {
  item: MemoryObjectView;
  selected: boolean;
  onSelect: () => void;
}) {
  const Icon = MEMORY_TYPE_LABELS[item.type].icon;
  const summary = typedSummary(item);
  const shownStatus = item.status === 'proposed' || item.status === 'confirmed' ? null : item.status;
  return (
    <button
      type="button"
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
      className={cn(
        'grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 py-3.5 pr-11 pl-2 text-left transition-colors hover:bg-accent/50',
        'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
        selected && 'bg-accent/70',
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-4 text-muted-foreground" />
      <span className="flex min-w-0 items-center gap-2">
        <span className="line-clamp-2 text-[15px] font-medium [overflow-wrap:anywhere] sm:line-clamp-1">
          {item.title}
        </span>
        {item.pinned ? (
          <span className="inline-flex shrink-0 items-center text-muted-foreground">
            <Pin aria-hidden className="size-3.5" />
            <span className="sr-only">Pinned</span>
          </span>
        ) : null}
      </span>
      <span className="col-start-2 line-clamp-2 text-small text-muted-foreground [overflow-wrap:anywhere]">
        {displayContent(item)}
      </span>
      <span className="col-start-2 flex flex-wrap items-center gap-x-1.5 text-caption text-subtle-foreground">
        <span>{memoryProvenance(item).text}</span>
        <span aria-hidden>·</span>
        <span>{MEMORY_TYPE_LABELS[item.type].label}</span>
        {shownStatus ? (
          <>
            <span aria-hidden>·</span>
            <span className={cn(shownStatus === 'disputed' && 'font-medium text-destructive')}>
              {getStatusDefinition('memory', shownStatus).label}
            </span>
          </>
        ) : null}
        {summary ? (
          <>
            <span aria-hidden>·</span>
            <span>{summary}</span>
          </>
        ) : null}
        {item.visibility === 'founder_private' ? (
          <>
            <span aria-hidden>·</span>
            <span>{VISIBILITY_LABELS.founder_private.label}</span>
          </>
        ) : null}
      </span>
    </button>
  );
}
