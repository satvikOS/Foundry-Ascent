import type { ResourceView } from '@foundry/contracts';
import {
  Archive,
  CircleCheck,
  Clock,
  Ellipsis,
  ExternalLink,
  FileClock,
  ListTree,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  SearchX,
  TriangleAlert,
} from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { announce } from '@/components/a11y/live-announcer';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Input } from '@/components/ui/input';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
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
import { errorMessage } from '@/lib/api/errors';
import { useResources, useUpdateResource } from '@/lib/api/hooks/program';
import { formatDate, formatRelative, pluralize } from '@/lib/format';
import { STAGE_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';

import {
  REVIEW_OVERDUE_DAYS,
  REVIEW_SOON_DAYS,
  RESOURCE_KIND_LABELS,
  resourceFreshness,
  safeExternalUrl,
  type FreshnessLevel,
} from './freshness';
import { ResourceFormSheet } from './resource-form-sheet';

type StatusFilter = 'in_use' | 'stale' | 'needs_review' | 'retired' | 'all';
type SortKey = 'name' | 'kind' | 'freshness';

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'in_use', label: 'In use (current + stale)' },
  { value: 'needs_review', label: 'Needs review' },
  { value: 'stale', label: 'Flagged stale' },
  { value: 'retired', label: 'Retired' },
  { value: 'all', label: 'All resources' },
];

const FRESHNESS: Record<FreshnessLevel, { label: string; icon: typeof CircleCheck; className: string }> = {
  fresh: { label: 'Fresh', icon: CircleCheck, className: 'text-muted-foreground' },
  review_soon: { label: 'Review soon', icon: Clock, className: 'text-warning' },
  overdue: { label: 'Review overdue', icon: TriangleAlert, className: 'text-destructive' },
};

/** Icon + label + relative date; the exact date is in the tooltip/title and <time>. */
export function FreshnessIndicator({ freshnessAt, now }: { freshnessAt: string; now?: number }) {
  const { level } = resourceFreshness(freshnessAt, now);
  const def = FRESHNESS[level];
  const Icon = def.icon;
  return (
    <span
      className="inline-flex flex-col gap-0.5 text-[13px]"
      title={`Last reviewed ${formatDate(freshnessAt)}`}
    >
      <span className={cn('inline-flex items-center gap-1 font-medium', def.className)}>
        <Icon aria-hidden className="size-3.5" />
        {def.label}
      </span>
      <span className="text-xs text-muted-foreground">
        Reviewed <time dateTime={freshnessAt}>{formatRelative(freshnessAt)}</time>
      </span>
    </span>
  );
}

function needsReview(resource: ResourceView): boolean {
  return resource.status === 'stale' || resourceFreshness(resource.freshnessAt).level !== 'fresh';
}

function matchesStatus(resource: ResourceView, filter: StatusFilter): boolean {
  switch (filter) {
    case 'in_use':
      return resource.status !== 'retired';
    case 'stale':
      return resource.status === 'stale';
    case 'needs_review':
      return resource.status !== 'retired' && needsReview(resource);
    case 'retired':
      return resource.status === 'retired';
    case 'all':
      return true;
  }
}

