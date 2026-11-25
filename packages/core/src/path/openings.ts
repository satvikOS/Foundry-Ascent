import { isEverydayWord, type Understanding, type UnderstoodReferral } from '@foundry/ai';
import { type Play } from '@foundry/contracts';

import { sayDue } from './dates.js';
import { afterIf, isWhole, lineSaid, yourself } from './lint.js';
import { worthIn } from './asked-sums.js';
import { sumSaid, type SumContext } from './sum-said.js';
import { bare, lowerFirst, upperFirst } from './tell.js';
import { toldCounts } from './told-counts.js';
import { contentStems, countsIn, plain } from './words.js';

/**
 * The server's one opening of a reply whose message was read: the figure, the pick, the result, what the record denies, what
 * a person decides, as a mentor says it. Every field of the reading may be empty; what is not there is not said. Pure.
 */
export type OpeningKind =
  | 'sum'
  | 'missing'
  | 'contradiction'
  | 'held'
  | 'choice'
  | 'result'
  | 'pushback'
  | 'integrity'
  | 'recall'
  | 'quit'
  | 'order'
  | 'solo'
  | 'praise'
  | 'counts'
  | 'answer';

export interface Opening {
  readonly kind: OpeningKind;
  readonly text: string;
  /** Two sentences at most: what is heard. */
  readonly voice: string;
  /** It says what to do first already. */
  readonly uses?: 'firstAction';
}

/** The step as an opening may name it. */
export interface StepSaid {
  readonly title: string;
  readonly dueOn: string | null;
  /** It serves what they ask; else it only stands on their path. */
  readonly chosen: boolean;
}

export interface OpeningContext {
  readonly yesNo: boolean;
  readonly today: string;
  readonly referral: Play['referral'];
  readonly step: StepSaid | null;
  readonly message?: string;
  /** Their earlier messages and the earlier replies, oldest first. */
  readonly earlier?: readonly string[];
  readonly replies?: readonly string[];
  /** The words themselves are asked for (a recap, a wording): nothing opens over them. */
  readonly textAsked?: boolean;
  /** What friends' praise shows, where that is what they bring (news.ts). */
  readonly praise?: { readonly means: string; readonly spoken: string } | null;
  /** Whether the conversation said it already. */
  readonly told?: (text: string) => boolean;
  /** The message reports an outcome, or asks of one told before (outcome.ts): a verdict opens over nothing else. */
  readonly outcome?: boolean;
  /** Several things happened at once: each is said, the most urgent first. */
  readonly inOrder?: boolean;
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

/** One of the forms, the same every time for the same words. */
function formOf<T>(forms: readonly [T, ...T[]], seed: string): T {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) % 1_000_003;
  return forms[hash % forms.length] ?? forms[0];
}

const CLAUSE = /^(?:whether|if|how|why|who|whom|whose|what|when|where|which|that)\b/iu;
/** An act: what one does, as it opens a sentence. */
const ACT =
  /^(?:(?:next|this|on) \p{L}+,? |today,? |tomorrow,? |tonight,? |then |now )?(?:ask|call|ring|email|e-mail|message|text|write|send|offer|sell|charge|count|track|mark|list|show|bring|take|visit|talk|meet|book|try|run|test|set|cut|pick|get|put|print|post|check|open|hand|cook|bake|make|give|compare|measure|start|use|invite|repeat|lend|rent|serve|watch|let|have|do|go|sign|find|return|deliver|teach|play|follow|pre-sell|presell)\b/iu;
const hasNumber = (text: string): boolean => /\d/u.test(text) || countsIn(text).length > 0;

// Sums --------------------------------------------------------------------------------------------------------------

const EARN_OR_LOSE =
  /\b(?:earn\w*|mak(?:e|ing)(?: money)?|profit\w*|win|gain\w*|keep|ahead)\b.{0,30}\bor\b.{0,20}\b(?:los[et]\w*|losing|nothing|in the red)\b|\b(?:do|am|are) (?:i|we) (?:still )?(?:los(?:e|ing)|earn(?:ing)?|mak(?:e|ing) (?:money|a profit))\b/i;
