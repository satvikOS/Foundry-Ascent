import type { Period } from './figures.js';
import type { SumUnit } from './types.js';

/**
 * What a figure is called: a phrase that stands before "is" ("what you keep a month"), with the period its numbers have and
 * the sign it came out with. A label that cannot is a plain one, so a right figure is never lost for its words.
 */

/** A label of its unit, when the model's is no phrase that stands before "is". */
const PLAIN: Readonly<Partial<Record<SumUnit, string>>> = {
  $: 'the amount',
  '%': 'the share',
  people: 'the number of people',
  days: 'the time',
  weeks: 'the time',
  months: 'the time',
  years: 'the time',
  hours: 'the time',
  minutes: 'the time',
};
const plainLabel = (unit: SumUnit): string => PLAIN[unit] ?? 'the figure you asked for';

const ENDS_OPEN =
  /\b(?:is|are|was|were|be|of|in|for|on|at|to|from|with|by|and|or|the|a|an|your|than|if|when|until|per)$/iu;
const QUESTION =
  /^(?:whether|if|why|who|whom|does|do|did|is|are|am|was|were|can|could|will|would|should)\b/iu;

/** "how many loans you need" is "the number of loans you need"; what still asks or stops short is the unit's plain label. */
export function phraseOf(label: string, unit: SumUnit): string {
  let said = label
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[\s.:;,?!=]+$/u, '');
  const many = /^how many (\S.*)$/iu.exec(said)?.[1];
  if (many !== undefined) said = `the number of ${many}`;
  const until = /^(?:when|how (?:long|soon) (?:until|till|before)) (\S.*)$/iu.exec(said)?.[1];
  if (until !== undefined) said = `the time until ${until}`;
  said = said
    .replace(/^how (?:big|large) (?:is )?(?=(?:the|your) )/iu, '')
    .replace(
      /^how much (?=(?:you|they|it|he|she|that|we|your|the)\b)(?!.*\b(?:better|worse|more|less|higher|lower|bigger|smaller|faster|slower)\b)/iu,
      'what ',
    );
  if (
    said === '' ||
    QUESTION.test(said) ||
    ENDS_OPEN.test(said) ||
    /^how (?:much|far|big|large|good|bad)\b/iu.test(said)
  )
    return plainLabel(unit);
  return said;
}

const PERIOD_WORDS: Readonly<Record<Period, RegExp>> = {
  day: /\b(?:days?|daily|nights?|today|tonight)\b/iu,
  week: /\b(?:weeks?|weekly)\b/iu,
  month: /\b(?:months?|monthly)\b/iu,
  year: /\b(?:years?|yearly|annual(?:ly)?)\b/iu,
};
/** A time of its own in a label: one day, a past week. */
const OTHER_TIME =
  / ?\b(?:(?:that|this|last|each|every|per|an?|the|on that|on the|in that|in an?) (?:day|night|week|weekend|month|year|event|session|evening)|today|tonight|daily|weekly|monthly|yearly)\b/giu;

/** The label with the period its sum is of: "what you keep that day" of monthly numbers is "what you keep a month". */
export function withPeriod(label: string, period: Period | null): string {
  if (period === null || PERIOD_WORDS[period].test(label)) return label;
  const bare = label.replace(OTHER_TIME, '').replace(/\s+/gu, ' ').trim();
  return `${bare === '' ? label : bare} a ${period}`;
}

const LEFT: readonly (readonly [RegExp, string])[] = [
  [/^what (?:that |this |it )?(?:leaves|brings|earns|makes) you\b/iu, 'what that loses you'],
  [/^what (?:that |this |it )?(?:left|brought|earned|made) you\b/iu, 'what that lost you'],
  [
    /^what (you|they) (?:keep|make|earn|clear|net|get|take home|pocket|are left with|have left)\b/iu,
    'what $1 lose',
  ],
  [
    /^what (you|they) (?:kept|made|earned|cleared|netted|got|took home|pocketed|were left with)\b/iu,
    'what $1 lost',
  ],
  [/^what (?:is|['’]s) left\b/iu, 'what you lose'],
  [/^what (?:stays|remains)(?: with you)?\b/iu, 'what you lose'],
  [/^(the|your) (?:net |gross )?(?:profit|earnings|margin|surplus)\b/iu, '$1 loss'],
  [/^(?:net |gross )?(?:profit|earnings|margin)\b/iu, 'your loss'],
];

/** What money under zero is called ("what you lose a month"); null: the label does not say. */
export function lossLabel(label: string): string | null {
  for (const [pattern, loss] of LEFT) if (pattern.test(label)) return label.replace(pattern, loss);
  return null;
}
