import { Link } from '@tanstack/react-router';
import { FileCheck, FileX, IdCard, Pencil, Plus, UserPlus } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { usePersonas } from '@/lib/api/hooks/eir';
import { useEirProfiles, type EirProfile } from '@/lib/api/hooks/veir-pools';

import { CONSENT_FIRST, eirVeirState } from './eir-veir';
import { EirProfileDialog } from './eir-profile-dialog';

const STATUS_LABEL: Record<EirProfile['status'], string | null> = {
  active: null,
  unavailable: 'Unavailable',
  retired: 'Retired',
};

const LINK =
  'font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring';

/** Where the EIR stands with their vEIR, and the next step a program lead can take. */
function VeirCell({
  tenant,
  profile,
  state,
  canCreateVeir,
}: {
  tenant: string;
  profile: EirProfile;
  state: ReturnType<typeof eirVeirState>;
  canCreateVeir: boolean;
}) {
  if (state.kind === 'no_veir') {
    return (
      <div className="grid gap-0.5">
        <span className="text-small text-muted-foreground">No vEIR yet</span>
        <span className="flex items-center gap-1 text-caption text-muted-foreground">
          <FileX aria-hidden className="size-3.5 text-warning" />
          {CONSENT_FIRST}
        </span>
        {canCreateVeir && profile.status === 'active' ? (
          <Link
            to="/$tenant/app/eir/personas/new"
            params={{ tenant }}
            search={{ eir: profile.id }}
            aria-label={`New vEIR for ${profile.displayName}`}
            className={`${LINK} mt-1 inline-flex w-fit items-center gap-1 text-small`}
          >
            <Plus aria-hidden className="size-3.5" />
            New vEIR
          </Link>
        ) : null}
      </div>
    );
  }
  const consent = state.kind === 'consent_on_file';
  return (
    <div className="grid gap-0.5">
      <Link
        to="/$tenant/app/eir/personas/$personaId"
        params={{ tenant, personaId: state.persona.id }}
        search={consent ? {} : { tab: 'consent' }}
        className={`${LINK} w-fit text-small`}
      >
        {state.persona.name}
      </Link>
      <span className="flex items-center gap-1 text-caption text-muted-foreground">
        {consent ? (
          <FileCheck aria-hidden className="size-3.5 text-foreground" />
        ) : (
          <FileX aria-hidden className="size-3.5 text-warning" />
        )}
        {consent ? 'Consent on file' : CONSENT_FIRST}
      </span>
    </div>
  );
}

/**
 * EIR studio → EIRs (program leads and platform admins): the real people vEIRs are built from. Add one by
 * linking a person who has the EIR role, edit their name, title, expertise and bio, and see where each stands
 * with their vEIR. Adding an EIR records no consent: a vEIR is released only once its EIR has recorded it.
 */
export function EirsPage({ tenant, canCreateVeir }: { tenant: string; canCreateVeir: boolean }) {
  const profiles = useEirProfiles();
  const personas = usePersonas();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<EirProfile | null>(null);

  const addButton = (
    <Button
      onClick={() => {
        setAdding(true);
      }}
    >
      <UserPlus aria-hidden />
      Add EIR
    </Button>
  );
  const error = profiles.error ?? personas.error;
  const list = profiles.data;
  const veirs = personas.data;

  return (
    <PageContainer>
      <PageHeader title="EIRs" description="The people vEIRs are built from." actions={addButton} />
      {error ? (
        <ErrorState
          error={error}
          onRetry={() => {
            void profiles.refetch();
            void personas.refetch();
          }}
          retrying={profiles.isRefetching || personas.isRefetching}
        />
      ) : !list || !veirs ? (
        <LoadingRegion label="Loading EIRs">
          <Skeleton className="h-56 rounded-xl" />
        </LoadingRegion>
      ) : list.length === 0 ? (
        <EmptyState
          icon={IdCard}
          title="No EIRs yet"
          description="Add the people your vEIRs will be built from."
          action={addButton}
        />
      ) : (
        <Table aria-label="EIRs">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">EIR</TableHead>
              <TableHead scope="col" className="hidden md:table-cell">
                Expertise
              </TableHead>
              <TableHead scope="col">vEIR</TableHead>
              <TableHead scope="col">
                <span className="sr-only">Edit</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((profile) => {
              const status = STATUS_LABEL[profile.status];
              return (
                <TableRow key={profile.id}>
                  <TableCell className="min-w-44 align-top">
                    <div className="grid gap-0.5">
                      <span className="flex flex-wrap items-center gap-2 font-medium">
                        {profile.displayName}
                        {status ? <Badge variant="muted">{status}</Badge> : null}
                      </span>
                      {profile.title ? (
                        <span className="text-small text-muted-foreground">{profile.title}</span>
                      ) : null}
                      {profile.principal && profile.principal.displayName !== profile.displayName ? (
                        <span className="text-caption text-subtle-foreground">
                          Signs in as {profile.principal.displayName}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="hidden align-top md:table-cell">
                    {profile.expertiseTags.length > 0 ? (
                      <ul aria-label={`${profile.displayName}’s expertise`} className="flex flex-wrap gap-1">
                        {profile.expertiseTags.map((tag) => (
                          <li key={tag}>
                            <Badge variant="secondary">{tag.replace(/-/g, ' ')}</Badge>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="text-small text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    <VeirCell
                      tenant={tenant}
                      profile={profile}
                      state={eirVeirState(profile.id, veirs)}
                      canCreateVeir={canCreateVeir}
                    />
                  </TableCell>
                  <TableCell className="w-10 text-right align-top">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Edit ${profile.displayName}`}
                      onClick={() => {
                        setEditing(profile);
                      }}
                    >
                      <Pencil aria-hidden />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      <EirProfileDialog key="add" open={adding} onOpenChange={setAdding} />
      {editing ? (
        <EirProfileDialog
          key={editing.id}
          open
          profile={editing}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
        />
      ) : null}
    </PageContainer>
  );
}
