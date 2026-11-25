import { type CriterionStatus, type PathCriterion, type VentureStage } from '@foundry/contracts';
import { type pathRepo } from '@foundry/db';

import { type Playbook } from './types.js';
import { contentStems, countsIn, plain, statedAsFact } from './words.js';

type VentureStageValue = VentureStage;

/** What the path is read from: the stored path, the venture's record and the stage the program set. */
export interface PathSource {
  readonly ventureId: string;
  readonly venture: {
    readonly name: string;
    readonly stage: VentureStageValue;
    readonly oneLiner: string;
    readonly domain: string;
    readonly currentGoal: string | null;
  };
  readonly reads: pathRepo.PathReads;
}

export interface CriterionState {
  readonly criterion: PathCriterion;
  readonly status: CriterionStatus;
  /** The founder's words, or the record that shows it (its title). */
  readonly evidence: string | null;
  /** Where it comes from: the path's own rows, the venture's record, or the stage the venture is past. */
  readonly by: 'path' | 'record' | 'stage' | null;
  /** How far they are when it asks for a count and some of it is reported ("8 of 10"). */
  readonly progress: Progress | null;
}

export interface Progress {
  readonly done: number;
  readonly of: number;
}

const PROGRESS = /^(\d{1,4}) of (\d{1,4}): /;

/** The row of a criterion still open, with how far they are and their words ("8 of 10: I did eight interviews."). */
export function progressEvidence(progress: Progress, words: string): string {
  return `${String(progress.done)} of ${String(progress.of)}: ${words}`.slice(0, 1000);
}

export function progressIn(evidence: string | null): Progress | null {
  const found = PROGRESS.exec(evidence ?? '');
  if (found === null) return null;
  const done = Number(found[1]);
  const of = Number(found[2]);
  return done > 0 && done < of ? { done, of } : null;
}

const EARLIER = /^Before (\d{4}-\d{2}-\d{2}): /;

/** What was shown before a change of direction: kept in their words with its day, and counting for nothing now. */
export function earlierEvidence(evidence: string, on: string): string {
  return EARLIER.test(evidence) ? evidence : `Before ${on}: ${evidence}`.slice(0, 1000);
}

/** The day of evidence from before a change of direction; null: it counts as it stands. */
export const earlierDay = (evidence: string): string | null => EARLIER.exec(evidence)?.[1] ?? null;

/** The founder's words of a criterion's evidence, without its count or its day. */
export const wordsOfEvidence = (evidence: string): string =>
  evidence.replace(EARLIER, '').replace(PROGRESS, '').trim();

export interface PathState {
  readonly stage: VentureStageValue;
  readonly stageIndex: number;
  readonly criteria: readonly CriterionState[];
}

/** Memory kinds that show work was done; a hypothesis, a preference or a risk shows none. */
const EVIDENCE_TYPES: ReadonlySet<string> = new Set([
  'evidence',
  'experiment',
  'decision',
  'milestone',
  'fact',
]);

const REACHED =
  /\b(?:signed|sold|launched|won|finished|completed|reached|hit|got|raised|held|ran|shipped|opened|joined|hired|pays?|paid|paying|uses?|renewed)\b/;

/**
 * A milestone that happened. One still open, with a date ahead of it, or kept from what they said they want (a goal is
 * kept as a milestone too) is a goal.
 */
export function milestoneReached(m: pathRepo.PathMemory): boolean {
  const status = typeof m.attributes.status === 'string' ? m.attributes.status : null;
  if (typeof m.attributes.completed_on === 'string') return true;
  if (status !== null) return /^(?:done|completed|reached|met)$/.test(status);
  const text = `${m.title}. ${m.content}`;
  return typeof m.attributes.target_date !== 'string' && REACHED.test(plain(text)) && statedAsFact(text);
}

/** An experiment with a result (a running one shows nothing yet), or any other kind that records work. */
function isShown(m: pathRepo.PathMemory): boolean {
  if (m.status !== 'confirmed' || !EVIDENCE_TYPES.has(m.type)) return false;
  const status = typeof m.attributes.status === 'string' ? m.attributes.status : null;
  if (m.type === 'experiment') return status === 'completed' && Boolean(m.attributes.result);
  if (m.type === 'milestone') return milestoneReached(m);
  return true;
}

/** A note the mentor kept by itself, that no person has approved or corrected. */
const isKeptNote = (m: pathRepo.PathMemory): boolean => m.origin === 'ai' && m.vouched !== true;

