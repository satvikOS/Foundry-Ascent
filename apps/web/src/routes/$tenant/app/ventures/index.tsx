import { VentureStage, type VentureSummary } from '@foundry/contracts';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { LayoutGrid, List, Plus, Rocket, Search, SearchX, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Input } from '@/components/ui/input';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { StageChip } from '@/components/ui/stage-chip';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  SortableTableHead,
  sortRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  type SortState,
} from '@/components/ui/table';
import { VentureCard, VentureCardSkeleton } from '@/components/ventures/venture-card';
import { useVentures, venturesQueryOptions } from '@/lib/api/hooks/ventures';
import { canUseProgramConsole, ROLE_LABELS } from '@/lib/auth/roles';
import { useRequiredMe } from '@/lib/auth/use-me';
import { formatRelative, pluralize } from '@/lib/format';
import { STAGE_LABELS, STAGE_ORDER } from '@/lib/labels';
import { safeStorage, STORAGE_KEYS } from '@/lib/storage';
import { cn } from '@/lib/utils';

type SortKey = 'name' | 'stage' | 'lastSession' | 'pendingMemory' | 'openEscalations';
type View = 'grid' | 'list';

interface VenturesSearch {
  q?: string | undefined;
  stage?: VentureStage | undefined;
  view?: View | undefined;
  sort?: SortKey | undefined;
  dir?: 'asc' | 'desc' | undefined;
}

const SORT_KEYS: SortKey[] = ['name', 'stage', 'lastSession', 'pendingMemory', 'openEscalations'];

