import { type PromptContinuity, type RecordLine } from '@foundry/ai';
import { type pathRepo } from '@foundry/db';

import { dayOf, isReference, standingDecisions } from './brief.js';
import { monthDay } from './dates.js';
import { earlierDay, milestoneReached, wordsOfEvidence } from './state.js';
import { ADVICE, bare, currentOnes, distinct, DOES, lowerFirst, SAYS, toYou, upperFirst } from './tell.js';
import { plain } from './words.js';

/**
 * The venture's record as a reading of a message is given it: whole sentences in the second person, each with its day, what
 * stands now first. What newer items replaced, markers and templates are left out; nobody's private note is in the reads
 * this is built from (`pathRepo.memoryPart`). Pure.
 */
export interface RecordSource {
  readonly today: string;
  readonly reads: pathRepo.PathReads;
  readonly continuity: PromptContinuity;
}

/** Lines, and their characters together, at most (about 1,600 tokens). */
export const MAX_RECORD_LINES = 24;
const MAX_CHARS = 6_000;
const LINE_CHARS = 340;

/** Their own words, or the record's of them, said to them; their surname goes with the name it is called by. */
function yours(text: string, name = ''): string {
  const called = name.trim();
  if (called.length < 2) return toYou(text);
  const full = new RegExp(`\\b${called.replace(/[^\p{L}\p{N}]/gu, '.')} (?=\\p{Lu})[\\p{L}'’-]+`, 'gu');
  return toYou(text.replace(full, called), called);
}

