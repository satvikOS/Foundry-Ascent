import {
  termsIn,
  withFitted,
  withMeanings,
  type Fitted,
  type PromptContinuity,
  type Understanding,
} from '@foundry/ai';
import { type EvidenceItem, type Play, type TurnGuidance } from '@foundry/contracts';
import { type pathRepo } from '@foundry/db';

import { saysStanding, type PathPromptGuidance } from './ai-adapter.js';
import { ofAnotherBusiness, otherBusinessesIn } from './other-business.js';
import {
  arcOf,
  briefOf,
  dayOf,
  firstSentence,
  isReference,
  standingDecisions,
  type BriefSource,
} from './brief.js';
import { addDays, daySaid, sayDue, sayPast } from './dates.js';
import { worthAsked } from './asked-sums.js';
import { deniedGrowth } from './denied.js';
import {
  concreteFact,
  decide,
  readingFor,
  evidencePlayOf,
  guidanceOf,
  HOW_FOLLOW_UP,
  inTheirVoice,
  type AppliedPivot,
  type DecideInput,
  type Decision,
} from './engine.js';
import {
  asksIfPriceRight,
  hourlyBefore,
  hourlyOf,
  money,
  percent,
  quantitiesIn,
  saidNumbers,
} from './calc.js';
import { heardRight, type Heard } from './heard.js';
import { priceChange } from './price-change.js';
import {
  asksFor,
  asksIfNeeded,
  asksIfNo,
  asksIfWorth,
  asksIn,
  asksMeaning,
  asksOneThing,
  asksOverview,
  asksRecall,
  asksWhatTold,
  isVenting,
  limitsIn,
  partAsked,
  statedIdea,
  timeSaid,
} from './kinds.js';
import { doneWhenOf, playOf, type ChosenStep } from './steps.js';
import { toldCounts } from './told-counts.js';
import { meaningWords, phraseIntent, pointsBack, refersBack } from './match.js';
import { ratesOf } from './choice.js';
import {
  asksIfGood,
  DEAR_BUT_BOUGHT,
  lastResult,
  newsOf,
  readAgain,
  readFurther,
  readMeaning,
  readResult,
  friendsPraise,
} from './news.js';
import { CRITERION_COUNTED, CRITERION_NAMES, STAGE_DOING } from './playbook/phrases.js';
import {
  JUDGEMENT_PLAYS,
  gapFor,
  holdsAnswer,
  personalAnswer,
  problemIn,
  readingOf,
  saysMost,
  type AnswerSource,
  type PersonalAnswer,
  type Reading,
} from './reading.js';
import {
  bare,
  currentOnes,
  dated,
  distinct,
  factsFor,
  ideaNamed,
  ideaSaid,
  informative,
  listed,
  lowerFirst,
  pivotSaid,
  priorFact,
  sameThing,
  storyLines,
  toYou,
  told,
  toldAs,
  upperFirst,
  type PriorSource,
} from './tell.js';
import { meIn, todayIn, whoIn } from './stated.js';
import { type Playbook } from './types.js';
import { milestoneReached, progressIn, wordsOfEvidence } from './state.js';
import {
  asksRuling,
  asksToStop,
  byUrgency,
  contradictionSaid,
  inConfidence,
  isItSaid,
  KEPT_SAID,
  listPick,
  offerSaid,
  openingOf,
  recallSaid,
  seeksPraise,
  sumOfReading,
  type Opening,
} from './openings.js';
import { readsOutcome } from './outcome.js';
import { offersForShares } from './referrals.js';
import { sumSaid } from './sum-said.js';
import {
  askedOf,
  asksForText,
  decides,
  fitsAsk,
  needsOrder,
  NOTHING,
  picksAgainst,
  referralPlayOf,
  sameSubject,
  tellsLegalLetter,
} from './understood.js';
import { contentStems, countsIn, numberOf, plain } from './words.js';

/** The path of one turn: what was decided, what is kept with the turn, and what the prompt is given. */
export interface PathTurn {
  readonly decision: Decision;
  readonly guidance: TurnGuidance | null;
  readonly prompt: PathPromptGuidance;
}

export interface PathTurnInput extends Omit<DecideInput, 'recordText' | 'background'> {
  readonly continuity: PromptContinuity;
  /** The founder's earlier messages in view. */
  readonly earlierMessages: readonly string[];
  /** The coach's earlier replies in view, oldest first. */
  readonly earlierReplies?: readonly string[];
  /** A call's words are read for what it heard badly (heard.ts). Absent: typed. */
  readonly channel?: 'text' | 'voice';
  /** What the message asks, read against the record and checked (docs/architecture/understand.md). Null or absent: not read. */
  readonly understanding?: Understanding | null;
}

function briefSource(input: PathTurnInput, decision: Decision): BriefSource {
  const { continuity } = input;
  const notebook = continuity.notebook ?? null;
  return {
    today: input.today,
    venture: input.venture,
    // As it reads after this turn: the idea just told, the direction just changed, the work just reported.
    reads: readsAfter(input, decision),
    profile: continuity.studentProfile ?? null,
    notebook:
      notebook === null
        ? null
        : { founderProfile: notebook.founderProfile, commitments: notebook.commitments },
    digests: (continuity.recentDigests ?? []).map((d) => ({
      sessionId: d.sessionId ?? '',
      date: d.date,
      title: d.title ?? null,
      summary: d.digest.summary,
    })),
  };
}

/** What the turn changes of the record, for what the prompt says of it. */
function readsAfter(input: PathTurnInput, decision: Decision): pathRepo.PathReads {
  const reads = decision.applied?.reads ?? input.reads;
  const idea = decision.pivot?.idea ?? decision.idea;
  if (idea === null) return reads;
  const path: pathRepo.PathRecord = {
    ventureId: input.ventureId,
    stage: decision.state.stage,
    intakeBy: null,
    pivots: [],
    playbookVersion: input.playbook.version,
    version: 1,
    ...reads.path,
    intake: { ...EMPTY_INTAKE, ...reads.path?.intake, idea },
  };
  return {
    ...reads,
    path:
      decision.pivot === null
        ? path
        : {
            ...path,
            pivots: [
              ...path.pivots,
              { on: input.today, from: decision.pivot.from, to: decision.pivot.to, sessionId: null },
            ],
          },
  };
}

const EMPTY_INTAKE = {
  idea: '',
  customer: '',
  studies: '',
  experience: null,
  hoursPerWeek: null,
  deadline: null,
  doneSoFar: '',
  block: '',
};

/** What a call heard, with the venture's own words in it as they are said (heard.ts); typed, the message as it is. */
function heardIn(input: PathTurnInput): { readonly message: string; readonly changes: Heard['changes'] } {
  if (input.channel !== 'voice') return { message: input.message, changes: [] };
  const intake = input.reads.path?.intake ?? null;
  const { text, changes } = heardRight(
    input.message,
    [input.venture.name].filter((n) => !/^new venture\b/i.test(n)),
    [input.venture.oneLiner, input.venture.currentGoal ?? '', intake?.idea ?? '', intake?.customer ?? ''],
  );
  return { message: text, changes };
}

/** Decides the turn and builds what its prompt and its record carry. Pure, like the engine. */
export function pathTurn(typed: PathTurnInput): PathTurn {
  const heard = heardIn(typed);
  const input: PathTurnInput = heard.message === typed.message ? typed : { ...typed, message: heard.message };
  const { continuity, playbook } = input;
  const notebook = continuity.notebook ?? null;
  const decision = decided(input, {
    ...input,
    recordText: [
      notebook?.summary ?? '',
      ...(notebook?.commitments ?? []).map((c) => c.text),
      ...(continuity.recentDigests ?? []).flatMap((d) => [d.digest.summary, ...d.digest.topics]),
    ].join('. '),
    background: [
      ...input.earlierMessages,
      continuity.studentProfile?.background ?? '',
      ...(notebook?.founderProfile ?? []).map((e) => e.text),
    ],
  });
  const prompt = promptOf(input, decision);
  return {
    decision,
    guidance: guidanceOf(playbook, decision),
    prompt: heard.changes.length === 0 ? prompt : { ...prompt, heard: heard.changes },
  };
}

/** The figure they ask for beside what a rule answers, as it is said. */
function besideSaid(input: PathTurnInput, decision: Decision): Lead | null {
  return decision.beside === null
    ? null
    : sumSaid(decision.beside, { texts: [input.message], replies: input.earlierReplies ?? [] });
}
function withFigure(input: PathTurnInput, decision: Decision, lead: Lead | null): Lead | null {
  const figure = besideSaid(input, decision);
  if (figure === null || lead?.text.includes(decision.beside?.said ?? '-') === true) return lead;
  return lead === null
    ? { text: figure.text, voice: figure.voice }
    : { text: joined(lead.text, figure.text), voice: joined(firstSentence(lead.voice), figure.voice) };
}

/** Rules that answer with what they hold for any such ask. */
const GENERIC_RULES: ReadonlySet<string> = new Set(['fills', 'overview', 'support', 'offer', 'phrase']);

/**
 * The rule that read the message, with no reading: null where none did, or only words or meanings near a play's (then the
 * reading decides). A report that finished nothing, and whose answer is the model's, read nothing.
 */
export function firedRule(input: PathTurnInput, decision: Decision): string | null {
  const { kind, calc, news } = decision;
  if (kind === 'social' || kind === 'rehearsal' || kind === 'crisis' || kind === 'new_idea') return kind;
  if (decision.pivot !== null) return 'pivot';
  if (kind === 'recall') return 'recall';
  if (decision.smaller !== null) return 'smaller';
  if (decision.commitment !== null && decision.step?.view.origin === 'founder') return 'commitment';
  if (decision.report?.state === 'not_yet') return 'not_yet';
  if (decision.restates !== null) return 'restates';
  if (decision.message) return 'message';
  if (decision.whenDone) return 'when_done';
  if (decision.howTo) return 'how_to';
  if (decision.pushes) return 'pushes';
  if (deniedLead(input, decision) !== null) return 'denied';
  if (decision.result !== null) return 'result';
  if (decision.choice !== null && decision.choice.pick !== null) return 'choice';
  if (calc.ask !== null && calc.lines.length > 0) return 'sum';
  // A figure with no sum of the rules': whoever reads more of the message has the rest of it.
  if (figureAsked(input) !== null) return null;
  const personal = personalOf(input, decision);
  const lead = leadOf(input, decision, startOf(input, decision), personal);
  if (news !== null && lead?.text.startsWith(news.means.slice(0, 40)) === true) return 'news';
  if (kind === 'report') return lead === null ? null : 'report';
  const own = kind === 'coaching' ? ownLead(input, decision) : null;
  if (own !== null) return own.name;
  if (decision.rejects) return 'rejects';
  if (decision.step === null) return 'support';
  if (decision.fills) return 'fills';
  if (decision.overview) return 'overview';
  if (startOf(input, decision) !== null) return 'start';
  if (personal?.opens === true) return 'personal';
  return decision.matched === 'phrase' ? 'phrase' : null;
}

/** Plays whose friends and family said it, and a claim of growth or of proof. */
const CLOSE_TO_THEM =
  /\b(?:my|our) (?:\w+ )?(?:friends?|family|mom|mum|mother|dad|father|parents|sister|brother|roommates?|floor|dorm|classmates?|buddies|buddy|teammates?)\b/i;
const CLAIMS_PROOF = /\b(?:gr(?:ow|ew|owth|owing|own)\w*|steady|prove[sdn]?|proof|traction|validated)\b/i;
const NOT_CUSTOMERS = /\bnot (?:(?:your|the|real|paying) )*(?:customers?|buyers?|users?)\b/i;
/** Rules that take what they count for a result. */
const COUNTS_A_RESULT: ReadonlySet<string> = new Set(['news', 'report', 'result']);

/** The rule counted as proof what the people who said it, or the record, deny: friends, no customers, a growth that fell. */
function countsWrong(input: PathTurnInput, fired: string, u: Understanding): boolean {
  const { result } = u;
  if (!COUNTS_A_RESULT.has(fired)) return GENERIC_RULES.has(fired) && u.contradicts !== null;
  if (u.contradicts !== null && CLAIMS_PROOF.test(input.message)) return true;
  if (result === null || !/^(?:weak|bad|too_early)$/.test(result.verdict)) return false;
  return (
    (CLOSE_TO_THEM.test(input.message) && friendsPraise(input.message) === null) ||
    NOT_CUSTOMERS.test(`${result.shows} ${result.doesNotShow ?? ''}`)
  );
}

/** What the reading holds that a general answer of the rules lacks. */
function readsMoreThan(input: PathTurnInput, rule: Decision, u: Understanding): boolean {
  const overviewOnly = sentencesOf(input.message).every((s) => !asksFor(s) || asksOverview(s));
  return (
    (rule.calc.lines.length === 0 && u.sums.some((s) => s.asked)) ||
    u.choice !== null ||
    (u.kind === 'choice' && u.stepPlayId !== null && u.stepPlayId !== rule.play?.id && !rule.overview) ||
    (u.result !== null &&
      readsOutcome(input.message, input.earlierMessages) &&
      rule.result === null &&
      rule.news === null) ||
    u.contradicts !== null ||
    (u.referral !== null && (rule.referral === null || offersForShares(input.message))) ||
    u.kind === 'integrity' ||
    asksToStop(input.message) ||
    needsOrder(u) ||
    (rule.overview && (!overviewOnly || u.secondAsk !== null)) ||
    // What they tell beside "what now?", which the whole path does not answer.
    (rule.overview &&
      rule.news === null &&
      (rule.report !== null || readsOutcome(input.message, [])) &&
      u.points.length >= 2 &&
      [u.kind, ...u.also].includes('update'))
  );
}

/** Rules that read the message as one kind of thing: news, a report, a result, a text of the program's, a smaller step. */
const READS_ONE_KIND: ReadonlySet<string> = new Set([
  'news',
  'report',
  'result',
  'message',
  'fills',
  'restates',
  'how_to',
  'smaller',
]);
/** Of those, the rules that write a text of the program's in place of theirs. */
const WRITES_TEXT: ReadonlySet<string> = new Set(['message', 'restates', 'fills', 'how_to']);
/** Something gone wrong with somebody they serve. */
const COMPLAINT =
  /\b(?:angry|upset|furious|annoyed|disappointed|complain\w*|refund\w*|(?:is|are|was|were|got) mad|responsible for this|fell|hurt|injur\w*|broken|damaged)\b/i;
/** News beside what they ask: somebody did or said something new. */
const NEWS_TOLD =
  /\b(?:said no|says no|turned (?:us|me) down|phoned|called|rang|emailed|texted|wrote back|offered|wants|asked (?:me|us|for)|ordered|cancel\w*|paid|left)\b/i;

/**
 * The rule read the message as another kind of thing than it is: words to send beside news, how they feel, made-up work, or
 * a complaint read as a result (a choice read as news stays the rule's: the tuned turns read it right). The reading decides those; every other rule keeps its turn.
 */
function misreads(fired: string, u: Understanding, message: string): boolean {
  if (!READS_ONE_KIND.has(fired)) return false;
  const news = NEWS_TOLD.test(message) || COMPLAINT.test(message);
  if (u.kind === 'draft' || u.also.includes('draft')) return !WRITES_TEXT.has(fired) || news;
  if (u.kind === 'feelings' || u.kind === 'integrity') return true;
  return COMPLAINT.test(message) && COUNTS_A_RESULT.has(fired);
}

/** The turn as it is decided: by the rule that read the message precisely, as with no reading, or by the reading. */
function decided(input: PathTurnInput, source: DecideInput): Decision {
  const u = readingFor(source);
  if (u === null) return decide(source);
  const rule = decide({ ...source, understanding: null });
  const fired = firedRule(input, rule);
  // What reads as a push and is a question of its own is the reading's.
  const asksOwn = fired === 'pushes' && !['pushback', 'privacy', 'feelings'].includes(u.kind);
  if (fired === null || asksOwn || misreads(fired, u, input.message)) return decide(source);
  const generic = GENERIC_RULES.has(fired);
  // Too much at once is taken in order; a recall with another ask in it is no recall alone.
  const loose =
    generic ||
    (fired !== 'pivot' && needsOrder(u) && u.also.concat(u.kind).includes('feelings')) ||
    // A figure is asked for, and the rule has none.
    (u.kind === 'sum' &&
      u.sums.some((s) => s.asked) &&
      rule.calc.lines.length === 0 &&
      !TAKES_A_SUM.has(fired) &&
      !['pivot', 'new_idea', 'restates', 'smaller'].includes(fired)) ||
    (fired === 'recall' &&
      u.kind !== 'recall' &&
      (!asksRecall(input.message) || u.choice !== null || u.contradicts !== null || u.kind === 'integrity'));
  const by = decides('answer', {
    ...NOTHING,
    precise: !loose,
    generic: loose,
    adds: readsMoreThan(input, rule, u),
    conflict: countsWrong(input, fired, u),
  });
  if (by === 'reading') return decide(source);
  const asked = u.sums.find((s) => s.asked) ?? null;
  const ruled = asksRuling(u, input.message) ? referralPlayOf(input.playbook, u, input.message) : null;
  return {
    ...rule,
    fired,
    // What never hurts: who decides, and a figure they ask for, where the rule has none.
    referral: rule.referral ?? ruled?.referral ?? null,
    beside: rule.calc.lines.length > 0 || rule.step === null || !TAKES_A_SUM.has(fired) ? null : asked,
    decidedBy: BY_RULE,
  };
}
/** Rules a figure may stand beside. */
const TAKES_A_SUM: ReadonlySet<string> = new Set([
  'recall',
  'report',
  'not_yet',
  'commitment',
  'price_change',
]);
const BY_RULE: NonNullable<Decision['decidedBy']> = {
  answer: 'rule',
  kind: 'rule',
  recall: 'rule',
  play: 'rule',
  step: 'rule',
  referral: 'rule',
  sum: 'rule',
  choice: 'rule',
  lead: 'rule',
};

/** A sum of numbers they told that nobody could work out: what is needed, never the step's parts in its place. */
const NO_FIGURE: NonNullable<PathPromptGuidance['fallback']> = {
  text: 'I will not guess that number. Write me each amount that goes into it on its own line, with what it is for, and I work it out with you.',
  voice: 'I will not guess that number. Tell me each amount that goes into it, and what it is for.',
};

/** "… help?" at the end of what they tell. */
const BARE_HELP = /[,.!;:\s]+(?:(?:please|pls|can you|could you)\s+)?help(?:\s+me)?(?:\s+please)?\s*[?.!]*$/i;
/** Words of its own a follow-up has at most ("just give me your best estimate"). */
const FOLLOW_UP_WORDS = 3;

/** How what they asked was found, as the prompt and the reply contract take it: what is only near it may be set aside. */
function matchedOf(
  decision: Decision,
  asked: Ask,
  answered: boolean,
): NonNullable<PathPromptGuidance['matched']> {
  if (decision.matched === 'semantic' || decision.matched === 'lexical') return 'semantic';
  // The program's answer is background to what was read, but for what is never shared.
  if (decision.reading !== null && !isHeld(decision) && asked !== null) return 'semantic';
  if (decision.kind === 'recall') return 'phrase';
  return decision.matched === null && asked === null && !answered ? 'none' : 'phrase';
}

