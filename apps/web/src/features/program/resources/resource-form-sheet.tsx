import { zodResolver } from '@hookform/resolvers/zod';
import { ResourceKind, VentureStage, type ResourceView } from '@foundry/contracts';
import { useId } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { announce } from '@/components/a11y/live-announcer';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import {
  applyServerFieldErrors,
  MutationErrorAlert,
  parseCommaList,
  SelectField,
} from '@/features/admin/shared/form';
import { useCreateResource, useUpdateResource, type UpsertResourceInput } from '@/lib/api/hooks/program';
import { STAGE_LABELS, STAGE_ORDER } from '@/lib/labels';

import { RESOURCE_KIND_LABELS } from './freshness';

const ResourceForm = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(160, 'Use 160 characters or fewer.'),
  kind: ResourceKind,
  description: z
    .string()
    .trim()
    .min(1, 'Describe what the resource offers and who it is for.')
    .max(2000, 'Use 2,000 characters or fewer.'),
  url: z.union([
    z.literal(''),
    z.url({ protocol: /^https?$/, error: 'Enter a full web address starting with https://' }),
  ]),
  tags: z.string().superRefine((value, ctx) => {
    const tags = parseCommaList(value);
    if (tags.length > 20) ctx.addIssue({ code: 'custom', message: 'Use at most 20 tags.' });
    if (tags.some((tag) => tag.length > 40))
      ctx.addIssue({ code: 'custom', message: 'Each tag must be 40 characters or fewer.' });
  }),
  stages: z.array(VentureStage),
  eligibility: z.string().trim().max(500, 'Use 500 characters or fewer.'),
  owner: z.string().trim().max(120, 'Use 120 characters or fewer.'),
});
type ResourceFormValues = z.infer<typeof ResourceForm>;

const KIND_OPTIONS = ResourceKind.options.map((kind) => ({ value: kind, label: RESOURCE_KIND_LABELS[kind] }));

function toFormValues(resource: ResourceView | null): ResourceFormValues {
  return {
    name: resource?.name ?? '',
    kind: resource?.kind ?? 'program',
    description: resource?.description ?? '',
    url: resource?.url ?? '',
    tags: resource?.tags.join(', ') ?? '',
    stages: resource?.stages ?? [],
    eligibility: resource?.eligibility ?? '',
    owner: resource?.owner ?? '',
  };
}

function toRequest(values: ResourceFormValues): Required<UpsertResourceInput> {
  return {
    name: values.name,
    kind: values.kind,
    description: values.description,
    url: values.url === '' ? null : values.url,
    tags: parseCommaList(values.tags),
    stages: STAGE_ORDER.filter((stage) => values.stages.includes(stage)),
    eligibility: values.eligibility === '' ? null : values.eligibility,
    owner: values.owner === '' ? null : values.owner,
  };
}

/** Fields that differ from the stored resource (PATCH sends only what changed). */
export function resourcePatch(
  resource: ResourceView,
  request: Required<UpsertResourceInput>,
): Partial<UpsertResourceInput> {
  const original = toRequest(toFormValues(resource));
  const patch: Partial<UpsertResourceInput> = {};
  for (const key of Object.keys(request) as (keyof UpsertResourceInput)[]) {
    if (JSON.stringify(request[key]) !== JSON.stringify(original[key])) {
      Object.assign(patch, { [key]: request[key] });
    }
  }
  return patch;
}

interface ResourceFormSheetProps {
  open: boolean;
  /** null = create a new resource. */
  resource: ResourceView | null;
  onOpenChange: (open: boolean) => void;
}

