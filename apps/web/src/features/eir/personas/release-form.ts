import { CoachMode, type PersonaReleaseView } from '@foundry/contracts';
import { z } from 'zod';

import { joinLines, parseLines } from '@/features/admin/shared/form';
import type { CreatePersonaReleaseInput } from '@/lib/api/hooks/eir';

/**
 * "New release" editor schema. Lists are edited as one-item-per-line textareas and converted to the
 * contract's arrays on submit (the hook validates the result against CreatePersonaReleaseRequest
 * again before sending). Limits keep prompts bounded (system-design §7: ≤ 12k input tokens).
 */
function lines(opts: { label: string; min?: number; max: number; itemMax: number }) {
  return z.string().superRefine((value, ctx) => {
    const items = parseLines(value);
    if (opts.min !== undefined && items.length < opts.min) {
      ctx.addIssue({
        code: 'custom',
        message:
          opts.min === 1
            ? `Add at least one ${opts.label}.`
            : `Add at least ${opts.min} ${opts.label}s (one per line).`,
      });
    }
    if (items.length > opts.max) ctx.addIssue({ code: 'custom', message: `Use at most ${opts.max} lines.` });
    const long = items.findIndex((item) => item.length > opts.itemMax);
    if (long >= 0) {
      ctx.addIssue({
        code: 'custom',
        message: `Line ${long + 1} is too long (max ${opts.itemMax} characters).`,
      });
    }
  });
}

const text = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .max(max, `Use ${max.toLocaleString()} characters or fewer.`);

export const FrameworkForm = z.object({
  name: text('A name', 120),
  whenToUse: text('When to use it', 500),
  keyQuestions: lines({ label: 'key question', min: 1, max: 10, itemMax: 300 }),
});

export const ReleaseFormSchema = z.object({
  summary: text('A summary', 2000),
  frameworks: z.array(FrameworkForm).max(12, 'Use at most 12 frameworks.'),
  evidenceStandard: text('An evidence standard', 1000),
  typicalQuestions: lines({ label: 'question', max: 20, itemMax: 300 }),
  redLines: lines({ label: 'red line', min: 1, max: 20, itemMax: 300 }),
  escalationTopics: lines({ label: 'escalation topic', min: 1, max: 20, itemMax: 200 }),
  referralDestinations: lines({ label: 'referral destination', max: 20, itemMax: 200 }),
  teachingPrinciples: lines({ label: 'teaching principle', max: 20, itemMax: 300 }),
  directness: z.enum(['gentle', 'balanced', 'direct']),
  warmth: z.enum(['reserved', 'warm']),
  pace: z.enum(['measured', 'brisk']),
  vocabulary: lines({ label: 'term', max: 30, itemMax: 60 }),
  feedbackStructure: text('A feedback structure', 1000),
  avoid: lines({ label: 'item', max: 30, itemMax: 200 }),
  disclosureText: z
    .string()
    .trim()
    .min(40, 'The disclosure must be at least 40 characters.')
    .max(600, 'Use 600 characters or fewer.')
    .refine((value) => /\bAI\b/.test(value), 'The disclosure must say plainly that this is an AI.'),
  allowedModes: z.array(CoachMode).min(1, 'Allow at least one coaching mode.'),
});
export type ReleaseFormValues = z.infer<typeof ReleaseFormSchema>;

export const EMPTY_FRAMEWORK: ReleaseFormValues['frameworks'][number] = {
  name: '',
  whenToUse: '',
  keyQuestions: '',
};

/** Prefill from the active release (or sensible blanks for a first release). */
export function releaseToForm(
  release: PersonaReleaseView | null,
  defaultDisclosure: string,
): ReleaseFormValues {
  const d = release?.doctrine;
  const s = release?.style;
  return {
    summary: d?.summary ?? '',
    frameworks: (d?.frameworks ?? []).map((f) => ({
      name: f.name,
      whenToUse: f.whenToUse,
      keyQuestions: joinLines(f.keyQuestions),
    })),
    evidenceStandard: d?.evidenceStandard ?? '',
    typicalQuestions: joinLines(d?.typicalQuestions ?? []),
    redLines: joinLines(d?.redLines ?? []),
    escalationTopics: joinLines(d?.escalationTopics ?? []),
    referralDestinations: joinLines(d?.referralDestinations ?? []),
    teachingPrinciples: joinLines(d?.teachingPrinciples ?? []),
    directness: s?.directness ?? 'balanced',
    warmth: s?.warmth ?? 'warm',
    pace: s?.pace ?? 'measured',
    vocabulary: joinLines(s?.vocabulary ?? []),
    feedbackStructure: s?.feedbackStructure ?? '',
    avoid: joinLines(s?.avoid ?? []),
    disclosureText: release?.disclosureText ?? defaultDisclosure,
    allowedModes: release?.allowedModes ?? [...CoachMode.options],
  };
}

export function formToRelease(values: ReleaseFormValues): CreatePersonaReleaseInput {
  return {
    doctrine: {
      summary: values.summary.trim(),
      frameworks: values.frameworks.map((f) => ({
        name: f.name.trim(),
        whenToUse: f.whenToUse.trim(),
        keyQuestions: parseLines(f.keyQuestions),
      })),
      evidenceStandard: values.evidenceStandard.trim(),
      typicalQuestions: parseLines(values.typicalQuestions),
      redLines: parseLines(values.redLines),
      escalationTopics: parseLines(values.escalationTopics),
      referralDestinations: parseLines(values.referralDestinations),
      teachingPrinciples: parseLines(values.teachingPrinciples),
    },
    style: {
      directness: values.directness,
      warmth: values.warmth,
      pace: values.pace,
      vocabulary: parseLines(values.vocabulary),
      feedbackStructure: values.feedbackStructure.trim(),
      avoid: parseLines(values.avoid),
    },
    disclosureText: values.disclosureText.trim(),
    // Keep the canonical mode order regardless of click order.
    allowedModes: CoachMode.options.filter((mode) => values.allowedModes.includes(mode)),
  };
}
