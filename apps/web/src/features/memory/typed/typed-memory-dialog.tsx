import { zodResolver } from '@hookform/resolvers/zod';
import { Visibility, type MemoryObjectView } from '@foundry/contracts';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import { announce } from '@/components/a11y/live-announcer';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api/errors';
import { VISIBILITY_LABELS } from '@/lib/labels';
import { FieldSelect, type FieldSelectOption } from '@/features/venture/field-select';
import { applyFieldErrors } from '@/features/venture/form-errors';

import { useCreateVentureMemory, useOptimisticMemoryAction } from '../api';
import {
  EXPERIMENT_STATUSES,
  MILESTONE_STATUSES,
  decisionAttributes,
  experimentAttributes,
  milestoneAttributes,
} from './attributes';
import { EXPERIMENT_STATUS_DEFS, MILESTONE_STATUS_DEFS } from './typed-status';

const EXPERIMENT_STATUS_OPTIONS: FieldSelectOption<string>[] = EXPERIMENT_STATUSES.map((s) => ({
  value: s,
  label: EXPERIMENT_STATUS_DEFS[s].label,
  icon: EXPERIMENT_STATUS_DEFS[s].icon,
}));
const MILESTONE_STATUS_OPTIONS: FieldSelectOption<string>[] = MILESTONE_STATUSES.map((s) => ({
  value: s,
  label: MILESTONE_STATUS_DEFS[s].label,
  icon: MILESTONE_STATUS_DEFS[s].icon,
}));
const VISIBILITY_OPTIONS: FieldSelectOption<z.infer<typeof Visibility>>[] = Visibility.options.map((v) => ({
  value: v,
  label: VISIBILITY_LABELS[v].label,
}));

export type TypedKind = 'decision' | 'experiment' | 'milestone';

const optionalText = (max: number, label: string) =>
  z.string().trim().max(max, `Keep ${label} under ${max.toLocaleString()} characters.`);
const isoDate = z
  .string()
  .trim()
  .refine((v) => v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v), 'Use a valid date.');

const FormSchema = z
  .object({
    kind: z.enum(['decision', 'experiment', 'milestone']),
    title: z.string().trim().min(1, 'Add a short title.').max(200, 'Keep the title under 200 characters.'),
    content: z.string().trim().min(1, 'This field is required.').max(8000, 'Keep it under 8,000 characters.'),
    visibility: Visibility,
    owner: optionalText(120, 'the owner'),
    date: isoDate,
    rationale: optionalText(2000, 'the rationale'),
    reversalCondition: optionalText(1000, 'the reversal condition'),
    alternatives: optionalText(2000, 'alternatives'),
    prediction: optionalText(1000, 'the prediction'),
    method: optionalText(2000, 'the method'),
    successCriteria: optionalText(1000, 'success criteria'),
    sampleSize: z
      .string()
      .trim()
      .refine((v) => v === '' || /^\d{1,7}$/.test(v), 'Use a whole number.'),
    status: z.string(),
    result: optionalText(2000, 'the result'),
    interpretation: optionalText(2000, 'the interpretation'),
    dependency: optionalText(300, 'the dependency'),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'experiment') {
      if (!v.prediction)
        ctx.addIssue({ code: 'custom', path: ['prediction'], message: 'What do you expect to happen?' });
      if (!v.method) ctx.addIssue({ code: 'custom', path: ['method'], message: 'How will you test it?' });
    }
    if (v.kind === 'milestone' && !v.date) {
      ctx.addIssue({ code: 'custom', path: ['date'], message: 'Choose a target date.' });
    }
  });
type FormInput = z.input<typeof FormSchema>;
type FormOutput = z.output<typeof FormSchema>;

const FIELD_NAMES = [
  'title',
  'content',
  'visibility',
  'owner',
  'date',
  'rationale',
  'reversalCondition',
  'alternatives',
  'prediction',
  'method',
  'successCriteria',
  'sampleSize',
  'status',
  'result',
  'interpretation',
  'dependency',
] as const;

const COPY: Record<TypedKind, { noun: string; content: string; contentHint: string }> = {
  decision: {
    noun: 'decision',
    content: 'What was decided',
    contentHint: 'One or two sentences anyone on the team would recognise.',
  },
  experiment: {
    noun: 'experiment',
    content: 'Hypothesis being tested',
    contentHint: 'The belief this experiment could prove wrong.',
  },
  milestone: {
    noun: 'milestone',
    content: 'Definition of done',
    contentHint: 'How everyone will know it has been reached.',
  },
};

function emptyValues(kind: TypedKind): FormInput {
  return {
    kind,
    title: '',
    content: '',
    visibility: 'venture',
    owner: '',
    date: '',
    rationale: '',
    reversalCondition: '',
    alternatives: '',
    prediction: '',
    method: '',
    successCriteria: '',
    sampleSize: '',
    status: kind === 'experiment' ? 'planned' : kind === 'milestone' ? 'planned' : '',
    result: '',
    interpretation: '',
    dependency: '',
  };
}