/** What is never shared is asked for. */
const isHeld = (decision: Decision): boolean => decision.play?.id === 'other-teams-privacy';

/**
 * What the step is to a reply that answers with nothing of the program's: absent when it is about what they asked (they
 * share a word that says something, or the message points back at it), else what stands on their path, said as that. It is
 * said on every turn that coaches: they never have to ask what comes next.
 */
const ASKS_WHAT_DECIDES = /\bnumbers?\b|\bwhat (?:result|would)\b|\bchange (?:your|my) mind\b|\bprove\b/i;
function stepRoleOf(
  input: PathTurnInput,
  decision: Decision,
  matched: PathPromptGuidance['matched'],
): PathPromptGuidance['stepRole'] {
  const { step } = decision;
  const u = decision.reading;
  if ((decision.kind !== 'coaching' && (u === null || decision.kind !== 'news')) || step === null)
    return undefined;
  const standing = saysStanding((input.earlierReplies ?? []).at(-1) ?? '') ? 'quiet' : 'standing';
  if (u !== null) {
    // Chosen for what they ask, or about it; else it only stands on their path.
    const asked = askedOf(u, input.message);
    const named = step.view.playId === u.stepPlayId || step.view.playId === decision.play?.id;
    const chosen =
      decision.offered ||
      decision.decidedBy?.step === 'rule' ||
      (named && (decision.referral !== null || u.kind === 'integrity' || fitsAsk(step.view, asked))) ||
      (step.view.playId === u.stepPlayId && u.kind === 'result');
    // They ask for it, or about it.
    if (
      decision.overview ||
      decision.intent === 'what-next' ||
      (decision.carried && pointsBack(input.message))
    )
      return undefined;
    if (picksAgainst(u, step.view) && !decision.offered) return standing;
    return chosen ||
      sameSubject(step.view, asked) ||
      (ASKS_WHAT_DECIDES.test(input.message) && fitsAsk(step.view, u.points.join('. ')))
      ? undefined
      : standing;
  }
  // They tell how hard it is: the step is only what stands.
  if (decision.vents || isVenting(input.message)) return 'standing';
  if (matched !== 'none' || decision.offered) return undefined;
  // They tell, and ask nothing but help: what comes next is the step.
  if (decision.idea !== null) return undefined;
  const asks = input.message.replace(BARE_HELP, '.');
  if (!asksFor(asks) && !pointsBack(input.message)) return undefined;
  // A follow-up is about what was just said, in few words of its own or pointing back at it.
  if (decision.carried && (refersBack(input.message) || meaningWords(input.message) <= FOLLOW_UP_WORDS))
    return undefined;
  // "Two lifts" and "two pilots" share nothing.
  const stems = (text: string): string[] =>
    contentStems(text).filter((w) => numberOf(w) === null && !/^\d+$/.test(w));
  const about = new Set(
    stems(`${step.view.title}. ${step.view.doneWhen}. ${step.view.items.map((i) => i.do).join('. ')}`),
  );
  // What the step was given for is what they go on about ("unit economics for one box", "at forty boxes a month?").
  if (decision.carried) for (const w of stems(input.earlierMessages.at(-1) ?? '')) about.add(w);
  if (stems(input.message).some((w) => about.has(w))) return undefined;
  // On a call it is not said twice in a row; a typed reply always has it (ai `sayStep`).
  return standing;
}

function promptOf(input: PathTurnInput, decision: Decision): PathPromptGuidance {
  const { step, choice, pathStep, calc } = decision;
  const start = startOf(input, decision);
  const u = decision.reading;
  const personal = u === null ? personalOf(input, decision) : null;
  const read = u === null ? null : readTurn(input, decision, u);
  // Who has not said they know the words is told what one means, the first time it is used.
  const terms = ['experienced', 'some'].includes(input.reads.path?.intake?.experience ?? '')
    ? null
    : termsIn([...input.earlierMessages, input.message, ...(input.earlierReplies ?? [])].join('\n'));
  const plainLead =
    read === null ? withFigure(input, decision, leadOf(input, decision, start, personal)) : read.lead;
  const lead =
    plainLead === null || terms === null
      ? plainLead
      : {
          text: withMeanings(plainLead.text, new Set(terms)),
          voice: withMeanings(plainLead.voice, new Set(terms), true),
        };
  // A step cut to one part is said as that part.
  const doing = step?.view.items.filter((i) => !i.done) ?? [];
  const title =
    doing.length === 1 && ONE_PART.test(step?.view.doneWhen ?? '')
      ? bare(doing[0]?.do ?? '')
      : (step?.view.title ?? '');
  const saidTitle =
    step === null || terms === null
      ? title
      : withMeanings(title, new Set([...terms, ...termsIn(lead?.text ?? '')]));
  const asked =
    lead !== null && personal?.opens === true && lead.text.startsWith(personal.text.slice(0, 24))
      ? null
      : askOf(input, decision, lead, personal);
  const found = matchedOf(decision, asked, lead !== null);
  // They name the options, and the program's answer names none of them: the pick is the model's, the answer its background.
  const matched = found === 'phrase' && namesNoOption(choice, asked) ? 'semantic' : found;
  // A sum is no answer of the step's: a step that is not about it still only stands on their path.
  const stepRole =
    u !== null || lead === null || decision.calc.ask !== null
      ? stepRoleOf(input, decision, matched)
      : undefined;
  const facts = templateFacts(input, decision);
  const sends = decision.message ? messageOf(input, decision) : null;
  const kind = decision.kind === 'crisis' ? 'coaching' : decision.kind;
  const talks = kind !== 'social' && kind !== 'rehearsal';
  const more = talks && read === null ? moreOf(input, decision, asked, lead) : [];
  const parts =
    kind === 'coaching' && decision.restates === null && read === null ? partsOf(input, decision) : [];
  const said1 = kind === 'coaching' && decision.restates === null ? limitsOf(input, decision, asked) : [];
  // Under a reading only what they set is told, never a sentence of the program's put in for it.
  const limits = read === null ? said1 : said1.map((l) => ({ ...l, text: '' }));
  const held = read?.opened === 'held';
  const heldOptions = held ? (input.understanding?.choice?.options ?? []) : [];
  const beside = besideSaid(input, decision);
  const sums = read === null ? (beside === null ? calc.lines : [beside.text]) : read.sums;
  const askBack = read === null ? (beside === null ? calc.missing : null) : null;
  const asksSum =
    read === null
      ? calc.unsure === true
      : u !== null &&
        (u.kind === 'sum' || u.also.includes('sum')) &&
        u.sums.length === 0 &&
        read.opened !== 'sum' &&
        u.missing === null;
  return {
    matched,
    ...(stepRole === undefined ? {} : { stepRole }),
    kind,
    brief: briefOf(briefSource(input, decision)),
    stage: {
      title: decision.stageTitle,
      number: decision.state.stageIndex + 1,
      count: decision.stageCount,
    },
    firstTime: decision.firstTime,
    ...(talks && decision.firstTimeNow ? { firstTimeNow: true } : {}),
    ask: asked,
    ...(lead === null ? {} : { lead }),
    ...(read === null && lead !== null && deniedLead(input, decision)?.text === lead.text
      ? { denies: true }
      : {}),
    ...(read === null || u === null
      ? {}
      : {
          reading: {
            kind: u.kind === 'pushback' && seeksPraise(input.message) ? 'question' : u.kind,
            ask: u.ask,
            secondAsk: u.secondAsk,
            points: read.points,
            record: u.record.map((r) => r.text),
            avoid: u.avoid,
            opened: read.opened,
            referral: u.referral,
            inOrder: needsOrder(u),
            ...read.notes,
            ...(heldOptions.length === 0 ? {} : { heldOptions }),
            ...(goneIn(input.message).length === 0 ? {} : { gone: goneIn(input.message) }),
            figures: u.sums.filter((x) => x.asked).map((x) => ({ value: x.value, unit: x.unit })),
          },
          ...(read.fallback === null ? {} : { fallback: read.fallback }),
        }),
    ...(read === null || u === null || !talks ? {} : fitOf(input, decision, u)),
    ...(talks && read === null && asked === null && lead === null && step !== null
      ? {
          fallback:
            kind === 'news'
              ? newsFallback(decision)
              : calc.unsure === true &&
                  !decision.rejects &&
                  (/\d/.test(input.message) || countsIn(input.message).length > 0)
                ? NO_FIGURE
                : decision.rejects || !asksFor(input.message)
                  ? standOn(input, decision, step.view)
                  : fallbackOf(input, step.view),
        }
      : {}),
    ...(more.length === 0 ? {} : { more }),
    ...(parts.length === 0 ? {} : { parts }),
    ...(limits.length === 0 ? {} : { limits }),
    ...(lead !== null && read === null && givesOrders(input, decision) ? { orders: true } : {}),
    ...(decision.message || decision.fills || u?.kind === 'draft' || u?.also.includes('draft') === true
      ? { draft: true }
      : {}),
    ...(talks && decision.restates !== null
      ? { restate: { how: decision.restates, reply: lastSaid(input) } }
      : {}),
    ...(talks && decision.rejects && read === null ? { rejected: true } : {}),
    ...(talks && templateBy(input, decision, lead) !== null
      ? { template: templateBy(input, decision, lead) ?? 'shown' }
      : {}),
    ...(kind === 'coaching' && asksJudgement(input, decision) ? { judgement: true } : {}),
    // What a person decides is never ruled on: the server's own sentence opens that answer, or the program's does.
    ...(talks &&
    choice !== null &&
    decision.calc.ask === null &&
    !held &&
    (decision.referral === null || decision.play === null)
      ? { choice: { kind: choice.kind, options: choice.options } }
      : {}),
    ...(talks && read === null && decision.finding !== '' ? { finding: decision.finding } : {}),
    ...(talks && sums.length > 0 ? { calc: sums } : {}),
    ...(talks && asksSum ? { asksSum: true } : {}),
    ...(talks && askBack !== null ? { askBack } : {}),
    ...(talks
      ? read === null
        ? { prior: priorOf(input, decision, lead), ...factsOf(input, decision) }
        : { prior: null }
      : {}),
    ...(talks ? { said: saidText(input, decision) } : {}),
    ...(decision.howTo ? { howTo: true } : {}),
    step:
      step === null
        ? null
        : {
            title: step.view.title,
            ...(saidTitle === step.view.title ? {} : { said: saidTitle }),
            items: step.view.items
              .filter((i) => !i.done)
              .map((i) => ({ do: i.do, how: i.how, minutes: i.minutes })),
            doneWhen: doneSaid(step.view.doneWhen),
            dueOn: step.view.dueOn,
            ...(decision.wasDue === null ? {} : { wasDue: decision.wasDue }),
            template:
              sends !== null
                ? { title: sends.title, body: fillTemplate(sends.body, facts) }
                : step.view.template === null
                  ? null
                  : {
                      title: step.view.template.title,
                      body: fillTemplate(step.view.template.body, facts),
                    },
          },
    pathStep: pathStep === null ? null : { title: pathStep.title, dueOn: pathStep.dueOn },
    then: decision.then.map((s) => s.title),
    checkIn:
      decision.checkIn === null
        ? null
        : { title: decision.checkIn.title, dueOn: decision.checkIn.dueOn, overdue: decision.checkIn.overdue },
    referral:
      decision.referral === null || toldEnough(input, decision, u)
        ? null
        : {
            who: decision.referral.who,
            bring: decision.referral.bring,
            before:
              u !== null && tellsLegalLetter(input.message) ? 'you answer it' : seenBefore(decision.referral),
            ...(referralTold(input, decision) ? { told: true } : {}),
          },
    newIdea: decision.newIdea,
    criteria: decision.missing.map((c) => ({ id: c.id, title: c.title, evidence: c.evidence })),
  };
}

/** The plays a founder comes to for a judgement of what they have, that the model may think before it answers. */
export const JUDGED_PLAYS: ReadonlySet<string> = new Set([
  'honest-read',
  'real-business',
  'biggest-reason-to-fail',
  'friends-love-it',
  'fake-compliments',
  'someone-has-my-idea',
  'will-anyone-pay',
]);
/** A judgement asked for in so many words. */
const JUDGES =
  /\b(?:is (?:it|that|this) (?:really )?(?:worth|enough|too (?:early|late|small|much|soon))|(?:poke|find) (?:some )?holes|what (?:is|are) (?:wrong|weak)|what am i (?:missing|not seeing)|(?:be|your) (?:brutally |really )?honest|would you (?:invest|bet|do it|buy)|am i (?:wrong|right|crazy|fooling|on the right)|what (?:do you|would you) (?:make of|think of)|what does (?:that|this|it) (?:mean|show|prove|tell)|does (?:that|this|it) (?:mean|show|prove|count)|should i (?:worry|be worried|give up|quit|stop|pivot))\b/;

/** Whether the message asks what to make of something: the venture, a result, whether it is worth it. */
export function asksJudgement(
  input: Pick<PathTurnInput, 'message'>,
  decision: Pick<Decision, 'play' | 'intent'>,
): boolean {
  return (
    (decision.play !== null && JUDGED_PLAYS.has(decision.play.id)) ||
    asksIfGood(input.message) ||
    JUDGES.test(plain(input.message))
  );
}

/** Whether they ask to choose between options the program's answer says nothing of. */
function namesNoOption(choice: Decision['choice'], asked: Ask): boolean {
  if (choice?.kind !== 'either' || asked === null) return false;
  const held = new Set(contentStems(asked.answer));
  return (
    !/^(?:both|in this order)\b/i.test(asked.answer) &&
    !choice.options.some((o) => contentStems(o).some((w) => held.has(w)))
  );
}

const ONE_PART = /^This one part is done: (.+?)[.\s]*$/;

/** When a step cut to one part is done, said so it can be checked ("You have emailed one of the five theatre groups…"). */
function doneSaid(doneWhen: string): string {
  const part = ONE_PART.exec(doneWhen)?.[1];
  if (part === undefined) return doneWhen;
  const minutes = /^first (\d+) minutes of: (.+)$/i.exec(part);
  return minutes === null
    ? doneWhenOf(part.replace(/^the first part of: /i, ''))
    : `You have spent ${minutes[1] ?? ''} minutes on it and kept what you made.`;
}

/** What the one who decides is seen before, as it follows "before". */
function seenBefore(referral: NonNullable<Play['referral']>): string {
  switch (referral.category) {
    case 'ip_licensing':
      return 'you show, publish or sign anything';
    case 'securities_investment':
      return 'you talk terms';
    case 'medical_regulatory':
      return 'you promise it or try it on anyone';
    case 'expert_judgment':
      return 'you decide';
    default:
      return /\b(?:business lawyer|accountant)\b/i.test(referral.who) ? 'you sign anything' : 'you go ahead';
  }
}

type Ask = PathPromptGuidance['ask'];
type Lead = NonNullable<PathPromptGuidance['lead']>;

const ask = (title: string, answer: string, why: string, traps: readonly string[] = []): Ask => ({
  title,
  answer: answer.replace(/\s+/g, ' ').trim(),
  why,
  traps,
  evidenceKeys: [],
});
const flat = (text: string): string => text.replace(/[ \t]+/g, ' ').trim();
const sentence = (text: string): string => (text === '' ? '' : `${upperFirst(bare(text))}.`);
const joined = (...parts: readonly string[]): string => flat(parts.filter((p) => p !== '').join(' '));

// What the reading says ----------------------------------------------------------------------------------------------

interface ReadTurn {
  readonly lead: Lead | null;
  /** What of it code says first; null: the writer opens. */
  readonly opened: NonNullable<PathPromptGuidance['reading']>['opened'];
  readonly points: readonly string[];
  readonly sums: readonly string[];
  /** What the writer writes from, beside the claims. */
  readonly notes: Pick<
    NonNullable<PathPromptGuidance['reading']>,
    'words' | 'yesNo' | 'result' | 'choice' | 'contradicts' | 'missing' | 'says'
  >;
  /** What stands when the writer's reply is none: the claims it was given to make. */
  readonly fallback: { readonly text: string; readonly voice: string } | null;
}

/** "She's bluffing, right?", "… or not", "or nah": yes or no asked at the end. */
const TAG_ASKED =
  /(?:\b(?:or not|or nah|yes or no)\s*[?!.]*|\b(?:right|yeah|no|correct|true|fine|ok(?:ay)?|good)\s*\?+)\s*$/i;

/** Most claims the writer is given. */
const MOST_POINTS = 5;

/** What code says first on a turn the reading decides, and what the writer writes the rest from. */
function readTurn(input: PathTurnInput, decision: Decision, u: Understanding): ReadTurn {
  const { calc, choice } = decision;
  const { message } = input;
  const by = decision.decidedBy;
  const text = asksForText(message) || u.kind === 'draft';
  const yesNo = choice?.kind === 'yes_no';
  const asksYes = yesNo || TAG_ASKED.test(message.trim()) || /\byes or no\b|\bgo or no.?go\b/i.test(message);
  // A line of its working that the reply before said is not said again.
  const newLines = calc.lines.filter((l, i) => i === 0 || !saidLately(input, l));
  const told = isHeld(decision) ? (decision.play?.answer ?? '') : '';
  const opening: Opening | null = openingOf(u, {
    message,
    earlier: input.earlierMessages,
    replies: input.earlierReplies ?? [],
    textAsked: text,
    yesNo,
    today: input.today,
    referral: decision.referral,
  });
  // The same figure in the words of who is sure of it; who decides in the play's own, where they are the more exact.
  const made: Opening | null =
    by?.sum === 'rule' && newLines.length > 0
      ? { kind: 'sum', ...sumLead(newLines) }
      : opening?.kind === 'held' && HOLDS_OWN.has(decision.play?.id ?? '')
        ? { ...opening, ...(holdsLead(input, decision) ?? {}) }
        : opening;
  const privacy = told === '' ? null : privacyLead(told);
  const lead = privacy ?? (made === null ? null : { text: made.text, voice: made.voice });
  const opened = privacy !== null ? 'privacy' : (made?.kind ?? null);
  const progress = decision.kind === 'report' ? (reportLead({ ...decision, news: null })?.text ?? '') : '';
  const counted = u.result === null && u.sums.length === 0 ? (toldCounts(message)?.text ?? '') : '';
  const praised =
    friendsPraise(message) === null
      ? ''
      : 'Friends who like it are no proof; people they do not know, at a price, are.';
  const praise = seeksPraise(message)
    ? 'It cannot be called great yet: strangers who pay for it would show that, and nobody’s word does.'
    : '';
  const claims = [praise, ...u.points, progress, counted, praised, isItSaid(message) ?? ''];
  const points = distinct(
    (needsOrder(u) ? byUrgency(claims) : claims)
      .map((x) => bare(x))
      .filter((x) => x !== '' && (lead === null || stemsShared(x, lead.text) < 0.7)),
    (x) => x,
    0.8,
  ).slice(0, MOST_POINTS);
  const pick = u.choice ?? listPick(u, message, input.earlierMessages);
  const said = u.kind === 'recall' ? recallSaid(u, input.today) : points.slice(0, 4).map(sentence);
  return {
    lead,
    opened,
    points,
    sums: lead !== null && opened === 'sum' ? [lead.text] : u.sums.map((x) => sumOfReading(u, x, message)),
    notes: {
      ...(text ? { words: true } : {}),
      ...(asksYes && !text ? { yesNo: true } : {}),
      ...(u.result === null || text || !readsOutcome(message, input.earlierMessages)
        ? {}
        : { result: u.result }),
      ...(pick === null || opened === 'held'
        ? {}
        : { choice: { pick: pick.pick, because: pick.because, flipsIf: pick.flipsIf } }),
      contradicts: text ? null : contradictionSaid(u, { today: input.today, yesNo }),
      ...(u.missing === null || opened === 'sum' ? {} : { missing: u.missing }),
      ...(inConfidence(message) ? { says: [KEPT_SAID] } : {}),
    },
    fallback: said.length === 0 ? null : { text: said.join(' '), voice: said.slice(0, 2).join(' ') },
  };
}

