import { type PathCriterion } from '@foundry/contracts';
import { type pathRepo } from '@foundry/db';

import { asksFor, ownSentences, statesItHappened } from './kinds.js';
import {
  neededFor,
  progressEvidence,
  stageOrder,
  topicOf,
  type PathSource,
  type PathState,
  type Progress,
} from './state.js';
import { type Playbook } from './types.js';
import { contentStems, numberOf, plain } from './words.js';

/**
 * Work a founder reports beyond their step ("I did eight interviews, six said the same thing" on a path still at the
 * idea): which criterion it counts for, how far it gets there, and the stage it belongs to. By rule, in their words.
 */
export interface ReportedWork {
  readonly criterion: PathCriterion;
  /** Null: the criterion asks for no count, or is reached. */
  readonly progress: Progress | null;
  readonly status: 'claimed' | 'open';
  /** The founder's own words for it, with the finding they gave beside it. */
  readonly words: string;
}

/** One subject of reported work: how a founder says it, and which criteria (by their own topic) it counts for. */
interface WorkTopic {
  readonly said: RegExp;
  /** The criterion's subject, read in its title and what counts as shown. */
  readonly criterion: RegExp;
  readonly inEvidence?: boolean;
  /** Wins over the topics after it in the same sentence. */
  readonly alone?: boolean;
}

const MONEY_WORK =
  /\b(?:sold|bought|paid|pre-?ordered|ordered|purchased|signed(?! up\b| in\b| off\b)|said yes|put down (?:a )?deposits?|became customers?)\b/;
const TOPICS: readonly WorkTopic[] = [
  {
    said: /\b(?:price|pricing) (?:test|experiment)s?\b|\b(?:offered|tried|tested) (?:it |them |\w+ ){0,3}(?:at|for) \$?\d/,
    criterion: /\b(?:price|pricing)\b/,
  },
  {
    said: MONEY_WORK,
    criterion: /\b(?:paying|paid|payment|signed|pre-?order(?:s|ed)?|committed|deposits?)\b/,
    inEvidence: true,
    alone: true,
  },
  {
    said: /\b(?:interview(?:ed|s)?|talked (?:to|with)|spoke (?:to|with)|spoken (?:to|with)|chatted with|sat down with|met with|conversations? with|had \w+ conversations?)\b/,
    criterion:
      /\b(?:interviews?|talk(?:ed)? to|conversations?|people (?:described|told|said)|last time (?:it|this|they))/,
  },
];
/** A sentence whose count is of something else ("in 12 days", "6 dollars", "40 percent"). */
const UNIT_AFTER =
  /^(?:dollar|buck|cent|percent|pct|minute|min|hour|hr|day|week|month|year|am|pm|o'clock|am\.|pm\.|st|nd|rd|th)s?$/;
const ACTED_BY_OTHERS =
  /\b(?:of (?:them|these|those)|people|students|customers?|schools?|labs?|clinics?|shops?|teams?)\b/;

const ACTED_SENTENCE =
  /\b(?:i|we|my cofounder|my co-founder|my team|our team)\b|\b(?:of (?:them|these|those|us))\b|^\W*(?:\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/;

/** The count said nearest to `match` in the sentence (its own words only, no money, dates or percentages). */
function countNear(sentence: string, said: RegExp): number | null {
  const s = plain(sentence);
  const found = said.exec(s);
  if (found === null) return null;
  const words = [...s.matchAll(/[\p{L}\p{N}$€£%.,'-]+/gu)].map((m) => ({ text: m[0], at: m.index }));
  const at = words.findIndex((w) => w.at + w.text.length > found.index);
  let best: { n: number; distance: number } | null = null;
  words.forEach((w, i) => {
    const bare = w.text.replace(/^[.,'-]+|[.,'-]+$/g, '');
    if (/[$€£%]/.test(bare)) return;
    const n = numberOf(bare);
    if (n === null || n > 100_000) return;
    const next = words[i + 1]?.text.replace(/[.,]+$/g, '') ?? '';
    if (UNIT_AFTER.test(next)) return;
    const distance = Math.abs(i - at);
    if (best === null || distance < best.distance) best = { n, distance };
  });
  return (best as { n: number; distance: number } | null)?.n ?? null;
}

const MORE = /\b(?:more|another|additional|extra)\b/;

/** The founder's words for a claim: the sentence that says it and what they found, as they wrote them. */
function wordsFor(own: readonly string[], index: number): string {
  const finding = own
    .slice(index + 1, index + 3)
    .filter((s) => !s.trim().endsWith('?') && !asksFor(s))
    .join(' ');
  return `${own[index] ?? ''} ${finding}`.replace(/\s+/g, ' ').trim().slice(0, 600);
}

/**
 * What the message reports as done towards the path's criteria: the first criterion of each subject still to show, with
 * the count said ("eight interviews" of ten asked for is progress; "two more" adds to what was reported before).
 */
export function reportedWork(state: PathState, text: string): ReportedWork[] {
  const own = ownSentences(text);
  const out: ReportedWork[] = [];
  own.forEach((sentence, i) => {
    if (!statesItHappened(sentence)) return;
    const s = plain(sentence);
    if (!ACTED_SENTENCE.test(s) && !ACTED_BY_OTHERS.test(s)) return;
    for (const topic of TOPICS) {
      if (!topic.said.test(s)) continue;
      const target = state.criteria.find((c) => {
        if (c.status !== 'open' || out.some((o) => o.criterion.id === c.criterion.id)) return false;
        if (topic.criterion.test(plain(c.criterion.title))) return true;
        return topic.inEvidence === true && topic.criterion.test(plain(c.criterion.evidence));
      });
      if (target === undefined) continue;
      const needed = neededFor(target.criterion);
      const said = countNear(sentence, topic.said);
      const words = wordsFor(own, i);
      if (needed <= 1) {
        out.push({ criterion: target.criterion, progress: null, status: 'claimed', words });
      } else if (said !== null) {
        const before = target.progress?.done ?? 0;
        // "Two more" adds; a smaller number than was reported is new work; the same or a larger one is the total so far.
        const done = MORE.test(s) || said < before ? before + said : said;
        out.push(
          done >= needed
            ? { criterion: target.criterion, progress: null, status: 'claimed', words }
            : done > before
              ? { criterion: target.criterion, progress: { done, of: needed }, status: 'open', words }
              : {
                  criterion: target.criterion,
                  progress: { done: before, of: needed },
                  status: 'open',
                  words,
                },
        );
      }
      if (topic.alone === true) break;
    }
  });
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

/** Whether a criterion the playbook reads by a count is short of it in `words` (a claim of it is not one yet). */
export function shortOfCount(criterion: PathCriterion, words: string): boolean {
  const needed = neededFor(criterion);
  if (needed <= 1 || topicOf(criterion)?.counted !== true) return false;
  const topic = TOPICS.find((t) => t.criterion.test(plain(criterion.title)) && t.said.test(plain(words)));
  const said = topic === undefined ? null : countNear(words, topic.said);
  return said !== null && said < needed;
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
    ...work.map((w) => order.indexOf(w.criterion.stage)),
    finished === null ? -1 : order.indexOf(finished.criterion.stage),
  );
  const stage = furthest > state.stageIndex ? (order[furthest] ?? null) : null;
  const rows: { criterionId: string; status: 'claimed' | 'open'; evidence: string }[] = work.map((w) => ({
    criterionId: w.criterion.id,
    status: w.status,
    evidence: w.progress === null ? w.words.slice(0, 1000) : progressEvidence(w.progress, w.words),
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
