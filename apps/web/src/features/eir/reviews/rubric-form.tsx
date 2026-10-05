import { zodResolver } from '@hookform/resolvers/zod';
import { CircleAlert, Send } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { Controller, useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import type { SubmitReviewInput } from '@/lib/api/hooks/eir';
import { cn } from '@/lib/utils';

import {
  NOTES_MAX,
  RUBRIC_CRITERIA,
  RubricFormSchema,
  SCALE,
  toReviewInput,
  type RubricFormValues,
} from './rubric';

interface RubricFormProps {
  onSubmit: (review: SubmitReviewInput) => void;
  submitting?: boolean;
  /** Rendered between the notes and the submit button (e.g. a mutation error). */
  footer?: ReactNode;
}

/** Unscored criteria are `undefined` at runtime (the form starts empty) even though the type says number. */
function scoreValue(value: unknown): string {
  return typeof value === 'number' ? String(value) : '';
}

/**
 * Blind calibration rubric: six criteria scored 1–5 (all required) plus optional notes. Validation
 * runs on submit; errors are attached to each radio group and focus moves to the first one.
 */
export function RubricForm({ onSubmit, submitting = false, footer }: RubricFormProps) {
  const baseId = useId();
  const { control, register, handleSubmit, formState, watch } = useForm<RubricFormValues>({
    resolver: zodResolver(RubricFormSchema),
    defaultValues: { notes: '' },
    shouldFocusError: true,
  });
  const notesLength = watch('notes').length;
  const errorCount = formState.errors.scores ? Object.keys(formState.errors.scores).length : 0;

  return (
    <form
      noValidate
      aria-label="Calibration rubric"
      onSubmit={(event) =>
        void handleSubmit((values) => {
          onSubmit(toReviewInput(values));
        })(event)
      }
      className="grid gap-5"
    >
      {formState.isSubmitted && errorCount > 0 ? (
        <p role="alert" className="flex items-center gap-1.5 text-[13px] font-medium text-destructive">
          <CircleAlert aria-hidden className="size-4" />
          {errorCount === 1
            ? 'Score the remaining criterion to submit.'
            : `Score the ${errorCount} remaining criteria to submit.`}
        </p>
      ) : null}
      {RUBRIC_CRITERIA.map((criterion) => {
        const id = `${baseId}-${criterion.key}`;
        const error = formState.errors.scores?.[criterion.key]?.message;
        return (
          <Controller
            key={criterion.key}
            control={control}
            name={`scores.${criterion.key}`}
            render={({ field }) => (
              <fieldset className="grid gap-2" aria-describedby={`${id}-desc${error ? ` ${id}-error` : ''}`}>
                <legend className="text-sm font-semibold">
                  {criterion.label}
                  <span aria-hidden className="text-muted-foreground">
                    *
                  </span>
                </legend>
                <p id={`${id}-desc`} className="-mt-1 text-[13px] text-muted-foreground">
                  {criterion.description}
                </p>
                <RadioGroup
                  aria-label={criterion.label}
                  aria-required
                  aria-invalid={error ? true : undefined}
                  value={scoreValue(field.value)}
                  onValueChange={(value) => {
                    field.onChange(Number(value));
                  }}
                  className="grid grid-cols-5 gap-1.5"
                >
                  {SCALE.map((option, index) => {
                    const optionId = `${id}-${option.value}`;
                    const selected = field.value === option.value;
                    return (
                      <label
                        key={option.value}
                        htmlFor={optionId}
                        className={cn(
                          'flex cursor-pointer flex-col items-center gap-1 rounded-lg border px-1 py-2 text-center transition-colors',
                          'hover:border-foreground/45 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
                          selected ? 'border-foreground bg-accent' : 'border-border',
                          error && !selected && 'border-destructive/60',
                        )}
                      >
                        <RadioGroupItem
                          id={optionId}
                          value={String(option.value)}
                          aria-label={`${option.value} ${option.label}`}
                          ref={index === 0 ? field.ref : undefined}
                          onBlur={field.onBlur}
                          className="sr-only"
                        />
                        <span
                          className={cn(
                            'text-base leading-5 font-semibold',
                            selected && 'underline underline-offset-4',
                          )}
                        >
                          {option.value}
                        </span>
                        <span className="text-[11px] leading-tight text-muted-foreground">
                          {option.label}
                        </span>
                      </label>
                    );
                  })}
                </RadioGroup>
                {error ? (
                  <p id={`${id}-error`} className="flex items-start gap-1.5 text-[13px] text-destructive">
                    <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                    {error}
                  </p>
                ) : null}
              </fieldset>
            )}
          />
        );
      })}
      <Field
        label="Notes"
        description={`Optional. What would a strong EIR have said differently? ${notesLength.toLocaleString()}/${NOTES_MAX.toLocaleString()}`}
        error={formState.errors.notes?.message}
      >
        <Textarea minRows={3} maxRows={10} {...register('notes')} />
      </Field>
      {footer}
      <div className="flex justify-end">
        <Button type="submit" loading={submitting} loadingText="Submitting…">
          <Send aria-hidden />
          Submit review
        </Button>
      </div>
    </form>
  );
}