function valuesFromMemory(kind: TypedKind, memory: MemoryObjectView): FormInput {
  const base = {
    ...emptyValues(kind),
    title: memory.title,
    content: memory.content,
    visibility: memory.visibility,
  };
  if (kind === 'decision') {
    const a = decisionAttributes(memory);
    return {
      ...base,
      owner: a.owner ?? '',
      date: a.decided_on ?? '',
      rationale: a.rationale ?? '',
      reversalCondition: a.reversal_condition ?? '',
      alternatives: (a.alternatives ?? []).join('\n'),
    };
  }
  if (kind === 'experiment') {
    const a = experimentAttributes(memory);
    return {
      ...base,
      prediction: a.prediction ?? '',
      method: a.method ?? '',
      successCriteria: a.success_criteria ?? '',
      sampleSize: a.sample_size === undefined ? '' : String(a.sample_size),
      status: a.status ?? 'planned',
      result: a.result ?? '',
      interpretation: a.interpretation ?? '',
    };
  }
  const a = milestoneAttributes(memory);
  return {
    ...base,
    owner: a.owner ?? '',
    date: a.target_date ?? '',
    status: a.status ?? 'planned',
    dependency: a.dependency ?? '',
  };
}

/** Typed attributes for the API: empty fields are omitted, unknown existing keys are preserved. */
export function buildTypedAttributes(
  values: FormOutput,
  existing: Record<string, unknown> = {},
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...existing };
  const set = (key: string, value: string | number | string[] | undefined) => {
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
      Reflect.deleteProperty(next, key);
    } else {
      next[key] = value;
    }
  };
  if (values.kind === 'decision') {
    set('owner', values.owner);
    set('decided_on', values.date);
    set('rationale', values.rationale);
    set('reversal_condition', values.reversalCondition);
    set(
      'alternatives',
      values.alternatives
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    );
  } else if (values.kind === 'experiment') {
    set('prediction', values.prediction);
    set('method', values.method);
    set('success_criteria', values.successCriteria);
    set('sample_size', values.sampleSize === '' ? undefined : Number.parseInt(values.sampleSize, 10));
    set('status', values.status);
    set('result', values.result);
    set('interpretation', values.interpretation);
  } else {
    set('owner', values.owner);
    set('target_date', values.date);
    set('status', values.status);
    set('dependency', values.dependency);
  }
  return next;
}

interface TypedMemoryDialogProps {
  ventureId: string;
  kind: TypedKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this memory (saved as a correction / new version) instead of creating one. */
  memory?: MemoryObjectView | null;
}

