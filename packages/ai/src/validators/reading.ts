import type { PromptGuidance } from '../prompts/guidance.js';
import { numbersIn, spelledNumbersIn } from './figures.js';
import { sharedCount, stemOf, stemsOf } from './stems.js';
import { isListUnit, wordsIn } from './units.js';

/**
 * A reply whose message was read (`PromptGuidance.reading`): what of the model's own stands beside what was read and what
 * the server opened with. Deterministic, per unit, the same for a streamed unit and a whole reply.
 *
 * 1. under an opening a sentence stays only when it adds something: a figure, a name, a fact of the record, a claim it was
 *    given, or something to do;
 * 2. a verdict that says nothing of theirs ("Good. The numbers show it's good.") goes, whatever opens;
 * 3. nothing agrees with what the opening just denied, or rules on what it left to a person;
 * 4. a push is never answered with a claim to have had evidence, and made-up work never with friends in its place.
 */

type Reading = NonNullable<PromptGuidance['reading']>;

const plain = (text: string): string =>
  text
    .replace(/\[\s*E\d+[^\]]*\]/giu, '')
    .replace(/[‘’ʼ]/gu, "'")
    .replace(/[*_]+/gu, '')
    .replace(/^\s*(?:[-•+]|\d{1,3}[.)])\s+/u, '')
    .trim();

/** Words a verdict is made of, and that bear on nothing by themselves. */
const EMPTY = new Set(
  (
    'good great strong solid promising positive encouraging excellent nice clear real important useful valuable key big fair ' +
    'number result show sign signal mean tell us thing way point start step work worth night day look sound seem make ' +
    'sense data fact far interest interested demand potential progress success bad tough hard challenge opportunity ' +
    'something what how that this it you your they so now yet just very really still also need want help focus keep go move'
  )
    .split(' ')
    .map(stemOf),
);

