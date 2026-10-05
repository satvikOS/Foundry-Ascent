import type { PersonaView } from '@foundry/contracts';
import { BadgeCheck, Eye, History } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { announce } from '@/components/a11y/live-announcer';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusBadge } from '@/components/ui/status-badge';
import { MutationErrorAlert } from '@/features/admin/shared/form';
import { useApprovePersonaRelease } from '@/lib/api/hooks/eir';
import { formatDate, pluralize } from '@/lib/format';

import { consentState } from './persona-labels';

type ReleaseSummary = PersonaView['releases'][number];

/** Why a release can't be approved right now (null = it can). */
export function approvalBlocker(persona: Pick<PersonaView, 'kind' | 'hasConsent'>): string | null {
  return consentState(persona) === 'missing'
    ? 'An EIR persona needs a consent record on file before any release can be approved.'
    : null;
}

interface ApproveReleaseDialogProps {
  persona: PersonaView;
  release: Pick<ReleaseSummary, 'id' | 'version'> | null;
  onClose: () => void;
  onApproved?: () => void;
}

/** Confirmation for approving a draft: spells out that it goes live for every assigned venture. */
export function ApproveReleaseDialog({ persona, release, onClose, onApproved }: ApproveReleaseDialogProps) {
  const approve = useApprovePersonaRelease();
  const current = persona.activeRelease;
  return (
    <AlertDialog
      open={release !== null}
      onOpenChange={(open) => {
        if (!open && !approve.isPending) {
          approve.reset();
          onClose();
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Approve v{release?.version} of {persona.name}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            It becomes the active release immediately:{' '}
            {pluralize(persona.assignedVentureCount, 'assigned venture')}{' '}
            {persona.assignedVentureCount === 1 ? 'uses' : 'use'} its doctrine, style and disclosure from the
            next message.
            {current ? ` v${current.version} is superseded and kept in the history.` : ''}
            {persona.status === 'suspended' ? ' The persona stays suspended until you resume it.' : ''}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <MutationErrorAlert error={approve.error} title="The release wasn’t approved" />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={approve.isPending}>Cancel</AlertDialogCancel>
          <Button
            loading={approve.isPending}
            loadingText="Approving…"
            onClick={() => {
              if (!release) return;
              approve.mutate(release.id, {
                onSuccess: () => {
                  toast.success(`v${release.version} approved and active`);
                  announce('Release approved');
                  onApproved?.();
                  onClose();
                },
              });
            }}
          >
            <BadgeCheck aria-hidden />
            Approve release
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Release history: every version with its status. Any release other than the active one can be opened for
 * review (full content from `GET /persona-releases/:id`); drafts can be approved from here.
 */
export function ReleaseHistory({
  persona,
  reviewingId = null,
  onReview,
}: {
  persona: PersonaView;
  /** The release currently open in the review panel, if any. */
  reviewingId?: string | null;
  onReview?: (releaseId: string) => void;
}) {
  const [approving, setApproving] = useState<ReleaseSummary | null>(null);
  const blocker = approvalBlocker(persona);
  const releases = [...persona.releases].sort((a, b) => b.version - a.version);

  return (
    <SectionCard
      title="Release history"
      description={pluralize(releases.length, 'release')}
      icon={History}
      flush
    >
      {releases.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">No releases yet. Create the first one.</p>
      ) : (
        <ol className="divide-y divide-border">
          {releases.map((release) => {
            const active = persona.activeRelease?.id === release.id;
            return (
              <li key={release.id} className="flex flex-col gap-2 px-5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">v{release.version}</span>
                  <StatusBadge kind="personaRelease" status={release.status} withTitle />
                  {active ? <Badge variant="outline">Active</Badge> : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  Created {formatDate(release.createdAt)}
                  {release.approvedAt ? ` · approved ${formatDate(release.approvedAt)}` : ''}
                </p>
                {onReview && !active ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="w-fit"
                    aria-pressed={reviewingId === release.id}
                    onClick={() => {
                      onReview(release.id);
                    }}
                  >
                    <Eye aria-hidden />
                    {reviewingId === release.id
                      ? `Reviewing v${release.version}`
                      : `Review v${release.version}`}
                  </Button>
                ) : null}
                {release.status === 'draft' ? (
                  <div className="grid gap-1.5">
                    <Button
                      size="sm"
                      variant="secondary"
                      className="w-fit"
                      disabled={blocker !== null}
                      aria-describedby={blocker ? `blocker-${release.id}` : undefined}
                      onClick={() => {
                        setApproving(release);
                      }}
                    >
                      <BadgeCheck aria-hidden />
                      Approve v{release.version}…
                    </Button>
                    {blocker ? (
                      <p id={`blocker-${release.id}`} className="text-xs text-muted-foreground">
                        {blocker}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
      <ApproveReleaseDialog
        persona={persona}
        release={approving}
        onClose={() => {
          setApproving(null);
        }}
      />
    </SectionCard>
  );
}
