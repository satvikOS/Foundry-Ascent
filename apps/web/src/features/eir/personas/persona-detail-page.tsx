import { Link } from '@tanstack/react-router';
import { ArrowLeft, CirclePause, CirclePlay } from 'lucide-react';
import { useState } from 'react';

import { PersonaAvatar } from '@/components/faces/persona-avatar';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePersona } from '@/lib/api/hooks/eir';
import { veirName } from '@/lib/veir';

import { ConsentTab } from './consent-tab';
import { DoctrineTab } from './doctrine-tab';
import { EmbodimentTab } from './embodiment-tab';
import { LessonsTab } from './lessons-tab';
import { LibraryTab } from './library-tab';
import { OverviewTab } from './overview-tab';
import { ResumePersonaDialog, SuspendPersonaDialog } from './persona-controls';
import { PERSONA_KIND_LABELS } from './persona-labels';
import { personaTabs, type PersonaTab } from './persona-tabs';
import { ReleasesTab } from './releases-tab';
import { TestBenchTab } from './test-bench-tab';

interface PersonaDetailPageProps {
  personaId: string;
  tenant: string;
  tab: PersonaTab;
  onTabChange: (tab: PersonaTab) => void;
  /** Lesson open in the Lessons tab. */
  lessonId: string | undefined;
  onLessonChange: (lessonId: string | undefined) => void;
  /** Program leads also see where the vEIR is assigned. */
  canSeeAssignments: boolean;
}

/**
 * EIR studio → one persona, in sections: overview, doctrine & style, knowledge library, lessons, releases,
 * the test bench (curators only), consent, and voice & face. Curators (program leads and the persona's own EIR)
 * edit; other studio roles read.
 */
export function PersonaDetailPage({
  personaId,
  tenant,
  tab,
  onTabChange,
  lessonId,
  onLessonChange,
  canSeeAssignments,
}: PersonaDetailPageProps) {
  const persona = usePersona(personaId);
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);

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

  if (persona.isPending) {
    return (
      <PageContainer>
        <PageHeader eyebrow={back} title="Persona" />
        <LoadingRegion label="Loading persona">
          <Skeleton className="h-96 rounded-xl" />
        </LoadingRegion>
      </PageContainer>
    );
  }
  if (persona.isError) {
    return (
      <PageContainer>
        <PageHeader eyebrow={back} title="Persona" />
        <ErrorState
          error={persona.error}
          onRetry={() => void persona.refetch()}
          retrying={persona.isRefetching}
        />
      </PageContainer>
    );
  }

  const p = persona.data;
  const displayName = veirName(p.name, p.kind, p.eirProfile?.displayName);
  const tabs = personaTabs(p);
  const current = tabs.some((t) => t.id === tab) ? tab : 'overview';
  const canCurate = p.canCurate === true;

  return (
    <PageContainer>
      <PageHeader
        eyebrow={back}
        title={
          <span className="flex items-center gap-3">
            <PersonaAvatar name={displayName} size="lg" decorative />
            {p.name}
          </span>
        }
        actions={
          canCurate && p.status === 'suspended' ? (
            <Button
              onClick={() => {
                setResumeOpen(true);
              }}
            >
              <CirclePlay aria-hidden />
              Resume
            </Button>
          ) : canCurate && p.status === 'active' ? (
            <Button
              variant="destructive-outline"
              onClick={() => {
                setSuspendOpen(true);
              }}
            >
              <CirclePause aria-hidden />
              Suspend
            </Button>
          ) : null
        }
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-small text-muted-foreground">
          <StatusBadge kind="persona" status={p.status} size="md" withTitle />
          <span>{p.eirProfile ? `Built from ${p.eirProfile.displayName}` : PERSONA_KIND_LABELS[p.kind]}</span>
        </div>
      </PageHeader>

      {p.status === 'suspended' ? (
        <Alert
          variant="warning"
          icon={CirclePause}
          title="Suspended: coaching is paused for every assigned venture"
          className="mb-6"
        >
          {p.suspendedReason ? `Reason: ${p.suspendedReason}` : null}
        </Alert>
      ) : null}

      <Tabs
        value={current}
        onValueChange={(next) => {
          const match = tabs.find((t) => t.id === next);
          if (match) onTabChange(match.id);
        }}
        className="gap-8"
      >
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <TabsList variant="underline" aria-label={`${p.name} sections`} className="min-w-max">
            {tabs.map((t) => (
              <TabsTrigger key={t.id} value={t.id}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="overview">
          <OverviewTab
            persona={p}
            tenant={tenant}
            canSeeAssignments={canSeeAssignments}
            onOpenTab={onTabChange}
          />
        </TabsContent>
        <TabsContent value="doctrine">
          <DoctrineTab
            persona={p}
            onOpenReleases={() => {
              onTabChange('releases');
            }}
          />
        </TabsContent>
        <TabsContent value="library">
          <LibraryTab persona={p} displayName={displayName} />
        </TabsContent>
        <TabsContent value="lessons">
          <LessonsTab
            persona={p}
            displayName={displayName}
            openLessonId={lessonId}
            onOpenLessonChange={onLessonChange}
          />
        </TabsContent>
        <TabsContent value="releases">
          <ReleasesTab persona={p} />
        </TabsContent>
        {canCurate ? (
          <TabsContent value="testbench">
            <TestBenchTab persona={p} displayName={displayName} />
          </TabsContent>
        ) : null}
        {p.kind === 'eir_persona' ? (
          <TabsContent value="consent">
            <ConsentTab persona={p} />
          </TabsContent>
        ) : null}
        <TabsContent value="embodiment">
          <EmbodimentTab
            persona={p}
            displayName={displayName}
            onOpenConsent={() => {
              onTabChange('consent');
            }}
          />
        </TabsContent>
      </Tabs>

      {canCurate ? (
        <>
          <SuspendPersonaDialog persona={p} open={suspendOpen} onOpenChange={setSuspendOpen} />
          <ResumePersonaDialog
            persona={p}
            open={resumeOpen}
            onOpenChange={setResumeOpen}
            onOpenConsent={
              p.kind === 'eir_persona'
                ? () => {
                    onTabChange('consent');
                  }
                : undefined
            }
          />
        </>
      ) : null}
    </PageContainer>
  );
}
