import { createHash } from 'node:crypto';

import { type PathStepView, type Play } from '@foundry/contracts';
import { type pathRepo } from '@foundry/db';

import { addDays, dueOnFor, onWeekday } from './dates.js';
import { stepIdFor } from './ids.js';
import { type Commitment, type SmallerAsk } from './kinds.js';
import { isShownCriterion, neededFor, type PathSource, type PathState } from './state.js';
import { type Playbook } from './types.js';
import { countsIn } from './words.js';

/**
 * One step, from its stored row or from the play it would be stored from: its sub-steps, when it is done, its day, and
 * how it is made smaller, taken up again and shown. Pure.
 */
export interface StepContext extends PathSource {
  readonly playbook: Playbook;
  readonly today: string;
}

export interface ChosenStep {
  readonly view: PathStepView;
  /** Not stored yet, stored with another status or due date, or changed (smaller, another day). Null: as it is stored. */
  readonly write: 'insert' | 'promote' | 'change' | null;
  /** The stored version the write expects (`promote`, `change`). */
  readonly storedVersion: number | null;
}

type Origin = PathStepView['origin'];

export const isOpen = (s: pathRepo.PathStepRecord): boolean => s.status !== 'done' && s.status !== 'skipped';

export const playOf = (playbook: Playbook, id: string | null): Play | null =>
  id === null ? null : (playbook.plays.find((play) => play.id === id) ?? null);

export function citationsOf(playbook: Playbook, play: Play): PathStepView['citations'] {
  return play.citations.flatMap((c) => {
    const source = playbook.sources.find((s) => s.id === c.sourceId);
    return source === undefined
      ? []
      : [{ ...c, title: source.title, authors: source.authors, url: source.url }];
  });
}

/** The step as the contract shows it, from its stored row. */
export function stepView(row: pathRepo.PathStepRecord): PathStepView {
  return {
    id: row.id,
    playId: row.playId,
    criterionId: row.criterionId,
    title: row.title,
    items: row.items.map((i) => ({ ...i })),
    doneWhen: row.doneWhen,
    dueOn: row.dueOn,
    status: row.status,
    origin: row.origin,
    evidence: row.evidence,
    template: row.template,
    citations: row.citations.map((c) => ({ ...c })),
    completedAt: row.completedAt,
    version: row.version,
  };
}

function attemptOf(steps: readonly pathRepo.PathStepRecord[], playId: string, origin: Origin): number {
  return steps.filter((s) => s.playId === playId && s.origin === origin && !isOpen(s)).length + 1;
}

const itemsOf = (play: Play): PathStepView['items'] =>
  play.steps.map((s) => ({ do: s.do, how: s.how, minutes: s.minutes, done: false }));

/** A play's step for this venture: its open row when it has one, else the step its first write will store. */
export function stepFor(
  context: StepContext,
  play: Play,
  options: {
    readonly status: PathStepView['status'];
    readonly criterionId: string | null;
    readonly origin?: Origin;
  },
): { view: PathStepView; row: pathRepo.PathStepRecord | null } {
  const origin = options.origin ?? 'path';
  const row =
    context.reads.steps.find((s) => s.playId === play.id && s.origin === origin && isOpen(s)) ?? null;
  if (row !== null) return { view: stepView(row), row };
  return {
    row: null,
    view: {
      id: stepIdFor({
        ventureId: context.ventureId,
        playId: play.id,
        origin,
        attempt: attemptOf(context.reads.steps, play.id, origin),
      }),
      playId: play.id,
      criterionId: options.criterionId,
      title: play.title,
      items: itemsOf(play),
      doneWhen: play.doneWhen,
      dueOn: null,
      status: options.status,
      origin,
      evidence: null,
      template: play.template,
      citations: citationsOf(context.playbook, play),
      completedAt: null,
      version: 1,
    },
  };
}

export const deadlineOf = (context: StepContext): string | null =>
  context.reads.path?.intake?.deadline?.on ?? null;

