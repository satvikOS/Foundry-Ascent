import { isEverydayWord, type Understanding, type UnderstoodReferral } from '@foundry/ai';
import { type Play } from '@foundry/contracts';

import { sayDue } from './dates.js';
import { isWhole, lineSaid, yourself } from './lint.js';
import { worthIn } from './asked-sums.js';
import { sumSaid, type SumContext } from './sum-said.js';
import { bare, lowerFirst, upperFirst } from './tell.js';
import { contentStems, countsIn, plain } from './words.js';

/**
 * What the server says before the writer on a turn the reading decides, and what it gives the writer to write from: the figure,
 * what a person decides and a refusal are code's, word for word; everything else is the writer's. Every field of the reading
 * may be empty. Pure.
 */
export interface Opening {
  readonly kind: 'sum' | 'held' | 'integrity';
  readonly text: string;
  /** Two sentences at most: what is heard. */
  readonly voice: string;
}

export interface OpeningContext {
  readonly yesNo: boolean;
  readonly today: string;
  readonly referral: Play['referral'];
  readonly message: string;
  /** Their earlier messages and the earlier replies, oldest first. */
  readonly earlier?: readonly string[];
  readonly replies?: readonly string[];
  /** The words themselves are asked for (a recap, a wording): nothing opens over them. */
  readonly textAsked?: boolean;
}

const flat = (text: string): string => text.replace(/\s+/gu, ' ').trim();
const join = (...parts: readonly string[]): string => flat(parts.filter((p) => p !== '').join(' '));
const sentence = (text: string): string => (bare(text) === '' ? '' : `${upperFirst(bare(text))}.`);