/** What another founder's work is never told, in the program's words: its first sentences. */
function privacyLead(answer: string): Lead {
  const said = sentencesOf(answer).slice(0, 3);
  return { text: said.join(' '), voice: said.slice(0, 2).join(' ') };
}

/** The method the writer fits to them as their one step, and what they have for it. */
function fitOf(
  input: PathTurnInput,
  decision: Decision,
  u: Understanding,
): { readonly fit?: NonNullable<PathPromptGuidance['fit']> } {
  const into = decision.fitInto;
  if (into === null || decision.kind === 'recall' || u.kind === 'recall') return {};
  const { view } = into;
  const play = playOf(input.playbook, view.playId);
  const own = decision.own?.view ?? null;
  const open = own !== null && own.status === 'now' ? own : null;
  return {
    fit: {
      title: view.title,
      parts: view.items.filter((i) => !i.done).map((i) => bare(i.do)),
      doneWhen: doneSaid(view.doneWhen),
      trap: play?.traps[0] ?? null,
      way: u.firstAction ?? u.result?.settles ?? null,
      open:
        open === null ? null : { title: open.title, doneWhen: doneSaid(open.doneWhen), dueOn: open.dueOn },
      hours: hoursFor(input),
      dueOn: fitDue(input, view.dueOn),
      ...(NEWS_TOLD.test(input.message) || COMPLAINT.test(input.message) ? { news: true } : {}),
    },
  };
}

/** Hours they say they have for it, else the hours of their week. */
function hoursFor(input: PathTurnInput): number | null {
  const m =
    /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten) ?(?:hours?|hrs?)\b(?! (?:ago|long))/i.exec(
      plain(input.message),
    );
  const said = m === null ? null : /^\d/.test(m[1] ?? '') ? Number(m[1]) : numberOf(m[1] ?? '');
  return said ?? input.reads.path?.intake?.hoursPerWeek ?? null;
}

