import { type Understanding } from '@foundry/ai';
import {
  type PathCheckIn,
  type PathCriterion,
  type PathStepView,
  type Play,
  type RiskCategory,
  type TurnGuidance,
  type VentureStage,
} from '@foundry/contracts';
import { type pathRepo, type retrievalRepo } from '@foundry/db';

import { isReference } from './brief.js';
import { calcAsked, calcOf, type CalcAsk, type CalcResult, type Ratio } from './calc.js';
import { choiceIn, settledWay, type Choice } from './choice.js';
import { addDays, daySaid, dueOnFor } from './dates.js';
import {
  asksAboutReply,
  asksFor,
  asksForTemplate,
  asksMessage,
  asksWhenDone,
  asksHowTo,
  asksIfNeeded,
  asksMeaning,
  asksOneThing,
  asksOverview,
  asksRecall,
  bringsNewIdea,
  commitmentOf,
  isCommitted,
  isFragment,
  isHardship,
  isInDistress,
  isReaction,
  isRehearsal,
  isSocial,
  isVenting,
  namesOthers,
  needsAPerson,
  rejectsAdvice,
  ownSentences,
  ownWords,
  partAsked,
  pivotOf,
  pushesOn,
  reportFinishes,
  reportOf,
  saysFirstTime,
  smallerOf,
  statedIdea,
  statesNeed,
  type Commitment,
  type MessageReport,
  type Pivot,
  type Restating,
  type SmallerAsk,
} from './kinds.js';
import {
  meaningWords,
  nearestWords,
  phraseIntent,
  pointsBack,
  refersBack,
  type Asking,
  type IntentMatch,
} from './match.js';
import { asksIfGood, findingIn, lastResult, newsOf, tellsNews, type News, type NewsKind } from './news.js';
import { reportedWork, withWork, type AppliedWork, type ReportedWork } from './progress.js';
import { offersForShares, referralForRisk } from './referrals.js';
import { isCompany } from './reading.js';
import { pickPlay, playMatchProfile, type Openness, type SemanticMatch } from './semantic.js';
import {
  earlierDay,
  earlierEvidence,
  hasEvidence,
  ideaText,
  isShownCriterion,
  missingOf,
  pathState,
  progressIn,
  recordShowing,
  stageOrder,
  wordsOfEvidence,
  type PathSource,
  type PathState,
} from './state.js';
import { asksToStop } from './openings.js';
import {
  askWhyStep,
  citationsOf,
  deadlineOf,
  isOpen,
  nowStep,
  openCriterionOf,
  ownStep,
  pickedChannel,
  pickTested,
  playOf,
  restOf,
  shownStep,
  smallerStep,
  stepFor,
  stepView,
  type ChosenStep,
  type StepContext,
} from './steps.js';
import { concrete, currentOnes, stillTrue, toYou, toldAs } from './tell.js';
import { type PathIntent, type Playbook } from './types.js';
import {
  askedOf,
  asksOfWork,
  asksWholePath,
  decides,
  fitsAsk,
  handsOn,
  NOTHING,
  picksAgainst,
  referralPlayOf,
  sameSubject,
  settled,
  speaks,
  tellsLegalLetter,
  testsAPick,
  type Decides,
  type Weighed,
  type WeighedField,
} from './understood.js';
import { contentStems, countsIn, plain, sentences, subjectStems } from './words.js';

export { stepView, type ChosenStep, type StepContext } from './steps.js';

/**
 * The founder path's engine: pure, no I/O, no model, no clock (today is given). The same input always gives the same
 * decision, to the byte; a reply explains the step it chose and never chooses another.
 *
 * The turn's step is the one their message is about: the play's own step when they ask something a play answers, by a
 * phrase of it (a referral's first) or, with none, by meaning (it
 * becomes the path's step when it shows what the stage still asks for, else it is offered), the step of the turn before
 * when they go on about it, and the path's own step when they ask what is next, report, or open the conversation.
 */
export type TurnKind =
  'coaching' | 'report' | 'news' | 'recall' | 'social' | 'rehearsal' | 'new_idea' | 'crisis';

export interface DecideInput extends PathSource {
  readonly playbook: Playbook;
  /** ISO date (YYYY-MM-DD). */
  readonly today: string;
  readonly message: string;
  /** The coach's last message (its reply, or the conversation's opener). */
  readonly previousReply: string | null;
  /** What the latest earlier turn of this conversation that gave a step decided (stored with it); null: none. */
  readonly previous?: TurnGuidance | null;
  /** The mode the founder chose, the counterpart they named, and the conversation's own mode. */
  readonly mode: string | null;
  readonly counterpart: string | null;
  readonly conversationMode: string | null;
  readonly crisis: boolean;
  /** The risk classifier's categories: a referral's own ask when no phrase names it. */
  readonly riskCategories: readonly RiskCategory[];
  /** Text of the record beyond memory (notes, summaries): what "the venture's record holds" also means. */
  readonly recordText: string;
  /** The founder's earlier messages in this conversation and what is known of their background. */
  readonly background: readonly string[];
  /** The founder's earlier messages in this conversation alone, oldest first. */
  readonly earlierMessages?: readonly string[];
  /** The conversation is already under way (a check-in is asked once, at its start). */
  readonly started: boolean;
  /**
   * The plays the message is nearest to by its embedding: read only when no phrase names one ({@link Decision.open}).
   * `unavailable`: they could not be read (late, failed, off), and the nearest words stand in, held to much more
   * (match.ts `NEAREST_WORDS`). Absent or null: not read yet, and the phrases alone.
   */
  readonly near?: retrievalRepo.NearPlays | 'unavailable' | null;
  /** What the message asks, read against the record and checked (understood.ts). Null or absent: the rules alone. */
  readonly understanding?: Understanding | null;
}

/** A change of direction: the idea it was and is, and what the old customer had shown, open again. */
export interface AppliedPivot extends Pivot {
  readonly from: string;
  readonly reopened: readonly PathCriterion[];
  /** What had been shown of those, in their words, kept with its day (it counts for nothing now). */
  readonly kept: readonly { readonly criterionId: string; readonly evidence: string }[];
  /** What the idea they go back to had shown, counting again. */
  readonly restored: readonly {
    readonly criterion: PathCriterion;
    readonly status: 'claimed' | 'open';
    readonly evidence: string | null;
    readonly sourceSessionId: string | null;
  }[];
  /** Steps in their own words that were about the old direction: they end with it. */
  readonly ends: readonly pathRepo.PathStepRecord[];
  /** The stage the path stands at now. */
  readonly stage: VentureStage;
}

export interface Decision {
  readonly kind: TurnKind;
  /** The ask's intent in the playbook's table, `overview` for "get me organized", or null. */
  readonly intent: string | null;
  readonly matched: IntentMatch['how'] | 'risk' | 'rule' | 'previous' | 'semantic' | 'reading' | null;
  /** The similarity of the nearest play, when the message was compared with them (whether or not it was chosen). */
  readonly score: number | null;
  /** No phrase names what they ask, and it may be matched by meaning (semantic.ts); null: nothing to match. */
  readonly open: Openness | null;
  /** The play that answers the ask; null when they asked nothing the playbook covers. */
  readonly play: Play | null;
  /** The whole path is the answer. */
  readonly overview: boolean;
  readonly state: PathState;
  readonly stageTitle: string;
  readonly stageCount: number;
  /** The turn's step. */
  readonly step: ChosenStep | null;
  /** The turn's step is not on their path: stored only when they tick, finish or add it. */
  readonly offered: boolean;
  /** The path's own open step, when the turn's is another one that is only offered. */
  readonly pathStep: PathStepView | null;
  /**
   * The step to store, as its row reads (the turn's own, or one a message that shows none takes up: "got it, I'll do eight
   * of those this week"); null: nothing to store.
   */
  readonly keeps: ChosenStep | null;
  /** The first turn that gives this venture a step: its path begins, at the stage it stands at. */
  readonly begins: boolean;
  /** The turn goes on about the step of the turn before. */
  readonly carried: boolean;
  /** What follows the step, in order. */
  readonly then: readonly PathStepView[];
  readonly missing: readonly PathCriterion[];
  readonly referral: Play['referral'];
  /** They push on what a qualified person decides, or on what is never shared: the answer stays. */
  readonly pushes: boolean;
  readonly report: MessageReport | null;
  /**
   * The founder's report finishes this stored step: it is completed with their words, and the step above is the next
   * (`rest`: only the small part of it was done, and the rest goes on).
   */
  readonly completes: {
    readonly step: pathRepo.PathStepRecord;
    readonly evidence: string;
    readonly rest: ReturnType<typeof restOf>;
  } | null;
  /** Work they report beyond the step, and what it changes. */
  readonly work: readonly ReportedWork[];
  readonly applied: AppliedWork | null;
  /** The step was not done: the day it moved to. */
  readonly movedTo: string | null;
  /** They asked for less: what the step was cut to. */
  readonly smaller: SmallerAsk | null;
  /** The smaller form of the step, to offer (a step not done). */
  readonly smallerOffer: PathStepView | null;
  readonly commitment: Commitment | null;
  /** The idea in their own words, to keep (the venture has none yet). */
  readonly idea: string | null;
  readonly pivot: AppliedPivot | null;
  readonly checkIn: PathCheckIn | null;
  /** The choice they asked to have made, with the pick what they told decides; null: none. */
  readonly choice: Choice | null;
  readonly newIdea: { readonly ventureName: string; readonly fact: string | null } | null;
  readonly firstTime: boolean;
  /** They say in this message that they have never done this. */
  readonly firstTimeNow: boolean;
  /** What the message tells without asking, and what it means (news.ts); null: nothing of the kind. */
  readonly news: News | null;
  /** They ask whether the result they told last is any good: that result. */
  readonly result: Ratio | null;
  /** The sums of their own numbers (calc.ts). */
  readonly calc: CalcResult;
  /** They ask how to do the step just given: its first item is the answer. */
  readonly howTo: boolean;
  /** They ask when the step is done: its done-when is the answer. */
  readonly whenDone: boolean;
  /** They ask for the message to send: its template is the answer. */
  readonly message: boolean;
  /** They ask to have the step's template written out. */
  readonly fills: boolean;
  /** They ask for the reply just given in other words; null: nothing of it. */
  readonly restates: Restating | null;
  /** They reject what they were just told, and ask nothing else. */
  readonly rejects: boolean;
  /** What they just told is acted on by this play, whose step is the turn's; null: the path's own step stands. */
  readonly actsOn: Play | null;
  /** What they say came of it, in their own words said back; '' when they tell none. */
  readonly finding: string;
  /** They tell how hard it is, and ask nothing of the work. */
  readonly vents: boolean;
  /** One thing to do is asked, and the last result they told is a weak one: the ones it came from are asked why. */
  readonly weak: Ratio | null;
  /** The day the turn's step was due, when it passed and the step has another day now. */
  readonly wasDue: string | null;
  /** The reading the turn rests on; null: the rules alone decided. */
  readonly reading: Understanding | null;
  /** Who decided what, where a reading was weighed (understood.ts `PRECEDENCE`): ids for the log, never words. */
  readonly decidedBy: Readonly<Record<WeighedField, Decides>> | null;
}

