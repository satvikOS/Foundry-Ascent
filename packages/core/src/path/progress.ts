import { type PathCriterion } from '@foundry/contracts';
import { type pathRepo } from '@foundry/db';

import {
  askedIn,
  correctionOf,
  talliesIn,
  tallyOf,
  type Act,
  type Correction,
  type Tally,
} from './counts.js';
import { asksFor, ownSentences, statesItHappened } from './kinds.js';
import {
  neededFor,
  progressEvidence,
  stageOrder,
  topicOf,
  wordsOfEvidence,
  type CriterionState,
  type PathSource,
  type PathState,
  type Progress,
} from './state.js';
import { type Playbook } from './types.js';
import { contentStems, countsIn, plain } from './words.js';

/**
 * Work a founder reports beyond their step ("I did eight interviews, six said the same thing" on a path still at the
 * idea): which criterion it counts for, how far it gets there, and the stage it belongs to. By rule, in their words, with
 * the number that did it (counts.ts) or none at all.
 */
export interface ReportedWork {
  readonly criterion: PathCriterion;
  /** Null: the criterion asks for no count, or is reached. */
  readonly progress: Progress | null;
  readonly status: 'claimed' | 'open';
  /** The founder's own words for it, with the finding they gave beside it. */
  readonly words: string;
  /** They took an earlier number back: what it was. */
  readonly corrects?: number;
}

/** One subject of reported work: how a founder says it, and which criteria (by their own topic) it counts for. */
interface WorkTopic {
  readonly said: RegExp;
  /** The criterion's subject, read in its title and what counts as shown. */
  readonly criterion: RegExp;
  readonly inEvidence?: boolean;
  /** What is counted of it; absent: how many it was offered to. */
  readonly acts?: readonly Act[];
}

const TOPICS: readonly WorkTopic[] = [
  {
    said: /\b(?:price|pricing) (?:test|experiment)s?\b|\b(?:offered|tried|tested) (?:it |them |\w+ ){0,3}(?:at|for) \$?\d|\boffered at \$?\d/,
    criterion: /\b(?:price|pricing)\b/,
  },
  {
    said: /./,
    criterion: /\b(?:paying|paid|payment|signed|pre-?order(?:s|ed)?|committed|deposits?)\b/,
    inEvidence: true,
    // A spoken yes is none: it counts when it is paid or signed.
    acts: ['paid', 'signed'],
  },
  {
    said: /./,
    criterion:
      /\b(?:interviews?|talk(?:ed)? to|conversations?|people (?:described|told|said)|last time (?:it|this|they))/,
    acts: ['talked'],
  },
];

/** The topic a criterion is of, by its title (or what counts as shown). */
const isOf = (topic: WorkTopic, c: PathCriterion): boolean =>
  topic.criterion.test(plain(c.title)) ||
  (topic.inEvidence === true && topic.criterion.test(plain(c.evidence)));

/** The founder's words for a claim: the sentence that says it and what they found, as they wrote them. */
function wordsFor(own: readonly string[], index: number): string {
  const finding = own
    .slice(index + 1, index + 3)
    .filter((s) => !s.trim().endsWith('?') && !asksFor(s))
    .join(' ');
  // "2 paid." tells nothing without the sentence before it.
  const said = own[index] ?? '';
  const before = own[index - 1] ?? '';
  const lead =
    contentStems(said).length < 3 && before !== '' && !before.trim().endsWith('?') ? `${before} ` : '';
  return `${lead}${said} ${finding}`.replace(/\s+/g, ' ').trim().slice(0, 600);
}

/**
 * What the message reports as done towards the path's criteria: the first criterion of each subject still to show, with
 * the count said ("eight interviews" of ten asked for is progress; "two more" adds to what was reported before).
 */
