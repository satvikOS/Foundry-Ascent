import type { PersonaReleaseView, PersonaView } from '@foundry/contracts';
import { Ban, BadgeCheck, X } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { SectionCard } from '@/components/ui/section-card';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { STATUS_DEFINITIONS } from '@/components/ui/status-badge';
import { usePersonaRelease } from '@/lib/api/hooks/eir';
import { formatDate } from '@/lib/format';

import { canOpenRelease, isOutdatedDraft, pendingDrafts } from './release-drafts';
import {
  ApproveReleaseDialog,
  approvalBlocker,
  ReleaseHistory,
  WithdrawReleaseDialog,
} from './release-history';
import { ReleaseContent } from './release-view';

/**
 * A release opened for review: the newest draft by default, or any earlier release picked in the history.
 * Its full content comes from `GET /persona-releases/:id`, so a reviewer sees exactly what they approve.
 * `onApprove` is absent for people who can't approve (only the persona's curators can). A draft older than
 * the active release is view only.
 */
export function ReleaseReview({
  persona,
  releaseId,
  blocker,
  onApprove,
  onWithdraw,
  onClose,
}: {
  persona: Pick<PersonaView, 'activeRelease'>;
  releaseId: string;
  blocker: string | null;
  onApprove?: (release: PersonaReleaseView) => void;
  /** Withdraws a superseded release (curators only). */
  onWithdraw?: (release: PersonaReleaseView) => void;
  /** Present when the person opened this release themselves (it can be closed). */
  onClose?: () => void;
}) {
  const release = usePersonaRelease(releaseId);
  const close = onClose ? (
    <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close review">
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
      <SectionCard title="Release" actions={close}>
        <ErrorState
          error={release.error}
          onRetry={() => void release.refetch()}
          retrying={release.isRefetching}
        />
      </SectionCard>
    );
  }
  const r = release.data;
  const outdated = isOutdatedDraft(persona, r);
  const draft = r.status === 'draft' && !outdated;
  return (
    <SectionCard
      title={
        outdated
          ? `Draft v${String(r.version)} · outdated`
          : draft
            ? `Draft v${String(r.version)} — ready for review`
            : `Release v${String(r.version)} · ${STATUS_DEFINITIONS.personaRelease[r.status].label}`
      }
      description={
        outdated
          ? `Older than the active v${String(persona.activeRelease?.version ?? '')}, so it can’t be approved.`
          : draft
            ? `Not live yet${r.createdBy ? ` · drafted by ${r.createdBy.displayName}` : ''}`
            : r.approvedAt
              ? `Approved ${formatDate(r.approvedAt)}${r.approvedBy ? ` by ${r.approvedBy.displayName}` : ''}`
              : `Created ${formatDate(r.createdAt)}`
      }
      className={draft ? 'border-dashed border-border-strong' : undefined}
      actions={
        <>
          {draft && onApprove ? (
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
          {r.status === 'superseded' && onWithdraw ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                onWithdraw(r);
              }}
            >
              <Ban aria-hidden />
              Withdraw…
            </Button>
          ) : null}
          {close}
        </>
      }
    >
      <div className="grid gap-6 py-2">
        {draft && blocker && onApprove ? <p className="text-small text-warning">{blocker}</p> : null}
        <ReleaseContent release={r} headingLevel={3} />
      </div>
    </SectionCard>
  );
}

/**
 * Releases: the version history and the review of a draft (approval makes it active). Drafts and withdrawn
 * releases open only for the persona's curators; everyone else reads the published history.
 */
export function ReleasesTab({ persona }: { persona: PersonaView }) {
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [approving, setApproving] = useState<PersonaReleaseView | null>(null);
  const [withdrawing, setWithdrawing] = useState<PersonaReleaseView | null>(null);
  const newestDraft = pendingDrafts(persona)[0] ?? null;
  const picked =
    pickedId !== null &&
    pickedId !== persona.activeRelease?.id &&
    persona.releases.some((r) => r.id === pickedId && canOpenRelease(persona, r))
      ? pickedId
      : null;
  const reviewId = picked ?? newestDraft?.id ?? null;
  const canApprove = persona.canCurate === true;

  return (
    <div className="grid gap-6">
      <ReleaseHistory persona={persona} reviewingId={reviewId} onReview={setPickedId} />
      {reviewId ? (
        <ReleaseReview
          key={reviewId}
          persona={persona}
          releaseId={reviewId}
          blocker={approvalBlocker(persona)}
          onApprove={canApprove ? setApproving : undefined}
          onWithdraw={canApprove ? setWithdrawing : undefined}
          onClose={
            picked !== null && picked !== newestDraft?.id
              ? () => {
                  setPickedId(null);
                }
              : undefined
          }
        />
      ) : null}
      <ApproveReleaseDialog
        persona={persona}
        release={approving}
        onClose={() => {
          setApproving(null);
        }}
        onApproved={() => {
          setPickedId(null);
        }}
      />
      <WithdrawReleaseDialog
        persona={persona}
        release={withdrawing}
        onClose={() => {
          setWithdrawing(null);
        }}
      />
    </div>
  );
}