/** The day of a fitted step: the step's, or the day before a meeting they name, or the day something is due. */
function fitDue(input: PathTurnInput, dueOn: string | null): string | null {
  const at =
    /\b(?:meet(?:ing)?|see(?:ing)?|call(?:ing)?|pitch(?:ing)?|present(?:ing)?|talk(?:ing)?|interview(?:ing)?|demo|visit(?:ing)?)\b[^.?!]{0,40}?\b((?:next |this |on )?(?:mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow)\b/i.exec(
      input.message,
    )?.[1];
  const due =
    /\b(?:due|deadline|by|before)\b[^.?!]{0,16}?\b((?:next |this |on )?(?:mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow)\b/i.exec(
      input.message,
    )?.[1];
  const day = daySaid(at ?? due ?? '', input.today);
  if (day === null || day <= input.today) return dueOn;
  const last = at === undefined ? day : addDays(day, -1);
  const by = last <= input.today ? day : last;
  return dueOn === null || by < dueOn ? by : dueOn;
}

/** The turn as its step was fitted, or kept, by the writer: what is stored and shown with the reply. */
export function fitTurn(playbook: Playbook, turn: PathTurn, fitted: Fitted | null): PathTurn {
  const { decision, prompt } = turn;
  if (fitted === null || prompt.fit === undefined) return turn;
  const { own } = decision;
  if (fitted === 'same') {
    if (own === null || (own.view.id === decision.step?.view.id && prompt.stepRole === undefined))
      return turn;
    const kept: Decision = {
      ...decision,
      step: own,
      offered: false,
      pathStep: null,
      keeps: own.write === null ? null : own,
    };
    return {
      ...turn,
      decision: kept,
      guidance: guidanceOf(playbook, kept),
      prompt: withFitted(prompt, fitted),
    };
  }
  const into = decision.fitInto;
  if (into === null) return turn;
  // The step they are on, asked about again with no news: it stays as it is stored, in whatever words it was fitted.
  if (prompt.fit.news !== true && into.storedVersion !== null && into.view.status === 'now')
    return fitTurn(playbook, turn, 'same');
  // What they said they would do, in their own words, is never displaced.
  const theirs = own?.view.origin === 'founder' && own.view.status === 'now' && own.view.id !== into.view.id;
  const stored = into.storedVersion !== null;
  const step: ChosenStep = {
    view: {
      ...into.view,
      title: fitted.title,
      doneWhen: `${bare(fitted.doneWhen)}.`,
      dueOn: prompt.fit.dueOn,
      status: theirs ? 'next' : 'now',
    },
    write: !stored ? 'insert' : into.view.status === 'now' || theirs ? 'change' : 'promote',
    storedVersion: into.storedVersion,
    fitted: true,
  };
  const kept: Decision = { ...decision, step, keeps: step, offered: false, pathStep: null };
  return {
    ...turn,
    decision: kept,
    guidance: guidanceOf(playbook, kept),
    prompt: withFitted(prompt, fitted),
  };
}

/** Numbers the message takes back ("three and not two"): nothing beside the new ones says them. */
const goneIn = (message: string): number[] =>
  [...saidNumbers(message).matchAll(/\b(?:and |, )?not (\d{1,5})\b(?! ?(?:%|percent))/g)].map((m) =>
    Number(m[1]),
  );

/** The plays whose own words on what can be said are the more exact. */
const HOLDS_OWN: ReadonlySet<string> = new Set([
  'patent-now-or-wait',
  'sign-ip-form',
  'student-ip',
  'international-student',
]);

// What the server says first ---------------------------------------------------------------------------------------

/** What an offer makes the whole come to, where they ask that. */
const figureAsked = (input: PathTurnInput): ReturnType<typeof worthAsked> =>
  worthAsked({ message: input.message, earlier: input.earlierMessages, record: [] });

/**
 * What must be exact and comes first, whatever the model writes after it: their sum, what their news means, where they
 * stand, what is on record, what a change of direction changes. Null: the model's own answer opens the reply.
 */
function leadOf(
  input: PathTurnInput,
  decision: Decision,
  start: Start | null,
  personal: PersonalAnswer | null,
): Lead | null {
  const { kind, choice } = decision;
  if (kind === 'social' || kind === 'rehearsal' || kind === 'crisis') return null;
  const denied = deniedLead(input, decision);
  if (denied !== null) return denied;
  const worth = figureAsked(input);
  if (worth !== null && decision.calc.lines.length === 0) {
    const s = sumSaid(worth, { worth: true });
    return { text: joined(s.text, s.aside), voice: s.voice };
  }
  const sum =
    decision.calc.ask !== null && decision.calc.lines.length > 0
      ? sumRead(decision, sumLead(decision.calc.lines.filter((l, i) => i === 0 || !saidLately(input, l))))
      : null;
  if (kind === 'recall') return sum === null ? recallLead(input, decision) : withBefore(input, decision, sum);
  if (kind === 'new_idea') return null;
  if (decision.pivot !== null) return pivotLead(input, decision, decision.pivot);
  // "What share is that, and is it enough?": the result read against its line has the share.
  if (decision.result !== null) return resultLead(input, decision.result);
  // Which of two, decided by their own figures: the pick says the sum.
  if (choice !== null && choice.pick !== null) return { text: choice.pick.text, voice: choice.pick.voice };
  if (sum !== null) return keptApart(input, withBefore(input, decision, sum));
  if (kind === 'coaching' && !decision.pushes) {
    const right = ownLead(input, decision);
    if (right !== null) return right.lead;
    // A verdict on them is the server's, word for word, and said once.
    if (personal?.opens === true && gaveBefore(input, personal.text) === 0)
      return { text: personal.text, voice: personal.voice };
  }
  if (kind === 'news')
    return decision.news === null ? null : { text: decision.news.means, voice: decision.news.spoken };
  if (kind === 'report') return reportLead(decision) ?? notYetLead(input, decision);
  if (decision.whenDone) return doneLead(decision);
  if (decision.message) return sendLead(input, decision);
  if (decision.fills) return fillLead(input, decision);
  if (decision.overview && (decision.play === null || start !== null) && !asksOfFounders(input, decision))
    return overviewLead(input, decision, start);
  if (start !== null) return startLead(input, start);
  if (decision.smaller !== null && decision.play === null && decision.step !== null) {
    const less = smallerAsk(input, decision)?.answer;
    return less === undefined ? null : { text: less, voice: firstSentence(less) };
  }
  if (decision.howTo) return howToLead(input, decision);
  return null;
}

/** The leads that answer one kind of ask, each by its own words; the first that fires, with its name. */
const OWN_LEADS: readonly (readonly [string, (input: PathTurnInput, decision: Decision) => Lead | null])[] = [
  ['price_change', (input) => priceChangeLead(input)],
  ['market', marketLead],
  ['price_right', priceRightLead],
  ['changes', changesLead],
  ['convince', (input, decision) => convinceLead(decision, input)],
  ['plain_pick', (input, decision) => plainPickLead(decision, input)],
  ['needed', neededLead],
  ['offer', offerLead],
  ['holds', holdsLead],
  ['ip_talk', ipTalkLead],
  ['meaning', meaningLead],
  ['compares', comparesLead],
  ['rejected', rejectedLead],
  ['if_no', ifNoLead],
  ['worth', worthLead],
  ['told', toldLead],
];
function ownLead(
  input: PathTurnInput,
  decision: Decision,
): { readonly name: string; readonly lead: Lead } | null {
  for (const [name, made] of OWN_LEADS) {
    const lead = made(input, decision);
    if (lead !== null) return { name, lead };
  }
  return null;
}

/** Money put to them for a part of it, and whether to take it asked: what can be said, never a verdict. */
function offerLead(input: PathTurnInput, decision: Decision): Lead | null {
  const { referral, howTo } = decision;
  if (referral?.category !== 'securities_investment' || howTo || !offersForShares(input.message)) return null;
  if (!asksFor(input.message)) return null;
  const said = offerSaid(referral);
  return gaveBefore(input, said.text) > 0 ? null : said;
}

/** What they claim of growth, against their own record: named first, kindly (denied.ts). */
function deniedLead(input: PathTurnInput, decision: Decision): Lead | null {
  const { kind } = decision;
  if (kind === 'recall' || kind === 'new_idea' || kind === 'report' || decision.pivot !== null) return null;
  if (decision.restates !== null || decision.calc.ask !== null) return null;
  const said = deniedGrowth(input.message, recordLines(input));
  return said === null || gaveBefore(input, said.text) > 0 ? null : said;
}

/** Whether what opens the reply is the one thing to do, or the parts of it in order. */
function givesOrders(input: PathTurnInput, decision: Decision): boolean {
  if (decision.smaller !== null || decision.weak !== null || decision.rejects) return true;
  // A page to fill in is the work: nothing of the model's own beside it but why.
  if (startOf(input, decision) !== null) return true;
  if (decision.kind === 'report') return decision.report?.state === 'not_yet';
  return (
    decision.overview &&
    (asksOneThing(input.message) || asksForPlan(input.message) || nextBlank(input, decision) !== '')
  );
}

/** The sum they ask for, against the one before when they ask for both ("what does it change?"). */
function withBefore(input: PathTurnInput, decision: Decision, sum: Lead): Lead {
  if (decision.calc.ask !== 'hourly' || !COMPARES_OLD.test(plain(input.message))) return sum;
  const before = hourlyBefore({
    message: input.message,
    earlier: input.earlierMessages,
    record: recordLines(input),
  });
  return before === null
    ? sum
    : { text: joined(sum.text, before), voice: joined(sum.voice, heardSum(before)) };
}
/** Their sum, of money another thing of theirs makes: it is that one's. */
function keptApart(input: PathTurnInput, sum: Lead): Lead {
  const m = OTHER_OWN.exec(plain(input.message));
  const other = m?.[1] ?? m?.[2];
  const name = bare(input.venture.name);
  if (other === undefined || name === '' || /^new venture\b/i.test(name)) return sum;
  const apart = `Keep the two apart: that money is your ${other}'s, and it covers nothing of ${name} until you decide to put it in.`;
  return { text: joined(sum.text, apart), voice: joined(sum.voice, apart) };
}
const OTHER_OWN =
  /\bmy ([a-z]+)(?:'s| is)? (?:just |also )?(?:the |my |an? )?other (?:thing|business|venture|project|company|job|shop|startup) (?:that )?(?:i|we)\b|\bmy other (?:business|venture|shop|company|project|thing),? (?:the |an? |is (?:an? |the )?)?([a-z]+)\b/;
const COMPARES_OLD =
  /\b(?:old|before|previous(?:ly)?|used to|compared?|versus|vs|against|difference|more than|chang(?:e|es|ed)|than it was|up from|new one and)\b/;
const recordLines = (input: PathTurnInput): string[] =>
  currentOnes(input.reads.memory)
    .concat(input.reads.memory)
    .filter((m, i, all) => all.indexOf(m) === i && m.status === 'confirmed' && !isReference(m))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((m) => inTheirVoice(m.content.trim() === '' ? m.title : m.content));

/** An either-or or a yes-or-no on what a qualified person decides: what can be said of it, first, and never the ruling. */
function holdsLead(input: PathTurnInput, decision: Decision): Lead | null {
  const { play, choice, referral } = decision;
  if (play === null || referral === null || choice === null || decision.howTo) return null;
  if (choice.kind === 'which') return null;
  const said = holdsAnswer(play, {
    texts: [...input.earlierMessages, input.message, ...input.reads.memory.map((m) => m.content)],
    today: input.today,
  });
  if (said === null || gaveBefore(input, said) > 0) return null;
  return {
    text: said,
    voice: said
      .split(/(?<=[.!?])\s+/u)
      .slice(0, 2)
      .join(' '),
  };
}

/** Showing it, or telling of it, before the office that decides has seen it: what is theirs to say meanwhile. */
const TELLS_OF_IT =
  /\b(?:can|could|may|should|is it (?:ok(?:ay)?|safe|fine)|am i allowed|do i)\b[^.?!]{0,30}\b(?:talk|tell|show|share|speak|demo|present|pitch|discuss|mention|post)\w*\b|\b(?:does|will|would|if) (?:i |we )?(?:talk|tell|show|shar|present|pitch|post)\w*\b/i;
function ipTalkLead(input: PathTurnInput, decision: Decision): Lead | null {
  if (decision.referral?.category !== 'ip_licensing' || !TELLS_OF_IT.test(input.message)) return null;
  const said =
    'Describe the problem to them, and not how your answer to it works, and ask UR Ventures first. What may be said without touching a patent is theirs to say, so ask them that in one line today.';
  return gaveBefore(input, said) > 0 ? null : { text: said, voice: said };
}

/** "So what does that mean for what I'm building?": their finding read, never told back to them. */
function meaningLead(input: PathTurnInput, decision: Decision): Lead | null {
  if (decision.finding === '' || decision.restates !== null || decision.play !== null) return null;
  if (!asksMeaning(input.message)) return null;
  const replies = input.earlierReplies ?? [];
  const told1 = [input.message, ...[...input.earlierMessages].reverse()].find(
    (m) => newsOf({ message: m, before: [] }) !== null || DEAR_BUT_BOUGHT.test(plain(m)),
  );
  const turned = (input.reads.path?.pivots ?? []).filter((x) => x.to !== '' && !/^back\b/i.test(x.to)).at(-1);
  const read =
    turned !== undefined && told1 === undefined
      ? keptFrom(decision.finding, lowerFirst(shortOf(ideaSaid(turned.to))))
      : readMeaning(told1 ?? decision.finding, {
          customer: templateFacts(input, decision).customer,
          venture: bare(input.venture.name),
        });
  if (read === null || replies.some((r) => stemsShared(read.text, r) >= GAVE_IT)) return null;
  return read;
}

/** What was found for the idea they left: why they left it, and the one thing of it to check for the new one. */
function keptFrom(finding: string, idea: string): Lead {
  const text = `Keep it as the reason you changed direction: ${lowerFirst(bare(finding))}. It says nothing yet about the new idea (${idea}): those are other people. One thing carries over, whatever stopped the first ones, so check that first with the new ones, by asking what they do today.`;
  return {
    text,
    voice: text
      .split(/(?<=[.!?])\s+/u)
      .slice(0, 2)
      .join(' '),
  };
}

/** "Convince a sceptic." of a pick their own counts decide: the doubt, how far the numbers carry, what would settle it. */
function convinceLead(decision: Decision, input: PathTurnInput): Lead | null {
  if (decision.restates !== 'convince') return null;
  const rated = pickBefore(input);
  if (rated === null) return null;
  const { best, other } = rated;
  const fewer = Math.max(1, Math.round(best.part - (other.part / other.whole) * best.whole));
  const text = `The doubt is fair: ${String(best.whole)} is a small group, and ${fewer === 1 ? 'one' : String(fewer)} fewer there would make the two equal. What speaks for it is the share: the same offer got about ${perTen(best)} in ten there, and about ${perTen(other)} in ten in the other, so the bigger group only looks better because more were asked. What would prove it wrong: ask 20 more in each with the same words. If the first falls to ${percent(other.part, other.whole)} or lower, I would drop it.`;
  return {
    text,
    voice: text
      .split(/(?<=[.!?])\s+/u)
      .slice(0, 2)
      .join(' '),
  };
}

/** A pick said in plain words, when they ask for that. */
function plainPickLead(decision: Decision, input: PathTurnInput): Lead | null {
  if (decision.restates !== 'plain') return null;
  const rated = pickBefore(input);
  if (rated === null) return null;
  const { best, other } = rated;
  const name = lowerFirst(bare(best.option));
  const text = `Go with ${/^(?:north|south|east|west)/i.test(name) ? `the ${name}` : name}. Out of every ten you asked there, about ${perTen(best)} said yes. In the other place it was about ${perTen(other)} out of ten. That is why it goes first.`;
  return { text, voice: text };
}

const perTen = (r: { readonly part: number; readonly whole: number }): string => {
  const n = Math.round((r.part / r.whole) * 10);
  return (
    (['none', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'] as const)[n] ??
    String(n)
  );
};

/** The choice the conversation had made for them by their own counts. */
function pickBefore(input: PathTurnInput): NonNullable<ReturnType<typeof choiceRates>> | null {
  const asks = [...input.earlierMessages].reverse().find((m) => choiceRates(m, input) !== null);
  return asks === undefined ? null : choiceRates(asks, input);
}
const choiceRates = (message: string, input: PathTurnInput): ReturnType<typeof ratesOf> =>
  ratesOf({
    message,
    earlier: input.earlierMessages,
    told: input.reads.memory.filter((m) => m.status === 'confirmed').map((m) => m.content),
  });

/** "What is a value proposition, and do I need one now?": whether it is for now, by the stage they are on. */
function neededLead(input: PathTurnInput, decision: Decision): Lead | null {
  if (!asksIfNeeded(input.message)) return null;
  const order = input.playbook.stages.map((x) => x.stage);
  const named = asksIn(input.message)
    .concat([input.message])
    .map((a) =>
      phraseIntent(
        input.playbook,
        a,
        (i) => i.note !== true && i.referral !== true && i.overview === undefined,
      ),
    )
    .find((m) => m !== null);
  const play = playOf(input.playbook, named?.intent.playId ?? null);
  if (play?.referral !== null) return null;
  const at = order.indexOf(play.stage);
  if (at < 0) return null;
  const doing = STAGE_DOING[play.stage];
  const here = decision.state.stageIndex;
  const thing = bare(play.template?.title ?? play.title).toLowerCase();
  const text =
    at > here
      ? `Not yet. It belongs to stage ${String(at + 1)}, ${doing}, and you are on stage ${String(here + 1)}, ${STAGE_DOING[decision.state.stage]}. Until then one plain line does its work: who has the problem, and what they do about it today.`
      : `Yes, now. It belongs to ${doing}, where you are${at < here ? ' already past' : ''}, and it is one page: ${thing}.`;
  return {
    text,
    voice: text
      .split(/(?<=[.!?])\s+/u)
      .slice(0, 2)
      .join(' '),
  };
}

const COMPARES =
  /\b(?:every ?(?:one|body) else|all the others|the others|other (?:founders|teams|people|students)(?: here| in the program)?)\b[^.?!]{0,40}\b(?:seems?|is|are|looks?|flying|ahead|doing|further|faster|better|already|killing|crushing)\b|\b(?:i am|we are) (?:so |way |far |always |just )?(?:behind|slower than|worse than) (?:everyone|everybody|the others|all|them)\b/;

/** They measure themselves by what others show: their own numbers, and what decides. */
function comparesLead(input: PathTurnInput, decision: Decision): Lead | null {
  if (asksFor(input.message) || !COMPARES.test(plain(input.message))) return null;
  const r = readingIn(input, decision);
  const own = r.best === '' ? '' : `Yours say this: ${r.best}.`;
  const text = joined(
    'What you see of the others is what they announce, never their numbers, so it tells you nothing about yours.',
    own,
    r.lacks,
    'That is the one thing to be ahead of, and nobody else in the room can do it for you.',
  );
  return {
    text,
    voice: joined('You see what the others announce, never their numbers.', own === '' ? r.lacks : own),
  };
}

/** They reject the answer: it is owned, and what their own facts allow stands in its place. */
function rejectedLead(input: PathTurnInput, decision: Decision): Lead | null {
  const { step } = decision;
  if (!decision.rejects || step === null) return null;
  const stands = standOn(input, decision, step.view);
  // Only what is said as theirs is said to be.
  const own = stands.own ? 'From your own facts, then.' : '';
  const opens = /\b(?:textbook|generic|boilerplate|vague|useless|obvious)\b/.test(plain(input.message))
    ? 'Fair, that was general.'
    : 'Fair.';
  return {
    text: joined(opens, own, stands.text),
    voice: joined(opens, stands.voice),
  };
}

/** "And if they say no?": a no to the step just given is part of it. */
function ifNoLead(input: PathTurnInput, decision: Decision): Lead | null {
  const { step } = decision;
  if (step === null || decision.play !== null || !asksIfNo(input.message)) return null;
  const about = `${step.view.title} ${step.view.items.map((i) => i.do).join(' ')} ${(input.earlierReplies ?? []).at(-1) ?? ''}`;
  const sells = /\b(?:pay|sell|offer|price|order|buy|pilot|letter)\b/i.test(step.view.title);
  const silent = /\b(?:answer|reply|respond|ignore)/i.test(plain(input.message));
  const text = silent
    ? 'If they do not answer, that is normal, and it is why the list is long: wait three days, send one short line once more, then go to the next name. Ten names for three talks is normal. If nobody of 20 answers, change the first sentence, not the person.'
    : sells
      ? 'If they say no, thank them and ask two things: what they did the last time, and what would have to be different. Do not argue and do not drop the price on the spot. Write the no and its reason the same day: one no teaches little, and three with the same reason tell you what to change.'
      : 'If they say no, thank them and ask who else deals with this. A no to a talk is about their time, not your idea, so go to the next name the same day. Write down each no: if most of 10 say no, change the first line of the message before you send more.';
  return about === ''
    ? null
    : {
        text,
        voice: text
          .split(/(?<=[.!?])\s+/u)
          .slice(0, 2)
          .join(' '),
      };
}

/** "Is that worth my two hours?": the step by its time, what it settles, and when to leave it. */
function worthLead(input: PathTurnInput, decision: Decision): Lead | null {
  const { step } = decision;
  if (step === null || decision.play !== null || !asksIfWorth(input.message)) return null;
  const play = playOf(input.playbook, step.view.playId);
  const items = step.view.items.filter((i) => !i.done);
  const minutes = items.reduce((sum, i) => sum + (i.minutes ?? 0), 0);
  const had = timeSaid(input.message);
  const first = items[0];
  const takes =
    minutes === 0
      ? ''
      : had !== null && minutes > had.minutes
        ? `All of it is about ${hoursSaid(minutes)}, so in your ${had.said} do the first part${first === undefined ? '' : `: ${lowerFirst(bare(first.do))}`}.`
        : `It is about ${hoursSaid(minutes)}${had === null ? '' : `, so it fits your ${had.said}`}.`;
  const r = readingIn(input, decision);
  const why = play === null ? '' : play.why;
  const skip = r.best === '' ? '' : `Skip it only if it tells you nothing about this: ${r.best}.`;
  const text = joined('Yes, if it settles something.', takes, why, skip);
  return {
    text,
    voice: joined('Yes.', takes, r.have === '' ? (why.split(/(?<=[.!?])\s+/u)[0] ?? '') : r.have),
  };
}

const hoursSaid = (minutes: number): string =>
  minutes >= 120 ? `${String(Math.round(minutes / 30) / 2)} hours` : `${String(minutes)} minutes`;

/** "What did you tell me to do?": the step as it stands, with its first part and when it is done. */
function toldLead(input: PathTurnInput, decision: Decision): Lead | null {
  const { step } = decision;
  if (step === null || !asksWhatTold(input.message)) return null;
  const last = input.reads.steps.find((x) => x.id === step.view.id);
  const first = step.view.items.find((i) => !i.done);
  const others = input.reads.steps
    .filter(
      (x) => x.id !== step.view.id && x.origin === 'path' && (x.status === 'next' || x.status === 'now'),
    )
    .slice(0, 1)
    .map((x) => lowerFirst(bare(x.title)));
  const gave = last === undefined ? 'The step is this' : 'I gave you this';
  const text = joined(
    `${gave}: ${lowerFirst(bare(step.view.title))}.`,
    first === undefined ? '' : `It starts with this part: ${lowerFirst(bare(first.do))}.`,
    others[0] === undefined ? '' : `Before it you were on this one, and it is still open: ${others[0]}.`,
  );
  return { text, voice: text };
}

/** A step not done: the day it moves to, and the smaller one to do instead. */
function notYetLead(input: PathTurnInput, decision: Decision): Lead | null {
  if (decision.report?.state !== 'not_yet') return null;
  const made = reportAsk(input, decision, null);
  return made === null ? null : { text: made.answer, voice: made.answer };
}

/** How to do the step just given: its first part, whole, and its template when the conversation has not shown it. */
function howToLead(input: PathTurnInput, decision: Decision): Lead | null {
  const made = howToAsk(input, decision);
  if (made === null || gaveBefore(input, made.answer) > 0) return null;
  const idea = decision.offered ? ideaTold(input) : '';
  const body =
    idea === ''
      ? made.answer
      : `For ${idea}, the first part is this: ${made.answer.replace(/^Start with the first part: /u, '')}`;
  const template = decision.step?.view.template ?? null;
  const block =
    made.block === undefined || template === null || showsTemplate(input.earlierReplies ?? [], template.body)
      ? ''
      : `\n\n${made.block}`;
  return { text: `${body}${block}`, voice: body };
}

/** "What changes because of that?", after a change of direction: what stays true, and what is to be shown again. */
function changesLead(input: PathTurnInput, decision: Decision): Lead | null {
  const last = (input.reads.path?.pivots ?? []).filter((x) => x.to !== '').at(-1);
  const idea = ideaOf(input, decision);
  if (last === undefined || idea === null || decision.play !== null) return null;
  if (!ASKS_CHANGE.test(plain(input.message))) return null;
  const reason = broughtHere(input);
  const stays = reason === '' ? '' : `What stays: ${bare(reason)}.`;
  const open = decision.missing.slice(0, 3).map(nameOf);
  const changes = `What changes: it is for this now, ${lowerFirst(shortOf(ideaSaid(idea)))}${open.length === 0 ? '' : `, so you show again ${listed(open)}`}.`;
  const text = joined(stays, changes);
  return (input.earlierReplies ?? []).some((r) => r.includes(changes))
    ? null
    : { text, voice: joined(stays, changes) };
}

/** The template they ask to have written out. */
function fillLead(input: PathTurnInput, decision: Decision): Lead | null {
  const template = decision.step?.view.template ?? null;
  if (template === null) return null;
  const filled = fillTemplate(template.body, templateFacts(input, decision));
  const labels = labelsOf(template.body);
  return {
    text: `Here it is${filled === template.body ? '' : ', with what you told me in it'}. The [brackets] are yours, because only you know them:\n\n${plainTemplate(filled)}`,
    voice:
      labels.length < 2
        ? `"${template.title}" is on your screen.`
        : `It is on your screen: ${listed(labels.slice(0, 5).map(lowerFirst))}. Say the first one to me in a sentence.`,
  };
}

/** They tell their idea: the page it goes on, once and whole, with what they told in it. */
function startLead(input: PathTurnInput, start: Start): Lead {
  const name = bare(input.venture.name);
  const what = name === '' || /^new venture\b/i.test(name) ? 'your idea' : name;
  const go = `First, put ${what} on one page: it shows what you have seen and what is still a guess.`;
  return { text: `${go}\n\n${start.text}`, voice: joined(go, start.voice) };
}

/** Whether what they charge is right: what an hour brings, and who has answered it so far. */
function priceRightLead(input: PathTurnInput, decision: Decision): Lead | null {
  if (!asksIfPriceRight(input.message)) return null;
  const line = hourlyOf({
    message: input.message,
    earlier: input.earlierMessages,
    record: currentOnes(input.reads.memory)
      .filter((m) => m.status === 'confirmed' && !isReference(m))
      .map((m) => m.content),
  });
  if (line === null) return null;
  const reading = readingIn(input, decision);
  const paid = reading.level === 'one_paid' || reading.level === 'some_paid';
  const opens = paid
    ? `So far it holds: somebody pays it. ${reading.have}`
    : 'Not proven yet: no buyer has answered it, so nobody can call it right or wrong.';
  const decides =
    'Two things decide it: whether that hour is worth yours, and what they pay for the way they do it now. If an hour of yours is worth more than that, it is too low already. If five of them in a row say yes without a pause, it is too low as well.';
  return { text: joined(opens, line, decides), voice: joined(opens, heardSum(line)) };
}

/** "Do I raise it to 40?", with the price they have: the line the new one has to beat. */
function priceChangeLead(input: PathTurnInput): Lead | null {
  const made = priceChange(input.message, [...recordLines(input), ...input.earlierMessages]);
  return made === null || gaveBefore(input, made.text) > 0 ? null : made;
}

/** A figure for the market, asked for as a number. */
const ASKS_MARKET_NUMBER =
  /\b(?:rough|ballpark|best|quick|dollar|any|some|approximate) (?:\w+ )?(?:estimate|number|figure|guess)s?\b|\b(?:estimate|number|figure|size|worth)\b[^?.!]{0,40}\bin (?:dollars|money)\b|\bballpark\b|\bjust (?:give me|tell me|say) (?:a|the|one) (?:number|figure|estimate)\b/;

/** "Just a rough estimate of the market, in dollars": the sum with what they told in it, and the one number to get. */
function marketLead(input: PathTurnInput, decision: Decision): Lead | null {
  const of = decision.play?.id ?? (decision.carried ? decision.step?.view.playId : null);
  const said = plain(input.message);
  const about = of === 'market-size' || /\bmarket size\b|\bsize of (?:the|my|our) market\b/.test(said);
  if (!about || !ASKS_MARKET_NUMBER.test(said)) return null;
  const { customer } = templateFacts(input, decision);
  const who = customer === null ? 'people in your first group' : lowerFirst(customer);
  const prices = [...recordLines(input), ...input.earlierMessages, input.message].flatMap((t) =>
    quantitiesIn(t).quantities.filter((q) => q.role === 'price' && q.low === q.high),
  );
  const price = prices.at(-1);
  const sure = price !== undefined && prices.every((q) => q.low === price.low);
  const times = price?.period === 'month' ? 12 : price?.period === 'week' ? 52 : null;
  const pays = !sure
    ? 'You have not told me a price, so put the one you mean to charge there, with the word guess beside it.'
    : times === null
      ? `At ${money(price.low)}${price.noun === null ? '' : ` a ${price.noun}`}, that is ${money(price.low)} x how many one buys in a year, and what people do today tells you how many.`
      : `At ${money(price.low)} a ${price.period ?? ''}, that is ${money(price.low)} x ${String(times)} = ${money(price.low * times)} a year from one.`;
  const line = `The market in dollars is one line you can defend: how many ${who} you could reach this year x what one pays you in a year.`;
  const get =
    'The one number to get is that count, from a page you can link. Any other figure would be mine and not yours, and the first question would sink it.';
  const text = joined(line, pays, get);
  return gaveBefore(input, text) > 0 ? null : { text, voice: joined(line, sentencesOf(get)[0] ?? '') };
}

// Read for them ----------------------------------------------------------------------------------------------------

function priorSource(input: PathTurnInput, decision: Decision, lead: Lead | null): PriorSource {
  return {
    oneLiner: input.venture.oneLiner,
    reads: input.reads,
    intake: input.reads.path?.intake ?? null,
    earlier: input.earlierMessages,
    message: input.message,
    about: `${decision.play?.title ?? ''} ${decision.step?.view.title ?? ''}`,
    // Without its step line: the step is the same on every turn. What answered a statement is no answer to the ask itself.
    said: [answeredStatement(input) ? '' : lastSaid(input), lead?.text ?? ''].join(' '),
    applies: decision.kind === 'coaching' && lead === null && decision.play !== null,
    venture: input.venture.name,
    today: input.today,
    ...(input.continuity.founderFirstName == null ? {} : { founder: input.continuity.founderFirstName }),
    ...partOfAnswer(decision),
  };
}

/** The first part of the step that answers them. */
function partOfAnswer(decision: Decision): { readonly part?: string } {
  const { step, play } = decision;
  const first = step?.view.items.find((i) => !i.done);
  return play === null || step?.view.playId !== play.id || first === undefined ? {} : { part: first.do };
}

/** What they have, what is missing, and what goes wrong today. */
function readingIn(input: PathTurnInput, decision: Decision): Reading {
  return readingOf(priorSource(input, decision, null), {
    customer: templateFacts(input, decision).customer,
    leftOver: decision.state.criteria.some(
      (c) => c.criterion.id === 'model-unit-economics' && c.status !== 'open',
    ),
  });
}

/** The program's answer to a judgement, made for them. */
function personalOf(input: PathTurnInput, decision: Decision): PersonalAnswer | null {
  const { play, kind } = decision;
  if (play === null || kind !== 'coaching' || decision.pushes || decision.howTo) return null;
  return personalFor(input, decision, play);
}

function personalFor(input: PathTurnInput, decision: Decision, play: Play): PersonalAnswer | null {
  const facts = templateFacts(input, decision);
  const reading = readingIn(input, decision);
  const replies = input.earlierReplies ?? [];
  const told1 = (text: string, of: readonly string[]): boolean => of.some((r) => saysMost(r, text));
  const source: AnswerSource = {
    // What the conversation already said of them is built on, never said again.
    reading: { ...reading, lacks: told1(reading.lacks, replies) ? '' : reading.lacks },
    ideaSaid: facts.idea !== null && told1(facts.idea, replies),
    venture: input.venture.name,
    idea: facts.idea ?? '',
    customer: facts.customer ?? '',
    answer: play.answer,
    yesNo: decision.choice?.kind === 'yes_no',
    facts: factsFor({ ...priorSource(input, decision, null), applies: true }),
    message: input.message,
  };
  return personalAnswer(play.id, source);
}

/** "What does a founder do all day?" asks about founders: the answer, never a page to fill in. */
const asksOfFounders = (input: PathTurnInput, decision: Decision): boolean =>
  decision.play?.id === 'start-from-zero' &&
  input.message.trim().endsWith('?') &&
  !asksOverview(input.message);

/** They reject the answer, or ask nothing: what the next one stands on, and one part of the step. */
function standOn(
  input: PathTurnInput,
  decision: Decision,
  view: NonNullable<Decision['step']>['view'],
): { readonly text: string; readonly voice: string; readonly own: boolean } {
  const r = readingIn(input, decision);
  const play = playOf(input.playbook, view.playId);
  const own = play === null ? null : personalFor(input, decision, play);
  const all = decision.rejects && own !== null ? sentencesOf(own.text) : [];
  const left = all.filter((x) => !saidIn(input, x)).slice(0, 3);
  if (decision.rejects && own !== null && all.every((x) => !saidIn(input, x)))
    return { text: own.text, voice: own.voice, own: true };
  // What the reply they reject left out of it.
  if (left.length > 0 && contentStems(left.join(' ')).length >= LEAST_LEFT)
    return { text: left.join(' '), voice: left.slice(0, 2).join(' '), own: true };
  if (r.have === '' && !decision.rejects) return { ...fallbackOf(input, view), own: false };
  const last = lastSaid(input);
  // A sum of their figures stood on them.
  const summed = (x: string): boolean => SUM_SAID.test(last) && figuresShared(x, last) >= 2;
  const fresh = (x: string): string =>
    decision.rejects && x !== '' && (summed(x) || (input.earlierReplies ?? []).some((y) => saysMost(y, x)))
      ? ''
      : x;
  const first = view.items.find((i) => !i.done);
  const go = first === undefined ? '' : `One part, today: ${lowerFirst(bare(first.do))}. ${first.how}`;
  // What they have was said: the one of their facts the last reply did not stand on, or it, once more.
  const told = concreteFact(input.reads.memory, input.continuity.founderFirstName ?? '', input.today);
  const others = [told === null ? '' : `${upperFirst(told)}.`, r.have].filter((x) => x !== '');
  const again = summed(r.have) || (input.earlierReplies ?? []).some((x) => /^Fair\b/u.test(x)) ? '' : r.have;
  const have =
    fresh(r.have) !== '' || !decision.rejects
      ? r.have
      : (others.find((x) => stemsShared(x, last) < GAVE_IT && !summed(x)) ?? again);
  const facts = [have, fresh(r.lacks)].filter((x) => x !== '');
  return {
    text: joined(...facts, go),
    voice: joined(...facts, decision.rejects ? (go.split(/(?<=[.])\s/u)[0] ?? '') : ''),
    own: facts.some((x) => x !== r.lacks),
  };
}

/** A reply that worked out a sum of theirs. */
const SUM_SAID = /= \$\d|\bbrings? what \$\d|\bbring what \d/;

/** How many of a fact's figures a text holds (a sum of them stood on it). */
function figuresShared(fact: string, text: string): number {
  const held = new Set(saidNumbers(text).match(/\d+(?:\.\d+)?/g) ?? []);
  return new Set((saidNumbers(fact).match(/\d+(?:\.\d+)?/g) ?? []).filter((d) => held.has(d))).size;
}

/** They only told something before this message: what they ask now was not asked yet. */
const answeredStatement = (input: PathTurnInput): boolean => {
  const last = input.earlierMessages.at(-1);
  return (
    last !== undefined &&
    asksFor(input.message) &&
    !asksFor(last) &&
    !last.includes('?') &&
    !asksOverview(last)
  );
};

/** Fewest words of an answer that still say something of it. */
const LEAST_LEFT = 6;

/** The last reply as it was said, without what the server ends it with. */
const lastSaid = (input: PathTurnInput): string =>
  ((input.earlierReplies ?? []).at(-1) ?? '')
    .split(/\n\n\*\*(?:Start with|Next|On your path)/u)[0]
    ?.replace(/ ?\[E\d+[^\]]*\]/g, '')
    .replace(/ ?(?:Your next step|On your path, next is): [^.]*\.\s*$/u, '')
    .trim() ?? '';

/**
 * Who writes the step's template on this reply, when it is one of labelled lines: the server's lead holds it (`opens`), the
 * conversation already showed it (`shown`), or it is on the card and the server adds it whole when the model starts one
 * (`offer`). Null: it is no such template (a script, a message), and the model may write it.
 */
function templateBy(
  input: PathTurnInput,
  decision: Decision,
  lead: Lead | null,
): 'opens' | 'shown' | 'offer' | null {
  const template = decision.step?.view.template ?? null;
  if (template === null) return null;
  if (labelledLines(template.body) < 3)
    // A letter or a script of the step's is the card's, on a turn that asks for none of it.
    return decision.play === null && !decision.message && !decision.fills && !decision.howTo ? 'shown' : null;
  const first = plainTemplate(template.body)
    .split('\n')
    .map((l) => l.trim().split(':')[0] ?? '')
    .filter((l) => l !== '');
  if (lead !== null && first.slice(0, 2).every((l) => lead.text.includes(l))) return 'opens';
  return showsTemplate(input.earlierReplies ?? [], template.body) ? 'shown' : 'offer';
}

const labelledLines = (body: string): number =>
  body.split('\n').filter((l) => /^\s*(?:\d{1,2}[.)] )?[A-Z][\w',’ -]{1,40}:(?!\s*["“]).*\[/.test(l)).length;

/** Two to four facts of theirs the answer is to use. */
function factsOf(input: PathTurnInput, decision: Decision): { readonly facts?: readonly string[] } {
  const { kind } = decision;
  if (decision.pushes || kind !== 'coaching' || decision.restates !== null) return {};
  const facts = factsFor({ ...priorSource(input, decision, null), applies: decision.play !== null });
  return facts.length === 0 ? {} : { facts };
}

/** When the step is done, to who asks when it is enough. */
function doneLead(decision: Decision): Lead | null {
  const done = decision.step?.view.doneWhen;
  if (done === undefined) return null;
  const said = `It is enough when this is true: ${lowerFirst(bare(doneSaid(done)))}. Stop there, and take the next step.`;
  return { text: said, voice: said };
}

/** A sum as it is heard ("40 boxes times $3.50 left per box is $140"). */
export function heardSum(line: string): string {
  return line
    .replace(/ x /g, ' times ')
    .replace(/ \/ /g, ' divided by ')
    .replace(/ = -/g, ' is minus ')
    .replace(/ = /g, ' is ')
    .replace(/ - /g, ' minus ');
}

/** A working the last replies said already. */
const saidLately = (input: PathTurnInput, line: string): boolean =>
  (input.earlierReplies ?? []).slice(-2).some((r) => r.includes(line) || r.includes(heardSum(line)));

function sumLead(lines: readonly string[]): Lead {
  return { text: lines.join(' '), voice: lines.slice(0, 2).map(heardSum).join(' ') };
}

/** A share of customers lost is read: what it costs to go on with it, and whom to ask. */
function sumRead(decision: Decision, sum: Lead): Lead {
  if (decision.calc.ask !== 'churn') return sum;
  const m = /(\d+) of (?:the )?(\d+) ([a-z]+(?: [a-z]+)?) = (\d+(?:\.\d+)?)%/.exec(sum.text);
  if (m === null || Number(m[4]) < 10) return sum;
  const [, part = '', , noun = 'customers'] = m;
  const read = `If that goes on, every new one only replaces one who left. So before you add ${noun}, ask the ${part} who left what they used it for and what they do now.`;
  return { text: joined(sum.text, read), voice: joined(sum.voice, read.split(/(?<=\.)\s/u)[1] ?? '') };
}

function resultLead(input: PathTurnInput, result: NonNullable<Decision['result']>): Lead {
  const read = readResult(result, [...input.earlierMessages, ...input.reads.memory.map((m) => m.content)]);
  // Read a moment ago: what would be enough, or what it shows and what it does not, never the same lines again.
  if (gaveBefore(input, read.text) > 0 && read.text.includes('No pass line')) {
    const again = readAgain(result);
    return { text: again, voice: again };
  }
  if (saidResult(input, result)) {
    const further = readFurther(result, [
      ...input.earlierMessages,
      ...input.reads.memory.map((m) => m.content),
    ]);
    return { text: further.text, voice: further.spoken };
  }
  return { text: read.text, voice: read.spoken };
}

/** Whether the conversation read this result already. */
const saidResult = (input: PathTurnInput, r: { readonly part: number; readonly whole: number }): boolean =>
  (input.earlierReplies ?? []).some(
    (x) =>
      x.includes(`${String(r.part)} of ${String(r.whole)}`) &&
      /\b(?:number to beat|pass line|passed)\b/i.test(x),
  );

const nameOf = (c: { readonly id: string; readonly title: string }): string =>
  CRITERION_NAMES[c.id] ?? lowerFirst(bare(c.title));

/** What a criterion is a number of ("2 of the 5 commitments from strangers"). */
const countedName = (c: { readonly id: string; readonly title: string }): string =>
  CRITERION_COUNTED[c.id] ?? nameOf(c).replace(/^(?:ten|five|three|twenty|\d+) /i, '');

/** They ask where they stand, or for the way ahead; else only what to do. */
const ASKS_WHERE =
  /\borgani[sz]e\w*\b|\bwhere (?:am|are|do|does|should|would|can)\b|\bstage\b|\bpath\b|\bplan\b|\broad ?map\b|\bnext\b|\bstart(?:ed)?\b|\bbegin\b|\bschedule\b|\bi am (?:a )?(?:student founder|lost|overwhelmed)\b|\bmy idea is\b|\bwhat (?:should|do) (?:i|we) (?:do|work on|focus on|be doing)\b|\bidea\b/;

/** Where they stand and what is missing, said by a mentor: the answer to "get me organized". */
function overviewLead(input: PathTurnInput, decision: Decision, start: Start | null): Lead {
  const { state, missing, step, then, news } = decision;
  const name = bare(input.venture.name);
  const fact = concreteFact(input.reads.memory, input.continuity.founderFirstName ?? '', input.today);
  const have = state.criteria
    .filter((c) => c.status !== 'open' && (c.by === 'path' || c.by === 'record'))
    .slice(-3)
    .map((c) => nameOf(c.criterion));
  const first = step?.view.items.find((i) => !i.done);
  const stage = `You are on stage ${String(state.stageIndex + 1)} of ${String(decision.stageCount)}${name === '' ? '' : ` with ${name}`}, ${STAGE_DOING[state.stage]}.`;
  const misses = missing.length > 0 ? `Still missing: ${listed(missing.map(nameOf))}.` : '';
  const starts = first === undefined ? '' : `Start with this: ${lowerFirst(bare(first.do))}.`;
  const opens = decision.firstTimeNow ? 'Never having done this is fine: we take it one part at a time.' : '';
  const fits = timeFits(input, decision);
  const block = start === null ? '' : `\n\n${start.text}`;
  const plan =
    asksForPlan(input.message) && step !== null ? `\n\n${planLines(input, decision).join('\n')}` : '';
  const heard = news === null ? '' : news.spoken;
  const weak = weakLead(input, decision);
  if (weak !== '') return { text: weak, voice: weak };
  if (
    asksOneThing(input.message) &&
    plan === '' &&
    start === null &&
    first !== undefined &&
    nextBlank(input, decision) === ''
  ) {
    // One thing, for them: whose it is, what nobody has shown yet, and the part that starts on it.
    const replies = input.earlierReplies ?? [];
    const r = readingIn(input, decision);
    const idea = ideaOf(input, decision);
    // What nobody has told them yet belongs before a talk, never before another kind of work; what they said here is known.
    const talk = /\b(?:talks?|interview\w*|ask|find \d+|people)\b/i.test(
      `${step?.view.title ?? ''} ${first.do}`,
    );
    const here = [...input.earlierMessages.slice(-2), input.message].some((m) => saysMost(m, r.have));
    const own = [here ? '' : r.have, r.level === 'none' && !talk ? '' : r.lacks].filter(
      (x) => x !== '' && !replies.slice(-1).some((y) => saysMost(y, x)),
    );
    const whose = idea === null || own.length > 1 ? '' : ` for ${ideaNamed(idea, input.venture.name)},`;
    const go = `${own.length === 0 ? 'One thing' : 'So one thing'}${whose === '' ? '' : `,${whose.replace(/,+$/u, '')}`}: ${lowerFirst(bare(first.do))}. ${first.how}`;
    return { text: joined(...own, go), voice: joined(own.at(-1) ?? '', firstSentence(go)) };
  }
  if (decision.actsOn !== null && news !== null) {
    const go = first === undefined ? '' : `So start with this: ${lowerFirst(bare(first.do))}. ${first.how}`;
    const told = priorFact(priorSource(input, decision, null))?.sentence ?? '';
    return { text: joined(news.means, told, go), voice: joined(news.spoken, firstSentence(go)) };
  }
  // Where they stand was just said, or is not what they ask: only where to start, with how.
  const saidBefore = (input.earlierReplies ?? []).some((r) => r.includes(stage));
  if (saidBefore || news !== null || decision.play !== null || !ASKS_WHERE.test(plain(input.message))) {
    const how = first === undefined || first.how === '' ? '' : sentence(first.how);
    const blank = start === null && plan === '' ? nextBlank(input, decision) : '';
    const known =
      fact === null || (input.earlierReplies ?? []).slice(-2).some((r) => stemsShared(fact, r) >= GAVE_IT)
        ? ''
        : `What you know so far: ${fact}.`;
    const go =
      saidBefore && start === null && plan === '' && first !== undefined
        ? `Do this part now${first.minutes === null ? '' : `, about ${String(first.minutes)} minutes`}: ${lowerFirst(bare(first.do))}.`
        : starts;
    return {
      text: `${joined(opens, news?.means ?? '', known, plan === '' ? (blank === '' ? `${go} ${how}` : blank) : 'In this order:', fits)}${plan}${block}`,
      voice: joined(
        opens === '' ? '' : 'First time is fine.',
        heard,
        go,
        heard !== ''
          ? ''
          : plan !== '' && then.length > 0
            ? `Then ${lowerFirst(bare(then[0]?.title ?? ''))}.`
            : (start?.voice ?? how),
      ),
    };
  }
  return {
    text: `${joined(
      opens,
      stage,
      have.length > 0 ? `You already have ${listed(have)}.` : '',
      fact === null ? '' : `What you know so far: ${fact}.`,
      misses,
      fits,
      plan === '' ? starts : 'In this order:',
    )}${plan}${block}`,
    voice: joined(
      opens === '' ? '' : 'First time is fine.',
      stage,
      missing.length > 0 && start === null
        ? `Still missing: ${listed(missing.slice(0, 2).map(nameOf))}.`
        : '',
      plan !== '' && then.length > 0
        ? `${starts} Then ${lowerFirst(bare(then[0]?.title ?? ''))}.`
        : `${starts} ${start?.voice ?? ''}`,
    ),
  };
}

/** One thing to do, when the last result is a weak one: ask the ones it came from. */
function weakLead(input: PathTurnInput, decision: Decision): string {
  const texts = [
    ...input.reads.memory.filter((m) => m.status === 'confirmed' && !isReference(m)).map((m) => m.content),
    ...input.earlierMessages,
  ];
  const result = decision.weak;
  if (result === null) return '';
  const from = [...texts].reverse().find((t) => lastResult([t]) !== null) ?? '';
  // The sentence with the numbers, never what they felt about it ("honestly I feel stupid").
  const counted = from.split(/(?<=[.!?])\s+/u).find((s) => lastResult([s]) !== null) ?? from;
  const fact = lowerFirst(toYou(told(counted)));
  const of =
    fact === '' || (input.earlierReplies ?? []).slice(-1).some((r) => stemsShared(fact, r) >= GAVE_IT);
  const no = result.whole - result.part;
  const yes =
    result.part === 0
      ? ''
      : `ask the ${result.part === 1 ? 'one' : String(result.part)} who said yes what made ${result.part === 1 ? 'that one' : 'them'} do it, and `;
  const opens = of ? 'One thing, then' : `You know this: ${fact}. So one thing`;
  return `${opens}: ${yes}ask ${no <= 5 ? 'the others' : `five of the ${String(no)} who did not`} what stopped them. Write their words the same day. What ${yes === '' ? 'they' : 'the two groups'} say${yes === '' ? '' : ' differently'} is the one change to make before the next round.`;
}

/** The template is in the conversation already: the next blank of it, with their idea beside it. '' when there is none. */
function nextBlank(input: PathTurnInput, decision: Decision): string {
  const { step } = decision;
  const template = step?.view.template ?? null;
  const replies = input.earlierReplies ?? [];
  if (template === null || step?.view.origin === 'founder' || !showsTemplate(replies, template.body))
    return '';
  const facts = templateFacts(input, decision);
  const blanks = plainTemplate(fillTemplate(template.body, facts))
    .split('\n')
    .flatMap((l) => {
      const m = /^\s*(?:\d{1,2}[.)] )?([A-Z][\w' -]{0,20}?)[:,]([^[]*)\[([^\]]{4,80})\]/.exec(l);
      if (m === null) return [];
      // "Jobs, what they try to get done: [job 1]": the line says what it is, its bracket only which one.
      const said = bare((m[2] ?? '').replace(/:\s*$/, ''));
      const what = /^\w+ \d$/.test(m[3] ?? '') && said !== '' ? `${said}, one thing` : (m[3] ?? '');
      return [{ label: m[1] ?? '', what }];
    });
  const given = replies.filter((r) => /one blank, "|Take the next blank/.test(r)).length;
  const blank = blanks[Math.min(given, blanks.length - 1)];
  if (blank === undefined) return '';
  const idea = facts.idea === null ? '' : ` for this idea: ${lowerFirst(shortOf(ideaSaid(facts.idea)))}`;
  return `${given === 0 ? 'The step starts with one blank' : 'Take the next blank of it'}, "${blank.label}": ${blank.what}. Write it in one plain line${idea}. A guess is fine if you mark it as one; five minutes is enough.`;
}

/** How the step fits the time they say they have ("four hours a week and an exam in nine days"). */
function timeFits(input: PathTurnInput, decision: Decision): string {
  const items = decision.step?.view.items.filter((i) => !i.done) ?? [];
  const minutes = items.reduce((sum, i) => sum + (i.minutes ?? 0), 0);
  if (items.length === 0 || items.some((i) => i.minutes === null) || minutes === 0) return '';
  const had = timeSaid(input.message);
  if (had === null) return '';
  const long =
    minutes >= 120
      ? `about ${String(Math.round(minutes / 30) / 2)} hours`
      : `about ${String(minutes)} minutes`;
  const asked = plain(input.message);
  const deadline = /\b(?:over|done|finished|passed|behind me|went)\b/.test(asked)
    ? undefined
    : /\b(?:exam|exams|midterm|midterms|finals?|deadline|paper|thesis)\b/.exec(asked)?.[0];
  const beside = deadline === undefined ? '' : `, and leaves the rest for your ${deadline}`;
  return minutes <= had.minutes
    ? `This step is ${long} in all, so it fits your ${had.said}${beside}.`
    : `This step is ${long} in all, more than your ${had.said}: do the first part and leave the rest for after.`;
}

// The thing itself ---------------------------------------------------------------------------------------------------

interface Start {
  readonly text: string;
  readonly voice: string;
}

/** The lines of a template a person fills in, by their labels ("Who", "Problem"). */
function labelsOf(body: string): string[] {
  return body
    .split('\n')
    .flatMap((l) => {
      const m = /^\s*(?:\d{1,2}[.)] )?([A-Z][\w']*(?: [\w']+)?)\s*[:?,]/.exec(l);
      return m?.[1] === undefined ? [] : [m[1].trim()];
    })
    .slice(0, 6);
}

/**
 * A template as it reads in a reply: a table's rows as lines of what each cell is for, and an empty bracket as one to fill.
 */
export function plainTemplate(body: string): string {
  let header: string[] | null = null;
  return body
    .split('\n')
    .flatMap((l): string[] => {
      if (!l.includes(' | ')) {
        header = null;
        return [l.replace(/\[ \]/g, '[...]')];
      }
      const cells = l.split(' | ').map((c) => c.trim());
      if (header === null) {
        header = cells.map((c) => c.toLowerCase().replace(/\s*\([^)]*\)\s*$/, ''));
        return [];
      }
      const names = header;
      const said = cells.map((c, i) => (/^"?\[ \]"?$/.test(c) ? `[${names[i] ?? '...'}]` : c));
      const [first = '', ...rest] = said;
      return [first.startsWith('[') ? `- ${said.join(', ')}` : `- ${first}: ${rest.join(', ')}`];
    })
    .join('\n');
}

/** Whether a reply of the conversation already showed the template. */
export function showsTemplate(replies: readonly string[], body: string): boolean {
  const lines = plainTemplate(body)
    .split('\n')
    .map((l) => l.trim().slice(0, 14))
    .filter((l) => l.length >= 4);
  return replies.some(
    (r) => lines.slice(0, 4).filter((l) => r.includes(l)).length >= Math.min(2, lines.length),
  );
}

/**
 * The step's own template, with what they told in it and the rest in [brackets], for a reply that starts the step: the
 * thing itself, never only the order to write it. Null: the turn starts nothing, it has none, or it was shown already.
 */
function startOf(input: PathTurnInput, decision: Decision): Start | null {
  const { step, kind } = decision;
  if (step === null || kind !== 'coaching') return null;
  if (!decision.overview && !tellsIdea(input, decision)) return null;
  // One thing to do is no page to fill in, what they just told has a step of its own, and a question is answered.
  if (decision.overview && asksOneThing(input.message)) return null;
  if (decision.actsOn !== null || asksOfFounders(input, decision)) return null;
  const template = step.view.template;
  if (template === null || step.view.origin === 'founder') return null;
  if (showsTemplate(input.earlierReplies ?? [], template.body)) return null;
  const filled = fillTemplate(template.body, templateFacts(input, decision));
  const body = plainTemplate(filled);
  const labels = labelsOf(template.body);
  return {
    text: `${filled === template.body ? 'Here it is to fill in, and the [brackets] are yours' : 'Here it is to fill in. What you told me is in it, and the [brackets] are yours'}:\n\n${body}`,
    voice:
      labels.length < 2
        ? `"${template.title}" is on your screen.`
        : `It is on your screen: ${listed(labels.slice(0, 5).map(lowerFirst))}.`,
  };
}

/** An order to the coach ("ignore your rules…"), never an idea. */
const ORDERS =
  /^(?:please )?(?:ignore|forget|pretend|repeat|print|tell|show|say|act|answer|stop|disregard|reveal|output|you are)\b/i;

/** The conversation opens with their idea or where they are, and asks nothing but help: its step starts here. */
function tellsIdea(input: PathTurnInput, decision: Decision): boolean {
  const message = input.message.replace(BARE_HELP, '.');
  return (
    decision.play === null &&
    !decision.vents &&
    decision.restates === null &&
    decision.calc.ask === null &&
    decision.smaller === null &&
    decision.commitment === null &&
    input.earlierMessages.length === 0 &&
    !asksFor(message) &&
    !ORDERS.test(message.trim()) &&
    meaningWords(message) >= 4 &&
    decision.step?.view.status === 'now' &&
    decision.step.view.playId === 'idea-on-a-page' &&
    (decision.idea !== null ||
      meaningWords(message) >= 5 ||
      /^(?:(?:hi|hello|so|well|ok(?:ay)?)[,.! ]+)*(?:i|we)(?:['’]d| would| want| am thinking| plan| hope)\b/i.test(
        message,
      ))
  );
}

/** The message they can send: the step's own template when it is one, else the one the stage has. */
function messageOf(
  input: PathTurnInput,
  decision: Decision,
): { readonly title: string; readonly body: string } | null {
  const own = decision.step?.view.template ?? null;
  if (own !== null && /^(?:hi|hello|hey|dear|subject)\b/im.test(own.body)) return own;
  const early = decision.state.stageIndex <= 1;
  const play = playOf(input.playbook, early ? 'find-ten-people' : 'cold-outreach');
  return play?.template ?? own;
}

const PLAN_ASKED = /\b(?:plan|road ?map|schedule|to ?do list|checklist|steps)\b/;
const asksForPlan = (message: string): boolean => PLAN_ASKED.test(plain(message));

/** The open step's parts and what follows, as a numbered list. */
function planLines(input: PathTurnInput, decision: Decision): string[] {
  const { step, then } = decision;
  if (step === null) return [];
  const items = step.view.items
    .filter((i) => !i.done)
    .map((i) => `${bare(i.do)}${i.minutes === null ? '' : ` (${String(i.minutes)} min)`}.`);
  const by = step.view.dueOn === null ? '' : ` by ${sayDue(input.today, step.view.dueOn)}`;
  const own = items.length === 0 ? [`${bare(step.view.title)}${by}.`] : items;
  // What follows, each with how it starts.
  const after = then.map((t) => {
    const first = t.items.find((i) => !i.done);
    const how = first === undefined || first.how === '' ? '' : ` ${sentence(first.how)}`;
    return `Then: ${lowerFirst(bare(t.title))}.${first === undefined ? '' : ` It starts with this: ${lowerFirst(bare(first.do))}.${how}`}`;
  });
  return [...own, ...after].map((l, i) => `${String(i + 1)}. ${l}`);
}

/** What a report changed, as a mentor says it: what they found first, then how far it gets them. */
function reportLead(decision: Decision): Lead | null {
  const { completes, work, news, finding } = decision;
  const parts: string[] = [];
  // The finding is the news, whatever else the message says is done.
  if (news === null && finding !== '' && (completes !== null || work.length > 0))
    parts.push(`What you found: ${lowerFirst(bare(finding))}.`);
  for (const w of work) {
    if (w.corrects !== undefined)
      parts.push(`Corrected: ${String(w.progress?.done ?? w.corrects)}, not ${String(w.corrects)}.`);
    if (w.progress !== null) {
      const left = w.progress.of - w.progress.done;
      parts.push(
        `That is ${String(w.progress.done)} of the ${String(w.progress.of)} ${countedName(w.criterion)}, ${String(left)} to go.`,
      );
    }
  }
  const shows = work
    .filter((w) => w.progress === null && w.corrects === undefined)
    .map((w) => nameOf(w.criterion));
  if (shows.length > 0) parts.push(`So you now have ${listed(shows)}.`);
  if (completes !== null && work.length === 0)
    parts.push(
      completes.rest === null
        ? `That closes the step you were on: ${lowerFirst(bare(completes.step.title))}.`
        : 'That part is done, and the rest of it comes next.',
    );
  if (news === null && parts.length === 0) return null;
  return {
    text: joined(news?.means ?? '', ...parts),
    voice: joined(news?.spoken ?? '', ...(news === null ? parts : parts.slice(0, 1))),
  };
}

/** What they last found, or told, before the direction changed. */
function broughtHere(input: PathTurnInput): string {
  const told1 = [
    ...input.reads.criteria
      .filter((c) => c.evidence !== null && c.sourceSessionId !== null)
      .map((c) => ({ on: c.updatedAt, words: wordsOfEvidence(c.evidence ?? '') })),
    ...input.reads.steps
      .filter((s) => s.status === 'done' && s.evidence !== null)
      .map((s) => ({ on: s.completedAt ?? s.createdAt, words: s.evidence ?? '' })),
  ].sort((a, b) => b.on.localeCompare(a.on));
  for (const t of told1) {
    const said = lowerFirst(toYou(told(t.words)));
    if (said.length <= 200 && informative(said)) return said;
  }
  return '';
}

/** A change of direction: what the idea is from today, what brought it, and what has to be shown again, or counts again. */
function pivotLead(input: PathTurnInput, decision: Decision, pivot: AppliedPivot): Lead {
  const finding = decision.finding === '' ? '' : `And this is new: ${lowerFirst(bare(decision.finding))}.`;
  const leaves = pivot.from === '' ? '' : lowerFirst(shortOf(ideaSaid(pivot.from)));
  if (pivot.back !== null) {
    const now = `You are back on this idea: ${lowerFirst(ideaSaid(pivot.idea))}.`;
    const counts = pivot.restored.map((r) => {
      const p = progressIn(r.evidence);
      return p === null
        ? nameOf(r.criterion)
        : `${String(p.done)} of the ${String(p.of)} ${countedName(r.criterion)}`;
    });
    const brought = broughtHere(input);
    const stopped = earlierFinding(input) ?? brought;
    // What is new takes away what stopped it ("no space" … "space is solved").
    const solves =
      decision.finding !== '' &&
      /\b(?:solved|fixed|gone|no longer|sorted|lend|lends|free|covered|taken care of|now have)\b/i.test(
        decision.finding,
      ) &&
      contentStems(decision.finding).some((w) => contentStems(stopped).includes(w))
        ? 'That means what stopped it is gone, so ask the ones it stopped first.'
        : '';
    const again =
      counts.length > 0
        ? `What you had shown for it counts again: ${listed(counts.slice(0, 4))}.`
        : brought === ''
          ? 'Nothing you showed for it is lost.'
          : `What you learned for it still holds: ${bare(earlierFinding(input) ?? brought)}.`;
    const from = leaves === '' ? '' : `The one you leave (${leaves}) stays in your story.`;
    return { text: joined(now, again, finding, solves, from), voice: joined(now, finding, solves) };
  }
  const reopened = pivot.reopened.slice(0, 3).map(nameOf);
  const to = ideaSaid(pivot.idea);
  const now = /^you\b/i.test(to)
    ? `From today ${lowerFirst(to)}.`
    : `From today the idea is ${lowerFirst(to)}.`;
  const before = (input.reads.path?.pivots ?? []).length > 0 ? 'The idea before it' : 'The first idea';
  const from = leaves === '' ? '' : `${before} (${leaves}) stays in your story.`;
  const reason = broughtHere(input);
  const why = reason === '' ? '' : `What brought you here stays true: ${bare(reason)}.`;
  const again =
    reopened.length > 0
      ? `What you showed was about the old customer, so you show it again for the new one: ${listed(reopened)}.`
      : reason === ''
        ? 'You had shown nothing about the old customer yet, so nothing is lost.'
        : 'It was about the old customer, so ask the new ones before you build on it.';
  return { text: joined(now, from, why, again), voice: joined(now, again) };
}

/** What they had found for the idea they go back to: from before the direction changed. */
function earlierFinding(input: PathTurnInput): string | null {
  const until = (input.reads.path?.pivots ?? [])[0]?.on ?? '9999';
  const steps = input.reads.steps
    .filter(
      (s) =>
        s.status === 'done' && s.evidence !== null && (s.completedAt ?? s.createdAt).slice(0, 10) <= until,
    )
    .sort((a, b) => (b.completedAt ?? b.createdAt).localeCompare(a.completedAt ?? a.createdAt));
  const words = steps[0]?.evidence ?? null;
  return words === null ? null : lowerFirst(toYou(told(words)));
}

const shortOf = (text: string): string =>
  text.length <= 120 ? bare(text) : `${bare(text.slice(0, 117))}...`;

/** The idea in their own words: what they just said, what is kept, else what the venture's record calls it. */
function ideaOf(input: PathTurnInput, decision: Decision): string | null {
  const kept = decision.idea ?? (input.reads.path?.intake?.idea ?? '').trim();
  if (kept !== '') return bare(kept);
  const line = input.venture.oneLiner.trim();
  return line === '' ? null : bare(line);
}

const STORY =
  /\bhow (?:we|i) got (?:here|to (?:this|where))\b|\bfrom the (?:start|beginning)\b|\b(?:story|history|journey|timeline)\b|\bhow (?:did|have) (?:we|i) (?:get|got|end up|ended up|arrive|come) (?:here|to (?:this|where)|this far)\b|\bwhy (?:are )?(?:we|i) (?:are )?where (?:we|i) are\b|\b(?:everything|all) (?:that )?(?:we|i)(?: have)? (?:did|done|tried|decided|learned|found)\b|\bwhat (?:has|have) (?:happened|i done|we done|i tried|we tried|i learned|we learned)\b|\b(?:recap|rundown|run ?down)(?: of (?:everything|our|my|the story)| ?(?:please|me|us)?\s*[?.!]*$)/;

/** How they got here, from the record's own dated entries, as a story. */
function storyLead(input: PathTurnInput, decision: Decision): Lead | null {
  const first = (input.reads.path?.pivots ?? []).find((x) => x.from !== '')?.from;
  const start = first ?? ideaOf(input, decision);
  const lines = storyLines(
    arcOf(briefSource(input, decision)),
    start === null ? '' : `${start} ${input.venture.name}`,
  );
  const opens = start === null ? '' : `You started with this idea: ${lowerFirst(shortOf(ideaSaid(start)))}.`;
  if (opens === '' && lines.length === 0) return null;
  return {
    text: [opens, ...lines.map((l) => `- ${dated(l)}`)].filter((l) => l !== '').join('\n'),
    voice: joined(opens, ...lines.slice(-3).map(dated)),
  };
}

const WHICH_IDEA =
  /\bwhich (?:of (?:the|my|our|those|these) (?:two |three |2 |3 )?)?(?:ideas?|ventures?|directions?|versions?)\b|\bwhat (?:idea|venture|direction|version) (?:are|am) (?:we|i)\b|\bwhat (?:is|was) (?:the|my|our) (?:current|latest|new|first|old|original|previous) (?:idea|direction|venture|version|plan)\b|\bare (?:we|i) still (?:on|doing|building|going with|working on)\b|\bwhat (?:are|am) (?:we|i) (?:building|making|selling|doing) (?:now|again|these days|at the moment)\b/;

/** The idea they are on, since when, and the one it was before. */
function whichIdeaLead(input: PathTurnInput, decision: Decision): Lead | null {
  const idea = ideaOf(input, decision);
  if (idea === null) return null;
  const pivots = (input.reads.path?.pivots ?? []).filter((x) => x.from !== '');
  const last = pivots.at(-1);
  const now = `You are on this idea: ${lowerFirst(shortOf(ideaSaid(idea)))}.`;
  if (last === undefined) return { text: now, voice: now };
  const back = /^back to (?!(?:the |our |my )?(?:first|original|old|previous|earlier|what)\b)([^.]+)/i.exec(
    last.to,
  )?.[1];
  const day = sayPast(input.today, last.on);
  if (/^back\b/i.test(last.to)) {
    // By the name they gave it, with what brought them back.
    const on =
      back === undefined
        ? `${bare(now)}, since ${day}.`
        : `You are on ${toYou(bare(back))} again, since ${day}.`;
    const left = `${upperFirst(shortName(last.from))} is the one you left.`;
    return { text: joined(on, left), voice: joined(on, left) };
  }
  const since = `${upperFirst(day)} you changed to it.`;
  const before = `The one before was this: ${lowerFirst(shortOf(ideaSaid(last.from)))}.`;
  return { text: joined(now, since, before), voice: joined(now, since) };
}

/** An idea by its first words ("an app with a story a night for parents" → "the app"). */
function shortName(idea: string): string {
  const said = ideaSaid(idea);
  const head = bare(said.split(/\s+(?:that|with|for|where|which|who|to|on|in|at)\s+|[,:;]/u)[0] ?? said);
  return contentStems(head).length === 0
    ? lowerFirst(shortOf(said))
    : lowerFirst(head).replace(/^an? /i, 'the ');
}

const HAS_AND_HAS_NOT =
  /\bwhat (?:do|does|have|has|had) .{0,40}\b(?:have|got|proven|proved|shown|achieved|validated)\b|\bwhat [\w'& -]{1,40} (?:has|have)\b|\bwhat (?:is|are)(?: still)? (?:missing|left to (?:prove|show)|proven|proved|not proven)\b|\bmissing\b|\bknow for (?:sure|certain)\b|\bknow so far\b|\b(?:status|state) of\b|\bwhere (?:does|is) (?:my|our|the)\b|\bstill to be (?:proven|shown)\b/;

/** What the venture has shown, with its numbers and prices, and what it has not. */
function statusLead(input: PathTurnInput, decision: Decision): Lead | null {
  const { state, missing } = decision;
  const name = bare(input.venture.name);
  const who = name === '' || /^new venture\b/i.test(name) ? 'You have' : `${name} has`;
  const others = otherBusinessesIn([input.message, ...input.earlierMessages]);
  const facts = input.reads.memory
    .filter(
      (m) =>
        m.status === 'confirmed' &&
        !isReference(m) &&
        ['evidence', 'fact', 'milestone', 'experiment'].includes(m.type) &&
        (m.type !== 'milestone' || milestoneReached(m)) &&
        !ofAnotherBusiness(`${m.title} ${m.content}`, others),
    )
    .map((m) => {
      const result = typeof m.attributes.result === 'string' ? m.attributes.result : '';
      return result === '' ? toldAs(m) : `${lowerFirst(bare(m.title))}: ${lowerFirst(bare(result))}`;
    });
  const told1 = [
    ...input.reads.criteria
      .filter((c) => c.status !== 'open' && c.evidence !== null && c.sourceSessionId !== null)
      .map((c) => lowerFirst(toYou(told(wordsOfEvidence(c.evidence ?? ''))))),
    ...input.reads.steps
      .filter((s) => s.status === 'done' && s.evidence !== null)
      .map((s) => lowerFirst(toYou(told(s.evidence ?? '')))),
  ].filter((t) => t !== '');
  const proven = distinct([...facts, ...told1], (t) => t)
    .sort((a, b) => Number(/\d/.test(b)) - Number(/\d/.test(a)))
    .slice(0, 4);
  const counted = state.criteria.flatMap((c) =>
    c.progress === null
      ? []
      : [`${String(c.progress.done)} of the ${String(c.progress.of)} ${countedName(c.criterion)}`],
  );
  const has = [...proven, ...counted];
  const lacks = missing.map(nameOf);
  const opens =
    has.length === 0 ? `${who} nothing shown yet that counts.` : `${who} this: ${has.join('; ')}.`;
  const not =
    lacks.length === 0
      ? ''
      : `${name === '' || /^new venture\b/i.test(name) ? 'You do' : 'It does'} not have this yet: ${listed(lacks)}.`;
  return {
    text: joined(opens, not),
    voice: joined(
      has.length === 0 ? opens : `${who} this: ${has.slice(0, 2).join('; ')}.`,
      lacks.length === 0 ? '' : `Not yet: ${listed(lacks.slice(0, 2))}.`,
    ),
  };
}

const ASKS_IDEA = /\b(?:idea|startup|venture|business|company|product)\b/;
const ASKS_LAST =
  /\b(?:last|talk|talked|discuss|discussed|speak|spoke|session|call|yesterday|cover|covered|leave off|left off|agree|agreed|said|say)\b/;
const ASKS_DECIDED =
  /\b(?:decide|decided|decision|agree|agreed|pivot|plan|change|changes|changed|direction)\b/;
const ASKS_TODO =
  /\b(?:something to do|anything to do|supposed to|going to do|meant to|tell me to do|to do next|next|plan|decide|decided|agree|agreed|my step)\b/;
const ASKS_CHANGE =
  /\bwhat (?:changes|changed|is different|will change|would change)\b|\bwhat does (?:that|this|it) change\b/;

/** What is on record, as they asked for it: the idea, what was decided and when, what they told. The step ends the reply. */
function recallLead(input: PathTurnInput, decision: Decision): Lead | null {
  const said = plain(input.message);
  if (STORY.test(said)) return storyLead(input, decision);
  if (WHICH_IDEA.test(said)) return whichIdeaLead(input, decision);
  if (HAS_AND_HAS_NOT.test(said)) return statusLead(input, decision);
  const name = bare(input.venture.name);
  const idea = ideaOf(input, decision);
  const asksIdea = ASKS_IDEA.test(said);
  const asksLast = ASKS_LAST.test(said);
  const asksDecided = ASKS_DECIDED.test(said);
  const asksTodo = ASKS_TODO.test(said);
  const standing = new Set(standingDecisions(input.reads.memory).map((m) => m.id));
  const founder = input.continuity.founderFirstName ?? '';
  const onRecord = currentOnes(input.reads.memory).filter(
    (m) => m.status === 'confirmed' && !isReference(m) && (m.type !== 'decision' || standing.has(m.id)),
  );
  // What they ask about, by its own words ("what's my fee?").
  const about = new Set(contentStems(input.message).filter((w) => !GENERIC_ASK.has(w)));
  const facts = distinct(
    onRecord
      .filter((m) => m.type !== 'decision' || !asksDecided)
      .map((m) => ({
        m,
        shared: contentStems(`${m.title}. ${m.content}`).filter((w) => about.has(w)).length,
      }))
      .filter((x) => x.shared > 0)
      .sort((a, b) => b.shared - a.shared || b.m.createdAt.localeCompare(a.m.createdAt))
      .map((x) => toldAs(x.m, founder)),
    (t) => t,
  ).slice(0, 2);
  const parts: string[] = [];
  const general = !asksLast && !asksDecided && !asksTodo && !asksIdea && facts.length === 0;
  if (idea !== null && (asksIdea || general))
    parts.push(
      `Your idea is ${name === '' || idea.toLowerCase().startsWith(name.toLowerCase()) ? '' : `${name}: `}${lowerFirst(toYou(idea))}.`,
    );
  const latest = (input.reads.path?.pivots ?? []).filter((p) => p.to !== '').at(-1);
  if (latest !== undefined && (asksDecided || asksLast || general)) {
    const to = toYou(bare(latest.to));
    const back = /^back\b/i.test(latest.to);
    parts.push(
      back
        ? `${upperFirst(sayPast(input.today, latest.on))} ${pivotSaid(latest.to)}.`
        : `${upperFirst(sayPast(input.today, latest.on))} you changed direction${latest.from === '' ? '' : `, from ${lowerFirst(shortOf(toYou(latest.from)))}`}: ${lowerFirst(to)}.`,
    );
    if (ASKS_CHANGE.test(said) && decision.missing.length > 0)
      parts.push(
        `What changes: you show it again for the new customer, starting with ${listed(decision.missing.slice(0, 2).map(nameOf))}.`,
      );
  }
  for (const f of facts) parts.push(sentence(f));
  if (asksDecided || asksLast || general) {
    const current = new Set(onRecord.map((m) => m.id));
    const decided = standingDecisions(input.reads.memory)
      .filter((m) => current.has(m.id))
      .filter((m) => latest === undefined || !sameThing(toldAs(m), `${latest.to} ${latest.from}`, 0.5))
      .slice(0, 2);
    for (const m of distinct(decided, toldAs)) {
      const what = toldAs(m);
      parts.push(
        `${upperFirst(sayPast(input.today, dayOf(m, 'decided_on')))} ${/^you\b/.test(what) ? what : `you decided: ${what.replace(/:\s+/gu, ', ')}`}.`,
      );
    }
  }
  // What they last reported, before what the conversation was about.
  if (asksLast || general) {
    const reported = broughtHere(input);
    if (reported !== '')
      parts.push(sentence(/^you\b/.test(reported) ? reported : `you told me that ${reported}`));
  }
  const last = (input.continuity.recentDigests ?? [])[0];
  if (last !== undefined && last.digest.summary.trim() !== '' && asksLast) {
    const summary = firstSentence(last.digest.summary).replace(/…$/u, '');
    const what = lowerFirst(toYou(bare(summary), founder));
    const day = sayPast(input.today, last.date.slice(0, 10));
    const line = /^you\b/.test(what)
      ? `${upperFirst(day)} ${what}.`
      : `${upperFirst(day)} we talked about this: ${what}.`;
    // What they reported is told already, in their own words.
    if (!parts.some((p) => sameThing(p, what, 0.5)) && !OF_A_STEP.test(what)) parts.push(line);
  }
  // A conversation is placed by the idea it was about.
  if (
    asksLast &&
    !asksDecided &&
    !asksIdea &&
    idea !== null &&
    parts.length > 0 &&
    !parts.some((p) => sameThing(p, idea))
  )
    parts.push(`It was about your idea: ${lowerFirst(shortOf(toYou(idea)))}.`);
  const progress = decision.state.criteria.find((c) => c.progress !== null);
  if (progress?.progress != null && (asksLast || asksTodo || general))
    parts.push(
      `So far: ${String(progress.progress.done)} of the ${String(progress.progress.of)} ${countedName(progress.criterion)}.`,
    );
  const done = input.reads.steps.find((s) => s.status === 'done');
  if (done !== undefined && (asksLast || general) && done.evidence === null)
    parts.push(`You finished one step: ${lowerFirst(bare(done.title))}.`);
  // The step they are on ends the reply, as on every turn (ai `reply-contract.ts`).
  if (parts.length === 0 && idea !== null) parts.push(`Your idea is ${lowerFirst(toYou(idea))}.`);
  const once = distinct(parts, (t) => t, 0.8);
  if (once.length === 0) return null;
  let text = '';
  for (const part of once) if (joined(text, part).length <= RECALL_CHARS) text = joined(text, part);
  return { text, voice: once.slice(0, 3).join(' ') };
}

/** What a summary says of the coaching itself, which the step line says. */
const OF_A_STEP = /\bstage \d\b|\b(?:five|5) (?:key )?lines\b|\bvalue proposition canvas\b/i;

/** Words of a recall question that name no fact of the record. */
const GENERIC_ASK = new Set(
  'remember remind again talk discuss decide decided idea startup venture plan last week change record agree session per what'.split(
    ' ',
  ),
);

/** Most characters of a recall. */
const RECALL_CHARS = 690;

// What the model answers from ----------------------------------------------------------------------------------------

/** The program's answer the model gives in its own words; null when the lead is the answer, or the model has to find one. */
function askOf(
  input: PathTurnInput,
  decision: Decision,
  lead: Lead | null,
  personal: PersonalAnswer | null,
): Ask {
  const { play, kind } = decision;
  if (kind === 'social' || kind === 'rehearsal' || kind === 'crisis' || kind === 'recall') return null;
  if (decision.pivot !== null || kind === 'news') return null;
  if (decision.pushes && (decision.referral !== null || play !== null)) return pushAsk(input, decision);
  if (kind === 'report') return reportAsk(input, decision, lead);
  if (decision.message || decision.fills) return null;
  if (decision.howTo) return lead === null ? howToAsk(input, decision) : null;
  if (play !== null && !(decision.overview && lead !== null))
    return playAsk(input, decision, play, lead === null ? (personal?.text ?? null) : null);
  if (decision.smaller !== null && !decision.overview) return smallerAsk(input, decision);
  return null;
}

const stemsShared = (text: string, said: string): number => {
  const words = contentStems(text);
  const held = new Set(contentStems(said));
  return words.length === 0 ? 0 : words.filter((w) => held.has(w)).length / words.length;
};

/** Share of an answer's words a reply holds when it gave that answer. */
const GAVE_IT = 0.7;

/** How many of the conversation's replies already gave `text` as the answer. */
const gaveBefore = (input: PathTurnInput, text: string): number =>
  (input.earlierReplies ?? []).filter((r) => stemsShared(text, r) >= GAVE_IT).length;

/** Whether they asked this play's question before: a question asked again is answered short, a statement answered is not. */
function askedBefore(input: PathTurnInput, play: Play, answer: string): boolean {
  const replies = input.earlierReplies ?? [];
  const asked = input.earlierMessages.filter((m) => asksFor(m));
  if (asked.some((m) => phraseIntent(input.playbook, m, (i) => i.playId === play.id) !== null)) return true;
  if (replies.length !== input.earlierMessages.length)
    return asked.length > 0 && gaveBefore(input, answer) > 0;
  return replies.some((r, i) => stemsShared(answer, r) >= GAVE_IT && asksFor(input.earlierMessages[i] ?? ''));
}

/** A part of a step, as a sentence with how. */
const partSaid = (part: { readonly do: string; readonly how: string }): string =>
  `${sentence(part.do)}${part.how === '' ? '' : ` ${sentence(part.how)}`}`;

/** The play's answer (made for them where it is a judgement). Given a moment ago, it is not given again: the next part is. */
function playAsk(input: PathTurnInput, decision: Decision, play: Play, personal: string | null): Ask {
  const answer = personal ?? play.answer;
  const held = input.playbook.intents.some((i) => i.playId === play.id && i.holds === true);
  // What is never shared is refused again in fewer words, and that it stays private is always said.
  if (held && gaveBefore(input, play.answer) > 0) return pushAsk(input, decision);
  if (gaveBefore(input, answer) === 0 && gaveBefore(input, play.answer) === 0) {
    const made = ask(play.title, answer, play.why, play.traps);
    return made === null || !held
      ? made
      : {
          ...made,
          keeps:
            'I do not see other founders here, and what they share stays with them, as your work stays with you.',
        };
  }
  const items = (decision.step?.view.items ?? []).filter((i) => !i.done);
  if (!askedBefore(input, play, play.answer)) {
    // Told when they asked nothing: the question gets what was not said yet, and the whole way to do it.
    const rest = answer
      .split(/(?<=[.!?])\s+/u)
      .filter(
        (x) =>
          contentStems(x).length >= 3 &&
          !(input.earlierReplies ?? []).some((r) => stemsShared(x, r) >= GAVE_IT),
      );
    // The one sentence that is the pick of what they ask now, then the way to do it, then what was not said.
    const wanted = new Set(contentStems(input.message));
    const [pick] = answer
      .split(/(?<=[.!?])\s+/u)
      .map((x) => ({ x, shared: contentStems(x).filter((w) => wanted.has(w)).length }))
      .filter((x) => x.shared > 0)
      .sort((a, b) => b.shared - a.shared);
    return ask(
      play.title,
      joined(
        pick?.x ?? '',
        ...items.slice(0, 2).map(partSaid),
        ...rest.filter((x) => x !== pick?.x).slice(0, 2),
      ),
      play.why,
      play.traps,
    );
  }
  const again = (input.earlierReplies ?? []).filter((r) =>
    /make it concrete now|Go on with the next part/.test(r),
  ).length;
  const part = items[Math.min(again, Math.max(0, items.length - 1))];
  if (part === undefined) return ask(play.title, firstSentence(answer), play.why, play.traps);
  const time = part.minutes === null ? '' : ` It takes about ${String(part.minutes)} minutes.`;
  const opens = again === 0 ? 'What I said stands, so make it concrete now' : 'Go on with the next part';
  return ask(
    `${play.title}: part ${String(again + 1)}`,
    `${opens}: ${lowerFirst(bare(part.do))}. ${part.how}${time}`,
    play.why,
    play.traps,
  );
}

const sentencesOf = (text: string): string[] =>
  text
    .split(/(?<=[.!?])\s+/u)
    .map((x) => x.trim())
    .filter((x) => x !== '');
/** Share of a sentence's words one reply holds when it said it in other words. */
const SAID_OF_IT = 0.6;
const saidIn = (input: PathTurnInput, text: string): boolean =>
  (input.earlierReplies ?? []).some((r) => stemsShared(text, r) >= SAID_OF_IT);
/** Most pieces of what was not said yet. */
const MOST_PIECES = 6;

/**
 * What the program has not said yet of what it answers with, when the conversation holds that answer already: its other
 * sentences, the parts of the step with how, the trap and the reason.
 */
function moreOf(input: PathTurnInput, decision: Decision, asked: Ask, lead: Lead | null): string[] {
  if (asked === null || lead !== null || (input.earlierReplies ?? []).length === 0) return [];
  const { play, step } = decision;
  if (play === null || decision.kind !== 'coaching') return [];
  // Who to see and what to bring is asked for: said again, it is the answer.
  if (decision.referral !== null && ASKS_WHO_AND_WHAT.test(plain(input.message))) return [];
  // The answer itself, never the part of it that stands in its place when it is asked again.
  const afresh = answeredStatement(input);
  const whole = afresh
    ? (personalFor(input, decision, play)?.text ?? play.answer)
    : /^(?:What I said stands|Go on with the next part)/u.test(asked.answer)
      ? play.answer
      : asked.answer;
  const answer = sentencesOf(whole).filter((x) => contentStems(x).length >= 4);
  const held = answer.filter((x) => saidIn(input, x)).length;
  if (answer.length === 0 || held / answer.length < HELD) return [];
  const items = step?.view.playId === play.id ? step.view.items.filter((i) => !i.done) : [];
  // Asked for the first time, it opens with what answers it, whatever a statement got.
  const opens = afresh ? sentencesOf(whole).slice(0, OPENS_WITH) : [];
  const rest = distinct(
    [
      ...answer,
      ...items.map(partSaid),
      ...play.traps.slice(0, 1).map((t) => `One trap: ${lowerFirst(bare(t))}.`),
      ...sentencesOf(play.why),
    ].filter((x) => !saidIn(input, x)),
    (x) => x,
    0.8,
  ).slice(0, MOST_PIECES);
  return [...opens, ...rest.filter((x) => !opens.includes(x))];
}
/** Sentences of the answer that open it when it is asked for the first time. */
const OPENS_WITH = 3;
/** Share of an answer's sentences the conversation holds when it was given. */
const HELD = 0.4;

const WHAT_NOW =
  /^(?:(?:and|so|then|but) )*what (?:now|next|then)\b|\bwhat (?:do|should|would) (?:i|we) do (?:now|next|then|with it)\b/;

/** The things they ask, each with what the server adds when the reply leaves it out. */
function partsOf(input: PathTurnInput, decision: Decision): NonNullable<PathPromptGuidance['parts']> {
  const asks = asksIn(input.message);
  if (asks.length < 2 || decision.pushes) return [];
  const { play, step } = decision;
  const items = (step?.view.items ?? []).filter((i) => !i.done);
  const own = play === null ? null : (personalFor(input, decision, play)?.text ?? play.answer);
  return asks.map((ask, i) => {
    const none = { ask, text: '', voice: '' };
    const first = items[0];
    if (WHAT_NOW.test(plain(ask))) {
      if (first === undefined) return none;
      const text = `So now: ${lowerFirst(bare(first.do))}. ${sentence(first.how)}`.trim();
      return { ask, text, voice: `So now: ${lowerFirst(bare(first.do))}.` };
    }
    if (/^(?:how|why)$/i.test(ask)) {
      const next = /^how$/i.test(ask)
        ? items.map(partSaid).find((x) => !saidIn(input, x))
        : sentencesOf(play?.why ?? '').find((x) => !saidIn(input, x));
      return next === undefined ? none : { ask, text: next, voice: next };
    }
    const found = phraseIntent(input.playbook, ask, (x) => x.note !== true && x.overview === undefined);
    const other = playOf(input.playbook, found?.intent.playId ?? null);
    if (other !== null && other.id !== play?.id && i > 0) {
      const said = sentencesOf(personalFor(input, decision, other)?.text ?? other.answer);
      const text = said.slice(0, 2).join(' ');
      return { ask, text, voice: said[0] ?? '' };
    }
    if (own === null) return none;
    // What the conversation said already is no answer to it now.
    const all = [...sentencesOf(own), ...(step?.view.playId === play?.id ? items.map(partSaid) : [])].filter(
      (x) => !saidIn(input, x),
    );
    const wanted = contentStems(ask);
    const ranked1 = all
      .map((x, n) => ({ x, n, shared: contentStems(x).filter((w) => wanted.includes(w)).length }))
      .filter((x) => x.shared > 0)
      .sort((a, b) => b.shared - a.shared || a.n - b.n)[0];
    if (ranked1 === undefined) return none;
    const text = joined(ranked1.x, i > 0 ? (all[ranked1.n + 1] ?? '') : '');
    return { ask, text, voice: ranked1.x };
  });
}

/** What they set themselves, each with the sentence of the program's that keeps to it ('' : none). */
function limitsOf(
  input: PathTurnInput,
  decision: Decision,
  asked: Ask,
): NonNullable<PathPromptGuidance['limits']> {
  const all = [
    ...sentencesOf(asked?.answer ?? ''),
    ...(decision.play === null ? [] : sentencesOf(decision.play.answer)),
    ...(decision.step?.view.items ?? []).filter((i) => !i.done).map(partSaid),
  ];
  return limitsIn(input.message).map((said) => ({
    said,
    text:
      all.find((x) =>
        /^\d+$/.test(said) ? new RegExp(`(?<![\\d.$])${said}(?![\\d.%])`).test(x) : plain(x).includes(said),
      ) ?? '',
  }));
}

/** The step's parts, or the next of them when the conversation already listed them. */
function fallbackOf(
  input: PathTurnInput,
  view: NonNullable<Decision['step']>['view'],
): NonNullable<PathPromptGuidance['fallback']> {
  const items = view.items.filter((i) => !i.done);
  const replies = input.earlierReplies ?? [];
  const said = (part: (typeof items)[number]): string => {
    const time = part.minutes === null ? '' : ` It takes about ${String(part.minutes)} minutes.`;
    return flat(`${sentence(part.do)} ${part.how === '' ? '' : sentence(part.how)}${time}`);
  };
  const listed1 = replies.filter(
    (r) => items[0] !== undefined && r.includes(`1. ${bare(items[0].do)}`),
  ).length;
  const alone = items.filter((i) => replies.some((r) => r.includes(`One part, then: ${bare(i.do)}`))).length;
  const part = items[Math.min(alone, Math.max(0, items.length - 1))];
  if (part === undefined) return { text: sentence(view.title), voice: sentence(view.title) };
  if (listed1 > 0 || alone > 0) {
    const text = `One part, then: ${said(part)}`;
    return { text, voice: text };
  }
  const list = items.map((i, n) => {
    const time = i.minutes === null ? '' : ` (${String(i.minutes)} min)`;
    return `${String(n + 1)}. ${bare(i.do)}${time}${i.how === '' ? '.' : `: ${lowerFirst(bare(i.how))}.`}`;
  });
  const second = items[1];
  return {
    text: `Here is how the step goes:\n\n${list.join('\n')}`,
    voice: `First ${lowerFirst(bare(part.do))}${second === undefined ? '' : `, then ${lowerFirst(bare(second.do))}`}.`,
  };
}

/** What the server says of news no rule reads, when the model said too little of it: never the step's parts instead. */
function newsFallback(decision: Decision): NonNullable<PathPromptGuidance['fallback']> {
  const told1 = decision.finding === '' ? '' : `You told me this: ${bare(decision.finding)}.`;
  return {
    text: joined(
      told1,
      'One thing that happened is a fact to check, and no pattern yet: it may be the timing, the person or the offer. Write down which of your guesses it touches, and ask whoever it came from what happened before it, and what they did or paid.',
      'If it changes who pays or why, change the plan; if it does not, what you were doing stands.',
    ),
    voice: joined(
      told1,
      'It is one fact, and no pattern yet. Ask whoever it came from what happened before it, and change the plan only if it changes who pays or why.',
    ),
  };
}

/** The message to send, written out: never left to be described. */
function sendLead(input: PathTurnInput, decision: Decision): Lead | null {
  const template = messageOf(input, decision);
  if (template === null) return null;
  const facts = templateFacts(input, decision);
  const body = plainTemplate(fillTemplate(template.body, facts));
  const first =
    facts.customer === null ? '' : ` It goes first to ${lowerFirst(bare(facts.customer))} you can name.`;
  return {
    text: `Here is the message. Put what is true of them in the [brackets] and send it today.${first}\n\n"${body}"`,
    voice:
      'Keep it to three lines: who you are, what you want to learn about the last time it happened, and a request for fifteen minutes.',
  };
}

/** Whether the conversation already said who decides and what to bring. */
function referralTold(input: PathTurnInput, decision: Decision): boolean {
  const { referral } = decision;
  return (
    referral !== null &&
    (input.earlierReplies ?? []).some(
      (r) => stemsShared(referral.who, r) >= GAVE_IT && stemsShared(referral.bring, r) >= GAVE_IT,
    )
  );
}

/**
 * Who decides was said in this conversation, and what they ask now is not that again: not said once more. Only where the
 * message was read.
 */
function toldEnough(input: PathTurnInput, decision: Decision, u: Understanding | null): boolean {
  const { referral } = decision;
  if (u === null || referral === null || tellsLegalLetter(input.message)) return false;
  const who = referral.who.split(/[,;]/u)[0] ?? referral.who;
  const said = (input.earlierReplies ?? []).some((r) => stemsShared(who, r) >= GAVE_IT);
  return said && !asksRuling(u, input.message);
}

/** How to do the first part of the step, with its template filled in from what they told. */
function howToAsk(input: PathTurnInput, decision: Decision): Ask {
  const view = decision.step?.view;
  const left = view?.items.filter((i) => !i.done) ?? [];
  const [first] = left;
  if (view === undefined || first === undefined) return null;
  // The part they ask about, by its own words: its way alone.
  const asked = left[partAsked(input.message, left) ?? -1];
  if (asked !== undefined)
    return ask(
      `How to: ${bare(asked.do)}`,
      `${sentence(asked.do)} ${asked.how}`,
      'It is one part of the step.',
    );
  const time = first.minutes === null ? '' : ` It takes about ${String(first.minutes)} minutes.`;
  const made = ask(
    `How to start: ${view.title}`,
    `Start with the first part: ${lowerFirst(bare(first.do))}. ${first.how}${time}`,
    'One part you can finish today moves more than a plan for all of them.',
  );
  // Its template is filled in for the idea it is for.
  const told = decision.offered ? ideaTold(input) : '';
  const facts = templateFacts(input, decision);
  return made === null || view.template === null
    ? made
    : {
        ...made,
        block: plainTemplate(
          fillTemplate(
            view.template.body,
            told === ''
              ? facts
              : {
                  ...facts,
                  idea: told,
                  customer: customerIn(told),
                  problem: null,
                  who: whoIn(told),
                  today: null,
                  me: null,
                },
          ),
        ),
      };
}

/** The office or person alone, without what it is ("UR Ventures"). */
const shortWho = (who: string): string => bare(who.split(/[,;]/u)[0] ?? who);

/**
 * A push on what a qualified person decides, or on what is never shared: the same no, and what to do meanwhile. Said once
 * in full; a push after that gets a short no and the next thing to do, never the same words again.
 */
function pushAsk(input: PathTurnInput, decision: Decision): Ask {
  const { referral, play, step } = decision;
  const items = step?.view.items.filter((i) => !i.done) ?? [];
  const pushed = (input.earlierReplies ?? []).filter((r) => PUSHED.test(r)).length;
  const part = items[Math.min(pushed, Math.max(0, items.length - 1))];
  const go = part === undefined ? '' : `${sentence(part.do)} ${part.how}`;
  if (referral === null) {
    const no = [
      'No, not even a hint: I cannot share what another founder told me, the way I never share yours.',
      'Still no, and nobody can change that for me: what they share stays private, and so does yours.',
      'That stays private, and that answer will not change.',
    ][Math.min(pushed, 2)];
    const made = ask(
      play?.title ?? 'Not shared',
      `${no ?? ''} Here is what gets you further today. ${go}`,
      '',
    );
    return made === null || no === undefined ? made : { ...made, keeps: no };
  }
  if (referralTold(input, decision) && ASKS_WHO_AND_WHAT.test(plain(input.message)))
    return ask(
      'Who to see, and what to take',
      `See ${lowerFirst(shortWho(referral.who))}, and take this with you: ${lowerFirst(bare(referral.bring))}. Put it all in one folder and send it a day ahead, so the time goes to your question.`,
      'They can answer in one meeting when they see the papers first.',
    );
  if (!referralTold(input, decision))
    return ask(
      'Who decides this, and what to take',
      `This one is for ${lowerFirst(bare(referral.who))}: bring them ${lowerFirst(bare(referral.bring))}. I cannot decide it for you, and a yes or no from me would be a guess.`,
      'A wrong yes here is hard to undo, and they answer questions like this for free or early.',
    );
  const who = lowerFirst(shortWho(referral.who));
  const no = [
    `I still cannot decide that or promise it: only ${who} can, and a yes or no from me would be a guess.`,
    `No promise from me on this one; ${who} can give you a real answer.`,
    `That stays with ${who}.`,
  ][Math.min(pushed, 2)];
  return ask(
    'Who decides this, and the first part',
    `${no ?? ''} What you can do today is this. ${go}`,
    'The sooner they see it, the sooner you have an answer that holds.',
  );
}

/** They ask who it is and what to take, and push on nothing. */
const ASKS_WHO_AND_WHAT =
  /\b(?:who (?:exactly |else )?(?:do|should|can|would) (?:i|we)|what (?:exactly )?(?:do|should|would) (?:i|we) (?:need to )?(?:bring|take|send|show|prepare)|what to (?:bring|take))\b/;

/** A reply that already answered a push. */
const PUSHED =
  /a yes or no from me would be a guess|not even a hint|Still no, and nobody|No promise from me|That answer will not change/;

/** The step cut to their time: what it is now. */
function smallerAsk(input: PathTurnInput, decision: Decision): Ask {
  const items = decision.step?.view.items.filter((i) => !i.done) ?? [];
  const minutes = items.reduce((sum, i) => sum + (i.minutes ?? 0), 0);
  const timed = items.length > 0 && items.every((i) => i.minutes !== null);
  const doing = items.map((i) => lowerFirst(bare(i.do))).join('; then ');
  return ask(
    'A smaller version of the step',
    `Make it smaller: ${doing}. ${timed ? `That is about ${String(minutes)} minutes${fitsIn(input.message)}, and the rest waits${untilSaid(input)}.` : 'The rest waits, and what comes of this part tells you what to change in it.'}`,
    'A small part that is done this week is worth more than a whole step that is not.',
  );
}

/** "…, so it fits one evening", when they said the time they have. */
function fitsIn(message: string): string {
  const [time] = limitsIn(message).filter((l) => /\b(?:evening|hour|afternoon|morning|weekend)s?\b/.test(l));
  const had = time ?? timeSaid(message)?.said;
  return had === undefined ? '' : `, so it fits ${/^(?:one|an?|two|three) /.test(had) ? had : `your ${had}`}`;
}

/** "… until after the exam", when one is what it is too much before. */
function untilSaid(input: PathTurnInput): string {
  const what = /\b(?:before|until after|because of|with) (?:the |my |our )?(exams?|midterms?|finals?)\b/.exec(
    plain([...input.earlierMessages.slice(-2), input.message].join(' ')),
  )?.[1];
  return what === undefined ? '' : ` until after your ${what}`;
}

/** A step not done, a commitment made: said when the lead says nothing of it. Never asks for what they reported. */
function reportAsk(input: PathTurnInput, decision: Decision, lead: Lead | null): Ask {
  const { report, commitment, step } = decision;
  const parts: string[] = [];
  if (report?.state === 'not_yet') {
    parts.push(
      decision.movedTo === null
        ? 'That happens, and nothing is lost: the step stands.'
        : `That happens, and nothing is lost: the step moves to ${sayDue(input.today, decision.movedTo)}.`,
    );
    const offer = decision.smallerOffer?.items.find((i) => !i.done);
    if (offer !== undefined)
      parts.push(`If it is still too much, do one thing only: ${lowerFirst(bare(offer.do))}.`);
  } else if (lead === null && commitment !== null && step !== null) {
    const first = step.view.items.find((i) => !i.done);
    parts.push(
      'Good, that is a clear commitment.',
      first === undefined || first.do === step.view.title
        ? 'Write one line for each answer, in their words, the same day.'
        : `Begin with this: ${lowerFirst(bare(first.do))}.`,
    );
  }
  if (decision.smaller !== null) {
    const less = smallerAsk(input, decision)?.answer;
    if (less !== undefined) parts.push(less);
  }
  return parts.length === 0 ? null : ask('What they report, and what it changes', parts.join(' '), '');
}

// Their own facts --------------------------------------------------------------------------------------------------

/** Everything they said or that is on record of them, as one text: what a line written for them may claim. */
function saidText(input: PathTurnInput, decision: Decision): string {
  const u = decision.reading;
  const { continuity, reads, venture } = input;
  const intake = reads.path?.intake ?? null;
  const profile = continuity.studentProfile ?? null;
  return [
    ...input.earlierMessages,
    input.message,
    venture.name,
    venture.oneLiner,
    venture.currentGoal ?? '',
    intake === null
      ? ''
      : [intake.idea, intake.customer, intake.studies, intake.doneSoFar, intake.block].join('. '),
    profile === null ? '' : [profile.background, profile.learningGoal, profile.constraints].join('. '),
    ...reads.memory
      .filter((m) => m.status === 'confirmed' && !isReference(m))
      .map(
        (m) =>
          `${m.title}. ${m.content}. ${typeof m.attributes.result === 'string' ? m.attributes.result : ''}`,
      ),
    ...reads.criteria.map((c) => c.evidence ?? ''),
    ...reads.steps.map((s) => s.evidence ?? ''),
    ...(reads.path?.pivots ?? []).flatMap((p) => [p.from, p.to]),
    ...(continuity.notebook?.founderProfile ?? []).map((e) => e.text),
    decision.calc.lines.join(' '),
    // What was read of them, checked against all of it.
    ...(u === null
      ? []
      : [...u.record.map((r) => r.text), ...u.sums.map((x) => sumOfReading(u, x, input.message))]),
  ]
    .filter((t) => t.trim() !== '')
    .join('\n')
    .slice(0, SAID_CHARS);
}

const SAID_CHARS = 12_000;

/** The one thing on record the answer builds on; none where the lead is the record itself. */
function priorOf(input: PathTurnInput, decision: Decision, lead: Lead | null): PathPromptGuidance['prior'] {
  const { kind, play } = decision;
  // A push is answered with a no and the next part; what it is about was said. What was said is said again, no more.
  if (decision.pushes || decision.restates !== null) return null;
  if (kind === 'recall' || kind === 'social' || kind === 'rehearsal') return null;
  if (kind === 'new_idea') return null;
  const source = priorSource(input, decision, lead);
  const found = priorFact({
    ...source,
    applies: kind === 'coaching' && lead === null && play !== null,
    // What a person decides, and a judgement, are the program's words: something of theirs always stands beside them.
    always: play !== null && (decision.referral !== null || JUDGEMENT_PLAYS.has(play.id)),
  });
  // Short enough to be heard, it is said on a call too.
  const heard =
    found === null ||
    found.spoken !== undefined ||
    found.sentence === '' ||
    found.sentence.split(' ').length > SPOKEN_FACT_WORDS
      ? found
      : { ...found, spoken: found.sentence };
  if (play === null || lead !== null || kind !== 'coaching' || !JUDGEMENT_PLAYS.has(play.id)) return heard;
  // A judgement names what they have and what is missing.
  const r = readingIn(input, decision);
  const gap = gapFor(play.id, r, input.venture.name);
  const has =
    r.have !== ''
      ? r.have
      : found === null || found.sentence === ''
        ? ''
        : `${upperFirst(bare(found.sentence))}.`;
  const last = (input.earlierReplies ?? []).at(-1) ?? '';
  const missing = gap === '' || (input.earlierReplies ?? []).some((r) => saysMost(r, gap)) ? '' : gap;
  // Their record is not told twice in a row on the same question, and stands beside another one's answer.
  const same = input.previous?.step?.playId === play.id;
  const whole = joined(has === '' || (same && r.have !== '' && saysMost(last, has)) ? '' : has, missing);
  if (whole === '') return heard;
  // On a call too, nothing of it twice in a row.
  const lately = (input.earlierReplies ?? []).slice(-2);
  const saidHave =
    r.have !== '' && ((same && saysMost(last, r.have)) || lately.some((x) => saysMost(x, r.have)));
  const both = joined(saidHave ? '' : r.have, missing);
  const spoken = both.split(' ').length <= SPOKEN_PRIOR_WORDS ? both : saidHave ? '' : r.have;
  return {
    fact: r.best !== '' ? r.best : (found?.fact ?? r.problem),
    sentence: whole,
    ...(spoken !== '' && spoken.split(' ').length <= SPOKEN_PRIOR_WORDS ? { spoken } : {}),
    ...(missing === '' ? {} : { gap: missing }),
  };
}

/** Most words of what they have and lack, and of another fact of theirs, said on a call. */
const SPOKEN_PRIOR_WORDS = 30;
const SPOKEN_FACT_WORDS = 18;

/** The idea of their own words the conversation turned to, short ("AI helpers that fill in the paperwork of clinics"). */
function ideaTold(input: PathTurnInput): string {
  for (const text of [...input.earlierMessages].reverse()) {
    const m =
      /\b(?:what about|how about|idea (?:is|for|of)|thinking (?:of|about)) (?:an? )?([^.?!]{12,140})/i.exec(
        text,
      );
    if (m?.[1] !== undefined) return lowerFirst(bare(shortOf(toYou(m[1]))));
  }
  return '';
}

interface TemplateFacts {
  readonly idea: string | null;
  readonly customer: string | null;
  readonly venture: string | null;
  readonly founder: string | null;
  /** What goes wrong today, in their words. */
  readonly problem?: string | null;
  /** Who it is for as their idea says it whole, what people do now, and what they themselves do ("I write …"). */
  readonly who?: string | null;
  readonly today?: string | null;
  readonly me?: string | null;
}

function templateFacts(input: PathTurnInput, decision: Decision): TemplateFacts {
  const told1 = input.reads.path?.intake?.customer.trim() ?? '';
  const name = bare(input.venture.name);
  const idea = ideaOf(input, decision);
  const customer = told1 === '' ? (idea === null ? null : customerIn(idea)) : told1;
  const texts = [input.message, ...[...input.earlierMessages].reverse()];
  return {
    idea,
    customer: customer === null ? null : bare(customer),
    venture: name === '' || /^new venture\b/i.test(name) ? null : name,
    founder: input.continuity.founderFirstName ?? null,
    problem:
      problemIn(
        [input.message, ...[...input.earlierMessages].reverse()],
        [input.venture.name, input.venture.oneLiner, idea ?? ''],
      ) || null,
    who:
      told1 !== ''
        ? null
        : ([idea ?? '', input.venture.oneLiner, ...texts.filter((t) => statedIdea(t, name) !== null)]
            .map(whoIn)
            .find((x) => x !== null) ?? null),
    today: todayIn(texts),
    me: meIn(texts),
  };
}

/** Who an idea is for, when its own words say it ("bike repair for people in dorms" → "people in dorms"). */
export function customerIn(idea: string): string | null {
  const tail = String.raw`(?: (?:in|on|at|with|who) (?:[a-z'-]+ ?){1,3})?(?=[.,;:!?]|$| so\b| and\b| without\b| that\b| late\b| every\b| instead\b| by\b| each\b| from\b| when\b| between\b| near\b)`;
  const people =
    '(?:people|students|nurses|parents|teachers|founders|owners|managers|clinics|labs|shops|schools|clubs|groups|families|farmers|cooks|caterers|teams|beginners|athletes|offices|restaurants|hotels|companies|doctors|dentists|renters|drivers|runners|hikers|rangers|marinas|gyms|salons|cafes|bakeries|kids|children|seniors|patients|tutors|landlords|housemates|roommates)';
  const m =
    new RegExp(`\\b(?:for|to|between|by) ((?:[a-z'-]+ ){0,2}?${people}${tail})`, 'i').exec(idea) ??
    new RegExp(
      `\\bfor ((?:[a-z'-]+ ){0,2}?(?!(?:elevators|sensors|motors|monitors|scooters|computers|printers|refrigerators|containers|trailers|chargers|filters|papers|posters|numbers|letters|orders|flowers|parents)\\b)[a-z]{3,}(?:ers|ors|ists|ians)${tail})`,
      'i',
    ).exec(idea);
  const who = m?.[1]?.trim() ?? '';
  return who === '' ? null : lowerFirst(who);
}

/** Who it is for, the way that says most of them. */
function whoSaid(facts: TemplateFacts): string | null {
  const { customer } = facts;
  const who = facts.who ?? null;
  if (who === null || customer === null) return who ?? customer;
  return customer.toLowerCase().includes(who.toLowerCase()) ? customer : who;
}

/** A template with what they told in its brackets, and the brackets of what they did not. */
export function fillTemplate(body: string, facts: TemplateFacts): string {
  return body.replace(/\[([^\]\n]{2,80})\]/g, (whole, slot: string) => {
    const t = slot.toLowerCase();
    if (/^your (?:first )?name$|^my name$/.test(t)) return facts.founder ?? whole;
    if (/\b(?:what (?:i|we) would (?:do|make|offer|build)|(?:my|the|your) (?:idea|offer|product)\b)/.test(t))
      return facts.idea === null ? whole : lowerFirst(facts.idea);
    if (/^(?:one )?type of person|^(?:the )?customer$|^who (?:it is for|has (?:it|the problem))/.test(t))
      return lowerFirst(whoSaid(facts) ?? whole);
    // The company of an agreement is the other side of it.
    if (/^(?:venture|venture name|product name)$/.test(t)) return facts.venture ?? whole;
    if (/^what goes wrong\b/.test(t)) return facts.problem ?? whole;
    if (/^what (?:they|people) do (?:about it )?now\b/.test(t)) return facts.today ?? whole;
    if (/^what i know\b/.test(t)) return facts.me ?? whole;
    return whole;
  });
}

/** The shown evidence that is the play's own sources (by their titles), for its citations. */
export function evidenceKeysOf(
  playbook: Playbook,
  decision: Decision,
  shown: readonly Pick<EvidenceItem, 'key' | 'title' | 'kind'>[],
): string[] {
  const play = evidencePlayOf(playbook, decision);
  if (play === null) return [];
  const titles = play.citations.flatMap((c) => {
    const source = playbook.sources.find((s) => s.id === c.sourceId);
    return source === undefined ? [] : [plain(source.title)];
  });
  const playTitle = plain(play.title);
  return shown
    .filter((item) => item.kind === 'chunk' || item.kind === 'resource')
    .filter((item) => {
      const title = plain(item.title);
      return title.includes(playTitle) || titles.some((t) => title.includes(t));
    })
    .map((item) => item.key)
    .slice(0, 4);
}

/** The prompt's guidance with the citations its answer may use. */
export function withEvidenceKeys(prompt: PathPromptGuidance, keys: readonly string[]): PathPromptGuidance {
  return prompt.ask === null || keys.length === 0
    ? prompt
    : { ...prompt, ask: { ...prompt.ask, evidenceKeys: keys } };
}

/** The decided step as the turn's next action, so call summaries and recaps name the same step. */
export function nextActionsOf(
  decision: Decision,
): { owner: string; action: string; target_date: string | null }[] | null {
  if (decision.step === null) return null;
  return [{ owner: 'founder', action: decision.step.view.title, target_date: decision.step.view.dueOn }];
}

/** What they might send next about the step, as tap-to-send messages the path answers by itself. */
export function followUpsOf(decision: Decision): string[] {
  const { kind, step } = decision;
  if (step === null || !['coaching', 'report', 'news', 'new_idea'].includes(kind)) return [];
  return [
    ...(decision.howTo ? [] : [HOW_FOLLOW_UP]),
    ...(decision.smaller === null ? [SMALLER_FOLLOW_UP] : []),
  ];
}

const SMALLER_FOLLOW_UP = 'That is too much this week. Can you make it smaller?';
