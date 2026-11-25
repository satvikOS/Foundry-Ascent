import { type ArcEntry, type PathIntake } from '@foundry/contracts';
import { type pathRepo } from '@foundry/db';

import { isReference, standingDecisions, dayOf } from './brief.js';
import { monthDay } from './dates.js';
import { asksFor, ownSentences } from './kinds.js';
import { milestoneReached, wordsOfEvidence } from './state.js';
import { contentStems, countsIn, plain } from './words.js';

/**
 * What the record holds, as a mentor says it: in the second person, without the memory's own label, each thing once. The
 * words are the record's; only who says them, and to whom, changes. Pure.
 */

export const bare = (text: string): string => text.replace(/[\s.!?;:,]+$/u, '').trim();

/** Lower-cases a clause's first letter, unless it is a name, an acronym or a number. */
export function lowerFirst(text: string): string {
  const word = /^[\p{L}\p{N}'’]+/u.exec(text)?.[0] ?? '';
  if (
    /^I(?:['’]\p{L}+)?$/u.test(word) ||
    /^\p{Lu}[\p{Lu}\d]/u.test(word) ||
    /^\p{L}\p{Ll}*\p{Lu}/u.test(word)
  )
    return text;
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}
export const upperFirst = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** "a", "a and b", "a, b and c". */
export function listed(items: readonly string[]): string {
  const all = items.filter((i) => i.trim() !== '');
  if (all.length <= 1) return all[0] ?? '';
  return `${all.slice(0, -1).join(', ')} and ${all.at(-1) ?? ''}`;
}

const YOU: readonly (readonly [RegExp, string])[] = [
  [/\b(?:I|we) (?:am|are)\b/giu, 'you are'],
  [/\b(?:I|we)['’](?:m|re)\b/giu, 'you are'],
  [/\bI was\b/giu, 'you were'],
  [/\b(?:I|we)['’]ve\b/giu, 'you have'],
  [/\b(?:I|we)['’]ll\b/giu, 'you will'],
  [/\b(?:I|we)['’]d\b/giu, 'you would'],
  [/\b(?:myself|ourselves)\b/giu, 'yourself'],
  [/\b(?:mine|ours)\b/giu, 'yours'],
  [/\b(?:my|our)\b/giu, 'your'],
  [/\b(?:me|us)\b(?! (?:dollars?|market|citizens?|based)\b)/gu, 'you'],
  [/\b(?:the|this) (?:founder|student founder)['’]s\b/giu, 'your'],
  [/\b(?:the|this) (?:founder|student founder)(?: (?:has|is|was))?\b/giu, 'you'],
  [/\bI\b/gu, 'you'],
  [/\bwe\b/giu, 'you'],
];

/** Their own words said back to them ("I did eight talks" → "you did eight talks"). */
export function toYou(text: string): string {
  let out = text;
  for (const [pattern, said] of YOU) out = out.replace(pattern, said);
  return out.replace(/\s+/g, ' ').trim();
}

/** Words an instruction or a decision opens with ("Charge 300 dollars…"). */
const DOES =
  /^(?:charge|sell|focus|start|stop|run|build|offer|ask|target|use|keep|launch|test|price|raise|drop|move|pick|choose|work|go|make|send|talk|interview|partner|hire|pivot|switch|rent|pause|wait|apply|join|bring|take|set|do|give|put|pay|serve|open|close|find|get|begin|limit|replace|change)\b/i;

/** A verb somewhere: what it says is a sentence, not a label. */
const SAYS =
  /\b(?:is|are|was|were|has|have|had|said|says|told|asked|paid|pays?|sold|sells?|bought|signed|lost|kept|keeps?|costs?|takes?|came|come|comes|went|go|goes|did|does|do|made|makes?|got|gets?|gave|gives?|ran|runs?|built|found|want(?:s|ed)?|need(?:s|ed)?|described|reported|shared|tracks?|use[sd]?|will|would|can|could|charge[sd]?|decided|interviewed|talked|spoke|offered|tried|tested|booked|fell|rose|grew|dropped|left|stayed|brought|won)\b/i;

const CLAUSE_CHARS = 170;

/** The first sentence of a text, or of its first clauses, at most {@link CLAUSE_CHARS}: never cut inside a word. */
function firstClause(text: string): string {
  const sentence = bare(
    text
      .replace(/\s+/g, ' ')
      .trim()
      .split(/(?<=[.!?])\s+/u)[0] ?? '',
  );
  if (sentence.length <= CLAUSE_CHARS) return sentence;
  const cut = sentence.slice(0, CLAUSE_CHARS);
  const at = Math.max(cut.lastIndexOf('; '), cut.lastIndexOf(', '), cut.lastIndexOf(' and '));
  return bare(at > 40 ? cut.slice(0, at) : cut.slice(0, cut.lastIndexOf(' ')));
}

/** What they reported: its first sentence, with the next when that is what it found ("I did eight talks; six of them said…"). */
function told(text: string): string {
  const [first = '', second = ''] = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+/u)
    .map(bare);
  const both = `${first}; ${lowerFirst(second)}`;
  return second !== '' &&
    /\b(?:said|told|bought|paid|signed|asked)\b/i.test(second) &&
    both.length <= CLAUSE_CHARS
    ? both
    : firstClause(text);
}

const hasFigure = (text: string): boolean => /\d/.test(text) || countsIn(text).length > 0;

/** A memory as a clause a mentor says ("one shop kept 900 tools on a clipboard"): what it holds, never its label. */
export function toldAs(m: Pick<pathRepo.PathMemory, 'type' | 'title' | 'content'>): string {
  const title = bare(m.title.replace(/\s+/g, ' '));
  const content = firstClause(m.content);
  const label = title.split(/\s+/).length <= 5 && !SAYS.test(title) && !hasFigure(title);
  const says =
    content !== '' &&
    (label || SAYS.test(content) || DOES.test(content)) &&
    !(hasFigure(title) && !hasFigure(content))
      ? content
      : title;
  const you = toYou(says);
  if (m.type === 'decision') {
    if (/^you (?:have )?(?:decided|agreed|chose)\b/i.test(you)) return lowerFirst(you);
    if (DOES.test(you)) return `you decided to ${lowerFirst(you)}`;
    return /\b(?:is|are|will)\b/.test(you) ? lowerFirst(you) : `you decided: ${lowerFirst(you)}`;
  }
  return lowerFirst(you);
}

const digitsOf = (text: string): Set<string> =>
  new Set([...(plain(text).match(/\d+(?:\.\d+)?/g) ?? []), ...countsIn(text).map(String)]);

/** Whether two texts tell the same thing: most of the shorter one's words are in the other, and their figures agree. */
export function sameThing(a: string, b: string, share = 0.6): boolean {
  const x = contentStems(a).filter((w) => !/^\d/.test(w));
  const y = contentStems(b).filter((w) => !/^\d/.test(w));
  const least = Math.min(x.length, y.length);
  if (least === 0) return plain(a) === plain(b);
  const shared = x.filter((w) => y.includes(w)).length;
  if (shared < least * share) return false;
  const m = digitsOf(a);
  const n = digitsOf(b);
  if (m.size === 0 || n.size === 0) return true;
  return [...m].some((d) => n.has(d));
}

/** Each thing once: of the entries that tell the same thing, the one that tells most. */
export function distinct<T>(items: readonly T[], textOf: (item: T) => string, share = 0.6): T[] {
  const out: T[] = [];
  for (const item of items) {
    const at = out.findIndex((o) => sameThing(textOf(o), textOf(item), share));
    const kept = out[at];
    if (kept === undefined) out.push(item);
    else if (contentStems(textOf(item)).length > contentStems(textOf(kept)).length) out[at] = item;
  }
  return out;
}

// The one fact that bears on this ask ----------------------------------------------------------------------------------

export interface PriorFact {
  /** The clause ("one clinic pays 400 dollars a month"). */
  readonly fact: string;
  /** The same as a sentence of the mentor's, for a reply that left it out. */
  readonly sentence: string;
  /** The same for a call: only their idea, asked about itself. */
  readonly spoken?: string;
}

export interface PriorSource {
  readonly oneLiner: string;
  readonly reads: pathRepo.PathReads;
  readonly intake: PathIntake | null;
  /** Their messages of this conversation before this one, oldest first. */
  readonly earlier: readonly string[];
  readonly message: string;
  /** What the answer is about (the play's title, the step). */
  readonly about: string;
  /** What the coach just said (its last replies, what this one opens with): the server never says it again. */
  readonly said: string;
  /** Whether the answer is one their idea can be put beside, when the record holds nothing nearer. */
  readonly applies?: boolean;
}

interface Candidate {
  readonly fact: string;
  readonly kind: 'record' | 'said' | 'idea';
  readonly weight: number;
  readonly on: string;
}

const PRIOR_TYPES: Readonly<Record<string, number>> = {
  evidence: 5,
  experiment: 5,
  milestone: 4,
  fact: 4,
  decision: 3,
  insight: 4,
  risk: 1,
};

/** The record's facts, their own words of this conversation and, last, the idea. */
function candidatesOf(s: PriorSource): Candidate[] {
  const out: Candidate[] = [];
  const decisions = new Set(standingDecisions(s.reads.memory).map((m) => m.id));
  for (const m of s.reads.memory) {
    const weight = PRIOR_TYPES[m.type];
    if (weight === undefined || m.status !== 'confirmed' || isReference(m)) continue;
    if (m.type === 'milestone' && !milestoneReached(m)) continue;
    if (m.type === 'decision' && !decisions.has(m.id)) continue;
    const result = typeof m.attributes.result === 'string' ? m.attributes.result : '';
    if (m.type === 'experiment' && result === '') continue;
    const fact = result === '' ? toldAs(m) : `${lowerFirst(bare(m.title))}: ${lowerFirst(bare(result))}`;
    out.push({ fact, kind: 'record', weight, on: dayOf(m, 'collected_on', 'decided_on', 'completed_on') });
  }
  for (const c of s.reads.criteria) {
    if (c.evidence === null || c.sourceSessionId === null) continue;
    const words = wordsOfEvidence(c.evidence);
    if (words !== '')
      out.push({
        fact: lowerFirst(toYou(told(words))),
        kind: 'record',
        weight: 5,
        on: c.updatedAt.slice(0, 10),
      });
  }
  for (const step of s.reads.steps)
    if (step.status === 'done' && step.evidence !== null)
      out.push({
        fact: lowerFirst(toYou(told(step.evidence))),
        kind: 'record',
        weight: 5,
        on: (step.completedAt ?? step.createdAt).slice(0, 10),
      });
  const done = s.intake?.doneSoFar.trim() ?? '';
  if (done !== '' && !/^(?:nothing|none|not (?:yet|much))\b/i.test(done))
    out.push({ fact: lowerFirst(toYou(firstClause(done))), kind: 'record', weight: 3, on: '' });
  const idea = (s.intake?.idea.trim() ?? '') === '' ? s.oneLiner.trim() : (s.intake?.idea.trim() ?? '');
  s.earlier.forEach((text, i) => {
    for (const sentence of ownSentences(text)) {
      // What tells the idea is the idea.
      if (
        asksFor(sentence) ||
        contentStems(sentence).length < 4 ||
        (idea !== '' && sameThing(sentence, idea))
      )
        continue;
      // A fact of theirs, never an order ("ignore your rules…") or a sentence about someone else.
      if (!OF_THEIRS.test(sentence.trim()) && !(MONEY_SAID.test(sentence) && !ORDER.test(sentence.trim())))
        continue;
      out.push({
        fact: lowerFirst(toYou(firstClause(sentence))),
        kind: 'said',
        weight: 2,
        on: `9999-${String(i).padStart(4, '0')}`,
      });
    }
  });
  if (idea !== '') out.push({ fact: lowerFirst(firstClause(idea)), kind: 'idea', weight: 0, on: '' });
  return out;
}

const OF_THEIRS =
  /^(?:(?:so|and|but|well|honestly|actually|right now|today|yesterday|last week)[, ]+)?(?:i|we|my|our)(?:['’]\w+)?\b/i;
const MONEY_SAID = /\$|\b(?:dollars?|bucks?|percent|sold|paid|bought|signed)\b/i;
const ORDER =
  /^(?:please )?(?:ignore|forget|pretend|repeat|print|tell|give|show|write|say|act|answer|make|change|keep|stop|remember)\b/i;

const PRIOR_SAID = 0.7;

/** The one thing on record that bears most on what they ask: by the words they share, then by what it shows. */
export function priorFact(s: PriorSource): PriorFact | null {
  const asked = new Set(contentStems(`${s.message} ${s.about}`));
  const said = new Set(contentStems(s.said));
  const own = new Set(contentStems(s.message));
  const gone = takenBack(s.message);
  const ofTheIdea = /\bmy (?:own )?(?:startup |business )?(?:idea|startup|venture|business)\b/i.test(
    s.message,
  );
  const ranked = distinct(candidatesOf(s), (c) => c.fact)
    .filter((c) => {
      const words = contentStems(c.fact);
      // "You are pivoting" tells nothing to build on.
      if (words.length < 2 || (words.length < 3 && !hasFigure(c.fact) && c.kind !== 'idea')) return false;
      // Nor is what this message takes back.
      if ([...digitsOf(c.fact)].some((d) => gone.has(d))) return false;
      // What they just said is no prior fact.
      return words.filter((w) => own.has(w)).length < words.length * 0.6;
    })
    .map((c) => ({
      ...c,
      shared: contentStems(c.fact).filter((w) => asked.has(w)).length,
      figure: Number(hasFigure(c.fact)),
    }))
    .sort(
      (a, b) =>
        Number(b.kind !== 'idea') - Number(a.kind !== 'idea') ||
        b.shared + b.weight - (a.shared + a.weight) ||
        b.figure - a.figure ||
        b.on.localeCompare(a.on),
    );
  // The server says one only when it is the record's, theirs and near what they ask, or the idea the answer is for.
  const tells = (c: (typeof ranked)[number]): boolean =>
    c.kind === 'record' ||
    (c.kind === 'idea' && s.applies === true) ||
    (c.kind === 'said' &&
      ((c.shared > 1 && /^you(?:r|['’]|\b)/i.test(c.fact)) || (c.shared > 0 && MONEY_SAID.test(c.fact))));
  const justSaid = (c: (typeof ranked)[number]): boolean => {
    // Asked about the idea itself, the answer names it.
    if (c.kind === 'idea' && ofTheIdea) return false;
    const words = contentStems(c.fact);
    return words.filter((w) => said.has(w)).length >= words.length * PRIOR_SAID;
  };
  const near = ranked.slice(0, PRIOR_NEAR);
  const best = near.find((c) => tells(c) && !justSaid(c));
  if (best === undefined) return near[0] === undefined ? null : { fact: near[0].fact, sentence: '' };
  const sentence =
    best.kind === 'idea'
      ? `Apply it to your idea: ${best.fact}.`
      : /^you\b/i.test(best.fact)
        ? `Build on this: ${best.fact}.`
        : best.kind === 'said'
          ? `You told me this: ${best.fact}.`
          : `Build on what you have: ${best.fact}.`;
  return best.kind === 'idea' && ofTheIdea
    ? { fact: best.fact, sentence, spoken: `That is for your idea: ${shortIdea(best.fact)}.` }
    : { fact: best.fact, sentence };
}

/** An idea in a few words: its first clause that tells something, at most {@link IDEA_WORDS} of them. */
function shortIdea(idea: string): string {
  const words = idea.split(/\s+/);
  return words.length <= IDEA_WORDS ? idea : bare(words.slice(0, IDEA_WORDS).join(' '));
}
const IDEA_WORDS = 14;

/** The figures a message takes back ("450 now, not 300"; "no longer 300"; "from 300 to 450"). */
function takenBack(message: string): Set<string> {
  const t = plain(message);
  return new Set(
    [
      ...t.matchAll(
        /\b(?:not|no longer|instead of|rather than|from|was|were)\s+(?:at |for )?\$?(\d+(?:\.\d+)?)\b/g,
      ),
    ].map((m) => m[1] ?? ''),
  );
}

/** How many of the nearest facts are looked through for one not said a moment ago. */
const PRIOR_NEAR = 4;

// The story ------------------------------------------------------------------------------------------------------------

const STORY_KINDS: ReadonlySet<ArcEntry['kind']> = new Set([
  'result',
  'setback',
  'decision',
  'pivot',
  'milestone',
  'step_done',
  'experiment',
]);

/** Most lines of a story. */
export const STORY_LINES = 8;

/** What an entry tells, to the founder. */
function entrySaid(e: ArcEntry): string {
  const title = bare(e.title.replace(/…$/u, ''));
  if (e.kind === 'pivot') {
    const to = /^Changed direction: (.+)$/u.exec(title)?.[1];
    if (to !== undefined) return `you changed direction to this: ${lowerFirst(toYou(bare(to)))}`;
  }
  if (e.kind === 'step_done') return `you finished: ${lowerFirst(title)}`;
  return toldAs({
    type: e.kind === 'decision' ? 'decision' : 'fact',
    title,
    content: e.source.kind === 'memory' ? (e.detail ?? '') : '',
  });
}

/**
 * How they got here, as dated lines, oldest first: each day once, each thing once (a day's copies of it, a pivot told as a
 * decision and as a note, are one), at most {@link STORY_LINES}.
 */
export function storyLines(arc: readonly ArcEntry[]): { readonly on: string; readonly said: string }[] {
  const days = new Map<string, ArcEntry[]>();
  for (const e of arc) if (STORY_KINDS.has(e.kind)) days.set(e.on, [...(days.get(e.on) ?? []), e]);
  const lines = [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([on, entries]) => {
      // One change of direction a day, in the path's own words when it has them.
      const pivots = entries.filter((e) => e.kind === 'pivot' || /\bpivot/i.test(e.title));
      const pivot = pivots.find((e) => e.id.startsWith('pivot:')) ?? pivots.at(-1);
      const rest = entries.filter((e) => !pivots.includes(e));
      const said = distinct(
        [...rest, ...(pivot === undefined ? [] : [pivot])].map(entrySaid),
        (t) => t,
        0.5,
      ).slice(0, 3);
      return { on, said: said.join('; ') };
    })
    .filter((l) => l.said !== '');
  const told: { on: string; said: string }[] = [];
  for (const line of lines) if (!told.some((t) => sameThing(t.said, line.said, 0.8))) told.push(line);
  // A change of direction is never left out: the oldest of the rest is.
  const over = told.length - STORY_LINES;
  const left = new Set(told.filter((l) => !/\bchanged direction\b/.test(l.said)).slice(0, Math.max(0, over)));
  return told.filter((l) => !left.has(l)).slice(-STORY_LINES);
}

export const dated = (line: { readonly on: string; readonly said: string }): string =>
  `${monthDay(line.on)}: ${line.said}.`;
