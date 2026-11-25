import { isEverydayWord, type Understanding, type UnderstoodReferral, type UnderstoodSum } from '@foundry/ai';
import { type Play, type RiskCategory, type TurnGuidance } from '@foundry/contracts';

import { sayDue } from './dates.js';
import { asksOverview } from './kinds.js';
import { referralForRisk } from './referrals.js';
import { bare, lowerFirst, upperFirst } from './tell.js';
import { type Playbook } from './types.js';
import { contentStems, plain } from './words.js';

/**
 * The checked reading of a message (docs/architecture/understand.md) as the turn uses it: who decides what where the rules
 * and the reading disagree, the server's one opening, and what the writer is given. Pure. Without a reading nothing here
 * is asked, and the rules decide as they always did.
 */

// Who decides -------------------------------------------------------------------------------------------------------

/** What is known of the turn when the rules and the reading are weighed. */
export interface Weighed {
  /** Their own report, commitment or smaller ask: "done", "not yet", "I'll do five". */
  readonly ownReport: boolean;
  /** A change of direction, or another idea. */
  readonly turned: boolean;
  /** Something done with the conversation itself: said again, the template, when it is enough, the whole path as a plan. */
  readonly operation: boolean;
  /** A referral's own phrase is in the message. */
  readonly referralPhrase: boolean;
  /** What is never shared is asked for, by a phrase. */
  readonly heldPhrase: boolean;
  /** They push on what a qualified person decides, or on what is never shared, and ask nothing else. */
  readonly heldPush: boolean;
  /** The founder asks to be told what is on record, by a phrase. */
  readonly recallPhrase: boolean;
  /** A phrase of the playbook names the play. */
  readonly phrase: boolean;
  /** The reading names a play, and plainly. */
  readonly namesPlay: boolean;
  readonly sure: boolean;
  /** The reading names the step's play, and the path allows it. */
  readonly namesStep: boolean;
  /** The reading finds that a qualified person decides. */
  readonly refers: boolean;
  /** The reading reads their message as a recall. */
  readonly readsRecall: boolean;
  /** The reading works out, picks, reads a result or finds a contradiction: the message asks more than a recall. */
  readonly readsMore: boolean;
  /** The reading's own sum they asked for, worked out by code. */
  readonly readSum: boolean;
  /** The calculator's sum, sure of every number (calc.ts). */
  readonly ruleSum: boolean;
  /** Both came to the same figure. */
  readonly sameSum: boolean;
  /** The reading makes the choice they ask for. */
  readonly picks: boolean;
  /** Their own counts decide the choice (choice.ts). */
  readonly countsPick: boolean;
  /** Both name the same option. */
  readonly samePick: boolean;
}

/** Nothing known of it. */
export const NOTHING: Weighed = {
  ownReport: false,
  turned: false,
  operation: false,
  referralPhrase: false,
  heldPhrase: false,
  heldPush: false,
  recallPhrase: false,
  phrase: false,
  namesPlay: false,
  sure: false,
  namesStep: false,
  refers: false,
  readsRecall: false,
  readsMore: false,
  readSum: false,
  ruleSum: false,
  sameSum: false,
  picks: false,
  countsPick: false,
  samePick: false,
};

export type Decides = 'rule' | 'reading';
export type WeighedField = 'kind' | 'recall' | 'play' | 'step' | 'referral' | 'sum' | 'choice' | 'lead';

interface Row {
  readonly when: string;
  readonly test: (w: Weighed) => boolean;
  readonly by: Decides;
}
const row = (when: string, test: (w: Weighed) => boolean, by: Decides): Row => ({ when, test, by });

/**
 * Where the rules and the reading disagree: the first row that holds decides. Above all of it stand a crisis, a rehearsal,
 * a social turn, a wellbeing or conflict risk, a pivot and the writes of a report, which no reading changes.
 */
