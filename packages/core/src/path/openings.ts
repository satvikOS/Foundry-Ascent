import { isEverydayWord, type Understanding, type UnderstoodReferral } from '@foundry/ai';
import { type Play } from '@foundry/contracts';

import { sayDue } from './dates.js';
import { sumSaid, type SumContext } from './sum-said.js';
import { bare, lowerFirst, upperFirst } from './tell.js';
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
  /** Whether the conversation said it already. */
  readonly told?: (text: string) => boolean;
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

const sumContext = (u: Understanding, message: string): SumContext => ({
  texts: [message, ...u.record.map((r) => r.text)],
  worth: u.referral === 'valuation',
});

/** A sum of the reading's, as it is said. */
export const sumOfReading = (u: Understanding, s: Understanding['sums'][number], message = ''): string =>
  sumSaid(s, sumContext(u, message)).text;

function sumOpening(u: Understanding, message: string): Opening | null {
  const asked = u.sums.filter((s) => s.asked).slice(0, 2);
  if (asked.length === 0) return null;
  const said = asked.map((s) => sumSaid(s, sumContext(u, message)));
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
  if (u.contradicts === null || bare(u.contradicts.line.text) === '') return null;
  const { line, why } = u.contradicts;
  const decided = /^(?:decision|pivot)$/.test(line.kind);
  const said = inside(
    line.text
      .replace(/^you decided:\s+(?:next:\s+)?/i, 'you decided to ')
      .replace(/^you decided(?: (?:to|that))? /i, (m) => m.toLowerCase()),
  );
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
  const fresh = contentStems(why).filter((w) => !held.has(w));
  const more = fresh.length >= 2 ? sentence(why) : '';
  return { kind: 'contradiction', text: join(opens, more), voice: join(opens, more) };
}

/** What is on record, as they asked for it. */
function recallOpening(u: Understanding, today: string): Opening | null {
  const lines = u.record
    .slice(0, 4)
    .filter((r) => bare(r.text) !== '')
    .map((r) =>
      r.on === null ? sentence(r.text) : `${upperFirst(sayDue(today, r.on))}: ${inside(r.text)}.`,
    );
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
  if (made === undefined || ![u.kind, ...u.also].some((k) => /^(?:choice|question|pushback)$/.test(k)))
    return null;
  // A choice that only a person makes was asked for, whatever its words.
  const asked = bare(u.ask) === '' ? message : u.ask;
  if (u.kind !== 'choice' && !RULING_ASKED.test(asked)) return null;
  const who = inside(referral.who.split(/[,;]/u)[0] ?? referral.who);
  const [first, second] = made(who, `${asked} ${message}`);
  return { kind: 'held', text: join(first, second), voice: join(first, second) };
}
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
      : `I’d change my mind if ${inside(choice.flipsIf.replace(/^(?:if|when)\s+/i, ''))}.`;
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

/** What a result shows with their numbers, what it does not, and the test that would settle it. */
function resultOpening(u: Understanding): Opening | null {
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
  const test = own === '' ? testOf(u.firstAction, shows) : own;
  return {
    kind: 'result',
    text: join(opens, more, open, test),
    voice: join(opens, test === '' || open !== '' ? open : test),
    ...(test !== '' && !test.startsWith('What settles it') ? { uses: 'firstAction' as const } : {}),
  };
}

/** A step that ends in a number somebody else makes. */
const IS_A_TEST = /\b(?:tests?|ask|pay|offer|sell|buy|count)\b/i;

