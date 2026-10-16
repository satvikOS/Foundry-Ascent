import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, UserSquare } from 'lucide-react';
import { useState } from 'react';

import { announce } from '@/components/a11y/live-announcer';
import { PersonaAvatar } from '@/components/faces/persona-avatar';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { SelectField } from '@/components/ui/select-field';
import { usePersonas } from '@/lib/api/hooks/eir';
import { useCreateEirPersona, useEirProfiles } from '@/lib/api/hooks/veir-pools';

import {
  defaultVeirName,
  eirsWithoutVeir,
  serverNameProblem,
  veirDisclosure,
  veirNameProblem,
} from './new-persona';
import { ReleaseEditor } from './release-editor';

/**
 * EIR studio → New vEIR (program lead): choose the EIR it is built from and its name, then write its first
 * doctrine and style. It starts as a draft; it coaches once the EIR's consent is recorded and v1 approved.
 */
export function NewPersonaPage({ tenant }: { tenant: string }) {
  const navigate = useNavigate();
  const profiles = useEirProfiles();
  const personas = usePersonas();
  const create = useCreateEirPersona();
  const [eirId, setEirId] = useState('');
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | undefined>();
  const [step, setStep] = useState<'who' | 'doctrine'>('who');

  const back = (
    <Link
      to="/$tenant/app/eir/personas"
      params={{ tenant }}
      className="inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
    >
      <ArrowLeft aria-hidden className="size-3.5" />
      Personas
    </Link>
  );

  if (profiles.isPending || personas.isPending) {
    return (
      <PageContainer size="narrow">
        <PageHeader eyebrow={back} title="New vEIR" />
        <LoadingRegion label="Loading EIRs">
          <Skeleton className="h-48 rounded-xl" />
        </LoadingRegion>
      </PageContainer>
    );
  }
  if (profiles.isError || personas.isError) {
    return (
      <PageContainer size="narrow">
        <PageHeader eyebrow={back} title="New vEIR" />
        <ErrorState
          error={profiles.error ?? personas.error}
          onRetry={() => {
            void profiles.refetch();
            void personas.refetch();
          }}
        />
      </PageContainer>
    );
  }

  const available = eirsWithoutVeir(profiles.data, personas.data);
  const eir = available.find((p) => p.id === eirId) ?? null;
  const trimmed = name.trim();

  const continueToDoctrine = () => {
    if (!eir) return;
    const problem = veirNameProblem(trimmed, eir.displayName, personas.data);
    setNameError(problem ?? undefined);
    if (problem === null) setStep('doctrine');
  };

  return (
    <PageContainer size={step === 'who' ? 'narrow' : 'default'}>
      <PageHeader eyebrow={back} title={step === 'who' ? 'New vEIR' : trimmed} />
      {available.length === 0 ? (
        <EmptyState
          icon={UserSquare}
          title="Every EIR already has a vEIR"
          description="Each EIR has one vEIR."
        />
      ) : step === 'who' ? (
        <SectionCard title="Who it’s built from">
          <form
            noValidate
            className="grid gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              continueToDoctrine();
            }}
          >
            <SelectField
              label="EIR"
              value={eirId}
              placeholder="Choose an EIR"
              onChange={(next) => {
                const picked = available.find((p) => p.id === next);
                // Suggest the standard name until someone types their own.
                if (picked && (name === '' || name === defaultVeirName(eir?.displayName ?? ''))) {
                  setName(defaultVeirName(picked.displayName));
                }
                setEirId(next);
              }}
              options={available.map((p) => ({ value: p.id, label: p.displayName }))}
              description="Their consent is recorded next; the vEIR can’t coach without it."
            />
            <Field label="Name" error={nameError} description="Founders see it in chat and on calls.">
              <Input
                autoComplete="off"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            </Field>
            {eir && trimmed ? (
              <p className="flex items-center gap-2 text-small text-muted-foreground">
                <PersonaAvatar name={eir.displayName.split(/\s+/)[0] ?? trimmed} size="sm" decorative />
                {trimmed} · vEIR · AI
              </p>
            ) : null}
            <div className="flex justify-end">
              <Button type="submit" disabled={!eir || trimmed === ''}>
                Continue
              </Button>
            </div>
          </form>
        </SectionCard>
      ) : eir ? (
        <ReleaseEditor
          title="Doctrine & style"
          description={`Saved as draft v1. ${trimmed} coaches once ${eir.displayName}’s consent is recorded and v1 is approved.`}
          submitLabel="Create vEIR"
          submittingLabel="Creating…"
          base={null}
          defaultDisclosure={veirDisclosure(trimmed, eir.displayName)}
          pending={create.isPending}
          error={create.error}
          onCancel={() => {
            create.reset();
            setStep('who');
          }}
          onSubmit={(release) => {
            create.mutate(
              {
                eirProfileId: eir.id,
                name: trimmed,
                doctrine: release.doctrine,
                style: release.style,
                disclosureText: release.disclosureText,
                allowedModes: release.allowedModes,
              },
              {
                onError: (error) => {
                  // The API refused the name (it would read as the EIR, or it is taken): back to the name,
                  // with the reason under it.
                  const problem = serverNameProblem(error);
                  if (problem === null) return;
                  create.reset();
                  setNameError(problem);
                  setStep('who');
                },
                onSuccess: (persona) => {
                  toast.success(`${persona.name} created as a draft`);
                  announce(`${persona.name} created. Record consent next.`);
                  void navigate({
                    to: '/$tenant/app/eir/personas/$personaId',
                    params: { tenant, personaId: persona.id },
                    search: { tab: 'consent' },
                  });
                },
              },
            );
          }}
        />
      ) : null}
    </PageContainer>
  );
}