export const PRECEDENCE: Readonly<Record<WeighedField, readonly Row[]>> = {
  kind: [
    row('their own report, commitment or smaller ask', (w) => w.ownReport, 'rule'),
    row('a change of direction, another idea', (w) => w.turned, 'rule'),
    row('something done with the conversation itself', (w) => w.operation, 'rule'),
    row('any other message', () => true, 'reading'),
  ],
  recall: [
    row('the reading reads a recall', (w) => w.readsRecall, 'reading'),
    row(
      'a phrase asks what is on record, and the reading finds no more in it',
      (w) => w.recallPhrase && !w.readsMore,
      'rule',
    ),
    row('any other message', () => true, 'reading'),
  ],
  play: [
    row('a referral’s own phrase', (w) => w.referralPhrase, 'rule'),
    row('what is never shared, by a phrase', (w) => w.heldPhrase, 'rule'),
    row('a push on what a person decides or is never shared', (w) => w.heldPush, 'rule'),
    row(
      'their own report, a change of direction, an operation',
      (w) => w.ownReport || w.turned || w.operation,
      'rule',
    ),
    row('the reading is sure of its play', (w) => w.namesPlay && w.sure, 'reading'),
    row('a phrase names a play', (w) => w.phrase, 'rule'),
    row('the reading names a play, or who decides', (w) => w.namesPlay || w.refers, 'reading'),
    row('neither', () => true, 'rule'),
  ],
  step: [
    row(
      'their own report, a change of direction, an operation',
      (w) => w.ownReport || w.turned || w.operation,
      'rule',
    ),
    row(
      'a referral’s own phrase, or what is never shared',
      (w) => w.referralPhrase || w.heldPhrase || w.heldPush,
      'rule',
    ),
    row('the reading reads a recall', (w) => w.readsRecall, 'rule'),
    row(
      'the reading names the step, a play or who decides',
      (w) => w.namesStep || w.namesPlay || w.refers,
      'reading',
    ),
    row('a phrase names a play', (w) => w.phrase, 'rule'),
    row('any other message keeps the step they are on', () => true, 'reading'),
  ],
  // Who decides is only ever added: the rules' referral stands whatever the reading says.
  referral: [
    row('the rules find one', (w) => w.referralPhrase || w.heldPush, 'rule'),
    row('the reading finds one', (w) => w.refers, 'reading'),
    row('neither', () => true, 'rule'),
  ],
  sum: [
    row('both come to the same figure: the calculator’s words', (w) => w.sameSum, 'rule'),
    row('the reading works out what they ask', (w) => w.readSum, 'reading'),
    row('the calculator is sure', (w) => w.ruleSum, 'rule'),
    row('neither', () => true, 'reading'),
  ],
  choice: [
    row('both name the same option: their counts say why', (w) => w.countsPick && w.samePick, 'rule'),
    row('the reading picks', (w) => w.picks, 'reading'),
    row('their own counts decide', (w) => w.countsPick, 'rule'),
    row('neither', () => true, 'reading'),
  ],
  lead: [
    row(
      'their own report, a change of direction, an operation',
      (w) => w.ownReport || w.turned || w.operation,
      'rule',
    ),
    row('any other message', () => true, 'reading'),
  ],
};

export const decides = (field: WeighedField, w: Weighed): Decides =>
  PRECEDENCE[field].find((r) => r.test(w))?.by ?? 'rule';

// What the reading says ---------------------------------------------------------------------------------------------

/** Whether a reading says enough of the message to rest a turn on. */
export const speaks = (u: Understanding): boolean =>
  u.points.length > 0 ||
  u.sums.length > 0 ||
  u.missing !== null ||
  u.choice !== null ||
  u.result !== null ||
  u.contradicts !== null ||
  u.referral !== null ||
  u.kind === 'recall' ||
  u.kind === 'integrity' ||
  u.kind === 'privacy';

const is = (u: Understanding, ...kinds: readonly Understanding['kind'][]): boolean =>
  kinds.includes(u.kind) || u.also.some((k) => kinds.includes(k));

/** Whether they ask something of the work, however they feel: a message only of feelings is answered as a person, with no task. */
export const asksOfWork = (u: Understanding): boolean =>
  (u.kind !== 'feelings' && u.kind !== 'social') ||
  is(u, 'question', 'choice', 'sum', 'result', 'next', 'draft', 'recall', 'integrity') ||
  u.secondAsk !== null;

/** Several things happened, or they do not know where to start: what there is to say is said in order, whatever else. */
export const needsOrder = (u: Understanding): boolean =>
  u.points.length >= 2 &&
  ((is(u, 'next') && is(u, 'feelings', 'update', 'result')) ||
    (is(u, 'feelings') && is(u, 'update', 'result')));

