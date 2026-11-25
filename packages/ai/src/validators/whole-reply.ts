import type { TurnChannel } from '@foundry/contracts';

import type { PromptGuidance } from '../prompts/guidance.js';
import { knownNumbersIn, numbersIn } from './figures.js';
import { falseUnit, withoutWorks } from './reading.js';
import {
  composedAnswer,
  flatters,
  heldRest,
  leadText,
  referralRest,
  rulesOnIt,
  withoutDeadline,
  withoutLabel,
  withoutStart,
} from './reply-contract.js';
import { saidSentences, saysAgain, type SaidSentence } from './said-before.js';
import { coverage, stemsOf } from './stems.js';
import { unitsOf, wordsIn } from './units.js';

/**
 * A reply the writer wrote whole, of a turn whose message was read (docs/architecture/understand.md): what is cut from it, only
 * for what is false, unsafe or said already; when it is a reply; and what the server adds because it is missing. Pure.
 */

/** A step line of the writer's own, beside the one code writes. */
const STEP_LINE =
  /^[\s*_>#-]*(?:(?:your )?next(?: step)?|on your path,? next is|done when|do it by|deadline)[*_]*\s*[:—]/iu;

/** The figure the server opened with, worked out once more. */
function saysFigureAgain(text: string, guidance: PromptGuidance): boolean {
  if (guidance.reading?.opened !== 'sum' || !/[÷×=]|\d\s?[*/x]\s?[$\d]/u.test(text)) return false;
  const lead = knownNumbersIn(guidance.lead?.text ?? '');
  const own = numbersIn(text);
  return own.length >= 2 && own.every((n) => lead.some((k) => Math.abs(k - n) < 0.5));
}

export interface WholeContext {
  /** What this reply said so far, the server's opening first. */
  readonly said: readonly SaidSentence[];
  /** The writer's text before the unit. */
  readonly before: string;
  readonly today?: string | null | undefined;
}

/** The share of a sentence's words another one holds that makes it the same one: an instruction about a fact is none. */
const SAID_WHOLE = 0.9;

/** A unit of the writer's as it stands, or why it is cut. */
export function wholeUnit(
  unit: string,
  guidance: PromptGuidance,
  context: WholeContext,
): { readonly text: string; readonly cut: string | null } {
  const cut = (reason: string): { text: string; cut: string } => ({ text: '', cut: reason });
  const text = withoutWorks(withoutLabel(unit));
  if (text.trim() === '') return cut('empty');
  if (STEP_LINE.test(text)) return cut('step_line');
  if (saysAgain(text, context.said, SAID_WHOLE) || saysFigureAgain(text, guidance)) return cut('said');
  const reason = falseUnit(text, guidance, context.before) ?? (rulesOnIt(text, guidance) ? 'rules' : null);
  if (reason !== null) return cut(reason);
  if (flatters(text)) return cut('flattery');
  const undated = withoutDeadline(text, guidance, context.today);
  return undated !== text && wordsIn(undated) < 3 ? cut('date') : { text: undated, cut: null };
}

/** Why a sentence was cut, as the writer is told it. */
export const CUT_WORDS: Readonly<Record<string, string>> = {
  works: 'it speaks of how the reply was prepared',
  broken: 'it is no whole sentence',
  against_figure: 'it goes against the figure worked out',
  denies_claim: 'it says the opposite of what is known',
  agrees: 'it agrees with what their own record denies, or with what a person decides',
  rules: 'it rules on what a qualified person decides',
  gone: 'it uses a number they took back',
  own_sum: 'it gives a figure nobody worked out',
  friends: 'friends who like it prove nothing',
  flattery: 'it only flatters',
  said: 'it was said already',
  step_line: 'the step goes on the last line only',
  date: 'its day is not theirs',
  support: 'nobody gave the figure, name or fact in it',
  own_facts: 'it says something of them that they never told',
  repeat: 'an earlier reply said it',
  leans: 'it goes on from a sentence that was cut',
};

/** A sentence that says something. */
const says = (text: string): boolean =>
  wordsIn(text) >= 4 && !/\?["'”’)\]*_]*\s*$/u.test(text.trim()) ? true : /["“][^"”]{8,}["”]/u.test(text);

/** How many sentences of its own a reply needs. */
export function sentencesNeeded(guidance: PromptGuidance, channel: TurnChannel): number {
  const r = guidance.reading;
  if (r === undefined) return 0;
  if (r.opened === 'sum') return 0;
  if (leadText(guidance, channel) !== '' || channel === 'voice') return 1;
  const short =
    r.words === true ||
    r.kind === 'sum' ||
    r.kind === 'draft' ||
    r.kind === 'recall' ||
    guidance.choice?.kind === 'yes_no';
  return short ? 1 : 2;
}

/** Whether the writer's own text (without the server's opening and the step) is a reply. */
export function isWholeReply(text: string, guidance: PromptGuidance, channel: TurnChannel): boolean {
  return unitsOf(text).filter((u) => says(u.text)).length >= sentencesNeeded(guidance, channel);
}

/** What stands in for the writer: the claims the reply was to make, those of them not said yet. */
export function composedWhole(guidance: PromptGuidance, channel: TurnChannel, said: string): string {
  const { lead: _lead, ...rest } = guidance;
  const whole = composedAnswer(rest, channel);
  if (whole.includes('\n')) return whole;
  const held = saidSentences(said);
  return unitsOf(whole)
    .filter((u) => !saysAgain(u.text, held))
    .map((u) => u.text)
    .join(' ');
}

/** What the server adds because the reply lacks it, each a whole text: what the record denies, then who decides. */
export function missingOf(released: string, guidance: PromptGuidance, channel: TurnChannel): string[] {
  const out: string[] = [];
  const against = guidance.reading?.contradicts ?? null;
  if (against !== null && against.says !== '' && coverage(stemsOf(against.line), stemsOf(released)) < 0.4)
    out.push(against.says);
  const lead = leadText(guidance, channel);
  const whole = [released, ...out].join(' ');
  const referral =
    guidance.reading?.opened === 'held' && lead !== ''
      ? heldRest(withoutStart(whole, lead) ?? whole, guidance, channel)
      : referralRest(whole, guidance, channel);
  if (referral !== '') out.push(referral);
  return out;
}

/** What the writer is asked when its draft, with what was cut, is no reply. */
export function repairBrief(
  draft: string,
  cuts: readonly { readonly text: string; readonly why: string }[],
): string {
  const said = draft.replace(/\s+/gu, ' ').trim().slice(0, 900);
  const list = cuts
    .slice(0, 8)
    .map(
      (c) =>
        `- "${c.text.replace(/\s+/gu, ' ').trim().slice(0, 180)}": ${CUT_WORDS[c.why] ?? 'it may not be said'}`,
    )
    .join('\n');
  return `[Your reply was: "${said}"\nThese sentences of it cannot be shown:\n${list === '' ? '- none of it answers them' : list}\nWrite the whole reply again without them, keeping the rest, in the same form with its NEXT line. Only what you say to them.]`;
}