/** Create or edit a decision, experiment or milestone with its type-specific attributes. */
export function TypedMemoryDialog({
  ventureId,
  kind,
  open,
  onOpenChange,
  memory = null,
}: TypedMemoryDialogProps) {
  const { createMemory, mutation: createMutation } = useCreateVentureMemory(ventureId);
  const correct = useOptimisticMemoryAction(ventureId);
  const [formError, setFormError] = useState<string | null>(null);
  const copy = COPY[kind];
  const editing = memory !== null;
  const { register, control, handleSubmit, reset, formState, setError } = useForm<
    FormInput,
    unknown,
    FormOutput
  >({
    resolver: zodResolver(FormSchema),
    defaultValues: emptyValues(kind),
  });
  const errors = formState.errors;

  useEffect(() => {
    if (!open) return;
    setFormError(null);
    reset(memory ? valuesFromMemory(kind, memory) : emptyValues(kind));
  }, [open, memory, kind, reset]);

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      if (memory) {
        const attributes = buildTypedAttributes(values, memory.attributes);
        const patch: {
          title?: string;
          content?: string;
          visibility?: z.infer<typeof Visibility>;
          attributes?: Record<string, unknown>;
        } = {};
        if (values.title !== memory.title) patch.title = values.title;
        if (values.content !== memory.content) patch.content = values.content;
        if (values.visibility !== memory.visibility) patch.visibility = values.visibility;
        if (JSON.stringify(attributes) !== JSON.stringify(memory.attributes)) patch.attributes = attributes;
        if (Object.keys(patch).length === 0) {
          onOpenChange(false);
          return;
        }
        await correct.mutateAsync({ memoryId: memory.id, action: { action: 'correct', patch } });
        toast.success(`Updated — saved as a new version`);
      } else {
        const created = await createMemory({
          type: kind,
          title: values.title,
          content: values.content,
          visibility: values.visibility,
          attributes: buildTypedAttributes(values),
        });
        toast.success(
          created.status === 'proposed'
            ? `Added — waiting for approval`
            : `${copy.noun[0]?.toUpperCase() ?? ''}${copy.noun.slice(1)} added`,
        );
      }
      announce(editing ? 'Saved' : 'Added');
      onOpenChange(false);
    } catch (error) {
      if (
        !applyFieldErrors(error, setError, FIELD_NAMES, {
          'patch.title': 'title',
          'patch.content': 'content',
        })
      ) {
        setFormError(errorMessage(error));
      }
    }
  });

  const pending = createMutation.isPending || correct.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <form onSubmit={(e) => void onSubmit(e)} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${copy.noun}` : `New ${copy.noun}`}</DialogTitle>
            <DialogDescription>
              {editing
                ? 'Changes are saved as a new version; the previous one stays in the memory history.'
                : `Saved to venture memory so Foundry Guide can use it as evidence.`}
            </DialogDescription>
          </DialogHeader>
          {formError ? (
            <Alert variant="destructive" live="alert">
              {formError}
            </Alert>
          ) : null}
          <Field label="Title" required error={errors.title?.message}>
            <Input {...register('title')} maxLength={200} autoComplete="off" />
          </Field>
          <Field label={copy.content} required description={copy.contentHint} error={errors.content?.message}>
            <Textarea {...register('content')} minRows={2} maxRows={8} maxLength={8000} />
          </Field>

          {kind === 'decision' ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Owner" error={errors.owner?.message}>
                  <Input {...register('owner')} maxLength={120} autoComplete="off" />
                </Field>
                <Field label="Decided on" error={errors.date?.message}>
                  <Input type="date" {...register('date')} />
                </Field>
              </div>
              <Field
                label="Rationale"
                description="Why this option over the others."
                error={errors.rationale?.message}
              >
                <Textarea {...register('rationale')} minRows={2} maxRows={6} maxLength={2000} />
              </Field>
              <Field
                label="Reversal condition"
                description="What evidence would make you change your mind?"
                error={errors.reversalCondition?.message}
              >
                <Textarea {...register('reversalCondition')} minRows={2} maxRows={4} maxLength={1000} />
              </Field>
              <Field
                label="Alternatives considered"
                description="One per line."
                error={errors.alternatives?.message}
              >
                <Textarea {...register('alternatives')} minRows={2} maxRows={5} />
              </Field>
            </>
          ) : null}

          {kind === 'experiment' ? (
            <>
              <Field
                label="Prediction"
                required
                description="What you expect to see if the hypothesis is right."
                error={errors.prediction?.message}
              >
                <Textarea {...register('prediction')} minRows={2} maxRows={4} maxLength={1000} />
              </Field>
              <Field label="Method" required error={errors.method?.message}>
                <Textarea {...register('method')} minRows={2} maxRows={6} maxLength={2000} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field
                  label="Success criteria"
                  error={errors.successCriteria?.message}
                  className="sm:col-span-2"
                >
                  <Input {...register('successCriteria')} maxLength={1000} />
                </Field>
                <Field label="Sample size" error={errors.sampleSize?.message}>
                  <Input inputMode="numeric" {...register('sampleSize')} />
                </Field>
              </div>
              <Controller
                control={control}
                name="status"
                render={({ field }) => (
                  <Field label="Status">
                    <FieldSelect
                      value={field.value}
                      onValueChange={field.onChange}
                      options={EXPERIMENT_STATUS_OPTIONS}
                      className="sm:w-56"
                    />
                  </Field>
                )}
              />
              <Field
                label="Result"
                description="What actually happened (numbers, not adjectives)."
                error={errors.result?.message}
              >
                <Textarea {...register('result')} minRows={2} maxRows={5} maxLength={2000} />
              </Field>
              <Field
                label="Interpretation"
                description="What the result means for the hypothesis."
                error={errors.interpretation?.message}
              >
                <Textarea {...register('interpretation')} minRows={2} maxRows={5} maxLength={2000} />
              </Field>
            </>
          ) : null}

          {kind === 'milestone' ? (
            <>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Target date" required error={errors.date?.message}>
                  <Input type="date" {...register('date')} />
                </Field>
                <Field label="Owner" error={errors.owner?.message}>
                  <Input {...register('owner')} maxLength={120} autoComplete="off" />
                </Field>
                <Controller
                  control={control}
                  name="status"
                  render={({ field }) => (
                    <Field label="Status">
                      <FieldSelect
                        value={field.value}
                        onValueChange={field.onChange}
                        options={MILESTONE_STATUS_OPTIONS}
                      />
                    </Field>
                  )}
                />
              </div>
              <Field
                label="Depends on"
                description="Another milestone, decision or external event."
                error={errors.dependency?.message}
              >
                <Input {...register('dependency')} maxLength={300} />
              </Field>
            </>
          ) : null}

          <Controller
            control={control}
            name="visibility"
            render={({ field }) => (
              <Field label="Visibility" description={VISIBILITY_LABELS[field.value].description}>
                <FieldSelect
                  value={field.value}
                  onValueChange={field.onChange}
                  options={VISIBILITY_OPTIONS}
                  className="sm:w-56"
                />
              </Field>
            )}
          />

          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" loading={pending} loadingText="Saving…">
              {editing ? 'Save changes' : `Add ${copy.noun}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