/** The whole path asked for as such: "get me organized", "a plan for the next two weeks". */
const WHOLE_PATH = /\borgani[sz]e\w*\b|\b(?:plan|road ?map|schedule|check ?list|to ?do list)\b/;
export const asksWholePath = (message: string, u: Understanding): boolean =>
  asksOverview(message) &&
  WHOLE_PATH.test(plain(message)) &&
  u.contradicts === null &&
  u.result === null &&
  u.choice === null &&
  u.sums.length === 0 &&
  !is(u, 'feelings', 'update', 'result', 'pushback');

/** Who decides, by what the reading says it is about. */
const REFERRAL_RISKS: Readonly<Partial<Record<UnderstoodReferral, RiskCategory>>> = {
  ip: 'ip_licensing',
  legal: 'legal',
  valuation: 'securities_investment',
  equity: 'legal',
  immigration: 'legal',
  regulatory: 'medical_regulatory',
  irb: 'medical_regulatory',
};
/** The play of a referral that its risk's own words would not find. */
const REFERRAL_PLAYS: Readonly<Partial<Record<UnderstoodReferral, string>>> = {
  equity: 'equity-split',
  immigration: 'international-student',
  irb: 'regulated-data',
};
const FOOD_OR_PERMIT =
  /\b(?:permits?|food|kitchen|cook\w*|bak(?:e|ed|ing|ery)|alcohol|health department|licen[cs]es?|street|stall|cart)\b/;

/** The play whose qualified person decides what the reading says one must; null: the reading names none. */
export function referralPlayOf(playbook: Playbook, u: Understanding, message: string): Play | null {
  const { referral } = u;
  if (referral === null) return null;
  const byId = (id: string | null | undefined): Play | null =>
    playbook.plays.find((x) => x.id === id && x.referral !== null) ?? null;
  const category = REFERRAL_RISKS[referral];
  // The ask's own play, when the same person decides it.
  const own = [byId(u.playId), byId(u.stepPlayId)].find(
    (p) =>
      p?.referral?.category === category ||
      (category === 'medical_regulatory' && p?.referral?.category === 'legal'),
  );
  if (own != null && category !== undefined) return own;
  const named = byId(REFERRAL_PLAYS[referral]);
  if (named !== null) return named;
  if (referral === 'regulatory' && FOOD_OR_PERMIT.test(plain(message))) {
    const permits = byId('permits-food');
    if (permits !== null) return permits;
  }
  return category === undefined ? null : byId(referralForRisk(playbook, [category], message)?.playId);
}

// The one opening ---------------------------------------------------------------------------------------------------

export type OpeningKind =
  'sum' | 'missing' | 'contradiction' | 'held' | 'choice' | 'result' | 'pushback' | 'integrity' | 'recall';

export interface Opening {
  readonly kind: OpeningKind;
  readonly text: string;
  readonly voice: string;
}

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();
const join = (...parts: readonly string[]): string => flat(parts.filter((p) => p !== '').join(' '));
const sentence = (text: string): string => (text === '' ? '' : `${upperFirst(bare(text))}.`);

