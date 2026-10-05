import { MemoryStatus, MemoryType, type MemoryObjectView } from '@foundry/contracts';
import { getRouteApi, Link } from '@tanstack/react-router';
import { Brain, Inbox, LayoutList, MousePointerClick, Plus, Search, SearchX, Table2, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { Inspector, useInspector } from '@/components/shell/inspector';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Input } from '@/components/ui/input';
import { InspectorSection } from '@/components/ui/inspector-panel';
import { Label } from '@/components/ui/label';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge, getStatusDefinition } from '@/components/ui/status-badge';
import { Switch } from '@/components/ui/switch';
import {
  SortableTableHead,
  sortRows,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
  type SortState,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useMemory } from '@/lib/api/hooks/memory';
import { useVenture } from '@/lib/api/hooks/ventures';
import { canWrite } from '@/lib/auth/roles';
import { useRequiredMe } from '@/lib/auth/use-me';
import { formatDateTime, formatRelative, isoString, pluralize } from '@/lib/format';
import { MEMORY_TYPE_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';

import { CreateMemoryDialog } from './memory-dialogs';
import { MemoryDetail } from './memory-detail';
import { ConfidenceMeter, MemoryTypeLabel, PinnedMark, VisibilityLabel } from './memory-meta';
import { ProposedQueue } from './proposed-queue';
import type { MemorySearch } from './search';

const routeApi = getRouteApi('/$tenant/app/ventures/$ventureId/memory');
const ALL = '__all__';

type SortKey = 'title' | 'type' | 'status' | 'confidence' | 'updated';

function sortValue(item: MemoryObjectView, key: SortKey): string | number {
  switch (key) {
    case 'title':
      return item.title;
    case 'type':
      return MEMORY_TYPE_LABELS[item.type].label;
    case 'status':
      return MemoryStatus.options.indexOf(item.status);
    case 'confidence':
      return item.confidence;
    case 'updated':
      return Date.parse(item.updatedAt);
  }
}

export function MemoryExplorer() {
  const me = useRequiredMe();
  const { tenant, ventureId } = routeApi.useParams();
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  const editable = canWrite(me, ventureId);
  const venture = useVenture(ventureId);
  const view = search.view ?? 'all';
  const { setOpen } = useInspector();
  const [creating, setCreating] = useState(false);

  const setSearch = useCallback(
    (patch: Partial<MemorySearch>, replace = true) =>
      void navigate({ search: (prev) => ({ ...prev, ...patch }), replace }),
    [navigate],
  );

  const select = (memoryId: string | undefined) => {
    setSearch({ m: memoryId }, false);
    if (memoryId) setOpen(true);
  };

  // Detail lookup: the unfiltered list (cached and shared) plus the proposed queue.
  const all = useMemory(ventureId);
  const proposed = useMemory(ventureId, { status: 'proposed' });
  const selected = useMemo(() => {
    if (!search.m) return null;
    return (
      all.data?.find((item) => item.id === search.m) ??
      proposed.data?.find((item) => item.id === search.m) ??
      null
    );
  }, [all.data, proposed.data, search.m]);

  const pendingCount = proposed.data?.length ?? venture.data?.pendingMemory ?? 0;

  return (
    <PageContainer size="wide">
      <Tabs
        value={view}
        onValueChange={(value) => {
          setSearch({ view: value === 'proposed' ? 'proposed' : undefined }, false);
        }}
        className="gap-0"
      >
        <PageHeader
          title="Memory"
          description="What Foundry Guide knows about this venture, with where each item came from. Nothing proposed is used until someone on the team approves it."
          actions={
            editable ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setCreating(true);
                }}
              >
                <Plus aria-hidden />
                Add memory
              </Button>
            ) : null
          }
        >
          <TabsList variant="underline">
            <TabsTrigger value="all">
              <Brain aria-hidden />
              All memory
            </TabsTrigger>
            <TabsTrigger value="proposed">
              <Inbox aria-hidden />
              Proposed
              {pendingCount > 0 ? (
                <span className="tabular rounded-sm bg-warning/15 px-1 text-[11px] text-warning">
                  {pendingCount}
                  <span className="sr-only"> to review</span>
                </span>
              ) : null}
            </TabsTrigger>
          </TabsList>
        </PageHeader>

        <TabsContent value="proposed">
          <ProposedQueue
            ventureId={ventureId}
            tenant={tenant}
            canEdit={editable}
            onOpenDetail={(id) => {
              select(id);
            }}
          />
        </TabsContent>
        <TabsContent value="all">
          <MemoryBrowser
            ventureId={ventureId}
            search={search}
            setSearch={setSearch}
            selectedId={search.m}
            onSelect={select}
            canEdit={editable}
            onCreate={() => {
              setCreating(true);
            }}
            tenant={tenant}
          />
        </TabsContent>
      </Tabs>

      <Inspector title="Memory detail" description="Provenance, confidence and version history">
        {search.m && selected ? (
          <MemoryDetail
            memory={selected}
            tenant={tenant}
            ventureId={ventureId}
            canEdit={editable}
            onRemoved={() => {
              select(undefined);
            }}
          />
        ) : search.m && (all.isPending || proposed.isPending) ? (
          <div className="grid gap-3 p-4" aria-busy="true">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-6 w-3/4" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : search.m ? (
          <InspectorSection title="Memory">
            <p className="text-[13px] text-muted-foreground">
              This item isn’t in the current memory list. It may have been deleted, rejected or replaced by a
              newer version.
            </p>
            <Button
              className="mt-3"
              size="sm"
              variant="secondary"
              onClick={() => {
                select(undefined);
              }}
            >
              Clear selection
            </Button>
          </InspectorSection>
        ) : (
          <MemorySummary items={all.data ?? []} />
        )}
      </Inspector>

      <CreateMemoryDialog
        ventureId={ventureId}
        open={creating}
        onOpenChange={setCreating}
        onCreated={(memory) => {
          select(memory.id);
        }}
      />
    </PageContainer>
  );
}

