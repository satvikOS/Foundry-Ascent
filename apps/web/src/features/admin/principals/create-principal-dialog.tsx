import { zodResolver } from '@hookform/resolvers/zod';
import { PlatformRole } from '@foundry/contracts';
import { CircleCheck, KeyRound, ShieldAlert, UserPlus } from 'lucide-react';
import { useId, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import { announce } from '@/components/a11y/live-announcer';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Label } from '@/components/ui/label';
import { useCreatePrincipal } from '@/lib/api/hooks/admin';
import { ROLE_LABELS } from '@/lib/auth/roles';

import { applyServerFieldErrors, MutationErrorAlert } from '../shared/form';
import type { CodeRecipient } from './issue-access-code-dialog';

export const PLATFORM_ROLE_DESCRIPTIONS: Record<z.infer<typeof PlatformRole>, string> = {
  platform_admin:
    'People, access codes, settings, the AI kill switch, usage and audit. No venture content unless also a member.',
  program_lead:
    'Enrol ventures, invite founders, manage resources, see portfolio aggregates and route escalations.',
  eir: 'Persona studio, calibration reviews and escalations for ventures they are assigned to.',
};

const PrincipalForm = z.object({
  displayName: z.string().trim().min(1, 'Enter the person’s name.').max(120, 'Use 120 characters or fewer.'),
  email: z.union([z.literal(''), z.email('Enter a valid email address, or leave it blank.')]),
  title: z.string().trim().max(120, 'Use 120 characters or fewer.'),
  roles: z.array(PlatformRole),
});
type PrincipalFormValues = z.infer<typeof PrincipalForm>;

interface CreatePrincipalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIssueCode: (recipient: CodeRecipient) => void;
}

export function CreatePrincipalDialog({ open, onOpenChange, onIssueCode }: CreatePrincipalDialogProps) {
  const create = useCreatePrincipal();
  const [created, setCreated] = useState<CodeRecipient | null>(null);
  const rolesId = useId();
  const { register, control, handleSubmit, formState, setError, reset, watch } = useForm<PrincipalFormValues>(
    {
      resolver: zodResolver(PrincipalForm),
      defaultValues: { displayName: '', email: '', title: '', roles: [] },
    },
  );
  const grantsAdmin = watch('roles').includes('platform_admin');

  const close = () => {
    onOpenChange(false);
    setCreated(null);
    create.reset();
    reset();
  };

  const onSubmit = handleSubmit((values) => {
    create.mutate(
      {
        displayName: values.displayName,
        email: values.email === '' ? null : values.email,
        title: values.title === '' ? null : values.title,
        roles: values.roles,
      },
      {
        onSuccess: (row) => {
          setCreated({ id: row.principal.id, displayName: row.principal.displayName });
          announce('Principal created');
        },
        onError: (error) => {
          applyServerFieldErrors(error, setError, ['displayName', 'email', 'title', 'roles']);
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
                {created.displayName} was added
              </DialogTitle>
              <DialogDescription>They can’t sign in until you issue an access code.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="secondary" onClick={close}>
                Done
              </Button>
              <Button
                onClick={() => {
                  const recipient = created;
                  close();
                  onIssueCode(recipient);
                }}
              >
                <KeyRound aria-hidden />
                Issue access code
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <UserPlus aria-hidden className="size-4" />
                Add a principal
              </DialogTitle>
              <DialogDescription>
                A person who signs in with an access code. Founders are usually invited from a venture
                instead.
              </DialogDescription>
            </DialogHeader>
            <form noValidate onSubmit={(event) => void onSubmit(event)} className="grid gap-4">
              <Field label="Name" required error={formState.errors.displayName?.message}>
                <Input autoComplete="off" {...register('displayName')} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Email" description="Optional." error={formState.errors.email?.message}>
                  <Input type="email" autoComplete="off" {...register('email')} />
                </Field>
                <Field label="Title" description="Optional." error={formState.errors.title?.message}>
                  <Input autoComplete="off" {...register('title')} />
                </Field>
              </div>
              <Controller
                control={control}
                name="roles"
                render={({ field }) => (
                  <fieldset className="grid gap-2" aria-describedby={`${rolesId}-hint`}>
                    <legend className="text-sm font-medium">Roles</legend>
                    <p id={`${rolesId}-hint`} className="text-[13px] text-muted-foreground">
                      Leave all unchecked for venture-only access (founder, team or advisor).
                    </p>
                    {PlatformRole.options.map((role) => {
                      const id = `${rolesId}-${role}`;
                      return (
                        <div
                          key={role}
                          className="flex items-start gap-2.5 rounded-lg border border-border px-3 py-2.5"
                        >
                          <Checkbox
                            id={id}
                            className="mt-0.5"
                            checked={field.value.includes(role)}
                            aria-describedby={`${id}-desc`}
                            onCheckedChange={(checked) => {
                              field.onChange(
                                checked === true
                                  ? [...field.value, role]
                                  : field.value.filter((r) => r !== role),
                              );
                            }}
                          />
                          <div className="grid gap-0.5">
                            <Label htmlFor={id}>{ROLE_LABELS[role]}</Label>
                            <p id={`${id}-desc`} className="text-[13px] text-muted-foreground">
                              {PLATFORM_ROLE_DESCRIPTIONS[role]}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </fieldset>
                )}
              />
              {grantsAdmin ? (
                <Alert variant="warning" icon={ShieldAlert} title="Platform admin is a powerful role">
                  It can pause all AI coaching, change spend caps and issue access codes for anyone.
                </Alert>
              ) : null}
              <MutationErrorAlert error={create.error} title="Couldn’t add the principal" />
              <DialogFooter>
                <Button variant="secondary" onClick={close} disabled={create.isPending}>
                  Cancel
                </Button>
                <Button type="submit" loading={create.isPending} loadingText="Adding…">
                  Add principal
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
