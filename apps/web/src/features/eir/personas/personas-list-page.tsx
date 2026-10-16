import { Link } from '@tanstack/react-router';
import { ChevronRight, Plus, UserSquare } from 'lucide-react';

import { PersonaAvatar } from '@/components/faces/persona-avatar';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { usePersonas } from '@/lib/api/hooks/eir';
import { useEirProfiles } from '@/lib/api/hooks/veir-pools';
import { formatNumber, pluralize } from '@/lib/format';
import { shortPersonaName } from '@/lib/veir';

import { ConsentIndicator } from './consent-indicator';
import { eirsWithoutVeir } from './new-persona';
import { PERSONA_KIND_LABELS } from './persona-labels';
import { pendingDrafts } from './release-drafts';

/** EIR studio → Personas: every vEIR and the program guide, with status, release, reach and consent. */
export function PersonasListPage({ tenant, canCreate }: { tenant: string; canCreate: boolean }) {
  const personas = usePersonas();
  const profiles = useEirProfiles({ enabled: canCreate });
  // Offer New vEIR only when some EIR doesn't have one yet (one vEIR per EIR).
  const available =
    canCreate && profiles.data && personas.data ? eirsWithoutVeir(profiles.data, personas.data).length : 0;
  const newVeir =
    available > 0 ? (
      <Button asChild>
        <Link to="/$tenant/app/eir/personas/new" params={{ tenant }}>
          <Plus aria-hidden />
          New vEIR
        </Link>
      </Button>
    ) : null;

  return (
    <PageContainer>
      <PageHeader title="Personas" description="vEIRs and the program guide." actions={newVeir} />
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
          description={newVeir ? 'Create a vEIR to get started.' : undefined}
          action={newVeir}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Persona</TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col" className="hidden md:table-cell">
                Release
              </TableHead>
              <TableHead scope="col" className="hidden text-right md:table-cell">
                Ventures
              </TableHead>
              <TableHead scope="col" className="hidden lg:table-cell">
                Consent
              </TableHead>
              <TableHead scope="col">
                <span className="sr-only">Open</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {personas.data.map((persona) => {
              const drafts = pendingDrafts(persona).length;
              return (
                <TableRow key={persona.id} className="relative">
                  <TableCell className="min-w-48">
                    <div className="flex items-center gap-3">
                      <PersonaAvatar
                        name={shortPersonaName(persona.name, persona.kind, persona.eirProfile?.displayName)}
                        size="md"
                        decorative
                      />
                      <div className="min-w-0">
                        <Link
                          to="/$tenant/app/eir/personas/$personaId"
                          params={{ tenant, personaId: persona.id }}
                          className="font-medium underline-offset-4 after:absolute after:inset-0 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                        >
                          {persona.name}
                        </Link>
                        <p className="text-small text-muted-foreground">
                          {persona.eirProfile?.displayName ?? PERSONA_KIND_LABELS[persona.kind]}
                        </p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge kind="persona" status={persona.status} withTitle />
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <span className="grid gap-0.5 text-sm">
                      {persona.activeRelease ? (
                        `v${persona.activeRelease.version}`
                      ) : (
                        <span className="text-muted-foreground">None</span>
                      )}
                      {drafts > 0 ? (
                        <span className="text-caption text-muted-foreground">
                          {pluralize(drafts, 'draft')} to approve
                        </span>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell className="tabular hidden text-right md:table-cell">
                    {formatNumber(persona.assignedVentureCount)}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
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
