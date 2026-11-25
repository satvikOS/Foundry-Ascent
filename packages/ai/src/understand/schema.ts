import { z } from 'zod';

import { RESULT_VERDICTS, SUM_UNITS, UNDERSTOOD_KINDS, UNDERSTOOD_REFERRALS } from './types.js';

/** Name of the structured output schema sent to the model. */
export const UNDERSTAND_SCHEMA_NAME = 'Understanding';

/** The whole budget of the call, by channel: a later answer is no answer (the turn goes on by its rules). */
export const UNDERSTAND_TIMEOUT_MS = { text: 2_500, voice: 1_200 } as const;

/** Output bound: about 450 tokens are asked for; more is room for a long sum, never for prose. */
export const UNDERSTAND_MAX_OUTPUT_TOKENS = 800;

/**
 * What the model fills. The fields that reason come first, so they carry the rest; nested one level, every field
 * required, lengths held afterwards (`checkUnderstanding`): a long string is cut or left out there, never a failed call.
 * A list the model got wrong, or a kind it has no word for, costs that field alone.
 */
export const RawUnderstanding = z.object({
  ask: z.string(),
  second_ask: z.string().nullable(),
  kind: z.enum(UNDERSTOOD_KINDS).catch('question'),
  also: z.array(z.enum(UNDERSTOOD_KINDS)).catch([]),
  /** Keys of the record lines that bear on it. */
  record: z.array(z.string()).catch([]),
  contradicts: z.object({ record: z.string(), why: z.string() }).nullable().catch(null),
  /** The numbers the sums below work with. */
  inputs: z
    .array(
      z.object({
        name: z.string(),
        value: z.number(),
        unit: z.enum(['$', '%', 'count', 'time']).catch('count'),
        /** `message`, `history`, `standard` or a record key. */
        from: z.string(),
      }),
    )
    .catch([]),
  sums: z
    .array(
      z.object({
        label: z.string(),
        unit: z.enum(SUM_UNITS).catch('units'),
        noun: z.string().nullable(),
        expr: z.string(),
        round: z.enum(['none', 'up', 'down']).catch('none'),
        asked: z.boolean(),
      }),
    )
    .catch([]),
  missing: z.string().nullable(),
  choice: z
    .object({
      options: z.array(z.string()),
      pick: z.string(),
      because: z.string(),
      flips_if: z.string().nullable(),
    })
    .nullable()
    .catch(null),
  result: z
    .object({
      verdict: z.enum(RESULT_VERDICTS),
      shows: z.string(),
      does_not_show: z.string().nullable(),
      settles: z.string().nullable(),
    })
    .nullable()
    .catch(null),
  referral: z.enum(UNDERSTOOD_REFERRALS).nullable().catch(null),
  play: z.string().nullable(),
  step_play: z.string().nullable(),
  sure: z.enum(['high', 'low']).catch('low'),
  points: z.array(z.object({ text: z.string(), basis: z.string() })).catch([]),
  first_action: z.string().nullable(),
  avoid: z.string().nullable(),
});
export type RawUnderstanding = z.infer<typeof RawUnderstanding>;
