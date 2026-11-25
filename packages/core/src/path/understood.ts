import { type Understanding, type UnderstoodReferral } from '@foundry/ai';
import { type Play, type RiskCategory, type TurnGuidance } from '@foundry/contracts';

import { asksOverview } from './kinds.js';
import { asksToStop } from './openings.js';
import { referralForRisk } from './referrals.js';
import { bare, toYou } from './tell.js';
import { type Playbook } from './types.js';
import { contentStems, countsIn, numberOf, plain } from './words.js';

/**
 * The checked reading of a message (docs/architecture/understand.md) as the turn uses it: what of it may be said at all, who
 * decides what where the rules and the reading disagree, and what stands before the step. Pure. Without a reading nothing
 * here is asked, and the rules decide as they always did. Any field of a reading may be empty.
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
  u.kind === 'privacy' ||
  (u.kind === 'pushback' && u.record.length > 0);

const is = (u: Understanding, ...kinds: readonly Understanding['kind'][]): boolean =>
  kinds.includes(u.kind) || u.also.some((k) => kinds.includes(k));

/** Whether they ask something of the work, however they feel: a message only of feelings is answered as a person, with no task. */
export const asksOfWork = (u: Understanding, message = ''): boolean =>
  (u.kind !== 'feelings' && u.kind !== 'social') ||
  is(u, 'question', 'choice', 'sum', 'result', 'next', 'draft', 'recall', 'integrity') ||
  u.secondAsk !== null ||
  asksToStop(message);

// What of it may be said ----------------------------------------------------------------------------------------------

/** Said of the conversation, the reading or the record itself, and not to them. */
const OF_THE_WORKS =
  /\b(?:the|this|your|a) (?:mentor|coach|assistant|ai|model|vEIR)\b|\bthe (?:message|reading|opening|prompt|brief|record (?:says|shows|states|line)|conversation)\b|\bthe founders?\b|\bR\d{1,2}\b/i;

/** A claim as it is said to them; '' when it is not said to them at all. */
function toThem(text: string): string {
  const said = /\bfounder\b/i.test(text) ? toYou(text) : text;
  return OF_THE_WORKS.test(said) ? '' : said.trim();
}
const orNull = (text: string | null): string | null => {
  const said = text === null ? '' : toThem(text);
  return said === '' ? null : said;
};

/** A line of the record that is the program's, or says nothing of the venture. */
const NO_FACT =
  /^you are doing this for the first time\b|\b(?:the|this|our) (?:program|programme|program['’]s|programme['’]s|playbook|method|course|module|curriculum|mentor|coach)\b|\bbusiness model canvas\b.*\bboxes\b/i;
/** Whether a line of the record is a fact of theirs. */
export const isTheirFact = (text: string): boolean => !NO_FACT.test(text);

/** What a person decides, by what is chosen between: never a pick of the mentor's. */
const DECIDED_BY: readonly (readonly [UnderstoodReferral, RegExp])[] = [
  ['immigration', /\b(?:visas?|f-?1|j-?1|h-?1b|cpt|opt (?:status|card|extension)|work permit|green card)\b/],
  [
    'equity',
    /\b(?:equity|vesting|cap table|ownership split|co-?founder shares)\b|\b(?:split|share|divide)\b.{0,24}\b(?:company|shares|stock|ownership)\b/,
  ],
  [
    'legal',
    /\b(?:llc|l\.l\.c|c-?corp\w*|s-?corp\w*|501 ?\(?c\)? ?\(?3\)?|incorporat\w*|non-?compete|indemnit\w*|sue|lawsuit)\b|\bsign(?:ing)? (?:it|this|that|the|their|her|his|an? (?:contract|lease|letter|loi|agreement|nda|form))\b|\b(?:just|do i|whether to|should i|not) sign\b(?! up)/,
  ],
  [
    'ip',
    /\b(?:patent\w*|provisional)\b|\bwho(?:m| |se)? ?(?:owns|it belongs)\b|\b(?:own|ownership of) the (?:idea|invention|code|rights|recipe|design|research)\b/,
  ],
  [
    'valuation',
    /\b(?:valuation|term sheet|convertible note|safe note)\b|\b(?:take|accept|turn down|refuse|reject) (?:the|his|her|their|an?) (?:investment|investor|check|cheque|offer for|term)\b|\bfor \d{1,2} ?(?:%|percent)/,
  ],
];

