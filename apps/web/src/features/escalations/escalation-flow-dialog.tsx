import { zodResolver } from '@hookform/resolvers/zod';
import {
  EscalationCategory,
  EscalationPriority,
  RequestedRole,
  type EscalationView,
} from '@foundry/contracts';
import { CircleCheck, Pencil } from 'lucide-react';
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
import { getStatusDefinition } from '@/components/ui/status-badge';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '@/lib/api/errors';
import { useCreateEscalation, useEscalationAction } from '@/lib/api/hooks/escalations';
import { ESCALATION_CATEGORY_LABELS, REQUESTED_ROLE_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';
import { FieldSelect, type FieldSelectOption } from '@/features/venture/field-select';
import { applyFieldErrors } from '@/features/venture/form-errors';

import { ConsentForm } from './consent-form';
import { EscalationPacketView } from './packet-view';

type Category = z.infer<typeof EscalationCategory>;
type Priority = z.infer<typeof EscalationPriority>;
type Role = z.infer<typeof RequestedRole>;

export interface EscalationDraft {
  turnId?: string | null;
  category?: Category | null;
  priority?: Priority | null;
  requestedRole?: Role | null;
  founderQuestion?: string;
  desiredDecision?: string | null;
}

const DetailsSchema = z.object({
  category: EscalationCategory,
  priority: EscalationPriority,
  requestedRole: RequestedRole,
  founderQuestion: z
    .string()
    .trim()
    .min(1, 'Say what you need help with.')
    .max(2000, 'Keep it under 2,000 characters.'),
  desiredDecision: z.string().trim().max(1000, 'Keep it under 1,000 characters.'),
});
type DetailsInput = z.input<typeof DetailsSchema>;
type DetailsOutput = z.output<typeof DetailsSchema>;

const EditSchema = z.object({
  founderQuestion: z.string().trim().min(1, 'Say what you need help with.').max(2000),
  desiredDecision: z.string().trim().max(1000),
  unknowns: z.string().max(4000),
});

const CATEGORY_OPTIONS: FieldSelectOption<Category>[] = EscalationCategory.options.map((c) => ({
  value: c,
  label: ESCALATION_CATEGORY_LABELS[c],
}));
const PRIORITY_OPTIONS: FieldSelectOption<Priority>[] = EscalationPriority.options.map((p) => {
  const def = getStatusDefinition('escalationPriority', p);
  return { value: p, label: def.label, icon: def.icon };
});
const ROLE_OPTIONS: FieldSelectOption<Role>[] = RequestedRole.options.map((r) => ({
  value: r,
  label: REQUESTED_ROLE_LABELS[r] ?? r,
}));

type Step = 'details' | 'review' | 'consent' | 'done';
const STEPS: { id: Exclude<Step, 'done'>; label: string }[] = [
  { id: 'details', label: 'Describe' },
  { id: 'review', label: 'Review packet' },
  { id: 'consent', label: 'Consent' },
];

function StepIndicator({ step }: { step: Step }) {
  const index = step === 'done' ? STEPS.length : STEPS.findIndex((s) => s.id === step);
  return (
    <ol className="flex items-center gap-2 text-xs" aria-label="Steps">
      {STEPS.map((s, i) => (
        <li key={s.id} className="flex items-center gap-2" aria-current={i === index ? 'step' : undefined}>
          <span
            className={cn(
              'flex size-5 items-center justify-center rounded-full border text-[11px] font-semibold',
              i < index && 'border-foreground bg-foreground text-background',
              i === index && 'border-foreground',
              i > index && 'border-dashed border-border-strong text-muted-foreground',
            )}
          >
            {i < index ? <CircleCheck aria-hidden className="size-3.5" /> : i + 1}
          </span>
          <span className={cn(i === index ? 'font-medium text-foreground' : 'text-muted-foreground')}>
            {s.label}
            <span className="sr-only">{i < index ? ' (done)' : i === index ? ' (current)' : ''}</span>
          </span>
          {i < STEPS.length - 1 ? <span aria-hidden className="h-px w-4 bg-border-strong" /> : null}
        </li>
      ))}
    </ol>
  );
}

interface EscalationFlowDialogProps {
  ventureId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Prefill for a new request (e.g. from a coach response's escalation proposal). */
  draft?: EscalationDraft | null;
  /** Continue an existing request at review/consent instead of creating one. */
  existing?: EscalationView | null;
  /** "View in Escalations" after completion. */
  onViewEscalation?: (escalation: EscalationView) => void;
}

/**
 * Request human support in three steps: describe → review the AI-drafted packet → consent to what is
 * shared. Closing midway keeps the request as a draft that can be finished from the Escalations page.
 */
export function EscalationFlowDialog({
  ventureId,
  open,
  onOpenChange,
  draft,
  existing,
  onViewEscalation,
}: EscalationFlowDialogProps) {
  const create = useCreateEscalation(ventureId);
  const edit = useEscalationAction();
  const [step, setStep] = useState<Step>('details');
  const [escalation, setEscalation] = useState<EscalationView | null>(null);
  const [editing, setEditing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const details = useForm<DetailsInput, unknown, DetailsOutput>({
    resolver: zodResolver(DetailsSchema),
    defaultValues: {
      category: 'expert_judgment',
      priority: 'P2',
      requestedRole: 'eir',
      founderQuestion: '',
      desiredDecision: '',
    },
  });
  const editForm = useForm<z.input<typeof EditSchema>, unknown, z.output<typeof EditSchema>>({
    resolver: zodResolver(EditSchema),
    defaultValues: { founderQuestion: '', desiredDecision: '', unknowns: '' },
  });

  useEffect(() => {
    if (!open) return;
    setFormError(null);
    setEditing(false);
    if (existing) {
      setEscalation(existing);
      setStep(existing.status === 'draft' || existing.status === 'awaiting_consent' ? 'review' : 'done');
      return;
    }
    setEscalation(null);
    setStep('details');
    create.reset();
    details.reset({
      category: draft?.category ?? 'expert_judgment',
      priority: draft?.priority ?? 'P2',
      requestedRole: draft?.requestedRole ?? 'eir',
      founderQuestion: draft?.founderQuestion ?? '',
      desiredDecision: draft?.desiredDecision ?? '',
    });
    // Reset only when the dialog opens.
  }, [open]);

  const submitDetails = details.handleSubmit((values) => {
    setFormError(null);
    create.mutate(
      {
        turnId: draft?.turnId ?? null,
        category: values.category,
        priority: values.priority,
        requestedRole: values.requestedRole,
        founderQuestion: values.founderQuestion,
        desiredDecision: values.desiredDecision || null,
      },
      {
        onSuccess: (created) => {
          setEscalation(created);
          setStep('review');
          announce('Request drafted. Review the packet.');
        },
        onError: (error) => {
          if (
            !applyFieldErrors(error, details.setError, [
              'category',
              'priority',
              'requestedRole',
              'founderQuestion',
              'desiredDecision',
            ])
          ) {
            setFormError(errorMessage(error));
          }
        },
      },
    );
  });

  const startEdit = () => {
    if (!escalation?.packet) return;
    editForm.reset({
      founderQuestion: escalation.packet.founderQuestion,
      desiredDecision: escalation.packet.desiredDecision ?? '',
      unknowns: escalation.packet.unknowns.join('\n'),
    });
    setEditing(true);
  };

  const submitEdit = editForm.handleSubmit((values) => {
    if (!escalation) return;
    setFormError(null);
    edit.mutate(
      {
        escalationId: escalation.id,
        action: {
          action: 'edit',
          packet: {
            founderQuestion: values.founderQuestion,
            desiredDecision: values.desiredDecision || null,
            unknowns: values.unknowns
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean),
          },
        },
      },
      {
        onSuccess: (updated) => {
          setEscalation(updated);
          setEditing(false);
          announce('Packet updated');
        },
        onError: (error) => {
          setFormError(errorMessage(error));
        },
      },
    );
  });

  const role = escalation ? (REQUESTED_ROLE_LABELS[escalation.requestedRole] ?? 'a person') : 'a person';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Request human support</DialogTitle>
          <DialogDescription>
            Foundry Guide drafts a short packet for {step === 'details' ? 'an EIR or specialist' : role}. You
            review it and choose what is shared — nothing leaves your workspace before you consent.
          </DialogDescription>
        </DialogHeader>
        <StepIndicator step={step} />
        {formError ? (
          <Alert variant="destructive" live="alert">
            {formError}
          </Alert>
        ) : null}

        {step === 'details' ? (
          <form onSubmit={(e) => void submitDetails(e)} noValidate className="grid gap-4">
            <Field
              label="What do you need help with?"
              required
              error={details.formState.errors.founderQuestion?.message}
            >
              <Textarea {...details.register('founderQuestion')} minRows={3} maxRows={8} maxLength={2000} />
            </Field>
            <Field
              label="What decision are you trying to make? (optional)"
              error={details.formState.errors.desiredDecision?.message}
            >
              <Textarea {...details.register('desiredDecision')} minRows={2} maxRows={5} maxLength={1000} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-3">
              <Controller
                control={details.control}
                name="category"
                render={({ field }) => (
                  <Field label="Topic">
                    <FieldSelect
                      value={field.value}
                      onValueChange={field.onChange}
                      options={CATEGORY_OPTIONS}
                    />
                  </Field>
                )}
              />
              <Controller
                control={details.control}
                name="priority"
                render={({ field }) => (
                  <Field
                    label="Urgency"
                    description={getStatusDefinition('escalationPriority', field.value).description}
                  >
                    <FieldSelect
                      value={field.value}
                      onValueChange={field.onChange}
                      options={PRIORITY_OPTIONS}
                    />
                  </Field>
                )}
              />
              <Controller
                control={details.control}
                name="requestedRole"
                render={({ field }) => (
                  <Field label="Who should help">
                    <FieldSelect value={field.value} onValueChange={field.onChange} options={ROLE_OPTIONS} />
                  </Field>
                )}
              />
            </div>
            <DialogFooter>
              <Button
                variant="secondary"
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" loading={create.isPending} loadingText="Drafting packet…">
                Draft packet
              </Button>
            </DialogFooter>
          </form>
        ) : null}

        {step === 'review' && escalation ? (
          <div className="grid gap-4">
            {editing ? (
              <form onSubmit={(e) => void submitEdit(e)} noValidate className="grid gap-4">
                <Field
                  label="Your question"
                  required
                  error={editForm.formState.errors.founderQuestion?.message}
                >
                  <Textarea {...editForm.register('founderQuestion')} minRows={3} maxLength={2000} />
                </Field>
                <Field
                  label="Decision you want to make"
                  error={editForm.formState.errors.desiredDecision?.message}
                >
                  <Textarea {...editForm.register('desiredDecision')} minRows={2} maxLength={1000} />
                </Field>
                <Field
                  label="Unknowns"
                  description="One per line."
                  error={editForm.formState.errors.unknowns?.message}
                >
                  <Textarea {...editForm.register('unknowns')} minRows={3} />
                </Field>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setEditing(false);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" loading={edit.isPending}>
                    Save packet
                  </Button>
                </div>
              </form>
            ) : escalation.packet ? (
              <EscalationPacketView packet={escalation.packet} />
            ) : (
              <Alert variant="info" title="The packet is being prepared">
                You can continue to consent; the packet will appear on the Escalations page.
              </Alert>
            )}
            {!editing ? (
              <DialogFooter>
                <Button
                  variant="secondary"
                  onClick={() => {
                    onOpenChange(false);
                  }}
                >
                  Finish later
                </Button>
                {escalation.packet ? (
                  <Button variant="secondary" onClick={startEdit}>
                    <Pencil aria-hidden />
                    Edit
                  </Button>
                ) : null}
                <Button
                  onClick={() => {
                    setStep('consent');
                  }}
                >
                  Continue to consent
                </Button>
              </DialogFooter>
            ) : null}
          </div>
        ) : null}

        {step === 'consent' && escalation ? (
          <ConsentForm
            escalation={escalation}
            onCancel={() => {
              setStep('review');
            }}
            onConsented={(updated) => {
              setEscalation(updated);
              setStep('done');
            }}
          />
        ) : null}

        {step === 'done' && escalation ? (
          <div className="grid gap-4">
            <Alert
              variant="success"
              title={
                escalation.status === 'awaiting_assignment'
                  ? 'Shared with the program team'
                  : escalation.sharingConsentAt
                    ? `Shared with ${escalation.assignee?.displayName ?? role}`
                    : 'Request saved'
              }
            >
              {escalation.status === 'awaiting_assignment'
                ? `They’ll assign the right person (${role}). You’ll see who, and every status change, on the Escalations page.`
                : escalation.sharingConsentAt
                  ? 'You’ll see their response and every status change on the Escalations page.'
                  : 'Track this request on the Escalations page.'}
            </Alert>
            <DialogFooter>
              {onViewEscalation ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    onViewEscalation(escalation);
                    onOpenChange(false);
                  }}
                >
                  View in Escalations
                </Button>
              ) : null}
              <Button
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
