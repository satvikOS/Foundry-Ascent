import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import { announce } from '@/components/a11y/live-announcer';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
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
import { toast } from '@/components/ui/toast';
import { SelectField } from '@/components/ui/select-field';
import { MutationErrorAlert } from '@/features/admin/shared/form';
import { applyFieldErrors } from '@/lib/form-errors';
import { formatDate } from '@/lib/format';
import {
  type LibrarySource,
  useCreateLibrarySource,
  useUpdateLibrarySource,
} from '@/lib/api/hooks/veir-pools';

import { AUTHORED_KINDS, type AuthoredKind, isAuthoredKind, SOURCE_KINDS } from './library-labels';

/** Mirrors CreatePersonaKnowledgeRequest (the API validates again). */
const LibrarySourceForm = z.object({
  kind: z.enum(AUTHORED_KINDS),
  title: z
    .string()
    .trim()
    .min(3, 'Give it a title of at least 3 characters.')
    .max(200, 'Use 200 characters or fewer.'),
  body: z
    .string()
    .trim()
    .min(20, 'Write at least 20 characters.')
    .max(50_000, 'Use 50,000 characters or fewer.'),
});
type LibrarySourceFormValues = z.infer<typeof LibrarySourceForm>;

/** An uploaded document: only its title is edited (its text comes from the file). */
const DocumentTitleForm = LibrarySourceForm.extend({ body: z.string() });

export type LibrarySheetState =
  | { mode: 'closed' }
  | { mode: 'create'; kind: AuthoredKind }
  | { mode: 'edit'; source: LibrarySource }
  | { mode: 'view'; source: LibrarySource };

interface LibrarySourceSheetProps {
  personaId: string;
  /** "Corin" — whose library this is. */
  displayName: string;
  state: LibrarySheetState;
  onClose: () => void;
}

const KIND_OPTIONS = AUTHORED_KINDS.map((kind) => ({ value: kind, label: SOURCE_KINDS[kind].label }));

/** "note", "case", "FAQ", … for sentences ("New FAQ", "Edit note"). */
function kindNoun(kind: LibrarySource['kind']): string {
  const label = SOURCE_KINDS[kind].label;
  return kind === 'faq' ? label : label.toLowerCase();
}

/** Write, edit or read one library source. Saving re-chunks it, so the vEIR draws on the new text at once. */
export function LibrarySourceSheet({ personaId, displayName, state, onClose }: LibrarySourceSheetProps) {
  const open = state.mode !== 'closed';
  const source = state.mode === 'edit' || state.mode === 'view' ? state.source : null;
  const authored = source === null || isAuthoredKind(source.kind);
  const create = useCreateLibrarySource(personaId);
  const update = useUpdateLibrarySource(personaId);
  const mutation = state.mode === 'create' ? create : update;

  const form = useForm<LibrarySourceFormValues>({
    resolver: zodResolver(authored ? LibrarySourceForm : DocumentTitleForm),
    defaultValues: { kind: 'note', title: '', body: '' },
  });
  const { register, control, handleSubmit, formState, reset, setError } = form;

  useEffect(() => {
    if (state.mode === 'create') reset({ kind: state.kind, title: '', body: '' });
    if (state.mode === 'edit' || state.mode === 'view') {
      const s = state.source;
      reset({ kind: isAuthoredKind(s.kind) ? s.kind : 'note', title: s.title, body: s.body ?? '' });
    }
  }, [state, reset]);

  const close = () => {
    if (mutation.isPending) return;
    create.reset();
    update.reset();
    onClose();
  };

  const onSubmit = handleSubmit((values) => {
    const done = (message: string) => {
      toast.success(message);
      announce(message);
      close();
    };
    const onError = (error: unknown) => {
      applyFieldErrors(error, setError, ['title', 'body', 'kind']);
    };
    if (state.mode === 'create') {
      create.mutate(
        { kind: values.kind, title: values.title, body: values.body },
        {
          onSuccess: () => {
            done(`Added “${values.title.trim()}”`);
          },
          onError,
        },
      );
    } else if (state.mode === 'edit') {
      const s = state.source;
      const input = {
        ...(values.title.trim() !== s.title ? { title: values.title } : {}),
        ...(authored && values.body.trim() !== (s.body ?? '') ? { body: values.body } : {}),
      };
      if (Object.keys(input).length === 0) {
        close();
        return;
      }
      update.mutate(
        { sourceId: s.id, input },
        {
          onSuccess: () => {
            done('Changes saved');
          },
          onError,
        },
      );
    }
  });

  const noun = kindNoun(source?.kind ?? (state.mode === 'create' ? state.kind : 'note'));
  const title =
    state.mode === 'create' ? `New ${noun}` : state.mode === 'edit' ? `Edit ${noun}` : (source?.title ?? '');
  const e = formState.errors;

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <SheetContent className="w-[min(100vw-1rem,40rem)]">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>
            {state.mode === 'view' && source
              ? `${SOURCE_KINDS[source.kind].label} · updated ${formatDate(source.updatedAt)}${source.createdBy ? ` · by ${source.createdBy.displayName}` : ''}`
              : `${displayName} draws on it in every venture it coaches.`}
          </SheetDescription>
        </SheetHeader>
        {state.mode === 'view' && source ? (
          <SheetBody>
            {source.body ? (
              <p className="prose-reading whitespace-pre-wrap">{source.body}</p>
            ) : (
              <p className="text-small text-muted-foreground">
                {source.summary ?? 'An uploaded document. Its text is searchable once processed.'}
              </p>
            )}
          </SheetBody>
        ) : (
          <form
            noValidate
            aria-label={title}
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => void onSubmit(event)}
          >
            <SheetBody className="grid content-start gap-5">
              {state.mode === 'create' ? (
                <Controller
                  control={control}
                  name="kind"
                  render={({ field }) => (
                    <SelectField
                      label="Kind"
                      value={field.value}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      options={KIND_OPTIONS}
                      description={SOURCE_KINDS[field.value].description}
                    />
                  )}
                />
              ) : null}
              <Field label="Title" required error={e.title?.message}>
                <Input autoComplete="off" {...register('title')} />
              </Field>
              {authored ? (
                <Field
                  label="Text"
                  required
                  description="Markdown headings and lists are kept as structure."
                  error={e.body?.message}
                >
                  <Textarea
                    minRows={12}
                    maxRows={28}
                    className="font-serif text-base leading-7"
                    {...register('body')}
                  />
                </Field>
              ) : null}
              <MutationErrorAlert error={mutation.error} title="Not saved" />
            </SheetBody>
            <SheetFooter className="justify-end">
              <Button variant="secondary" onClick={close} disabled={mutation.isPending}>
                Cancel
              </Button>
              <Button type="submit" loading={mutation.isPending} loadingText="Saving…">
                {state.mode === 'create' ? 'Add to library' : 'Save'}
              </Button>
            </SheetFooter>
          </form>
        )}
      </SheetContent>
    </Sheet>
  );
}
