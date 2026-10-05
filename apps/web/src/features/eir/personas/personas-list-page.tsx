import { Link } from '@tanstack/react-router';
import { ChevronRight, FilePen, UserSquare } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { usePersonas } from '@/lib/api/hooks/eir';
import { formatNumber, pluralize } from '@/lib/format';

import { ConsentIndicator } from './consent-indicator';
import { PERSONA_KIND_LABELS } from './persona-labels';

/** EIR studio → Personas: every persona with status, active release, reach and consent. */
export function PersonasListPage({ tenant }: { tenant: string }) {
  const personas = usePersonas();

  return (
    <PageContainer size="wide">
      <PageHeader
        title="Personas"
        description="Foundry Guide and any EIR personas. Every release is versioned and approved by a person; suspending a persona stops it immediately."
      />
      {personas.isPending ? (
        <LoadingRegion label="Loading personas">
          <Skeleton className="h-56 rounded-xl" />
        </LoadingRegion>
      ) : personas.isError ? (
        <ErrorState
          error={personas.error}
          onRetry={() => void personas.refetch()}
          retrying={personas.isRefetching}
        />
      ) : personas.data.length === 0 ? (
        <EmptyState
          icon={UserSquare}
          title="No personas yet"
          description="Personas are created by the platform seed. Contact an admin if Foundry Guide is missing."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Persona</TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col">Active release</TableHead>
              <TableHead scope="col" className="text-right">
                Assigned ventures
              </TableHead>
              <TableHead scope="col">Consent</TableHead>
              <TableHead scope="col">
                <span className="sr-only">Open</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {personas.data.map((persona) => {
              const drafts = persona.releases.filter((r) => r.status === 'draft').length;
              return (
                <TableRow key={persona.id} className="relative">
                  <TableCell className="min-w-56">
                    <Link
                      to="/$tenant/app/eir/personas/$personaId"
                      params={{ tenant, personaId: persona.id }}
                      className="font-medium underline-offset-4 after:absolute after:inset-0 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      {persona.name}
                    </Link>
                    <p className="flex flex-wrap items-center gap-1.5 text-[13px] text-muted-foreground">
                      {PERSONA_KIND_LABELS[persona.kind]}
                      {persona.eirProfile ? (
                        <>
                          <span aria-hidden>·</span>
                          {persona.eirProfile.displayName}
                          {persona.eirProfile.synthetic ? <Badge variant="muted">Synthetic</Badge> : null}
                        </>
                      ) : null}
                    </p>
                  </TableCell>
                  <TableCell>
                    <div className="grid gap-1">
                      <StatusBadge kind="persona" status={persona.status} withTitle />
                      {persona.status === 'suspended' && persona.suspendedReason ? (
                        <span
                          className="line-clamp-1 max-w-56 text-xs text-muted-foreground"
                          title={persona.suspendedReason}
                        >
                          {persona.suspendedReason}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="grid gap-1">
                      <span className="text-sm">
                        {persona.activeRelease ? (
                          `v${persona.activeRelease.version}`
                        ) : (
                          <span className="text-muted-foreground">None</span>
                        )}
                      </span>
                      {drafts > 0 ? (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <FilePen aria-hidden className="size-3" />
                          {pluralize(drafts, 'draft')} awaiting approval
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {formatNumber(persona.assignedVentureCount)}
                  </TableCell>
                  <TableCell>
                    <ConsentIndicator persona={persona} />
                  </TableCell>
                  <TableCell className="w-8 text-right">
                    <ChevronRight aria-hidden className="ml-auto size-4 text-muted-foreground" />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </PageContainer>
  );
}