/** Program console → Resources: the resource graph Foundry Guide uses in route mode. */
export function ResourcesPage() {
  const resources = useResources();
  const update = useUpdateResource();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<string>('all');
  const [status, setStatus] = useState<StatusFilter>('in_use');
  const [sort, setSort] = useState<SortState<SortKey> | null>({ key: 'name', direction: 'asc' });
  const [editing, setEditing] = useState<{ open: boolean; resource: ResourceView | null }>({
    open: false,
    resource: null,
  });
  const [retiring, setRetiring] = useState<ResourceView | null>(null);
  const searchId = useId();

  const all = useMemo(() => resources.data ?? [], [resources.data]);
  const reviewCount = all.filter((r) => r.status !== 'retired' && needsReview(r)).length;

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = all.filter(
      (r) =>
        matchesStatus(r, status) &&
        (kind === 'all' || r.kind === kind) &&
        (!needle ||
          [r.name, r.description, r.owner ?? '', ...r.tags].some((text) =>
            text.toLowerCase().includes(needle),
          )),
    );
    return sortRows(filtered, sort, (r, key) =>
      key === 'name' ? r.name : key === 'kind' ? RESOURCE_KIND_LABELS[r.kind] : Date.parse(r.freshnessAt),
    );
  }, [all, query, kind, status, sort]);

  const setResourceStatus = (resource: ResourceView, next: ResourceView['status'], message: string) => {
    update.mutate(
      { resourceId: resource.id, patch: { status: next } },
      {
        onSuccess: () => {
          toast.success(message);
          announce(message);
        },
        onError: (error) => {
          toast.error(errorMessage(error));
        },
      },
    );
  };

  const openCreate = () => {
    setEditing({ open: true, resource: null });
  };

  return (
    <PageContainer size="wide">
      <PageHeader
        title="Resources"
        description="Programs, funding, labs and clinics Foundry Guide can route founders to. Stale entries mislead founders — review them regularly."
        actions={
          <Button onClick={openCreate}>
            <Plus aria-hidden />
            Add resource
          </Button>
        }
      >
        <div
          role="search"
          aria-label="Filter resources"
          className="flex flex-col gap-2 lg:flex-row lg:items-center"
        >
          <div className="relative w-full lg:max-w-xs">
            <label htmlFor={searchId} className="sr-only">
              Search resources
            </label>
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id={searchId}
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              placeholder="Search name, description, tags"
              className="pl-8"
            />
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger className="w-full sm:w-44" aria-label="Filter by kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All kinds</SelectItem>
                {Object.entries(RESOURCE_KIND_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={status}
              onValueChange={(value) => {
                const match = STATUS_FILTERS.find((f) => f.value === value);
                if (match) setStatus(match.value);
              }}
            >
              <SelectTrigger className="w-full sm:w-56" aria-label="Filter by status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_FILTERS.map((f) => (
                  <SelectItem key={f.value} value={f.value}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-[13px] text-muted-foreground lg:ml-auto" aria-live="polite">
            {resources.isSuccess
              ? `${rows.length} shown · ${pluralize(reviewCount, 'needs', 'need')} review`
              : null}
          </p>
        </div>
      </PageHeader>

      {resources.isPending ? (
        <LoadingRegion label="Loading resources">
          <Skeleton className="h-72 rounded-xl" />
        </LoadingRegion>
      ) : resources.isError ? (
        <ErrorState
          error={resources.error}
          onRetry={() => void resources.refetch()}
          retrying={resources.isRefetching}
        />
      ) : all.length === 0 ? (
        <EmptyState
          icon={ListTree}
          title="No resources yet"
          description="Add the programs, funds and clinics founders can use. Foundry Guide only routes to resources listed here."
          action={
            <Button onClick={openCreate}>
              <Plus aria-hidden />
              Add resource
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title="No resources match"
          description="Try a different search, kind or status."
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setQuery('');
                setKind('all');
                setStatus('all');
              }}
            >
              Show all resources
            </Button>
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTableHead sortKey="name" sort={sort} onSortChange={setSort}>
                Resource
              </SortableTableHead>
              <SortableTableHead sortKey="kind" sort={sort} onSortChange={setSort}>
                Kind
              </SortableTableHead>
              <TableHead>Stages</TableHead>
              <TableHead>Owner</TableHead>
              <SortableTableHead sortKey="freshness" sort={sort} onSortChange={setSort}>
                Freshness
              </SortableTableHead>
              <TableHead>Status</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((resource) => {
              const href = safeExternalUrl(resource.url);
              return (
                <TableRow key={resource.id} className={cn(resource.status === 'retired' && 'opacity-70')}>
                  <TableCell className="max-w-sm min-w-56">
                    <div className="flex items-center gap-1.5 font-medium">
                      {href ? (
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer nofollow"
                          className="inline-flex items-center gap-1 underline decoration-border-strong underline-offset-4 hover:decoration-foreground"
                        >
                          {resource.name}
                          <ExternalLink aria-hidden className="size-3.5 text-muted-foreground" />
                          <span className="sr-only">(opens in a new tab)</span>
                        </a>
                      ) : (
                        resource.name
                      )}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[13px] text-muted-foreground">
                      {resource.description}
                    </p>
                    {resource.tags.length > 0 ? (
                      <ul aria-label="Tags" className="mt-1.5 flex flex-wrap gap-1">
                        {resource.tags.slice(0, 4).map((tag) => (
                          <li key={tag}>
                            <Badge variant="muted">{tag}</Badge>
                          </li>
                        ))}
                        {resource.tags.length > 4 ? (
                          <li>
                            <Badge variant="muted">+{resource.tags.length - 4} more</Badge>
                          </li>
                        ) : null}
                      </ul>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{RESOURCE_KIND_LABELS[resource.kind]}</TableCell>
                  <TableCell className="text-[13px] text-muted-foreground">
                    {resource.stages.length === 0
                      ? 'All stages'
                      : resource.stages.map((stage) => STAGE_LABELS[stage]).join(', ')}
                  </TableCell>
                  <TableCell className="text-[13px] text-muted-foreground">{resource.owner ?? '—'}</TableCell>
                  <TableCell>
                    <FreshnessIndicator freshnessAt={resource.freshnessAt} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge kind="resource" status={resource.status} withTitle />
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${resource.name}`}>
                          <Ellipsis aria-hidden />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onSelect={() => {
                            setEditing({ open: true, resource });
                          }}
                        >
                          <Pencil aria-hidden />
                          Edit…
                        </DropdownMenuItem>
                        {resource.status === 'stale' ? (
                          <DropdownMenuItem
                            onSelect={() => {
                              setResourceStatus(resource, 'active', `Marked “${resource.name}” as current`);
                            }}
                          >
                            <CircleCheck aria-hidden />
                            Mark as current
                          </DropdownMenuItem>
                        ) : null}
                        {resource.status === 'active' ? (
                          <DropdownMenuItem
                            onSelect={() => {
                              setResourceStatus(resource, 'stale', `Flagged “${resource.name}” as stale`);
                            }}
                          >
                            <FileClock aria-hidden />
                            Flag as stale
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuSeparator />
                        {resource.status === 'retired' ? (
                          <DropdownMenuItem
                            onSelect={() => {
                              setResourceStatus(resource, 'active', `Restored “${resource.name}”`);
                            }}
                          >
                            <RotateCcw aria-hidden />
                            Restore
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            destructive
                            onSelect={() => {
                              setRetiring(resource);
                            }}
                          >
                            <Archive aria-hidden />
                            Retire…
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        Freshness: reviewed within {REVIEW_SOON_DAYS} days is fresh; after {REVIEW_OVERDUE_DAYS} days a review
        is overdue. “Stale” is a manual flag that tells Foundry Guide to caveat the resource.
      </p>

      <ResourceFormSheet
        open={editing.open}
        resource={editing.resource}
        onOpenChange={(open) => {
          setEditing((prev) => ({ ...prev, open }));
        }}
      />

      <AlertDialog
        open={retiring !== null}
        onOpenChange={(open) => {
          if (!open) setRetiring(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retire “{retiring?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Foundry Guide stops recommending it immediately. It stays in this list under “Retired” and can
              be restored.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              destructive
              onClick={() => {
                if (retiring) setResourceStatus(retiring, 'retired', `Retired “${retiring.name}”`);
              }}
            >
              Retire resource
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageContainer>
  );
}
