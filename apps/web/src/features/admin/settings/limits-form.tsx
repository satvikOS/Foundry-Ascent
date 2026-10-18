import { zodResolver } from '@hookform/resolvers/zod';
import type { PlatformSettingsView } from '@foundry/contracts';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { announce } from '@/components/a11y/live-announcer';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { toast } from '@/components/ui/toast';
import type { UpdateSettingsInput } from '@/lib/api/hooks/admin';
import { applyFieldErrors } from '@/lib/form-errors';

import { MutationErrorAlert } from '../shared/form';

const number = (message = 'Enter a number.') => z.number({ error: message });
const MB = 1024 * 1024;

/** Defaults the API applies when a setting was never changed (packages/db settings repository). */
const CALL_DEFAULTS = {
  maxCallMinutes: 30,
  dailyCallMinutesPerPrincipal: 60,
  faceMinutesPerPrincipalMonth: 60,
  faceMinutesPerCall: 20,
} as const;

const LimitsForm = z
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
    dailyUploadDocumentsPerPrincipal: number('Enter a whole number.')
      .int('Enter a whole number.')
      .min(0, 'Can’t be negative.')
      .max(1000, 'At most 1,000 documents.'),
    dailyUploadMegabytesPerPrincipal: number('Enter a whole number.')
      .int('Enter a whole number.')
      .min(0, 'Can’t be negative.')
      .max(10_240, 'At most 10,240 MB.'),
    maxCallMinutes: number('Enter a whole number.')
      .int('Enter a whole number.')
      .min(1, 'At least 1 minute.')
      .max(240, 'At most 240 minutes.'),
    dailyCallMinutesPerPrincipal: number('Enter a whole number.')
      .int('Enter a whole number.')
      .min(0, 'Can’t be negative.')
      .max(1440, 'At most 1,440 minutes.'),
    faceMinutesPerPrincipalMonth: number('Enter a whole number.')
      .int('Enter a whole number.')
      .min(0, 'Can’t be negative.')
      .max(10_000, 'At most 10,000 minutes.'),
    faceMinutesPerCall: number('Enter a whole number.')
      .int('Enter a whole number.')
      .min(1, 'At least 1 minute.')
      .max(240, 'At most 240 minutes.'),
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
    dailyUploadDocumentsPerPrincipal: settings.dailyUploadDocumentsPerPrincipal,
    dailyUploadMegabytesPerPrincipal: Math.round(settings.dailyUploadBytesPerPrincipal / MB),
    maxCallMinutes: settings.maxCallMinutes ?? CALL_DEFAULTS.maxCallMinutes,
    dailyCallMinutesPerPrincipal:
      settings.dailyCallMinutesPerPrincipal ?? CALL_DEFAULTS.dailyCallMinutesPerPrincipal,
    faceMinutesPerPrincipalMonth:
      settings.faceMinutesPerPrincipalMonth ?? CALL_DEFAULTS.faceMinutesPerPrincipalMonth,
    faceMinutesPerCall: settings.faceMinutesPerCall ?? CALL_DEFAULTS.faceMinutesPerCall,
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
  if (values.dailyUploadDocumentsPerPrincipal !== settings.dailyUploadDocumentsPerPrincipal) {
    patch.dailyUploadDocumentsPerPrincipal = values.dailyUploadDocumentsPerPrincipal;
  }
  if (values.dailyUploadMegabytesPerPrincipal !== Math.round(settings.dailyUploadBytesPerPrincipal / MB)) {
    patch.dailyUploadBytesPerPrincipal = values.dailyUploadMegabytesPerPrincipal * MB;
  }
  const saved = toLimitsFormValues(settings);
  if (values.maxCallMinutes !== saved.maxCallMinutes) patch.maxCallMinutes = values.maxCallMinutes;
  if (values.dailyCallMinutesPerPrincipal !== saved.dailyCallMinutesPerPrincipal) {
    patch.dailyCallMinutesPerPrincipal = values.dailyCallMinutesPerPrincipal;
  }
  if (values.faceMinutesPerPrincipalMonth !== saved.faceMinutesPerPrincipalMonth) {
    patch.faceMinutesPerPrincipalMonth = values.faceMinutesPerPrincipalMonth;
  }
  if (values.faceMinutesPerCall !== saved.faceMinutesPerCall)
    patch.faceMinutesPerCall = values.faceMinutesPerCall;
  return patch;
}

