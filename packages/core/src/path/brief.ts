import { type PromptContinuity } from '@foundry/ai';
import { type ArcEntry, type StudentProfile } from '@foundry/contracts';
import { type pathRepo } from '@foundry/db';

import { daysBetween, monthDay } from './dates.js';
import { earlierDay, milestoneReached, progressIn, wordsOfEvidence } from './state.js';
import { contentStems, countsIn, plain } from './words.js';

/** The founder's story and who they are, from the record alone: nothing here is written by a model. */

/** Most characters of the brief in a prompt. */
export const BRIEF_CHARS = 1_200;
const LINE_CHARS = 180;
/** The idea is shown whole, or nearly. */
const IDEA_CHARS = 320;
const ARC_ENTRIES = 60;

export interface BriefSource {
  readonly today: string;
  readonly venture: {
    readonly name: string;
    readonly stage: string;
    readonly oneLiner: string;
    readonly domain: string;
    readonly currentGoal: string | null;
  };
  readonly reads: pathRepo.PathReads;
  /** The person's own profile (null: none, a temporary chat, or somebody else's to read). */
  readonly profile:
    | (Pick<StudentProfile, 'background' | 'learningGoal' | 'constraints'> & {
        readonly approvedAt?: string;
      })
    | null;
  readonly notebook: Pick<NonNullable<PromptContinuity['notebook']>, 'founderProfile' | 'commitments'> | null;
  /** The venture's latest conversations with a digest, newest first. */
  readonly digests: readonly {
    readonly sessionId: string;
    readonly date: string;
    readonly title: string | null;
    readonly summary: string;
  }[];
}

function oneLine(text: string, max = LINE_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}

export const firstSentence = (text: string): string => oneLine(text.split(/(?<=[.!?])\s+/u)[0] ?? text);