/** A play as the step to do now: due from today, its stored row promoted when it waited. */
export function nowStep(context: StepContext, play: Play, criterionId: string | null): ChosenStep {
  const { view, row } = stepFor(context, play, { status: 'now', criterionId });
  const due = dueOnFor(context.today, play.days, deadlineOf(context));
  if (row === null) return { view: { ...view, dueOn: due }, write: 'insert', storedVersion: null };
  if (row.status === 'now') return { view, write: null, storedVersion: row.version };
  return {
    view: {
      ...view,
      status: 'now',
      dueOn: row.dueOn !== null && row.dueOn >= context.today ? row.dueOn : due,
    },
    write: 'promote',
    storedVersion: row.version,
  };
}

/** The first criterion the play shows that is still open: of the current stage first (its own play before others). */
export function openCriterionOf(state: PathState, play: Play, inStage: boolean): string | null {
  const open = state.criteria.filter(
    (c) =>
      c.status === 'open' &&
      (c.criterion.playId === play.id || play.criteria.includes(c.criterion.id)) &&
      (!inStage || c.criterion.stage === state.stage),
  );
  const own = open.find((c) => c.criterion.playId === play.id);
  return (own ?? open[0])?.criterion.id ?? null;
}

// Smaller ----------------------------------------------------------------------------------------------------

/** Most characters of a done-when (`path_steps`). */
const DONE_CHARS = 400;
const DEFAULT_MINUTES = 30;
const LEAST_MINUTES = 10;
const PART = /^(?:First \d+ minutes of|The first part of): /;
const minutesOf = (item: PathStepView['items'][number]): number => item.minutes ?? DEFAULT_MINUTES;
const lowerFirst = (text: string): string =>
  /^[A-Z][a-z]/.test(text) ? `${text.charAt(0).toLowerCase()}${text.slice(1)}` : text;
const clause = (text: string): string => lowerFirst(text.replace(/[\s.!?;]+$/u, '').trim());

const NUMBER_WORDS =
  'two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|\\d{1,3}';
const COUNTED = new RegExp(`\\b(?:(?:all|the|these|those|my|our) )*(${NUMBER_WORDS}) (?=[a-z])`, 'i');

/** One of a number ("email the five theatre groups" → "Email one of the five theatre groups"); null: it has no count. */
function oneOf(whole: string): string | null {
  if (/\bone of the\b/i.test(whole) || (countsIn(whole)[0] ?? 0) <= 1) return null;
  const said = whole.replace(COUNTED, (_m, n: string) => `one of the ${n} `);
  return said === whole ? null : `${said.charAt(0).toUpperCase()}${said.slice(1)}`;
}

/**
 * The same step cut to its first doable item or items within the time they have, done when those are, and due soon. Null:
 * it fits as it is, or there is nothing left to cut.
 */
export function smallerStep(view: PathStepView, ask: SmallerAsk, today: string): PathStepView | null {
  const left = view.items.filter((i) => !i.done);
  const first = left[0];
  if (first === undefined) return null;
  const total = left.reduce((sum, i) => sum + minutesOf(i), 0);
  if (!ask.strict && (ask.minutes === null || total <= ask.minutes)) return null;
  const last = left.at(-1);
  // Too big is too big, whatever they have: at least the last item waits.
  const most =
    left.length > 1 && ask.strict && last !== undefined ? total - minutesOf(last) : Number.POSITIVE_INFINITY;
  const had =
    ask.minutes ?? (left.length > 1 ? minutesOf(first) : Math.max(LEAST_MINUTES, Math.floor(total / 2)));
  const budget = Math.max(LEAST_MINUTES, Math.min(had, most));
  const taken = new Set<PathStepView['items'][number]>();
  let spent = 0;
  for (const item of left) {
    if (spent + minutesOf(item) > budget) break;
    taken.add(item);
    spent += minutesOf(item);
  }
  // All of it fits the time they have.
  if (taken.size === left.length) return null;
  // Not even the first one fits: a first part of it, by the time they have, one of a number, or the start of it.
  const whole = clause(first.do.replace(PART, ''));
  const part =
    taken.size === 0
      ? {
          ...first,
          do:
            ask.minutes !== null
              ? `First ${String(budget)} minutes of: ${whole}`
              : (oneOf(whole) ?? `The first part of: ${whole}`),
          minutes: ask.minutes === null && first.minutes === null ? null : budget,
        }
      : null;
  const items =
    part === null
      ? view.items.filter((i) => i.done || taken.has(i))
      : view.items.filter((i) => i.done || i === first).map((i) => (i === first ? part : i));
  const doing = items.filter((i) => !i.done);
  return {
    ...view,
    items,
    doneWhen:
      doing.length === 1
        ? `This one part is done: ${clause(doing[0]?.do ?? '')}.`
        : `These ${String(doing.length)} parts are done: ${doing.map((i) => clause(i.do)).join('; ')}.`.slice(
            0,
            DONE_CHARS,
          ),
    dueOn: ask.today ? today : onWeekday(addDays(today, 1)),
  };
}

