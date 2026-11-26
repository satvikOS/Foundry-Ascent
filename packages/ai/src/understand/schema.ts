import { z } from 'zod';

import {
  RESULT_VERDICTS,
  UNDERSTOOD_REFERRALS,
  type ResultVerdict,
  type SumUnit,
  type UnderstoodKind,
  type UnderstoodReferral,
} from './types.js';

/**
 * The reading is three small calls made at once, each with its own prompt and answer, so that it takes as long as its
 * longest part and a late part costs only itself: ROUTE (what is asked, which kind, which play, who decides), SUMS (the
 * figure they ask for, over named numbers) and JUDGE (what it shows, which option, what the answer must say).
 */
export const UNDERSTAND_PARTS = ['route', 'sums', 'judge'] as const;
export type UnderstandPart = (typeof UNDERSTAND_PARTS)[number];

/** How a part is asked: JUDGE is shorter on a call, where the reply waits for nothing it does not open on. */
export const UNDERSTAND_FORMS = ['route', 'sums', 'judge', 'judgeVoice'] as const;
export type UnderstandForm = (typeof UNDERSTAND_FORMS)[number];

/** Names of the structured output schemas sent to the model. */
export const UNDERSTAND_SCHEMA_NAMES: Readonly<Record<UnderstandForm, string>> = {
  route: 'UnderstandRoute',
  sums: 'UnderstandSums',
  judge: 'UnderstandJudge',
  judgeVoice: 'UnderstandJudgeVoice',
};

/** The whole budget of a reading, by channel (`CORE_UNDERSTAND_TYPED_MS`, `CORE_UNDERSTAND_VOICE_MS`): what is late then is left. */
export const UNDERSTAND_TIMEOUT_MS = { text: 3_000, voice: 1_700 } as const;

/** How long JUDGE is waited for once ROUTE and SUMS are in, where the reply does not open on what it says. */
export const UNDERSTAND_JUDGE_WAIT_MS = { text: 700, voice: 250 } as const;

/** Output bounds: 60 to 150 tokens are asked for; more is room for a long sum, never for prose. */
export const UNDERSTAND_MAX_OUTPUT_TOKENS: Readonly<Record<UnderstandForm, number>> = {
  route: 220,
  sums: 320,
  judge: 380,
  judgeVoice: 200,
};

/**
 * What the model fills: short keys, reasoning first, every field required (a null is a token), lengths held afterwards
 * (`readUnderstanding`). A field of the wrong form costs that field alone.
 */
export const RouteReading = z.object({
  /** What they ask; a second thing asked. */
  a: z.string(),
  b: z.string().nullable().catch(null),
  /** Kinds, the main one first; a word that is none is left out (merge.ts). */
  k: z.array(z.string()).catch([]),
  /** Keys of the record lines the answer needs. */
  r: z.array(z.string()).catch([]),
  /** The record line the message denies or changes. */
  c: z.string().nullable().catch(null),
  /** Who must decide it. */
  f: z.enum(UNDERSTOOD_REFERRALS).nullable().catch(null),
  /** The play that answers; the play whose step serves the ask; whether the first one plainly answers. */
  p: z.string().nullable().catch(null),
  s: z.string().nullable().catch(null),
  h: z.boolean().catch(false),
});
export type RouteReading = z.infer<typeof RouteReading>;

export const SumsReading = z.object({
  /** The figure this message asks for, in words. */
  q: z.string().nullable().catch(null),
  /** How it is worked out, in words: the plan the sum is written from, never shown. */
  w: z.string().nullable().catch(null),
  /** The numbers, `name=value@where`. */
  n: z.array(z.string()).catch([]),
  /** The sums: label, unit (or what is counted), expression. */
  s: z.array(z.object({ l: z.string(), u: z.string().catch('units'), e: z.string() })).catch([]),
  /** The number that is nowhere. */
  m: z.string().nullable().catch(null),
});
export type SumsReading = z.infer<typeof SumsReading>;

export const JudgeReading = z.object({
  /** A claim the record denies: the claim word for word, the line, and both sides in words. */
  x: z.object({ q: z.string(), r: z.string(), w: z.string() }).nullable().catch(null),
  /** The choice: options, pick, because, what would change it. */
  o: z
    .object({ o: z.array(z.string()), p: z.string(), b: z.string(), f: z.string().nullable().catch(null) })
    .nullable()
    .catch(null),
  /** What happened: verdict, shows, does not show, what settles it. */
  t: z
    .object({
      v: z.enum(RESULT_VERDICTS),
      s: z.string(),
      n: z.string().nullable().catch(null),
      e: z.string().nullable().catch(null),
    })
    .nullable()
    .catch(null),
  /** What the answer must say. */
  g: z.array(z.string()).catch([]),
});
export type JudgeReading = z.infer<typeof JudgeReading>;

/** JUDGE on a call: the choice and what happened, which open the reply, and no more. Read back as a `JudgeReading`. */
export const JudgeVoiceReading = z.object({
  o: z
    .object({ o: z.array(z.string()), p: z.string(), b: z.string() })
    .nullable()
    .catch(null),
  t: z
    .object({ v: z.enum(RESULT_VERDICTS), s: z.string(), e: z.string().nullable().catch(null) })
    .nullable()
    .catch(null),
});
export type JudgeVoiceReading = z.infer<typeof JudgeVoiceReading>;

/** The answer each part is asked for. */
export const UNDERSTAND_SCHEMAS = {
  route: RouteReading,
  sums: SumsReading,
  judge: JudgeReading,
  judgeVoice: JudgeVoiceReading,
} as const;

/** What came back in time, by part; an absent part was late, failed or not asked. */
export interface UnderstandReadings {
  readonly route?: RouteReading | null;
  readonly sums?: SumsReading | null;
  readonly judge?: JudgeReading | null;
}

/** A number a sum works with, as a reading gives it. */
export interface RawInput {
  readonly name: string;
  readonly value: number;
  readonly unit: '$' | '%' | 'count' | 'time';
  /** `message`, `history`, `standard` or a record key. */
  readonly from: string;
  /** Written as two numbers of one line ("4 / 16"). */
  readonly calc?: string;
}

export interface RawSum {
  readonly label: string;
  readonly unit: SumUnit;
  readonly noun: string | null;
  readonly expr: string;
  readonly round: 'none' | 'up' | 'down';
  readonly asked: boolean;
}

/** The parts as one reading (`mergeReadings`), not checked yet. */
export interface RawUnderstanding {
  readonly ask: string;
  readonly second_ask: string | null;
  readonly kind: UnderstoodKind;
  readonly also: readonly UnderstoodKind[];
  readonly record: readonly string[];
  /** Where ROUTE and JUDGE name the same line; `claim`: JUDGE's quote of the message. */
  readonly contradicts: { readonly record: string; readonly claim: string; readonly why: string } | null;
  readonly inputs: readonly RawInput[];
  readonly sums: readonly RawSum[];
  readonly missing: string | null;
  readonly choice: {
    readonly options: readonly string[];
    readonly pick: string;
    readonly because: string;
    readonly flips_if: string | null;
  } | null;
  readonly result: {
    readonly verdict: ResultVerdict;
    readonly shows: string;
    readonly does_not_show: string | null;
    readonly settles: string | null;
  } | null;
  readonly referral: UnderstoodReferral | null;
  readonly play: string | null;
  readonly step_play: string | null;
  readonly sure: 'high' | 'low';
  readonly points: readonly string[];
  readonly first_action: string | null;
  readonly avoid: string | null;
}