const DOES =
  /^(?:(?:so|and|then|now|first|next|instead|today|tonight|tomorrow|this week)[,:]? )*(?:(?:you (?:can|could|should|need to|might)|i(?:'d| would)|let's) (?:(?:just|also|first) )?)?(?:ask|call|ring|email|e-mail|message|text|write|send|offer|sell|charge|count|track|mark|list|show|bring|take|tell|visit|talk|meet|book|try|run|test|set|price|cut|stop|drop|pick|choose|give|get|put|make|print|post|check|read|open|close|hand|pay|split|compare|measure|start|begin|use|say|reply|answer|wait|hold)\b/iu;

const VERDICT =
  /\b(?:good|great|strong|solid|promising|positive|encouraging|excellent|nice|fantastic|amazing|bad|tough|hard|big|real|clear|fair|important|useful|valuable|success\w*|progress|challenge|opportunity)\b/iu;

/** Whether a unit only says how good or bad it is. */
export function emptyVerdict(unit: string): boolean {
  const text = plain(unit);
  if (text === '' || /\?["'”’)]*$/u.test(text) || isListUnit(unit) || /\d/.test(text)) return false;
  if (/["“]/u.test(text)) return false;
  const said = [...stemsOf(text)];
  if (!VERDICT.test(text)) return false;
  return wordsIn(text) <= 14 && said.every((w) => EMPTY.has(w));
}

/** Names a text says mid-sentence. */
const namesIn = (text: string): string[] =>
  [...text.matchAll(/(?<=[\p{L}\p{N},;:)'’-]\s)\p{Lu}[\p{L}'’-]{2,}/gu)].map((m) => m[0].toLowerCase());

const figures = (text: string): number[] => [...numbersIn(text), ...spelledNumbersIn(text)];

/** Whether a unit adds something to what the server opened with. */
export function addsToLead(unit: string, reading: Reading, lead: string): boolean {
  const text = plain(unit);
  const held = stemsOf(lead);
  const given = figures(lead);
  // "About six months" under 6.2 months is that figure again.
  if (figures(text).some((n) => n > 1 && !given.some((g) => Math.abs(g - n) <= Math.abs(g) * 0.05)))
    return true;
  const names = namesIn(lead);
  if (namesIn(text).some((n) => !names.includes(n))) return true;
  const said = stemsOf(text);
  const fresh = new Set([...said].filter((w) => !held.has(w) && !EMPTY.has(w)));
  if (fresh.size === 0) return false;
  const from = (source: string): boolean => {
    const own = [...stemsOf(source)].filter((w) => !held.has(w) && !EMPTY.has(w));
    return sharedCount(new Set(own), fresh) >= Math.min(2, own.length) && own.length > 0;
  };
  if ([...reading.points, ...reading.record].some(from)) return true;
  return fresh.size >= 3 && (DOES.test(text) || /["“][^"”]{12,}["”]/u.test(text));
}

const AGREES =
  /^(?:yes|yeah|yep|sure|absolutely|exactly|right|that(?:'s| is) (?:fair|right|true|fine|ok(?:ay)?|honest|accurate)|it(?:'s| is) (?:fair|fine|honest|accurate)|you(?:'re| are) (?:right|correct)|fair enough|agreed)\b/iu;
/** A verdict on an offer, terms, a price named for a part of it, or a split. */
const RULES_TERMS =
  /\b(?:good|great|fair|bad|low|high|reasonable|decent|generous|solid|right|standard)\b[^.!?]{0,30}\b(?:price|offer|deal|terms?|valuation|split|share|stake|amount)\b|\b(?:price|offer|deal|terms?|valuation|split|stake|\d{1,3}\s?[/-]\s?\d{1,3})\b[^.!?]{0,30}\b(?:is|are|looks?|seems?|sounds?) (?:a )?(?:good|great|fair|bad|low|high|reasonable|decent|generous|right|standard|fine|ok)\b|^(?:yes,? )?(?:take|accept|sign|agree to|go with) (?:it|the|this|that|his|her|their)\b/iu;
const ASKS_FIRST =
  /\b(?:before (?:you (?:sign|answer|agree|say|take|accept)|(?:an?|the|your) (?:lawyer|office|\w+ (?:has|have) (?:read|said)))|until|unless|whether|not|never|don't|only|ask|lawyer|who decides|decides?)\b/iu;

/** "I'm not asserting anything without evidence.": a mentor's own defence. */
const DEFENDS =
  /\bi(?:'m| am| was|'ve| have)(?: not|n't)? (?:just |simply )?(?:assert|claim|making (?:this|that|it) up|guess|saying (?:this|that) without|(?:got )?evidence|basing)\w*|\bmy (?:evidence|claim|advice) (?:is|comes)\b|\bthe evidence (?:i|we) have\b/iu;

/** A line of what to do first: the server's alone. */
const STARTS_WITH = /^start with\s*[:—–]/iu;

const FRIENDS =
  /\b(?:friends?|roommates?|room mates?|flatmates?|family|your (?:mom|dad|parents|sister|brother))\b/iu;
const NO_FRIENDS =
  /\b(?:not|no|never|n't|except|without|instead of|rather than|other than|beyond|outside|do not count|don't count)\b/iu;

/** Comfort in place of help. */
const COMFORTS =
  /\b(?:focus on what you can control|one (?:step|thing|day) at a time|take a (?:deep )?breath|it(?:'s| is) going to be (?:ok|okay|fine|all right)|you(?:'ve| have) got this|don't panic|things will work out)\b/iu;

/** Whether a quotation is open at the end of `before`. */
function inQuote(before: string): boolean {
  let open = false;
  for (const ch of before) {
    if (ch === '"') open = !open;
    else if (ch === '“') open = true;
    else if (ch === '”') open = false;
  }
  return open;
}

/** Why a unit of the model's own does not stand beside the reading; null: it does. */
export function againstReading(
  unit: string,
  guidance: PromptGuidance,
  lead: string,
  before = '',
): string | null {
  const { reading } = guidance;
  if (reading === undefined) return null;
  const text = plain(unit);
  if (text === '') return null;
  // A line to say or send is theirs to change: none of its sentences is read alone.
  if (/^["“]/u.test(text) || inQuote(before)) return null;
  if (emptyVerdict(unit)) return 'empty_verdict';
  if ((reading.opened === 'contradiction' || reading.opened === 'held') && AGREES.test(text)) return 'agrees';
  const decided =
    reading.referral !== null && reading.referral !== 'wellbeing' && reading.referral !== 'grants';
  if (decided && RULES_TERMS.test(text) && !ASKS_FIRST.test(text)) return 'rules';
  if (STARTS_WITH.test(text)) return 'second_plan';
  if (reading.inOrder && COMFORTS.test(text)) return 'comforts';
  if (reading.kind === 'pushback' && DEFENDS.test(text)) return 'defends';
  if (reading.kind === 'integrity' && FRIENDS.test(text) && !NO_FRIENDS.test(text)) return 'friends';
  // A question is held apart, a line that announces waits for what it announces, and a draft is as long as it is.
  if (lead === '' || guidance.draft === true || /[?:]["'”’)]*$/u.test(text) || isListUnit(unit)) return null;
  return addsToLead(unit, reading, lead) ? null : 'adds_nothing';
}

/** Whether a reply makes a claim it was given. */
export function makesPoint(point: string, said: ReadonlySet<string>, share = 0.5): boolean {
  const own = new Set([...stemsOf(point)].filter((w) => !EMPTY.has(w)));
  return own.size === 0 || sharedCount(own, said) / own.size >= share;
}
