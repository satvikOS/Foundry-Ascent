import { zodResolver } from '@hookform/resolvers/zod';
import { KeyRound } from 'lucide-react';
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
import { useIssueAccessCode } from '@/lib/api/hooks/admin';
import type { IssuedAccessCode } from '@/lib/api/hooks/team';

import { AccessCodeRevealDialog } from '../shared/access-code-reveal';
import { applyServerFieldErrors, MutationErrorAlert, SelectField } from '../shared/form';

export const CODE_EXPIRY_OPTIONS = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'No expiry' },
] as const;

const IssueForm = z.object({
  label: z
    .string()
    .trim()
    .min(1, 'Add a label so you can recognise this code later.')
    .max(80, 'Use 80 characters or fewer.'),
  expiry: z.enum(['7', '30', '90', '365', 'never']),
});
type IssueFormValues = z.infer<typeof IssueForm>;

export interface CodeRecipient {
  id: string;
  displayName: string;
}

interface IssueAccessCodeDialogProps {
  /** Who the code is for; the dialog is open while set. */
  recipient: CodeRecipient | null;
  onClose: () => void;
}

/**
 * Issue an access code to a principal: a short form, then the one-time reveal. The plaintext code
 * lives only in this component's state until the admin confirms they stored it, and the mutation is
 * reset so it is not retained in the query cache either.
 */
export function IssueAccessCodeDialog({ recipient, onClose }: IssueAccessCodeDialogProps) {
  return (
    <IssueAccessCodeDialogInner key={recipient?.id ?? 'closed'} recipient={recipient} onClose={onClose} />
  );
}

function IssueAccessCodeDialogInner({ recipient, onClose }: IssueAccessCodeDialogProps) {
  const issue = useIssueAccessCode();
  const [issued, setIssued] = useState<IssuedAccessCode | null>(null);
  const { register, control, handleSubmit, formState, setError } = useForm<IssueFormValues>({
    resolver: zodResolver(IssueForm),
    defaultValues: { label: 'access code', expiry: '30' },
  });

  const onSubmit = handleSubmit((values) => {
    if (!recipient) return;
    issue.mutate(
      {
        principalId: recipient.id,
        input: {
          label: values.label,
          expiresInDays: values.expiry === 'never' ? null : Number(values.expiry),
        },
      },
      {
        onSuccess: (result) => {
          setIssued(result);
          // Announce the event only — never the code.
          announce('Access code issued. Copy it now; it is shown once.');
        },
        onError: (error) => {
          applyServerFieldErrors(error, setError, ['label', 'expiry'], (path) =>
            path === 'expiresInDays' ? 'expiry' : path,
          );
        },
      },
    );
  });

  if (issued) {
    return (
      <AccessCodeRevealDialog
        issued={issued}
        onDone={() => {
          setIssued(null);
          issue.reset();
          onClose();
        }}
      />
    );
  }

  return (
    <Dialog
      open={recipient !== null}
      onOpenChange={(open) => {
        if (!open && !issue.isPending) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound aria-hidden className="size-4" />
            Issue access code
          </DialogTitle>
          <DialogDescription>
            For {recipient?.displayName}. The code is shown once; Foundry Ascent stores only its hash.
          </DialogDescription>
        </DialogHeader>
        <form noValidate onSubmit={(event) => void onSubmit(event)} className="grid gap-4">
          <Field
            label="Label"
            required
            description="Visible to admins only, e.g. “laptop” or “demo day”."
            error={formState.errors.label?.message}
          >
            <Input autoComplete="off" {...register('label')} />
          </Field>
          <Controller
            control={control}
            name="expiry"
            render={({ field }) => (
              <SelectField
                label="Expires after"
                value={field.value}
                onChange={field.onChange}
                onBlur={field.onBlur}
                options={CODE_EXPIRY_OPTIONS}
                description="Shorter is safer. You can revoke a code at any time."
                error={formState.errors.expiry?.message}
              />
            )}
          />
          <MutationErrorAlert error={issue.error} title="Couldn’t issue the code" />
          <DialogFooter>
            <Button variant="secondary" onClick={onClose} disabled={issue.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={issue.isPending} loadingText="Issuing…">
              Issue code
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
