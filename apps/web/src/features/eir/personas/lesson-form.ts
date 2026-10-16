import type { LessonView } from '@foundry/contracts';
import { z } from 'zod';

import type { CreateLessonInput, LessonActionInput } from '@/lib/api/hooks/veir-pools';

const field = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(3, `${label} needs at least 3 characters.`)
    .max(max, `Use ${max.toLocaleString()} characters or fewer.`);

/** Mirrors CreateLessonRequest (the API validates again). */
export const LessonForm = z.object({
  title: field('The title', 200),
  context: field('The context', 2000),
  signal: field('The signal', 2000),
  intervention: field('What helps', 2000),
  outcome: field('The outcome', 2000),
  limits: field('The limits', 2000),
});
export type LessonFormValues = z.infer<typeof LessonForm>;

export const LESSON_FIELDS: readonly {
  name: keyof LessonFormValues;
  label: string;
  description: string;
}[] = [
  { name: 'title', label: 'Title', description: 'One line a founder would recognise.' },
  { name: 'context', label: 'Context', description: 'When this applies.' },
  { name: 'signal', label: 'Signal', description: 'What the founder says or does that shows it.' },
  { name: 'intervention', label: 'What helps', description: 'The move that works.' },
  { name: 'outcome', label: 'Outcome', description: 'What usually happens next.' },
  { name: 'limits', label: 'Limits', description: 'When it doesn’t hold.' },
];

export const EMPTY_LESSON: LessonFormValues = {
  title: '',
  context: '',
  signal: '',
  intervention: '',
  outcome: '',
  limits: '',
};

export function lessonToForm(lesson: LessonView): LessonFormValues {
  return {
    title: lesson.title,
    context: lesson.context,
    signal: lesson.signal,
    intervention: lesson.intervention,
    outcome: lesson.outcome,
    limits: lesson.limits,
  };
}

export function formToLesson(values: LessonFormValues): CreateLessonInput {
  return {
    title: values.title.trim(),
    context: values.context.trim(),
    signal: values.signal.trim(),
    intervention: values.intervention.trim(),
    outcome: values.outcome.trim(),
    limits: values.limits.trim(),
  };
}

/** The `edit` action with only the fields that changed, or null when nothing did. */
export function lessonEdit(lesson: LessonView, values: LessonFormValues): LessonActionInput | null {
  const next = formToLesson(values);
  const changed = (Object.keys(next) as (keyof LessonFormValues)[]).filter(
    (key) => next[key] !== lesson[key],
  );
  if (changed.length === 0) return null;
  return { action: 'edit', ...Object.fromEntries(changed.map((key) => [key, next[key]])) };
}
