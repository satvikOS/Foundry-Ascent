import type { PersonaReleaseView, PersonaView } from '@foundry/contracts';
import { Link } from '@tanstack/react-router';
import {
  ArrowLeft,
  BadgeCheck,
  CirclePause,
  CirclePlay,
  FilePen,
  FilePlus2,
  History,
  UserSquare,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { announce } from '@/components/a11y/live-announcer';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { STATUS_DEFINITIONS, StatusBadge } from '@/components/ui/status-badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useCreatePersonaRelease, usePersona, usePersonaRelease } from '@/lib/api/hooks/eir';
import { formatDate, formatNumber } from '@/lib/format';

import { ConsentIndicator } from './consent-indicator';
import { ResumePersonaDialog, SuspendPersonaDialog } from './persona-controls';
import { PERSONA_KIND_LABELS } from './persona-labels';
import { ReleaseEditor } from './release-editor';
import { ApproveReleaseDialog, approvalBlocker, ReleaseHistory } from './release-history';
import { DoctrineView, ReleaseGuardrails, StyleView } from './release-view';

/** Doctrine / Style / Disclosure tabs for one release. */
function ReleaseTabs({ release }: { release: PersonaReleaseView }) {
  return (
    <Tabs defaultValue="doctrine">
      <TabsList variant="underline" aria-label={`Release v${release.version} sections`}>
        <TabsTrigger value="doctrine">Doctrine</TabsTrigger>
        <TabsTrigger value="style">Style</TabsTrigger>
        <TabsTrigger value="guardrails">Disclosure &amp; modes</TabsTrigger>
      </TabsList>
      <TabsContent value="doctrine" className="pt-2">
        <DoctrineView doctrine={release.doctrine} />
      </TabsContent>
      <TabsContent value="style" className="pt-2">
        <StyleView style={release.style} />
      </TabsContent>
      <TabsContent value="guardrails" className="pt-2">
        <ReleaseGuardrails release={release} />
      </TabsContent>
    </Tabs>
  );
}

/**
 * A release opened for review: the newest draft by default, or any earlier release picked in the history.
 * Its full content comes from `GET /persona-releases/:id` (drafts are visible to program leads, platform
 * admins and the persona's EIR), so a reviewer sees exactly what they approve, even after a reload.
 */
export function ReleaseReview({
  releaseId,
  blocker,
  onApprove,
  onClose,
}: {
  releaseId: string;
  blocker: string | null;
  onApprove: (release: PersonaReleaseView) => void;
  /** Present when the person opened this release themselves (it can be closed). */
  onClose?: () => void;
}) {
  const release = usePersonaRelease(releaseId);
  const close = onClose ? (
    <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close review">
      <X aria-hidden />
    </Button>
  ) : null;
  if (release.isPending) {
    return (
      <LoadingRegion label="Loading release">
        <Skeleton className="h-72 rounded-xl" />
      </LoadingRegion>
    );
  }
  if (release.isError) {
    return (
      <SectionCard title="Release" icon={FilePen} actions={close}>
        <ErrorState
          error={release.error}
          onRetry={() => void release.refetch()}
          retrying={release.isRefetching}
        />
      </SectionCard>
    );
  }
  const r = release.data;
  const draft = r.status === 'draft';
  return (
    <SectionCard
      title={
        draft
          ? `Draft v${String(r.version)} — ready for review`
          : `Release v${String(r.version)} · ${STATUS_DEFINITIONS.personaRelease[r.status].label}`
      }
      description={
        draft
          ? `Not live yet${r.createdBy ? ` · drafted by ${r.createdBy.displayName}` : ''}. Review it, then approve to make it the active release.`
          : r.approvedAt
            ? `Approved ${formatDate(r.approvedAt)}${r.approvedBy ? ` by ${r.approvedBy.displayName}` : ''}`
            : `Created ${formatDate(r.createdAt)}`
      }
      icon={draft ? FilePen : History}
      className={draft ? 'border-dashed border-border-strong' : undefined}
      actions={
        <>
          {draft ? (
            <Button
              size="sm"
              disabled={blocker !== null}
              onClick={() => {
                onApprove(r);
              }}
            >
              <BadgeCheck aria-hidden />
              Approve…
            </Button>
          ) : null}
          {close}
        </>
      }
    >
      <ReleaseTabs release={r} />
    </SectionCard>
  );
}

function PersonaOverview({ persona }: { persona: PersonaView }) {
  return (
    <SectionCard title="Overview" icon={UserSquare}>
      <dl className="grid gap-3 text-sm">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Status</dt>
          <dd>
            <StatusBadge kind="persona" status={persona.status} withTitle />
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Kind</dt>
          <dd>{PERSONA_KIND_LABELS[persona.kind]}</dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Assigned ventures</dt>
          <dd className="tabular font-medium">{formatNumber(persona.assignedVentureCount)}</dd>
        </div>
        {persona.eirProfile ? (
          <div className="grid gap-1.5">
            <dt className="text-muted-foreground">EIR profile</dt>
            <dd className="grid gap-1.5">
              <span className="flex flex-wrap items-center gap-1.5 font-medium">
                {persona.eirProfile.displayName}
                {persona.eirProfile.synthetic ? <Badge variant="muted">Synthetic</Badge> : null}
              </span>
              {persona.eirProfile.expertiseTags.length > 0 ? (
                <ul aria-label="Expertise" className="flex flex-wrap gap-1">
                  {persona.eirProfile.expertiseTags.map((tag) => (
                    <li key={tag}>
                      <Badge variant="secondary">{tag}</Badge>
                    </li>
                  ))}
                </ul>
              ) : null}
            </dd>
          </div>
        ) : null}
        <div className="grid gap-1">
          <dt className="text-muted-foreground">Consent</dt>
          <dd>
            <ConsentIndicator persona={persona} showDescription />
          </dd>
        </div>
      </dl>
    </SectionCard>
  );
}

/** EIR studio → Persona: active doctrine/style, release history, new release, suspend/resume. */
export function PersonaDetailPage({ personaId, tenant }: { personaId: string; tenant: string }) {
  const persona = usePersona(personaId);
  const create = useCreatePersonaRelease(personaId);
  const [editing, setEditing] = useState(false);
  /** A release the person opened from the history (otherwise the newest draft is reviewed). */
  const [pickedReleaseId, setPickedReleaseId] = useState<string | null>(null);
  const [approvingDraft, setApprovingDraft] = useState<PersonaReleaseView | null>(null);
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
      <PageContainer size="wide">
        <PageHeader eyebrow={back} title="Persona" />
        <LoadingRegion label="Loading persona">
          <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
            <Skeleton className="h-96 rounded-xl" />
            <Skeleton className="h-64 rounded-xl" />
          </div>
        </LoadingRegion>
      </PageContainer>
    );
  }
  if (persona.isError) {
    return (
      <PageContainer size="wide">
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
  const nextVersion = Math.max(0, ...p.releases.map((r) => r.version)) + 1;
  const newestDraft =
    [...p.releases].filter((r) => r.status === 'draft').sort((a, b) => b.version - a.version)[0] ?? null;
  const picked =
    pickedReleaseId !== null &&
    pickedReleaseId !== p.activeRelease?.id &&
    p.releases.some((r) => r.id === pickedReleaseId)
      ? pickedReleaseId
      : null;
  const reviewId = picked ?? newestDraft?.id ?? null;
  const blocker = approvalBlocker(p);

  return (
    <PageContainer size="wide">
      <PageHeader
        eyebrow={back}
        title={p.name}
        actions={
          editing ? null : (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setEditing(true);
                }}
              >
                <FilePlus2 aria-hidden />
                New release
              </Button>
              {p.status === 'suspended' ? (
                <Button
                  onClick={() => {
                    setResumeOpen(true);
                  }}
                >
                  <CirclePlay aria-hidden />
                  Resume
                </Button>
              ) : p.status === 'active' ? (
                <Button
                  variant="destructive-outline"
                  onClick={() => {
                    setSuspendOpen(true);
                  }}
                >
                  <CirclePause aria-hidden />
                  Suspend
                </Button>
              ) : null}
            </>
          )
        }
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-muted-foreground">
          <StatusBadge kind="persona" status={p.status} size="md" withTitle />
          <span>{PERSONA_KIND_LABELS[p.kind]}</span>
          {p.eirProfile ? <span>{p.eirProfile.displayName}</span> : null}
          <span>{p.activeRelease ? `Release v${p.activeRelease.version} active` : 'No active release'}</span>
        </div>
      </PageHeader>

      <div className="grid gap-6">
        {p.status === 'suspended' ? (
          <Alert
            variant="warning"
            icon={CirclePause}
            title="Suspended — coaching is blocked for every assigned venture"
            action={
              <Button
                size="sm"
                onClick={() => {
                  setResumeOpen(true);
                }}
              >
                Resume
              </Button>
            }
          >
            {p.suspendedReason ? <>Reason: {p.suspendedReason}</> : 'No reason was recorded.'}
          </Alert>
        ) : null}
        {blocker ? (
          <Alert variant="info" title="Consent needed before release">
            {blocker} Drafts can still be written and reviewed.
          </Alert>
        ) : null}

        {editing ? (
          <ReleaseEditor
            personaName={p.name}
            nextVersion={nextVersion}
            base={p.activeRelease}
            pending={create.isPending}
            error={create.error}
            onCancel={() => {
              setEditing(false);
              create.reset();
            }}
            onSubmit={(input) => {
              create.mutate(input, {
                onSuccess: (release) => {
                  setPickedReleaseId(release.id);
                  setEditing(false);
                  toast.success(`Draft v${release.version} created`);
                  announce('Draft release created');
                },
              });
            }}
          />
        ) : (
          <div className="grid items-start gap-6 lg:grid-cols-[1fr_20rem]">
            <div className="grid gap-6">
              {reviewId ? (
                <ReleaseReview
                  key={reviewId}
                  releaseId={reviewId}
                  blocker={blocker}
                  onApprove={setApprovingDraft}
                  onClose={
                    picked !== null && picked !== newestDraft?.id
                      ? () => {
                          setPickedReleaseId(null);
                        }
                      : undefined
                  }
                />
              ) : null}

              {p.activeRelease ? (
                <SectionCard
                  title={`Active release · v${p.activeRelease.version}`}
                  description={
                    p.activeRelease.approvedAt
                      ? `Approved ${formatDate(p.activeRelease.approvedAt)}${
                          p.activeRelease.approvedBy ? ` by ${p.activeRelease.approvedBy.displayName}` : ''
                        }`
                      : 'Approved'
                  }
                  icon={BadgeCheck}
                >
                  <ReleaseTabs release={p.activeRelease} />
                </SectionCard>
              ) : (
                <SectionCard title="No active release" icon={FilePlus2}>
                  <p className="text-sm text-muted-foreground">
                    This persona can’t coach until a release is approved. Create a release to define its
                    doctrine and style.
                  </p>
                </SectionCard>
              )}
            </div>
            <div className="grid gap-6">
              <PersonaOverview persona={p} />
              <ReleaseHistory persona={p} reviewingId={reviewId} onReview={setPickedReleaseId} />
            </div>
          </div>
        )}
      </div>

      <SuspendPersonaDialog persona={p} open={suspendOpen} onOpenChange={setSuspendOpen} />
      <ResumePersonaDialog persona={p} open={resumeOpen} onOpenChange={setResumeOpen} />
      <ApproveReleaseDialog
        persona={p}
        release={approvingDraft}
        onClose={() => {
          setApprovingDraft(null);
        }}
        onApproved={() => {
          setPickedReleaseId(null);
        }}
      />
    </PageContainer>
  );
}
