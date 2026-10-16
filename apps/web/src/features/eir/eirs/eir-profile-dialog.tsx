import { zodResolver } from '@hookform/resolvers/zod';
import { UserPen, UserPlus } from 'lucide-react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import { announce } from '@/components/a11y/live-announcer';
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
import { SelectField } from '@/components/ui/select-field';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { MutationErrorAlert, parseCommaList } from '@/features/admin/shared/form';
import {
  useCreateEirProfile,
  useEirCandidates,
  useUpdateEirProfile,
  type EirProfile,
} from '@/lib/api/hooks/veir-pools';
import { applyFieldErrors } from '@/lib/form-errors';

import { CONSENT_FIRST } from './eir-veir';

const ProfileForm = z.object({
  principalId: z.string(),
  displayName: z.string().trim().min(2, 'Enter the person’s name.').max(120, 'Use 120 characters or fewer.'),
  title: z.string().trim().max(120, 'Use 120 characters or fewer.'),
  expertise: z.string().max(600, 'Keep the list shorter.'),
  bio: z.string().trim().max(2000, 'Use 2,000 characters or fewer.'),
});
type ProfileFormValues = z.infer<typeof ProfileForm>;

const FIELDS = ['principalId', 'displayName', 'title', 'expertise', 'bio'] as const;

/** A server error at `expertiseTags` (or one of its entries) belongs to the expertise field. */
function fieldOf(path: string): string {
  return path === 'expertiseTags' || path.startsWith('expertiseTags.') ? 'expertise' : path;
}

interface EirProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The EIR to edit; absent to add one. Key the dialog by it: the form starts from it. */
  profile?: EirProfile | null;
}

/**
 * Add an EIR (link a person who has the EIR role to a profile) or edit one: name, title, areas of expertise and
 * a short bio. Adding one records no consent: the EIR records it on their vEIR before it can be released.
 */
export function EirProfileDialog({ open, onOpenChange, profile = null }: EirProfileDialogProps) {
  const editing = profile !== null;
  const candidates = useEirCandidates({ enabled: open && !editing });
  const create = useCreateEirProfile();
  const update = useUpdateEirProfile();
  const mutation = editing ? update : create;
  const { register, control, handleSubmit, formState, setError, reset, setValue, getValues } =
    useForm<ProfileFormValues>({
      resolver: zodResolver(
        ProfileForm.refine((values) => editing || values.principalId !== '', {
          path: ['principalId'],
          message: 'Choose the person.',
        }),
      ),
      defaultValues: {
        principalId: profile?.principal?.id ?? '',
        displayName: profile?.displayName ?? '',
        title: profile?.title ?? '',
        expertise: profile?.expertiseTags.join(', ') ?? '',
        bio: profile?.bio ?? '',
      },
    });
  const e = formState.errors;
  const people = candidates.data ?? [];
  const noOneToAdd = !editing && candidates.isSuccess && people.length === 0;

  const close = () => {
    if (mutation.isPending) return;
    create.reset();
    update.reset();
    reset();
    onOpenChange(false);
  };

  const onError = (error: unknown) => {
    applyFieldErrors(error, setError, FIELDS, fieldOf);
  };

  const onSubmit = handleSubmit((values) => {
    const fields = {
      displayName: values.displayName,
      title: values.title === '' ? null : values.title,
      expertiseTags: parseCommaList(values.expertise),
      bio: values.bio === '' ? null : values.bio,
    };
    if (profile) {
      update.mutate(
        { profileId: profile.id, input: fields },
        {
          onSuccess: (saved) => {
            toast.success(`${saved.displayName} saved`);
            announce(`${saved.displayName} saved`);
            close();
          },
          onError,
        },
      );
      return;
    }
    create.mutate(
      { principalId: values.principalId, ...fields },
      {
        onSuccess: (saved) => {
          toast.success(`${saved.displayName} added. ${CONSENT_FIRST}.`);
          announce(`${saved.displayName} added. ${CONSENT_FIRST}.`);
          close();
        },
        onError,
      },
    );
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {editing ? (
              <UserPen aria-hidden className="size-4" />
            ) : (
              <UserPlus aria-hidden className="size-4" />
            )}
            {editing ? `Edit ${profile.displayName}` : 'Add EIR'}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? 'How the program knows them. Their vEIR keeps its own name and doctrine.'
              : 'A person a vEIR can be built from. They sign in with their own access code.'}
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          aria-label={editing ? 'Edit EIR' : 'Add EIR'}
          className="grid gap-4"
          onSubmit={(event) => void onSubmit(event)}
        >
          {editing ? (
            profile.principal ? (
              <p className="text-small text-muted-foreground">Signs in as {profile.principal.displayName}.</p>
            ) : null
          ) : candidates.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : noOneToAdd ? (
            <Alert variant="info" title="No one to add yet">
              Everyone with the EIR role already has a profile. A platform admin gives someone the role under
              People &amp; access, then they appear here.
            </Alert>
          ) : (
            <Controller
              control={control}
              name="principalId"
              render={({ field }) => (
                <SelectField
                  label="Person"
                  required
                  value={field.value}
                  placeholder="Choose a person with the EIR role"
                  onChange={(next) => {
                    const previous = people.find((p) => p.id === field.value);
                    const picked = people.find((p) => p.id === next);
                    // Suggest their own name and title until someone types others.
                    if (
                      picked &&
                      (getValues('displayName') === '' || getValues('displayName') === previous?.displayName)
                    ) {
                      setValue('displayName', picked.displayName);
                    }
                    if (
                      picked?.title &&
                      (getValues('title') === '' || getValues('title') === previous?.title)
                    ) {
                      setValue('title', picked.title);
                    }
                    field.onChange(next);
                  }}
                  onBlur={field.onBlur}
                  options={people.map((p) => ({ value: p.id, label: p.displayName }))}
                  error={e.principalId?.message}
                />
              )}
            />
          )}
          <Field
            label="Name"
            required
            description="Their real name, as founders know them."
            error={e.displayName?.message}
          >
            <Input autoComplete="off" {...register('displayName')} />
          </Field>
          <Field label="Title" description="Optional." error={e.title?.message}>
            <Input autoComplete="off" placeholder="Former VP Sales, Gridline" {...register('title')} />
          </Field>
          <Field
            label="Areas of expertise"
            description="Comma-separated, e.g. pricing, b2b sales."
            error={e.expertise?.message}
          >
            <Input autoComplete="off" {...register('expertise')} />
          </Field>
          <Field
            label="Bio"
            description="A few sentences on their background. Optional."
            error={e.bio?.message}
          >
            <Textarea minRows={3} maxRows={8} {...register('bio')} />
          </Field>
          {editing ? null : (
            <p className="text-small text-muted-foreground">
              {CONSENT_FIRST}. They record it themselves on their vEIR’s Consent tab.
            </p>
          )}
          <MutationErrorAlert
            error={mutation.error}
            title={editing ? 'Changes weren’t saved' : 'The EIR wasn’t added'}
          />
          <DialogFooter>
            <Button variant="secondary" onClick={close} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={mutation.isPending}
              loadingText={editing ? 'Saving…' : 'Adding…'}
              disabled={noOneToAdd}
            >
              {editing ? 'Save' : 'Add EIR'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