function MemorySummary({ items }: { items: MemoryObjectView[] }) {
  const byStatus = new Map<string, number>();
  const byType = new Map<string, number>();
  for (const item of items) {
    byStatus.set(item.status, (byStatus.get(item.status) ?? 0) + 1);
    byType.set(item.type, (byType.get(item.type) ?? 0) + 1);
  }
  return (
    <>
      <InspectorSection title="Select an item">
        <p className="flex items-start gap-2 text-[13px] text-muted-foreground">
          <MousePointerClick aria-hidden className="mt-0.5 size-4 shrink-0" />
          Choose a memory to see where it came from, how confident the team is, who can see it and every
          change made to it.
        </p>
      </InspectorSection>
      {items.length > 0 ? (
        <>
          <InspectorSection title="By status">
            <ul className="grid gap-1.5">
              {MemoryStatus.options
                .filter((status) => byStatus.has(status))
                .map((status) => (
                  <li key={status} className="flex items-center justify-between">
                    <StatusBadge kind="memory" status={status} />
                    <span className="tabular text-[13px]">{byStatus.get(status)}</span>
                  </li>
                ))}
            </ul>
          </InspectorSection>
          <InspectorSection title="By type">
            <ul className="grid gap-1.5">
              {MemoryType.options
                .filter((type) => byType.has(type))
                .map((type) => (
                  <li key={type} className="flex items-center justify-between">
                    <MemoryTypeLabel type={type} />
                    <span className="tabular text-[13px]">{byType.get(type)}</span>
                  </li>
                ))}
            </ul>
          </InspectorSection>
        </>
      ) : null}
    </>
  );
}

interface MemoryBrowserProps {
  ventureId: string;
  tenant: string;
  search: MemorySearch;
  setSearch: (patch: Partial<MemorySearch>, replace?: boolean) => void;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  canEdit: boolean;
  onCreate: () => void;
}

