import type { PersonaView } from '@foundry/contracts';
import { FilePen, PencilLine } from 'lucide-react';
import { useState } from 'react';

import { announce } from '@/components/a11y/live-announcer';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { useCreatePersonaRelease, usePersonaRelease } from '@/lib/api/hooks/eir';
import { formatDate } from '@/lib/format';

import { ReleaseEditor } from './release-editor';
import { ReleaseContent } from './release-view';

function newestDraftOf(persona: PersonaView) {
  const activeVersion = persona.activeRelease?.version ?? 0;
  return (
    [...persona.releases]
      .filter((r) => r.status === 'draft' && r.version > activeVersion)
      .sort((a, b) => b.version - a.version)[0] ?? null
  );
}

/**
 * Doctrine & style: what the vEIR believes and how it talks, as approved. Curators edit it here; an edit
 * is saved as a draft release that goes live only once approved in Releases.
 */
export function DoctrineTab({
  persona,
  onOpenReleases,
}: {
  persona: PersonaView;
  onOpenReleases: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const create = useCreatePersonaRelease(persona.id);
  const active = persona.activeRelease;
  const draft = newestDraftOf(persona);
  // Edits continue from the newest draft when there is one, so nobody's unapproved work is lost.
  const draftRelease = usePersonaRelease(editing && draft ? draft.id : null);
  const nextVersion = Math.max(0, ...persona.releases.map((r) => r.version)) + 1;
  const canEdit = persona.canCurate === true && persona.status !== 'retired';

  if (editing) {
    if (draft && draftRelease.isPending) {
      return (
        <LoadingRegion label="Loading the draft">
          <Skeleton className="h-96 rounded-xl" />
        </LoadingRegion>
      );
    }
    const base = draftRelease.data ?? active;
    return (
      <ReleaseEditor
        title="Edit doctrine & style"
        description={`Saves draft v${nextVersion}${base ? `, based on v${base.version}` : ''}. Founders see no change until it’s approved.`}
        submitLabel="Save draft"
        submittingLabel="Saving draft…"
        base={base}
        pending={create.isPending}
        error={create.error}
        onCancel={() => {
          setEditing(false);
          create.reset();
        }}
        onSubmit={(input) => {
          create.mutate(input, {
            onSuccess: (release) => {
              setEditing(false);
              toast.success(`Draft v${release.version} saved`);
              announce('Draft saved. Review it in Releases.');
              onOpenReleases();
            },
          });
        }}
      />
    );
  }

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-small text-muted-foreground">
          {active
            ? `Release v${active.version}${active.approvedAt ? ` · approved ${formatDate(active.approvedAt)}` : ''}${
                active.approvedBy ? ` by ${active.approvedBy.displayName}` : ''
              }`
            : 'No approved release yet.'}
        </p>
        {canEdit ? (
          <Button
            variant="secondary"
            onClick={() => {
              setEditing(true);
            }}
          >
            <PencilLine aria-hidden />
            Edit
          </Button>
        ) : null}
      </div>
      {draft ? (
        <Alert
          variant="info"
          icon={FilePen}
          title={`Draft v${draft.version} is waiting for approval`}
          action={
            <Button size="sm" variant="secondary" onClick={onOpenReleases}>
              Review
            </Button>
          }
        />
      ) : null}
      {active ? (
        <ReleaseContent release={active} />
      ) : (
        <EmptyState
          icon={FilePen}
          title="Nothing approved yet"
          description="This vEIR can’t coach until a release is approved."
          headingLevel={2}
        />
      )}
    </div>
  );
}
