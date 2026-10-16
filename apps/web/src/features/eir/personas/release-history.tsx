import type { PersonaView } from '@foundry/contracts';
import { BadgeCheck, Eye } from 'lucide-react';

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
import { useApprovePersonaRelease } from '@/lib/api/hooks/eir';
import { formatDate, pluralize } from '@/lib/format';

import { CONSENT_NEEDED, consentState } from './persona-labels';

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
 * Every version of the persona with its status. Any release other than the active one can be opened for
 * review; drafts are approved from the review panel.
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
    <SectionCard title="History" description={pluralize(releases.length, 'release')} flush>
      {releases.length === 0 ? (
        <p className="px-5 py-4 text-small text-muted-foreground">No releases yet.</p>
      ) : (
        <ol aria-label="Releases" className="divide-y divide-border">
          {releases.map((release) => {
            const active = persona.activeRelease?.id === release.id;
            const reviewing = reviewingId === release.id;
            return (
              <li key={release.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-5 py-3">
                <span className="tabular w-8 text-small font-semibold">v{release.version}</span>
                <StatusBadge kind="personaRelease" status={release.status} withTitle />
                {active ? <Badge variant="outline">Active</Badge> : null}
                <span className="text-caption text-muted-foreground">
                  {release.approvedAt
                    ? `Approved ${formatDate(release.approvedAt)}`
                    : `Created ${formatDate(release.createdAt)}`}
                </span>
                {active ? null : (
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
                    {release.status === 'draft' ? 'Review' : 'View'}
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