export function reportedWork(state: PathState, text: string): ReportedWork[] {
  const own = ownSentences(text);
  const out: ReportedWork[] = [];
  const correction = correctionOf(text);
  if (correction !== null) {
    const corrected = corrects(state, correction, own);
    if (corrected !== null) return [corrected];
  }
  const tallies = talliesIn(text);
  for (const topic of TOPICS) {
    const found = countedBy(topic, own, tallies);
    if (found === null) continue;
    const target = state.criteria.find(
      (c) =>
        c.status === 'open' &&
        !out.some((o) => o.criterion.id === c.criterion.id) &&
        isOf(topic, c.criterion),
    );
    if (target === undefined) continue;
    const words = wordsFor(own, found.at);
    const needed = neededFor(target.criterion);
    if (needed <= 1) {
      out.push({ criterion: target.criterion, progress: null, status: 'claimed', words });
      continue;
    }
    if (found.count === null || found.count === 0) continue;
    const before = target.progress?.done ?? 0;
    // "Two more" adds; "in all" is the total; a smaller number than was reported is new work; the same or a larger one is
    // the total so far.
    const done = found.more || (!found.total && found.count < before) ? before + found.count : found.count;
    out.push(
      done >= needed
        ? { criterion: target.criterion, progress: null, status: 'claimed', words }
        : {
            criterion: target.criterion,
            progress: { done: found.total ? done : Math.max(done, before), of: needed },
            status: 'open',
            words,
          },
    );
  }
  if (out.length > 0) return out;
  // No subject of its own: a finished thing that holds most of a criterion's words ("I submitted the canvas").
  for (const [i, sentence] of own.entries()) {
    if (!statesItHappened(sentence)) continue;
    const s = plain(sentence);
    if (
      !/\b(?:i|we) (?:have |just |finally )*(?:submitted|turned in|handed in|finished|wrote|written|filled(?: in| out)?|completed|chose|chosen|named|mapped)\b/.test(
        s,
      )
    )
      continue;
    const held = new Set(contentStems(sentence));
    const target = state.criteria.find((c) => {
      if (c.status !== 'open' || neededFor(c.criterion) > 5) return false;
      const words = contentStems(c.criterion.title);
      const shared = words.filter((w) => held.has(w)).length;
      return words.length >= 2 && shared >= 2 && shared * 3 >= words.length * 2;
    });
    if (target !== undefined)
      return [{ criterion: target.criterion, progress: null, status: 'claimed', words: wordsFor(own, i) }];
  }
  return [];
}

interface Counted {
  readonly count: number | null;
  readonly more: boolean;
  readonly total: boolean;
  readonly at: number;
}

/** What the message counts of a topic: the number that did it, or how many it was offered to. */
function countedBy(topic: WorkTopic, own: readonly string[], tallies: readonly Tally[]): Counted | null {
  if (topic.acts !== undefined) return tallyOf(tallies, topic.acts);
  const at = own.findIndex(
    (s) => topic.said.test(plain(s)) && !s.trim().endsWith('?') && statesItHappened(s),
  );
  if (at < 0) return null;
  const asked = own.map(askedIn).find((n) => n !== null) ?? null;
  return { count: asked, more: false, total: false, at };
}

/** The criterion whose number they take back, at the number it is. */
function corrects(state: PathState, c: Correction, own: readonly string[]): ReportedWork | null {
  // What was told of it: how far they are, or, reached, the number it took (said at once, or added up).
  const counted = (x: CriterionState): number[] =>
    x.progress !== null
      ? [x.progress.done]
      : x.by === 'path' && x.status !== 'open' && neededFor(x.criterion) > 1
        ? [...countsIn(wordsOfEvidence(x.evidence ?? '')), neededFor(x.criterion)]
        : [];
  const target = state.criteria.find((x) => {
    const said = counted(x);
    if (said.length === 0 || (c.was !== null && !said.includes(c.was))) return false;
    if (c.act === null) return c.was !== null;
    const act = c.act;
    return TOPICS.some((t) => t.acts?.includes(act) === true && isOf(t, x.criterion));
  });
  if (target === undefined) return null;
  const was = c.was ?? counted(target).at(-1) ?? c.is;
  if (was === c.is) return null;
  const needed = neededFor(target.criterion);
  const words = wordsFor(own, c.at);
  return c.is >= needed
    ? { criterion: target.criterion, progress: null, status: 'claimed', words, corrects: was }
    : {
        criterion: target.criterion,
        progress: { done: c.is, of: needed },
        status: 'open',
        words,
        corrects: was,
      };
}