function MemoryBrowser({
  ventureId,
  tenant,
  search,
  setSearch,
  selectedId,
  onSelect,
  canEdit,
  onCreate,
}: MemoryBrowserProps) {
  const ids = { search: useId(), type: useId(), status: useId(), pinned: useId() };
  const [query, setQuery] = useState(search.q ?? '');
  const pushedQuery = useRef(search.q);
  const [sort, setSort] = useState<SortState<SortKey> | null>({ key: 'updated', direction: 'desc' });
  const layout = search.layout ?? 'list';

  useEffect(() => {
    if (search.q !== pushedQuery.current) {
      pushedQuery.current = search.q;
      setQuery(search.q ?? '');
    }
  }, [search.q]);

  useEffect(() => {
    const handle = setTimeout(() => {
      const next = query.trim() === '' ? undefined : query.trim();
      if (next !== search.q) {
        pushedQuery.current = next;
        setSearch({ q: next });
      }
    }, 250);
    return () => {
      clearTimeout(handle);
    };
  }, [query, search.q, setSearch]);

  const memory = useMemory(ventureId, {
    type: search.type,
    status: search.status,
    q: search.q,
    pinned: search.pinned,
  });
  const items = useMemo(() => {
    const rows = memory.data ?? [];
    // Pinned items first in the list layout; the table uses explicit column sorting.
    if (layout === 'table') return sortRows(rows, sort, sortValue);
    return [...rows].sort(
      (a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    );
  }, [memory.data, layout, sort]);

  const hasFilters =
    search.type !== undefined ||
    search.status !== undefined ||
    search.pinned !== undefined ||
    search.q !== undefined;
  const clearFilters = () => {
    setQuery('');
    pushedQuery.current = undefined;
    setSearch({ type: undefined, status: undefined, pinned: undefined, q: undefined });
  };

  return (
    <div className="grid gap-4">
      <div role="search" aria-label="Filter memory" className="flex flex-wrap items-end gap-3">
        <div className="grid min-w-[14rem] flex-1 gap-1.5">
          <Label htmlFor={ids.search} className="text-xs text-muted-foreground">
            Search
          </Label>
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id={ids.search}
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
              }}
              placeholder="Search titles and details"
              className="pl-9"
              maxLength={200}
            />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={ids.type} className="text-xs text-muted-foreground">
            Type
          </Label>
          <Select
            value={search.type ?? ALL}
            onValueChange={(value) => {
              setSearch({ type: value === ALL ? undefined : (value as MemoryType) });
            }}
          >
            <SelectTrigger id={ids.type} className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All types</SelectItem>
              {MemoryType.options.map((type) => {
                const Icon = MEMORY_TYPE_LABELS[type].icon;
                return (
                  <SelectItem key={type} value={type}>
                    <Icon aria-hidden className="size-4 text-muted-foreground" />
                    {MEMORY_TYPE_LABELS[type].label}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={ids.status} className="text-xs text-muted-foreground">
            Status
          </Label>
          <Select
            value={search.status ?? ALL}
            onValueChange={(value) => {
              setSearch({ status: value === ALL ? undefined : (value as MemoryStatus) });
            }}
          >
            <SelectTrigger id={ids.status} className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any status</SelectItem>
              {MemoryStatus.options.map((status) => {
                const def = getStatusDefinition('memory', status);
                const Icon = def.icon;
                return (
                  <SelectItem key={status} value={status}>
                    <Icon aria-hidden className="size-4 text-muted-foreground" />
                    {def.label}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>
        <div className="flex h-9 items-center gap-2">
          <Switch
            id={ids.pinned}
            checked={search.pinned === true}
            onCheckedChange={(checked) => {
              setSearch({ pinned: checked ? true : undefined });
            }}
          />
          <Label htmlFor={ids.pinned} className="font-normal">
            Pinned only
          </Label>
        </div>
      </div>

      <div className="flex min-h-8 items-center justify-between gap-3 text-[13px] text-muted-foreground">
        <p role="status" aria-live="polite">
          {memory.isPending ? 'Loading…' : memory.isError ? '' : pluralize(items.length, 'item')}
          {memory.isFetching && !memory.isPending ? <span className="sr-only"> (updating)</span> : null}
        </p>
        <div className="flex items-center gap-2">
          {hasFilters ? (
            <Button variant="ghost" size="xs" onClick={clearFilters}>
              <X aria-hidden />
              Clear filters
            </Button>
          ) : null}
          <div className="flex items-center gap-1" role="group" aria-label="Layout">
            <Button
              variant={layout === 'list' ? 'secondary' : 'ghost'}
              size="icon-sm"
              aria-label="List layout"
              aria-pressed={layout === 'list'}
              onClick={() => {
                setSearch({ layout: undefined });
              }}
            >
              <LayoutList aria-hidden />
            </Button>
            <Button
              variant={layout === 'table' ? 'secondary' : 'ghost'}
              size="icon-sm"
              aria-label="Table layout"
              aria-pressed={layout === 'table'}
              onClick={() => {
                setSearch({ layout: 'table' });
              }}
            >
              <Table2 aria-hidden />
            </Button>
          </div>
        </div>
      </div>

      {memory.isError ? (
        <ErrorState error={memory.error} onRetry={() => void memory.refetch()} />
      ) : memory.isPending ? (
        <div aria-busy="true" className="overflow-hidden rounded-xl border border-border bg-card">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="grid gap-2 border-b border-border px-4 py-3.5 last:border-0">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3.5 w-3/4" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        hasFilters ? (
          <EmptyState
            icon={SearchX}
            title="No memory matches these filters"
            description="Try a different type or status, or clear the search."
            action={
              <Button variant="secondary" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={Brain}
            title="Nothing remembered yet"
            description="Approved decisions, evidence, experiments and facts from your sessions will collect here. You can also add memory yourself."
            action={
              canEdit ? (
                <>
                  <Button size="sm" onClick={onCreate}>
                    <Plus aria-hidden />
                    Add memory
                  </Button>
                  <Button asChild size="sm" variant="secondary">
                    <Link to="/$tenant/app/ventures/$ventureId/coach" params={{ tenant, ventureId }}>
                      Start a session
                    </Link>
                  </Button>
                </>
              ) : null
            }
          />
        )
      ) : layout === 'table' ? (
        <Table aria-label="Memory">
          <TableHeader>
            <TableRow>
              <SortableTableHead sortKey="title" sort={sort} onSortChange={setSort}>
                Title
              </SortableTableHead>
              <SortableTableHead sortKey="type" sort={sort} onSortChange={setSort}>
                Type
              </SortableTableHead>
              <SortableTableHead sortKey="status" sort={sort} onSortChange={setSort}>
                Status
              </SortableTableHead>
              <SortableTableHead sortKey="confidence" sort={sort} onSortChange={setSort}>
                Confidence
              </SortableTableHead>
              <SortableTableHead sortKey="updated" sort={sort} onSortChange={setSort}>
                Updated
              </SortableTableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.id} data-state={item.id === selectedId ? 'selected' : undefined}>
                <TableCell className="max-w-[28rem]">
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-1.5 text-left font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                    aria-current={item.id === selectedId ? 'true' : undefined}
                    onClick={() => {
                      onSelect(item.id);
                    }}
                  >
                    <span className="truncate">{item.title}</span>
                    {item.pinned ? <PinnedMark className="sr-only" /> : null}
                  </button>
                </TableCell>
                <TableCell>
                  <MemoryTypeLabel type={item.type} />
                </TableCell>
                <TableCell>
                  <StatusBadge kind="memory" status={item.status} />
                </TableCell>
                <TableCell>
                  <ConfidenceMeter value={item.confidence} />
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  <time dateTime={isoString(item.updatedAt)} title={formatDateTime(item.updatedAt)}>
                    {formatRelative(item.updatedAt)}
                  </time>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <ul aria-label="Memory" className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          {items.map((item) => (
            <li key={item.id} className="border-b border-border last:border-0">
              <MemoryRow
                item={item}
                selected={item.id === selectedId}
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

function MemoryRow({
  item,
  selected,
  onSelect,
}: {
  item: MemoryObjectView;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
      className={cn(
        'grid w-full gap-1.5 px-4 py-3 text-left transition-colors hover:bg-accent/50',
        'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
        selected && 'bg-accent/70',
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <MemoryTypeLabel type={item.type} iconOnly />
        <span className="truncate text-sm font-medium">{item.title}</span>
        {item.pinned ? <PinnedMark className="ml-auto shrink-0" /> : null}
      </span>
      <span className="line-clamp-2 text-[13px] text-muted-foreground">{item.content}</span>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatusBadge kind="memory" status={item.status} />
        <ConfidenceMeter value={item.confidence} />
        <VisibilityLabel visibility={item.visibility} />
        <span className="text-xs text-muted-foreground">
          Updated{' '}
          <time dateTime={isoString(item.updatedAt)} title={formatDateTime(item.updatedAt)}>
            {formatRelative(item.updatedAt)}
          </time>
        </span>
      </span>
    </button>
  );
}