/** "70/30": two parts that make a whole. */
const isSplit = (text: string): boolean =>
  [...text.matchAll(/(?<![\d.$])(\d{1,3}) ?[/:-] ?(\d{1,3})(?![\d.])/g)].some(
    (m) => Number(m[1]) + Number(m[2]) === 100,
  );

/** Who decides what they choose between; null: it is theirs. */
function personFor(u: Understanding): UnderstoodReferral | null {
  if (u.choice === null) return null;
  const yesNo = /^(?:yes|no|not yet|neither|both)\b/i.test(bare(u.choice.pick));
  const of = plain(
    [...u.choice.options, u.choice.pick, yesNo || u.choice.options.length === 0 ? u.ask : ''].join(' . '),
  );
  return isSplit(of) ? 'equity' : (DECIDED_BY.find(([, words]) => words.test(of))?.[0] ?? null);
}

/** What changes a mind is something one can see happen: a number, or what somebody does. */
const SEEN =
  /\b(?:pay|pays|paid|buy|buys|bought|order|orders|sign|signs|say|says|said|answer|answers|refuse|refuses|reply|replies|come|comes|came|return|returns|renew|renews|cancel|cancels|leave|leaves|book|books|agree|agrees|show|shows|stop|stops|keep|keeps|ask|asks|turn|turns|tell|tells)\b/i;

function flipsOf(flips: string | null, because: string): string | null {
  const said = orNull(flips);
  if (said === null) return null;
  const own = contentStems(said);
  const held = new Set(contentStems(because));
  // The reason itself, the other way round.
  if (own.length === 0 || own.filter((w) => held.has(w)).length >= own.length * 0.7) return null;
  return /\d/.test(said) || countsIn(said).length > 0 || SEEN.test(said) ? said : null;
}

/** Whether a pick is one of the things they named, and no step of the program's in its place. */
function isTheirPick(pick: string, told: string, titles: readonly string[]): boolean {
  if (YES_NO_PICK.test(pick)) return true;
  const own = contentStems(pick);
  if (own.length === 0) return true;
  const theirs = new Set(contentStems(told));
  const shared = own.filter((w) => theirs.has(w)).length;
  if (shared === 0) return false;
  return !titles.some((t) => {
    const title = new Set(contentStems(t));
    return (
      own.length >= 3 &&
      own.filter((w) => title.has(w)).length >= own.length * 0.75 &&
      shared < own.length * 0.5
    );
  });
}

/** A letter that tells them to stop, or threatens: a lawyer reads it first. */
const LEGAL_LETTER =
  /\b(?:letter|notice|e-?mail|message)\b.{0,60}\b(?:stop (?:using|selling|calling)|cease|desist|trademark\w*|infring\w*|copyright\w*|lawyers?|attorney|legal action|sue|lawsuit|violat\w*)\b|\b(?:lawyers?|attorney)\b.{0,30}\b(?:letter|notice|wrote|sent|emailed)\b|\bcease and desist\b/i;
export const tellsLegalLetter = (message: string): boolean => LEGAL_LETTER.test(plain(message));

/** They choose between things of their own, or ask yes or no: what they only tell is no choice to make for them. */
function asksToChoose(choice: NonNullable<Understanding['choice']>, told: string): boolean {
  if (YES_NO_PICK.test(choice.pick.trim()) || choice.options.length < 2) return true;
  const wordsOf = (text: string): string[] =>
    (plain(text).match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !BARE_WORDS.has(w));
  const theirs = new Set([...wordsOf(told), ...contentStems(told)]);
  const named = choice.options.filter((o) => {
    const others = new Set(choice.options.filter((x) => x !== o).flatMap(wordsOf));
    return wordsOf(o).some(
      (w) => !others.has(w) && (theirs.has(w) || contentStems(w).some((x) => theirs.has(x))),
    );
  });
  return named.length >= 2;
}
const BARE_WORDS = new Set(
  'a an the to of for in on at it is and or we i you they my our your do does be then'.split(' '),
);
const YES_NO_PICK = /^(?:yes|no|not yet|neither|both|wait|stop|pause)\b/i;