const CUT_DONE = /^(?:This one part is|These \d+ parts are) done: /;

/** Whether a stored step was made smaller than its play ({@link smallerStep}). */
export function isCut(step: Pick<pathRepo.PathStepRecord, 'doneWhen'>, play: Play | null): boolean {
  return play !== null && CUT_DONE.test(step.doneWhen);
}

/**
 * A step made smaller whose small part is done: the rest of it, as the play has it, due from today. Null when nothing is
 * left (the step is finished).
 */
export function restOf(
  context: Pick<StepContext, 'today'>,
  step: pathRepo.PathStepRecord,
  play: Play | null,
  deadline: string | null,
): { readonly items: PathStepView['items']; readonly doneWhen: string; readonly dueOn: string } | null {
  if (play === null || !isCut(step, play)) return null;
  const items = play.steps.map((s) => ({
    do: s.do,
    how: s.how,
    minutes: s.minutes,
    done: step.items.some((i) => i.do === s.do),
  }));
  if (items.every((i) => i.done)) return null;
  return { items, doneWhen: play.doneWhen, dueOn: dueOnFor(context.today, play.days, deadline) };
}

// What a pick or a result makes of it ------------------------------------------------------------------------------

/** The people or the thing of a way to customers ("talk to team captains" → "team captains"). */
export const wayOf = (option: string): string =>
  option
    .replace(/[\s.!?]+$/u, '')
    .replace(
      /^(?:talk(?:ing)? (?:to|with)|speak(?:ing)? (?:to|with)|go(?:ing)? (?:to|through)|ask(?:ing)?|us(?:e|ing)|do(?:ing)?|post(?:ing)? (?:on|in)|sell(?:ing)? (?:to|through)|try(?:ing)?|run(?:ning)?|through|via|by|the|a|an|two|three|our|my) /iu,
      '',
    )
    .trim();

/** "Which channel first?", decided by where their buyers came from: the step copies that way, and tries no three. */
export function pickedChannel(view: PathStepView, option: string): PathStepView {
  const way = lowerFirst(wayOf(option));
  return {
    ...view,
    title: `Ask for 10 more orders through ${way}`.slice(0, TITLE_CHARS),
    items: [
      {
        do: `List 10 more ${way.endsWith('s') ? way : `ways into ${way}`} like the ones that worked`,
        how: 'Ask each buyer who came that way for one name like theirs.',
        minutes: 30,
        done: false,
      },
      {
        do: 'Make each the same offer, at the same price',
        how: 'Same words every time, so the count means something.',
        minutes: 120,
        done: false,
      },
      {
        do: 'Write hours, talks and orders for each',
        how: 'Hours for one order is the number to beat when you try another way later.',
        minutes: 15,
        done: false,
      },
    ],
    doneWhen: `10 more were asked through ${way}, and the hours and orders of each are written down.`,
    template: null,
  };
}

