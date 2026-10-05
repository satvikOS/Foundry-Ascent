import { zodResolver } from '@hookform/resolvers/zod';
import type { EscalationView } from '@foundry/contracts';
import { Ban, CircleCheck, Hand } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { announce } from '@/components/a11y/live-announcer';
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
import { Textarea } from '@/components/ui/textarea';
import { MutationErrorAlert, parseLines } from '@/features/admin/shared/form';
import { errorMessage } from '@/lib/api/errors';
import { useEscalationAction } from '@/lib/api/hooks/escalations';

const ResolveForm = z.object({
  summary: z
    .string()
    .trim()
    .min(1, 'Summarise the outcome for the founder.')
    .max(4000, 'Use 4,000 characters or fewer.'),
  nextSteps: z.string().superRefine((value, ctx) => {
    const steps = parseLines(value);
    if (steps.length > 10) ctx.addIssue({ code: 'custom', message: 'List at most 10 next steps.' });
    if (steps.some((step) => step.length > 500)) {
      ctx.addIssue({ code: 'custom', message: 'Keep each next step to 500 characters.' });
    }
  }),
});
type ResolveFormValues = z.infer<typeof ResolveForm>;

const DeclineForm = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'Tell the founder and program lead why you’re declining.')
    .max(1000, 'Use 1,000 characters or fewer.'),
});
type DeclineFormValues = z.infer<typeof DeclineForm>;

export function canAcknowledge(escalation: Pick<EscalationView, 'status'>): boolean {
  return escalation.status === 'routed';
}

export function canClose(escalation: Pick<EscalationView, 'status'>): boolean {
  return escalation.status === 'routed' || escalation.status === 'acknowledged';
}

/** Assignee actions on an escalation in the inbox: acknowledge, resolve, decline. */
export function InboxActions({ escalation }: { escalation: EscalationView }) {
  const action = useEscalationAction();
  const [dialog, setDialog] = useState<'resolve' | 'decline' | null>(null);

  if (!canAcknowledge(escalation) && !canClose(escalation)) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {canAcknowledge(escalation) ? (
        <Button
          loading={action.isPending && dialog === null}
          loadingText="Acknowledging…"
          onClick={() => {
            action.mutate(
              { escalationId: escalation.id, action: { action: 'acknowledge' } },
              {
                onSuccess: () => {
                  toast.success('Escalation acknowledged');
                  announce('Escalation acknowledged');
                },
                onError: (error) => {
                  toast.error(errorMessage(error));
                },
              },
            );
          }}
        >
          <Hand aria-hidden />
          Acknowledge
        </Button>
      ) : null}
      {canClose(escalation) ? (
        <>
          <Button
            variant={canAcknowledge(escalation) ? 'secondary' : 'default'}
            onClick={() => {
              setDialog('resolve');
            }}
          >
            <CircleCheck aria-hidden />
            Resolve…
          </Button>
          <Button
            variant="destructive-outline"
            onClick={() => {
              setDialog('decline');
            }}
          >
            <Ban aria-hidden />
            Decline…
          </Button>
        </>
      ) : null}

      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !action.isPending) {
            setDialog(null);
            action.reset();
          }
        }}
      >
        <DialogContent className="max-w-lg">
          {dialog === 'resolve' ? (
            <ResolveBody
              escalation={escalation}
              pending={action.isPending}
              error={action.error}
              onSubmit={(values) => {
                action.mutate(
                  {
                    escalationId: escalation.id,
                    action: {
                      action: 'resolve',
                      resolution: { summary: values.summary, nextSteps: parseLines(values.nextSteps) },
                    },
                  },
                  {
                    onSuccess: () => {
                      setDialog(null);
                      toast.success('Escalation resolved');
                      announce('Escalation resolved');
                    },
                  },
                );
              }}
              onCancel={() => {
                setDialog(null);
              }}
            />
          ) : dialog === 'decline' ? (
            <DeclineBody
              pending={action.isPending}
              error={action.error}
              onSubmit={(values) => {
                action.mutate(
                  { escalationId: escalation.id, action: { action: 'decline', reason: values.reason } },
                  {
                    onSuccess: () => {
                      setDialog(null);
                      toast.success('Escalation declined');
                      announce('Escalation declined');
                    },
                  },
                );
              }}
              onCancel={() => {
                setDialog(null);
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ResolveBody({
  escalation,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  escalation: EscalationView;
  pending: boolean;
  error: unknown;
  onSubmit: (values: ResolveFormValues) => void;
  onCancel: () => void;
}) {
  const { register, handleSubmit, formState } = useForm<ResolveFormValues>({
    resolver: zodResolver(ResolveForm),
    defaultValues: { summary: '', nextSteps: '' },
  });
  return (
    <>
      <DialogHeader>
        <DialogTitle>Resolve escalation</DialogTitle>
        <DialogDescription>
          {escalation.ventureName} will see your summary and next steps. Write them for the founder.
        </DialogDescription>
      </DialogHeader>
      <form noValidate onSubmit={(event) => void handleSubmit(onSubmit)(event)} className="grid gap-4">
        <Field label="Outcome summary" required error={formState.errors.summary?.message}>
          <Textarea minRows={4} maxRows={12} {...register('summary')} />
        </Field>
        <Field
          label="Next steps"
          description="Optional. One per line, up to 10."
          error={formState.errors.nextSteps?.message}
        >
          <Textarea minRows={3} maxRows={10} {...register('nextSteps')} />
        </Field>
        <MutationErrorAlert error={error} title="Couldn’t resolve the escalation" />
        <DialogFooter>
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" loading={pending} loadingText="Resolving…">
            Resolve
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

function DeclineBody({
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  pending: boolean;
  error: unknown;
  onSubmit: (values: DeclineFormValues) => void;
  onCancel: () => void;
}) {
  const { register, handleSubmit, formState } = useForm<DeclineFormValues>({
    resolver: zodResolver(DeclineForm),
    defaultValues: { reason: '' },
  });
  return (
    <>
      <DialogHeader>
        <DialogTitle>Decline escalation</DialogTitle>
        <DialogDescription>
          Use this if it’s outside your expertise or you can’t take it on. Your reason is shared so it can be
          re-routed quickly.
        </DialogDescription>
      </DialogHeader>
      <form noValidate onSubmit={(event) => void handleSubmit(onSubmit)(event)} className="grid gap-4">
        <Field label="Reason" required error={formState.errors.reason?.message}>
          <Textarea minRows={3} maxRows={8} {...register('reason')} />
        </Field>
        <MutationErrorAlert error={error} title="Couldn’t decline the escalation" />
        <DialogFooter>
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" variant="destructive" loading={pending} loadingText="Declining…">
            Decline
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