/**
 * A reading as the reply may rest on it: what is not said to them goes, a line of the program's is no fact of theirs, what a
 * person decides is nobody's pick (and who decides is then found), and a pick is one of theirs.
 */
export function settled(
  u: Understanding,
  about: {
    readonly message: string;
    readonly earlier: readonly string[];
    readonly titles: readonly string[];
  },
): Understanding {
  const person = personFor(u);
  const choice =
    u.choice === null || person !== null
      ? null
      : {
          ...u.choice,
          pick: toThem(u.choice.pick),
          because: toThem(u.choice.because),
          flipsIf: flipsOf(u.choice.flipsIf, u.choice.because),
        };
  const told = [about.message, ...about.earlier].join('. ');
  const result =
    u.result === null
      ? null
      : {
          ...u.result,
          shows: toThem(u.result.shows),
          doesNotShow: orNull(u.result.doesNotShow),
          settles: orNull(u.result.settles),
        };
  const why = u.contradicts === null ? '' : toThem(u.contradicts.why);
  return {
    ...u,
    ask: u.ask.trim(),
    record: u.record.filter((r) => isTheirFact(r.text)),
    contradicts:
      u.contradicts === null || !isTheirFact(u.contradicts.line.text) ? null : { ...u.contradicts, why },
    missing: orNull(u.missing),
    choice:
      choice === null ||
      choice.pick === '' ||
      !isTheirPick(bare(choice.pick), told, about.titles) ||
      !asksToChoose(choice, told)
        ? null
        : choice,
    result: result === null || (result.shows === '' && result.doesNotShow === null) ? null : result,
    referral:
      u.referral !== null && !(person !== null && u.referral === 'grants')
        ? u.referral
        : (person ?? (tellsLegalLetter(about.message) ? 'legal' : u.referral)),
    points: u.points.map(toThem).filter((p) => p !== ''),
    firstAction: orNull(u.firstAction),
    avoid: u.avoid,
  };
}

/** Several things happened, or they do not know where to start: what there is to say is said in order, whatever else. */
export const needsOrder = (u: Understanding): boolean =>
  (u.points.length >= 2 && is(u, 'feelings') && is(u, 'next', 'update', 'result')) ||
  (u.points.length >= 3 && is(u, 'next') && is(u, 'update', 'result'));

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
  const choices = [u.ask, ...(u.choice?.options ?? [])].join('. ');
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
  if (category === undefined) return null;
  // By what they ask; a word in passing ("a cousin is an accountant") says less.
  const asked = referralForRisk(playbook, [category], choices)?.playId;
  const plainly = asked !== referralForRisk(playbook, [category], '')?.playId;
  return byId(plainly ? asked : referralForRisk(playbook, [category], message)?.playId);
}

// What stands before the step ---------------------------------------------------------------------------------------

const NOT_AN_ACTION =
  /^(?:you|i|we|they|it|this|that|the|an?|your|consider|think|reflect|focus|continue|keep going|keep doing|explore|be|try to|aim|remember|understand|evaluate|assess|decide|plan|prepare|stay|feel|make sure|ensure|wait)\b/i;
const DAY =
  '(?:(?:next |this )?(?:mon|tues|wednes|thurs|fri|satur|sun)day|today|tonight|tomorrow|(?:the )?end of (?:the |this )?week|(?:january|february|march|april|may|june|july|august|september|october|november|december) \\d{1,2})';
const BY_DAY = new RegExp(`,?\\s*\\b(?:by|before|no later than) (${DAY})\\b`, 'gi');