/** A weak result: the ones it came from are asked why, both sides. Null: there is nobody to ask. */
export function askWhyStep(
  context: Pick<StepContext, 'today'>,
  result: { readonly part: number; readonly whole: number },
  view: PathStepView,
): PathStepView | null {
  const no = result.whole - result.part;
  if (no <= 0) return null;
  const others = no <= 5 ? `the ${String(no)} who did not` : `five of the ${String(no)} who did not`;
  const yes = result.part === 0 ? '' : `the ${result.part === 1 ? 'one' : String(result.part)} who said yes`;
  return {
    ...view,
    title: yes === '' ? `Ask ${others} what stopped them` : `Ask ${yes} why, and ${others} what stopped them`,
    items: [
      ...(yes === ''
        ? []
        : [
            {
              do: `Ask ${yes} what made them do it`,
              how: 'What was going on that day, and what they would have done without it. Their words, not yours.',
              minutes: 15 * Math.min(result.part, 6),
              done: false,
            },
          ]),
      {
        do: `Ask ${others} what stopped them`,
        how: 'Do not sell. Ask what they did instead, and what that cost them.',
        minutes: 60,
        done: false,
      },
      {
        do: 'Write in one line what the two groups say differently',
        how: 'That is the one thing to change before the next round.',
        minutes: 15,
        done: false,
      },
    ],
    doneWhen:
      yes === ''
        ? 'You have their words from at least five of them, and one line says what to change.'
        : 'You have the words of both groups, and one line says what they say differently.',
    dueOn: dueOnFor(context.today, 5, null),
    template: null,
  };
}

// In the founder's own words ------------------------------------------------------------------------------------

/** Most characters of a step's title (`path_steps`). */
const TITLE_CHARS = 120;

/** What they will do as done ("email" → "emailed"), and what can be said of it then. */
const DID: Readonly<Record<string, readonly [did: string, count: string, came: string]>> = {
  ask: ['asked', 'how many said yes', 'what they said'],
  offer: ['offered it to', 'how many said yes', 'what they said'],
  email: ['emailed', 'how many answered', 'what came back'],
  message: ['messaged', 'how many answered', 'what came back'],
  text: ['texted', 'how many answered', 'what came back'],
  dm: ['messaged', 'how many answered', 'what came back'],
  contact: ['contacted', 'how many answered', 'what came back'],
  call: ['called', 'how many picked up', 'what they said'],
  talk: ['talked', 'what most of them said', 'what they said'],
  speak: ['spoken', 'what most of them said', 'what they said'],
  interview: ['interviewed', 'what most of them said', 'what they said'],
  meet: ['met', 'what most of them said', 'what they said'],
  visit: ['visited', 'what you saw in each', 'what you saw'],
  sell: ['sold', 'who bought and at what price', 'who bought and at what price'],
  pitch: ['pitched', 'how many said yes', 'what they asked'],
  show: ['shown', 'what each of them did', 'what they did'],
  survey: ['surveyed', 'how many answered', 'what they answered'],
  send: ['sent', 'how many answered', 'what came back'],
  post: ['posted', 'how many answered', 'what came back'],
  write: ['written', '', ''],
  draft: ['drafted', '', ''],
  build: ['built', '', ''],
  make: ['made', '', ''],
  finish: ['finished', '', ''],
  submit: ['submitted', '', ''],
  read: ['read', '', ''],
  list: ['listed', '', ''],
  book: ['booked', '', ''],
  print: ['printed', '', ''],
  find: ['found', '', ''],
  pick: ['picked', '', ''],
  choose: ['chosen', '', ''],
  count: ['counted', '', ''],
  file: ['filed', '', ''],
  launch: ['launched', 'who came', 'who came'],
  run: ['run', 'what came of it', 'what came of it'],
  test: ['tested', 'what came of it', 'what came of it'],
  try: ['tried', 'what came of it', 'what came of it'],
  do: ['done', 'what came of it', 'what came of it'],
};

/** When what they said they would do is done, in checkable words ("you have asked 5 caterers and can say how many said yes"). */
export function doneWhenOf(said: string): string {
  const whole = clause(said);
  const verb = /^[a-z]+/i.exec(whole)?.[0].toLowerCase() ?? '';
  const did = DID[verb];
  if (did === undefined) return `You have done it, and can say in one line what came of it: ${whole}.`;
  const rest = whole.slice(verb.length).trim();
  const say = (countsIn(whole)[0] ?? 0) > 1 && !/\bone of the\b/i.test(whole) ? did[1] : did[2];
  return `You have ${did[0]}${rest === '' ? '' : ` ${rest}`}${say === '' ? '' : ` and can say ${say}`}.`;
}

/**
 * What the founder said they would do, as their step: their words for its title, the method of the play it belongs to
 * when the playbook has one, and their day.
 */
