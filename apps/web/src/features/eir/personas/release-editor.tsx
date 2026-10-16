import { zodResolver } from '@hookform/resolvers/zod';
import { CoachMode, DEFAULT_DISCLOSURE, type PersonaReleaseView } from '@foundry/contracts';
import { Plus, Trash2 } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Controller, useFieldArray, useForm, type Control, type FieldPath } from 'react-hook-form';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { SectionCard } from '@/components/ui/section-card';
import { Textarea } from '@/components/ui/textarea';
import { MutationErrorAlert } from '@/features/admin/shared/form';
import type { CreatePersonaReleaseInput } from '@/lib/api/hooks/eir';
import { MODE_LABELS } from '@/lib/labels';

import { STYLE_OPTIONS } from './persona-labels';
import {
  EMPTY_FRAMEWORK,
  formToRelease,
  releaseToForm,
  ReleaseFormSchema,
  type ReleaseFormValues,
} from './release-form';

const ONE_PER_LINE = 'One per line.';

function StyleDial({
  control,
  name,
  label,
}: {
  control: Control<ReleaseFormValues>;
  name: 'directness' | 'warmth' | 'pace';
  label: string;
}) {
  const id = useId();
  const options: readonly { value: string; label: string; description: string }[] = STYLE_OPTIONS[name];
  return (
    <Controller
      control={control}
      name={name}
      render={({ field }) => (
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">{label}</legend>
          <RadioGroup value={field.value} onValueChange={field.onChange} aria-label={label} className="gap-2">
            {options.map((option, index) => (
              <div key={option.value} className="flex items-start gap-2.5">
                <RadioGroupItem
                  id={`${id}-${option.value}`}
                  value={option.value}
                  className="mt-0.5"
                  ref={index === 0 ? field.ref : undefined}
                  aria-describedby={`${id}-${option.value}-desc`}
                />
                <div className="grid gap-0.5">
                  <Label htmlFor={`${id}-${option.value}`}>{option.label}</Label>
                  <span id={`${id}-${option.value}-desc`} className="text-xs text-muted-foreground">
                    {option.description}
                  </span>
                </div>
              </div>
            ))}
          </RadioGroup>
        </fieldset>
      )}
    />
  );
}

interface ReleaseEditorProps {
  /** Card title and the form's accessible name. */
  title: string;
  description: string;
  submitLabel: string;
  submittingLabel: string;
  /** Prefill source (normally the newest release). */
  base: PersonaReleaseView | null;
  /** Disclosure for a blank release. */
  defaultDisclosure?: string;
  pending: boolean;
  error: unknown;
  /** Fields shown above the doctrine (e.g. who a new vEIR is built from). */
  leading?: ReactNode;
  onSubmit: (input: CreatePersonaReleaseInput) => void;
  onCancel: () => void;
}

/**
 * Editor for a persona's doctrine, style, disclosure and modes. Submitting creates a DRAFT release; nothing
 * changes for founders until a person approves it.
 */