/** A sentence of the program's method put in for a question about the future: it says nothing of this ask. */
const FROM_THE_TABLE =
  /\bwhat (?:they|he|she) spent on (?:this|it) last time\b|\bwhen (?:they|he|she) last (?:dealt with|had|did) (?:it|this)\b/i;
/** Asking what somebody would do, pay or like. */
const OF_THE_FUTURE =
  /\bwhat (?:they|he|she|people) would (?:pay|do|like|want|use)\b|\b(?:whether|if) (?:they|he|she|people) would\b/i;
const OF_THE_PERSON =
  /\b(?:lawyers?|attorney|accountant|eir|entrepreneur in residence|program lead|ur ventures|technology transfer|international services|iso|regulatory specialist|specialist|counsel(?:or|ing)?)\b/i;
const MAIN_WORDS = 9;

/** What they themselves propose to do, in stems. */
const proposedIn = (message: string): ReadonlySet<string> => {
  const said =
    /\b(?:i['’]?d rather|i(?:['’]?m| am) (?:going to|gonna|thinking (?:of|about))|i(?:['’]?ll| will)|we(?:['’]?ll| will)|i want to|can i|should i|so i['’]?ll)\b([^.?!]+)/i.exec(
      message,
    )?.[1];
  return new Set(contentStems(said ?? ''));
};

/** One thing one could start on, said so it can be read aloud. */
export function actionSaid(text: string, message: string): string {
  const told = plain(message);
  return (
    bare(text.replace(BY_DAY, (whole, day: string) => (told.includes(day.toLowerCase()) ? whole : '')))
      // "Call Ada and ask them what …": one person is no "them".
      .replace(
        /\b(ask) (?:them|him|her|he|she) (?=(?:what|how|when|whether|why|if|which|who|where)\b)/gi,
        '$1 ',
      )
  );
}

/**
 * The one thing to do first, as it is said before the step; null when it says nothing one could start on, sets a day of its
 * own beside the step's, is the step itself, has nothing to do with the ask or the step, is who decides once more, or goes
 * against what the reply answers (two plans are none; none is better than a wrong one).
 */