export const Route = createFileRoute('/$tenant/app/ventures/')({
  validateSearch: (search: Record<string, unknown>): VenturesSearch => {
    const stage = VentureStage.safeParse(search.stage);
    return {
      q: typeof search.q === 'string' && search.q.trim() ? search.q.slice(0, 100) : undefined,
      stage: stage.success ? stage.data : undefined,
      view: search.view === 'list' || search.view === 'grid' ? search.view : undefined,
      sort: SORT_KEYS.includes(search.sort as SortKey) ? (search.sort as SortKey) : undefined,
      dir: search.dir === 'desc' || search.dir === 'asc' ? search.dir : undefined,
    };
  },
  loader: ({ context }) => {
    context.queryClient.query(venturesQueryOptions()).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Ventures' }] }),
  component: VenturesPage,
});

function sortValue(v: VentureSummary, key: SortKey): string | number | null {
  switch (key) {
    case 'name':
      return v.name;
    case 'stage':
      return STAGE_ORDER.indexOf(v.stage);
    case 'lastSession':
      return v.lastSessionAt ? Date.parse(v.lastSessionAt) : null;
    case 'pendingMemory':
      return v.pendingMemory;
    case 'openEscalations':
      return v.openEscalations;
  }
}

function VenturesPage() {
  const me = useRequiredMe();
  const tenant = me.tenant.slug;
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const ventures = useVentures();
  const searchId = useId();
  const [query, setQuery] = useState(search.q ?? '');
  const pushedQuery = useRef(search.q);

  // Adopt URL changes we didn't make (back/forward, links) without clobbering in-progress typing.
  useEffect(() => {
    if (search.q !== pushedQuery.current) {
      pushedQuery.current = search.q;
      setQuery(search.q ?? '');
    }
  }, [search.q]);

  const view: View = search.view ?? (safeStorage.get(STORAGE_KEYS.venturesView) === 'list' ? 'list' : 'grid');
  const sort: SortState<SortKey> | null = search.sort
    ? { key: search.sort, direction: search.dir ?? 'asc' }
    : null;

  // Debounce the text filter into the URL (shareable, back-button friendly).
  useEffect(() => {
    const handle = setTimeout(() => {
      const trimmed = query.trim();
      const next = trimmed === '' ? undefined : trimmed;
      if (next !== search.q) {
        pushedQuery.current = next;
        void navigate({ search: (prev) => ({ ...prev, q: next }), replace: true });
      }
    }, 200);
    return () => {
      clearTimeout(handle);
    };
  }, [query, search.q, navigate]);

  const filtered = useMemo(() => {
    const needle = (search.q ?? '').toLowerCase();
    const rows = (ventures.data ?? []).filter(
      (v) =>
        (!search.stage || v.stage === search.stage) &&
        (!needle || v.name.toLowerCase().includes(needle) || v.oneLiner.toLowerCase().includes(needle)),
    );
    return sortRows(rows, sort ?? { key: 'name', direction: 'asc' }, sortValue);
  }, [ventures.data, search.q, search.stage, sort]);

  const setView = (next: View) => {
    safeStorage.set(STORAGE_KEYS.venturesView, next);
    void navigate({ search: (prev) => ({ ...prev, view: next }), replace: true });
  };
  const clearFilters = () => {
    setQuery('');
    pushedQuery.current = undefined;
    void navigate({ search: (prev) => ({ ...prev, q: undefined, stage: undefined }), replace: true });
  };
  const onSort = (next: SortState<SortKey>) =>
    void navigate({ search: (prev) => ({ ...prev, sort: next.key, dir: next.direction }), replace: true });
  const hasFilters = search.q !== undefined || search.stage !== undefined;
  const total = ventures.data?.length ?? 0;

  return (
    <PageContainer size="wide">
      <PageHeader
        title="Ventures"
        description="Every venture you’re a member of or assigned to."
        actions={
          canUseProgramConsole(me) ? (
            <Button asChild variant="secondary">
              <Link to="/$tenant/app/program/ventures" params={{ tenant }}>
                <Plus aria-hidden />
                Enrol venture
              </Link>
            </Button>
          ) : null
        }
      >
        <div
          role="search"
          aria-label="Filter ventures"
          className="flex flex-col gap-2 sm:flex-row sm:items-center"
        >
          <div className="relative w-full sm:max-w-xs">
            <label htmlFor={searchId} className="sr-only">
              Search ventures
            </label>
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id={searchId}
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
              }}
              placeholder="Search by name or one-liner"
              className="pl-8"
            />
          </div>
          <Select
            value={search.stage ?? 'all'}
            onValueChange={(value) =>
              void navigate({
                search: (prev) => ({ ...prev, stage: value === 'all' ? undefined : (value as VentureStage) }),
                replace: true,
              })
            }
          >
            <SelectTrigger className="w-full sm:w-48" aria-label="Filter by stage">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All stages</SelectItem>
              {STAGE_ORDER.map((stage) => (
                <SelectItem key={stage} value={stage}>
                  {STAGE_LABELS[stage]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {hasFilters ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                clearFilters();
              }}
            >
              <X aria-hidden />
              Clear
            </Button>
          ) : null}
          <div className="flex items-center gap-3 sm:ml-auto">
            <p className="text-[13px] text-muted-foreground" aria-live="polite">
              {ventures.isSuccess
                ? hasFilters
                  ? `${filtered.length} of ${pluralize(total, 'venture')}`
                  : pluralize(total, 'venture')
                : null}
            </p>
            <div role="group" aria-label="Layout" className="flex rounded-md border border-border p-0.5">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Grid view"
                aria-pressed={view === 'grid'}
                className={cn(view === 'grid' && 'bg-accent')}
                onClick={() => {
                  setView('grid');
                }}
              >
                <LayoutGrid aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="List view"
                aria-pressed={view === 'list'}
                className={cn(view === 'list' && 'bg-accent')}
                onClick={() => {
                  setView('list');
                }}
              >
                <List aria-hidden />
              </Button>
            </div>
          </div>
        </div>
      </PageHeader>

      {ventures.isError ? (
        <ErrorState error={ventures.error} onRetry={() => void ventures.refetch()} />
      ) : ventures.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true">
          <span className="sr-only" role="status">
            Loading ventures…
          </span>
          {Array.from({ length: 6 }, (_, i) => (
            <VentureCardSkeleton key={i} />
          ))}
        </div>
      ) : total === 0 ? (
        <EmptyState
          icon={Rocket}
          headingLevel={2}
          title="No ventures yet"
          description="When a program lead adds you to a venture, it will appear here."
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={SearchX}
          headingLevel={2}
          title="No ventures match"
          description="Try a different search or stage."
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                clearFilters();
              }}
            >
              Clear filters
            </Button>
          }
        />
      ) : view === 'grid' ? (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((venture) => (
            <li key={venture.id}>
              <VentureCard venture={venture} tenant={tenant} />
            </li>
          ))}
        </ul>
      ) : (
        <Table>
          <caption className="sr-only">Ventures, sortable by column</caption>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <SortableTableHead sortKey="name" sort={sort} onSortChange={onSort}>
                Venture
              </SortableTableHead>
              <SortableTableHead sortKey="stage" sort={sort} onSortChange={onSort}>
                Stage
              </SortableTableHead>
              <TableHead>Your role</TableHead>
              <SortableTableHead sortKey="lastSession" sort={sort} onSortChange={onSort}>
                Last session
              </SortableTableHead>
              <SortableTableHead align="right" sortKey="pendingMemory" sort={sort} onSortChange={onSort}>
                To review
              </SortableTableHead>
              <SortableTableHead align="right" sortKey="openEscalations" sort={sort} onSortChange={onSort}>
                Escalations
              </SortableTableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((venture) => (
              <TableRow key={venture.id}>
                <TableCell>
                  <div className="flex items-center gap-2.5">
                    <Avatar name={venture.name} shape="square" size="sm" decorative />
                    <div className="min-w-0">
                      <Link
                        to="/$tenant/app/ventures/$ventureId/overview"
                        params={{ tenant, ventureId: venture.id }}
                        className="font-medium hover:underline hover:underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        {venture.name}
                      </Link>
                      <p className="max-w-xs truncate text-xs text-muted-foreground">{venture.oneLiner}</p>
                    </div>
                    {venture.status !== 'active' ? (
                      <StatusBadge kind="venture" status={venture.status} />
                    ) : null}
                  </div>
                </TableCell>
                <TableCell>
                  <StageChip stage={venture.stage} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {venture.myRole ? ROLE_LABELS[venture.myRole] : 'Assigned'}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {venture.lastSessionAt ? formatRelative(venture.lastSessionAt) : 'Never'}
                </TableCell>
                <TableCell className="tabular text-right">{venture.pendingMemory}</TableCell>
                <TableCell className="tabular text-right">{venture.openEscalations}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </PageContainer>
  );
}