/** The clause with its first letter lower, unless it opens with a name. */
export const inside = (text: string): string => {
  const said = bare(text);
  const word = /^[\p{L}'’]+/u.exec(said)?.[0] ?? '';
  return isEverydayWord(word.toLowerCase()) || isEverydayWord(word) ? lowerFirst(said) : said;
};

// Sums --------------------------------------------------------------------------------------------------------------

const EARN_OR_LOSE =
  /\b(?:earn\w*|mak(?:e|ing)(?: money)?|profit\w*|win|gain\w*|keep|ahead)\b.{0,30}\bor\b.{0,20}\b(?:los[et]\w*|losing|nothing|in the red)\b|\b(?:do|am|are) (?:i|we) (?:still )?(?:los(?:e|ing)|earn(?:ing)?|mak(?:e|ing) (?:money|a profit))\b/i;
const SUPPOSES =
  /(?:^|[.!?]\s+)(?:(?:ok(?:ay)?|so|fine|well)[, ]+)*(?:(?:just|let['’]?s|lets) (?:say|suppose|assume|pretend|imagine)|suppose|assume|imagine|say (?:everyone|everybody|\d))\b/i;

const sumContext = (u: Understanding, message: string, c?: OpeningContext): SumContext => ({
  texts: [message, ...u.record.map((r) => r.text)],
  worth: u.sums.some((s) => /\b(?:worth|valu(?:e|ation))\b/i.test(s.label)),
  earns: EARN_OR_LOSE.test(message),
  supposed: SUPPOSES.test(message),
  ...(c?.replies === undefined ? {} : { replies: c.replies }),
});

/** A sum of the reading's, as it is said. */
export const sumOfReading = (u: Understanding, s: Understanding['sums'][number], message = ''): string =>
  sumSaid(s, sumContext(u, message)).text;

function sumOpening(u: Understanding, message: string, c: OpeningContext): Opening | null {
  const asked = u.sums.filter((s) => s.asked).slice(0, 2);
  if (asked.length === 0) return null;
  const said = asked.map((s) => sumSaid(s, sumContext(u, message, c)));
  const aside = said.map((s) => s.aside).find((a) => a !== '') ?? '';
  return {
    kind: 'sum',
    text: join(...said.map((s) => s.text), aside),
    voice: join(...said.map((s) => s.voice)),
  };
}

// What their record says ---------------------------------------------------------------------------------------------

/** They propose to do something; else they claim something. */
const proposes = (u: Understanding): boolean =>
  u.kind === 'choice' || u.kind === 'next' || u.kind === 'update';

/** Their record denies what they say, or they change it: the line, and as the server says it when the reply does not. */
export function contradictionSaid(
  u: Understanding,
  c: Pick<OpeningContext, 'today' | 'yesNo'>,
): { readonly line: string; readonly says: string } | null {
  if (u.contradicts === null || NO_DENIAL.test(u.contradicts.line.text.trim())) return null;
  const { line, why } = u.contradicts;
  const decided = /^(?:decision|pivot)$/.test(line.kind);
  // A question changes nothing that was settled.
  if (decided && !/^(?:choice|update|next|pushback|result)$/.test(u.kind)) return null;
  const said = inside(lineSaid(line.text));
  if (said === '') return null;
  const on = line.on === null ? '' : ` (${sayDue(c.today, line.on)})`;
  const own = /\d/.test(line.text) || countsIn(line.text).length > 0 ? 'numbers' : 'record';
  const says = own === 'numbers' ? 'say' : 'says';
  const opens = decided
    ? `That changes something you settled before${on}: ${said}.`
    : proposes(u)
      ? `Your own ${own} speak${own === 'numbers' ? '' : 's'} against it: ${said}.`
      : c.yesNo
        ? `Not quite, by your own ${own}: ${said}.`
        : `Your own ${own} ${says} otherwise: ${said}.`;
  // What the reading says of it, where it says more than the line.
  const held = new Set(contentStems(line.text));
  const stems = contentStems(why);
  const fresh = stems.filter((w) => !held.has(w));
  const more =
    fresh.length >= 2 && fresh.length > stems.length * 0.4 && isWhole(why) ? sentence(yourself(why)) : '';
  return { line: lineSaid(line.text), says: join(opens, more) };
}

/** What they said they would do, hope or have not tried denies nothing. */
const NO_DENIAL =
  /^$|^(?:you said you would|a goal of yours|you believe,|a risk you named|your test, .{2,80} has no result|you described your idea|you said it is for|you have \d+ hours)/i;

// What a person decides ----------------------------------------------------------------------------------------------

/** What can be said of it, by what it is: who decides, and what is theirs to do meanwhile; never a yes, a no or a price. */
const HELD: Readonly<
  Partial<Record<UnderstoodReferral, (who: string, asked: string) => readonly [string, string]>>
> = {
  equity: (who) => [
    `I will not decide that for you: how it is shared is for you and your co-founder to agree, with ${who} before anything is signed.`,
    'What should count is what each of you does and risks from now on, what you each put in, and what happens if one of you leaves.',
  ],
  valuation: (who) => [
    `Do not say yes yet, and I will not call it a good or a bad price: that is for ${who} to go through with you first.`,
    'What you can say today is that you are glad of the offer and are taking advice before you answer.',
  ],
  legal: (who, asked) =>
    /\b(?:sign\w*|contracts?|letters?|loi|agreements?|clauses?|terms?|exclusiv\w*|nda|leases?|pages?|form)\b/i.test(
      asked,
    )
      ? [
          `Do not say yes or no to that yet: ${who} reads it with you first, and then it is your call.`,
          'What you can say today is that it is being read, and which points you want to talk about.',
        ]
      : [`I will not pick that for you: ${who} settles it with you, from what you do and plan.`, ''],
  immigration: (who) => [
    `Do not do it yet: what you may do on your visa is for ${who} to say, in writing.`,
    '',
  ],
  ip: (who) => [`Do not act on that yet: whose it is, is for ${who} to say.`, ''],
  regulatory: (who) => [
    `Not a yes yet: what you may claim, sell or try on people is for ${who} to say first.`,
    'What you can say today is that you are interested and asking what has to be in place.',
  ],
  irb: (who) => [
    `Not a yes yet: whether you may try it on people is for ${who} to say first.`,
    'What you can say today is that you are interested and asking what has to be approved.',
  ],
};

/** What can be said of an offer for a part of it, by who decides. */
export function offerSaid(referral: NonNullable<Play['referral']>): {
  readonly text: string;
  readonly voice: string;
} {
  const [first = '', second = ''] =
    HELD.valuation?.(inside(referral.who.split(/[,;]/u)[0] ?? referral.who), '') ?? [];
  return { text: join(first, second), voice: join(first, second) };
}

/** An offer, terms or a status that a person decides: what can be said by when, never a yes, a no or a price. */
function heldOpening(u: Understanding, referral: Play['referral'], message: string): Opening | null {
  if (referral === null || u.referral === null || u.choice !== null) return null;
  const made = HELD[u.referral];
  // How it is shared is held where that is what they ask.
  if (u.referral === 'equity' && !OF_A_SPLIT.test(`${u.ask} ${message}`)) return null;
  if (made === undefined || ![u.kind, ...u.also].some((k) => /^(?:choice|question|pushback)$/.test(k)))
    return null;
  // A choice that only a person makes was asked for, whatever its words.
  const asked = bare(u.ask) === '' ? message : u.ask;
  if (u.kind !== 'choice' && !RULING_ASKED.test(asked)) return null;
  const who = inside(referral.who.split(/[,;]/u)[0] ?? referral.who);
  const [first, second] = made(who, `${asked} ${message}`);
  // What the offer implies is arithmetic, and no verdict.
  const worth = u.referral === 'valuation' ? worthIn([message]) : null;
  const paper =
    worth === null
      ? ''
      : `On paper it makes the whole worth ${worth.said} (${worth.working}), which is arithmetic and not a verdict.`;
  return { kind: 'held', text: join(first, paper, second), voice: join(first, second) };
}
const OF_A_SPLIT =
  /\b(?:split\w*|equity|shares?|stake|percent\w*|vest\w*|own(?:s|ership)?|half and half)\b|%|\d{1,3} ?[/:-] ?\d{1,3}\b/i;

/** "Would it be wrong to go alone?" of who started it with somebody. */
const ALONE =
  /\b(?:on my own|by myself|alone|without (?:him|her|them|my (?:co-?founder|partner)|\p{Lu}\p{L}+))\b/u;
const WITH_SOMEBODY = /\b(?:co-?founders?|partner|both of you|the two of you|you and \p{Lu}\p{L}+)\b/u;
const IN_CONFIDENCE =
  /\b(?:between us|don['’]?t tell|do not tell|keep (?:this|it|that) (?:between|private|secret|quiet|to yourself)|off the record)\b/i;
/** What is true of the product, where they ask for it to be kept from their team. */
export const KEPT_SAID =
  'Your team can see what I keep from our conversations in Knowledge, so use a temporary chat for what is only yours to say.';
export const inConfidence = (message: string): boolean => IN_CONFIDENCE.test(message);
/** Whether they ask about going on without who they started it with. */
export const goesAlone = (u: Understanding, message: string): boolean =>
  ALONE.test(message) &&
  !/\bsplit\b|%|\d{1,3} ?[/:-] ?\d{1,3}\b/i.test(message) &&
  (WITH_SOMEBODY.test(`${message} ${u.record.map((r) => r.text).join(' ')}`) ||
    u.referral === 'equity' ||
    /^cofounder|^team-conflict/.test(u.stepPlayId ?? ''));

/** What taking it for free, a grant or a letter is, where they ask if it is a customer: the program's own answer. */
const IS_IT =
  /\b(?:is|are|isn['’]?t|does|do|would|counts? as|like)\b[^.?!]{0,60}\b(customers?|traction|revenue|arr|sales?|a sale)\b/i;
const IT_IS: readonly (readonly [RegExp, string])[] = [
  [
    /\b(?:(?:for|is|it['’]?s|only if|if) (?:it['’]?s )?free\b|for nothing|free (?:for|of charge)|doesn['’]?t pay|not paying)\b/i,
    'Not a customer yet: somebody who takes it for free is a user, and a customer pays for it.',
  ],
  [/\bgrants?\b/i, 'A grant is not a customer: it pays for the work, and nobody has bought anything yet.'],
  [
    /\b(?:non-?binding|not binding|loi|letter of intent)\b/i,
    'A letter that binds nobody is not revenue yet: revenue is money somebody has paid.',
  ],
  [
    /\b(?:sign-?ups?|wait ?list|followers|likes|downloads)\b/i,
    'A sign-up is not a customer yet: signing up is free, and a customer is somebody who pays.',
  ],
];
export function isItSaid(message: string): string | null {
  return IS_IT.test(message) ? (IT_IS.find(([words]) => words.test(message))?.[1] ?? null) : null;
}

/** "Only one of the four": the list of so many things they named before. */
const ONE_OF =
  /\b(?:one|1) of (?:the |those |these |my |our |all )?(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten)\b|\bwhich one of them\b/i;
const COUNTS = ['', '', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
export function namedBefore(message: string, earlier: readonly string[]): readonly string[] {
  const m = ONE_OF.exec(message);
  if (m === null) return [];
  const n = m[1] === undefined ? null : /^\d/.test(m[1]) ? Number(m[1]) : COUNTS.indexOf(m[1].toLowerCase());
  for (const text of [message, ...[...earlier].reverse()])
    for (const found of text.matchAll(
      /(?:^|[:.!?(]\s*|\b(?:like|namely|including)\s+)((?:[\p{L}][\p{L} '-]{1,24},\s*){1,9}(?:and |or )?[\p{L}][\p{L} '-]{1,24})(?=[.!?)]|$)/giu,
    )) {
      const items = (found[1] ?? '').split(/,\s*(?:and |or )?|\s+(?:and|or)\s+/iu).map((x) => x.trim());
      if (
        items.length >= 2 &&
        items.every((x) => x.split(' ').length <= 3) &&
        (n === null || items.length === n)
      )
        return items;
    }
  return [];
}
/** "Which one of them?" of things they named before, which nothing decides: one they can try by hand. */
export function listPick(
  u: Understanding,
  message: string,
  earlier: readonly string[],
): { readonly pick: string; readonly because: string; readonly flipsIf: string } | null {
  if (u.kind !== 'choice' || u.choice !== null || u.referral !== null) return null;
  const items = namedBefore(message, earlier);
  const [first = ''] = items;
  if (items.length < 2) return null;
  return {
    pick: first,
    because: `None of the ${COUNTS[items.length] ?? String(items.length)} has proof yet: keep the one they can do by hand for ten people this week and charge for.`,
    flipsIf: 'Another of them is quicker to do by hand.',
  };
}

/** Whether what they ask now is what a person decides. */
export const asksRuling = (u: Understanding, message: string): boolean =>
  u.referral !== null &&
  u.referral !== 'grants' &&
  u.referral !== 'wellbeing' &&
  !(u.kind === 'sum' || u.kind === 'recall' || u.kind === 'draft') &&
  (u.kind === 'choice' || RULING_ASKED.test(bare(u.ask) === '' ? message : u.ask));

/** Asks whether to take it, sign it, whether it is fair, allowed or theirs. */
const RULING_ASKED =
  /\b(?:whether|should|is|are|if|what|which|how much)\b.{0,90}\b(?:accept|take|sign|agree|fair|good|bad|price|worth|allowed|legal|own|owns|split|claim|say|right|normal|okay|ok|reasonable|problem|can|confirm|fine|amazing)\b/i;

// Made-up work, and stopping -----------------------------------------------------------------------------------------

const NO_MADE_UP =
  'No, I will not help make that up or hide it: one thing found out puts all your real work in doubt.';
const TO_STOP =
  /\b(?:quit(?:ting)?|giv(?:e|ing) (?:it (?:all )?)?up|walk(?:ing)? away|shut(?:ting)? (?:it|this|the \w+) down|call(?:ing)? it quits|(?:stop(?:ping)?|drop(?:ping)?|leav(?:e|ing)) (?:doing )?(?:it|this|the venture|the (?:whole )?thing|all of (?:it|this)|altogether|for good)|(?:want|going|need|have|like|ready|time|okay|ok|fine|allowed|wrong|bad) to (?:just )?stop)\b/i;
const PERMISSION =
  /\b(?:(?:ok(?:ay)?|all ?right|fine|allowed|wrong|bad|dumb|selfish|crazy|failure) (?:to|if i|for me to)|is (?:it|that) (?:ok(?:ay)?|all ?right|fine|wrong|bad|dumb|selfish)|permission to|am i (?:a )?(?:failure|quitter|wrong|bad))\b/i;
/** Whether they ask leave to stop: an ask of the work, however it is put. */
export const asksToStop = (message: string): boolean =>
  TO_STOP.test(plain(message)) && PERMISSION.test(plain(message));

// Several things, and a plain answer -----------------------------------------------------------------------------------

const URGENT: readonly RegExp[] = [
  /\b(?:lawyer|legal|letter|lawsuit|sue|court|police|evict\w*|unsafe|injur\w*|recall|cease|infring\w*|trademark|logo|permit|inspector)\b/i,
  /\b(?:today|tonight|tomorrow|deadline|due|overdue|this week|(?:mon|tues|wednes|thurs|fri|satur|sun)day)\b/i,
];
/** What is urgent is said first: a letter from a lawyer or an office, a day that is near, the rest. */
export function byUrgency(points: readonly string[]): string[] {
  const rank = (p: string): number => {
    const at = URGENT.findIndex((r) => r.test(p));
    return at < 0 ? URGENT.length : at;
  };
  return points
    .map((p, i) => ({ p, i, r: rank(p) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.p);
}

/** What is on record, as whole sentences with their day. */
export function recallSaid(u: Understanding, today: string): string[] {
  return u.record
    .slice(0, 4)
    .filter((r) => bare(r.text) !== '')
    .map((r) => {
      const said = yourself(r.text);
      return r.on === null ? sentence(said) : `${upperFirst(sayDue(today, r.on))}: ${inside(said)}.`;
    });
}

/** They want it called great: no push, and nothing to agree with. */
const SEEKS_PRAISE =
  /\b(?:tell|say|admit|promise|agree|confirm)\b[^.?!]{0,30}\b(?:great|amazing|brilliant|genius|awesome|perfect|the best|wonderful|going to (?:work|win|make it))\b/i;
export const seeksPraise = (message: string): boolean => SEEKS_PRAISE.test(message);

/** What code says first, the one that comes first: a refusal, then the figure they ask for, then what a person decides. */
export function openingOf(u: Understanding, c: OpeningContext): Opening | null {
  if (u.kind === 'integrity') return { kind: 'integrity', text: NO_MADE_UP, voice: NO_MADE_UP };
  // The words themselves are asked for: they are the whole reply.
  if (c.textAsked === true) return null;
  const sum = sumOpening(u, c.message, c);
  if (sum !== null && u.kind !== 'recall') return sum;
  return goesAlone(u, c.message) ? null : heldOpening(u, c.referral, c.message);
}