export function firstActionOf(
  u: Understanding,
  step: (NonNullable<TurnGuidance['step']> & { readonly standing: boolean }) | null,
  message: string,
  beside: {
    /** What the reply opens with, and which opening that is. */
    readonly lead?: string;
    readonly opened?: string | null;
    readonly used?: boolean;
    readonly referral?: Play['referral'];
  } = {},
): string | null {
  if (u.firstAction === null || step === null || beside.used === true) return null;
  const said = actionSaid(u.firstAction, message);
  const count = said.split(/\s+/u).length;
  if (count < 4 || count > 28 || NOT_AN_ACTION.test(said) || said.endsWith('?')) return null;
  if (FROM_THE_TABLE.test(said) || OF_THE_FUTURE.test(said)) return null;
  const own = contentStems(said);
  if (own.length < 3) return null;
  // Who decides is said once in the reply, with what to bring.
  const main = said.split(/\s+/u).slice(0, MAIN_WORDS).join(' ');
  if (beside.referral != null && OF_THE_PERSON.test(main)) return null;
  // Nothing to sign, take or send for what a person decides first.
  if (u.referral !== null && /^(?:sign|accept|take the|agree|send (?:it|the) (?:signed|offer))\b/i.test(said))
    return null;
  // What the opening speaks against, or leaves open, is no first thing to do.
  const proposed = proposedIn(message);
  const against =
    beside.opened === 'contradiction' || beside.opened === 'pushback' || beside.opened === 'held';
  if (
    against &&
    proposed.size >= 2 &&
    own.filter((w) => proposed.has(w)).length >= Math.min(3, proposed.size * 0.6)
  )
    return null;
  if (u.choice !== null) {
    const pick = new Set(contentStems(u.choice.pick));
    const others = new Set(
      u.choice.options
        .filter((o) => contentStems(o).filter((w) => pick.has(w)).length < contentStems(o).length * 0.6)
        .flatMap((o) => contentStems(o))
        .filter((w) => !pick.has(w)),
    );
    if (own.some((w) => others.has(w)) && !own.some((w) => pick.has(w))) return null;
    // A pick of giving it away for now is no ask for money.
    if (FREE.test(u.choice.pick) && MONEY_ASKED.test(said)) return null;
  }
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
  // The same thing with another number is a second plan.
  const numbers = (t: string): number[] => [
    ...(t.match(/(?<![\d.$])\d{1,4}(?![\d.]*%)/g) ?? []).map(Number),
    ...contentStems(t).flatMap((w) => numberOf(w) ?? []),
  ];
  const ofStep = numbers(`${step.title} ${step.doneWhen}`);
  const ofOwn = numbers(said);
  const subjects = subjectsOf(said);
  const sharedTitle = subjects.filter((w) => title.has(w)).length;
  if (ofOwn.length > 0 && ofStep.length > 0 && sharedTitle >= 1 && !ofOwn.some((n) => ofStep.includes(n)))
    return null;
  // Said already, by what opens.
  const lead = new Set(contentStems(beside.lead ?? ''));
  if (lead.size > 0 && own.filter((w) => lead.has(w)).length >= own.length * 0.85) return null;
  // About what they ask: their own words, or the answer's.
  const asked = new Set(
    contentStems(
      [message, u.ask, u.secondAsk ?? '', ...u.points, u.choice?.pick ?? '', u.result?.settles ?? ''].join(
        '. ',
      ),
    ),
  );
  const about = own.filter((w) => asked.has(w) && numberOf(w) === null && !/^\d+$/.test(w)).length;
  if (about === 0) return null;
  // Of several things at once, only what the step is about, or the one that comes first.
  const shared = own.filter((w) => held.has(w)).length;
  if (needsOrder(u)) {
    const first = new Set(contentStems(u.points[0] ?? ''));
    return shared >= 2 || own.filter((w) => first.has(w)).length >= 2 ? said : null;
  }
  // What opens is what they can say or do now, or the step only stands: it need not be about it.
  if (about >= 2 && (step.standing || SAYS_NOW.has(beside.opened ?? ''))) return said;
  const stepText = `${step.title}. ${step.doneWhen}`;
  const belongs =
    subjects.some((w) => held.has(w)) || SUBJECT_GROUPS.some((g) => g.test(stepText) && g.test(said));
  return belongs ? said : null;
}
const SAYS_NOW: ReadonlySet<string> = new Set(['held', 'contradiction', 'integrity', 'quit', 'pushback']);
const FREE = /\b(?:free|for nothing|not? charge|no price|charge (?:later|nothing))\b/i;
const MONEY_ASKED = /\b(?:pay|charge|price|buy|order|deposit|money|\$ ?\d|dollars?)\b/i;

// Which step fits ----------------------------------------------------------------------------------------------------

/** Words a step and an ask share whatever either is about. */
const OF_ANY_STEP = new Set(
  contentStems(
    'write list ask people person sentence one next first number try run test make get week day find put give choose choice name start step pass line done show tell know want need thing way work good bad right now say plan idea venture customer student question answer thing part send back own word use little come',
  ),
);
/** Different words for one subject. */
const SUBJECT_GROUPS: readonly RegExp[] = [
  /\b(?:pay|pays|paid|paying|price|prices|priced|pricing|charge[sd]?|charging|fee|free|cheap|expensive|costs?)\b|\$/i,
  /\b(?:sell(?:ing)? to|stock(?:ed|s)?|shelf|shelves|pilots?|companies|company|clients?|shops?|stores?|restaurants?)\b/i,
  /\b(?:interview\w*|talks?|talked|talking|conversation\w*|meet|meeting|met with)\b/i,
  /\b(?:left|leave|leaving|leavers|churn\w*|stayed|stay|retention|came back|come back)\b/i,
  /\b(?:share|shares|split|equity|co-?founders?|partner|50 ?\/ ?50)\b/i,
  /\b(?:investor|invest\w*|valuation|worth|angel|stake|terms?|raise|raising|round)\b/i,
  /\b(?:cash|runway|burn\w*|run out|hit zero|months? left|money lasts?)\b/i,
  /\b(?:quit|stop|stopping|pause|close|shut|give up|go on|continue)\b/i,
  /\b(?:hand ?over|handover|take over|takes? it over|pass it on|hand it|take it over)\b/i,
  /\b(?:visa|f-?1|immigration|international)\b/i,
  /\b(?:patent|invention|lab|license|licence|ip)\b/i,
  /\b(?:canvas|boxes|module|class|assignment|capstone|financials?)\b/i,
  /\b(?:letter of intent|loi|contract|agreement|sign)\b/i,
  /\b(?:claim|fda|medical|health|patients?|clinical|device)\b/i,
  /\b(?:costs?|margin|break.?even|earned? back|profit|left over|money in|kept|keep)\b/i,
];

