/**
 * What a founder's message asks, read against their record before anything is written (docs/architecture/understand.md).
 * A short structured model call proposes it; `checkUnderstanding` keeps only what the message, the conversation, the record
 * or the playbook holds, and code does the sums. Everything here is already checked.
 */
export const UNDERSTOOD_KINDS = [
  'question',
  'choice',
  'sum',
  'result',
  'update',
  'next',
  'recall',
  'pushback',
  'feelings',
  'social',
  'draft',
  'integrity',
  'privacy',
] as const;
export type UnderstoodKind = (typeof UNDERSTOOD_KINDS)[number];

export const UNDERSTOOD_REFERRALS = [
  'ip',
  'legal',
  'valuation',
  'equity',
  'immigration',
  'regulatory',
  'wellbeing',
  'irb',
  'grants',
] as const;
export type UnderstoodReferral = (typeof UNDERSTOOD_REFERRALS)[number];

export const RESULT_VERDICTS = ['strong', 'promising', 'mixed', 'weak', 'too_early', 'bad'] as const;
export type ResultVerdict = (typeof RESULT_VERDICTS)[number];

export const SUM_UNITS = ['$', '%', 'people', 'months', 'hours', 'units', 'x'] as const;
export type SumUnit = (typeof SUM_UNITS)[number];

/** A line of the founder's record as the call was shown it. */
export interface RecordLine {
  /** `R1`, `R2`, … */
  readonly key: string;
  readonly kind: string;
  /** A whole sentence, in the founder's second person ("You charge $11 a bowl."). */
  readonly text: string;
  /** The day it is about, YYYY-MM-DD, when it has one. */
  readonly on: string | null;
  readonly memoryId: string | null;
}

/** A sum they ask for or their question turns on, computed by code. */
export interface UnderstoodSum {
  /** What the figure is, as it ends a sentence: "what you kept that night". */
  readonly label: string;
  readonly unit: SumUnit;
  /** The result, rounded as it is said. */
  readonly value: number;
  /** As it is said: "$192.50", "8 bowls", "6.2 months". */
  readonly said: string;
  /** The working as it is shown, its inputs in place: "38 × ($11 − $4.20 − $0.55) − $45". */
  readonly working: string;
  /** Whether this is the figure they asked for (else one their question turns on). */
  readonly asked: boolean;
}

export interface UnderstoodChoice {
  readonly options: readonly string[];
  readonly pick: string;
  readonly because: string;
  readonly flipsIf: string | null;
}

export interface UnderstoodResult {
  readonly verdict: ResultVerdict;
  readonly shows: string;
  readonly doesNotShow: string | null;
  readonly settles: string | null;
}

export interface Understanding {
  readonly ask: string;
  readonly secondAsk: string | null;
  readonly kind: UnderstoodKind;
  readonly also: readonly UnderstoodKind[];
  /** Record lines that bear on it, most telling first. */
  readonly record: readonly RecordLine[];
  readonly contradicts: { readonly line: RecordLine; readonly why: string } | null;
  readonly sums: readonly UnderstoodSum[];
  /** The number a sum they asked for lacks, in words ("what one box costs you"). */
  readonly missing: string | null;
  readonly choice: UnderstoodChoice | null;
  readonly result: UnderstoodResult | null;
  readonly referral: UnderstoodReferral | null;
  readonly playId: string | null;
  readonly stepPlayId: string | null;
  readonly sure: boolean;
  readonly points: readonly string[];
  readonly firstAction: string | null;
  readonly avoid: string | null;
}
