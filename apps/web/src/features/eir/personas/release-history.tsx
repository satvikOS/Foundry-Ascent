import type { PersonaView } from '@foundry/contracts';
import { Ban, BadgeCheck, Eye } from 'lucide-react';

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
import { toast } from '@/components/ui/toast';
import { MutationErrorAlert } from '@/features/admin/shared/form';
import { useApprovePersonaRelease, useWithdrawPersonaRelease } from '@/lib/api/hooks/eir';
import { formatDate, pluralize } from '@/lib/format';

import { CONSENT_NEEDED, consentState } from './persona-labels';
import { canOpenRelease, isOutdatedDraft } from './release-drafts';

type ReleaseSummary = PersonaView['releases'][number];

/** Why a release can't be approved right now (null = it can). */
export function approvalBlocker(persona: Pick<PersonaView, 'kind' | 'hasConsent'>): string | null {
  return consentState(persona) === 'missing' ? CONSENT_NEEDED : null;
}

interface ApproveReleaseDialogProps {
  persona: PersonaView;
  release: Pick<ReleaseSummary, 'id' | 'version'> | null;
  onClose: () => void;
  onApproved?: () => void;
}

/** Confirmation for approving a draft: it goes live for every assigned venture. */
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
            It becomes the active release now: {pluralize(persona.assignedVentureCount, 'venture')}{' '}
            {persona.assignedVentureCount === 1 ? 'uses' : 'use'} it from the next message.
            {current ? ` v${current.version} stays in the history.` : ''}
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
                  toast.success(`v${release.version} is now active`);
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
 * Confirmation for withdrawing a superseded release (e.g. a doctrine error found after the fact): the
 * conversations still on it move to the active release at their next message.
 */
export function WithdrawReleaseDialog({
  persona,
  release,
  onClose,
}: {
  persona: Pick<PersonaView, 'name' | 'activeRelease'>;
  release: Pick<ReleaseSummary, 'id' | 'version'> | null;
  onClose: () => void;
}) {
  const withdraw = useWithdrawPersonaRelease();
  const active = persona.activeRelease;
  return (
    <AlertDialog
      open={release !== null}
      onOpenChange={(open) => {
        if (!open && !withdraw.isPending) {
          withdraw.reset();
          onClose();
        }
      }}
    >
      <AlertDialogContent className="border-destructive/50">
        <AlertDialogHeader>
          <AlertDialogTitle>
            Withdraw v{release?.version} of {persona.name}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {active
              ? `Conversations still on v${String(release?.version ?? '')} move to the active v${String(active.version)} at their next message.`
              : `Conversations still on v${String(release?.version ?? '')} stop using it at their next message.`}{' '}
            It stays in the history as withdrawn and can’t be used again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <MutationErrorAlert error={withdraw.error} title="The release wasn’t withdrawn" />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={withdraw.isPending}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            loading={withdraw.isPending}
            loadingText="Withdrawing…"
            onClick={() => {
              if (!release) return;
              withdraw.mutate(release.id, {
                onSuccess: () => {
                  toast.success(`v${release.version} withdrawn`);
                  announce('Release withdrawn');
                  onClose();
                },
              });
            }}
          >
            <Ban aria-hidden />
            Withdraw release
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Every version of the persona with its status. Any release other than the active one that the viewer may
 * open (drafts and withdrawn releases: curators only) can be opened for review; drafts newer than the
 * active release are approved from the review panel.
 */
export function ReleaseHistory({
  persona,
  reviewingId,
  onReview,
}: {
  persona: PersonaView;
  /** The release open in the review panel, if any. */
  reviewingId: string | null;
  onReview: (releaseId: string) => void;
}) {
  const releases = [...persona.releases].sort((a, b) => b.version - a.version);
  return (
    <SectionCard title="History" description={pluralize(releases.length, 'release')}>
      {releases.length === 0 ? (
        <p className="text-small text-muted-foreground">No releases yet.</p>
      ) : (
        <ol aria-label="Releases" className="divide-y divide-border">
          {releases.map((release) => {
            const active = persona.activeRelease?.id === release.id;
            const outdated = isOutdatedDraft(persona, release);
            const reviewing = reviewingId === release.id;
            return (
              <li key={release.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-3 first:pt-0">
                <span className="tabular w-8 text-small font-semibold">v{release.version}</span>
                <StatusBadge kind="personaRelease" status={release.status} withTitle />
                {active ? <Badge variant="outline">Active</Badge> : null}
                {outdated ? <Badge variant="muted">Outdated</Badge> : null}
                <span className="text-caption text-muted-foreground">
                  {release.approvedAt
                    ? `Approved ${formatDate(release.approvedAt)}`
                    : `Created ${formatDate(release.createdAt)}`}
                </span>
                {active || !canOpenRelease(persona, release) ? null : (
                  <Button
                    size="sm"
                    variant={reviewing ? 'secondary' : 'ghost'}
                    className="ml-auto"
                    aria-pressed={reviewing}
                    onClick={() => {
                      onReview(release.id);
                    }}
                  >
                    <Eye aria-hidden />
                    {release.status === 'draft' && !outdated ? 'Review' : 'View'}
                    <span className="sr-only"> v{release.version}</span>
                  </Button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </SectionCard>
  );
}
