import { VentureStage, type VentureDetail } from '@foundry/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { getRouteApi } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import { announce } from '@/components/a11y/live-announcer';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { PageSection } from '@/components/ui/page-section';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { MutationErrorAlert } from '@/features/admin/shared/form';
import { useUpdateVenture, useVenture } from '@/lib/api/hooks/ventures';
import { canWrite } from '@/lib/auth/roles';
import { useRequiredMe } from '@/lib/auth/use-me';
import { applyFieldErrors } from '@/lib/form-errors';
import { STAGE_LABELS, STAGE_ORDER } from '@/lib/labels';

import { SelectField } from '@/components/ui/select-field';
import { GoalEditor } from './goal-editor';
import { sentenceStart, useVeirName } from './veir-name';

const routeApi = getRouteApi('/$tenant/app/v/$ventureId/settings');

const ProfileForm = z.object({
  name: z.string().trim().min(3, 'Use at least 3 characters.').max(80, 'Use 80 characters or fewer.'),
  oneLiner: z.string().trim().max(280, 'Use 280 characters or fewer.'),
  stage: VentureStage,
});
type ProfileValues = z.infer<typeof ProfileForm>;

const PROFILE_FIELDS = ['name', 'oneLiner', 'stage'] as const;
const STAGE_OPTIONS = STAGE_ORDER.map((stage) => ({ value: stage, label: STAGE_LABELS[stage] }));

function profileOf(venture: VentureDetail): ProfileValues {
  return { name: venture.name, oneLiner: venture.oneLiner, stage: venture.stage };
}

/** Venture settings: the profile the vEIR and the program see (name, one-liner, stage) and the current goal. */
export function VentureSettingsPage() {
  const me = useRequiredMe();
  const { ventureId } = routeApi.useParams();
  const venture = useVenture(ventureId);
  const editable = canWrite(me, ventureId);
  const veirName = useVeirName(ventureId);

  return (
    <PageContainer size="narrow">
      <PageHeader
        title="Venture settings"
        info={`${sentenceStart(veirName)} uses the stage and current goal to focus each conversation.`}
      />
      {venture.isError ? (
        <ErrorState error={venture.error} onRetry={() => void venture.refetch()} />
      ) : !venture.data ? (
        <div aria-busy="true" className="grid gap-6">
          <span className="sr-only" role="status">
            Loading…
          </span>
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <div className="grid gap-10">
          <VentureProfileCard venture={venture.data} editable={editable} />
          <GoalEditor ventureId={ventureId} goal={venture.data.currentGoal} canEdit={editable} />
        </div>
      )}
    </PageContainer>
  );
}

/**
 * The venture's profile: read-only for people who can't edit it. A refusal that names a field (e.g. a name
 * another venture uses) is shown on that field only; the form-level alert is for failures that name none.
 */
export function VentureProfileCard({ venture, editable }: { venture: VentureDetail; editable: boolean }) {
  const update = useUpdateVenture(venture.id);
  // Whether the last failure was placed on its fields (then no form-level alert repeats or contradicts it).
  const [onFields, setOnFields] = useState(false);
  const { register, control, handleSubmit, formState, reset, setError } = useForm<ProfileValues>({
    resolver: zodResolver(ProfileForm),
    defaultValues: profileOf(venture),
  });

  // Adopt server changes (e.g. a rename by the program team) unless the person is mid-edit.
  useEffect(() => {
    if (!formState.isDirty) reset(profileOf(venture));
  }, [venture, formState.isDirty, reset]);

  const onSubmit = handleSubmit((values) => {
    const patch: Partial<ProfileValues> = {};
    if (values.name !== venture.name) patch.name = values.name;
    if (values.oneLiner !== venture.oneLiner) patch.oneLiner = values.oneLiner;
    if (values.stage !== venture.stage) patch.stage = values.stage;
    if (Object.keys(patch).length === 0) {
      reset(values);
      return;
    }
    update.mutate(patch, {
      onSuccess: (next) => {
        reset(profileOf(next));
        toast.success('Venture updated');
        announce('Venture updated');
      },
      onError: (error) => {
        setOnFields(applyFieldErrors(error, setError, PROFILE_FIELDS));
      },
    });
  });

  if (!editable) {
    return (
      <PageSection title="Profile">
        <dl className="grid gap-4 text-sm">
          <div className="grid gap-1">
            <dt className="text-muted-foreground">Name</dt>
            <dd className="font-medium">{venture.name}</dd>
          </div>
          <div className="grid gap-1">
            <dt className="text-muted-foreground">One-liner</dt>
            <dd>{venture.oneLiner || '—'}</dd>
          </div>
          <div className="grid gap-1">
            <dt className="text-muted-foreground">Stage</dt>
            <dd>{STAGE_LABELS[venture.stage]}</dd>
          </div>
        </dl>
      </PageSection>
    );
  }

  return (
    <PageSection title="Profile">
      <form noValidate onSubmit={(event) => void onSubmit(event)} className="grid gap-5">
        <Field label="Name" required error={formState.errors.name?.message}>
          <Input autoComplete="off" {...register('name')} />
        </Field>
        <Field label="One-liner" error={formState.errors.oneLiner?.message}>
          <Textarea minRows={2} maxRows={4} maxLength={280} {...register('oneLiner')} />
        </Field>
        <Controller
          control={control}
          name="stage"
          render={({ field }) => (
            <SelectField
              label="Stage"
              error={formState.errors.stage?.message}
              value={field.value}
              onChange={field.onChange}
              options={STAGE_OPTIONS}
            />
          )}
        />
        <MutationErrorAlert
          error={update.isError && !onFields ? update.error : null}
          title="Couldn’t save the venture"
        />
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            disabled={!formState.isDirty || update.isPending}
            onClick={() => {
              update.reset();
              reset(profileOf(venture));
            }}
          >
            Discard
          </Button>
          <Button
            type="submit"
            disabled={!formState.isDirty}
            loading={update.isPending}
            loadingText="Saving…"
          >
            Save changes
          </Button>
        </div>
      </form>
    </PageSection>
  );
}
