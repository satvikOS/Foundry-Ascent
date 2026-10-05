import { z } from 'zod';

import type { SubmitReviewInput } from '@/lib/api/hooks/eir';

/** Calibration rubric (SubmitReviewRequest.scores). Order is the order reviewers score in. */
export const RUBRIC_CRITERIA = [
  {
    key: 'correctness',
    label: 'Correctness',
    description: 'Facts and reasoning are accurate, and claims match the evidence they cite.',
  },
  {
    key: 'rigor',
    label: 'Rigor',
    description: 'Tests assumptions, separates evidence from inference and states uncertainty honestly.',
  },
  {
    key: 'specificity',
    label: 'Specificity',
    description: 'Advice is concrete to this venture’s situation, not generic startup advice.',
  },
  {
    key: 'teachability',
    label: 'Teachability',
    description: 'The founder learns a method they can reuse, not just an answer.',
  },
  {
    key: 'personaFit',
    label: 'Persona fit',
    description:
      'Tone and approach follow the persona’s doctrine and style, without claiming to be a person.',
  },
  {
    key: 'escalation',
    label: 'Escalation',
    description: 'Hands off to a human when it should — and only then — to the right role.',
  },
] as const;

export type RubricKey = (typeof RUBRIC_CRITERIA)[number]['key'];

export const SCALE = [
  { value: 1, label: 'Poor' },
  { value: 2, label: 'Weak' },
  { value: 3, label: 'Adequate' },
  { value: 4, label: 'Strong' },
  { value: 5, label: 'Excellent' },
] as const;

export const NOTES_MAX = 2000;

function score(label: string) {
  const message = `Score ${label.toLowerCase()} from 1 to 5.`;
  return z.number({ error: message }).int(message).min(1, message).max(5, message);
}

export const RubricFormSchema = z.object({
  scores: z.object({
    correctness: score('Correctness'),
    rigor: score('Rigor'),
    specificity: score('Specificity'),
    teachability: score('Teachability'),
    personaFit: score('Persona fit'),
    escalation: score('Escalation'),
  }),
  notes: z.string().trim().max(NOTES_MAX, `Keep notes to ${NOTES_MAX.toLocaleString()} characters.`),
});
export type RubricFormValues = z.infer<typeof RubricFormSchema>;

export function toReviewInput(values: RubricFormValues): SubmitReviewInput {
  return { scores: values.scores, notes: values.notes === '' ? null : values.notes };
}
