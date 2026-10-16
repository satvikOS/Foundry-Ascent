import { zodResolver } from '@hookform/resolvers/zod';
import type { LessonView } from '@foundry/contracts';
import { BadgeCheck, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

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
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { applyServerFieldErrors, MutationErrorAlert } from '@/features/admin/shared/form';
import { formatDate } from '@/lib/format';
import { useCreateLesson, useLessonAction } from '@/lib/api/hooks/veir-pools';

import {
  EMPTY_LESSON,
  formToLesson,
  LESSON_FIELDS,
  LessonForm,
  lessonEdit,
  lessonToForm,
  type LessonFormValues,
} from './lesson-form';
import { DistilledBadge, LessonStatusBadge, needsReview } from './lesson-labels';

type LessonSheetState = { mode: 'closed' } | { mode: 'create' } | { mode: 'open'; lesson: LessonView };

interface LessonSheetProps {
  personaId: string;
  displayName: string;
  state: LessonSheetState;
  /** Curators edit, publish and withdraw; everyone else reads. */
  canCurate: boolean;
  onClose: () => void;
}

/**
 * Review one lesson: edit its six parts, publish it (only published lessons are retrieved) or withdraw it.
 * A withdrawn lesson is read-only.
 */
export function LessonSheet({ personaId, displayName, state, canCurate, onClose }: LessonSheetProps) {
  const [busy, setBusy] = useState(false);
  const lesson = state.mode === 'open' ? state.lesson : null;
  const title = state.mode === 'create' ? 'New lesson' : (lesson?.title ?? '');
  return (
    <Sheet
      open={state.mode !== 'closed'}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <SheetContent className="w-[min(100vw-1rem,40rem)]">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription asChild>
            <div className="flex flex-wrap items-center gap-2">
              {lesson ? (
                <>
                  <LessonStatusBadge status={lesson.status} />
                  {lesson.origin === 'distilled' ? <DistilledBadge /> : null}
                  <span>Created {formatDate(lesson.createdAt)}</span>
                </>
              ) : (
                <span>Saved as a draft. {displayName} uses it once it’s published.</span>
              )}
            </div>
          </SheetDescription>
        </SheetHeader>
        {state.mode === 'closed' ? null : (
          <LessonBody
            // A fresh form for each lesson: background refetches never overwrite edits in progress.
            key={lesson?.id ?? 'new'}
            personaId={personaId}
            displayName={displayName}
            title={title}
            lesson={lesson}
            canCurate={canCurate}
            onBusyChange={setBusy}
            onDone={onClose}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function LessonBody({
  personaId,
  displayName,
  title,
  lesson,
  canCurate,
  onBusyChange,
  onDone,
}: {
  personaId: string;
  displayName: string;
  title: string;
  lesson: LessonView | null;
  canCurate: boolean;
  onBusyChange: (busy: boolean) => void;
  onDone: () => void;
}) {
  const create = useCreateLesson(personaId);
  const act = useLessonAction(personaId);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const editable = canCurate && lesson?.status !== 'withdrawn';
  const pending = create.isPending || act.isPending;
  const { register, handleSubmit, formState, setError } = useForm<LessonFormValues>({
    resolver: zodResolver(LessonForm),
    defaultValues: lesson ? lessonToForm(lesson) : EMPTY_LESSON,
  });
  const e = formState.errors;

  const finish = (message: string) => {
    toast.success(message);
    announce(message);
    onBusyChange(false);
    onDone();
  };
  const fail = (error: unknown) => {
    onBusyChange(false);
    applyServerFieldErrors(
      error,
      setError,
      LESSON_FIELDS.map((f) => f.name),
    );
  };

  /** Saves the edits (if any), then runs `then` with the saved lesson. */
  const saveThen = (then?: (saved: LessonView) => void) =>
    handleSubmit((values) => {
      onBusyChange(true);
      if (lesson === null) {
        create.mutate(formToLesson(values), {
          onSuccess: () => {
            finish('Lesson saved as a draft');
          },
          onError: fail,
        });
        return;
      }
      const edit = lessonEdit(lesson, values);
      if (edit === null) {
        if (then) then(lesson);
        else finish('No changes');
        return;
      }
      act.mutate(
        { lessonId: lesson.id, action: edit },
        {
          onSuccess: (saved) => {
            if (then) then(saved);
            else finish('Changes saved');
          },
          onError: fail,
        },
      );
    });

  const publish = saveThen((saved) => {
    act.mutate(
      { lessonId: saved.id, action: { action: 'publish' } },
      {
        onSuccess: () => {
          finish(`Published. ${displayName} can draw on it now.`);
        },
        onError: fail,
      },
    );
  });

  const withdraw = () => {
    if (!lesson) return;
    onBusyChange(true);
    act.mutate(
      { lessonId: lesson.id, action: { action: 'withdraw' } },
      {
        onSuccess: () => {
          setConfirmWithdraw(false);
          finish('Lesson withdrawn');
        },
        onError: fail,
      },
    );
  };

  return (
    <form
      noValidate
      aria-label={title}
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => void saveThen()(event)}
    >
      <SheetBody className="grid content-start gap-5">
        {lesson?.origin === 'distilled' && needsReview(lesson) ? (
          <Alert variant="info" title="Proposed from conversations">
            Check it names no venture, person or identifying number before publishing.
          </Alert>
        ) : null}
        {editable ? (
          LESSON_FIELDS.map((f) => (
            <Field
              key={f.name}
              label={f.label}
              description={f.description}
              required
              error={e[f.name]?.message}
            >
              {f.name === 'title' ? (
                <Input autoComplete="off" {...register(f.name)} />
              ) : (
                <Textarea minRows={2} maxRows={8} {...register(f.name)} />
              )}
            </Field>
          ))
        ) : lesson ? (
          <dl className="grid gap-5">
            {LESSON_FIELDS.filter((f) => f.name !== 'title').map((f) => (
              <div key={f.name} className="grid gap-1">
                <dt className="label-mono">{f.label}</dt>
                <dd className="text-body whitespace-pre-wrap">{lesson[f.name]}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <MutationErrorAlert error={create.error ?? act.error} title="Not saved" />
      </SheetBody>
      {editable ? (
        <SheetFooter className="flex-wrap justify-end">
          {lesson ? (
            <Button
              variant="ghost"
              className="mr-auto text-destructive"
              disabled={pending}
              onClick={() => {
                setConfirmWithdraw(true);
              }}
            >
              <Undo2 aria-hidden />
              Withdraw
            </Button>
          ) : null}
          {lesson && needsReview(lesson) ? (
            <>
              <Button type="submit" variant="secondary" disabled={pending || !formState.isDirty}>
                Save
              </Button>
              <Button
                loading={act.isPending}
                loadingText="Publishing…"
                disabled={pending}
                onClick={(event) => void publish(event)}
              >
                <BadgeCheck aria-hidden />
                Publish
              </Button>
            </>
          ) : (
            <Button
              type="submit"
              loading={pending}
              loadingText="Saving…"
              disabled={lesson !== null && !formState.isDirty}
            >
              {lesson ? 'Save' : 'Save draft'}
            </Button>
          )}
        </SheetFooter>
      ) : null}

      <AlertDialog
        open={confirmWithdraw}
        onOpenChange={(open) => {
          if (!act.isPending) setConfirmWithdraw(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Withdraw this lesson?</AlertDialogTitle>
            <AlertDialogDescription>
              {displayName} stops using it. A withdrawn lesson can’t be published again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={act.isPending}>Keep it</AlertDialogCancel>
            <Button
              variant="destructive"
              loading={act.isPending}
              loadingText="Withdrawing…"
              onClick={withdraw}
            >
              Withdraw
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}
