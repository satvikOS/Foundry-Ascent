import { VentureStatus } from '@foundry/contracts';
import { Link } from '@tanstack/react-router';
import { Briefcase, Ellipsis, PencilLine, Plus, Search, SearchX, UserPlus, Users } from 'lucide-react';
import { useId, useMemo, useState } from 'react';

import { VentureMark } from '@/components/faces/user-avatar';
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
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
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
import { useProgramVentures, type ProgramVenture } from '@/lib/api/hooks/program';
import { useRequiredMe } from '@/lib/auth/use-me';
import { formatDate, pluralize } from '@/lib/format';
import { DOMAIN_LABELS, STAGE_LABELS, STAGE_ORDER } from '@/lib/labels';

import { CreateVentureDialog } from './create-venture-dialog';
import { InviteMemberDialog } from './invite-member-dialog';
import { RenameVentureDialog } from './rename-venture-dialog';

type SortKey = 'name' | 'stage' | 'members' | 'created';

function sortValue(row: ProgramVenture, key: SortKey): string | number {
  switch (key) {
    case 'name':
      return row.name;
    case 'stage':
      return STAGE_ORDER.indexOf(row.stage);
    case 'members':
      return row.memberCount;
    case 'created':
      return Date.parse(row.createdAt);
  }
}

/** Program → Ventures: enrolment metadata only (never venture content); enrol, rename and invite. */
export function ProgramVenturesPage() {
  const me = useRequiredMe();
  const ventures = useProgramVentures();
  const [query, setQuery] = useState('');
  const [stage, setStage] = useState<string>('all');
  const [sort, setSort] = useState<SortState<SortKey> | null>({ key: 'name', direction: 'asc' });
  const [createOpen, setCreateOpen] = useState(false);
  const [inviteFor, setInviteFor] = useState<{ id: string; name: string } | null>(null);
  const [renameFor, setRenameFor] = useState<{ id: string; name: string } | null>(null);
  const searchId = useId();

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = (ventures.data ?? []).filter(
      (row) =>
        (stage === 'all' || row.stage === stage) && (!needle || row.name.toLowerCase().includes(needle)),
    );
    return sortRows(filtered, sort, sortValue);
  }, [ventures.data, query, stage, sort]);

  const total = ventures.data?.length ?? 0;
  const filtering = query.trim() !== '' || stage !== 'all';

  return (
    <PageContainer size="wide">
      <PageHeader
        title="Ventures"
        description="Each venture’s content stays private to its team."
        actions={
          <Button
            onClick={() => {
              setCreateOpen(true);
            }}
          >
            <Plus aria-hidden />
            Enrol venture
          </Button>
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
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              placeholder="Search ventures"
              className="pl-8"
            />
          </div>
          <Select value={stage} onValueChange={setStage}>
            <SelectTrigger className="w-full sm:w-48" aria-label="Filter by stage">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All stages</SelectItem>
              {STAGE_ORDER.map((s) => (
                <SelectItem key={s} value={s}>
                  {STAGE_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[13px] text-muted-foreground sm:ml-auto" aria-live="polite">
            {ventures.isSuccess
              ? filtering
                ? `${rows.length} of ${pluralize(total, 'venture')}`
                : pluralize(total, 'venture')
              : null}
          </p>
        </div>
      </PageHeader>

      {ventures.isPending ? (
        <LoadingRegion label="Loading ventures">
          <Skeleton className="h-64 rounded-xl" />
        </LoadingRegion>
      ) : ventures.isError ? (
        <ErrorState
          error={ventures.error}
          onRetry={() => void ventures.refetch()}
          retrying={ventures.isRefetching}
        />
      ) : total === 0 ? (
        <EmptyState
          icon={Briefcase}
          title="No ventures enrolled yet"
          description="Enrol your first venture, then invite its founder with a one-time access code."
          action={
            <Button
              onClick={() => {
                setCreateOpen(true);
              }}
            >
              <Plus aria-hidden />
              Enrol venture
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title="No ventures match"
          description="Try a different search or stage."
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setQuery('');
                setStage('all');
              }}
            >
              Clear filters
            </Button>
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTableHead sortKey="name" sort={sort} onSortChange={setSort}>
                Venture
              </SortableTableHead>
              <SortableTableHead
                sortKey="stage"
                sort={sort}
                onSortChange={setSort}
                className="hidden sm:table-cell"
              >
                Stage
              </SortableTableHead>
              <TableHead className="hidden md:table-cell">Domain</TableHead>
              <SortableTableHead
                sortKey="members"
                sort={sort}
                onSortChange={setSort}
                align="right"
                className="hidden sm:table-cell"
              >
                Members
              </SortableTableHead>
              <TableHead className="hidden lg:table-cell">Status</TableHead>
              <SortableTableHead
                sortKey="created"
                sort={sort}
                onSortChange={setSort}
                className="hidden lg:table-cell"
              >
                Enrolled
              </SortableTableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const status = VentureStatus.safeParse(row.status);
              return (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">
                    <span className="flex items-center gap-2.5">
                      <VentureMark name={row.name} size="sm" />
                      <span className="grid">
                        {row.name}
                        {/* Phones: the stage sits under the name instead of in its own column. */}
                        <span className="text-caption font-normal text-muted-foreground sm:hidden">
                          {STAGE_LABELS[row.stage]}
                        </span>
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <StageChip stage={row.stage} />
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">
                    {DOMAIN_LABELS[row.domain] ?? row.domain}
                  </TableCell>
                  <TableCell className="tabular hidden text-right sm:table-cell">{row.memberCount}</TableCell>
                  <TableCell className="hidden lg:table-cell">
                    {status.success ? (
                      <StatusBadge kind="venture" status={status.data} />
                    ) : (
                      <span className="text-muted-foreground">{row.status}</span>
                    )}
                  </TableCell>
                  <TableCell className="tabular hidden whitespace-nowrap text-muted-foreground lg:table-cell">
                    <time dateTime={row.createdAt}>{formatDate(row.createdAt)}</time>
                  </TableCell>
                  <TableCell className="w-10 text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.name}`}>
                          <Ellipsis aria-hidden />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild>
                          <Link
                            to="/$tenant/app/v/$ventureId/team"
                            params={{ tenant: me.tenant.slug, ventureId: row.id }}
                          >
                            <Users aria-hidden />
                            Team
                          </Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => {
                            setInviteFor({ id: row.id, name: row.name });
                          }}
                        >
                          <UserPlus aria-hidden />
                          Invite a member…
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => {
                            setRenameFor({ id: row.id, name: row.name });
                          }}
                        >
                          <PencilLine aria-hidden />
                          Rename…
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <CreateVentureDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onInvite={(venture) => {
          setInviteFor(venture);
        }}
      />
      <InviteMemberDialog
        venture={inviteFor}
        onClose={() => {
          setInviteFor(null);
        }}
      />
      <RenameVentureDialog
        venture={renameFor}
        onClose={() => {
          setRenameFor(null);
        }}
      />
    </PageContainer>
  );
}
