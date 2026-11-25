import { type PromptGuidance } from '../prompts/guidance.js';

import { coverage, stemOf, stemsOf } from './stems.js';
import { isListUnit } from './units.js';

/**
 * A second reading of what the server read first (live, 2026-11-25): under a lead that says what a result shows, what it does
 * not and what to do, the model's own paragraph says the same in other words ("What this shows is…", "This doesn't prove…").
 * And a question of the model's that nothing in the conversation answers to ("What was hard about it?").
 */
const READS =
  /^(?:so |and |but )?what (?:those|these|that|this|it|they|the|your)\b[^.?!]{0,60}\b(?:means?|shows?|tells? you|prove[sn]?)\b|^what [^.?!]{0,50}\b(?:don['’]?t|doesn['’]?t|do not|does not) (?:yet )?(?:show|prove|tell)\b|^(?:so |but |and )?(?:this|that|it|those|these) (?:also |only |just )?(?:(?:does|do)(?:n['’]t| not) )?(?:yet )?(?:prove|mean|show|suggest|tell|indicate)s?\b|,? it (?:shows|means|suggests)\b|^your \$?[\d.,]+[^.?!]{0,40}\bmeans\b/iu;
/** Words that turn a sentence and add nothing to it. */
const TURNS: ReadonlySet<string> = new Set(
  'mean show prove tell learn see watch whether might okay fine sign interest hold matter point able clear real'
    .split(' ')
    .map(stemOf),
);
/** Share of a sentence's own words the lead and their message hold for it to be a second reading of them. */
const READ_AGAIN = 0.5;
const LEAST = 3;

const wordsOf = (text: string): Set<string> => new Set([...stemsOf(text)].filter((w) => !TURNS.has(w)));

/** Whether a unit only reads again what the lead read (`lead`, `founder`: their stems). */
export function readsAgain(
  unit: string,
  guidance: PromptGuidance,
  lead: ReadonlySet<string>,
  founder: ReadonlySet<string>,
): boolean {
  if (lead.size === 0 || isListUnit(unit) || /\?["'”’)\]*_]*\s*$/u.test(unit)) return false;
  const sum = (guidance.calc ?? []).length > 0;
  const read = guidance.kind === 'news' || (guidance.finding ?? '') !== '';
  if (!sum && !read) return false;
  const held = new Set([...lead, ...founder]);
  const all = wordsOf(unit);
  // A figure of its own is something new.
  if ([...all].some((w) => /^\d/.test(w) && !held.has(w))) return false;
  const said = new Set([...all].filter((w) => !/^\d/.test(w)));
  const text = unit.replace(/^[\s*_>]+/u, '');
  if (READS.test(text)) {
    // The lead said what it shows: said of it again, whatever the words.
    if (read && (lead.has('show') || lead.has('mean'))) return true;
    // "Your $3 left means each adds $3": what a sum worked out, read off its own figures.
    if (sum && [...all].some((w) => /^\d/.test(w))) return true;
  }
  return read && said.size >= LEAST && coverage(said, held) >= READ_AGAIN;
}

const REFUSES_NUMBER =
  /^(?:sorry,? (?:but )?)?i (?:can(?:['’]t|not)|won['’]t|will not)(?: \w+)? (?:give|make up|offer|provide|put|name|invent|share)\b[^.?!]{0,60}\b(?:estimate|number|figure|guess|size)\b/iu;

/** A number refused, under a lead that gave the way to it: the refusal says nothing more. */
export const refusesUnderLead = (unit: string, lead: ReadonlySet<string>): boolean =>
  lead.size > 0 && REFUSES_NUMBER.test(unit.replace(/^[\s*_>"“]+/u, ''));

/** How it was, asked of something nobody told of. */
const HOW_WAS_IT =
  /^(?:(?:and|so),? )?what (?:was|is|were|felt|made it|made that)(?: so| the)? (?:hard(?:est)?|difficult|easy|easiest|surprising|frustrating|annoying|best|worst|tricky)(?: (?:part|thing|bit))?(?: (?:about|of|in|with) (?:it|that|this|them))?\?/iu;

/** Whether the question a reply ends with is about something they did not tell they did. */
export const danglingAsk = (question: string, guidance: PromptGuidance): boolean =>
  guidance.kind !== 'report' && HOW_WAS_IT.test(question.replace(/^[\s*_>"“]+/u, ''));

/** The same as a line of its own, whoever it may be put to: nothing before it says who is asked. */
export const danglingLine = (unit: string, before: string, guidance: PromptGuidance): boolean =>
  danglingAsk(unit.trimStart(), guidance) &&
  (/^\s*\n\s*\n/u.test(unit) || /\n\s*\n\s*$/u.test(before)) &&
  !/:\s*$/u.test(before);

const letters = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Whether a unit is their own message, said back as it is ("Help me plan this."). */
export const echoesThem = (unit: string, founderText: string): boolean => {
  const own = letters(unit);
  return own !== '' && own === letters(founderText);
};
