import type { MemoryObjectView, MemoryStatus } from '@foundry/contracts';
import { Pin, Plus, Search, SearchX } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Input } from '@/components/ui/input';
import { HairlineSkeleton } from '@/components/ui/page-section';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getStatusDefinition } from '@/components/ui/status-badge';
import { displayContent, useMemory } from '@/lib/api/hooks/memory';
import { formatDateTime, formatRelative, isoString, pluralize } from '@/lib/format';
import { MEMORY_TYPE_LABELS, VISIBILITY_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';
import {
  actionAttributes,
  daysUntil,
  decisionAttributes,
  experimentAttributes,
  formatIsoDate,
  humaniseValue,
  milestoneAttributes,
} from '@/features/memory/typed/attributes';

import { MEMORY_LIST_STATUSES, memoryListRows, typeChips } from './memory-filters';
import type { KnowledgeSearch } from './search';

const ANY = '__current__';

interface MemorySectionProps {
  ventureId: string;
  search: KnowledgeSearch;
  setSearch: (patch: Partial<KnowledgeSearch>, replace?: boolean) => void;
  onSelect: (memoryId: string) => void;
  canEdit: boolean;
  onCreate: () => void;
  /** Label of the create button for the selected type ("Add decision"). */
  createLabel: string;
}

/**
 * The venture's kept memory: type chips, a status filter and search over one hairline list. Selecting
 * an item opens its detail (source, history, actions) in the side panel.
 */
export function MemorySection({
  ventureId,
  search,
  setSearch,
  onSelect,
  canEdit,
  onCreate,
  createLabel,
}: MemorySectionProps) {
  const statusId = useId();
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
    () => (all.data ?? []).filter((item) => item.pinned && item.status !== 'proposed').length,
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
          <label htmlFor={statusId} className="sr-only">
            Status
          </label>
          <Select
            value={search.status ?? ANY}
            onValueChange={(value) => {
              setSearch({ status: value === ANY ? undefined : (value as MemoryStatus) });
            }}
          >
            <SelectTrigger id={statusId} className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Kept</SelectItem>
              {MEMORY_LIST_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {getStatusDefinition('memory', status).label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
            title="Nothing kept yet"
            description="What your team approves from conversations appears here. You can add things yourself too."
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
            <li key={item.id}>
              <MemoryRow
                item={item}
                selected={item.id === search.m}
                onSelect={() => {
                  onSelect(item.id);
                }}
              />
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
  return (
    <button
      type="button"
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
      className={cn(
        'grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-2 py-3.5 text-left transition-colors hover:bg-accent/50',
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
        <span>{MEMORY_TYPE_LABELS[item.type].label}</span>
        <span aria-hidden>·</span>
        <span className={cn(item.status === 'disputed' && 'font-medium text-destructive')}>
          {getStatusDefinition('memory', item.status).label}
        </span>
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
        <span aria-hidden>·</span>
        <span>
          Updated{' '}
          <time dateTime={isoString(item.updatedAt)} title={formatDateTime(item.updatedAt)}>
            {formatRelative(item.updatedAt)}
          </time>
        </span>
      </span>
    </button>
  );
}