/** A text's whole sentences: one cut off by its column's length is left out. */
function sentencesOf(text: string, cutAt: number): string[] {
  const flat = text.replace(/\s+/gu, ' ').trim();
  if (flat === '') return [];
  const parts = flat.split(/(?<=[.!?])\s+(?=["“'(]?[\p{Lu}\p{N}$])/u);
  const cut = text.length >= cutAt && !/[.!?"”')]$/u.test(flat);
  return cut && parts.length > 1 ? parts.slice(0, -1) : parts;
}

const sentence = (text: string): string => {
  const said = upperFirst(bare(text));
  return said === ''
    ? ''
    : /[.!?]["”')]?$/u.test(text.trim()) && /[!?]/u.test(text.trim().slice(-2))
      ? upperFirst(text.trim())
      : `${said}.`;
};

/** As many whole sentences as a line holds; the first is always there, cut at a word when it alone is too long. */
function joined(parts: readonly string[]): string {
  let out = '';
  for (const part of parts) {
    if (part === '') continue;
    const next = out === '' ? part : `${out} ${part}`;
    if (next.length > LINE_CHARS && out !== '') break;
    out = next;
  }
  if (out.length <= LINE_CHARS) return out;
  const cut = out.slice(0, LINE_CHARS - 1);
  return `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

/** What the column of a memory's content holds (`pathRepo.memoryPart`). */
const CONTENT_CHARS = 280;
const hasDigit = (text: string): boolean => /\d/u.test(text);

/** A memory's own sentences, said to them; its label where the words alone are no sentence. */
function toldSentences(m: pathRepo.PathMemory, name: string): string[] {
  const title = bare(m.title.replace(/\s+/gu, ' '));
  const content = sentencesOf(m.content, CONTENT_CHARS).map((s) => yours(s, name));
  const titled = sentence(yours(title, name));
  if (content.length === 0) return [titled];
  const [first = '', ...rest] = content;
  const opens = content.some(
    (s) => SAYS.test(s) || DOES.test(s) || (/[.!?]$/u.test(s) && s.split(' ').length >= 6),
  );
  if (!opens) return [`On ${lowerFirst(yours(title, name))}, your record says: ${bare(content.join(' '))}.`];
  // A number only the label holds is theirs too.
  const held = new Set(plain(m.content).match(/\d[\d.,]*/gu) ?? []);
  const figures = plain(title).match(/\d[\d.,]*/gu) ?? [];
  const label = hasDigit(title) && SAYS.test(title) && figures.some((f) => !held.has(f)) ? [titled] : [];
  return [...label, sentence(first), ...rest.map(sentence)];
}

const attribute = (m: pathRepo.PathMemory, key: string): string => {
  const value = m.attributes[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
};

interface Draft {
  readonly kind: string;
  readonly text: string;
  readonly on: string | null;
  readonly memoryId: string | null;
  /** How telling it is when not all of them fit. */
  readonly weight: number;
}

const WEIGHT: Readonly<Record<string, number>> = {
  decision: 7,
  evidence: 8,
  experiment: 8,
  milestone: 6,
  fact: 7,
  relationship: 5,
  insight: 5,
  risk: 2,
  hypothesis: 3,
};

function decisionText(m: pathRepo.PathMemory, name: string): string {
  const [first = '', ...rest] = toldSentences(m, name);
  const said = bare(first);
  if (/^you (?:have )?(?:decided|agreed|chose)\b/iu.test(said)) return joined([first, ...rest]);
  if (DOES.test(said)) return joined([`You decided to ${lowerFirst(said)}.`, ...rest]);
  return /\b(?:is|are|will|charge|sell|pay|have)\b/iu.test(said)
    ? joined([first, ...rest])
    : joined([`You decided: ${lowerFirst(said)}.`, ...rest]);
}

function memoryDraft(m: pathRepo.PathMemory, name: string): Draft | null {
  const weight = WEIGHT[m.type];
  if (weight === undefined || m.status !== 'confirmed' || isReference(m)) return null;
  const said = `${m.title}. ${m.content}`;
  if (ADVICE.test(said) || /[[\]{}]|_{2,}/u.test(m.title)) return null;
  const base = { memoryId: m.id, weight: weight + (m.pinned ? 2 : 0) };
  const title = lowerFirst(yours(bare(m.title.replace(/\s+/gu, ' ')), name));
  const told = toldSentences(m, name);
  // Its first sentence, as it stands after another ("… not reached yet: win the table").
  const own = lowerFirst(bare(yours(sentencesOf(m.content, CONTENT_CHARS)[0] ?? title, name)));
  switch (m.type) {
    case 'decision':
      return { ...base, kind: 'decision', text: decisionText(m, name), on: dayOf(m, 'decided_on') };
    case 'experiment': {
      const result = attribute(m, 'result');
      const on = dayOf(m, 'completed_on', 'collected_on');
      if (result !== '')
        return {
          ...base,
          kind: 'experiment',
          text: joined([`Your test, ${title}, came out so: ${bare(yours(result, name))}.`, ...told]),
          on,
        };
      // A test of the past with its numbers in its words is one with a result; else it has none yet.
      return hasDigit(m.content) && !/\b(?:will|plan|going to|want)\b/iu.test(m.content)
        ? { ...base, kind: 'experiment', text: joined(told), on }
        : {
            ...base,
            weight: 4,
            kind: 'experiment',
            text: joined([`Your test, ${title}, has no result yet.`, ...told]),
            on,
          };
    }
    case 'milestone': {
      if (milestoneReached(m))
        return {
          ...base,
          kind: 'milestone',
          text: joined(told),
          on: dayOf(m, 'completed_on', 'target_date'),
        };
      const by = attribute(m, 'target_date');
      const until = /^\d{4}-\d{2}-\d{2}/u.test(by) ? ` by ${monthDay(by.slice(0, 10))}` : '';
      const goal = SAYS.test(title) || DOES.test(title) ? title : own;
      return {
        ...base,
        weight: 4,
        kind: 'goal',
        text: `A goal of yours, not reached yet${until}: ${goal}.`,
        on: dayOf(m),
      };
    }
    case 'hypothesis': {
      const belief = SAYS.test(title) ? title : own;
      const plainBelief = belief.replace(/^you (?:think|believe|hope|assume)(?: that)? /iu, '');
      return {
        ...base,
        kind: 'hypothesis',
        text: `You believe, and have not tested: ${plainBelief}.`,
        on: dayOf(m),
      };
    }
    case 'risk':
      return {
        ...base,
        kind: 'risk',
        text: joined([`A risk you named: ${own}.`]),
        on: dayOf(m),
      };
    default:
      return { ...base, kind: m.type, text: joined(told), on: dayOf(m, 'collected_on') };
  }
}

/** Of items with one label, the latest: the same thing told again with other words is what it is now. */
function latestOfLabel(memory: readonly pathRepo.PathMemory[]): pathRepo.PathMemory[] {
  return memory.filter(
    (m) =>
      !memory.some(
        (later) =>
          later !== m &&
          later.type === m.type &&
          later.status === 'confirmed' &&
          later.createdAt > m.createdAt &&
          plain(later.title) === plain(m.title) &&
          // Two interviews may share a label; two prices cannot both stand.
          (m.type === 'fact' || m.type === 'decision' || m.type === 'relationship'),
      ),
  );
}

/** The record of a turn as lines `R1`, `R2`, …: what stands, the newest first, what the founder said of themself last. */
export function recordLines(source: RecordSource): RecordLine[] {
  const { reads, continuity, today } = source;
  const name = continuity.founderFirstName ?? '';
  const intake = reads.path?.intake ?? null;
  const drafts: Draft[] = [];
  const add = (kind: string, text: string, on: string | null, weight: number): void => {
    if (bare(text) !== '') drafts.push({ kind, text: joined([text]), on, memoryId: null, weight });
  };
  const decisions = new Set(standingDecisions(reads.memory).map((m) => m.id));
  for (const m of latestOfLabel(currentOnes(reads.memory))) {
    if (m.type === 'decision' && !decisions.has(m.id)) continue;
    const draft = memoryDraft(m, name);
    if (draft !== null && bare(draft.text) !== '') drafts.push(draft);
  }
  for (const pivot of reads.path?.pivots ?? [])
    add(
      'pivot',
      pivot.to === ''
        ? `You changed direction on ${monthDay(pivot.on)}.`
        : `You changed direction on ${monthDay(pivot.on)}, ${pivot.from === '' ? '' : `from "${bare(yours(pivot.from))}" `}to "${bare(yours(pivot.to))}".`,
      pivot.on,
      9,
    );
  const words = new Set<string>();
  for (const c of reads.criteria) {
    if (c.evidence === null || c.stepId !== null || c.sourceSessionId === null) continue;
    const said = wordsOfEvidence(c.evidence);
    if (said === '' || words.has(said)) continue;
    words.add(said);
    add(
      'reported',
      sentencesOf(yours(said, name), 4_000).map(sentence).join(' '),
      earlierDay(c.evidence) ?? c.updatedAt.slice(0, 10),
      7,
    );
  }
  for (const step of reads.steps)
    if (step.status === 'done')
      add(
        'done',
        `You finished "${bare(step.title)}"${step.evidence === null ? '' : `: ${bare(lowerFirst(yours(step.evidence, name)))}`}.`,
        (step.completedAt ?? step.createdAt).slice(0, 10),
        step.evidence === null ? 2 : 6,
      );
    else if (step.status === 'blocked' && step.reason !== null)
      add(
        'blocked',
        `You are blocked on "${bare(step.title)}": ${bare(lowerFirst(yours(step.reason, name)))}.`,
        step.createdAt.slice(0, 10),
        4,
      );
  for (const c of (continuity.notebook?.commitments ?? []).filter((x) => x.status === 'open').slice(0, 2))
    add(
      'commitment',
      `You said you would: ${bare(lowerFirst(yours(c.text, name)))}${c.due === null ? '' : ` (by ${monthDay(c.due)})`}.`,
      null,
      3,
    );

  const own: Draft[] = [];
  const of = (kind: string, text: string): void => {
    own.push({ kind, text: joined([text]), on: null, memoryId: null, weight: 0 });
  };
  if (intake !== null) {
    if (intake.idea.trim() !== '')
      of('idea', `You described your idea as: ${bare(yours(intake.idea, name))}.`);
    if (intake.customer.trim() !== '')
      of('customer', `You said it is for ${bare(lowerFirst(yours(intake.customer, name)))}.`);
    if (
      intake.doneSoFar.trim() !== '' &&
      !/^(?:nothing|none|not (?:yet|much))\b/iu.test(intake.doneSoFar.trim())
    )
      of('done', `You said of what is done so far: ${bare(lowerFirst(yours(intake.doneSoFar, name)))}.`);
    if (intake.hoursPerWeek !== null)
      of('time', `You have ${String(intake.hoursPerWeek)} hours a week for it.`);
    if (intake.deadline !== null && intake.deadline.on >= today)
      of(
        'deadline',
        `Your deadline, ${bare(lowerFirst(intake.deadline.what))}, is on ${monthDay(intake.deadline.on)}.`,
      );
    if (intake.block.trim() !== '')
      of('stuck', `You said you are stuck on ${bare(lowerFirst(yours(intake.block, name)))}.`);
    if (intake.experience === 'first_time') of('founder', 'You are doing this for the first time.');
  }
  const limits = continuity.studentProfile?.constraints.trim() ?? '';
  if (limits !== '') of('founder', `You said of your limits: ${bare(lowerFirst(yours(limits, name)))}.`);

  // What tells the most stays when not everything fits; then the newest first.
  const told = distinct(
    [...drafts].sort((a, b) => b.weight - a.weight || (b.on ?? '').localeCompare(a.on ?? '')),
    (d) => d.text,
    0.8,
  );
  const kept: Draft[] = [];
  let chars = own.reduce((n, d) => n + d.text.length, 0);
  for (const draft of told) {
    if (kept.length + own.length >= MAX_RECORD_LINES || chars + draft.text.length > MAX_CHARS) continue;
    kept.push(draft);
    chars += draft.text.length;
  }
  kept.sort((a, b) => (b.on ?? '').localeCompare(a.on ?? '') || b.weight - a.weight);
  return [...kept, ...own].slice(0, MAX_RECORD_LINES).map((d, i) => ({
    key: `R${String(i + 1)}`,
    kind: d.kind,
    text: d.text,
    on: d.on,
    memoryId: d.memoryId,
  }));
}