const subjectsOf = (text: string): string[] =>
  contentStems(text).filter((w) => !OF_ANY_STEP.has(w) && numberOf(w) === null && !/^\d+$/.test(w));

/** What they ask and what it is answered with, in words; with the message when that says little of it. */
export function askedOf(u: Understanding, message: string): string {
  const read = [
    u.ask,
    u.secondAsk ?? '',
    ...u.points,
    u.choice === null ? '' : `${u.choice.pick}. ${u.choice.because}`,
    u.result?.settles ?? '',
  ].join('. ');
  // "How do I use an evening before she comes?": what there is to do is in the message.
  return subjectsOf(read).length >= 2 && u.kind !== 'next' ? read : `${read}. ${message}`;
}

/** Whether a play's step is about what they ask: its title, or the play's own name, and theirs share a subject. */
export function fitsAsk(
  play: {
    readonly title: string;
    readonly doneWhen: string;
    readonly id?: string;
    readonly playId?: string | null;
  },
  asked: string,
): boolean {
  const said = new Set(subjectsOf(asked));
  const name = (play.playId ?? play.id ?? '').replace(/[^a-z-]/g, '').replace(/-/g, ' ');
  const title = `${play.title}. ${play.doneWhen}`;
  if (subjectsOf(`${play.title}. ${name}`).some((w) => said.has(w))) return true;
  return SUBJECT_GROUPS.some((g) => g.test(title) && g.test(asked));
}

/** Whether what they ask is about the step they are on: its title, what done means or its parts share a subject with it. */
export function sameSubject(
  view: {
    readonly title: string;
    readonly doneWhen: string;
    readonly items: readonly { readonly do: string }[];
  },
  asked: string,
): boolean {
  const about = new Set(
    subjectsOf(`${view.title}. ${view.doneWhen}. ${view.items.map((i) => i.do).join('. ')}`),
  );
  return subjectsOf(asked).some((w) => about.has(w));
}

/** Either-or on the product, the place or the day, and not on the price: what tests it is a small try of the pick. */
export function testsAPick(u: Understanding): boolean {
  if (u.choice === null || u.choice.options.length < 2) return false;
  const of = [...u.choice.options, u.choice.pick].join('. ');
  return !MONEY_ASKED.test(of) && !FREE.test(of);
}
/** Giving it to somebody else to run. */
const HANDS_ON =
  /\b(?:hand(?:ing)? (?:it|this|them|that|the \w+)(?: \w+)? (?:over|on|off|to)|hand ?over|take (?:it|them|this|the \w+) over|pass(?:ing)? it on|give it to)\b/i;
export const handsOn = (u: Understanding): boolean => u.choice !== null && HANDS_ON.test(u.choice.pick);

/** A step that asks for money, where the pick is not to ask for it yet. */
export const picksAgainst = (u: Understanding, play: Pick<Play, 'title'>): boolean =>
  u.choice !== null && FREE.test(u.choice.pick) && MONEY_ASKED.test(play.title);

/** Whether a line of the record is about what they ask: they share a subject. */
export function bearsOn(text: string, asked: string): boolean {
  const said = new Set(subjectsOf(asked));
  return (
    subjectsOf(text).some((w) => said.has(w)) || SUBJECT_GROUPS.some((g) => g.test(text) && g.test(asked))
  );
}