/** What is not done yet, however it is kept. */
const PLANNED =
  /\b(?:plan(?:s|ned|ning)?|intends?|intend(?:ed|ing)|wants?|wanted|wish(?:es)?|hop(?:e|es|ed|ing)|consider(?:s|ed|ing)?|think(?:s|ing)? (?:about|of|that)|might|may|could|would|should|will|going to|about to|next step|needs? to|has to|have to|idea (?:is|was)|propos(?:e|es|ed|al)|suggest(?:s|ed)?|aims?|believes?|assumes?|expects?)\b/;

/** Something that was done, or that people do: what a founder's work shows. */
const HAPPENED =
  /\b(?:interviewed|talked|spoke|met|asked|surveyed|visited|watched|tested|tried|built|made|ran|run|held|signed|paid|pays?|paying|bought|sold|ordered|pre-?ordered|booked|launched|shipped|opened|decided|chose|chosen|picked|agreed|settled|switched|dropped|offered|showed|shown|collected|got|received|told|said|described|counted|measured|found|used|uses|using|came back|renewed|filed|registered|formed|incorporated|joined|hired|won|raised|earned|charged|charges|served|finished|completed|lost|kept)\b/;

/** Whether a note kept from a conversation says more than the idea again (a third of its words, at least). */
function saysMoreThan(idea: string, m: pathRepo.PathMemory): boolean {
  const text = m.content.trim() === '' ? m.title : m.content;
  const held = new Set(contentStems(idea));
  const words = contentStems(text);
  const fresh = words.filter((w) => !held.has(w));
  return words.length > 0 && fresh.length * 3 > words.length;
}

/** The venture's idea as its record has it: what a note that only repeats it is compared with. */
export function ideaText(source: Pick<PathSource, 'venture' | 'reads'>): string {
  const { venture, reads } = source;
  const intake = reads.path?.intake;
  return [
    venture.name,
    venture.oneLiner,
    venture.currentGoal ?? '',
    intake?.idea ?? '',
    intake?.customer ?? '',
  ].join('. ');
}

/**
 * Whether the venture's record holds work of its own: it then starts at the stage the program has it at. What a person put
 * there does; a note the mentor kept by itself only when it shows something the path asks for.
 */
export function hasEvidence(
  playbook: Playbook,
  source: Pick<PathSource, 'venture' | 'reads'>,
  memory: readonly pathRepo.PathMemory[] = source.reads.memory,
): boolean {
  const idea = ideaText(source);
  return memory.some(
    (m) =>
      m.status === 'confirmed' &&
      EVIDENCE_TYPES.has(m.type) &&
      (!isKeptNote(m) || playbook.criteria.some((c) => recordShowing(c, [m], idea) !== null)),
  );
}

export interface Topic {
  /** The criterion is about this. */
  readonly criterion: RegExp;
  /** A record shows it. */
  readonly record: RegExp;
  /** Kinds of record that can show it (default: all that show work). */
  readonly types?: readonly string[];
  /** A count the criterion asks for must be reached by one the record gives. */
  readonly counted?: boolean;
  /** Read in what counts as shown, too (else in the criterion's title alone). */
  readonly inEvidence?: boolean;
}

/**
 * What a record shows, by subject: the first topic a criterion is about decides which records count for it. The
 * playbook names its criteria; this table reads them by their words, so a new criterion needs no code.
 */
