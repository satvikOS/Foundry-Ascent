import { zodResolver } from '@hookform/resolvers/zod';
import type { PlatformSettingsView } from '@foundry/contracts';
import { SlidersHorizontal } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { announce } from '@/components/a11y/live-announcer';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import type { UpdateSettingsInput } from '@/lib/api/hooks/admin';

import { applyServerFieldErrors, MutationErrorAlert } from '../shared/form';

const number = (message = 'Enter a number.') => z.number({ error: message });

export const LimitsForm = z
  .object({
    dailyUsdCapGlobal: number()
      .min(0, 'Can’t be negative.')
      .max(100, 'The platform maximum is $100 per day.'),
    dailyUsdCapPerPrincipal: number()
      .min(0, 'Can’t be negative.')
      .max(50, 'The platform maximum is $50 per day.'),
    maxTurnsPerSession: number('Enter a whole number.')
      .int('Enter a whole number.')
      .min(1, 'At least 1 turn.')
      .max(200, 'At most 200 turns.'),
    groundingPercent: number().min(0, 'Between 0 and 100%.').max(100, 'Between 0 and 100%.'),
    portfolioMinGroupSize: number('Enter a whole number.')
      .int('Enter a whole number.')
      .min(2, 'k must be at least 2.')
      .max(20, 'k can be at most 20.'),
  })
  .refine((v) => v.dailyUsdCapPerPrincipal <= v.dailyUsdCapGlobal, {
    path: ['dailyUsdCapPerPrincipal'],
    message: 'The per-person cap can’t exceed the platform cap.',
  });
export type LimitsFormValues = z.infer<typeof LimitsForm>;

type LimitKey = keyof LimitsFormValues;

export function toLimitsFormValues(settings: PlatformSettingsView): LimitsFormValues {
  return {
    dailyUsdCapGlobal: settings.dailyUsdCapGlobal,
    dailyUsdCapPerPrincipal: settings.dailyUsdCapPerPrincipal,
    maxTurnsPerSession: settings.maxTurnsPerSession,
    groundingPercent: Math.round(settings.groundingCoverageThreshold * 1000) / 10,
    portfolioMinGroupSize: settings.portfolioMinGroupSize,
  };
}

/** Only the fields that changed, converted back to the API's units. */
export function limitsPatch(settings: PlatformSettingsView, values: LimitsFormValues): UpdateSettingsInput {
  const patch: UpdateSettingsInput = {};
  if (values.dailyUsdCapGlobal !== settings.dailyUsdCapGlobal)
    patch.dailyUsdCapGlobal = values.dailyUsdCapGlobal;
  if (values.dailyUsdCapPerPrincipal !== settings.dailyUsdCapPerPrincipal) {
    patch.dailyUsdCapPerPrincipal = values.dailyUsdCapPerPrincipal;
  }
  if (values.maxTurnsPerSession !== settings.maxTurnsPerSession)
    patch.maxTurnsPerSession = values.maxTurnsPerSession;
  const threshold = Math.round(values.groundingPercent * 10) / 1000;
  if (Math.abs(threshold - settings.groundingCoverageThreshold) > 1e-9)
    patch.groundingCoverageThreshold = threshold;
  if (values.portfolioMinGroupSize !== settings.portfolioMinGroupSize) {
    patch.portfolioMinGroupSize = values.portfolioMinGroupSize;
  }
  return patch;
}

const FIELD_FOR_API: Record<string, LimitKey> = {
  dailyUsdCapGlobal: 'dailyUsdCapGlobal',
  dailyUsdCapPerPrincipal: 'dailyUsdCapPerPrincipal',
  maxTurnsPerSession: 'maxTurnsPerSession',
  groundingCoverageThreshold: 'groundingPercent',
  portfolioMinGroupSize: 'portfolioMinGroupSize',
};

interface LimitsCardProps {
  settings: PlatformSettingsView;
  onSave: (
    patch: UpdateSettingsInput,
    callbacks: { onSuccess: () => void; onError: (error: unknown) => void },
  ) => void;
  pending: boolean;
  error: unknown;
}

/** Spend caps, session length, grounding threshold and portfolio k. Saves only changed fields. */
export function LimitsCard({ settings, onSave, pending, error }: LimitsCardProps) {
  const { register, handleSubmit, formState, reset, setError } = useForm<LimitsFormValues>({
    resolver: zodResolver(LimitsForm),
    defaultValues: toLimitsFormValues(settings),
  });
  const errors = formState.errors;

  const onSubmit = handleSubmit((values) => {
    const patch = limitsPatch(settings, values);
    if (Object.keys(patch).length === 0) {
      reset(values);
      return;
    }
    onSave(patch, {
      onSuccess: () => {
        toast.success('Settings saved');
        announce('Settings saved');
      },
      onError: (err) => {
        applyServerFieldErrors(
          err,
          setError,
          Object.values(FIELD_FOR_API),
          (path) => FIELD_FOR_API[path] ?? path,
        );
      },
    });
  });

  const numberInput = (name: LimitKey, props: { step: string; min: number; max: number }) => (
    <Input
      type="number"
      inputMode="decimal"
      className="tabular"
      {...props}
      {...register(name, { valueAsNumber: true })}
    />
  );

  return (
    <SectionCard title="Limits and thresholds" description="Apply to every tenant" icon={SlidersHorizontal}>
      <form
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
        aria-label="Limits and thresholds"
      >
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-semibold">Daily AI spend caps (USD)</legend>
          <Field
            label="Platform cap per day"
            description="When today’s total reaches this, new turns are refused until midnight UTC."
            error={errors.dailyUsdCapGlobal?.message}
          >
            {numberInput('dailyUsdCapGlobal', { step: '0.5', min: 0, max: 100 })}
          </Field>
          <Field
            label="Cap per person per day"
            description="Stops one account from using the whole budget."
            error={errors.dailyUsdCapPerPrincipal?.message}
          >
            {numberInput('dailyUsdCapPerPrincipal', { step: '0.25', min: 0, max: 50 })}
          </Field>
        </fieldset>
        <fieldset className="grid gap-4 sm:grid-cols-3">
          <legend className="mb-2 text-sm font-semibold">Coaching quality and privacy</legend>
          <Field
            label="Max turns per session"
            description="Long sessions drift; founders are asked to end and start fresh."
            error={errors.maxTurnsPerSession?.message}
          >
            {numberInput('maxTurnsPerSession', { step: '1', min: 1, max: 200 })}
          </Field>
          <Field
            label="Grounding threshold (%)"
            description="Below this share of cited facts, answers are narrowed with an uncertainty banner."
            error={errors.groundingPercent?.message}
          >
            {numberInput('groundingPercent', { step: '1', min: 0, max: 100 })}
          </Field>
          <Field
            label="Portfolio minimum group size (k)"
            description="Aggregates over fewer than k ventures are hidden from program staff."
            error={errors.portfolioMinGroupSize?.message}
          >
            {numberInput('portfolioMinGroupSize', { step: '1', min: 2, max: 20 })}
          </Field>
        </fieldset>
        <MutationErrorAlert error={error} title="Settings weren’t saved" />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="secondary"
            disabled={!formState.isDirty || pending}
            onClick={() => {
              reset(toLimitsFormValues(settings));
            }}
          >
            Discard changes
          </Button>
          <Button type="submit" loading={pending} loadingText="Saving…" disabled={!formState.isDirty}>
            Save changes
          </Button>
        </div>
      </form>
    </SectionCard>
  );
}