/** The clause with its first letter lower, unless it opens with a name. */
const inside = (text: string): string => {
  const said = bare(text);
  const word = /^[\p{L}'’]+/u.exec(said)?.[0] ?? '';
  return isEverydayWord(word.toLowerCase()) || isEverydayWord(word) ? lowerFirst(said) : said;
};
const CLAUSE = /^(?:whether|if|how|why|who|whom|whose|what|when|where|which|that)\b/i;

/** A working as it is heard; '' when nobody could follow it. */
function heardWorking(working: string): string {
  const steps = [...working.matchAll(/[×÷−+*/]/gu)].length;
  if (steps === 0 || steps > 3 || /[()]/.test(working)) return '';
  return working
    .replace(/\s*[×*]\s*/gu, ' times ')
    .replace(/\s*[÷/]\s*/gu, ' divided by ')
    .replace(/\s+[−-]\s+/gu, ' minus ')
    .replace(/\s*\+\s*/gu, ' plus ');
}

/** A label that a verb may follow ("what Saturday left you"). */
const VERBAL = /^(?:what|how (?:much|many|long|often)|the|your|each|one|an? )\b/i;

/** One sum as it is said. */
export function sumSaid(s: UnderstoodSum): { readonly text: string; readonly voice: string } {
  const label = upperFirst(bare(s.label));
  const working = flat(s.working);
  const verbal = VERBAL.test(s.label);
  const is = verbal ? `${label} is ${s.said}` : `${label}: ${s.said}`;
  const heard = heardWorking(working);
  return {
    text:
      working === '' || working === s.said ? `${is}.` : verbal ? `${is}: ${working}.` : `${is} (${working}).`,
    voice: heard === '' ? `${is}.` : `${is}, ${heard}.`,
  };
}

function sumOpening(u: Understanding): Opening | null {
  const asked = u.sums.filter((s) => s.asked).slice(0, 2);
  if (asked.length === 0) return null;
  const said = asked.map(sumSaid);
  return { kind: 'sum', text: join(...said.map((s) => s.text)), voice: join(...said.map((s) => s.voice)) };
}

/** A sum that lacks a number: which one, with what the others come to. */
function missingOpening(u: Understanding): Opening | null {
  if (u.missing === null) return null;
  const known = u.sums.slice(0, 1).map((s) => sumSaid(s).text);
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

/** Their record denies what they say, or they change it: named first, kindly. */
function contradictionOpening(u: Understanding, yesNo: boolean, today: string): Opening | null {
  if (u.contradicts === null) return null;
  const { line, why } = u.contradicts;
  const decided = /^(?:decision|pivot)$/.test(line.kind);
  const said = inside(line.text.replace(/^you decided(?: (?:to|that))? /i, (m) => m.toLowerCase()));
  const on = line.on === null ? '' : ` (${sayDue(today, line.on)})`;
  const opens = decided
    ? `That changes something you settled before${on}: ${said}.`
    : `${yesNo ? 'Not quite: your' : 'Your'} own ${/\d/.test(line.text) ? 'numbers say' : 'record says'} otherwise: ${said}.`;
  // What the reading says of it, where it says more than the line.
  const held = new Set(contentStems(line.text));
  const fresh = contentStems(why).filter((w) => !held.has(w));
  const more = fresh.length >= 2 ? sentence(why) : '';
  return { kind: 'contradiction', text: join(opens, more), voice: opens };
}

/** An offer, terms or a status that a person decides: what can be said by when, never a yes, a no or a price. */
function heldOpening(u: Understanding, referral: Play['referral']): Opening | null {
  if (referral === null || u.referral === null || u.referral === 'wellbeing' || u.referral === 'grants')
    return null;
  if (u.choice !== null || !is(u, 'choice', 'question', 'pushback')) return null;
  if (!RULING_ASKED.test(u.ask)) return null;
  const who = inside(referral.who.split(/[,;]/u)[0] ?? referral.who);
  const text = `Give no answer on that yet: whether it is right for you is for ${who} to read with you first, and a yes or no from me would be a guess.`;
  return { kind: 'held', text, voice: text };
}
/** Asks whether to take it, sign it, whether it is fair, allowed or theirs. */
const RULING_ASKED =
  /\b(?:whether|should|is|are|if)\b.{0,90}\b(?:accept|take|sign|agree|fair|good|bad|price|worth|allowed|legal|own|owns|split|claim|say|right|normal|okay|ok|reasonable|problem|can)\b/i;

/** The choice they ask for, made: the pick, why, and what would change it. */
function choiceOpening(u: Understanding): Opening | null {
  const { choice } = u;
  if (choice === null) return null;
  const pick = bare(choice.pick);
  const opens = /^(?:yes|no|not yet|neither|both)\b/i.test(pick)
    ? `${upperFirst(pick)}.`
    : `My pick: ${inside(pick)}.`;
  const why = sentence(choice.because.replace(/^because\s+/i, ''));
  const flips =
    choice.flipsIf === null
      ? ''
      : `I would change my mind if ${inside(choice.flipsIf.replace(/^(?:if|when)\s+/i, ''))}.`;
  return { kind: 'choice', text: join(opens, why, flips), voice: join(opens, why) };
}

const VERDICTS: Readonly<Record<NonNullable<Understanding['result']>['verdict'], string>> = {
  strong: 'That is a strong result, and here is what it shows.',
  promising: 'Promising, and not proven yet. Here is what it shows.',
  mixed: 'It is mixed. Here is what it shows.',
  weak: 'It is weak so far. Here is what it shows.',
  too_early: 'It is too early to call. Here is what it shows so far.',
  bad: 'It is bad news, and better known now than later. Here is what it shows.',
};

/** What a result shows with their numbers, what it does not, and what would settle it. */
function resultOpening(u: Understanding): Opening | null {
  const { result } = u;
  if (result === null) return null;
  const not =
    result.doesNotShow === null
      ? ''
      : CLAUSE.test(result.doesNotShow)
        ? `It does not show ${inside(result.doesNotShow)}.`
        : `What it does not show: ${inside(result.doesNotShow)}.`;
  const settles = result.settles === null ? '' : `What would settle it: ${inside(result.settles)}.`;
  const shows = sentence(result.shows);
  return {
    kind: 'result',
    text: join(VERDICTS[result.verdict], shows, not, settles),
    voice: join(VERDICTS[result.verdict].split(/(?<=[.,]) (?:and )?here/iu)[0] ?? '', shows, not),
  };
}

/** They argue: what is not known is owned, what they have is shown, and the test that decides it is named with its day. */
function pushbackOpening(u: Understanding, step: StepSaid | null, today: string): Opening | null {
  const settles = u.result?.settles ?? u.choice?.flipsIf ?? u.firstAction;
  const fact = u.record.find((r) => /\d/.test(r.text)) ?? u.record[0];
  const shown = fact?.text ?? u.result?.shows;
  if (shown === undefined && settles === null) return null;
  const opens = 'Fair: what I said is a judgement, and neither of us has proof yet.';
  const known = shown === undefined ? '' : `What you have so far: ${inside(shown)}.`;
  const by = step?.dueOn == null ? '' : ` by ${sayDue(today, step.dueOn)}`;
  const test =
    settles !== null
      ? `What decides it${by}: ${inside(settles.replace(/^if\s+/i, ''))}.`
      : step?.chosen !== true
        ? ''
        : `What decides it${by}: ${inside(step.doneWhen)}.`;
  return { kind: 'pushback', text: join(opens, known, test), voice: join(opens, test === '' ? known : test) };
}

const INTEGRITY =
  'No, I will not help make that up or hide it: whoever relies on it would be misled, and one thing found out puts all your real work in doubt.';

/** What is on record, as they asked for it. */
function recallOpening(u: Understanding, today: string): Opening | null {
  const lines = u.record.slice(0, 4).map((r) => {
    const text = sentence(r.text);
    return r.on === null ? text : `${upperFirst(sayDue(today, r.on))}: ${inside(r.text)}.`;
  });
  if (lines.length === 0) return null;
  return { kind: 'recall', text: join(...lines), voice: join(...lines.slice(0, 2)) };
}

/** The step as an opening may name it. */
export interface StepSaid {
  readonly dueOn: string | null;
  readonly doneWhen: string;
  /** It serves what they ask; else it only stands on their path. */
  readonly chosen: boolean;
}

/** Every opening the reading holds, the one the reply opens with first; the others are the writer's points. */
export function openingsOf(
  u: Understanding,
  args: {
    readonly yesNo: boolean;
    readonly today: string;
    readonly referral: Play['referral'];
    readonly step: StepSaid | null;
  },
): Opening[] {
  const made: Readonly<Record<OpeningKind, Opening | null>> = {
    sum: sumOpening(u),
    missing: missingOpening(u),
    contradiction: contradictionOpening(u, args.yesNo, args.today),
    held: heldOpening(u, args.referral),
    choice: choiceOpening(u),
    result: resultOpening(u),
    pushback: u.kind === 'pushback' ? pushbackOpening(u, args.step, args.today) : null,
    integrity:
      u.kind === 'integrity' ? { kind: 'integrity', text: INTEGRITY, voice: firstOf(INTEGRITY) } : null,
    recall: u.kind === 'recall' ? recallOpening(u, args.today) : null,
  };
  return (ORDER[u.kind] ?? FIRST).concat(FIRST).flatMap((kind, i, all) => {
    const opening = made[kind];
    return opening === null || all.indexOf(kind) !== i ? [] : [opening];
  });
}

const firstOf = (text: string): string => text.split(/(?<=[.!?:])\s+/u)[0]?.replace(/:$/u, '.') ?? text;

/** Which opening comes first: what they asked for, after what their own record denies. */
const FIRST: readonly OpeningKind[] = [
  'integrity',
  'contradiction',
  'held',
  'sum',
  'missing',
  'choice',
  'result',
  'pushback',
  'recall',
];
const ORDER: Readonly<Partial<Record<Understanding['kind'], readonly OpeningKind[]>>> = {
  sum: ['sum', 'missing'],
  recall: ['recall'],
  result: ['contradiction', 'result'],
  choice: ['contradiction', 'held', 'choice'],
  pushback: ['contradiction', 'held', 'pushback'],
};

/** What an opening that does not open the reply is to the writer: claims the answer makes. */
export function asPoints(u: Understanding, openings: readonly Opening[], lead: OpeningKind | null): string[] {
  return openings.flatMap((o): string[] => {
    if (o.kind === lead) return [];
    switch (o.kind) {
      case 'contradiction':
        return u.contradicts === null ? [] : [bare(u.contradicts.why)];
      case 'choice':
        return u.choice === null ? [] : [`Pick ${inside(u.choice.pick)}: ${inside(u.choice.because)}`];
      case 'result':
        return u.result === null
          ? []
          : [
              bare(u.result.shows),
              ...(u.result.settles === null ? [] : [`What would settle it: ${inside(u.result.settles)}`]),
            ];
      case 'sum':
      case 'missing':
        return [bare(o.text)];
      default:
        return [];
    }
  });
}

// What stands before the step ---------------------------------------------------------------------------------------

const NOT_AN_ACTION =
  /^(?:you|i|we|they|it|this|that|the|an?|your|consider|think|reflect|focus|continue|keep going|keep doing|explore|be|try to|aim|remember|understand|evaluate|assess|decide|plan|prepare|stay|feel|make sure|ensure|wait)\b/i;
const DAY =
  '(?:(?:next |this )?(?:mon|tues|wednes|thurs|fri|satur|sun)day|today|tonight|tomorrow|(?:the )?end of (?:the |this )?week|(?:january|february|march|april|may|june|july|august|september|october|november|december) \\d{1,2})';
const BY_DAY = new RegExp(`,?\\s*\\b(?:by|before|no later than) (${DAY})\\b`, 'gi');

/**
 * The one thing to do first, as it is said before the step; null when it says nothing one could start on, sets a day of its
 * own beside the step's, is the step itself, or has nothing to do with it (two plans are none).
 */
export function firstActionOf(
  u: Understanding,
  step: (NonNullable<TurnGuidance['step']> & { readonly standing: boolean }) | null,
  message: string,
): string | null {
  if (u.firstAction === null || step === null || step.standing) return null;
  const told = plain(message);
  const said = bare(
    u.firstAction.replace(BY_DAY, (whole, day: string) => (told.includes(day.toLowerCase()) ? whole : '')),
  );
  const count = said.split(/\s+/u).length;
  if (count < 4 || count > 28 || NOT_AN_ACTION.test(said) || said.endsWith('?')) return null;
  const own = contentStems(said);
  if (own.length < 3) return null;
  const title = new Set(contentStems(step.title));
  const parts = contentStems(
    `${step.title}. ${step.doneWhen}. ${step.items.map((i) => `${i.do} ${i.how}`).join('. ')}`,
  );
  const held = new Set(parts);
  // The step in other words.
  if (title.size > 0 && own.filter((w) => title.has(w)).length / own.length >= 0.75) return null;
  if (
    step.items.some(
      (i) =>
        new Set(contentStems(i.do)).size >= 3 &&
        [...new Set(contentStems(i.do))].every((w) => own.includes(w)),
    )
  )
    return null;
  // Of several things at once, only what the step is about.
  const shared = own.filter((w) => held.has(w)).length;
  return needsOrder(u)
    ? shared >= 2
      ? said
      : null
    : step.playId === u.stepPlayId || shared > 0
      ? said
      : null;
}