const TOPICS: readonly Topic[] = [
  {
    criterion:
      /\b(?:interview|talk(?:ed)? to|spoke|spoken|conversation|people (?:described|told|said)|last time (?:it|this|they))/,
    record: /\b(?:interview|talked (?:to|with)|spoke (?:to|with)|conversations? with|described|told us)/,
    types: ['evidence', 'fact', 'milestone', 'experiment'],
    counted: true,
  },
  {
    criterion:
      /\b(?:paying|paid|payment|revenue|first (?:\w+ )?(?:customer|sale|order)|signed|invoice|pre-?order|deposit|letter of intent|pilots?)\b/,
    record:
      /\b(?:paid (?:pilots?|customers?|users?|orders?)|paying (?:customers?|users?|labs?|clients?)|pilots? (?:\w+ ){0,2}(?:signed|paid|running|started)|signed (?:\w+ ){0,4}(?:pilots?|agreements?|contracts?|customers?)|pre-?orders?|deposits?|invoiced|revenue of|first (?:paying )?customers?|sold \w+)/,
    types: ['evidence', 'fact', 'milestone', 'experiment'],
    counted: true,
    inEvidence: true,
  },
  {
    criterion: /\b(?:price|pricing|willing(?:ness)? to pay|charge)\b/,
    record: /\b(?:priced?|pricing|willing to pay|charg(?:e|ed|ing))\b/,
    types: ['evidence', 'experiment', 'decision'],
  },
  {
    criterion: /\b(?:experiment|landing page|smoke test|fake door|test(?:ed)?|demand)\b/,
    record: /./,
    types: ['experiment'],
  },
  {
    criterion: /\b(?:prototype|mvp|working version|demo|build|built)\b/,
    record: /\b(?:prototype|mvp|working version|demo|built|beta)\b/,
    types: ['evidence', 'fact', 'milestone', 'experiment'],
  },
  {
    criterion:
      /\b(?:buyer|decision maker|who (?:pays|buys|signs)|customer segment|beachhead|one customer|target customer|who it is for)\b/,
    record: /\b(?:buyer|sell to|customer segment|beachhead|target|focus on|who (?:pays|buys|signs))\b/,
    types: ['decision', 'evidence', 'fact'],
  },
  {
    criterion: /\b(?:unit economics|gross margin|cost per|break-?even|cost to (?:make|serve))\b/,
    record: /\b(?:unit economics|gross margin|cost per|break-?even|cost (?:of|to)|margin)\b/,
  },
  {
    criterion: /\b(?:co-?founder|team|roles?|equity split|founder agreement)\b/,
    record: /\b(?:co-?founder|equity split|founder agreement|roles? (?:agreed|split))\b/,
    types: ['decision', 'fact', 'milestone'],
  },
  {
    criterion: /\b(?:incorporat|llc|legal entity|compan(?:y|ies) (?:formed|registered))/,
    record: /\b(?:incorporated|formed (?:an? )?(?:llc|company)|registered (?:the )?company)\b/,
    types: ['decision', 'fact', 'milestone'],
  },
  {
    criterion: /\b(?:channel|acquisition|repeatable|referral|sales process)\b/,
    record: /\b(?:channel|acquisition|referrals?|sales process|conversion)\b/,
    types: ['evidence', 'experiment'],
  },
  {
    criterion: /\b(?:retention|repeat|come back|churn|active (?:users?|customers?))\b/,
    record: /\b(?:retention|repeat(?:ed|s)?|came back|churn|active (?:users?|customers?)|renewed)\b/,
    types: ['evidence', 'experiment', 'fact'],
  },
];

/** What a criterion is about, read in its title, then (for the topics that say so) in what counts as shown. */
export function topicOf(criterion: PathCriterion): Topic | null {
  const title = plain(criterion.title);
  const about = plain(`${criterion.title}. ${criterion.evidence}`);
  return (
    TOPICS.find((t) => t.criterion.test(title)) ??
    TOPICS.find((t) => t.inEvidence === true && t.criterion.test(about)) ??
    null
  );
}

/** The count a criterion asks for (1: none). */
export function neededFor(criterion: PathCriterion): number {
  return countsIn(criterion.evidence)[0] ?? countsIn(criterion.title)[0] ?? 1;
}

/** How many characters either side of a topic's words a count of it stands in ("11 paying customers"). */
const COUNT_REACH = 24;

/**
 * The counts a record gives of a topic: beside the topic's own words only ("two paid pilots" beside "900 tools" is two),
 * and the sample a record states for itself.
 */
function recordCounts(m: pathRepo.PathMemory, topic: RegExp, telling: readonly string[]): number[] {
  const counts = telling.flatMap((sentence) => {
    const text = plain(sentence);
    return [...text.matchAll(new RegExp(topic.source, 'gu'))].flatMap((match) =>
      countsIn(
        // Whole words only: "1200" cut to "200" would be another count.
        text
          .slice(Math.max(0, match.index - COUNT_REACH), match.index + match[0].length + COUNT_REACH)
          .replace(match.index > COUNT_REACH ? /^\S*\s/u : /^/u, '')
          .replace(match.index + match[0].length + COUNT_REACH < text.length ? /\s\S*$/u : /$/u, ''),
      ),
    );
  });
  for (const key of ['n', 'sample_size']) {
    const value = Number(m.attributes[key]);
    if (Number.isFinite(value) && value > 0) counts.push(value);
  }
  return counts;
}

/**
 * The record that shows `criterion`, or null. Deterministic: the first in the read's order. `idea`: what the venture is
 * ({@link ideaText}), so a note that only says it again shows nothing.
 */
