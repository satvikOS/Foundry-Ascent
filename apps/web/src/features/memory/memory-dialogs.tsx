import { zodResolver } from '@hookform/resolvers/zod';
import { MemoryType, Visibility, type MemoryObjectView, type SourceRef } from '@foundry/contracts';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import { Alert } from '@/components/ui/alert';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { announce } from '@/components/a11y/live-announcer';
import { errorMessage } from '@/lib/api/errors';
import { MEMORY_TYPE_LABELS, VISIBILITY_LABELS } from '@/lib/labels';
import { FieldSelect, type FieldSelectOption } from '@/features/venture/field-select';
import { applyFieldErrors } from '@/features/venture/form-errors';

import { useFullMemory } from '@/lib/api/hooks/memory';

import { useCreateVentureMemory, useMemoryActions } from './api';

const VISIBILITIES = Visibility.options;
const TYPE_OPTIONS: FieldSelectOption<MemoryType>[] = MemoryType.options.map((type) => ({
  value: type,
  label: MEMORY_TYPE_LABELS[type].label,
  icon: MEMORY_TYPE_LABELS[type].icon,
}));

function VisibilitySelect({
  value,
  onChange,
  id,
}: {
  value: Visibility;
  onChange: (value: Visibility) => void;
  id?: string;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        onChange(next as Visibility);
      }}
    >
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {VISIBILITIES.map((v) => (
          <SelectItem key={v} value={v}>
            <span className="flex flex-col items-start">
              <span>{VISIBILITY_LABELS[v].label}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// -------------------------------------------------------------------------------------------------
// Correct
// -------------------------------------------------------------------------------------------------

const CorrectSchema = z.object({
  title: z.string().trim().min(1, 'Add a short title.').max(200, 'Keep the title under 200 characters.'),
  content: z
    .string()
    .trim()
    .min(1, 'Describe what should be remembered.')
    .max(8000, 'Keep it under 8,000 characters.'),
  visibility: Visibility,
  confidence: z
    .number({ error: 'Enter a number from 0 to 100.' })
    .min(0, 'Use 0 to 100.')
    .max(100, 'Use 0 to 100.'),
  reason: z.string().trim().max(500, 'Keep the reason under 500 characters.'),
  approveAfter: z.boolean(),
});
type CorrectInput = z.input<typeof CorrectSchema>;
type CorrectOutput = z.output<typeof CorrectSchema>;

interface CorrectMemoryDialogProps {
  ventureId: string;
  memory: MemoryObjectView | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the corrected (new version) memory. */
  onCorrected?: (memory: MemoryObjectView) => void;
}

/** Correct a memory object: saved as a new version; the previous one stays in history. */
export function CorrectMemoryDialog({
  ventureId,
  memory: listed,
  open,
  onOpenChange,
  onCorrected,
}: CorrectMemoryDialogProps) {
  // Lists carry an excerpt: the form is filled (and can be saved) only once the full text is loaded,
  // otherwise a correction would replace the content with its excerpt.
  const { memory, complete } = useFullMemory(open ? listed : null);
  const { mutation, run } = useMemoryActions(ventureId);
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<CorrectInput, unknown, CorrectOutput>({
    resolver: zodResolver(CorrectSchema),
    defaultValues: {
      title: '',
      content: '',
      visibility: 'venture',
      confidence: 70,
      reason: '',
      approveAfter: true,
    },
  });
  const { register, handleSubmit, reset, control, setError, formState } = form;

  useEffect(() => {
    if (open && memory && complete) {
      setFormError(null);
      reset({
        title: memory.title,
        content: memory.content,
        visibility: memory.visibility,
        confidence: Math.round(memory.confidence * 100),
        reason: '',
        approveAfter: true,
      });
    }
  }, [open, memory, complete, reset]);

  if (!memory) return null;
  const isProposed = memory.status === 'proposed';

  const onSubmit = handleSubmit((values) => {
    setFormError(null);
    if (!complete) return;
    const patch: { title?: string; content?: string; visibility?: Visibility; confidence?: number } = {};
    if (values.title !== memory.title) patch.title = values.title;
    if (values.content !== memory.content) patch.content = values.content;
    if (values.visibility !== memory.visibility) patch.visibility = values.visibility;
    const confidence = Math.round(values.confidence) / 100;
    if (Math.abs(confidence - memory.confidence) > 0.001) patch.confidence = confidence;
    if (Object.keys(patch).length === 0) {
      if (isProposed && values.approveAfter) {
        run(memory.id, { action: 'approve' });
        onOpenChange(false);
        return;
      }
      setFormError('Nothing changed. Edit a field, or cancel.');
      return;
    }
    mutation.mutate(
      {
        memoryId: memory.id,
        action: { action: 'correct', patch, ...(values.reason ? { reason: values.reason } : {}) },
      },
      {
        onSuccess: (result) => {
          // `correct` always answers with the new version; only `delete` is body-less (204).
          const corrected = result ?? memory;
          if (isProposed && values.approveAfter && corrected.status === 'proposed') {
            run(corrected.id, { action: 'approve' }, { successMessage: 'Corrected and approved' });
          } else {
            toast.success('Correction saved as a new version');
            announce('Correction saved');
          }
          onCorrected?.(corrected);
          onOpenChange(false);
        },
        onError: (error) => {
          const shown = applyFieldErrors(error, setError, [
            'title',
            'content',
            'visibility',
            'confidence',
            'reason',
          ]);
          if (!shown) setFormError(errorMessage(error));
        },
      },
    );
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <form onSubmit={(e) => void onSubmit(e)} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{isProposed ? 'Edit proposed memory' : 'Correct memory'}</DialogTitle>
            <DialogDescription>
              Corrections are saved as a new version. The previous version stays in the history with who
              changed it and why.
            </DialogDescription>
          </DialogHeader>
          {formError ? (
            <Alert variant="destructive" live="alert">
              {formError}
            </Alert>
          ) : null}
          <Field label="Title" required error={formState.errors.title?.message}>
            <Input {...register('title')} maxLength={200} autoComplete="off" />
          </Field>
          <Field label="What should be remembered" required error={formState.errors.content?.message}>
            <Textarea {...register('content')} minRows={4} maxRows={12} maxLength={8000} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Controller
              control={control}
              name="visibility"
              render={({ field }) => (
                <Field
                  label="Visibility"
                  description={VISIBILITY_LABELS[field.value].description}
                  error={formState.errors.visibility?.message}
                >
                  <VisibilitySelect value={field.value} onChange={field.onChange} />
                </Field>
              )}
            />
            <Field
              label="Confidence (%)"
              description="How sure the team is, from 0 to 100."
              error={formState.errors.confidence?.message}
            >
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                max={100}
                step={5}
                {...register('confidence', { valueAsNumber: true })}
              />
            </Field>
          </div>
          <Field
            label="Reason (optional)"
            description="Shown in the version history."
            error={formState.errors.reason?.message}
          >
            <Input
              {...register('reason')}
              maxLength={500}
              placeholder="e.g. Updated after the second interview round"
            />
          </Field>
          {isProposed ? (
            <Controller
              control={control}
              name="approveAfter"
              render={({ field }) => (
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="correct-approve-after"
                    checked={field.value}
                    onCheckedChange={(checked) => {
                      field.onChange(checked === true);
                    }}
                  />
                  <Label htmlFor="correct-approve-after" className="font-normal">
                    Approve after saving
                  </Label>
                </div>
              )}
            />
          ) : null}
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              loading={mutation.isPending || !complete}
              loadingText={complete ? 'Saving…' : 'Loading…'}
            >
              Save correction
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// -------------------------------------------------------------------------------------------------
// Dispute
// -------------------------------------------------------------------------------------------------

const DisputeSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, 'Say briefly what is wrong or contested.')
    .max(500, 'Keep it under 500 characters.'),
});

export function DisputeMemoryDialog({
  ventureId,
  memory,
  open,
  onOpenChange,
}: {
  ventureId: string;
  memory: MemoryObjectView | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { run, isPending } = useMemoryActions(ventureId);
  const form = useForm<z.input<typeof DisputeSchema>, unknown, z.output<typeof DisputeSchema>>({
    resolver: zodResolver(DisputeSchema),
    defaultValues: { reason: '' },
  });
  const { register, handleSubmit, reset, formState } = form;
  useEffect(() => {
    if (open) reset({ reason: '' });
  }, [open, reset]);
  if (!memory) return null;

  const onSubmit = handleSubmit((values) => {
    run(memory.id, { action: 'dispute', reason: values.reason });
    onOpenChange(false);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={(e) => void onSubmit(e)} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Dispute this memory</DialogTitle>
            <DialogDescription>
              Disputed memory is no longer treated as fact by Foundry Guide until someone corrects or
              re-approves it.
            </DialogDescription>
          </DialogHeader>
          <Field label="What’s wrong?" required error={formState.errors.reason?.message}>
            <Textarea {...register('reason')} minRows={3} maxLength={500} />
          </Field>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" loading={isPending}>
              Mark as disputed
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// -------------------------------------------------------------------------------------------------
// Delete / reject confirmation
// -------------------------------------------------------------------------------------------------

export function ConfirmMemoryActionDialog({
  ventureId,
  memory,
  action,
  open,
  onOpenChange,
  onDone,
}: {
  ventureId: string;
  memory: MemoryObjectView | null;
  action: 'delete' | 'reject';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone?: () => void;
}) {
  const { run } = useMemoryActions(ventureId);
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  if (!memory) return null;
  const isDelete = action === 'delete';
  const reasonId = `memory-${action}-reason`;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{isDelete ? 'Delete this memory?' : 'Reject this suggestion?'}</AlertDialogTitle>
          <AlertDialogDescription>
            {isDelete
              ? 'Foundry Guide will stop using it immediately. Only an audit record (who and when) is kept.'
              : 'It will not be used as venture memory. You can add it again later if it turns out to be right.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-2">
          <Label htmlFor={reasonId}>
            Reason <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id={reasonId}
            value={reason}
            maxLength={500}
            onChange={(e) => {
              setReason(e.target.value);
            }}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            variant={isDelete ? 'destructive' : 'default'}
            onClick={() => {
              const trimmed = reason.trim();
              run(memory.id, { action, ...(trimmed ? { reason: trimmed } : {}) });
              onOpenChange(false);
              onDone?.();
            }}
          >
            {isDelete ? 'Delete' : 'Reject'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// -------------------------------------------------------------------------------------------------
// Create (generic)
// -------------------------------------------------------------------------------------------------

const CreateSchema = z.object({
  type: MemoryType,
  title: z.string().trim().min(1, 'Add a short title.').max(200, 'Keep the title under 200 characters.'),
  content: z
    .string()
    .trim()
    .min(1, 'Describe what should be remembered.')
    .max(8000, 'Keep it under 8,000 characters.'),
  visibility: Visibility,
});
type CreateInput = z.input<typeof CreateSchema>;
type CreateOutput = z.output<typeof CreateSchema>;

export function CreateMemoryDialog({
  ventureId,
  open,
  onOpenChange,
  defaults,
  sourceRefs,
  onCreated,
}: {
  ventureId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaults?: Partial<CreateInput>;
  sourceRefs?: SourceRef[];
  onCreated?: (memory: MemoryObjectView) => void;
}) {
  const { createMemory, mutation } = useCreateVentureMemory(ventureId);
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<CreateInput, unknown, CreateOutput>({
    resolver: zodResolver(CreateSchema),
    defaultValues: { type: 'fact', title: '', content: '', visibility: 'venture' },
  });
  const { register, handleSubmit, reset, control, formState, setError } = form;

  useEffect(() => {
    if (open) {
      setFormError(null);
      reset({ type: 'fact', title: '', content: '', visibility: 'venture', ...defaults });
    }
    // `defaults` is read once per opening on purpose.
  }, [open, reset]);

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      const memory = await createMemory({ ...values, ...(sourceRefs ? { sourceRefs } : {}) });
      toast.success(memory.status === 'proposed' ? 'Added — waiting for approval' : 'Added to memory');
      announce('Memory added');
      onCreated?.(memory);
      onOpenChange(false);
    } catch (error) {
      if (!applyFieldErrors(error, setError, ['type', 'title', 'content', 'visibility'])) {
        setFormError(errorMessage(error));
      }
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <form onSubmit={(e) => void onSubmit(e)} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Add to memory</DialogTitle>
            <DialogDescription>
              Record something Foundry Guide should know about this venture. It is linked to you as the
              source.
            </DialogDescription>
          </DialogHeader>
          {formError ? (
            <Alert variant="destructive" live="alert">
              {formError}
            </Alert>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Controller
              control={control}
              name="type"
              render={({ field }) => (
                <Field label="Type" error={formState.errors.type?.message}>
                  <FieldSelect value={field.value} onValueChange={field.onChange} options={TYPE_OPTIONS} />
                </Field>
              )}
            />
            <Controller
              control={control}
              name="visibility"
              render={({ field }) => (
                <Field
                  label="Visibility"
                  description={VISIBILITY_LABELS[field.value].description}
                  error={formState.errors.visibility?.message}
                >
                  <VisibilitySelect value={field.value} onChange={field.onChange} />
                </Field>
              )}
            />
          </div>
          <Field label="Title" required error={formState.errors.title?.message}>
            <Input {...register('title')} maxLength={200} autoComplete="off" />
          </Field>
          <Field label="Details" required error={formState.errors.content?.message}>
            <Textarea {...register('content')} minRows={4} maxRows={12} maxLength={8000} />
          </Field>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending} loadingText="Adding…">
              Add to memory
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