const FIELD_FOR_API: Record<string, LimitKey> = {
  dailyUsdCapGlobal: 'dailyUsdCapGlobal',
  dailyUsdCapPerPrincipal: 'dailyUsdCapPerPrincipal',
  maxTurnsPerSession: 'maxTurnsPerSession',
  groundingCoverageThreshold: 'groundingPercent',
  portfolioMinGroupSize: 'portfolioMinGroupSize',
  dailyUploadDocumentsPerPrincipal: 'dailyUploadDocumentsPerPrincipal',
  dailyUploadBytesPerPrincipal: 'dailyUploadMegabytesPerPrincipal',
  maxCallMinutes: 'maxCallMinutes',
  dailyCallMinutesPerPrincipal: 'dailyCallMinutesPerPrincipal',
  faceMinutesPerPrincipalMonth: 'faceMinutesPerPrincipalMonth',
  faceMinutesPerCall: 'faceMinutesPerCall',
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

/** Spend caps, call caps, upload quota, session length, grounding threshold and portfolio k. Saves changes only. */
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
        applyFieldErrors(err, setError, Object.values(FIELD_FOR_API), (path) => FIELD_FOR_API[path] ?? path);
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
    <SectionCard title="Limits and thresholds">
      <form
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
        aria-label="Limits and thresholds"
      >
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-semibold">Daily AI spend caps (USD)</legend>
          <Field
            subgrid
            label="Platform cap per day"
            description="New turns are refused once today’s total reaches it (UTC)."
            error={errors.dailyUsdCapGlobal?.message}
          >
            {numberInput('dailyUsdCapGlobal', { step: '0.5', min: 0, max: 100 })}
          </Field>
          <Field
            subgrid
            label="Cap per person per day"
            description="Stops one account from using the whole budget."
            error={errors.dailyUsdCapPerPrincipal?.message}
          >
            {numberInput('dailyUsdCapPerPrincipal', { step: '0.25', min: 0, max: 50 })}
          </Field>
        </fieldset>
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-semibold">Voice calls</legend>
          <Field
            subgrid
            label="Longest call (minutes)"
            description="A call ends when it reaches this."
            error={errors.maxCallMinutes?.message}
          >
            {numberInput('maxCallMinutes', { step: '1', min: 1, max: 240 })}
          </Field>
          <Field
            subgrid
            label="Call minutes per person per day"
            description="Further calls wait until midnight UTC."
            error={errors.dailyCallMinutesPerPrincipal?.message}
          >
            {numberInput('dailyCallMinutesPerPrincipal', { step: '1', min: 0, max: 1440 })}
          </Field>
        </fieldset>
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-semibold">Video face</legend>
          <Field
            subgrid
            label="Video minutes per person per month"
            description="Then the usual tile."
            error={errors.faceMinutesPerPrincipalMonth?.message}
          >
            {numberInput('faceMinutesPerPrincipalMonth', { step: '1', min: 0, max: 10_000 })}
          </Field>
          <Field
            subgrid
            label="Video minutes per call"
            description="Then the usual tile."
            error={errors.faceMinutesPerCall?.message}
          >
            {numberInput('faceMinutesPerCall', { step: '1', min: 1, max: 240 })}
          </Field>
        </fieldset>
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-semibold">Document uploads per person per day</legend>
          <Field
            subgrid
            label="Documents per day"
            description="Further uploads wait until midnight UTC."
            error={errors.dailyUploadDocumentsPerPrincipal?.message}
          >
            {numberInput('dailyUploadDocumentsPerPrincipal', { step: '1', min: 0, max: 1000 })}
          </Field>
          <Field
            subgrid
            label="Upload volume per day (MB)"
            description="Total size one person can upload in a day."
            error={errors.dailyUploadMegabytesPerPrincipal?.message}
          >
            {numberInput('dailyUploadMegabytesPerPrincipal', { step: '1', min: 0, max: 10_240 })}
          </Field>
        </fieldset>
        <fieldset className="grid gap-4 sm:grid-cols-3">
          <legend className="mb-2 text-sm font-semibold">Coaching quality and privacy</legend>
          <Field
            subgrid
            label="Max turns per session"
            description="Founders are then asked to start a new conversation."
            error={errors.maxTurnsPerSession?.message}
          >
            {numberInput('maxTurnsPerSession', { step: '1', min: 1, max: 200 })}
          </Field>
          <Field
            subgrid
            label="Grounding threshold (%)"
            description="Below this share of cited facts, answers are narrowed with an uncertainty banner."
            error={errors.groundingPercent?.message}
          >
            {numberInput('groundingPercent', { step: '1', min: 0, max: 100 })}
          </Field>
          <Field
            subgrid
            label="Portfolio minimum group size (k)"
            description="Smaller groups are hidden from program staff."
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