const SUPPOSES =
  /(?:^|[.!?]\s+)(?:(?:ok(?:ay)?|so|fine|well)[, ]+)*(?:(?:just|let['’]?s|lets) (?:say|suppose|assume|pretend|imagine)|suppose|assume|imagine|say (?:everyone|everybody|\d))\b/i;

const sumContext = (u: Understanding, message: string, c?: OpeningContext): SumContext => ({
  texts: [message, ...u.record.map((r) => r.text)],
  worth:
    u.referral === 'valuation' ||
    u.sums.some((s) => /\b(?:whole|venture|company|business|startup)\b.*\bworth\b/i.test(s.label)),
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

/** A sum that lacks a number: which one, with what the others come to. */
function missingOpening(u: Understanding, message: string): Opening | null {
  if (u.missing === null || bare(u.missing) === '') return null;
  const known = u.sums.slice(0, 1).map((s) => sumOfReading(u, s, message));
  const text = join(
    `I cannot give you that figure yet, because one number is missing: ${inside(u.missing)}.`,
    known.length === 0 ? '' : `What can be worked out so far: ${lowerFirst(known[0] ?? '')}`,
  );
  return { kind: 'missing', text, voice: `One number is missing for that: ${inside(u.missing)}.` };
}

/** The number a sum lacks, as the reply's one question. */
export function missingQuestion(missing: string): string {
  const said = inside(missing);
  if (/^(?:what|how|who|whether|when|where)\b/i.test(said)) return `Can you tell me ${said}?`;
  return /^(?:the|your|an?|each|one)\b/i.test(said) ? `What is ${said}?` : `What is the ${said}?`;
}

// What their record says ---------------------------------------------------------------------------------------------

/** They propose to do something; else they claim something. */
const proposes = (u: Understanding): boolean =>
  u.kind === 'choice' || u.kind === 'next' || u.kind === 'update';

/** Their record denies what they say, or they change it: named first, kindly. */
function contradictionOpening(u: Understanding, c: OpeningContext): Opening | null {
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
  return { kind: 'contradiction', text: join(opens, more), voice: join(opens, more) };
}

/** What they said they would do, hope or have not tried denies nothing. */
const NO_DENIAL =
  /^$|^(?:you said you would|a goal of yours|you believe,|a risk you named|your test, .{2,80} has no result|you described your idea|you said it is for|you have \d+ hours)/i;

/** What is on record, as they asked for it. */
function recallOpening(u: Understanding, today: string): Opening | null {
  const lines = u.record
    .slice(0, 4)
    .filter((r) => bare(r.text) !== '')
    .map((r) => {
      const said = yourself(r.text);
      return r.on === null ? sentence(said) : `${upperFirst(sayDue(today, r.on))}: ${inside(said)}.`;
    });
  if (lines.length === 0) return null;
  return { kind: 'recall', text: join(...lines), voice: join(...lines.slice(0, 2)) };
}

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
/** Whether they ask about going on without who they started it with. */
export const goesAlone = (u: Understanding, message: string): boolean =>
  ALONE.test(message) &&
  !/\bsplit\b|%|\d{1,3} ?[/:-] ?\d{1,3}\b/i.test(message) &&
  (WITH_SOMEBODY.test(`${message} ${u.record.map((r) => r.text).join(' ')}`) ||
    u.referral === 'equity' ||
    /^cofounder|^team-conflict/.test(u.stepPlayId ?? ''));

function soloOpening(u: Understanding, message: string): Opening | null {
  if (!goesAlone(u, message) || u.kind === 'recall') return null;
  const opens = 'Wanting to do it on your own is not bad in itself.';
  const first =
    'What has to be settled first is who owns what you made together, what you promised each other, and that your co-founder hears it from you.';
  const kept = IN_CONFIDENCE.test(message)
    ? 'One thing to know: your team can see what I keep from our conversations in Knowledge, so use a temporary chat for what is only yours to say.'
    : '';
  return { kind: 'solo', text: join(opens, first, kept), voice: join(opens, kept === '' ? first : kept) };
}

/** What taking it for free, a grant or a letter is, where they ask if it is a customer: the program's own answer. */
const IS_IT =
  /\b(?:is|are|isn['’]?t|does|do|would|counts? as|like)\b[^.?!]{0,60}\b(customers?|traction|revenue|arr|sales?|a sale)\b/i;
const IT_IS: readonly (readonly [RegExp, string])[] = [
  [
    /\b(?:(?:for|is|it['’]?s|only if|if) (?:it['’]?s )?free\b|for nothing|free (?:for|of charge)|doesn['’]?t pay|not paying)\b/i,
    'Not yet: somebody who takes it for free is a user, and a customer is somebody who pays for it.',
  ],
  [/\bgrants?\b/i, 'A grant is not a customer: it pays for the work, and nobody has bought anything yet.'],
  [
    /\b(?:non-?binding|not binding|loi|letter of intent)\b/i,
    'Not yet: a letter that binds nobody is interest, and revenue is money somebody has paid.',
  ],
  [
    /\b(?:sign-?ups?|wait ?list|followers|likes|downloads)\b/i,
    'Not yet: signing up is free, and a customer is somebody who pays.',
  ],
];
function isItOpening(message: string): Opening | null {
  if (!IS_IT.test(message)) return null;
  const said = IT_IS.find(([words]) => words.test(message))?.[1];
  return said === undefined ? null : { kind: 'answer', text: said, voice: said };
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
function listPick(u: Understanding, message: string, earlier: readonly string[]): Opening | null {
  if (u.kind !== 'choice' || u.choice !== null || u.referral !== null) return null;
  const items = namedBefore(message, earlier);
  const [first = ''] = items;
  if (items.length < 2) return null;
  const said = `My pick: ${inside(first)}.`;
  const why = `None of the ${COUNTS[items.length] ?? String(items.length)} has proof yet, so keep the one you can do by hand for ten people this week and charge for; if another of them is quicker to do by hand, keep that one.`;
  return { kind: 'choice', text: join(said, why), voice: join(said, why) };
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

// A choice and a result ----------------------------------------------------------------------------------------------

const LONG_REASON = 32;
/** The reason's first clauses, when all of it is long. */
function reasonOf(because: string): string {
  const said = flat(because.replace(/^because\s+/i, ''));
  const words = (text: string): number => text.split(' ').length;
  if (words(said) <= LONG_REASON) return sentence(said);
  const parts = said.split(/(?<=[;.!?])\s+|(?<=,)\s+(?=(?:while|and|so|which|but)\b)/u);
  let out = parts[0] ?? said;
  for (const part of parts.slice(1)) {
    if (words(`${out} ${part}`) > LONG_REASON) break;
    out = `${out} ${part}`;
  }
  return words(out) >= 4 ? sentence(out) : sentence(said);
}

/** The choice they ask for, made: the pick, why, and what would change it. */
function choiceOpening(u: Understanding): Opening | null {
  const { choice } = u;
  if (choice === null || bare(choice.pick) === '') return null;
  const pick = bare(choice.pick);
  const opens = /^(?:yes|no|not yet|neither|both)\b/i.test(pick)
    ? `${upperFirst(pick)}.`
    : `My pick: ${inside(pick)}.`;
  const why = reasonOf(choice.because);
  const flips =
    choice.flipsIf === null || bare(choice.flipsIf) === ''
      ? ''
      : `I’d change my mind if ${inside(afterIf(choice.flipsIf))}.`;
  return { kind: 'choice', text: join(opens, why, flips), voice: join(opens, why) };
}

type Verdict = NonNullable<Understanding['result']>['verdict'];
const VERDICTS: Readonly<Record<Verdict, readonly [string, ...string[]]>> = {
  strong: ['That is a strong result:', 'Strong, and here is why:'],
  promising: ['Promising, not proven:', 'Good so far, and not proven yet:'],
  mixed: ['Mixed:', 'It cuts both ways:'],
  weak: ['Weak so far:', 'That is thin so far:'],
  too_early: ['Too early to call:', 'Not enough to call it yet:'],
  bad: ['Bad news, and better known now:', 'Not good, and better known now:'],
};
const OPEN: readonly [string, ...string[]] = [
  'It does not tell you',
  'What you still do not know is',
  'That leaves open',
];
/** A whole sentence of its own ("You do not know how many slept through"). */
const IS_WHOLE =
  /^(?:you|nobody|no one|none|it|they|there|this|that|the \p{L}+|we) (?:\p{L}+ )?(?:do|does|did|have|has|is|are|was|were|may|might|could|can|cannot|know|never|not)\b/iu;

/** What a result does not show. */
function openOf(text: string, seed: string): string {
  const said = flat(bare(text))
    .replace(
      /^(?:it |this |that )?(?:does not|doesn['’]t|do not|don['’]t) (?:yet )?(?:show|tell(?: you| us)?|prove|say)(?: yet)?,? /iu,
      '',
    )
    .replace(/^if /iu, 'whether ');
  if (said === '') return '';
  if (CLAUSE.test(said)) return `${formOf(OPEN, seed)} ${inside(said)}.`;
  if (IS_WHOLE.test(said)) return sentence(said);
  return `It says nothing yet about ${inside(said)}.`;
}

/** The test as something to do, with its number; null: it is none. */
export const testAct = (settles: string | null): string | null => {
  const said = flat(bare(settles ?? ''));
  return ACT.test(said) && hasNumber(said) ? said : null;
};

/** The test that settles a result: an act with a number; '' when there is none. */
function testOf(settles: string | null, seed: string): string {
  const said = flat(bare(settles ?? '')).replace(/^(?:if|when) (?=.*\d)/iu, 'whether ');
  if (said === '' || !hasNumber(said)) return '';
  if (ACT.test(said)) {
    const act = inside(said);
    return formOf(
      [`To settle it, ${act}.`, `${upperFirst(act)}, and you will know.`, `The test is simple: ${act}.`],
      seed,
    );
  }
  if (CLAUSE.test(said)) return `What settles it is ${inside(said)}.`;
  return '';
}

/** Asking people for something: money, an order, a yes. */
const ASKS_PEOPLE = /\b(?:ask|offer|sell|charge|pay|buy|order|pre-?order|price)\b/i;
/** A step that is a test of whatever is to be tested: the opening says which. */
const OPEN_TEST = /\b(?:small test|one test|experiment|your pick)\b/i;
const digits = (text: string): number[] => [
  ...(text.match(/(?<![\d.$])\d{1,4}(?![\d.]*%)/g) ?? []).map(Number),
  ...countsIn(text),
];

/** A test beside the step the reply ends with: one plan. The step is named where both ask people; another plan goes. */
function besideStep(test: string, step: StepSaid | null): string {
  if (test === '' || step === null) return test;
  if (OPEN_TEST.test(step.title)) return test;
  if (!ASKS_PEOPLE.test(test) || !ASKS_PEOPLE.test(step.title)) return '';
  const of = digits(step.title);
  const own = digits(test);
  return of.length > 0 && own.some((n) => of.includes(n)) ? test : 'The step below settles it.';
}

/** On a call nothing stands below, and a step that only stands on their path may go unsaid. */
const heardStep = (test: string, step: StepSaid | null): string =>
  !test.startsWith('The step below')
    ? test
    : step?.chosen === true
      ? test.replace('step below', 'next step')
      : '';

/** What a result shows with their numbers, what it does not, and the test that would settle it. */
function resultOpening(u: Understanding, step: StepSaid | null): Opening | null {
  const { result } = u;
  if (result === null) return null;
  const shows = flat(bare(result.shows));
  const open = result.doesNotShow === null ? '' : openOf(result.doesNotShow, `${shows}?`);
  if (shows === '' && open === '') return null;
  const verdict = formOf(VERDICTS[result.verdict], shows);
  const [first = '', ...rest] = shows.split(/(?<=[.!?])\s+/u);
  const opens =
    shows === '' ? `${verdict.replace(/(?:, and here is why)?:$/u, '')}.` : `${verdict} ${inside(first)}.`;
  const more = rest.map(sentence).join(' ');
  const own = testOf(result.settles, shows);
  const said = own === '' ? testOf(u.firstAction, shows) : own;
  const test = besideStep(said, step);
  return {
    kind: 'result',
    text: join(opens, more, open, test),
    voice: join(opens, test === '' || open !== '' ? open : heardStep(test, step)),
    ...(test !== '' && test === said && !test.startsWith('What settles it')
      ? { uses: 'firstAction' as const }
      : {}),
  };
}

/** They want it called great. */
const SEEKS_PRAISE =
  /\b(?:tell|say|admit|promise|agree|confirm)\b[^.?!]{0,30}\b(?:great|amazing|brilliant|genius|awesome|good|perfect|the best|wonderful|going to (?:work|win|make it))\b|\b(?:isn['’]?t|is) (?:it|this|my idea) (?:great|amazing|brilliant|genius|awesome|wonderful)\b/i;

/** Praise asked for: why it cannot be given yet, what is real so far, and what would show it. */
function unpraisedOpening(u: Understanding): Opening {
  const opens = 'I cannot call it great yet, because what would show that is a stranger who pays for it.';
  const shown = u.record.map((r) => lineSaid(r.text)).find((t) => t !== '' && hasNumber(t));
  const real =
    shown === undefined
      ? 'So far there is the idea, and nothing yet that shows anyone wants it.'
      : `What is real so far is this: ${inside(shown)}.`;
  const shows = 'Ten people you do not know who pay for it this month would show it.';
  return { kind: 'pushback', text: join(opens, real, shows), voice: join(opens, shows) };
}

/** A step that ends in a number somebody else makes. */
const IS_A_TEST = /\b(?:tests?|ask|pay|offer|sell|buy|count)\b/i;

/** They argue: what is not known is owned, what they have is shown, and the test that decides it is named with its day. */
function pushbackOpening(u: Understanding, c: OpeningContext): Opening | null {
  const { step, today } = c;
  if (SEEKS_PRAISE.test(c.message ?? '')) return unpraisedOpening(u);
  const settles = [u.result?.settles, u.choice?.flipsIf, u.firstAction].find(
    (x): x is string =>
      x !== undefined &&
      x !== null &&
      bare(x) !== '' &&
      (ACT.test(bare(x)) || CLAUSE.test(bare(x)) || hasNumber(x)),
  );
  const lines = u.record.map((r) => lineSaid(r.text)).filter((t) => t !== '');
  const all = lines.find(hasNumber) ?? lines[0] ?? u.result?.shows ?? '';
  const shown = c.told?.(all) === true ? '' : all;
  if (bare(all) === '' && settles === undefined) return null;
  const opens = 'Fair: what I said is a judgement, and neither of us has proof yet.';
  const known = bare(shown) === '' ? '' : `What you do have is this: ${inside(shown)}.`;
  const by = step?.dueOn == null ? '' : ` by ${sayDue(today, step.dueOn)}`;
  const said = flat(bare(settles ?? '')).replace(/^if\s+/iu, 'whether ');
  const dated =
    /\b(?:today|tonight|tomorrow|(?:this|next) (?:week|month)|(?:mon|tues|wednes|thurs|fri|satur|sun)day|(?:january|february|march|april|may|june|july|august|september|october|november|december) \d)/iu.test(
      said,
    );
  const other = said !== '' && ACT.test(said) && besideStep(said, step) !== said;
  const test = other
    ? step !== null && ASKS_PEOPLE.test(step.title)
      ? 'The step below decides it.'
      : ''
    : said !== ''
      ? ACT.test(said)
        ? `${upperFirst(inside(said))}${dated ? '' : by}, and that decides it.`
        : CLAUSE.test(said)
          ? `What decides it${by} is ${inside(said)}.`
          : `What decides it${by}: ${inside(said)}.`
      : step === null || !(step.chosen || IS_A_TEST.test(step.title))
        ? ''
        : `What decides it${by}: ${inside(step.title)}.`;
  const heard = heardStep(test, step);
  return {
    kind: 'pushback',
    text: join(opens, known, test),
    voice: join(opens, heard === '' ? known : heard),
  };
}

// Made-up work, and stopping -----------------------------------------------------------------------------------------

const NO_MADE_UP =
  'No, I will not help make that up or hide it: one thing found out puts all your real work in doubt.';
const TIME_LEFT =
  /\b(?:(?:only |just )?have |got )?((?:\d{1,2}|an?|one|two|three|four|half an) (?:hours?|hrs?|minutes?|mins?|evenings?|days?))\b/i;
const OF_TALKS =
  /\b(?:interviews?|talks?|conversations?|tastings?|quotes?|testimonials?|reviews?|surveys?|responses?|answers?|users?|customers?)\b/i;

/** Made-up work is refused in a line; then what can be done for real in the time they have, from what they have. */
function integrityOpening(u: Understanding, message: string): Opening {
  const time = TIME_LEFT.exec(message)?.[1]
    ?.toLowerCase()
    .replace(/\bhrs?\b/, (m) => (m === 'hr' ? 'hour' : 'hours'));
  const left =
    time === undefined
      ? /\btonight\b/i.test(message)
        ? 'Tonight'
        : ''
      : `In the ${time.replace(/^an? /, '')} you have`;
  const real = u.record.map((r) => lineSaid(r.text)).find((t) => t !== '' && hasNumber(t));
  const can =
    u.points.length > 0
      ? ''
      : OF_TALKS.test(`${u.ask} ${message}`)
        ? `${left === '' ? 'Instead' : left}, hold two short talks with people you do not know, write down what they say, and hand in two true ones with a note that they are two.`
        : `${left === '' ? 'Instead' : left}, write down what is true, what you do not know yet, and how you will find out: that can be handed in.`;
  const has = real === undefined ? '' : `What you really have is this: ${inside(real)}.`;
  return { kind: 'integrity', text: join(NO_MADE_UP, has, can), voice: join(NO_MADE_UP, can) };
}

const TO_STOP =
  /\b(?:quit(?:ting)?|giv(?:e|ing) (?:it (?:all )?)?up|walk(?:ing)? away|shut(?:ting)? (?:it|this|the \w+) down|call(?:ing)? it quits|(?:stop(?:ping)?|drop(?:ping)?|leav(?:e|ing)) (?:doing )?(?:it|this|the venture|the (?:whole )?thing|all of (?:it|this)|altogether|for good)|(?:want|going|need|have|like|ready|time|okay|ok|fine|allowed|wrong|bad) to (?:just )?stop)\b/i;
const PERMISSION =
  /\b(?:(?:ok(?:ay)?|all ?right|fine|allowed|wrong|bad|dumb|selfish|crazy|failure) (?:to|if i|for me to)|is (?:it|that) (?:ok(?:ay)?|all ?right|fine|wrong|bad|dumb|selfish)|permission to|am i (?:a )?(?:failure|quitter|wrong|bad))\b/i;
/** Whether they ask leave to stop: an ask of the work, however it is put. */
export const asksToStop = (message: string): boolean =>
  TO_STOP.test(plain(message)) && PERMISSION.test(plain(message));

const HOURS = /\b(?:about |around |some )?(\d{1,3}) ?(?:hours?|hrs?) (?:a|per|each|every) week\b/i;
const MONEY = /\$ ?\d|\b\d[\d,.]* ?(?:dollars?|bucks?)\b/i;

/** "Tell me it is ok to quit": it is; their own numbers; what each way costs. */
function quitOpening(u: Understanding, message: string): Opening | null {
  if (!asksToStop(message)) return null;
  const money = u.record.find((r) => MONEY.test(r.text));
  const hours = [message, ...u.record.map((r) => r.text)]
    .map((t) => HOURS.exec(t)?.[1])
    .find((h) => h !== undefined);
  const opens = 'Yes, it is okay to stop, and it is okay that you are tired of it.';
  const known = money === undefined ? '' : sentence(lineSaid(money.text));
  const back = hours === undefined ? 'your hours back' : `${hours} hours a week back`;
  const costs = `Stopping ${money === undefined ? 'ends what it brings in' : 'ends that'} and gives you ${back}; going on keeps both as they are; a pause or handing it on sits between.`;
  const person =
    u.referral === 'wellbeing'
      ? 'If it is bigger than the venture, talk to the Counseling Center today.'
      : '';
  return { kind: 'quit', text: join(opens, known, costs, person), voice: join(opens, costs) };
}

// Several things, and a plain answer -----------------------------------------------------------------------------------

/** They push on what the mentor said, and not only on what there is to do. */
const CHALLENGES =
  /\byou(?:['’]re| are| keep| always| don['’]?t| do not| have no|r\b)|\b(?:disagree|prove it|says who|your (?:evidence|proof|advice)|what makes you|according to)\b/i;

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

/** Several things at once: one warm sentence, then each of them on its line, the most urgent first. */
function orderOpening(u: Understanding): Opening | null {
  const points = byUrgency(u.points.map(sentence)).filter((p) => p !== '');
  if (points.length < 2) return null;
  const felt = u.kind === 'feelings' || u.also.includes('feelings');
  const warm = felt
    ? 'That is a lot at once, and it makes sense that it feels like too much.'
    : 'That is a lot at once.';
  return {
    kind: 'order',
    text: `${warm} In this order:\n\n${points.map((p, i) => `${String(i + 1)}. ${p}`).join('\n')}`,
    voice: join(
      felt ? 'That is a lot at once.' : warm,
      `First, ${inside(points[0] ?? '')}.`,
      `Then, ${inside(points[1] ?? '')}.`,
    ),
  };
}

const ASKS_WHICH_WAY =
  /^(?:whether|if|is|are|was|does|do|can|could|should|what (?:number|would|counts|result)|which|how (?:many|much|soon|long))\b/i;

/** A plain question with one answer: the first claim, when it is one. */
function answerOpening(u: Understanding): Opening | null {
  const [first = ''] = u.points;
  if (!/^(?:question|next|update|feelings)$/.test(u.kind) || u.also.includes('draft')) return null;
  if (u.referral !== null || bare(first) === '') return null;
  if (!ASKS_WHICH_WAY.test(u.ask.trim())) return null;
  const asked = new Set(contentStems(u.ask));
  const number =
    /\b(?:numbers?|how (?:many|much|soon|long)|figure|pass line|threshold)\b/i.test(u.ask) &&
    hasNumber(first);
  if (!number && !contentStems(first).some((w) => asked.has(w))) return null;
  const said = sentence(first);
  return { kind: 'answer', text: said, voice: said };
}

const is = (u: Understanding, ...kinds: readonly Understanding['kind'][]): boolean =>
  kinds.includes(u.kind) || u.also.some((k) => kinds.includes(k));
/** "How do I …", "what do I even ask": the way, and no verdict. */
const ASKS_HOW =
  /^(?:(?:ok(?:ay)?|so|and|but|like|um+|uh+|well|no)[, ]+)*(?:how (?:do|would|should|can|could) (?:i|we)\b|what do (?:i|we) (?:literally |actually |even )?(?:say|write|ask)\b)/i;
const ASKS_FIGURE =
  /\bhow (?:much|many|long|soon)\b|\bnumbers?\b|\${2,}|\b(?:fewest|least|minimum)\b|\bwhat(?:['’]?s| is| do| does| am| are)\b[^.?!]{0,60}\b(?:left|worth|paid|earn|figure|pocket|zero|bank|comes? (?:in|to))\b|\bwhen (?:does|do|will|have|has)\b/i;
/** Whether the message is one a result is read in: never over a recall, a figure nobody worked out, or a how-to. */
function readsResult(u: Understanding, message: string, outcome: boolean): boolean {
  if (!outcome) return false;
  if (is(u, 'recall', 'draft', 'privacy', 'integrity') || ASKS_HOW.test(message)) return false;
  if (!u.sums.some((s) => s.asked) && (u.kind === 'sum' || (is(u, 'sum') && ASKS_FIGURE.test(message))))
    return false;
  return is(u, 'result', 'update', 'pushback', 'feelings') || u.result !== null;
}

/** Friends' praise, in full once; asked of again, the answer in short. */
function praiseOpening(c: OpeningContext): Opening | null {
  if (c.praise == null) return null;
  if (c.told?.(c.praise.means) === true) {
    const said = 'No, friends are not proof. Ask people you do not know, at a price, and count who pays.';
    return { kind: 'praise', text: said, voice: said };
  }
  return { kind: 'praise', text: c.praise.means, voice: c.praise.spoken };
}

/** A result nobody read: what its counts show (told-counts.ts). */
function countsOpening(message: string): Opening | null {
  const told = toldCounts(message);
  return told === null ? null : { kind: 'counts', text: told.text, voice: told.voice };
}

// Which comes first --------------------------------------------------------------------------------------------------

/** Every opening the reading holds, the one the reply opens with first; the others are the writer's points. */
export function openingsOf(u: Understanding, c: OpeningContext): Opening[] {
  const message = c.message ?? '';
  // The words themselves are asked for: they are the whole reply.
  if (c.textAsked === true && u.kind !== 'integrity') return [];
  const solo = soloOpening(u, message);
  const asked = u.sums.some((s) => s.asked);
  const made: Readonly<Record<OpeningKind, Opening | null>> = {
    quit: quitOpening(u, message),
    sum: sumOpening(u, message, c),
    missing: missingOpening(u, message),
    contradiction: contradictionOpening(u, c),
    held: solo === null ? heldOpening(u, c.referral, message) : null,
    choice: choiceOpening(u) ?? listPick(u, message, c.earlier ?? []),
    result: readsResult(u, message, c.outcome !== false) ? resultOpening(u, c.step) : null,
    solo,
    praise: asked || u.choice !== null ? null : praiseOpening(c),
    counts: u.result === null && readsResult(u, message, c.outcome !== false) ? countsOpening(message) : null,
    pushback: u.kind === 'pushback' ? pushbackOpening(u, c) : null,
    order: c.inOrder === true ? orderOpening(u) : null,
    answer: answerOpening(u) ?? (u.kind === 'recall' || u.kind === 'draft' ? null : isItOpening(message)),
    integrity: u.kind === 'integrity' ? integrityOpening(u, message) : null,
    recall: u.kind === 'recall' ? recallOpening(u, c.today) : null,
  };
  const sumFirst = asked && u.kind !== 'choice' && u.kind !== 'recall' && is(u, 'sum');
  const first: readonly OpeningKind[] = sumFirst
    ? ['integrity', 'sum']
    : made.quit !== null && c.inOrder !== true
      ? ['integrity', 'quit']
      : c.inOrder === true
        ? ['integrity', 'quit', 'order']
        : u.kind === 'pushback' && !CHALLENGES.test(message) && made.result !== null
          ? ['contradiction', 'held', 'praise', 'result']
          : (ORDER[u.kind] ?? FIRST);
  return [...first].concat(FIRST).flatMap((kind, i, all) => {
    const opening = made[kind];
    return opening === null || all.indexOf(kind) !== i ? [] : [opening];
  });
}

/** Which opening comes first: what they asked for, after what their own record denies. */
const FIRST: readonly OpeningKind[] = [
  'integrity',
  'contradiction',
  'held',
  'sum',
  'missing',
  'quit',
  'solo',
  'choice',
  'praise',
  'result',
  'counts',
  'pushback',
  'recall',
  'answer',
];
const ORDER: Readonly<Partial<Record<Understanding['kind'], readonly OpeningKind[]>>> = {
  sum: ['sum', 'missing'],
  recall: ['recall'],
  result: ['contradiction', 'praise', 'result', 'counts'],
  question: ['integrity', 'contradiction', 'held', 'sum', 'missing', 'solo', 'praise', 'answer'],
  feelings: ['quit'],
  choice: ['contradiction', 'held', 'solo', 'choice'],
  pushback: ['contradiction', 'held', 'praise', 'pushback'],
};

/** What an opening that does not open the reply is to the writer: claims the answer makes. */
export function asPoints(u: Understanding, openings: readonly Opening[], lead: OpeningKind | null): string[] {
  return openings.flatMap((o): string[] => {
    if (o.kind === lead) return [];
    switch (o.kind) {
      case 'contradiction':
        return u.contradicts === null
          ? []
          : [bare(u.contradicts.why) === '' ? bare(u.contradicts.line.text) : bare(u.contradicts.why)];
      case 'choice':
        return u.choice === null || bare(u.choice.because) === ''
          ? []
          : [upperFirst(inside(u.choice.because))];
      case 'result':
        return u.result === null
          ? []
          : [
              bare(u.result.shows),
              ...(u.result.settles !== null && ACT.test(bare(u.result.settles)) && hasNumber(u.result.settles)
                ? [bare(u.result.settles)]
                : []),
            ].filter((x) => x !== '');
      case 'sum':
        return u.sums
          .filter((x) => x.asked)
          .slice(0, 2)
          .map((x) => bare(sumOfReading(u, x)));
      case 'missing':
        return [bare(o.text)];
      default:
        return [];
    }
  });
}