/** They argue: what is not known is owned, what they have is shown, and the test that decides it is named with its day. */
function pushbackOpening(u: Understanding, c: OpeningContext): Opening | null {
  const { step, today } = c;
  const settles = [u.result?.settles, u.choice?.flipsIf, u.firstAction].find(
    (x): x is string =>
      x !== undefined &&
      x !== null &&
      bare(x) !== '' &&
      (ACT.test(bare(x)) || CLAUSE.test(bare(x)) || hasNumber(x)),
  );
  const fact = u.record.find((r) => hasNumber(r.text)) ?? u.record[0];
  const all = fact?.text ?? u.result?.shows ?? '';
  const shown = c.told?.(all) === true ? '' : all;
  if (bare(all) === '' && settles === undefined) return null;
  const opens = 'Fair: what I said is a judgement, and neither of us has proof yet.';
  const known = bare(shown) === '' ? '' : `What you do have is this: ${inside(shown)}.`;
  const by = step?.dueOn == null ? '' : ` by ${sayDue(today, step.dueOn)}`;
  const said = flat(bare(settles ?? '')).replace(/^if\s+/iu, 'whether ');
  const dated = /\b(?:today|tonight|tomorrow|this week|(?:mon|tues|wednes|thurs|fri|satur|sun)day)\b/iu.test(
    said,
  );
  const test =
    said !== ''
      ? ACT.test(said)
        ? `${upperFirst(inside(said))}${dated ? '' : by}, and that decides it.`
        : CLAUSE.test(said)
          ? `What decides it${by} is ${inside(said)}.`
          : `What decides it${by}: ${inside(said)}.`
      : step === null || !(step.chosen || IS_A_TEST.test(step.title))
        ? ''
        : `What decides it${by}: ${inside(step.title)}.`;
  return { kind: 'pushback', text: join(opens, known, test), voice: join(opens, test === '' ? known : test) };
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
  const real = u.record.find((r) => hasNumber(r.text));
  const can =
    u.points.length > 0
      ? ''
      : OF_TALKS.test(`${u.ask} ${message}`)
        ? `${left === '' ? 'Instead' : left}, hold two short talks with people you do not know, write down what they say, and hand in two true ones with a note that they are two.`
        : `${left === '' ? 'Instead' : left}, write down what is true, what you do not know yet, and how you will find out: that can be handed in.`;
  const has = real === undefined ? '' : `What you really have is this: ${inside(real.text)}.`;
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
  const known = money === undefined ? '' : sentence(money.text.replace(/^A risk you named: /u, ''));
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

// Which comes first --------------------------------------------------------------------------------------------------

/** Every opening the reading holds, the one the reply opens with first; the others are the writer's points. */
export function openingsOf(u: Understanding, c: OpeningContext): Opening[] {
  const message = c.message ?? '';
  const made: Readonly<Record<OpeningKind, Opening | null>> = {
    quit: quitOpening(u, message),
    sum: sumOpening(u, message),
    missing: missingOpening(u, message),
    contradiction: contradictionOpening(u, c),
    held: heldOpening(u, c.referral, message),
    choice: choiceOpening(u),
    result: resultOpening(u),
    pushback: u.kind === 'pushback' ? pushbackOpening(u, c) : null,
    order: c.inOrder === true ? orderOpening(u) : null,
    answer: answerOpening(u),
    integrity: u.kind === 'integrity' ? integrityOpening(u, message) : null,
    recall: u.kind === 'recall' ? recallOpening(u, c.today) : null,
  };
  const first =
    c.inOrder === true
      ? (['integrity', 'quit', 'order'] as const)
      : u.kind === 'pushback' && !CHALLENGES.test(message) && made.result !== null
        ? (['contradiction', 'held', 'result'] as const)
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
  'choice',
  'result',
  'pushback',
  'recall',
  'answer',
];
const ORDER: Readonly<Partial<Record<Understanding['kind'], readonly OpeningKind[]>>> = {
  sum: ['sum', 'missing'],
  recall: ['recall'],
  result: ['contradiction', 'result'],
  feelings: ['quit'],
  choice: ['contradiction', 'held', 'choice'],
  pushback: ['contradiction', 'held', 'pushback'],
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
        return u.choice === null ? [] : [`${upperFirst(inside(u.choice.pick))}: ${inside(u.choice.because)}`];
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
