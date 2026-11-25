import { PathIntake, type FounderExperience } from '@foundry/contracts';
import { useId, useState } from 'react';
import type { z } from 'zod';

import { announce } from '@/components/a11y/live-announcer';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { SegmentedControl } from '@/features/venture/segmented-control';
import { errorMessage } from '@/lib/api/errors';
import { useSavePathIntake } from '@/lib/api/hooks/path';
import { cn } from '@/lib/utils';

type Experience = z.infer<typeof FounderExperience>;

export const EXPERIENCE_LABELS: Record<Experience, string> = {
  first_time: 'First time',
  some: 'Some',
  experienced: 'Experienced',
};

export const EMPTY_INTAKE: PathIntake = PathIntake.parse({});

/** What the founder types: the deadline's two halves apart, and a number field's text. */
interface Draft extends Omit<PathIntake, 'deadline' | 'hoursPerWeek'> {
  hours: string;
  deadlineWhat: string;
  deadlineOn: string;
}

function draftOf(intake: PathIntake): Draft {
  const { deadline, hoursPerWeek, ...rest } = intake;
  return {
    ...rest,
    hours: hoursPerWeek === null ? '' : String(hoursPerWeek),
    deadlineWhat: deadline?.what ?? '',
    deadlineOn: deadline?.on ?? '',
  };
}

/** The intake as it is saved; a deadline needs both its halves, so half of one is an error instead of a guess. */
export function intakeOf(draft: Draft): { intake: PathIntake } | { error: 'hours' | 'deadline' } {
  const { hours, deadlineWhat, deadlineOn, ...rest } = draft;
  const what = deadlineWhat.trim();
  if ((what === '') !== (deadlineOn === '')) return { error: 'deadline' };
  const hoursPerWeek = hours.trim() === '' ? null : Number(hours);
  const parsed = PathIntake.safeParse({
    ...rest,
    hoursPerWeek,
    deadline: what === '' ? null : { what, on: deadlineOn },
  });
  return parsed.success
    ? { intake: parsed.data }
    : { error: parsed.error.issues[0]?.path[0] === 'deadline' ? 'deadline' : 'hours' };
}

interface IntakeFormProps {
  ventureId: string;
  initial: PathIntake | null;
  /** The conversation's card asks the six that matter for a first plan; the path page has them all. */
  fields: 'short' | 'all';
  cancelLabel: string;
  onSaved: () => void;
  onCancel: () => void;
}

/** What the mentor plans with: every field optional, none more than a line. */
export function IntakeForm({ ventureId, initial, fields, cancelLabel, onSaved, onCancel }: IntakeFormProps) {
  const id = useId();
  const save = useSavePathIntake(ventureId);
  const [draft, setDraft] = useState<Draft>(() => draftOf(initial ?? EMPTY_INTAKE));
  const [error, setError] = useState<'hours' | 'deadline' | null>(null);
  const set = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  };
  const line = (key: 'idea' | 'customer' | 'studies' | 'doneSoFar' | 'block', label: string, max: number) => (
    <Field label={label} id={`${id}-${key}`}>
      <Input
        value={draft[key]}
        maxLength={max}
        autoComplete="off"
        onChange={(event) => {
          set({ [key]: event.target.value });
        }}
      />
    </Field>
  );
  return (
    <form
      noValidate
      data-slot="intake-form"
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const result = intakeOf(draft);
        if ('error' in result) {
          setError(result.error);
          document
            .getElementById(`${id}-${result.error === 'deadline' ? 'deadline-what' : 'hours'}`)
            ?.focus();
          return;
        }
        save.mutate(result.intake, {
          onSuccess: () => {
            announce('Saved');
            onSaved();
          },
          onError: (cause) => {
            toast.error('Couldn’t save that', { description: errorMessage(cause) });
          },
        });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {line('idea', 'Your idea, in a sentence', 400)}
        {line('customer', 'Who it is for', 240)}
        {line('studies', 'What you study', 120)}
        <div className="grid gap-2">
          <span id={`${id}-experience`} className="text-sm leading-none font-medium">
            Building a venture
          </span>
          <SegmentedControl<Experience | ''>
            label="Building a venture"
            className="h-9 flex-wrap"
            value={draft.experience ?? ''}
            onChange={(value) => {
              // A second press on the chosen one takes it back: nothing here is required.
              set({ experience: value === '' || value === draft.experience ? null : value });
            }}
            options={[
              { value: 'first_time', label: EXPERIENCE_LABELS.first_time },
              { value: 'some', label: EXPERIENCE_LABELS.some },
              { value: 'experienced', label: EXPERIENCE_LABELS.experienced },
            ]}
          />
        </div>
        <Field label="Hours a week" id={`${id}-hours`} error={error === 'hours' ? 'Use 0 to 60.' : undefined}>
          <Input
            inputMode="numeric"
            value={draft.hours}
            maxLength={2}
            autoComplete="off"
            onChange={(event) => {
              set({ hours: event.target.value.replace(/\D/g, '') });
            }}
          />
        </Field>
        <div className="grid gap-2">
          <Field
            label="Next deadline"
            id={`${id}-deadline-what`}
            error={error === 'deadline' ? 'Add both what and when.' : undefined}
          >
            <Input
              value={draft.deadlineWhat}
              maxLength={120}
              placeholder="What"
              autoComplete="off"
              onChange={(event) => {
                set({ deadlineWhat: event.target.value });
              }}
            />
          </Field>
          <Input
            type="date"
            aria-label="Deadline date"
            value={draft.deadlineOn}
            onChange={(event) => {
              set({ deadlineOn: event.target.value });
            }}
          />
        </div>
        {fields === 'all' ? (
          <>
            {line('doneSoFar', 'Done so far', 600)}
            {line('block', 'What’s in the way', 300)}
          </>
        ) : null}
      </div>
      <div className={cn('flex gap-2', fields === 'all' && 'justify-end')}>
        <Button type="submit" size="sm" loading={save.isPending} loadingText="Saving…">
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {cancelLabel}
        </Button>
      </div>
    </form>
  );
}