export function ownStep(
  context: StepContext,
  said: Commitment,
  play: Play | null,
  criterionId: string | null,
): ChosenStep {
  const title = `${said.clause.charAt(0).toUpperCase()}${said.clause.slice(1)}`.slice(0, TITLE_CHARS).trim();
  const key = createHash('sha256').update(title.toLowerCase()).digest('hex').slice(0, 16);
  const attempt =
    context.reads.steps.filter(
      (s) => s.origin === 'founder' && s.title.toLowerCase() === title.toLowerCase() && !isOpen(s),
    ).length + 1;
  const row =
    context.reads.steps.find(
      (s) => s.origin === 'founder' && isOpen(s) && s.title.toLowerCase() === title.toLowerCase(),
    ) ?? null;
  const due = said.dueOn ?? dueOnFor(context.today, play?.days ?? 4, deadlineOf(context));
  if (row !== null) {
    const view: PathStepView = { ...stepView(row), status: 'now', dueOn: said.dueOn ?? row.dueOn ?? due };
    const same = row.status === 'now' && row.dueOn === view.dueOn;
    return {
      view,
      write: same ? null : row.status === 'now' ? 'change' : 'promote',
      storedVersion: row.version,
    };
  }
  return {
    write: 'insert',
    storedVersion: null,
    view: {
      id: stepIdFor({ ventureId: context.ventureId, playId: `own:${key}`, origin: 'founder', attempt }),
      playId: play?.id ?? null,
      criterionId,
      title,
      items:
        play === null
          ? [
              {
                do: title,
                how: 'As you said you would. Keep one line on what came of it.',
                minutes: null,
                done: false,
              },
            ]
          : itemsOf(play),
      doneWhen: doneWhenOf(said.clause),
      dueOn: due,
      status: 'now',
      origin: 'founder',
      evidence: null,
      template: play?.template ?? null,
      citations: play === null ? [] : citationsOf(context.playbook, play),
      completedAt: null,
      version: 1,
    },
  };
}

// As it is shown ---------------------------------------------------------------------------------------------------

/** What is left of a counted step, as an instruction ("Hold 2 more customer talks"). */
function restTitle(title: string, evidence: string, rest: number): string {
  const left = `${String(rest)} more`;
  const one = rest === 1;
  if (/\b(?:conversations?|interviews?|talks?|people (?:described|told|said))\b/i.test(evidence))
    return `Hold ${left} customer ${one ? 'talk' : 'talks'}`;
  if (/\b(?:customers?|buyers?)\b/i.test(evidence)) return `Win ${left} ${one ? 'customer' : 'customers'}`;
  return `${title}: ${left}`;
}

/**
 * The step as it is shown: when its criterion is already part of the way ("8 of 10"), what remains of it, with the work
 * before the first talk taken as done. Never stored: the rows keep the play's own words.
 */
export function shownStep(view: PathStepView, state: PathState): PathStepView {
  if (view.criterionId === null || view.origin === 'founder' || view.playId === null) return view;
  if (view.status === 'done' || view.status === 'skipped') return view;
  const c = state.criteria.find((x) => x.criterion.id === view.criterionId);
  if (c?.progress === null || c?.progress === undefined || isShownCriterion(state, view.criterionId))
    return view;
  // Another way to the same evidence ("write a cold email") is not itself counted.
  const counted = new RegExp(
    `\\b${String(c.progress.of)} (?:people|talks?|interviews?|conversations?|customers?|buyers?|strangers?)\\b`,
  );
  if (c.criterion.playId !== view.playId && !counted.test(view.doneWhen)) return view;
  if (neededFor(c.criterion) !== c.progress.of) return view;
  const rest = c.progress.of - c.progress.done;
  const longest = view.items.reduce(
    (best, item, i) => (minutesOf(item) > minutesOf(view.items[best] ?? item) ? i : best),
    0,
  );
  return {
    ...view,
    title: restTitle(view.title, c.criterion.evidence, rest),
    items: view.items.map((item, i) => (i < longest ? { ...item, done: true } : item)),
    doneWhen:
      `${String(rest)} more ${rest === 1 ? 'makes' : 'make'} ${String(c.progress.of)} in all: ${clause(c.criterion.evidence).replace(/^A (?=[a-z])/, 'a ')}.`.slice(
        0,
        DONE_CHARS,
      ),
  };
}
