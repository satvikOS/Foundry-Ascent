import { zodResolver } from '@hookform/resolvers/zod';
import { Send } from 'lucide-react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
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
import { StatusBadge } from '@/components/ui/status-badge';
import {
  applyServerFieldErrors,
  dateInputToIso,
  MutationErrorAlert,
  SelectField,
  todayDateInput,
} from '@/features/admin/shared/form';
import { useRouteEscalation, type EscalationQueueEntry } from '@/lib/api/hooks/program';
import { ESCALATION_CATEGORY_LABELS } from '@/lib/labels';

import type { AssigneeOption } from './assignees';

function routeForm(today: string) {
  return z.object({
    assigneeId: z.string().min(1, 'Choose who should handle this escalation.'),
    dueDate: z
      .string()
      .refine((value) => value === '' || dateInputToIso(value) !== null, 'Enter a valid date.')
      .refine((value) => value === '' || value >= today, 'The due date can’t be in the past.'),
  });
}
type RouteFormValues = z.infer<ReturnType<typeof routeForm>>;

interface RouteEscalationDialogProps {
  escalation: EscalationQueueEntry | null;
  /** The tenant's EIRs and program leads (`GET /program/assignees`). */
  options: readonly AssigneeOption[];
  optionsState: 'loading' | 'error' | 'ready';
  onClose: () => void;
}

/**
 * Assign a consented escalation to an EIR or program lead, with an optional due date. The person is
 * chosen from the tenant directory (never typed in); the dialog shows metadata only, no packet content.
 */
export function RouteEscalationDialog({
  escalation,
  options,
  optionsState,
  onClose,
}: RouteEscalationDialogProps) {
  return (
    <Dialog
      open={escalation !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        {escalation ? (
          <RouteForm
            key={escalation.id}
            escalation={escalation}
            options={options}
            optionsState={optionsState}
            onClose={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RouteForm({
  escalation,
  options,
  optionsState,
  onClose,
}: Omit<RouteEscalationDialogProps, 'escalation'> & { escalation: EscalationQueueEntry }) {
  const route = useRouteEscalation();
  const today = todayDateInput();
  const currentDue = escalation.dueAt ? todayDateInput(new Date(escalation.dueAt)) : '';
  const { register, control, handleSubmit, formState, setError } = useForm<RouteFormValues>({
    resolver: zodResolver(routeForm(today)),
    defaultValues: {
      assigneeId: options.some((o) => o.id === escalation.assigneeId) ? (escalation.assigneeId ?? '') : '',
      dueDate: currentDue >= today ? currentDue : '',
    },
  });

  const onSubmit = handleSubmit((values) => {
    route.mutate(
      {
        escalationId: escalation.id,
        route: {
          assigneeId: values.assigneeId,
          dueAt: values.dueDate ? dateInputToIso(values.dueDate) : null,
        },
      },
      {
        onSuccess: () => {
          const name = options.find((o) => o.id === values.assigneeId)?.name ?? 'the assignee';
          toast.success(`Routed to ${name}`);
          announce('Escalation routed');
          onClose();
        },
        onError: (error) => {
          applyServerFieldErrors(error, setError, ['assigneeId', 'dueDate'], (path) =>
            path === 'dueAt' ? 'dueDate' : path,
          );
        },
      },
    );
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Send aria-hidden className="size-4" />
          {escalation.assigneeId ? 'Reassign escalation' : 'Route escalation'}
        </DialogTitle>
        <DialogDescription>
          {escalation.ventureName} · {ESCALATION_CATEGORY_LABELS[escalation.category]}
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge kind="escalationPriority" status={escalation.priority} />
        <StatusBadge kind="escalationStatus" status={escalation.status} />
      </div>
      <form noValidate onSubmit={(event) => void onSubmit(event)} className="grid gap-4">
        <Controller
          control={control}
          name="assigneeId"
          render={({ field }) => (
            <SelectField
              label="Assignee"
              required
              placeholder={optionsState === 'loading' ? 'Loading people…' : 'Choose a person'}
              disabled={optionsState !== 'ready' || options.length === 0}
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              options={options.map((o) => ({
                value: o.id,
                label: o.detail ? `${o.name} — ${o.detail}` : o.name,
              }))}
              error={formState.errors.assigneeId?.message}
            />
          )}
        />
        {optionsState === 'error' ? (
          <Alert variant="warning">Couldn’t load the people you can route to. Close and try again.</Alert>
        ) : optionsState === 'ready' && options.length === 0 ? (
          <Alert variant="info">
            No EIRs or program leads are set up yet. Ask a platform admin to add one in Principals.
          </Alert>
        ) : (
          <p className="text-[13px] text-muted-foreground">
            Only EIRs and program staff of your program can receive an escalation.
          </p>
        )}
        <Field
          label="Due date"
          description="Optional. Due at 5 pm your time on this day."
          error={formState.errors.dueDate?.message}
        >
          <Input type="date" min={today} {...register('dueDate')} />
        </Field>
        <p className="text-[13px] text-muted-foreground">
          The founder approved sharing, so the assignee will see the escalation packet.
        </p>
        <MutationErrorAlert error={route.error} title="Couldn’t route the escalation" />
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={route.isPending}>
            Cancel
          </Button>
          <Button type="submit" loading={route.isPending} loadingText="Routing…">
            {escalation.assigneeId ? 'Reassign' : 'Route'}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