export function ResourceFormSheet({ open, resource, onOpenChange }: ResourceFormSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[min(100vw-2.5rem,36rem)]">
        {open ? (
          <ResourceFormBody
            key={resource?.id ?? 'new'}
            resource={resource}
            onDone={() => {
              onOpenChange(false);
            }}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function ResourceFormBody({ resource, onDone }: { resource: ResourceView | null; onDone: () => void }) {
  const create = useCreateResource();
  const update = useUpdateResource();
  const mutation = resource ? update : create;
  const stagesLegend = useId();
  const { register, control, handleSubmit, formState, setError } = useForm<ResourceFormValues>({
    resolver: zodResolver(ResourceForm),
    defaultValues: toFormValues(resource),
  });
  const fields = ['name', 'kind', 'description', 'url', 'tags', 'stages', 'eligibility', 'owner'] as const;
  const onError = (error: unknown) => {
    applyServerFieldErrors(error, setError, fields);
  };

  const onSubmit = handleSubmit((values) => {
    const request = toRequest(values);
    if (!resource) {
      create.mutate(request, {
        onSuccess: (created) => {
          toast.success(`Added “${created.name}”`);
          announce('Resource added');
          onDone();
        },
        onError,
      });
      return;
    }
    const patch = resourcePatch(resource, request);
    if (Object.keys(patch).length === 0) {
      onDone();
      return;
    }
    update.mutate(
      { resourceId: resource.id, patch },
      {
        onSuccess: () => {
          toast.success('Resource updated');
          announce('Resource updated');
          onDone();
        },
        onError,
      },
    );
  });

  return (
    <>
      <SheetHeader>
        <SheetTitle>{resource ? `Edit ${resource.name}` : 'Add a resource'}</SheetTitle>
        <SheetDescription>
          Foundry Guide recommends these in route mode. Keep eligibility and links accurate.
        </SheetDescription>
      </SheetHeader>
      <form
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="flex min-h-0 flex-1 flex-col"
        aria-label={resource ? 'Edit resource' : 'New resource'}
      >
        <SheetBody className="grid content-start gap-4">
          <Field label="Name" required error={formState.errors.name?.message}>
            <Input autoComplete="off" {...register('name')} />
          </Field>
          <Controller
            control={control}
            name="kind"
            render={({ field }) => (
              <SelectField
                label="Kind"
                required
                value={field.value}
                onChange={field.onChange}
                onBlur={field.onBlur}
                options={KIND_OPTIONS}
                error={formState.errors.kind?.message}
              />
            )}
          />
          <Field label="Description" required error={formState.errors.description?.message}>
            <Textarea minRows={3} maxRows={8} {...register('description')} />
          </Field>
          <Field
            label="Link"
            description="Optional. Must start with https://"
            error={formState.errors.url?.message}
          >
            <Input
              type="url"
              inputMode="url"
              autoComplete="off"
              placeholder="https://"
              {...register('url')}
            />
          </Field>
          <Controller
            control={control}
            name="stages"
            render={({ field }) => (
              <fieldset aria-describedby={`${stagesLegend}-hint`} className="grid gap-2">
                <legend className="text-sm font-medium">Relevant stages</legend>
                <p id={`${stagesLegend}-hint`} className="text-[13px] text-muted-foreground">
                  Leave all unchecked if it applies at every stage.
                </p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {STAGE_ORDER.map((stage) => {
                    const id = `${stagesLegend}-${stage}`;
                    const checked = field.value.includes(stage);
                    return (
                      <div key={stage} className="flex items-center gap-2">
                        <Checkbox
                          id={id}
                          checked={checked}
                          onCheckedChange={(next) => {
                            field.onChange(
                              next === true
                                ? [...field.value, stage]
                                : field.value.filter((value) => value !== stage),
                            );
                          }}
                        />
                        <Label htmlFor={id} className="font-normal">
                          {STAGE_LABELS[stage]}
                        </Label>
                      </div>
                    );
                  })}
                </div>
              </fieldset>
            )}
          />
          <Field
            label="Tags"
            description="Comma-separated, e.g. “seed, hardware, grants”."
            error={formState.errors.tags?.message}
          >
            <Input autoComplete="off" {...register('tags')} />
          </Field>
          <Field
            label="Eligibility"
            description="Optional. Who can apply and when."
            error={formState.errors.eligibility?.message}
          >
            <Textarea minRows={2} maxRows={5} {...register('eligibility')} />
          </Field>
          <Field
            label="Owner"
            description="Optional. The team or person who maintains it."
            error={formState.errors.owner?.message}
          >
            <Input autoComplete="off" {...register('owner')} />
          </Field>
          <MutationErrorAlert error={mutation.error} title="Couldn’t save the resource" />
        </SheetBody>
        <SheetFooter className="justify-end">
          <Button variant="secondary" onClick={onDone} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button type="submit" loading={mutation.isPending} loadingText="Saving…">
            {resource ? 'Save changes' : 'Add resource'}
          </Button>
        </SheetFooter>
      </form>
    </>
  );
}
