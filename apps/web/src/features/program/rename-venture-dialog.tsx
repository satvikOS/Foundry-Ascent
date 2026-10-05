import { zodResolver } from '@hookform/resolvers/zod';
import { PencilLine } from 'lucide-react';
import { useEffect } from 'react';
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
import { Input } from '@/components/ui/input';
import { applyServerFieldErrors, MutationErrorAlert } from '@/features/admin/shared/form';
import { useRenameProgramVenture } from '@/lib/api/hooks/program';

const RenameForm = z.object({
  name: z.string().trim().min(3, 'Use at least 3 characters.').max(80, 'Use 80 characters or fewer.'),
});
type RenameFormValues = z.infer<typeof RenameForm>;

interface RenameVentureDialogProps {
  /** The venture to rename; null closes the dialog. */
  venture: { id: string; name: string } | null;
  onClose: () => void;
}

/**
 * Program staff rename a venture (any venture of the program, e.g. to undo a misleading rename by its
 * team). The server requires a distinctive name that no other venture of the program uses.
 */
export function RenameVentureDialog({ venture, onClose }: RenameVentureDialogProps) {
  const rename = useRenameProgramVenture();
  const { register, handleSubmit, formState, setError, reset } = useForm<RenameFormValues>({
    resolver: zodResolver(RenameForm),
    defaultValues: { name: venture?.name ?? '' },
  });

  useEffect(() => {
    if (venture) reset({ name: venture.name });
  }, [venture, reset]);

  const close = () => {
    rename.reset();
    onClose();
  };

  const onSubmit = handleSubmit((values) => {
    if (!venture) return;
    rename.mutate(
      { ventureId: venture.id, input: { name: values.name } },
      {
        onSuccess: (row) => {
          toast.success(`Renamed to ${row.name}`);
          announce('Venture renamed');
          close();
        },
        onError: (error) => {
          applyServerFieldErrors(error, setError, ['name']);
        },
      },
    );
  });

  return (
    <Dialog
      open={venture !== null}
      onOpenChange={(next) => {
        if (!next && !rename.isPending) close();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PencilLine aria-hidden className="size-4" />
            Rename {venture?.name ?? 'venture'}
          </DialogTitle>
          <DialogDescription>
            Venture names must be distinctive and unique in the program: other ventures’ coaches never mention
            them.
          </DialogDescription>
        </DialogHeader>
        <form noValidate onSubmit={(event) => void onSubmit(event)} className="grid gap-4">
          <Field label="Venture name" required error={formState.errors.name?.message}>
            <Input autoComplete="off" {...register('name')} />
          </Field>
          <MutationErrorAlert error={rename.error} title="Couldn’t rename the venture" />
          <DialogFooter>
            <Button variant="secondary" onClick={close} disabled={rename.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={rename.isPending} loadingText="Renaming…">
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
