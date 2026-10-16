import { Link } from '@tanstack/react-router';
import { Waypoints } from 'lucide-react';
import { useState } from 'react';

import { PersonaAvatar } from '@/components/faces/persona-avatar';
import { VentureMark } from '@/components/faces/user-avatar';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { usePersonas } from '@/lib/api/hooks/eir';
import { type ProgramVenture, useProgramVentures } from '@/lib/api/hooks/program';
import { useEirProfiles } from '@/lib/api/hooks/veir-pools';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { shortPersonaName } from '@/lib/veir';

import { AssignDialog } from './assign-dialog';
import { countByPersona } from './assignment';

type Filter = { kind: 'all' } | { kind: 'persona'; personaId: string | null };

/** Program → vEIRs & assignments: who coaches each venture, who reviews it, and changing either. */
export function AssignmentsPage({ tenant }: { tenant: string }) {
  const ventures = useProgramVentures();
  const personas = usePersonas();
  const eirProfiles = useEirProfiles();
  const [filter, setFilter] = useState<Filter>({ kind: 'all' });
  const [changing, setChanging] = useState<ProgramVenture | null>(null);

  const loading = ventures.isPending || personas.isPending;
  const error = ventures.error ?? personas.error;

  return (
    <PageContainer>
      <PageHeader title="vEIRs & assignments" description="Who coaches each venture, and who reviews it." />
      {loading ? (
        <LoadingRegion label="Loading assignments">
          <Skeleton className="h-64 rounded-xl" />
        </LoadingRegion>
      ) : error || !ventures.data || !personas.data ? (
        <ErrorState
          error={error}
          onRetry={() => {
            void ventures.refetch();
            void personas.refetch();
          }}
        />
      ) : ventures.data.length === 0 ? (
        <EmptyState
          icon={Waypoints}
          title="No ventures yet"
          description="Enrol a venture in Ventures, then choose its vEIR here."
        />
      ) : (
        <AssignmentsTable
          tenant={tenant}
          rows={ventures.data}
          personas={personas.data}
          filter={filter}
          onFilterChange={setFilter}
          onChange={setChanging}
        />
      )}
      <AssignDialog
        venture={changing}
        personas={personas.data ?? []}
        eirProfiles={eirProfiles.data ?? []}
        onClose={() => {
          setChanging(null);
        }}
      />
    </PageContainer>
  );
}

function AssignmentsTable({
  tenant,
  rows,
  personas,
  filter,
  onFilterChange,
  onChange,
}: {
  tenant: string;
  rows: readonly ProgramVenture[];
  personas: NonNullable<ReturnType<typeof usePersonas>['data']>;
  filter: Filter;
  onFilterChange: (filter: Filter) => void;
  onChange: (venture: ProgramVenture) => void;
}) {
  const counts = countByPersona(rows);
  const chips: { key: string; label: string; count: number; filter: Filter }[] = [
    { key: 'all', label: 'All', count: rows.length, filter: { kind: 'all' } },
    ...personas
      .filter((p) => counts.has(p.id))
      .map((p) => ({
        key: p.id,
        label: p.name,
        count: counts.get(p.id) ?? 0,
        filter: { kind: 'persona', personaId: p.id } as const,
      })),
    ...(counts.has(null)
      ? [
          {
            key: 'none',
            label: 'Unassigned',
            count: counts.get(null) ?? 0,
            filter: { kind: 'persona', personaId: null } as const,
          },
        ]
      : []),
  ];
  const shown = filter.kind === 'all' ? rows : rows.filter((r) => r.personaId === filter.personaId);
  const personaById = new Map(personas.map((p) => [p.id, p]));

  return (
    <div className="grid gap-4">
      {chips.length > 2 ? (
        <div role="group" aria-label="Filter by vEIR" className="flex flex-wrap gap-1.5">
          {chips.map((chip) => {
            const selected =
              chip.filter.kind === filter.kind &&
              (chip.filter.kind === 'all' ||
                (filter.kind === 'persona' && chip.filter.personaId === filter.personaId));
            return (
              <button
                key={chip.key}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  onFilterChange(chip.filter);
                }}
                className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-small transition-colors',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                  selected
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border text-muted-foreground hover:border-border-strong hover:text-foreground',
                )}
              >
                {chip.label}
                <span className="tabular text-caption opacity-70">{chip.count}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Venture</TableHead>
            <TableHead scope="col" className="hidden sm:table-cell">
              vEIR
            </TableHead>
            <TableHead scope="col" className="hidden md:table-cell">
              Reviewed by
            </TableHead>
            <TableHead scope="col" className="hidden lg:table-cell">
              Since
            </TableHead>
            <TableHead scope="col">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((row) => {
            const persona = row.personaId ? personaById.get(row.personaId) : undefined;
            return (
              <TableRow key={row.id}>
                <TableCell className="font-medium">
                  <span className="flex items-center gap-2.5">
                    <VentureMark name={row.name} size="sm" />
                    <span className="grid">
                      {row.name}
                      {/* Phones: the vEIR sits under the venture instead of in its own column. */}
                      <span className="text-caption font-normal text-muted-foreground sm:hidden">
                        {row.personaName ?? 'Not assigned'}
                      </span>
                    </span>
                  </span>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  {persona ? (
                    <span className="flex items-center gap-2">
                      <PersonaAvatar
                        name={shortPersonaName(persona.name, persona.kind, persona.eirProfile?.displayName)}
                        size="xs"
                        decorative
                      />
                      <Link
                        to="/$tenant/app/eir/personas/$personaId"
                        params={{ tenant, personaId: persona.id }}
                        className="underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        {persona.name}
                      </Link>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">{row.personaName ?? 'Not assigned'}</span>
                  )}
                </TableCell>
                <TableCell className="hidden text-muted-foreground md:table-cell">
                  {row.reviewingEir?.displayName ?? 'Nobody'}
                </TableCell>
                <TableCell className="tabular hidden whitespace-nowrap text-muted-foreground lg:table-cell">
                  {row.assignedAt ? <time dateTime={row.assignedAt}>{formatDate(row.assignedAt)}</time> : '—'}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Change the vEIR of ${row.name}`}
                    onClick={() => {
                      onChange(row);
                    }}
                  >
                    Change
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
