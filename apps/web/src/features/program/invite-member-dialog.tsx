import { zodResolver } from '@hookform/resolvers/zod';
import { MembershipRole } from '@foundry/contracts';
import { UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

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
import { AccessCodeRevealDialog } from '@/features/admin/shared/access-code-reveal';
import { applyServerFieldErrors, MutationErrorAlert, SelectField } from '@/features/admin/shared/form';
import { useInviteMember, type IssuedAccessCode } from '@/lib/api/hooks/team';
import { ROLE_LABELS } from '@/lib/auth/roles';

export const EXPIRY_OPTIONS = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '180', label: '180 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'No expiry' },
] as const;

const ROLE_DESCRIPTIONS: Record<z.infer<typeof MembershipRole>, string> = {
  founder: 'Full workspace, including founder-only items they author and sharing consent.',
  team: 'Full workspace except founder-only items.',
  advisor: 'Read access to items shared with advisors.',
};

const InviteForm = z.object({
  displayName: z.string().trim().min(1, 'Enter the person’s name.').max(120, 'Use 120 characters or fewer.'),
  email: z.union([z.literal(''), z.email('Enter a valid email address, or leave it blank.')]),
  title: z.string().trim().max(120, 'Use 120 characters or fewer.'),
  role: MembershipRole,
  expiry: z.enum(['30', '90', '180', '365', 'never']),
});
type InviteFormValues = z.infer<typeof InviteForm>;

interface InviteMemberDialogProps {
  /** The venture to invite into; the dialog is open while set. */
  venture: { id: string; name: string } | null;
  onClose: () => void;
}

/**
 * Invite a founder (or team member / advisor) to a venture. The API creates the principal and
 * returns a one-time access code, revealed once in AccessCodeRevealDialog and then discarded.
 */
export function InviteMemberDialog({ venture, onClose }: InviteMemberDialogProps) {
  // Remount per venture so the form and mutation never carry state across ventures.
  return <InviteMemberDialogInner key={venture?.id ?? 'closed'} venture={venture} onClose={onClose} />;
}

function InviteMemberDialogInner({ venture, onClose }: InviteMemberDialogProps) {
  const invite = useInviteMember(venture?.id ?? '');
  const [issued, setIssued] = useState<{ code: IssuedAccessCode; role: string } | null>(null);
  const form = useForm<InviteFormValues>({
    resolver: zodResolver(InviteForm),
    defaultValues: { displayName: '', email: '', title: '', role: 'founder', expiry: '90' },
  });
  const { register, control, handleSubmit, formState, setError } = form;

  const onSubmit = handleSubmit((values) => {
    invite.mutate(
      {
        displayName: values.displayName,
        email: values.email === '' ? null : values.email,
        title: values.title === '' ? null : values.title,
        role: values.role,
        expiresInDays: values.expiry === 'never' ? null : Number(values.expiry),
      },
      {
        onSuccess: (code) => {
          setIssued({ code, role: ROLE_LABELS[values.role] });
        },
        onError: (error) => {
          applyServerFieldErrors(error, setError, ['displayName', 'email', 'title', 'role']);
        },
      },
    );
  });

  if (issued && venture) {
    return (
      <AccessCodeRevealDialog
        issued={issued.code}
        context={`Invitation to ${venture.name} as ${issued.role.toLowerCase()}`}
        onDone={() => {
          setIssued(null);
          invite.reset();
          onClose();
        }}
      />
    );
  }

  return (
    <Dialog
      open={venture !== null}
      onOpenChange={(open) => {
        if (!open && !invite.isPending) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus aria-hidden className="size-4" />
            Invite to {venture?.name}
          </DialogTitle>
          <DialogDescription>
            Creates their account and a one-time access code you hand over privately.
          </DialogDescription>
        </DialogHeader>
        <form noValidate onSubmit={(event) => void onSubmit(event)} className="grid gap-4">
          <Field label="Name" required error={formState.errors.displayName?.message}>
            <Input autoComplete="off" {...register('displayName')} />
          </Field>
          <Field
            label="Email"
            description="Optional. Used only for your records."
            error={formState.errors.email?.message}
          >
            <Input type="email" autoComplete="off" {...register('email')} />
          </Field>
          <Field
            label="Title"
            description="Optional, e.g. “Co-founder & CEO”."
            error={formState.errors.title?.message}
          >
            <Input autoComplete="off" {...register('title')} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Controller
              control={control}
              name="role"
              render={({ field }) => (
                <SelectField
                  label="Role"
                  value={field.value}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  options={MembershipRole.options.map((role) => ({ value: role, label: ROLE_LABELS[role] }))}
                  description={ROLE_DESCRIPTIONS[field.value]}
                  error={formState.errors.role?.message}
                />
              )}
            />
            <Controller
              control={control}
              name="expiry"
              render={({ field }) => (
                <SelectField
                  label="Access expires after"
                  value={field.value}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  options={EXPIRY_OPTIONS}
                  error={formState.errors.expiry?.message}
                />
              )}
            />
          </div>
          <MutationErrorAlert error={invite.error} title="Couldn’t create the invitation" />
          <DialogFooter>
            <Button variant="secondary" onClick={onClose} disabled={invite.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={invite.isPending} loadingText="Creating…">
              Create invitation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