// ------------------------------------------------------------------------------------------------
// The path's own step
// ------------------------------------------------------------------------------------------------

/** A criterion's open step, or the play that produces its evidence. */
interface Candidate {
  readonly criterion: PathCriterion;
  readonly play: Play;
  /** Its step is blocked, or was skipped last. */
  readonly setAside: boolean;
}

function candidates(context: StepContext, state: PathState): Candidate[] {
  const { playbook, reads } = context;
  const out: Candidate[] = [];
  const order = stageOrder(playbook);
  for (let i = state.stageIndex; i < order.length; i += 1) {
    for (const c of state.criteria) {
      if (c.criterion.stage !== order[i] || c.status !== 'open') continue;
      // The step they are already on for it, whichever play it is of; else the criterion's own play.
      const given = reads.steps
        .filter((s) => s.criterionId === c.criterion.id && s.origin === 'path' && isOpen(s))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const play =
        playOf(
          playbook,
          given.find((s) => s.playId === c.criterion.playId)?.playId ?? given[0]?.playId ?? null,
        ) ?? playOf(playbook, c.criterion.playId);
      if (play === null || out.some((o) => o.play.id === play.id)) continue;
      const own = reads.steps.filter((s) => s.playId === play.id && s.origin === 'path');
      const latestClosed = own
        .filter((s) => !isOpen(s))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .at(-1);
      const open = own.find(isOpen);
      out.push({
        criterion: c.criterion,
        play,
        setAside: open === undefined ? latestClosed?.status === 'skipped' : open.status === 'blocked',
      });
    }
  }
  return capstonesLast(context, out);
}

/** A capstone of the curriculum ("ain-canvas-capstone"). */
const CAPSTONE = /^ain-.*-capstone$/;
const COURSE_DEADLINE =
  /\b(?:capstone|canvas|module|course|class|assignment|submission|submit|program(?:me)?|business plan|pitch deck)\b/i;

/**
 * The venture's own next evidence before a curriculum capstone of the same stage, unless the deadline they gave is the
 * capstone's: then it comes first.
 */
function capstonesLast(context: StepContext, all: Candidate[]): Candidate[] {
  const deadline = context.reads.path?.intake?.deadline ?? null;
  const due = deadline !== null && deadline.on >= context.today && COURSE_DEADLINE.test(deadline.what);
  const order = stageOrder(context.playbook);
  return all
    .map((c, i) => ({
      c,
      i,
      stage: order.indexOf(c.criterion.stage),
      last: !CAPSTONE.test(c.play.id) ? 0 : due ? -1 : 1,
    }))
    .sort((a, b) => a.stage - b.stage || a.last - b.last || a.i - b.i)
    .map((x) => x.c);
}

/**
 * The step the path is on: the stored one while what it produces is still to show, else the first criterion of the
 * current stage still to show (in the playbook's order), else what follows. What was skipped or is blocked waits until
 * nothing else of the stage is left.
 */
