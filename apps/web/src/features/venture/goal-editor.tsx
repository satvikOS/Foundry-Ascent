import type { VentureDetail, VentureOverview } from '@foundry/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { Pencil, Target } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { announce } from '@/components/a11y/live-announcer';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { SectionCard } from '@/components/ui/section-card';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api/errors';
import { useUpdateVenture } from '@/lib/api/hooks/ventures';
import { queryKeys } from '@/lib/api/query-keys';

const MAX_GOAL = 500;

/**
 * The venture's current goal, editable in place. Saves optimistically (overview + venture caches) and
 * rolls back with a toast if the server rejects the change.
 */
export function GoalEditor({
  ventureId,
  goal,
  canEdit,
}: {
  ventureId: string;
  goal: string | null;
  canEdit: boolean;
}) {
  const client = useQueryClient();
  const update = useUpdateVenture(ventureId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(goal ?? '');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const editButtonRef = useRef<HTMLButtonElement | null>(null);
  const hintId = useId();

  useEffect(() => {
    if (!editing) setDraft(goal ?? '');
  }, [goal, editing]);

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  const stopEditing = () => {
    setEditing(false);
    requestAnimationFrame(() => editButtonRef.current?.focus());
  };

  const save = () => {
    const next = draft.trim() === '' ? null : draft.trim().slice(0, MAX_GOAL);
    if (next === (goal ?? null)) {
      stopEditing();
      return;
    }
    const overviewKey = queryKeys.venture.overview(ventureId);
    const detailKey = queryKeys.venture.detail(ventureId);
    const previousOverview = client.getQueryData<VentureOverview>(overviewKey);
    const previousDetail = client.getQueryData<VentureDetail>(detailKey);
    if (previousOverview)
      client.setQueryData<VentureOverview>(overviewKey, { ...previousOverview, currentGoal: next });
    if (previousDetail)
      client.setQueryData<VentureDetail>(detailKey, { ...previousDetail, currentGoal: next });
    stopEditing();
    update.mutate(
      { currentGoal: next },
      {
        onSuccess: () => {
          toast.success(next ? 'Goal updated' : 'Goal cleared');
          announce(next ? 'Goal updated' : 'Goal cleared');
        },
        onError: (error) => {
          if (previousOverview) client.setQueryData(overviewKey, previousOverview);
          if (previousDetail) client.setQueryData(detailKey, previousDetail);
          toast.error('Couldn’t update the goal', { description: errorMessage(error) });
        },
      },
    );
  };

  return (
    <SectionCard
      title="Current goal"
      icon={Target}
      description="What this venture is working towards right now. Foundry Guide uses it to focus every session."
      actions={
        canEdit && !editing ? (
          <Button
            ref={editButtonRef}
            variant="ghost"
            size="sm"
            onClick={() => {
              setEditing(true);
            }}
          >
            <Pencil aria-hidden />
            {goal ? 'Edit' : 'Set goal'}
          </Button>
        ) : null
      }
    >
      {editing ? (
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <label htmlFor={`${hintId}-goal`} className="sr-only">
            Current goal
          </label>
          <Textarea
            id={`${hintId}-goal`}
            ref={textareaRef}
            value={draft}
            maxLength={MAX_GOAL}
            minRows={2}
            maxRows={6}
            aria-describedby={hintId}
            placeholder="e.g. Validate exam-week demand with 300 students before the end of term"
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setDraft(goal ?? '');
                stopEditing();
              } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                save();
              }
            }}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p id={hintId} className="flex items-center gap-1 text-xs text-muted-foreground">
              <span className="tabular">
                {draft.length}/{MAX_GOAL}
              </span>
              <span aria-hidden>·</span>
              <Kbd>Esc</Kbd> cancel
            </p>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setDraft(goal ?? '');
                  stopEditing();
                }}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm">
                Save goal
              </Button>
            </div>
          </div>
        </form>
      ) : goal ? (
        <p className="text-[15px] leading-7 font-medium text-balance">{goal}</p>
      ) : (
        <p className="text-sm text-muted-foreground">
          No goal set yet.{canEdit ? ' A clear, dated goal makes every session sharper.' : ''}
        </p>
      )}
    </SectionCard>
  );
}