export function recordShowing(
  criterion: PathCriterion,
  memory: readonly pathRepo.PathMemory[],
  idea = '',
): pathRepo.PathMemory | null {
  const topic = topicOf(criterion);
  const needed = neededFor(criterion);
  const words = contentStems(criterion.title);
  for (const m of memory) {
    if (!isShown(m)) continue;
    const kept = isKeptNote(m);
    if (kept && !saysMoreThan(idea, m)) continue;
    // What a person recorded as decided stands as it is; a kept note must say, in the same sentence, that it happened.
    const stands = (s: string): boolean =>
      (m.type === 'decision' || statedAsFact(s)) &&
      (!kept || (HAPPENED.test(plain(s)) && !PLANNED.test(plain(s))));
    // The title of a kept note is a label ("Ten interviews"), not what was done.
    const text = `${kept && m.content.trim() !== '' ? '' : `${m.title}. `}${m.content}${typeof m.attributes.result === 'string' ? `. ${m.attributes.result}` : ''}`;
    if (topic !== null) {
      if (topic.types !== undefined && !topic.types.includes(m.type)) continue;
      const telling = text.split(/(?<=[.!?])\s+/u).filter((s) => topic.record.test(plain(s)) && stands(s));
      if (telling.length === 0) continue;
      if (
        topic.counted === true &&
        needed > 1 &&
        Math.max(0, ...recordCounts(m, topic.record, telling)) < needed
      )
        continue;
      return m;
    }
    // No topic: the record must hold most of the criterion's own words, stated as fact.
    const held = new Set(contentStems(text));
    const shared = words.filter((w) => held.has(w)).length;
    if (words.length >= 2 && shared >= 2 && shared * 3 >= words.length * 2 && stands(text)) return m;
  }
  return null;
}

const shown = (c: CriterionState): boolean => c.status !== 'open';

/** The stages in the playbook's order. */
export function stageOrder(playbook: Playbook): VentureStageValue[] {
  return playbook.stages.map((s) => s.stage);
}

/**
 * Where the venture stands. The stage is the furthest of: the one its path already reached (it never goes back by
 * itself), every stage whose criteria are all shown, and the program's: before the path has begun when the record holds
 * work of its own (seeded, imported, from before), afterwards only once the program has changed it. A path that has begun
 * never moves because something was noted. A criterion is as its row says; without a row, the record may show it, and one
 * of a stage already passed counts as claimed.
 */
export function pathState(playbook: Playbook, source: PathSource): PathState {
  const order = stageOrder(playbook);
  const indexOfStage = (stage: VentureStageValue | null | undefined): number =>
    stage === null || stage === undefined ? 0 : Math.max(0, order.indexOf(stage));
  const { path, criteria: rows, memory } = source.reads;
  const idea = ideaText(source);
  const changed = path !== null && path.pivots.length > 0;
  const programMoved =
    path === null
      ? hasEvidence(playbook, source)
      : path.programStage != null && path.programStage !== source.venture.stage;
  const started = Math.max(indexOfStage(path?.stage), programMoved ? indexOfStage(source.venture.stage) : 0);
  const byId = new Map(rows.map((r) => [r.criterionId, r] as const));
  const own = playbook.criteria.map((criterion): CriterionState => {
    const row = byId.get(criterion.id);
    const progress = row?.status === 'open' ? progressIn(row.evidence) : null;
    // A criterion taken back counts again by what the record holds since; without a change of direction, by the path alone.
    const known =
      row === undefined
        ? memory
        : changed && row.status === 'open'
          ? memory.filter((m) => row.updatedAt !== '' && m.createdAt > row.updatedAt)
          : [];
    const record = row === undefined || row.status === 'open' ? recordShowing(criterion, known, idea) : null;
    if (record !== null)
      return { criterion, status: 'claimed', evidence: record.title, by: 'record', progress: null };
    if (row !== undefined)
      return {
        criterion,
        status: row.status,
        evidence: row.evidence,
        by: row.status === 'open' ? null : 'path',
        progress,
      };
    return { criterion, status: 'open', evidence: null, by: null, progress: null };
  });
  let index = started;
  while (index < order.length - 1) {
    const stage = order[index];
    const ofStage = own.filter((c) => c.criterion.stage === stage);
    if (!ofStage.every(shown)) break;
    index += 1;
  }
  return {
    stage: order[index] ?? source.venture.stage,
    stageIndex: index,
    criteria: own.map((c) =>
      c.status === 'open' && !byId.has(c.criterion.id) && indexOfStage(c.criterion.stage) < started
        ? { ...c, status: 'claimed' as const, by: 'stage' as const }
        : c,
    ),
  };
}

/** What the current stage still asks for, in order. */
export function missingOf(state: PathState): PathCriterion[] {
  return state.criteria.filter((c) => c.criterion.stage === state.stage && !shown(c)).map((c) => c.criterion);
}

export function isShownCriterion(state: PathState, criterionId: string | null): boolean {
  if (criterionId === null) return false;
  const found = state.criteria.find((c) => c.criterion.id === criterionId);
  return found !== undefined && shown(found);
}