export function currentStep(context: StepContext, state: PathState): ChosenStep | null {
  const { playbook, reads } = context;
  const stored = reads.steps
    .filter(
      (s) =>
        s.status === 'now' &&
        !(s.origin === 'path' && s.playId !== null && playOf(playbook, s.playId) === null),
    )
    .filter((s) => s.criterionId === null || !isShownCriterion(state, s.criterionId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const first = stored[0];
  if (first !== undefined) return { view: stepView(first), write: null, storedVersion: first.version };
  const all = candidates(context, state);
  const inStage = all.filter((c) => c.criterion.stage === state.stage);
  const pick = inStage.find((c) => !c.setAside) ?? all.find((c) => !c.setAside) ?? inStage[0] ?? all[0];
  return pick === undefined ? null : nowStep(context, pick.play, pick.criterion.id);
}

/** What follows `step` on the path, in order (at most `most`), one step for each criterion. */
export function followingSteps(
  context: StepContext,
  state: PathState,
  step: ChosenStep | null,
  most: number,
): PathStepView[] {
  const out: PathStepView[] = [];
  const taken = new Set([step?.view.id]);
  const criteria = new Set(step?.view.criterionId == null ? [] : [step.view.criterionId]);
  const add = (view: PathStepView): void => {
    if (out.length >= most || taken.has(view.id)) return;
    if (view.criterionId !== null && criteria.has(view.criterionId)) return;
    taken.add(view.id);
    if (view.criterionId !== null) criteria.add(view.criterionId);
    out.push(view);
  };
  const waiting = context.reads.steps
    .filter((s) => s.status === 'next' || s.status === 'now' || s.status === 'blocked')
    .filter((s) => s.criterionId === null || !isShownCriterion(state, s.criterionId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const row of waiting) add({ ...stepView(row), status: row.status === 'blocked' ? 'blocked' : 'next' });
  for (const c of candidates(context, state)) {
    if (out.length >= most) break;
    if (c.play.id === step?.view.playId || out.some((o) => o.playId === c.play.id)) continue;
    add(stepFor(context, c.play, { status: 'next', criterionId: c.criterion.id }).view);
  }
  for (const view of playsAfter(context, state, playOf(context.playbook, step?.view.playId ?? null)))
    if (!out.some((o) => o.playId === view.playId) && view.playId !== step?.view.playId) add(view);
  return out;
}

/** The plays that follow `play` by its own account, still worth doing. */
function playsAfter(context: StepContext, state: PathState, play: Play | null): PathStepView[] {
  return (play?.next ?? []).flatMap((id) => {
    const follows = playOf(context.playbook, id);
    if (follows === null) return [];
    if (follows.criteria.length > 0 && follows.criteria.every((c) => isShownCriterion(state, c))) return [];
    return [stepFor(context, follows, { status: 'next', criterionId: null }).view];
  });
}

/** The last step given, when it was given before today or is due: what a conversation asks about first. */
export function checkInOf(
  context: Pick<StepContext, 'today'>,
  steps: readonly pathRepo.PathStepRecord[],
  principalId?: string,
): PathCheckIn | null {
  const step = steps
    .filter((s) => s.status === 'now')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
  if (step === undefined) return null;
  if (principalId !== undefined && step.givenTo !== null && step.givenTo !== principalId) return null;
  const given = step.createdAt.slice(0, 10);
  const due = step.dueOn !== null && step.dueOn <= context.today;
  if (given >= context.today && !due) return null;
  return {
    stepId: step.id,
    title: step.title,
    dueOn: step.dueOn,
    overdue: step.dueOn !== null && step.dueOn < context.today,
    version: step.version,
  };
}

// ------------------------------------------------------------------------------------------------
// The turn's step
// ------------------------------------------------------------------------------------------------

interface TurnStep {
  readonly step: ChosenStep | null;
  readonly offered: boolean;
}

const asItIs = (view: PathStepView, row: pathRepo.PathStepRecord): ChosenStep => ({
  view,
  write: null,
  storedVersion: row.version,
});

/**
 * The step of the play that answers their ask. The play of a criterion the current stage still asks for becomes the
 * path's step (the one before waits, as it is); one already on the path is shown as it is; any other is offered.
 */
function askStep(context: StepContext, state: PathState, play: Play, own: ChosenStep | null): TurnStep {
  if (own?.view.playId === play.id) return { step: own, offered: false };
  const here = openCriterionOf(state, play, true);
  const row = context.reads.steps.find((s) => s.playId === play.id && s.origin === 'path' && isOpen(s));
  // What they said they would do, in their own words, is never displaced by an ask.
  const theirs = own?.view.origin === 'founder' && own.view.status === 'now';
  if (here !== null && row?.status !== 'blocked' && !theirs)
    return { step: nowStep(context, play, here), offered: false };
  if (row !== undefined) {
    const view = stepView(row);
    if (row.status !== 'later') return { step: asItIs(view, row), offered: false };
    // Offered before in the form they asked for (a smaller one): the same step, with a day they can still make.
    const dueOn =
      view.dueOn !== null && view.dueOn < context.today
        ? dueOnFor(context.today, play.days, deadlineOf(context))
        : view.dueOn;
    return { step: asItIs({ ...view, dueOn }, row), offered: true };
  }
  const { view } = stepFor(context, play, {
    status: 'later',
    criterionId: here ?? openCriterionOf(state, play, false),
  });
  return {
    step: {
      view: { ...view, dueOn: dueOnFor(context.today, play.days, deadlineOf(context)) },
      write: null,
      storedVersion: null,
    },
    offered: true,
  };
}

/** The step of the turn before, as it stands now; null when there was none or it is closed. */
function stepBefore(
  context: StepContext,
  previous: TurnGuidance | null,
  own: ChosenStep | null,
): TurnStep | null {
  const shown = previous?.step ?? null;
  if (shown === null) return null;
  if (own?.view.id === shown.id) return { step: own, offered: false };
  const row = context.reads.steps.find((s) => s.id === shown.id);
  if (row !== undefined) return isOpen(row) ? { step: asItIs(stepView(row), row), offered: false } : null;
  // Never stored: offered, shown as that turn showed it; the path's own step that was not stored is derived again.
  return previous?.offered === true
    ? { step: { view: { ...shown }, write: null, storedVersion: null }, offered: true }
    : null;
}

/** The first step of an idea that is not this venture's: the first play of the first stage, offered beside the path. */
function ideaStep(context: StepContext): TurnStep | null {
  const { playbook } = context;
  const stage = playbook.stages[0]?.stage;
  const criterion = playbook.criteria.find((c) => c.stage === stage && playOf(playbook, c.playId) !== null);
  const play =
    playOf(playbook, criterion?.playId ?? null) ?? playbook.plays.find((x) => x.stage === stage) ?? null;
  if (play === null) return null;
  const { view, row } = stepFor(context, play, { status: 'later', criterionId: null, origin: 'coach' });
  if (row !== null) return { step: asItIs(view, row), offered: row.status === 'later' };
  return {
    step: {
      view: { ...view, dueOn: dueOnFor(context.today, play.days, null) },
      write: null,
      storedVersion: null,
    },
    offered: true,
  };
}

/**
 * The play that acts on what they just told: somebody else pays, asks for it, refuses for a reason, has a spending rule, offers
 * a trial or money; someone left; a page brought sign-ups. Its step is the turn's, offered beside the path's own.
 */
const NEWS_PLAYS: Readonly<Partial<Record<NewsKind, { readonly company: string; readonly person: string }>>> =
  {
    split: { company: 'will-anyone-pay', person: 'will-anyone-pay' },
    pull: { company: 'pilot-agreement', person: 'pre-sale' },
    offer: { company: 'pilot-agreement', person: 'pilot-agreement' },
    refusal: { company: 'competitors', person: 'competitors' },
    limit: { company: 'b2b-selling', person: 'b2b-selling' },
    interest: { company: 'letter-of-intent', person: 'pre-sale' },
    cold: { company: 'pre-sale', person: 'pre-sale' },
    yes: { company: 'letter-of-intent', person: 'pre-sale' },
    paid: { company: 'first-ten-customers', person: 'pre-sale' },
    barrier: { company: 'smallest-test', person: 'smallest-test' },
    left: { company: 'retention', person: 'retention' },
    concentration: { company: 'channel-choice', person: 'channel-choice' },
    funding: { company: 'friends-family-money', person: 'friends-family-money' },
    disclosure: { company: 'patent-now-or-wait', person: 'patent-now-or-wait' },
    meeting: { company: 'investor-meeting', person: 'investor-meeting' },
    free: { company: 'concierge-test', person: 'concierge-test' },
    praise: { company: 'friends-love-it', person: 'friends-love-it' },
  };
/** What a report beside it changes: the customer, the buyer or the way in, whatever else it counts. */
const MOVES_THE_CUSTOMER: ReadonlySet<NewsKind> = new Set<NewsKind>([
  'split',
  'pull',
  'offer',
  'refusal',
  'limit',
  'yes',
  'paid',
  'interest',
  'cold',
  'barrier',
  'free',
  'praise',
  'left',
  'funding',
  'disclosure',
]);

/** Early proof of the same kind a later stage already has: there the path's own step goes on. */
const EARLY_PROOF: ReadonlySet<NewsKind> = new Set<NewsKind>([
  'paid',
  'yes',
  'interest',
  'cold',
  'free',
  'praise',
]);

/** What they charge, changed. */
const OF_A_PRICE = /\b(?:fee|price|rate|charge|cost)s?\b/i;

function playOn(playbook: Playbook, state: PathState, news: News, message: string): Play | null {
  if (news.kind === 'change') return OF_A_PRICE.test(message) ? playOf(playbook, 'pricing') : null;
  const plays = NEWS_PLAYS[news.kind];
  if (plays === undefined) return null;
  if (EARLY_PROOF.has(news.kind) && state.stageIndex >= stageOrder(playbook).indexOf('commercialization'))
    return null;
  return playOf(playbook, isCompany(message) ? plays.company : plays.person);
}

/** The step of the play that acts on what they told: offered, unless it is the step they are on. */
function newsStep(context: StepContext, state: PathState, play: Play, own: ChosenStep | null): TurnStep {
  if (own?.view.playId === play.id) return { step: own, offered: false };
  const row = context.reads.steps.find((s) => s.playId === play.id && s.origin === 'path' && isOpen(s));
  if (row !== undefined) return { step: asItIs(stepView(row), row), offered: row.status === 'later' };
  const { view } = stepFor(context, play, {
    status: 'later',
    criterionId: openCriterionOf(state, play, false),
  });
  return {
    step: {
      view: { ...view, dueOn: dueOnFor(context.today, play.days, deadlineOf(context)) },
      write: null,
      storedVersion: null,
    },
    offered: true,
  };
}

/** The step as it becomes theirs to do now, on the day they said. */
function taken(context: StepContext, turn: TurnStep, dueOn: string | null): ChosenStep | null {
  const { step } = turn;
  if (step === null) return null;
  const row = context.reads.steps.find((s) => s.id === step.view.id);
  const view: PathStepView = { ...step.view, status: 'now', dueOn: dueOn ?? step.view.dueOn };
  if (row === undefined) return { view, write: 'insert', storedVersion: null };
  if (row.status !== 'now') return { view, write: 'promote', storedVersion: row.version };
  return row.dueOn === view.dueOn
    ? { view, write: null, storedVersion: row.version }
    : { view, write: 'change', storedVersion: row.version };
}

/** The turn's step cut to what they have time for; null when it fits as it is. */
function cut(context: StepContext, turn: TurnStep, ask: SmallerAsk): ChosenStep | null {
  const { step } = turn;
  if (step === null) return null;
  const view = smallerStep(step.view, ask, context.today);
  if (view === null) return null;
  // Offered, it is kept in this form (not on their path): asked again, it is this step and no other.
  if (turn.offered)
    return {
      view,
      write: step.storedVersion === null ? 'insert' : 'change',
      storedVersion: step.storedVersion,
    };
  return {
    view,
    write: step.write === 'insert' || step.write === 'promote' ? step.write : 'change',
    storedVersion: step.storedVersion,
  };
}

const isPast = (step: ChosenStep, today: string): boolean =>
  step.view.dueOn !== null && step.view.dueOn < today;

/** A step not done moves to a day they can still make (one still ahead keeps its day). */
function moved(context: StepContext, step: ChosenStep, play: Play | null): ChosenStep | null {
  if (step.view.dueOn !== null && step.view.dueOn > addDays(context.today, 1)) return null;
  const dueOn = dueOnFor(context.today, Math.min(play?.days ?? 4, 7), deadlineOf(context));
  if (dueOn === step.view.dueOn) return null;
  return {
    view: { ...step.view, dueOn },
    write: step.write ?? 'change',
    storedVersion: step.storedVersion,
  };
}

// ------------------------------------------------------------------------------------------------
// The decision
// ------------------------------------------------------------------------------------------------

/** One concrete fact of the venture's record: a confirmed one with a figure first, then any confirmed one. */
export function concreteFact(
  memory: readonly pathRepo.PathMemory[],
  founder = '',
  today?: string,
): string | null {
  const ranked = currentOnes(memory).filter(
    (m) =>
      m.status === 'confirmed' &&
      ['evidence', 'fact', 'milestone', 'decision'].includes(m.type) &&
      !isReference(m) &&
      stillTrue(toldAs(m, founder), m.createdAt.slice(0, 10), today) &&
      (m.type === 'decision' || concrete(toldAs(m, founder))),
  );
  const figure = ranked.find((m) => m.type !== 'decision' && /\d/.test(toldAs(m, founder)));
  const told = figure ?? ranked[0];
  return told === undefined ? null : toldAs(told, founder);
}

/** The words that name the venture, and everything its record says. */
function recordOf(input: DecideInput): { core: string; all: string; substantial: boolean } {
  const { venture, reads } = input;
  const intake = reads.path?.intake;
  const core = [
    venture.name,
    venture.oneLiner,
    venture.currentGoal ?? '',
    intake?.idea ?? '',
    intake?.customer ?? '',
  ].join('. ');
  const all = [
    core,
    venture.domain,
    ...reads.memory.map((m) => `${m.title}. ${m.content}`),
    ...reads.steps.map((s) => s.evidence ?? ''),
    input.recordText,
  ].join('. ');
  return { core, all, substantial: reads.memory.length > 0 || subjectStems(core).length >= 4 };
}

/** What a phrase found in a statement must hold to be what it asks: two words that say something, or more (match.ts). */
const STATEMENT_PHRASE = 4;

const SUPPORT: ReadonlySet<RiskCategory> = new Set<RiskCategory>(['safety_wellbeing', 'conflict_harassment']);

/** The path as it reads once `step` is done, or the small part of it that was. */
function withCompleted(
  reads: pathRepo.PathReads,
  done: NonNullable<Decision['completes']>,
): pathRepo.PathReads {
  const { step, evidence, rest } = done;
  if (rest !== null)
    return {
      ...reads,
      steps: reads.steps.map((s) => (s.id === step.id ? { ...s, ...rest, version: s.version + 1 } : s)),
    };
  const criterionId = step.criterionId;
  return {
    ...reads,
    steps: reads.steps.map((s) =>
      s.id === step.id
        ? { ...s, status: 'done' as const, evidence, completedAt: s.completedAt ?? s.createdAt }
        : s,
    ),
    criteria:
      criterionId === null
        ? reads.criteria
        : [
            ...reads.criteria.filter((c) => c.criterionId !== criterionId),
            {
              criterionId,
              status: 'met' as const,
              evidence,
              stepId: step.id,
              sourceSessionId: null,
              updatedAt: step.createdAt,
            },
          ],
  };
}

/** Stages whose evidence is about a customer: what a change of direction opens again. */
const ABOUT_THE_CUSTOMER_FROM: VentureStage = 'discovery';

/** The path after a change of direction: what the old customer showed is open again, from talking to customers on. */
function withPivot(
  input: DecideInput,
  state: PathState,
  pivot: Pivot,
): { readonly applied: AppliedPivot; readonly reads: pathRepo.PathReads } {
  const { playbook, reads } = input;
  const order = stageOrder(playbook);
  const from = order.indexOf(ABOUT_THE_CUSTOMER_FROM);
  const ofCustomer = (c: PathCriterion): boolean => order.indexOf(c.stage) >= Math.max(0, from);
  const shown = state.criteria
    .filter((c) => (c.status !== 'open' || c.progress !== null) && ofCustomer(c.criterion))
    .map((c) => c.criterion);
  const told = reads.path?.intake?.idea.trim() ?? '';
  const old = told === '' ? input.venture.oneLiner.trim() : told;
  const restored = pivot.back === null ? [] : restoredBy(input, pivot.idea);
  const again = new Set(restored.map((r) => r.criterion.id));
  const reopened = shown.filter((c) => !again.has(c.id));
  const back = from < 0 ? state.stageIndex : Math.min(state.stageIndex, from);
  // The idea they go back to had its stage: the program's, when its record was of it, and what it shows.
  const had =
    pivot.back === null
      ? back
      : Math.max(back, restored.some((r) => r.status === 'claimed') ? order.indexOf(input.venture.stage) : 0);
  const stage = order[Math.min(had, order.length - 1)] ?? state.stage;
  const ids = new Set(reopened.map((c) => c.id));
  const open = reads.criteria.filter((c) => ids.has(c.criterionId));
  const kept = open.flatMap((c) =>
    c.evidence === null
      ? []
      : [
          {
            criterionId: c.criterionId,
            evidence: earlierEvidence(c.evidence, c.updatedAt.slice(0, 10) || input.today),
          },
        ],
  );
  const path: pathRepo.PathRecord = {
    ventureId: input.ventureId,
    stage,
    intakeBy: null,
    playbookVersion: playbook.version,
    version: 1,
    ...reads.path,
    intake: {
      ...(reads.path?.intake ?? {
        customer: '',
        studies: '',
        experience: null,
        hoursPerWeek: null,
        deadline: null,
        doneSoFar: '',
        block: '',
      }),
      idea: pivot.idea,
    },
    pivots: [...(reads.path?.pivots ?? []), { on: input.today, from: old, to: pivot.to, sessionId: null }],
    programStage: input.venture.stage,
  };
  // A step in their own words was about the old direction: it ends with it.
  const ends = reads.steps.filter((s) => s.status === 'now' && s.origin === 'founder');
  const changes = reopened.length > 0 || restored.length > 0;
  return {
    applied: { ...pivot, from: old, reopened, kept, restored, ends, stage },
    reads: {
      ...reads,
      // The step they were on waits: the new direction starts with what it opened.
      steps: reads.steps.map((s) =>
        ends.includes(s)
          ? { ...s, status: 'skipped' as const }
          : s.status === 'now' && s.origin === 'path' && changes
            ? { ...s, status: 'next' as const, dueOn: null }
            : s,
      ),
      path: { ...path, stage },
      criteria: [
        ...reads.criteria.filter((c) => !ids.has(c.criterionId) && !again.has(c.criterionId)),
        ...[...ids].map((criterionId) => ({
          criterionId,
          status: 'open' as const,
          evidence: kept.find((c) => c.criterionId === criterionId)?.evidence ?? null,
          stepId: open.find((c) => c.criterionId === criterionId)?.stepId ?? null,
          sourceSessionId: null,
          // Nothing on record yet is newer than the change: the old customer's evidence does not count.
          updatedAt: '9999-12-31T00:00:00.000Z',
        })),
        ...restored.map((r) => ({
          criterionId: r.criterion.id,
          status: r.status,
          evidence: r.evidence,
          stepId: null,
          sourceSessionId: r.sourceSessionId,
          updatedAt: '9999-12-31T00:00:00.000Z',
        })),
      ],
    },
  };
}

/** What an idea they go back to had shown: its evidence from before the change, and what its record held then. */
function restoredBy(input: DecideInput, idea: string): AppliedPivot['restored'] {
  const { playbook, reads } = input;
  const was = earlierIdeas(input).find((x) => x.idea === idea);
  if (was === undefined) return [];
  const memory = reads.memory.filter((m) => {
    const on = m.createdAt.slice(0, 10);
    return on <= was.until && (was.from === '' || on > was.from);
  });
  return playbook.criteria.flatMap((criterion) => {
    const row = reads.criteria.find((c) => c.criterionId === criterion.id);
    if (row === undefined) return [];
    const day = earlierDay(row.evidence ?? '');
    if (row.evidence !== null && day !== null && day <= was.until && (was.from === '' || day > was.from)) {
      const words = row.evidence.replace(/^Before \d{4}-\d{2}-\d{2}: /, '');
      return [
        {
          criterion,
          status: progressIn(words) === null ? ('claimed' as const) : ('open' as const),
          evidence: words,
          sourceSessionId: row.sourceSessionId,
        },
      ];
    }
    if (row.status !== 'open' || row.evidence !== null || !hasEvidence(playbook, input, memory)) return [];
    const record = recordShowing(criterion, memory, ideaText(input));
    return record === null
      ? []
      : [{ criterion, status: 'claimed' as const, evidence: record.title, sourceSessionId: null }];
  });
}

/** Words that name the venture rather than a fact of it. */
const NO_FACT: ReadonlySet<string> = new Set(
  'company business startup venture idea product customer market plan step stage problem worth next path'.split(
    ' ',
  ),
);

/** Asks for a fact of the record by its own words ("what's my fee per application?"). */
function asksForRecorded(message: string, memory: readonly pathRepo.PathMemory[]): boolean {
  const asked = /\bwhat(?: is| was| are| were) (?:my|our) ((?:[\p{L}'-]+ ?){1,4})/u.exec(plain(message));
  if (asked?.[1] === undefined) return false;
  const words = contentStems(asked[1]).filter((w) => !NO_FACT.has(w));
  return memory.some((m) => {
    if (m.status !== 'confirmed' || isReference(m)) return false;
    const title = contentStems(m.title);
    return words.some((w) => title.includes(w));
  });
}

const NO_CALC: CalcResult = { ask: null, lines: [], missing: null };

/** The plays whose answer is a sum of their numbers. */
const SUM_PLAYS: Readonly<Record<string, CalcAsk>> = { 'unit-economics': 'contribution' };
/** The play a sum they ask for belongs to, when no phrase names one. */
const PLAY_OF_SUM: Readonly<Partial<Record<CalcAsk, string>>> = {
  hourly: 'pricing',
  slot_price: 'pricing',
  target_price: 'pricing',
  churn: 'retention',
  same_rate: 'retention',
};
/** A pitch on its day, and what they ask about it on the way: its step stays. */
const PART_OF: Readonly<Record<string, readonly string[]>> = {
  'pitch-competition': ['pitch-deck', 'elevator-pitch', 'qa-prep', 'demo'],
  'investor-meeting': ['pitch-deck', 'elevator-pitch', 'qa-prep'],
};

/** A change of an amount, as a record tells it ("change the price from $20 to $25 a patch"). */
const CHANGED_AMOUNT =
  /\b(?:chang\w+|rais\w+|lower\w*|mov\w+|updat\w+|increas\w+|reduc\w+|set|put|went|goes|adjust\w+|switch\w+|fee|price|rate|it)\b([^.;]{0,30}?) (?:up |down )?from (\$? ?\d[\d.,]*(?: dollars)?) to (\$? ?\d[\d.,]*(?: dollars)?)((?: (?:per|an?|each|for each|for an?) (?:[a-z]+ ){0,2}[a-z]+)?)/gi;

/** A record's sentence of them as they would say it ("the founder charges $450" → "I charge $450"), for the calculator. */
export function inTheirVoice(text: string): string {
  return toYou(text)
    .replace(CHANGED_AMOUNT, (_whole, what: string, from: string, to: string, per: string) => {
      const thing = /\b(fee|price|rate|charge)\b/i.exec(`${_whole} ${what}`)?.[1]?.toLowerCase() ?? 'price';
      return `the ${thing} is ${to}${per} now, not ${from}`;
    })
    .replace(/\byour\b/gi, 'my')
    .replace(/\byou (?:are|were)\b/gi, 'I am')
    .replace(/\byou\b/gi, 'I');
}

/** What the record and the intake hold, as the calculator and a pass line read it: oldest first. */
function recordTexts(input: DecideInput): string[] {
  const intake = input.reads.path?.intake;
  const memory = input.reads.memory
    .filter((m) => m.status === 'confirmed' && !isReference(m))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return [
    intake?.doneSoFar ?? '',
    ...memory.map((m) => {
      const result = typeof m.attributes.result === 'string' ? m.attributes.result : '';
      return [m.content.trim() === '' ? m.title : m.content, result]
        .filter((t) => t.trim() !== '')
        .map(inTheirVoice)
        .join('. ');
    }),
    // Their words, never the count kept before them ("2 of 5: …").
    ...input.reads.criteria.map((c) => wordsOfEvidence(c.evidence ?? '')),
    ...input.reads.steps.map((s) => s.evidence ?? ''),
  ].filter((t) => t.trim() !== '');
}

/** What this turn is and what it must say next. */
export function decide(input: DecideInput): Decision {
  const { playbook } = input;
  const before = pathState(playbook, input);
  const titleOf = (state: PathState): string => playbook.stages[state.stageIndex]?.title ?? state.stage;
  const firstTime =
    input.reads.path?.intake?.experience === 'first_time' ||
    (input.reads.path?.intake?.experience !== 'experienced' &&
      [input.message, ...input.background].some(saysFirstTime));
  const base = {
    intent: null,
    matched: null,
    score: null,
    open: null,
    play: null,
    overview: false,
    state: before,
    stageTitle: titleOf(before),
    stageCount: playbook.stages.length,
    step: null,
    offered: false,
    pathStep: null,
    keeps: null,
    begins: false,
    carried: false,
    then: [],
    missing: missingOf(before),
    referral: null,
    pushes: false,
    report: null,
    completes: null,
    work: [],
    applied: null,
    movedTo: null,
    smaller: null,
    smallerOffer: null,
    commitment: null,
    idea: null,
    pivot: null,
    checkIn: null,
    choice: null,
    newIdea: null,
    firstTime,
    firstTimeNow: saysFirstTime(input.message),
    news: null,
    result: null,
    calc: NO_CALC,
    howTo: false,
    whenDone: false,
    message: false,
    fills: false,
    restates: null,
    rejects: false,
    actsOn: null,
    finding: '',
    vents: false,
    weak: null,
    wasDue: null,
    reading: null,
    decidedBy: null,
  } as const;

  if (input.crisis) return { ...base, kind: 'crisis' };
  if (
    isRehearsal({
      text: input.message,
      mode: input.mode,
      counterpart: input.counterpart,
      conversationMode: input.conversationMode,
      previousReply: input.previousReply,
    })
  )
    return { ...base, kind: 'rehearsal' };

  const { message } = input;
  const previous = input.previous ?? null;
  // What the message asks, as it was read; never of a turn a wellbeing or conflict risk is found on.
  const read =
    input.understanding == null
      ? null
      : settled(input.understanding, {
          message,
          earlier: input.earlierMessages ?? [],
          titles: playbook.plays.map((p) => p.title),
        });
  const u = read !== null && speaks(read) && !input.riskCategories.some((c) => SUPPORT.has(c)) ? read : null;
  // The work is asked of, however they feel.
  const works = u !== null && asksOfWork(u, message);
  const on = currentStep(input, before);
  const onRow = input.reads.steps.find((s) => s.id === on?.view.id && s.status === 'now') ?? null;
  const reacts = isReaction(message);
  // A text pasted to have it read is no report, news or change of theirs.
  const theirs = ownWords(message);
  const referralMatch = reacts
    ? null
    : (phraseIntent(playbook, message, (i) => i.referral === true) ?? offerMatch(playbook, theirs));
  const report = reportOf(theirs);
  const committed = commitmentOf(theirs, input.today);
  const commitment = isCommitted(committed) ? committed : null;
  const earlier = stepBefore(input, previous, on);

  // "I did it, thanks!" thanks, and reports on the step they were on.
  const reportsOnStep = report !== null && on !== null && on.write === null;
  const askLike = asksFor(message);
  // Courtesy and a bare "ok" are never an ask, whatever words they hold.
  if (
    (referralMatch === null || !askLike) &&
    !reportsOnStep &&
    !asksOverview(message) &&
    isSocial(message, input.previousReply)
  )
    return { ...base, kind: 'social', commitment, keeps: accepted(input, commitment, earlier) };

  const recallPhrase = referralMatch === null && asksRecall(message);
  const readsMore =
    u !== null &&
    u.kind !== 'recall' &&
    (u.sums.some((s) => s.asked) ||
      u.choice !== null ||
      u.result !== null ||
      u.contradicts !== null ||
      ['sum', 'choice', 'result', 'pushback', 'draft', 'integrity', 'feelings'].includes(u.kind));
  const recallAsked =
    recallPhrase &&
    (u === null ||
      u.kind === 'recall' ||
      decides('recall', { ...NOTHING, recallPhrase, readsMore }) === 'rule');
  const pivot = recallAsked ? null : pivotIn(input, pivotOf(theirs));
  const isNote = (i: PathIntent): boolean => i.note === true;
  // "How do I price it, and what's next?": the question a play answers is answered, and its step is the next one.
  const asksElse = sentences(message).some(
    (s) =>
      asksFor(s) &&
      !asksOverview(s) &&
      phraseIntent(playbook, s, (i) => !isNote(i) && i.overview === undefined) !== null,
  );
  const wholePath = u === null || asksWholePath(message, u);
  const asksPath =
    referralMatch === null &&
    !recallAsked &&
    !asksElse &&
    !needsAPerson(message) &&
    asksOverview(message) &&
    wholePath;
  const newIdea =
    referralMatch === null && !recallAsked && pivot === null && bringsNewIdea(message, recordOf(input));

  // The founder's explicit ask: a phrase of the playbook (a plain report that happens to hold one asks nothing).
  const told = { record: recordTexts(input), earlier: input.earlierMessages ?? [] };
  // How to do one part of the step just given, asked in words of that part that no phrase of a play reads.
  const part =
    earlier?.step == null ||
    recallAsked ||
    referralMatch !== null ||
    phraseIntent(playbook, message, (i) => !isNote(i)) !== null
      ? null
      : partAsked(
          message,
          earlier.step.view.items.filter((i) => !i.done),
        );
  const howTo = earlier !== null && !recallAsked && (asksHowTo(message) || part !== null);
  const whenDone = earlier !== null && !recallAsked && !howTo && asksWhenDone(message);
  // What they want done with the reply just given is done to it: it asks for nothing else.
  const restates =
    recallAsked || pivot !== null || input.previousReply === null || !input.started
      ? null
      : asksAboutReply(message);
  const rejects = restates === null && input.started && rejectsAdvice(message);
  const toSend = !recallAsked && !howTo && pivot === null && restates === null && asksMessage(message);
  const result = asksIfGood(message) ? lastResult([...told.record, ...told.earlier]) : null;
  const heldIntent = heldBy(playbook, previous);
  const upset = needsAPerson(message);
  const asked = smallerOf(message);
  const recorded = asksForRecorded(message, input.reads.memory);
  // "Shorter", of what was said, is no smaller step.
  const smaller = restates === null ? asked : null;
  let match: IntentMatch | null = null;
  const asking: Asking =
    earlier !== null && pointsBack(message)
      ? 'follow_up'
      : askLike || isFragment(message)
        ? earlier === null
          ? 'ask'
          : 'mid_ask'
        : 'statement';
  if (referralMatch === null && !recallAsked) {
    // A report of their step or of the path's work, or a commitment, asks nothing, whatever phrase it holds; another
    // thing they tell (what is in the way, what happened) may be what they ask about.
    const reports =
      commitment !== null ||
      (report !== null &&
        report.state !== 'blocked' &&
        (report.state !== 'done' ||
          reportedWork(before, message).length > 0 ||
          (onRow !== null && reportFinishes(message, report, onRow))));
    if ((askLike || !reports) && !reacts && !howTo && !whenDone && restates === null && !rejects)
      match = phraseIntent(playbook, message, (i) => !isNote(i));
    // In passing, a word of a play ("the pricing page is blue") asks nothing: a statement says more of it than that.
    if (asking === 'statement' && match !== null && match.score < STATEMENT_PHRASE) match = null;
  }
  const note = referralMatch === null && !reacts ? phraseIntent(playbook, message, isNote) : null;
  // A push on what a qualified person decides, or on what is never shared, keeps the answer of the turn before.
  const ownAsk =
    referralMatch !== null || match !== null || recallAsked || asksPath || newIdea || pivot !== null;
  const pushes =
    heldIntent !== null &&
    !ownAsk &&
    part === null &&
    pushesOn(message, heldIntent.holds === true) &&
    (u === null ||
      ((['pushback', 'privacy', 'feelings'].includes(u.kind) ||
        // Nothing else was read in it.
        (u.kind === 'question' && (u.playId === null || u.playId === heldIntent.playId))) &&
        !readsMoreThanPush(u)));
  const risky =
    referralMatch === null && !pushes ? referralForRisk(playbook, input.riskCategories, message) : null;
  const recall =
    recallAsked ||
    (u?.kind === 'recall' && referralMatch === null && pivot === null && !newIdea) ||
    (referralMatch === null && match === null && risky === null && recorded && !readsMore);
  // A risk the classifier found is the ask itself unless a phrase of the playbook named another one: then that is
  // answered, and who decides comes with it.
  const ruled: PathIntent | null =
    referralMatch?.intent ??
    (pivot !== null ? null : (match?.intent ?? risky ?? (pushes ? heldIntent : null)));
  // A sum has its play, whatever its words are near to ("what share of my clubs did I lose?" is no runway).
  const sumAsked = calcAsked(message);
  const sumPlay =
    ruled !== null || asksPath || newIdea || pivot !== null || !askLike || sumAsked === null
      ? null
      : playOf(playbook, PLAY_OF_SUM[sumAsked] ?? null);
  const work = recall || newIdea || pivot !== null ? [] : reportedWork(before, theirs);
  // They tell how hard it is, and ask nothing: no task is pushed.
  const vents = isVenting(message);
  const hardship = isHardship(message);
  // Nothing any phrase or rule reads in it: what is left may be matched by meaning.
  const unread =
    ruled === null &&
    sumPlay === null &&
    !asksPath &&
    !recall &&
    !newIdea &&
    pivot === null &&
    // What they report or will do asks nothing by itself; a question beside it does ("I asked ten people, how do I…").
    (report === null || (askLike && report.state !== 'not_yet' && report.state !== 'dropped')) &&
    (askLike || (work.length === 0 && commitment === null)) &&
    (smaller === null || (askLike && !smaller.strict)) &&
    !recorded &&
    !howTo &&
    !whenDone &&
    !toSend &&
    restates === null &&
    !rejects &&
    result === null &&
    !reacts &&
    !vents &&
    !upset &&
    !isInDistress(message) &&
    !input.riskCategories.some((c) => SUPPORT.has(c));
  const open = unread ? opennessOf(input, asking, askLike) : null;
  const near = input.near ?? null;
  const compared = near !== null && near !== 'unavailable' && playMatchProfile(near.modelId) !== null;
  const nearest: SemanticMatch | null =
    open === null || !compared ? null : pickPlay(playbook, message, near, open);
  // A question of their own work is never answered by what is not shared here, however near its words are.
  const semantic =
    nearest?.intent?.holds === true && !namesOthers(message) ? { ...nearest, intent: null } : nearest;
  const words: IntentMatch | null =
    open === null || near === null || compared
      ? null
      : nearestWords(playbook, message, {
          only: (i) => !isNote(i),
          // A few words that name a thing are a question of it ("cofounder shares").
          guarded: open === 'guarded' && !(asking === 'ask' && report === null),
        });
  const found = ruled ?? semantic?.intent ?? words?.intent ?? null;
  // Where the rules and the reading disagree, one table decides (understood.ts).
  const referralPlay = u === null ? null : referralPlayOf(playbook, u, message);
  // What they say they did or will do, and ask nothing beside it; a promise inside an argument is no report.
  const ownReport =
    smaller?.strict === true ||
    (!readsMore &&
      !asksNow(u) &&
      (commitment !== null || (report !== null && (report.state !== 'blocked' || reportsOnStep))));
  const weighed: Weighed | null =
    u === null
      ? null
      : {
          ownReport,
          turned: pivot !== null || newIdea,
          operation:
            asksPath ||
            whenDone ||
            toSend ||
            (restates !== null && u.kind !== 'pushback') ||
            (asksForTemplate(message) && earlier !== null) ||
            (howTo && message.trim() === HOW_FOLLOW_UP),
          referralPhrase: referralMatch !== null,
          heldPhrase: match?.intent.holds === true,
          heldPush: pushes,
          recallPhrase,
          phrase: match !== null && match.intent.overview === undefined,
          namesPlay: playOf(playbook, u.playId) !== null,
          sure: u.sure,
          namesStep: playOf(playbook, u.stepPlayId) !== null,
          refers: referralPlay !== null,
          readsRecall: recall && u.kind === 'recall',
          readsMore,
          ...weighedSums(u, () => calcOf({ message, ...told, ask: null })),
          ...weighedChoice(u, () => choiceIn({ message: theirs, earlier: told.earlier, told: told.record })),
        };
  const decidedBy = weighed === null ? null : decidedFields(weighed);
  const readPlayId =
    u === null
      ? null
      : u.kind === 'privacy' && u.playId === null
        ? (playbook.intents.find((i) => i.holds === true)?.playId ?? null)
        : (u.playId ?? (u.referral === null ? null : (referralPlay?.id ?? null)));
  const byReading = decidedBy?.play === 'reading' || (u?.kind === 'privacy' && found === null);
  const intent: PathIntent | null = !byReading ? found : intentOfPlay(playbook, readPlayId);
  const overview = asksPath || (intent?.overview !== undefined && wholePath);
  const answered =
    (byReading ? playOf(playbook, readPlayId) : playOf(playbook, intent?.playId ?? null)) ??
    (recall || byReading ? null : sumPlay);
  // "Get me organized" is answered by where this venture stands: a play of another stage ("you are on move one") is not.
  const play =
    intent?.overview === 'path' || (overview && answered?.stage !== before.stage) ? null : answered;
  const matched: Decision['matched'] =
    referralMatch !== null
      ? 'phrase'
      : intent !== null && intent === risky
        ? 'risk'
        : pushes
          ? 'previous'
          : byReading && play !== null
            ? 'reading'
            : intent !== null && intent === match?.intent
              ? match.how
              : ruled === null && intent !== null
                ? words === null
                  ? 'semantic'
                  : words.how
                : overview || (sumPlay !== null && play === sumPlay)
                  ? 'rule'
                  : null;
  const passing =
    playOf(playbook, (risky ?? note?.intent)?.playId ?? null)?.referral ?? semantic?.referral ?? null;
  // The rules' own stands whatever was read; the reading's is only added. A word in passing of an option they do not go
  // with ("hire someone, or …?") brings nobody.
  const passedOver =
    u !== null &&
    u.choice !== null &&
    u.referral === null &&
    referralMatch === null &&
    risky === null &&
    play !== null &&
    !fitsAsk(play, u.choice.pick);
  const ofPlay = passedOver ? null : (play?.referral ?? null);
  const found1 = (byReading ? (passing ?? ofPlay) : (ofPlay ?? passing)) ?? referralPlay?.referral ?? null;
  // What to bring is what came.
  const referral =
    found1 !== null && u !== null && found1.category === 'legal' && tellsLegalLetter(message)
      ? { ...found1, bring: 'The letter, when it came, and a copy of everything it is about' }
      : found1;

  // What they report: the step finished, work of the path's criteria, or a step not done.
  const told1 =
    report !== null && !askLike ? report : report !== null && on !== null && intent === null ? report : null;
  // A change of direction is no missed day, and no step dropped: only work that was done is reported beside it.
  const reported = pivot !== null && told1 !== null && told1.state !== 'done' ? null : told1;
  // A founder who is upset, or asks about safety or a conflict, is never pushed a task (a smaller one is no push).
  const support =
    input.riskCategories.some((c) => SUPPORT.has(c)) ||
    ((upset || (hardship && reported === null)) &&
      intent === null &&
      !works &&
      !(smaller !== null && earlier !== null)) ||
    // Only how they feel: no task.
    (u?.kind === 'feelings' && !works && reported === null && play === null);

  const completes = reported === null && pivot !== null ? null : finished(input, report, onRow, work);

  let reads = completes === null ? input.reads : withCompleted(input.reads, completes);
  let state = completes === null ? before : pathState(playbook, { ...input, reads });
  const rest = work.filter(
    (w) =>
      (w.corrects !== undefined || !isShownCriterion(state, w.criterion.id)) &&
      w.criterion.id !== completes?.step.criterionId,
  );
  // A finished step of a later stage moves the path there too.
  const finishedCriterion =
    completes?.rest === null
      ? (playbook.criteria.find((c) => c.id === completes.step.criterionId) ?? null)
      : null;
  const moves =
    finishedCriterion !== null && stageOrder(playbook).indexOf(finishedCriterion.stage) > state.stageIndex;
  const applied =
    rest.length === 0 && !moves
      ? null
      : withWork(
          playbook,
          { ...input, reads },
          state,
          rest,
          finishedCriterion === null
            ? null
            : { criterion: finishedCriterion, words: completes?.evidence ?? '' },
        );
  if (applied !== null) {
    reads = applied.reads;
    state = pathState(playbook, { ...input, reads });
  }
  let appliedPivot: AppliedPivot | null = null;
  if (pivot !== null) {
    const turned = withPivot({ ...input, reads }, state, pivot);
    appliedPivot = turned.applied;
    reads = turned.reads;
    state = pathState(playbook, { ...input, reads });
  }
  const now: StepContext = { ...input, reads };
  const own = currentStep(now, state);

  const asks = intent !== null || overview || (byReading && play !== null);
  const news =
    recall || newIdea || pivot !== null || support
      ? null
      : newsOf({ message: theirs, before: [...told.record, ...told.earlier] });
  const ruledKind: TurnKind = newIdea
    ? 'new_idea'
    : recall
      ? 'recall'
      : pivot !== null ||
          (!asks && (reported !== null || (commitment !== null && !askLike) || work.length > 0)) ||
          (asksPath && (completes !== null || work.length > 0))
        ? 'report'
        : !asks &&
            !askLike &&
            (news !== null ||
              // Something happened, and no rule reads what it means: the model says it.
              (tellsNews(theirs) &&
                restates === null &&
                !rejects &&
                !vents &&
                !upset &&
                !reacts &&
                smaller === null &&
                statedIdea(theirs, input.venture.name) === null))
          ? 'news'
          : 'coaching';
  // Their report is written whatever the reading says; how the turn is answered is the reading's.
  const kind: TurnKind =
    u === null ||
    decidedBy?.kind !== 'reading' ||
    recall ||
    (ruledKind === 'report' && (completes !== null || work.length > 0))
      ? ruledKind
      : !askLike && u.secondAsk === null && (u.kind === 'update' || u.kind === 'result')
        ? 'news'
        : 'coaching';

  // The turn's step.
  const carriable = earlier !== null && completes === null && pivot === null;
  let turn: TurnStep = { step: own, offered: false };
  let carried = false;
  let movedTo: string | null = null;
  let smallerOffer: PathStepView | null = null;
  let cutTo: SmallerAsk | null = null;
  const byTheReading =
    u !== null &&
    decidedBy?.step === 'reading' &&
    !recall &&
    // Work of the path they report moves it; a result that finished nothing may have a step of its own.
    (kind !== 'report' ||
      (completes === null && commitment === null && pivot === null && weighed?.namesStep === true));
  if (newIdea) turn = ideaStep(now) ?? turn;
  else if (byTheReading) {
    const chosen = readStep(now, state, own, {
      u,
      play,
      phrased: ruled === null ? null : playOf(playbook, ruled.playId),
      referral: referralPlay,
      message,
      told,
    });
    if (chosen !== null) turn = chosen;
    else if (carriable && !support && (!earlier.offered || goesOn(input, earlier, askLike))) {
      turn = earlier;
      carried = true;
    }
  } else if (recall && sumPlay !== null) turn = newsStep(now, state, sumPlay, own);
  else if (pivot !== null && referral === null) {
    // "The plan is to ask 5 caterers this week": the first step of the new direction, in their own words.
    const theirs = commitment === null ? null : said(now, state, commitment);
    turn = { step: theirs ?? own, offered: false };
  } else if (recall || overview) turn = { step: own, offered: false };
  else if (
    play !== null &&
    kind === 'coaching' &&
    asksIfNeeded(message) &&
    play.referral === null &&
    stageOrder(playbook).indexOf(play.stage) > state.stageIndex
  )
    // "Do I need one now?" of a later stage: not yet, so the path's own step stands.
    turn = { step: own, offered: false };
  else if (play !== null && kind === 'coaching') {
    if (
      (pushes && earlier !== null) ||
      (earlier?.step != null && (PART_OF[earlier.step.view.playId ?? ''] ?? []).includes(play.id))
    ) {
      turn = earlier;
      carried = true;
    } else turn = askStep(now, state, untested(now, told, play) ?? play, own);
  } else if (kind === 'report') {
    const mine = commitment !== null && reported === null && work.length === 0 ? commitment : null;
    const theirs = mine === null ? null : (accepted(now, mine, earlier) ?? said(now, state, mine));
    if (theirs !== null) turn = { step: theirs, offered: false };
    else if (reported?.state === 'not_yet' && own !== null) {
      const back = moved(now, own, playOf(playbook, own.view.playId));
      if (back !== null) {
        turn = { step: back, offered: false };
        movedTo = back.view.dueOn;
      }
      smallerOffer = smallerStep(own.view, { minutes: null, strict: true, today: false }, input.today);
    }
  } else if (kind === 'news') {
    // What they tell moves nothing of the path by itself: the path's own step stands, beside the one that acts on it.
  } else if (carriable && !support && (!earlier.offered || goesOn(input, earlier, askLike))) {
    turn = earlier;
    carried = true;
  }
  // What they just told is acted on, whatever the path's own step is (what they said they would do comes first).
  const theirOwn = own?.view.origin === 'founder' && own.view.status === 'now';
  const actsOn =
    news === null ||
    decidedBy?.step === 'reading' ||
    support ||
    recall ||
    newIdea ||
    pivot !== null ||
    commitment !== null ||
    theirOwn
      ? null
      : kind === 'news' ||
          (kind === 'report' && MOVES_THE_CUSTOMER.has(news.kind) && reported?.state !== 'not_yet') ||
          (asksPath && play === null)
        ? playOn(playbook, state, news, `${message} ${input.venture.oneLiner}`)
        : null;
  if (actsOn !== null) {
    turn = newsStep(now, state, actsOn, own);
    carried = false;
  }
  if (smaller !== null && !recall && kind !== 'new_idea') {
    const less = cut(now, turn, smaller);
    if (less !== null) {
      turn = { step: less, offered: turn.offered };
      cutTo = smaller;
      smallerOffer = null;
    }
  }
  // A step past its day is given one they can still make (what was due, and when, is in the check-in and the opening).
  let wasDue: string | null = null;
  if (turn.step !== null && turn.step.view.status === 'now' && isPast(turn.step, input.today)) {
    const again = moved(now, turn.step, playOf(playbook, turn.step.view.playId));
    if (again !== null) {
      if (recall) wasDue = turn.step.view.dueOn;
      turn = { step: again, offered: turn.offered };
    }
  }
  // A choice they asked to have made, and the pick their record decides: the step acts on it, and reopens nothing.
  const choice =
    (kind === 'coaching' || kind === 'new_idea') && !overview && intent?.holds !== true
      ? choiceIn({ message: theirs, earlier: told.earlier, told: told.record })
      : null;
  const way =
    turn.step?.view.playId === 'channel-choice'
      ? (choice?.pick?.option ??
        settledWay([...told.earlier, theirs], [...told.record, ...told.earlier, theirs]))
      : null;
  if (way !== null && turn.step !== null)
    turn = { ...turn, step: { ...turn.step, view: pickedChannel(turn.step.view, way) } };
  if (u !== null && testsAPick(u) && turn.step?.view.playId === 'smallest-test' && turn.offered)
    turn = { ...turn, step: { ...turn.step, view: pickTested(turn.step.view, u.choice?.pick ?? '') } };
  // Due sooner than the step would be: the class's day is the step's.
  const classDay = u === null || turn.step === null ? null : dueInClass(message, input.today);
  if (classDay !== null && turn.step !== null && turn.offered && (turn.step.view.dueOn ?? '9') > classDay)
    turn = { ...turn, step: { ...turn.step, view: { ...turn.step.view, dueOn: classDay } } };
  const weak = overview && news === null && asksOneThing(message) ? weakResult(told) : null;
  if (weak !== null && turn.step !== null) {
    const read = playOf(playbook, 'read-results');
    const base1 =
      read === null ? null : stepFor(now, read, { status: 'later', criterionId: null, origin: 'coach' });
    const asksThem =
      base1 === null ? null : base1.row === null ? askWhyStep(now, weak, base1.view) : base1.view;
    if (asksThem !== null)
      turn = { step: { view: asksThem, write: null, storedVersion: null }, offered: true };
  }
  if (support) turn = { step: null, offered: false };
  const calc =
    recall && !calcAsked(message)
      ? NO_CALC
      : calcOf({
          message,
          ...told,
          ask:
            u !== null && u.kind !== 'sum' && !u.also.includes('sum')
              ? null
              : (SUM_PLAYS[play?.id ?? ''] ?? null),
        });
  const explicit = play !== null && !pushes;
  const due = checkInOf(input, input.reads.steps);
  const checkIn =
    input.started || completes !== null || support || kind === 'report' || pivot !== null
      ? null
      : due !== null && explicit && !due.overdue && due.dueOn !== input.today
        ? null
        : due;
  const ownView = own === null ? null : shownStep(own.view, state);
  const step: ChosenStep | null =
    turn.step === null ? null : { ...turn.step, view: shownStep(turn.step.view, state) };
  const following = turn.offered
    ? playsAfter(now, state, playOf(playbook, turn.step?.view.playId ?? null))
    : followingSteps(now, state, turn.step, 2);
  const keptIdea = input.reads.path?.intake?.idea.trim() ?? '';
  return {
    kind,
    intent: intent?.id ?? (pivot !== null ? 'pivot' : overview ? 'overview' : null),
    matched,
    score: semantic?.score ?? null,
    open,
    play,
    overview,
    state,
    stageTitle: titleOf(state),
    stageCount: playbook.stages.length,
    step,
    offered: turn.offered && step !== null,
    pathStep: turn.offered && ownView !== null && ownView.id !== step?.view.id ? ownView : null,
    keeps: turn.step?.write == null ? null : turn.step,
    begins: input.reads.path === null && step !== null,
    carried,
    then: step === null || newIdea ? [] : following.slice(0, 2).map((s) => shownStep(s, state)),
    missing: missingOf(state),
    // Still on what a qualified person decides.
    referral:
      referral ??
      // What was said before of who decides, while they go on about it.
      (carried && u?.referral !== null ? (previous?.referral ?? null) : null) ??
      (news !== null && DECIDED_BY_A_PERSON.has(news.kind) ? (actsOn?.referral ?? null) : null),
    pushes,
    report: reported,
    completes,
    work: applied === null ? [] : rest,
    applied,
    movedTo,
    smaller: cutTo,
    smallerOffer,
    commitment: kind === 'report' ? commitment : null,
    idea:
      keptIdea === '' && !newIdea && pivot === null && !recall
        ? statedIdea(theirs, input.venture.name)
        : null,
    pivot: appliedPivot,
    checkIn: checkIn !== null && namesStep(input.previousReply, checkIn.title) ? null : checkIn,
    choice,
    newIdea: newIdea
      ? { ventureName: input.venture.name, fact: concreteFact(input.reads.memory, '', input.today) }
      : null,
    firstTime,
    firstTimeNow: base.firstTimeNow,
    news,
    result,
    calc,
    howTo: howTo && carried,
    whenDone: whenDone && carried,
    message: toSend && step !== null && kind === 'coaching' && intent === null,
    fills:
      step !== null &&
      step.view.template !== null &&
      kind === 'coaching' &&
      pivot === null &&
      restates === null &&
      (play === null || play.id === step.view.playId || overview) &&
      asksForTemplate(message),
    restates: kind === 'coaching' && intent === null && !overview && !support ? restates : null,
    rejects: kind === 'coaching' && intent === null && !overview && !support && rejects,
    actsOn,
    finding:
      // What they say they will do is no finding.
      (commitment !== null && reported === null && work.length === 0 && news === null
        ? ''
        : foundIn(theirs, kind, news, appliedPivot, overview && work.length + Number(news !== null) > 0)) ||
      (kind === 'coaching' && restates === null && asksMeaning(message)
        ? findingIn(theirs) || lastFinding(input)
        : ''),
    vents: vents && reported === null && !works,
    weak: turn.step === null ? null : weak,
    wasDue,
    reading:
      works &&
      !support &&
      kind !== 'new_idea' &&
      // The reply just given, said again: from that reply alone.
      (restates === null || decidedBy?.lead !== 'rule')
        ? u
        : null,
    decidedBy,
  };
}

/** The day something of a class is due, as they say it ("the canvas is due Friday"); null: none said. */
function dueInClass(message: string, today: string): string | null {
  const said = /\b(?:due|hand(?:ed)? (?:it )?in|submit(?:ted)?|turn(?:ed)? (?:it )?in)\b[^.?!]{0,24}/i.exec(
    message,
  )?.[0];
  if (
    said === undefined ||
    !/\b(?:class|module|assignment|prof(?:essor)?|course|homework|canvas|section)\b/i.test(message)
  )
    return null;
  const day = daySaid(said, today);
  return day !== null && day >= today ? day : null;
}

/** Money put to them for a part of the company, in any words: the referral of what it is worth. */
function offerMatch(playbook: Playbook, message: string): IntentMatch | null {
  if (!offersForShares(message)) return null;
  const intent = referralForRisk(playbook, ['securities_investment'], message);
  return intent === null ? null : { intent, how: 'phrase', score: 1 };
}

/** As it is sent with one tap (turn.ts `followUpsOf`). */
export const HOW_FOLLOW_UP = 'How do I do the first part?';

const decidedFields = (w: Weighed): NonNullable<Decision['decidedBy']> => ({
  kind: decides('kind', w),
  recall: decides('recall', w),
  play: decides('play', w),
  step: decides('step', w),
  referral: decides('referral', w),
  sum: decides('sum', w),
  choice: decides('choice', w),
  lead: decides('lead', w),
});

/** The reading finds something asked beside what they tell. */
const asksNow = (u: Understanding | null): boolean =>
  u !== null && (u.secondAsk !== null || !['update', 'result', 'social', 'recall'].includes(u.kind));

/** The reading finds another ask than the push: a sum, a pick, a result. */
const readsMoreThanPush = (u: Understanding): boolean =>
  u.sums.some((s) => s.asked) || u.choice !== null || u.result !== null;

function weighedSums(
  u: Understanding,
  calc: () => CalcResult,
): Pick<Weighed, 'readSum' | 'ruleSum' | 'sameSum'> {
  const asked = u.sums.filter((s) => s.asked);
  const { ask, lines } = calc();
  const ruleSum = ask !== null && lines.length > 0;
  const said = lines.join(' ').replace(/,(?=\d{3})/g, '');
  return {
    readSum: asked.length > 0,
    ruleSum,
    sameSum:
      ruleSum &&
      asked.length === 1 &&
      asked.every((s) =>
        [...said.matchAll(/\d+(?:\.\d+)?/g)].some((m) => Math.abs(Number(m[0]) - Math.abs(s.value)) < 0.0051),
      ),
  };
}

function weighedChoice(
  u: Understanding,
  choice: () => Choice | null,
): Pick<Weighed, 'picks' | 'countsPick' | 'samePick'> {
  const option = choice()?.pick?.option ?? null;
  const words = new Set(contentStems(option ?? ''));
  return {
    picks: u.choice !== null,
    countsPick: option !== null,
    samePick: option !== null && u.choice !== null && contentStems(u.choice.pick).some((w) => words.has(w)),
  };
}

/** An intent of the playbook's that leads to a play: its referral or never-shared one first. */
function intentOfPlay(playbook: Playbook, playId: string | null): PathIntent | null {
  const all = playbook.intents.filter((i) => i.playId === playId && i.note !== true);
  return (
    all.find((i) => i.referral === true || i.holds === true) ??
    all.find((i) => i.overview === undefined) ??
    null
  );
}

/**
 * The step that serves what they ask, as it was read: the play the reading names for it, else the one that answers, else who
 * decides. One already under way that is about the same thing stands, and theirs in their own words always does: another is
 * offered beside it. Null: the reading asks for none.
 */
function readStep(
  context: StepContext,
  state: PathState,
  own: ChosenStep | null,
  args: {
    readonly u: Understanding;
    readonly play: Play | null;
    /** The play a phrase named. */
    readonly phrased: Play | null;
    readonly referral: Play | null;
    readonly message: string;
    readonly told: { readonly record: readonly string[]; readonly earlier: readonly string[] };
  },
): TurnStep | null {
  const { u, play, phrased, referral } = args;
  const stay: TurnStep = { step: own, offered: false };
  const asked = askedOf(u, args.message);
  // A step whose title is about something else is no step of this ask.
  const fits = (p: Play | null): Play | null =>
    p === null ||
    p.id === phrased?.id ||
    p.referral !== null ||
    // Work they would make up has the step that makes it real.
    u.kind === 'integrity' ||
    fitsAsk(p, asked)
      ? p
      : null;
  const wantedHere = allowedStep(context, state, playOf(context.playbook, u.stepPlayId), play, phrased);
  const named = fits(wantedHere);
  const picked = pickStep(context, own, u, wantedHere, asksToStop(args.message));
  if (picked !== undefined)
    return picked === null || picked.id === own?.view.playId ? stay : newsStep(context, state, picked, own);
  // Who decides comes before anything else is done about it.
  const deciding =
    referral !== null && (named === null || (named.referral === null && !u.sure)) && u.kind !== 'sum';
  const wanted = deciding ? referral : (named ?? fits(allowedStep(context, state, play, play, phrased)));
  if (wanted === null) return null;
  if (wanted.id === own?.view.playId) return stay;
  // A figure is no reason for another step, unless the sum is the play itself.
  const sumOnly = u.kind === 'sum' && !u.also.some((k) => k !== 'sum' && k !== 'question');
  if (sumOnly && wanted.referral === null && wanted.id !== phrased?.id && !(u.sure && wanted.id === u.playId))
    return stay;
  if (u.kind === 'sum' && u.also.includes('feelings')) return stay;
  const open = own !== null && own.write === null && own.view.status === 'now';
  if (wanted.id === phrased?.id || !open)
    return askStep(context, state, untested(context, args.told, wanted) ?? wanted, own);
  const about = wanted.referral !== null || !sameSubject(own.view, asked);
  return about || (u.sure && wanted.id === u.playId)
    ? newsStep(context, state, untested(context, args.told, wanted) ?? wanted, own)
    : stay;
}

/**
 * The step of a choice made: handing it over has the hand-over page, "may I stop?" the choice with its evidence; an
 * either-or that is not about money a small test of the pick, unless the step named, or theirs, is about the pick. Null: the
 * step they are on stands; undefined: no such choice.
 */
function pickStep(
  context: StepContext,
  own: ChosenStep | null,
  u: Understanding,
  named: Play | null,
  stops: boolean,
): Play | null | undefined {
  const { playbook } = context;
  if (handsOn(u)) return playOf(playbook, 'after-graduation') ?? undefined;
  if (stops) return playOf(playbook, 'quit-or-continue') ?? undefined;
  if (!testsAPick(u)) {
    // "Not for money yet" is no ask to pay.
    const money = named === null || u.choice === null ? false : picksAgainst(u, named);
    return money ? null : undefined;
  }
  const pick = u.choice?.pick ?? '';
  const about = (p: Pick<Play, 'title' | 'doneWhen'>): boolean => fitsAsk(p, pick);
  if (named !== null && (about(named) || /^(?:Choose|Pick|Score|Compare|List your last)\b/.test(named.title)))
    return named;
  if (named !== null && named.referral !== null) return undefined;
  if (own !== null && about(own.view)) return null;
  return playOf(playbook, 'smallest-test') ?? undefined;
}

/** A step the path allows now: of the ask's own play, or of a stage next to the one they are on. */
function allowedStep(
  context: StepContext,
  state: PathState,
  wanted: Play | null,
  play: Play | null,
  phrased: Play | null,
): Play | null {
  if (wanted === null) return null;
  if (wanted.id === play?.id || wanted.id === phrased?.id) return wanted;
  const order = stageOrder(context.playbook);
  return Math.abs(order.indexOf(wanted.stage) - state.stageIndex) <= 1 ? wanted : null;
}

/** "Go on or stop?" of what nobody has tried: there are no tests to list, so the step is the first one. */
function untested(
  context: StepContext,
  told: { readonly record: readonly string[]; readonly earlier: readonly string[] },
  play: Play,
): Play | null {
  if (play.id !== 'quit-or-continue' || lastResult([...told.record, ...told.earlier]) !== null) return null;
  if (hasEvidence(context.playbook, context) || context.reads.criteria.some((c) => c.evidence !== null))
    return null;
  return playOf(context.playbook, 'smallest-test');
}

/** The last result they told, when it is a weak one (less than half); null: none, or a good one. */
function weakResult(told: {
  readonly record: readonly string[];
  readonly earlier: readonly string[];
}): Ratio | null {
  const result = lastResult([...told.record, ...told.earlier]);
  return result === null || result.part * 2 >= result.whole ? null : result;
}

/** Money for a part of it, and what goes public: a qualified person decides. */
const DECIDED_BY_A_PERSON: ReadonlySet<NewsKind> = new Set<NewsKind>(['funding', 'disclosure']);

/** What they last found, here or on record, for a question of what it means. */
function lastFinding(input: DecideInput): string {
  for (const text of [...(input.earlierMessages ?? [])].reverse()) {
    if (newsOf({ message: text, before: [] }) === null && reportOf(text) === null) continue;
    const found = findingIn(text);
    if (found !== '') return found;
  }
  const told = input.reads.criteria
    .filter((c) => c.evidence !== null && c.sourceSessionId !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (told !== undefined) return findingIn(wordsOfEvidence(told.evidence ?? ''));
  const done = input.reads.steps
    .filter((s) => s.status === 'done' && s.evidence !== null)
    .sort((a, b) => (b.completedAt ?? b.createdAt).localeCompare(a.completedAt ?? a.createdAt))[0];
  return done === undefined ? '' : findingIn(done.evidence ?? '');
}

/** What came of their work, for the model to read: the result beside another ask, else what they tell. */
function foundIn(
  message: string,
  kind: TurnKind,
  news: News | null,
  pivot: AppliedPivot | null,
  beside: boolean,
): string {
  if (kind === 'coaching' && news !== null && news.ratio !== null)
    return news.means.split(/(?<=[.:]) /u)[0]?.replace(/[.:]$/u, '') ?? '';
  return kind === 'report' || kind === 'news' || beside ? findingIn(message, pivot?.quote ?? '') : '';
}

/** Whether a message goes on about the step of the turn before, when that is no step of their path. */
function goesOn(input: DecideInput, earlier: TurnStep, askLike: boolean): boolean {
  const { message } = input;
  if (!askLike || refersBack(message) || meaningWords(message) <= FOLLOW_UP_WORDS) return true;
  const view = earlier.step?.view;
  const about = new Set(
    contentStems(
      `${view?.title ?? ''}. ${view?.doneWhen ?? ''}. ${(view?.items ?? []).map((i) => i.do).join('. ')}. ${input.earlierMessages?.at(-1) ?? ''}`,
    ).filter((w) => !/^\d+$/.test(w)),
  );
  return contentStems(message).some((w) => about.has(w));
}

/** The change of direction with the idea it is to; null: they go back to an idea nobody knows. */
function pivotIn(input: DecideInput, pivot: Pivot | null): Pivot | null {
  if (pivot?.back == null) return pivot;
  const ideas = earlierIdeas(input);
  const idea =
    pivot.back === 'first'
      ? ideas[0]
      : pivot.back === 'last'
        ? ideas.at(-1)
        : ideas
            .map((x) => ({ x, shared: sharedWords(x.idea, pivot.to.split(/\. /u)[0] ?? '') }))
            .filter((x) => x.shared > 0)
            .sort((a, b) => b.shared - a.shared)[0]?.x;
  return idea === undefined ? null : { ...pivot, idea: idea.idea };
}

const sharedWords = (a: string, b: string): number => {
  const words = new Set(contentStems(a));
  return contentStems(b).filter((w) => words.has(w)).length;
};

/** The ideas the venture had before the one it is on, oldest first, with the day each ended. */
function earlierIdeas(
  input: Pick<DecideInput, 'reads' | 'venture'>,
): { readonly idea: string; readonly until: string; readonly from: string }[] {
  const pivots = input.reads.path?.pivots ?? [];
  const now = input.reads.path?.intake?.idea.trim() ?? '';
  return pivots
    .map((p, i) => ({ idea: p.from.trim(), until: p.on, from: pivots[i - 1]?.on ?? '' }))
    .filter((x) => x.idea !== '' && x.idea !== now);
}

/** Words of its own a question that points back has at most, to go on about what was said and ask nothing else. */
const FOLLOW_UP_WORDS = 5;

/**
 * Whether a message no rule reads asks something that may be matched by meaning, and how plainly. While another step is
 * under way only a question of its own does, one that points at nothing just said: the rest goes on about that step.
 */
function opennessOf(input: DecideInput, asking: Asking, askLike: boolean): Openness | null {
  const { message, previous, previousReply } = input;
  const words = meaningWords(message);
  if (asking === 'follow_up' || words === 0) return null;
  // A question beside a report is part of what they say.
  if (asking === 'ask' && askLike && reportOf(message) === null) return 'ask';
  if (words < 2) return null;
  if (previous != null && (!askLike || (refersBack(message) && words <= FOLLOW_UP_WORDS))) return null;
  if (asking === 'statement') {
    // A plain fact, what they answer to a question, or tell of their idea, asks nothing.
    if (!statesNeed(message)) return null;
    if (/\?["'”’)\]*_]*\s*$/.test((previousReply ?? '').trim())) return null;
    if (statedIdea(message, input.venture.name) !== null) return null;
  }
  return 'guarded';
}

/** The intent the turn before answered, when a push keeps it: a qualified person decides, or it is never shared. */
function heldBy(playbook: Playbook, previous: TurnGuidance | null): PathIntent | null {
  if (previous === null) return null;
  const intent = playbook.intents.find(
    (i) => i.id === previous.intent && (i.referral === true || i.holds === true),
  );
  if (intent !== undefined) return intent;
  // Nothing named it on that turn, and it went on about what is never shared.
  const held = playbook.intents.find((i) => i.holds === true && i.playId === previous.playId);
  if (held !== undefined) return held;
  // A referral that came with the answer: the play it is of, while it is the latest thing said.
  return previous.referral === null
    ? null
    : (playbook.intents.find((i) => {
        const play = i.referral === true ? playOf(playbook, i.playId) : null;
        return (
          play?.referral?.who === previous.referral?.who && play?.referral?.bring === previous.referral?.bring
        );
      }) ?? null);
}

/** "I'll do that", "eight of those this week": the step just given becomes theirs, on the day they said. */
function accepted(
  context: StepContext,
  commitment: Commitment | null,
  earlier: TurnStep | null,
): ChosenStep | null {
  if (commitment === null || earlier?.step == null) return null;
  const { view } = earlier.step;
  const words = new Set(
    contentStems(`${view.title} ${view.doneWhen} ${view.items.map((i) => i.do).join(' ')}`).filter(
      (w) => !/^\d+$/.test(w),
    ),
  );
  const shared = contentStems(commitment.clause).filter((w) => words.has(w)).length;
  // Their own number of something else is a step of their own ("email the five theatre groups").
  if (!commitment.about && shared < 2) return null;
  const step = taken(context, earlier, commitment.dueOn);
  return step?.write === null ? null : step;
}

/** What they say they will do, as a step in their own words, with the method of the play it belongs to. */
function said(context: StepContext, state: PathState, commitment: Commitment): ChosenStep | null {
  if (commitment.about) return null;
  const subject = contentStems(commitment.clause).length;
  if (subject < 2 || (commitment.dueOn === null && countsIn(commitment.clause).length === 0)) return null;
  const { playbook } = context;
  const work = reportedWork(state, `I ${pastOf(commitment.clause)}`)[0] ?? null;
  const byWords = phraseIntent(playbook, commitment.clause, (i) => i.note !== true && i.referral !== true);
  const play =
    playOf(playbook, work?.criterion.playId ?? null) ??
    playOf(
      playbook,
      byWords === null || byWords.intent.overview !== undefined ? null : byWords.intent.playId,
    );
  const criterionId = work?.criterion.id ?? null;
  return ownStep(context, commitment, play, criterionId);
}

/** "talk to ten" as it would be reported ("talked to ten"), to read what it would count for. */
function pastOf(clause: string): string {
  return clause
    .replace(/^talk\b/i, 'talked')
    .replace(/^speak\b/i, 'spoke')
    .replace(/^interview\b/i, 'interviewed')
    .replace(/^meet\b/i, 'met')
    .replace(/^sell\b/i, 'sold');
}

/** Their words for what they finished: the sentence that says it, and what they found, as they wrote them. */
function evidenceOf(message: string, quote: string): string {
  const own = ownSentences(message);
  const at = own.indexOf(quote);
  const found = own.slice(at + 1, at + 4).filter((x) => !x.trim().endsWith('?') && !asksFor(x));
  return [quote, ...found].join(' ').slice(0, 600).trim();
}

/** The stored step the report finishes; a report of other work of the path ("done, I talked to all ten") does not. */
function finished(
  input: DecideInput,
  report: MessageReport | null,
  stored: pathRepo.PathStepRecord | null,
  work: readonly ReportedWork[],
): Decision['completes'] {
  if (report === null || stored === null) return null;
  if (
    work.length > 0 &&
    stored.criterionId !== null &&
    stored.origin === 'path' &&
    !work.some((w) => w.criterion.id === stored.criterionId)
  )
    return null;
  // Part of the way is progress, whatever else the message says is done.
  if (work.some((w) => w.criterion.id === stored.criterionId && w.status === 'open')) return null;
  if (!reportFinishes(input.message, report, stored)) return null;
  return {
    step: stored,
    evidence: evidenceOf(ownWords(input.message), report.quote),
    rest: restOf(input, stored, playOf(input.playbook, stored.playId), deadlineOf(input)),
  };
}

/** Whether a text already names the step (at least half of its title's subject words). */
export function namesStep(text: string | null, title: string): boolean {
  if (text === null) return false;
  const words = subjectWords(title);
  if (words.length === 0) return false;
  const said = new Set(subjectWords(text));
  return words.filter((w) => said.has(w)).length * 2 >= words.length;
}

function subjectWords(text: string): string[] {
  return [...new Set(subjectStems(text).concat(text.match(/\d+/g) ?? []))];
}

/** The play whose method the turn rests on: the one that answers, else that of the step they go on about. */
export function evidencePlayOf(playbook: Playbook, decision: Decision): Play | null {
  if (decision.kind === 'recall') return null;
  return decision.play ?? (decision.carried ? playOf(playbook, decision.step?.view.playId ?? null) : null);
}

/** Kept with the turn and shown under the reply; null on a turn that gives no step (social, rehearsal, crisis). */
export function guidanceOf(playbook: Playbook, decision: Decision): TurnGuidance | null {
  if (decision.kind === 'social' || decision.kind === 'rehearsal' || decision.kind === 'crisis') return null;
  if (decision.step === null && decision.referral === null) return null;
  const { play, step } = decision;
  return {
    intent: decision.intent,
    playId: play?.id ?? step?.view.playId ?? null,
    stage: decision.state.stage,
    stageTitle: decision.stageTitle,
    stageNumber: decision.state.stageIndex + 1,
    stageCount: decision.stageCount,
    step: step?.view ?? null,
    ...(decision.pathStep === null ? {} : { pathStep: decision.pathStep }),
    ...(decision.offered ? { offered: true } : {}),
    then: decision.then.slice(0, 2).map((s) => s.title),
    referral: decision.referral,
    citations: play !== null ? citationsOf(playbook, play) : (step?.view.citations ?? []),
  };
}

export type { VentureStage };
