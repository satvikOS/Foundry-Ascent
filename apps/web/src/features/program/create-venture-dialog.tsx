import { zodResolver } from '@hookform/resolvers/zod';
import { VentureDomain, VentureStage } from '@foundry/contracts';
import { CircleCheck, Rocket, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
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
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { applyServerFieldErrors, MutationErrorAlert, SelectField } from '@/features/admin/shared/form';
import { useCreateProgramVenture } from '@/lib/api/hooks/program';
import { DOMAIN_LABELS, STAGE_LABELS, STAGE_ORDER } from '@/lib/labels';

const VentureForm = z.object({
  name: z.string().trim().min(3, 'Use at least 3 characters.').max(80, 'Use 80 characters or fewer.'),
  oneLiner: z.string().trim().max(280, 'Keep the one-liner to 280 characters.'),
  stage: VentureStage,
  domain: VentureDomain,
  cohort: z.string().trim().max(60, 'Use 60 characters or fewer.'),
});
type VentureFormValues = z.infer<typeof VentureForm>;

const STAGE_OPTIONS = STAGE_ORDER.map((stage) => ({ value: stage, label: STAGE_LABELS[stage] }));
const DOMAIN_OPTIONS = VentureDomain.options.map((domain) => ({
  value: domain,
  label: DOMAIN_LABELS[domain] ?? domain,
}));

interface CreateVentureDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Continue to inviting the founder of the newly enrolled venture. */
  onInvite: (venture: { id: string; name: string }) => void;
}

/** Enrol a venture (program lead). On success offers the next step: inviting its founder. */
export function CreateVentureDialog({ open, onOpenChange, onInvite }: CreateVentureDialogProps) {
  const create = useCreateProgramVenture();
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null);
  const { register, control, handleSubmit, formState, setError, reset } = useForm<VentureFormValues>({
    resolver: zodResolver(VentureForm),
    defaultValues: { name: '', oneLiner: '', stage: 'idea', domain: 'general', cohort: '' },
  });

  const close = () => {
    onOpenChange(false);
    setCreated(null);
    create.reset();
    reset();
  };

  const onSubmit = handleSubmit((values) => {
    create.mutate(
      { ...values, cohort: values.cohort === '' ? null : values.cohort },
      {
        onSuccess: (result) => {
          setCreated({ id: result.id, name: values.name });
          announce('Venture enrolled');
        },
        onError: (error) => {
          applyServerFieldErrors(error, setError, ['name', 'oneLiner', 'stage', 'domain', 'cohort']);
        },
      },
    );
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !create.isPending) close();
      }}
    >
      <DialogContent className="max-w-lg">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CircleCheck aria-hidden className="size-4 text-success" />
                {created.name} is enrolled
              </DialogTitle>
              <DialogDescription>
                Next, invite its founder. They get a one-time access code to sign in.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="secondary" onClick={close}>
                Done
              </Button>
              <Button
                onClick={() => {
                  const venture = created;
                  close();
                  onInvite(venture);
                }}
              >
                <UserPlus aria-hidden />
                Invite founder
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Rocket aria-hidden className="size-4" />
                Enrol a venture
              </DialogTitle>
              <DialogDescription>
                Creates a private venture workspace. Only its members (and its assigned EIR) can see its
                content.
              </DialogDescription>
            </DialogHeader>
            <form noValidate onSubmit={(event) => void onSubmit(event)} className="grid gap-4">
              <Field
                label="Venture name"
                required
                description="A distinctive name, unique in the program (not a common word such as “Pilot”)."
                error={formState.errors.name?.message}
              >
                <Input autoComplete="off" {...register('name')} />
              </Field>
              <Field
                label="One-liner"
                description="What it does, for whom — in a sentence."
                error={formState.errors.oneLiner?.message}
              >
                <Textarea minRows={2} maxRows={4} {...register('oneLiner')} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Controller
                  control={control}
                  name="stage"
                  render={({ field }) => (
                    <SelectField
                      label="Stage"
                      value={field.value}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      options={STAGE_OPTIONS}
                      error={formState.errors.stage?.message}
                    />
                  )}
                />
                <Controller
                  control={control}
                  name="domain"
                  render={({ field }) => (
                    <SelectField
                      label="Domain"
                      value={field.value}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      options={DOMAIN_OPTIONS}
                      error={formState.errors.domain?.message}
                    />
                  )}
                />
              </div>
              <Field
                label="Cohort"
                description="Optional, e.g. “Spring 2027”."
                error={formState.errors.cohort?.message}
              >
                <Input autoComplete="off" {...register('cohort')} />
              </Field>
              <MutationErrorAlert error={create.error} title="Couldn’t enrol the venture" />
              <DialogFooter>
                <Button variant="secondary" onClick={close} disabled={create.isPending}>
                  Cancel
                </Button>
                <Button type="submit" loading={create.isPending} loadingText="Enrolling…">
                  Enrol venture
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