export function ReleaseEditor({
  title,
  description,
  submitLabel,
  submittingLabel,
  base,
  defaultDisclosure = DEFAULT_DISCLOSURE,
  pending,
  error,
  leading,
  onSubmit,
  onCancel,
}: ReleaseEditorProps) {
  const ids = { modes: useId() };
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const { register, control, handleSubmit, formState } = useForm<ReleaseFormValues>({
    resolver: zodResolver(ReleaseFormSchema),
    defaultValues: releaseToForm(base, defaultDisclosure),
  });
  const frameworks = useFieldArray({ control, name: 'frameworks' });
  const e = formState.errors;

  const textarea = (name: FieldPath<ReleaseFormValues>, rows = 3) => (
    <Textarea minRows={rows} maxRows={12} {...register(name)} />
  );

  return (
    <SectionCard title={title} description={description}>
      {leading}
      <form
        noValidate
        aria-label={title}
        onSubmit={(event) =>
          void handleSubmit((values) => {
            onSubmit(formToRelease(values));
          })(event)
        }
        className="grid gap-8"
      >
        {formState.isSubmitted && Object.keys(e).length > 0 ? (
          <Alert variant="destructive" live="alert" title="Some fields need attention">
            Fix the highlighted fields, then try again.
          </Alert>
        ) : null}

        <fieldset className="grid gap-5">
          <legend className="mb-3 text-base font-semibold">Doctrine</legend>
          <Field
            label="Summary"
            required
            description="What this persona believes about building ventures, in a paragraph."
            error={e.summary?.message}
          >
            {textarea('summary', 4)}
          </Field>

          <div className="grid gap-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Frameworks</h3>
              <Button
                variant="secondary"
                size="sm"
                disabled={frameworks.fields.length >= 12}
                onClick={() => {
                  frameworks.append({ ...EMPTY_FRAMEWORK });
                }}
              >
                <Plus aria-hidden />
                Add framework
              </Button>
            </div>
            {frameworks.fields.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border-strong px-4 py-3 text-small text-muted-foreground">
                No frameworks yet. Add the methods this persona teaches (e.g. jobs-to-be-done, assumption
                mapping).
              </p>
            ) : null}
            {e.frameworks?.message ? (
              <p className="text-small text-destructive">{e.frameworks.message}</p>
            ) : null}
            <ol className="grid gap-3">
              {frameworks.fields.map((item, index) => (
                <li key={item.id} className="grid gap-3 rounded-lg border border-border px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-small font-medium text-muted-foreground">
                      Framework {index + 1}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove framework ${index + 1}`}
                      onClick={() => {
                        frameworks.remove(index);
                      }}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Name" required error={e.frameworks?.[index]?.name?.message}>
                      <Input autoComplete="off" {...register(`frameworks.${index}.name`)} />
                    </Field>
                    <Field label="When to use it" required error={e.frameworks?.[index]?.whenToUse?.message}>
                      <Input autoComplete="off" {...register(`frameworks.${index}.whenToUse`)} />
                    </Field>
                  </div>
                  <Field
                    label="Key questions"
                    required
                    description={ONE_PER_LINE}
                    error={e.frameworks?.[index]?.keyQuestions?.message}
                  >
                    {textarea(`frameworks.${index}.keyQuestions`)}
                  </Field>
                </li>
              ))}
            </ol>
          </div>

          <Field
            label="Evidence standard"
            required
            description="What counts as evidence before the coach treats something as fact."
            error={e.evidenceStandard?.message}
          >
            {textarea('evidenceStandard')}
          </Field>
          <div className="grid gap-5 md:grid-cols-2">
            <Field label="Typical questions" description={ONE_PER_LINE} error={e.typicalQuestions?.message}>
              {textarea('typicalQuestions', 4)}
            </Field>
            <Field
              label="Teaching principles"
              description={ONE_PER_LINE}
              error={e.teachingPrinciples?.message}
            >
              {textarea('teachingPrinciples', 4)}
            </Field>
            <Field
              label="Red lines"
              required
              description="Things the coach must never do or advise. One per line."
              error={e.redLines?.message}
            >
              {textarea('redLines', 4)}
            </Field>
            <Field
              label="Escalation topics"
              required
              description="Topics always handed to a human. One per line."
              error={e.escalationTopics?.message}
            >
              {textarea('escalationTopics', 4)}
            </Field>
            <Field
              label="Referral destinations"
              description="Where to send founders (offices, clinics, programs). One per line."
              error={e.referralDestinations?.message}
            >
              {textarea('referralDestinations', 3)}
            </Field>
          </div>
        </fieldset>

        <fieldset className="grid gap-5">
          <legend className="mb-3 text-base font-semibold">Style</legend>
          <div className="grid gap-5 md:grid-cols-3">
            <StyleDial control={control} name="directness" label="Directness" />
            <StyleDial control={control} name="warmth" label="Warmth" />
            <StyleDial control={control} name="pace" label="Pace" />
          </div>
          <Field
            label="Feedback structure"
            required
            description="How feedback is organised, e.g. “what’s working → biggest risk → one next step”."
            error={e.feedbackStructure?.message}
          >
            {textarea('feedbackStructure')}
          </Field>
          <div className="grid gap-5 md:grid-cols-2">
            <Field
              label="Vocabulary"
              description="Preferred terms. One per line."
              error={e.vocabulary?.message}
            >
              {textarea('vocabulary')}
            </Field>
            <Field
              label="Avoid"
              description="Phrases, habits or tones to avoid. One per line."
              error={e.avoid?.message}
            >
              {textarea('avoid')}
            </Field>
          </div>
        </fieldset>

        <fieldset className="grid gap-5">
          <legend className="mb-3 text-base font-semibold">Disclosure and modes</legend>
          <Field
            label="Disclosure"
            required
            description="Shown in every conversation. Must say plainly that it’s an AI."
            error={e.disclosureText?.message}
          >
            {textarea('disclosureText')}
          </Field>
          <Controller
            control={control}
            name="allowedModes"
            render={({ field }) => (
              <fieldset
                className="grid gap-2"
                aria-describedby={e.allowedModes ? `${ids.modes}-error` : undefined}
              >
                <legend className="mb-1 text-sm font-medium">
                  Allowed coaching modes
                  <span aria-hidden className="text-muted-foreground">
                    *
                  </span>
                </legend>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {CoachMode.options.map((mode, index) => {
                    const def = MODE_LABELS[mode];
                    const id = `${ids.modes}-${mode}`;
                    return (
                      <div
                        key={mode}
                        className="flex items-start gap-2.5 rounded-lg border border-border px-3 py-2.5"
                      >
                        <Checkbox
                          id={id}
                          className="mt-0.5"
                          ref={index === 0 ? field.ref : undefined}
                          checked={field.value.includes(mode)}
                          aria-describedby={`${id}-desc`}
                          onCheckedChange={(checked) => {
                            field.onChange(
                              checked === true
                                ? [...field.value, mode]
                                : field.value.filter((m) => m !== mode),
                            );
                          }}
                        />
                        <div className="grid gap-0.5">
                          <Label htmlFor={id}>{def.label}</Label>
                          <span id={`${id}-desc`} className="text-xs text-muted-foreground">
                            {def.description}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {e.allowedModes?.message ? (
                  <p id={`${ids.modes}-error`} className="text-small text-destructive">
                    {e.allowedModes.message}
                  </p>
                ) : null}
              </fieldset>
            )}
          />
        </fieldset>

        <MutationErrorAlert error={error} title="The draft wasn’t created" />

        <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-end">
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() => {
              if (formState.isDirty) setConfirmDiscard(true);
              else onCancel();
            }}
          >
            Cancel
          </Button>
          <Button type="submit" loading={pending} loadingText={submittingLabel}>
            {submitLabel}
          </Button>
        </div>
      </form>

      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard your changes?</AlertDialogTitle>
            <AlertDialogDescription>They haven’t been saved and will be lost.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction destructive onClick={onCancel}>
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  );
}