/** Whether a criterion the playbook reads by a count is short of it in `words` (a claim of it is not one yet). */
export function shortOfCount(criterion: PathCriterion, words: string): boolean {
  const needed = neededFor(criterion);
  if (needed <= 1 || topicOf(criterion)?.counted !== true) return false;
  const topic = TOPICS.find((t) => t.acts !== undefined && t.criterion.test(plain(criterion.title)));
  const said = topic?.acts === undefined ? null : tallyOf(talliesIn(words), topic.acts);
  return said !== null && said.count < needed;
}

export interface AppliedWork {
  readonly reads: pathRepo.PathReads;
  /** The stage the reported work moved the path to; null: it stays. */
  readonly stage: PathState['stage'] | null;
  /** Criteria the report claims, with the words kept (earlier stages' too, when the stage moved). */
  readonly rows: readonly {
    readonly criterionId: string;
    readonly status: 'claimed' | 'open';
    readonly evidence: string;
    /** A number taken back: the criterion is open again if it was reached. */
    readonly reopens?: boolean;
  }[];
}

/**
 * The path as it reads with the reported work: each criterion claimed or on its way, and, when the furthest is of a later
 * stage, the stage moved there with every earlier criterion claimed by the record, in the founder's words.
 */
export function withWork(
  playbook: Playbook,
  source: PathSource,
  state: PathState,
  work: readonly ReportedWork[],
  /** A criterion their report finished with its step, and their words for it. */
  finished: { readonly criterion: PathCriterion; readonly words: string } | null = null,
): AppliedWork {
  const order = stageOrder(playbook);
  const furthest = Math.max(
    -1,
    // A number taken back moves nothing on.
    ...work.map((w) => (w.corrects === undefined ? order.indexOf(w.criterion.stage) : -1)),
    finished === null ? -1 : order.indexOf(finished.criterion.stage),
  );
  const stage = furthest > state.stageIndex ? (order[furthest] ?? null) : null;
  const rows: {
    criterionId: string;
    status: 'claimed' | 'open';
    evidence: string;
    reopens?: boolean;
  }[] = work.map((w) => ({
    criterionId: w.criterion.id,
    status: w.status,
    evidence: w.progress === null ? w.words.slice(0, 1000) : progressEvidence(w.progress, w.words),
    ...(w.corrects !== undefined && w.status === 'open' ? { reopens: true } : {}),
  }));
  if (stage !== null) {
    const words =
      work.find((w) => w.criterion.stage === stage)?.words ?? finished?.words ?? work[0]?.words ?? '';
    for (const c of state.criteria) {
      if (c.status !== 'open' || order.indexOf(c.criterion.stage) >= furthest) continue;
      const own = rows.find((r) => r.criterionId === c.criterion.id);
      if (own === undefined && c.criterion.id !== finished?.criterion.id)
        rows.push({ criterionId: c.criterion.id, status: 'claimed', evidence: words.slice(0, 1000) });
    }
  }
  const { path, criteria } = source.reads;
  const byId = new Map(rows.map((r) => [r.criterionId, r] as const));
  return {
    stage,
    rows,
    reads: {
      ...source.reads,
      path:
        stage === null
          ? path
          : path === null
            ? {
                ventureId: source.ventureId,
                stage,
                intake: null,
                intakeBy: null,
                pivots: [],
                playbookVersion: playbook.version,
                version: 1,
              }
            : { ...path, stage },
      criteria: [
        ...criteria.filter((c) => !byId.has(c.criterionId)),
        ...rows.map((r) => ({
          criterionId: r.criterionId,
          status: r.status,
          evidence: r.evidence,
          stepId: criteria.find((c) => c.criterionId === r.criterionId)?.stepId ?? null,
          sourceSessionId: null,
          updatedAt: criteria.find((c) => c.criterionId === r.criterionId)?.updatedAt ?? '',
        })),
      ],
    },
  };
}
