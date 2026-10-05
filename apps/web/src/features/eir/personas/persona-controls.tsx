import { zodResolver } from '@hookform/resolvers/zod';
import type { PersonaView } from '@foundry/contracts';
import { CirclePause, CirclePlay } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { announce } from '@/components/a11y/live-announcer';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
import { applyServerFieldErrors, MutationErrorAlert } from '@/features/admin/shared/form';
import { useResumePersona, useSuspendPersona } from '@/lib/api/hooks/eir';
import { pluralize } from '@/lib/format';

const SuspendForm = z.object({
  reason: z
    .string()
    .trim()
    .min(3, 'Give a short reason (at least 3 characters).')
    .max(500, 'Use 500 characters or fewer.'),
});
type SuspendFormValues = z.infer<typeof SuspendForm>;

interface ControlProps {
  persona: PersonaView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Human kill switch for one persona (system-design §4.3): checked on session create and every turn,
 * so it applies to the very next message in every assigned venture. No engineering involved.
 */
export function SuspendPersonaDialog({ persona, open, onOpenChange }: ControlProps) {
  const suspend = useSuspendPersona();
  const { register, handleSubmit, formState, setError, reset } = useForm<SuspendFormValues>({
    resolver: zodResolver(SuspendForm),
    defaultValues: { reason: '' },
  });
  const ventures = pluralize(persona.assignedVentureCount, 'assigned venture');

  const close = () => {
    onOpenChange(false);
    suspend.reset();
    reset();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !suspend.isPending) close();
      }}
    >
      <DialogContent className="max-w-lg border-warning/50">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CirclePause aria-hidden className="size-4 text-warning" />
            Suspend {persona.name}?
          </DialogTitle>
          <DialogDescription asChild>
            <div className="grid gap-2">
              <p>Takes effect immediately for {ventures}:</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>New sessions are refused and the next message in any open session is blocked.</li>
                <li>
                  Founders see that a person paused their coach. Past sessions, memory, documents and
                  escalations stay available, and they can still reach a human.
                </li>
                <li>Your reason is recorded in the audit log and shown in the studio.</li>
                <li>You can resume it from this page at any time.</li>
              </ul>
            </div>
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="grid gap-4"
          onSubmit={(event) =>
            void handleSubmit((values) => {
              suspend.mutate(
                { personaId: persona.id, reason: values.reason },
                {
                  onSuccess: () => {
                    toast.success(`${persona.name} is suspended`);
                    announce('Persona suspended', 'assertive');
                    close();
                  },
                  onError: (error) => {
                    applyServerFieldErrors(error, setError, ['reason']);
                  },
                },
              );
            })(event)
          }
        >
          <Field
            label="Reason"
            required
            description="e.g. “Gave investment advice in a calibration sample — reviewing doctrine.”"
            error={formState.errors.reason?.message}
          >
            <Textarea minRows={3} maxRows={6} {...register('reason')} />
          </Field>
          <MutationErrorAlert error={suspend.error} title={`${persona.name} wasn’t suspended`} />
          <DialogFooter>
            <Button variant="secondary" onClick={close} disabled={suspend.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" loading={suspend.isPending} loadingText="Suspending…">
              Suspend now
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ResumePersonaDialog({ persona, open, onOpenChange }: ControlProps) {
  const resume = useResumePersona();
  const release = persona.activeRelease;
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!resume.isPending) {
          onOpenChange(next);
          if (!next) resume.reset();
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <CirclePlay aria-hidden className="size-4" />
            Resume {persona.name}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {release
              ? `Coaching resumes with release v${release.version} for ${pluralize(persona.assignedVentureCount, 'assigned venture')}, from their next message. The platform kill switch and spend caps still apply.`
              : 'This persona has no approved release, so it can’t coach until a release is approved.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <MutationErrorAlert error={resume.error} title={`${persona.name} wasn’t resumed`} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={resume.isPending}>Keep suspended</AlertDialogCancel>
          <Button
            loading={resume.isPending}
            loadingText="Resuming…"
            onClick={() => {
              resume.mutate(persona.id, {
                onSuccess: () => {
                  toast.success(`${persona.name} resumed`);
                  announce('Persona resumed');
                  onOpenChange(false);
                },
              });
            }}
          >
            Resume coaching
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