const ISO_DAY = /^\d{4}-\d{2}-\d{2}/;
const attribute = (m: pathRepo.PathMemory, key: string): string | null => {
  const value = m.attributes[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
};

/** The day an item is about: what it says of itself, else the day it was recorded. */
export function dayOf(m: pathRepo.PathMemory, ...keys: readonly string[]): string {
  for (const key of keys) {
    const value = attribute(m, key);
    if (value !== null && ISO_DAY.test(value)) return value.slice(0, 10);
  }
  return m.createdAt.slice(0, 10);
}

/** A workspace's own marker (seeded reference codes): never part of a story. */
export const isReference = (m: pathRepo.PathMemory): boolean => /\bdo not share\b|CANARY::/i.test(m.content);

/**
 * A memory object as one fact: its title when that says the thing, else its title with what it holds ("Fee: charge 300
 * dollars an application").
 */
export function factOf(m: pathRepo.PathMemory): string {
  const title = oneLine(m.title.replace(/[\s.!;:]+$/u, ''), 160);
  const content = firstSentence(m.content).replace(/[\s.!;:]+$/u, '');
  if (content === '') return title;
  const words = contentStems(title);
  const held = new Set(contentStems(content));
  const says = /\d/.test(title) || words.length >= 5 || (words.length >= 3 && countsIn(title).length > 0);
  if (says || (words.length >= 3 && words.every((w) => held.has(w)))) return title;
  return oneLine(`${title}: ${content}`, LINE_CHARS);
}

/**
 * The decisions that stand, the latest first: one a newer decision corrects ("fee: 450 now, not 300") is left out.
 */
export function standingDecisions(memory: readonly pathRepo.PathMemory[]): pathRepo.PathMemory[] {
  const newest = memory
    .filter((m) => m.type === 'decision' && m.status === 'confirmed' && !isReference(m))
    .sort(
      (a, b) =>
        dayOf(b, 'decided_on').localeCompare(dayOf(a, 'decided_on')) ||
        b.createdAt.localeCompare(a.createdAt),
    );
  return newest.filter((m, i) => {
    const said = plain(`${m.title}. ${m.content}`);
    return !newest.slice(0, i).some((later) => {
      const was = /\bnot (?:\$ ?)?(\d+(?:[.,]\d+)*)/.exec(plain(`${later.title}. ${later.content}`))?.[1];
      if (was === undefined || !new RegExp(`(?<![\\d.])${was.replace(/\./g, '\\.')}(?![\\d])`).test(said))
        return false;
      const subject = contentStems(later.title).filter((w) => !/^\d/.test(w));
      return contentStems(said).some((w) => subject.includes(w));
    });
  });
}

const PIVOT =
  /\bpivot(?:ed|ing)?\b|\b(?:switch(?:ed|ing)?|chang(?:ed|ing)|mov(?:ed|ing)) (?:from|away from)\b|\binstead of\b|\bno longer\b/;
const SETBACK =
  /\b(?:lost|failed|rejected|declined|cancel(?:l)?ed|churned|dropped out|fell through|did not (?:pass|convert|sign|work))\b/;

/** An item of the record as an entry of the story (null: not one). */
function entryOf(m: pathRepo.PathMemory): ArcEntry | null {
  if (m.status !== 'confirmed') return null;
  const text = plain(`${m.title}. ${m.content}`);
  const result = attribute(m, 'result');
  const entry = (kind: ArcEntry['kind'], on: string, detail: string | null): ArcEntry => ({
    id: `memory:${m.id}`,
    kind,
    on,
    title: oneLine(m.title, 140),
    detail: detail === null ? null : oneLine(detail, 240),
    source: { kind: 'memory', id: m.id },
  });
  switch (m.type) {
    case 'decision':
      return entry(PIVOT.test(text) ? 'pivot' : 'decision', dayOf(m, 'decided_on'), m.content);
    case 'experiment':
      return entry(
        result === null ? 'experiment' : SETBACK.test(plain(result)) ? 'setback' : 'result',
        dayOf(m, 'completed_on', 'collected_on'),
        result ?? m.content,
      );
    case 'evidence':
      return entry(SETBACK.test(text) ? 'setback' : 'result', dayOf(m, 'collected_on'), m.content);
    case 'milestone': {
      if (milestoneReached(m)) return entry('milestone', dayOf(m, 'completed_on', 'target_date'), m.content);
      // A goal is no part of what happened: it is told as what they set out to do, on the day they said it.
      const target = attribute(m, 'target_date');
      const goal = entry('commitment', dayOf(m), target === null ? m.content : `By ${monthDay(target)}`);
      return { ...goal, title: oneLine(`Goal: ${m.title}`, 140) };
    }
    case 'insight':
      return PIVOT.test(text) ? entry('pivot', dayOf(m), m.content) : null;
    default:
      return null;
  }
}

/** What they reported in conversations in their own words (not with a step, which the story names), each once. */
function reportedWords(
  criteria: readonly pathRepo.PathCriterionRecord[],
): [words: string, criterion: pathRepo.PathCriterionRecord][] {
  const seen = new Set<string>();
  return [...criteria]
    .filter((c) => c.evidence !== null && c.stepId === null && c.sourceSessionId !== null)
    .filter((c) => ISO_DAY.test(c.updatedAt))
    .sort((a, b) => a.criterionId.localeCompare(b.criterionId))
    .flatMap((c): [string, pathRepo.PathCriterionRecord][] => {
      const words = wordsOfEvidence(c.evidence ?? '');
      if (words === '' || seen.has(words)) return [];
      seen.add(words);
      return [[words, c]];
    });
}

/** The venture's story so far, oldest first, each entry saying where it comes from. */
export function arcOf(source: BriefSource): ArcEntry[] {
  const { reads, profile } = source;
  const entries: ArcEntry[] = [];
  if (profile !== null && profile.background.trim() !== '')
    entries.push({
      id: 'profile:background',
      kind: 'origin',
      on: (profile.approvedAt ?? source.today).slice(0, 10),
      title: oneLine(profile.background, 140),
      detail: profile.learningGoal.trim() === '' ? null : oneLine(profile.learningGoal, 240),
      source: { kind: 'profile', id: 'student-profile' },
    });
  const intake = reads.path?.intake ?? null;
  if (intake !== null && intake.idea !== '')
    entries.push({
      id: 'profile:intake',
      kind: 'idea',
      on: source.today,
      title: oneLine(intake.idea, 140),
      detail: intake.customer === '' ? null : oneLine(`For ${intake.customer}`, 240),
      source: { kind: 'profile', id: 'intake' },
    });
  (reads.path?.pivots ?? []).forEach((pivot, i) => {
    // The words of a deleted conversation are gone; that the direction changed on that day stays.
    entries.push({
      id: `pivot:${String(i)}:${pivot.on}`,
      kind: 'pivot',
      on: pivot.on,
      title: pivot.to === '' ? 'A change of direction' : oneLine(`Changed direction: ${pivot.to}`, 140),
      detail: pivot.from === '' ? null : oneLine(`Before: ${pivot.from}`, 240),
      source:
        pivot.sessionId === null
          ? { kind: 'profile', id: 'intake' }
          : { kind: 'session', id: pivot.sessionId },
    });
  });
  for (const [words, c] of reportedWords(reads.criteria))
    entries.push({
      id: `reported:${c.criterionId}`,
      kind: 'result',
      on: earlierDay(c.evidence ?? '') ?? c.updatedAt.slice(0, 10),
      title: oneLine(words, 140),
      detail: null,
      source: { kind: 'session', id: c.sourceSessionId ?? '' },
    });
  for (const m of reads.memory) {
    const entry = entryOf(m);
    if (entry !== null) entries.push(entry);
  }
  for (const step of reads.steps) {
    const on = step.completedAt?.slice(0, 10) ?? step.createdAt.slice(0, 10);
    if (step.status === 'done')
      entries.push({
        id: `step:${step.id}`,
        kind: 'step_done',
        on,
        title: oneLine(step.title, 140),
        detail: step.evidence === null ? null : oneLine(step.evidence, 240),
        source: { kind: 'step', id: step.id },
      });
    else if (step.status === 'now' && step.origin !== 'coach')
      entries.push({
        id: `step:${step.id}`,
        kind: 'commitment',
        on: step.createdAt.slice(0, 10),
        title: oneLine(step.title, 140),
        detail: step.dueOn === null ? null : `Due ${monthDay(step.dueOn)}`,
        source: { kind: 'step', id: step.id },
      });
  }
  for (const d of source.digests)
    entries.push({
      id: `session:${d.sessionId}`,
      kind: 'conversation',
      on: d.date.slice(0, 10),
      title: oneLine(d.title ?? 'A conversation', 140),
      detail: d.summary.trim() === '' ? null : oneLine(d.summary, 240),
      source: { kind: 'session', id: d.sessionId },
    });
  return entries.sort((a, b) => a.on.localeCompare(b.on) || a.id.localeCompare(b.id)).slice(-ARC_ENTRIES);
}

const EXPERIENCE = {
  first_time: 'first-time founder',
  some: 'has some founder experience',
  experienced: 'experienced founder',
} as const;

/**
 * Who they are and the venture's story for the prompt, most decision-relevant first: lines are added while they fit
 * {@link BRIEF_CHARS}. `asked`: what this turn adds ahead of the story (a choice they ask to have made).
 */
export function briefOf(source: BriefSource, asked: readonly string[] = []): string {
  const { venture, reads, profile, today } = source;
  const intake = reads.path?.intake ?? null;
  const lines: string[] = [];
  const confirmed = reads.memory.filter((m) => m.status === 'confirmed' && !isReference(m));
  const of = (type: string): pathRepo.PathMemory[] => confirmed.filter((m) => m.type === type);
  // The idea as they told it, and what was decided last, come before everything else: whatever is cut, never these.
  const idea = intake?.idea.trim() ?? '';
  if (idea !== '') lines.push(`Idea, in their words: ${oneLine(idea, IDEA_CHARS)}`);
  const changed = (reads.path?.pivots ?? []).filter((x) => x.to !== '').at(-1);
  if (changed !== undefined && changed.from !== '')
    lines.push(`Changed direction ${changed.on}, from: ${oneLine(changed.from, 140)}`);
  const decisions = standingDecisions(reads.memory);
  const decided = (m: pathRepo.PathMemory): string => `Decided ${dayOf(m, 'decided_on')}: ${factOf(m)}`;
  lines.push(...decisions.slice(0, 1).map(decided));
  const person = [
    intake?.studies ? `studies ${oneLine(intake.studies, 80)}` : null,
    intake?.experience ? EXPERIENCE[intake.experience] : null,
    profile !== null && profile.background !== '' ? oneLine(profile.background, 140) : null,
    intake?.hoursPerWeek != null ? `${String(intake.hoursPerWeek)} hours a week` : null,
  ].filter((x): x is string => x !== null);
  lines.push(
    `Venture: ${oneLine(venture.name, 80)} (${venture.domain}, recorded stage ${venture.stage.replace(/_/g, ' ')}).` +
      (venture.oneLiner.trim() === '' ? '' : ` ${oneLine(venture.oneLiner)}`),
  );
  if (person.length > 0) lines.push(`Founder: ${person.join('; ')}.`);
  if (intake?.deadline != null) {
    const left = daysBetween(today, intake.deadline.on);
    if (left >= 0)
      lines.push(
        `Deadline: ${oneLine(intake.deadline.what, 100)} on ${intake.deadline.on} (${left === 0 ? 'today' : `${String(left)} days left`}).`,
      );
  }
  lines.push(...asked.map((a) => oneLine(a, 240)));
  if (venture.currentGoal !== null && venture.currentGoal.trim() !== '')
    lines.push(`Goal: ${oneLine(venture.currentGoal)}`);
  if (intake !== null && intake.customer !== '') lines.push(`For: ${oneLine(intake.customer, 120)}`);

  const figureFirst = (items: pathRepo.PathMemory[]): pathRepo.PathMemory[] =>
    [...items].sort((a, b) => Number(/\d/.test(factOf(b))) - Number(/\d/.test(factOf(a))));
  lines.push(...decisions.slice(1, 2).map(decided));
  // What they reported in their own words, the latest first.
  for (const c of [...reads.criteria]
    .filter((x) => x.evidence !== null && x.stepId === null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .filter(
      (x, i, all) =>
        all.findIndex((y) => wordsOfEvidence(y.evidence ?? '') === wordsOfEvidence(x.evidence ?? '')) === i,
    )
    .slice(0, 2)) {
    const progress = progressIn(c.evidence);
    const before = earlierDay(c.evidence ?? '');
    lines.push(
      `They reported${before === null ? '' : ` (${before}, before the change of direction)`}${progress === null ? '' : ` (${String(progress.done)} of ${String(progress.of)} done)`}: "${oneLine(wordsOfEvidence(c.evidence ?? ''), 200)}"`,
    );
  }
  for (const m of figureFirst([...of('evidence'), ...of('fact')]).slice(0, 3))
    lines.push(`Known (${dayOf(m, 'collected_on')}): ${factOf(m)}`);
  const experiments = of('experiment');
  for (const m of experiments.filter((x) => attribute(x, 'result') !== null).slice(0, 1))
    lines.push(`Result: ${oneLine(m.title, 100)}: ${oneLine(attribute(m, 'result') ?? '', 80)}`);
  for (const m of experiments.filter((x) => attribute(x, 'result') === null).slice(0, 1))
    lines.push(`Running: ${oneLine(m.title, 140)}`);
  for (const step of reads.steps.filter((s) => s.status === 'done').slice(0, 2))
    lines.push(
      `Did (${(step.completedAt ?? step.createdAt).slice(0, 10)}): ${oneLine(step.title, 90)}` +
        (step.evidence === null ? '' : `: "${oneLine(step.evidence, 100)}"`),
    );
  for (const step of reads.steps
    .filter((s) => s.status === 'now' && s.dueOn !== null && s.dueOn < today)
    .slice(0, 1))
    lines.push(`Overdue since ${step.dueOn ?? ''}: ${oneLine(step.title, 100)}`);
  for (const step of reads.steps.filter((s) => s.status === 'blocked').slice(0, 1))
    lines.push(
      `Blocked: ${oneLine(step.title, 80)}${step.reason === null ? '' : ` ("${oneLine(step.reason, 90)}")`}`,
    );
  for (const m of of('milestone').slice(0, 1))
    lines.push(
      milestoneReached(m)
        ? `Milestone ${dayOf(m, 'completed_on', 'target_date')}: ${factOf(m)}`
        : `Goal, not reached yet (by ${dayOf(m, 'target_date')}): ${factOf(m)}`,
    );
  for (const m of of('risk').slice(0, 1)) lines.push(`Risk they named: ${oneLine(m.title, 120)}`);
  for (const c of (source.notebook?.commitments ?? []).filter((x) => x.status === 'open').slice(0, 1))
    lines.push(`Said they would: ${oneLine(c.text, 120)}${c.due === null ? '' : ` (by ${c.due})`}`);
  if (intake !== null && intake.block !== '') lines.push(`Stuck on: ${oneLine(intake.block, 120)}`);
  if (intake !== null && intake.doneSoFar !== '')
    lines.push(`Done so far, they say: ${oneLine(intake.doneSoFar)}`);
  if (profile !== null && profile.constraints !== '')
    lines.push(`Limits: ${oneLine(profile.constraints, 120)}`);
  for (const d of source.digests.slice(0, 1))
    lines.push(`Last conversation (${d.date.slice(0, 10)}): ${firstSentence(d.summary)}`);
  for (const entry of (source.notebook?.founderProfile ?? []).slice(0, 1))
    lines.push(`How they work: ${oneLine(entry.text, 120)}`);
  for (const m of of('hypothesis').slice(0, 1)) lines.push(`Believes, untested: ${oneLine(m.title, 120)}`);

  let out = '';
  for (const line of lines) {
    const next = out === '' ? line : `${out}\n${line}`;
    if (next.length > BRIEF_CHARS) continue;
    out = next;
  }
  return out;
}
