import { zodResolver } from '@hookform/resolvers/zod';
import { CoachMode, SessionPrivacy } from '@foundry/contracts';
import { useNavigate } from '@tanstack/react-router';
import { EyeOff, Play, Save } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import { announce } from '@/components/a11y/live-announcer';
import { DisclosureBanner } from '@/components/disclosure-banner';
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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '@/lib/api/errors';
import { useCreateSession } from '@/lib/api/hooks/sessions';
import { MODE_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';
import { applyFieldErrors } from '@/features/venture/form-errors';

import { COACH_MODES, MODE_DETAILS } from './modes';
import { setPendingCounterpart } from './pending-counterpart';

const StartSessionSchema = z
  .object({
    mode: CoachMode,
    goal: z.string().trim().max(500, 'Keep the goal under 500 characters.'),
    privacy: SessionPrivacy,
    counterpart: z.string().trim().max(120, 'Keep it under 120 characters.'),
  })
  .refine((v) => v.mode !== 'rehearse' || v.counterpart.length >= 2, {
    path: ['counterpart'],
    message: 'Say who you’ll be talking to, e.g. “Seed investor”.',
  });
type StartInput = z.input<typeof StartSessionSchema>;
type Privacy = z.infer<typeof SessionPrivacy>;
type StartOutput = z.output<typeof StartSessionSchema>;

export const PRIVACY_OPTIONS: Record<Privacy, { label: string; description: string; icon: typeof Save }> = {
  standard: {
    label: 'Standard',
    description:
      'The transcript and recap are kept in this venture’s workspace. Anything worth remembering is proposed to you for approval first.',
    icon: Save,
  },
  ephemeral: {
    label: 'Ephemeral',
    description:
      'Nothing from this session is kept as memory, and no recap is saved. Only minimal security records (who and when) are retained.',
    icon: EyeOff,
  },
};

interface StartSessionDialogProps {
  ventureId: string;
  tenant: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultMode?: CoachMode;
}

/** Start a coaching session: mode (with guidance), optional goal, privacy, and a rehearsal counterpart. */
export function StartSessionDialog({
  ventureId,
  tenant,
  open,
  onOpenChange,
  defaultMode = 'diagnose',
}: StartSessionDialogProps) {
  const navigate = useNavigate();
  const create = useCreateSession(ventureId);
  const [formError, setFormError] = useState<string | null>(null);
  const ids = { mode: useId(), privacy: useId() };
  const { control, register, handleSubmit, reset, watch, formState, setError } = useForm<
    StartInput,
    unknown,
    StartOutput
  >({
    resolver: zodResolver(StartSessionSchema),
    defaultValues: { mode: defaultMode, goal: '', privacy: 'standard', counterpart: '' },
  });
  const mode = watch('mode');

  useEffect(() => {
    if (open) {
      setFormError(null);
      create.reset();
      reset({ mode: defaultMode, goal: '', privacy: 'standard', counterpart: '' });
    }
    // Reset only when the dialog opens.
  }, [open]);

  const onSubmit = handleSubmit((values) => {
    setFormError(null);
    create.mutate(
      { mode: values.mode, goal: values.goal || null, privacy: values.privacy },
      {
        onSuccess: (session) => {
          if (values.mode === 'rehearse') setPendingCounterpart(session.id, values.counterpart);
          announce('Session started');
          onOpenChange(false);
          void navigate({
            to: '/$tenant/app/ventures/$ventureId/coach/$sessionId',
            params: { tenant, ventureId, sessionId: session.id },
          });
        },
        onError: (error) => {
          if (!applyFieldErrors(error, setError, ['mode', 'goal', 'privacy']))
            setFormError(errorMessage(error));
        },
      },
    );
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <form onSubmit={(e) => void onSubmit(e)} noValidate className="grid gap-5">
          <DialogHeader>
            <DialogTitle>Start a session</DialogTitle>
            <DialogDescription>
              Pick how you want Foundry Guide to work with you. You can switch modes mid-session.
            </DialogDescription>
          </DialogHeader>
          <DisclosureBanner variant="inline" />
          {formError ? (
            <Alert variant="destructive" live="alert" title="Couldn’t start the session">
              {formError}
            </Alert>
          ) : null}

          <fieldset className="grid gap-2.5">
            <legend id={ids.mode} className="mb-2.5 text-sm font-medium">
              Mode
            </legend>
            <Controller
              control={control}
              name="mode"
              render={({ field }) => (
                <RadioGroup
                  aria-labelledby={ids.mode}
                  value={field.value}
                  onValueChange={(value) => {
                    field.onChange(value);
                  }}
                  className="grid gap-2 sm:grid-cols-2"
                >
                  {COACH_MODES.map((m) => {
                    const def = MODE_LABELS[m];
                    const Icon = def.icon;
                    const itemId = `${ids.mode}-${m}`;
                    const selected = field.value === m;
                    return (
                      <label
                        key={m}
                        htmlFor={itemId}
                        className={cn(
                          'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-accent/50',
                          selected ? 'border-foreground/60 bg-accent/40' : 'border-border',
                        )}
                      >
                        <RadioGroupItem
                          id={itemId}
                          value={m}
                          className="mt-0.5"
                          aria-describedby={`${itemId}-desc`}
                        />
                        <span className="grid gap-0.5">
                          <span className="flex items-center gap-1.5 text-sm font-medium">
                            <Icon aria-hidden className="size-4 text-muted-foreground" />
                            {def.label}
                          </span>
                          <span
                            id={`${itemId}-desc`}
                            className="text-[13px] leading-snug text-muted-foreground"
                          >
                            {def.description}{' '}
                            <span className="text-subtle-foreground">{MODE_DETAILS[m].whenToUse}</span>
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </RadioGroup>
              )}
            />
          </fieldset>

          {mode === 'rehearse' ? (
            <Field
              label="Who are you rehearsing with?"
              required
              description="Foundry Guide plays this role. Describe a role, not a real person."
              error={formState.errors.counterpart?.message}
            >
              <Input
                {...register('counterpart')}
                maxLength={120}
                placeholder="e.g. Seed investor, library operations manager"
              />
            </Field>
          ) : null}

          <Field
            label="Goal (optional)"
            description="What would make this session worth your time?"
            error={formState.errors.goal?.message}
          >
            <Textarea
              {...register('goal')}
              minRows={2}
              maxRows={5}
              maxLength={500}
              placeholder={`e.g. ${MODE_DETAILS[mode].example}`}
            />
          </Field>

          <fieldset className="grid gap-2">
            <legend id={ids.privacy} className="mb-2 text-sm font-medium">
              Privacy
            </legend>
            <Controller
              control={control}
              name="privacy"
              render={({ field }) => (
                <RadioGroup
                  aria-labelledby={ids.privacy}
                  value={field.value}
                  onValueChange={(value) => {
                    field.onChange(value);
                  }}
                  className="grid gap-2 sm:grid-cols-2"
                >
                  {SessionPrivacy.options.map((p) => {
                    const def = PRIVACY_OPTIONS[p];
                    const Icon = def.icon;
                    const itemId = `${ids.privacy}-${p}`;
                    return (
                      <label
                        key={p}
                        htmlFor={itemId}
                        className={cn(
                          'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-accent/50',
                          field.value === p ? 'border-foreground/60 bg-accent/40' : 'border-border',
                        )}
                      >
                        <RadioGroupItem
                          id={itemId}
                          value={p}
                          className="mt-0.5"
                          aria-describedby={`${itemId}-desc`}
                        />
                        <span className="grid gap-0.5">
                          <span className="flex items-center gap-1.5 text-sm font-medium">
                            <Icon aria-hidden className="size-4 text-muted-foreground" />
                            {def.label}
                          </span>
                          <span
                            id={`${itemId}-desc`}
                            className="text-[13px] leading-snug text-muted-foreground"
                          >
                            {def.description}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </RadioGroup>
              )}
            />
          </fieldset>

          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending} loadingText="Starting…">
              <Play aria-hidden />
              Start session
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
