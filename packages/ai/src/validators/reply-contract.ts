import type { TurnChannel } from '@foundry/contracts';

import { inDistress } from '../prompts/conversation-state.js';
import { longDay, sayDay } from '../prompts/due-day.js';
import {
  guidanceText,
  type PromptGuidance,
  type ReplyContractFinding,
  type ReplyContractResult,
} from '../prompts/guidance.js';
import { knownNumbersIn, numbersIn } from './figures.js';
import { saidSentences, saysAgain, unsaidOf, type SaidSentence } from './said-before.js';
import { danglingAsk, danglingLine, echoesThem, readsAgain, refusesUnderLead } from './second-reading.js';
import { handBackCandidate, isProtectedLine, putToFounder } from './social.js';
import { agreesWith, bareVerdict, echoesReferral, rulesTerms } from './reading.js';
import { coverage, sharedCount, stemOf, stemsOf } from './stems.js';
import {
  isBlockUnit,
  isListUnit,
  leansBack,
  letterOpen,
  renumbered,
  unitsOf,
  withoutFences,
  wordsIn,
  type TextUnit,
} from './units.js';

/**
 * The reply contract (founder path, 2026-11-24): every coaching reply is the answer, why, the step the path is on and at
 * most one question, after it. The client's live test: "very open ended; no proper way to express what needs to be done
 * next". The prompt asks for it (prompts/craft.ts `replyContractRules`); this makes it so, deterministically:
 *
 * - {@link checkReplyContract} reads a whole reply against what the path decided ({@link PromptGuidance}) and, where a
 *   part is missing, writes that part from the decision: never a second model call, and the model's own content stays.
 * - {@link firstUnitVerdict} is the early gate of a streamed reply: a first sentence that puts the answer off ("Before we
 *   pick a structure…") or only asks is held back; any other sentence is released at once, so a good reply waits for
 *   nothing. {@link contractTail} is what the end of the stream must add.
 *
 * Social turns and role-play in character are exempt (`PromptGuidance.kind`); crisis turns never get here (no model).
 */

export interface ReplyContractInput {
  readonly reply: string;
  /** What the path decided; null: no path, nothing to hold the reply to. */
  readonly guidance: PromptGuidance | null;
  readonly channel: TurnChannel;
  /** ISO date: the step's day is said the way a person says it ("Thursday"). */
  readonly today?: string | null;
  /** The founder's message: its own words never count as the answer said. */
  readonly founderText?: string;
}

/**
 * Whether the reply of a turn the path decided this way is held to the contract: never a social turn or role-play, and
 * never a founder in distress (`founderText`), who is answered as a person first, whatever step is open, unless their message
 * was read and asks something of the work.
 */
export function contractApplies(
  guidance: PromptGuidance | null | undefined,
  founderText?: string,
): guidance is PromptGuidance {
  return (
    guidance !== null &&
    guidance !== undefined &&
    guidance.kind !== 'social' &&
    guidance.kind !== 'rehearsal' &&
    guidance.reading === undefined &&
    (founderText === undefined || !inDistress(founderText))
  );
}

/**
 * Whether the writer writes the whole reply (docs/architecture/understand.md): its message was read. What it writes is checked
 * for truth alone (validators/whole-reply.ts), whatever they feel: read, they ask something of the work.
 */
export function wholeApplies(guidance: PromptGuidance | null | undefined): guidance is PromptGuidance {
  return (
    guidance !== null &&
    guidance !== undefined &&
    guidance.kind !== 'social' &&
    guidance.kind !== 'rehearsal' &&
    guidance.reading !== undefined
  );
}

// Reading a unit ---------------------------------------------------------------------------------------------

const QUESTION_END = /\?["'”’)\]*_]*$/u;
const WEEKDAY = '(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day';
const MONTH =
  '(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)';

/** Words a sentence may open with before what it says. */
const LEAD_WORDS = String.raw`(?:(?:okay|ok|sure|right|alright|well|so|but|and|now|yes|yeah|absolutely|got it|of course)[,.!:]?\s+)*`;

/** "Before we pick a structure": putting the answer off; never "before we meet again" or "before you build". */
const BEFORE_WE = String.raw`before (?:we|i) (?:(?:can|could|even|actually|really|get to) )?(?!(?:meet|speak|talk) (?:again|next|on|this|tomorrow))(?:get|go|dive|jump|pick|decide|answer|talk|discuss|start|choose|settle|move|commit|look|think|make|recommend|suggest|build|plan|map|organi[sz]e|do|work|figure|name|set|price|land|sketch|lay|design|draft|write|touch|tackle|begin|continue|proceed|dig|unpack|break|give|say|tell|help|advise)\b`;
const BEFORE_ING = String.raw`before (?:diving|jumping|getting|going|picking|deciding|answering|choosing|moving|committing|giving|offering|suggesting|recommending) `;

/** A clause that puts the answer off, up to the comma it ends at. */
const DEFERRAL_LEAD = new RegExp(
  String.raw`^${LEAD_WORDS}(?:${BEFORE_WE}|${BEFORE_ING})[^,;:.?!—–]{0,90}(?:,|—|–)\s*`,
  'iu',
);

/** A sentence that only puts the answer off. */
const DEFERRAL = [
  new RegExp(String.raw`^${LEAD_WORDS}(?:${BEFORE_WE}|${BEFORE_ING})`, 'iu'),
  new RegExp(
    String.raw`^${LEAD_WORDS}(?:(?:first|to (?:answer|help|advise|guide|point)\b[^,.:]{0,50}),?\s+)?(?:i|we)(?:'d| would|'ll| will)?(?: (?:really|just|first))? (?:(?:need|want|have|like|love) to (?:know|understand|learn|hear)|need (?:(?:a (?:bit|little|few)|some) )?more)\b(?![^.]*(?:[:;]|, so ))`,
    'iu',
  ),
  new RegExp(
    String.raw`^${LEAD_WORDS}(?:first,? )?let(?:'s| us| me)(?: just| first)? (?:step back|take a step back|start by (?:understanding|clarifying|figuring|asking|getting)|understand|clarify|figure out|unpack|explore|get clear|get a (?:clearer|better) (?:picture|sense)|ask you|back up)\b(?:[^.:;\s]*\s+){0,10}[^.:;\s]*[.!…]*$`,
    'iu',
  ),
  /\bhard to say (?:without|until|before)\b/iu,
  /\b(?:can(?:['’]t|not)|could(?:n['’]t| not)) (?:really |properly )?(?:say|tell|answer|advise|recommend)(?: (?:you|that|this))? (?:until|without|yet|before)\b/iu,
  /\bthe (?:right )?answer (?:really )?depends\b[^:]*$/iu,
];

const IT_DEPENDS = new RegExp(
  String.raw`^${LEAD_WORDS}(?:it|that|this) (?:really |all |honestly |just )?depends\b`,
  'iu',
);
/** The rule that makes "it depends" an answer. */
const RULE = /:|;|\b(?:if|when|unless|whenever|once)\b/iu;

/** A question put in place of help ("What's your plan to reach someone like that?"). */
const PLAN_QUESTION =
  /\bhow (?:are|do) you (?:thinking|think|planning|plan|approaching|feel(?:ing)?) (?:about|of|on|to)\b|\bdo you have (?:a|any) (?:plan|strategy|idea|thoughts?|sense)s?\b|\bwhat(?:['’]s| is| are) your (?:plan|plans|thinking|strategy|approach|thoughts|take|goal|next step)s? (?:for|on|about|to|with|here)\b/iu;

/** A request that asks like a question. */
const REQUEST = new RegExp(
  String.raw`^${LEAD_WORDS}(?:first,? )?(?:please )?(?:tell me (?:about|more|what|how|who|where|why|which|a)|walk me through|help me understand|share (?:with me|a (?:bit|little)|more|what|how|who)|give me (?:a (?:sense|bit|little|quick)|more|some)|i(?:['’]d| would) (?:love|like) to (?:hear|know|understand|learn)|i(?:['’]m| am) curious)\b`,
  'iu',
);

const PRAISE = String.raw`(?:great|fantastic|amazing|brilliant|excellent|awesome|incredible|wonderful|impressive|exciting|promising|clever|genius|terrific|superb|outstanding)`;
const PRAISED = String.raw`(?:idea|concept|question|start|opportunity|venture|plan|thinking|insight|vision|product|business|startup|space|point|stuff|instinct)s?`;
/** A sentence that flatters and says nothing else. */
const FLATTERY = [
  new RegExp(
    String.raw`^(?:wow|oh|honestly|okay|yes|well|so)?[,!]?\s*(?:what (?:a|an)|(?:that|this|it)(?:['’]s| is| sounds like)|your (?:idea|concept|plan|venture) (?:is|sounds)|you(?:['’]ve| have) got|sounds like) (?:such )?(?:a |an )?(?:really |truly |absolutely |very |super |genuinely )*${PRAISE}(?: (?:and|,) \w+)?(?: \w+)?(?: ${PRAISED})?(?: (?:for|to|with|and|here|already|of yours)\b[^.?!,;:]{0,40})?[.!]*$`,
    'iu',
  ),
  new RegExp(String.raw`^${PRAISE} (?:${PRAISED}|thinking|work|job)[.!]*$`, 'iu'),
  /^(?:i|we) (?:really |absolutely |just )?(?:love|adore) (?:this|that|your|the|it|where)\b[^.?!,;:]{0,60}[.!]*$/iu,
  /^i(?:['’]m| am) (?:so |really |very )?(?:excited|impressed|thrilled|blown away)\b[^.?!,;:]{0,80}[.!]*$/iu,
  /^you(?:['’]re| are) (?:doing (?:great|amazing|awesome)|(?:going to|gonna) (?:crush|nail|love)|a natural|off to a (?:great|fantastic|strong))\b[^.?!,;:]{0,40}[.!]*$/iu,
  /^keep up the (?:great|good|amazing) work[.!]*$/iu,
  /^(?:i(?:['’]d| would|['’]m| am) (?:be )?(?:so |very |more than )?(?:happy|glad|delighted) to help|happy to help|glad to help|glad you asked)\b[^.?!,;:]{0,60}[.!]*$/iu,
];
/** Flattery before something real: "That's a great idea, but the buyer…" keeps what follows. */
const FLATTERY_LEAD = new RegExp(
  String.raw`^(?:(?:(?:that|this|it)(?:'s| is)|what|your (?:idea|concept|plan) is) (?:such )?(?:a |an )?(?:really |truly |very )?${PRAISE}\b|i (?:really )?love (?:this|that|your|the)\b)[^.?!;:]{0,40}?(?:,| —| –)\s*(?:but|and|so|now|however,?)\s+`,
  'iu',
);

/** Words that carry nothing of their own ("Got it.", "Let's dig in.", "Here's how I see it."). */
const FILLER =
  /^(?:(?:okay|ok|got it|right|sure|understood|thanks|alright|perfect|great|nice|cool|noted|fair enough|makes sense|absolutely|of course|hi|hello|hey)(?:[\s,]+[\p{L}'’.-]+){0,2}|(?:so|now)?,?\s*let(?:['’]s| us) (?:dig in|dive in|get (?:into it|started|going|to it)|take a look|break (?:it|this) down)|here(?:['’]s| is) (?:how i see it|my (?:honest )?(?:take|read|view)|the thing)|good to (?:hear|know)|no problem|no worries)[\s.!:…]*$/iu;

/** `asked`: a question that may be a line for someone else (a draft, a script): never moved or left out, and no help either. */
type UnitClass = 'question' | 'asked' | 'deferral' | 'flattery' | 'filler' | 'block' | 'statement';

/** The unit without Markdown emphasis around it, apostrophes straight. */
function bare(text: string): string {
  return text
    .replace(/\[\s*E\d+(?:\s*[,;]\s*E\d+)*\s*\]/gi, '')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/^[\s*_>"“]+/u, '')
    .replace(/[*_]+/g, '')
    .trim();
}

function quoteOpen(text: string): boolean {
  let open = false;
  for (const ch of text) {
    if (ch === '"') open = !open;
    else if (ch === '“') open = true;
    else if (ch === '”') open = false;
  }
  return open;
}

/** Whether a question is asked of no one ("Why?", "So what changes?") and answered by what follows it. */
function isRhetorical(text: string, next: string | null): boolean {
  return (
    next !== null &&
    next.trim() !== '' &&
    !QUESTION_END.test(next.trim()) &&
    wordsIn(text) <= 6 &&
    !/\b(?:you|your|yours|we|us|our)\b/iu.test(text)
  );
}

/** What a unit (said after `before`, with `next` after it) does in a coaching reply. */
function classOf(before: string, unit: string, next: string | null): UnitClass {
  const raw = unit.trim();
  if (isBlockUnit(raw) || quoteOpen(before) || letterOpen(before) || /^\s*>/.test(raw)) {
    // A list of questions that opens the reply is still questions; under a script's heading it is the script.
    return QUESTION_END.test(raw) && isListUnit(raw) && wordsIn(before) < 12 && putToFounder(before, unit)
      ? 'asked'
      : 'block';
  }
  const text = bare(raw);
  if (QUESTION_END.test(text)) {
    if (!putToFounder(before, unit)) return 'block';
    if (isRhetorical(text, next)) return 'filler';
    return handBackCandidate(before, unit) ? 'question' : 'asked';
  }
  if (REQUEST.test(text) && !/:\s*$/.test(text)) return 'question';
  if (IT_DEPENDS.test(text)) {
    return RULE.test(text.replace(IT_DEPENDS, '')) || (next !== null && RULE.test(next))
      ? 'statement'
      : 'deferral';
  }
  const lead = DEFERRAL_LEAD.exec(text);
  if (lead !== null) {
    const rest = text.slice(lead[0].length);
    if (!isPostponing(rest)) return 'statement';
    return QUESTION_END.test(rest) ? 'question' : 'deferral';
  }
  if (DEFERRAL.some((re) => re.test(text))) return 'deferral';
  if (
    !/\b(?:not|never|whether|isn't|won't|can't|don't|doesn't)\b/iu.test(text) &&
    FLATTERY.some((re) => re.test(text))
  )
    return 'flattery';
  if (FILLER.test(text)) return 'filler';
  return 'statement';
}

/** Whether what follows a "before we…" clause only goes on putting it off. */
/** Whether a unit only flatters. */
export const flatters = (unit: string): boolean => classOf('', unit, null) === 'flattery';

function isPostponing(rest: string): boolean {
  return (
    rest.trim() === '' ||
    QUESTION_END.test(rest.trim()) ||
    REQUEST.test(rest) ||
    /^(?:i|we|it(?:'s| is)|let(?:'s| me| us)|there(?:'s| are| is)|can you|could you|one thing|a (?:few|couple))\b/iu.test(
      rest.trim(),
    )
  );
}

function capital(text: string): string {
  return text.replace(/^([\s*_"“(]*)(\p{Ll})/u, (_m, pre: string, c: string) => `${pre}${c.toUpperCase()}`);
}

/** The unit without the clause that puts it off or flatters, when something real follows the clause; else null. */
function withoutLead(raw: string): string | null {
  const space = /^\s*/.exec(raw)?.[0] ?? '';
  const text = raw.trim();
  const straight = text.replace(/[‘’ʼ]/g, "'");
  for (const pattern of [DEFERRAL_LEAD, FLATTERY_LEAD]) {
    const lead = pattern.exec(straight);
    if (lead === null) continue;
    const rest = text.slice(lead[0].length);
    if (wordsIn(rest) >= 3 && !isPostponing(rest.replace(/[‘’ʼ]/g, "'"))) return `${space}${capital(rest)}`;
  }
  return null;
}

interface ReadUnit extends TextUnit {
  readonly kind: UnitClass;
}

function read(text: string): ReadUnit[] {
  const units = unitsOf(text);
  return units.map((u, i) => ({
    ...u,
    kind: classOf(text.slice(0, u.start), u.raw, units[i + 1]?.text ?? null),
  }));
}

// The step ---------------------------------------------------------------------------------------------------

const STANDING_OPENS = String.raw`on your path,? (?:the |your )?next(?: step| item)? is`;
const NEXT_LINE = new RegExp(
  String.raw`^[\s*_]*(?:next(?: step)?|${STANDING_OPENS})[*_]*\s*(?::|—|–|-)`,
  'iu',
);
/** The step line as the server opens it, on text and on a call. */
const SERVER_STEP = /^[*_]*(?:(?:your )?next(?: step)?|on your path,? next is)[*_]*\s*:/iu;
/** "A good next step: …", "Your next step is to …": a sentence that says what to do next, whatever it opens with. */
const NEXT_SAID = new RegExp(
  String.raw`^${LEAD_WORDS}[\s*_]*(?:here(?:['’]s| is) )?(?:a|an|your|the|my|one) (?:(?:really |very )?(?:good|great|best|better|solid|useful|obvious|simple|smart|clear|logical|natural|real|right|immediate|concrete|practical) )*next (?:step|move|action|thing to do)[*_]*\s*(?::|—|–|-|(?:is|would be|could be|should be)\b)`,
  'iu',
);
/** "One small step: call a loft.", "What to do now: send this.", "Test that first: …": a second next thing. */
const OWN_NEXT = new RegExp(
  String.raw`^${LEAD_WORDS}(?:` +
    [
      String.raw`(?:one|a|an|the|your|my) (?:very )?(?:(?:small|smallest|tiny|quick|quickest|simple|simplest|concrete|immediate|easy|easiest|single) ){1,3}(?:first |next )?(?:step|action|task|move|thing to do)\b(?: (?:now|today|here|right now|this week|for (?:now|today|you|this week)|you can (?:take|do)(?: now| today| this week)?|to take(?: now| today)?))?(?:\s*(?::|—|–)|,? (?:is|would be|could be|will be)\b)`,
      String.raw`(?:what (?:you (?:can |should )?|to )do (?:now|first|today|tonight|tomorrow|right away|this week|right now)|do this (?:now|today|first|week|tonight)|first (?:step|thing)|action(?: item)?|your orders|orders|step one)\s*(?::|—|–)`,
      String.raw`test (?:that|this|it) (?:first|now|today)\b`,
      String.raw`(?:start|begin) (?:by tomorrow|tomorrow|today|tonight|right now|this (?:week|evening|morning|afternoon))\b`,
      String.raw`(?:the )?(?:one|only|first|smallest|best|single) thing (?:you can|to|you should|i(?:['’]d| would)(?: have you)?) do\b`,
      String.raw`(?:your|the) first step\b[^.!?:]{0,20}(?::|is\b|should\b|—|–)`,
    ].join('|') +
    ')',
  'iu',
);
/** "…: your next step is to test it": said inside a sentence. */
const NEXT_INSIDE =
  /\b(?:your|the) (?:very )?next (?:step|move)(?:\s*:| (?:is|should be|would be|will be)\b)/iu;
/** "Next, choose one group to ask.", "Next, we turn to the pass line.": what to do next, with a comma. */
const NEXT_COMMA =
  /^[\s*_]*(?:(?:and|so|then|now) )?next,?\s+(?:,\s*)?(?:(?:you(?:['’]ll| will| should| need to| can| want to)|we(?:['’]ll| will| should| can| need to)?|let['’]?s|let us|i(?:['’]d| would|['’]ll)|i(?:['’]m| am) going to|think about|work on|move on to|comes?)\b|(?:write|ask|make|list|send|talk|call|sell|pick|choose|put|book|test|count|run|offer|try|set|take|find|start|email|message|mark|fill|read|check|look|keep|decide|show|contact|build|draft|collect|get|copy|rehearse|deliver|finish|focus|pin|line up|reach|create|define|identify|figure|name)\b)/iu;
/** What done means, on its own line. */
export const DONE_LINE = /^[\s*_]*done (?:when|once)\b/iu;
/** "You will know it is done once …": what done means, in other words. */
const DONE_SAID =
  /^(?:so |and )?you(?:['’]ll| will) (?:know|have done enough|be done|be finished)\b[^.!?]{0,50}\b(?:enough|done|finished|ready)?\b[^.!?]{0,20}\b(?:when|once)\b/iu;
/** Whether `text` names the step: its title, or one of the things to do in it, in recognisable words. */
export function namesStep(text: string, step: PromptGuidance['step']): boolean {
  if (step === null) return false;
  const said = stemsOf(text);
  const matches = (words: ReadonlySet<string>, opens: boolean): boolean => {
    if (words.size === 0) return false;
    const shared = sharedCount(words, said);
    const share = shared / words.size;
    return (
      (share >= 0.6 && shared >= Math.min(2, words.size)) ||
      (shared >= 3 && share >= 0.4) ||
      (opens && shared >= 2 && share >= 0.34)
    );
  };
  const opens = NEXT_LINE.test(text);
  if (matches(stemsOf(step.title), opens)) return true;
  return step.items.some((item) => {
    const words = stemsOf(item.do);
    return words.size >= 3 && coverage(words, said) >= 0.7;
  });
}

function stripEnd(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s.!;:,]+$/u, '');
}

/** Lower-cases a clause's first letter, unless it is a name, an acronym or "I". */
function lowerFirst(text: string): string {
  const word = /^[\p{L}\p{N}'’]+/u.exec(text)?.[0] ?? '';
  if (
    /^I(?:['’]\p{L}+)?$/u.test(word) ||
    /^\p{Lu}[\p{Lu}\d]/u.test(word) ||
    /^\p{L}\p{Ll}*\p{Lu}/u.test(word)
  )
    return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

const MOST_PARTS_CHARS = 150;

function doneClause(doneWhen: string): string {
  // Said in the step line already, as the step.
  if (/^\s*this one part is done:/iu.test(doneWhen)) return 'this one part is done';
  // A step cut to some of its parts: which ones, when they fit a line.
  const parts = /^\s*these (\d+) parts are done:\s*(.*)$/iu.exec(doneWhen);
  if (parts !== null)
    return (parts[2] ?? '').length <= MOST_PARTS_CHARS
      ? `these ${parts[1] ?? ''} parts are done: ${stripEnd(parts[2] ?? '')}`
      : `these ${parts[1] ?? ''} parts are done`;
  return lowerFirst(stripEnd(doneWhen.replace(/^\s*done when:?\s*/iu, '')));
}

/** A step's title with its day: "Email one group today", "Talk to five people by Thursday, December 3". */
function titleBy(
  title: string,
  dueOn: string | null,
  today: string | null | undefined,
  long: boolean,
): string {
  const t = stripEnd(title);
  const day = sayDay(dueOn, today);
  if (day === null) return t;
  if (day === 'today' || day === 'tomorrow')
    return long && day === 'tomorrow'
      ? `${t} by tomorrow`
      : `${t} ${day === 'today' ? 'today' : 'by tomorrow'}`;
  return `${t} by ${long ? (longDay(dueOn ?? '') ?? day) : day}`;
}

/**
 * The step as the server says it, once, at the end of the reply: "**Next:** … by Thursday, December 3. Done when …" (text),
 * one short sentence on a call.
 */
export function stepLine(
  step: NonNullable<PromptGuidance['step']>,
  channel: TurnChannel,
  today?: string | null,
): string {
  // Said aloud, the title alone: a meaning in brackets is read on the screen.
  if (channel === 'voice')
    return `Your next step: ${lowerFirst(titleBy(step.title, step.dueOn, today, false))}.`;
  const title = step.said ?? step.title;
  return `**Next:** ${titleBy(title, step.dueOn, today, true)}. Done when ${doneClause(step.doneWhen)}.`;
}

/** A step that is not about what they asked, as what stands on their path. */
export function standingLine(
  step: NonNullable<PromptGuidance['step']>,
  channel: TurnChannel,
  today?: string | null,
): string {
  const title = channel === 'voice' ? step.title : (step.said ?? step.title);
  const said = titleBy(title, step.dueOn, today, channel === 'text');
  return channel === 'voice'
    ? `On your path, next is: ${lowerFirst(said)}.`
    : `**On your path, next is:** ${said}.`;
}

/** The step as a recall ends on it, with the day it was due when that has passed. */
function recalledStep(
  step: NonNullable<PromptGuidance['step']>,
  channel: TurnChannel,
  today?: string | null,
): string {
  const was = step.wasDue ?? (today != null && step.dueOn !== null && step.dueOn < today ? step.dueOn : null);
  if (was === null) return stepLine(step, channel, today);
  const day = longDay(was) ?? was;
  const dueOn = step.dueOn === was ? null : step.dueOn;
  return stepLine({ ...step, dueOn }, channel, today).replace(
    channel === 'voice' ? /\.$/u : /\. (?=Done when )/u,
    channel === 'voice' ? `. It was due ${day}.` : `. It was due ${day}. `,
  );
}

/** The turn's step as the server says it; '' when the turn gives none (it was said a moment ago). */
export function sayStep(guidance: PromptGuidance, channel: TurnChannel, today?: string | null): string {
  const { step } = guidance;
  if (step === null) return '';
  if (guidance.kind === 'recall') return recalledStep(step, channel, today);
  // Said in the reply before: on a call it is not said twice in a row; a typed reply always has it.
  if (guidance.stepRole === 'quiet' && channel === 'voice') return '';
  return guidance.stepRole === undefined
    ? stepLine(step, channel, today)
    : standingLine(step, channel, today);
}

// The model's own step talk --------------------------------------------------------------------------------------

/** A line of its own that says by when, and nothing else ("Do it by Monday.", "By Friday, December 5."). */
const BY_ONLY = new RegExp(
  String.raw`^(?:(?:do|finish|complete|have|get|aim to (?:do|finish|complete|have|get)|try to (?:do|finish|have))\b[^.!?]{0,60}?\b)?(?:by|before|due(?: on| by)?|start (?:by|on))\s+(?:the )?(?:end of )?(?:(?:this|next) )?(?:${WEEKDAY}|${MONTH}\.? \d{1,2}|today|tonight|tomorrow|week(?:end)?)(?:,? (?:the )?(?:${MONTH}\.? \d{1,2}|\d{1,2} ${MONTH})(?:st|nd|rd|th)?)?[.!]*$`,
  'iu',
);
/** "Do this in 20 minutes." */
const IN_MINUTES =
  /^(?:do (?:it|this|that)|that (?:takes|is)|it takes)\b[^.!?]{0,20}\b(?:in |about )?\d+ (?:minutes|min|hours?)\b[^.!?]{0,20}[.!]*$/iu;
/** What opens the step's own list ("Here's what to do:", "Do three things:"). */
const ANNOUNCES_STEPS =
  /^[\s*_]*(?:here(?:['’]s| is| are)?|so|now|then)?[, ]*(?:(?:what|the (?:\w+ )?steps|the plan|your plan|how)\b[^.!?]{0,60}|(?:you(?:['’]ll| will| should)? )?(?:do|follow|take) (?:these|this|the following|three|four|two|a few)\b[^.!?]{0,40})[*_]*:[*_\s]*$/iu;

/** Whether a unit opens a step of the model's own: "Next: …", "Your next step is …", "What to do next: …". */
export function opensStep(unit: string): boolean {
  const t = bare(unit.replace(/^\s*(?:[-*+•]|\d{1,3}[.)])\s+/u, '').replace(/^\s*#{1,6}\s+/u, ''));
  if (NEXT_LINE.test(t)) return true;
  if (QUESTION_END.test(t)) return false;
  return (
    NEXT_SAID.test(t) ||
    NEXT_INSIDE.test(t) ||
    OWN_NEXT.test(t) ||
    /^(?:what to do|do this) next\b/iu.test(t) ||
    /^(?:so |and )?the next (?:concrete|clear|real|simple|small|logical|natural|best|practical) (?:step|move|thing)\b/iu.test(
      t,
    )
  );
}

/** Whether a unit by itself only says when it is due, how long it takes or what done means. */
export function saysDue(unit: string): boolean {
  const t = bare(unit.replace(/^\s*(?:[-*+•]|\d{1,3}[.)])\s+/u, ''));
  return (
    DONE_LINE.test(t) ||
    DONE_SAID.test(t) ||
    BY_ONLY.test(t) ||
    IN_MINUTES.test(t) ||
    /^(?:deadline|due|by when)\s*:/iu.test(t)
  );
}

/** Whether a unit says one of the step's own parts again (they are on the card, and under the reply when asked). */
export function restatesItem(unit: string, guidance: PromptGuidance): boolean {
  const { step } = guidance;
  if (step === null || guidance.howTo === true) return false;
  const said = stemsOf(unit.replace(/^\s*(?:[-*+•]|\d{1,3}[.)])\s+/u, ''));
  if (said.size < 3) return false;
  // A sentence of the program's answer is the answer, whatever the step's parts say too.
  if (
    guidance.kind !== 'report' &&
    guidance.ask !== null &&
    coverage(said, stemsOf(`${guidance.ask.answer} ${guidance.ask.why}`)) >= 0.6
  )
    return false;
  return step.items.some((item) => {
    const words = stemsOf(item.do);
    if (words.size < 3 || coverage(words, said) < 0.7) return false;
    return coverage(said, stemsOf(`${item.do} ${item.how}`)) >= 0.6;
  });
}

/** "Next, let's …", "Next, send them …": a second plan beside the server's step. */
const SECOND_PLAN =
  /^(?:so |and |now )?next,? (?:let(?:'s| us)|you(?:'ll| will| can| could| should| need to| might| want to|'d want to)|i(?:'d| would| suggest| recommend)|we(?:'ll| can| should| need to)|try|ask|get|go|write|send|build|make|run|test|talk|call|e-?mail|offer|sell|pick|choose|set|find|list|draft|create|take|turn|put|show|launch|start|do|use|work|think|focus|schedule|book|reach|contact|interview|check|review|decide|define|identify|validate|gather|collect|refine|update|share|look|move|figure|map|plan|price|prepare|speak|follow)\b/iu;
const DO_VERBS =
  'spend|ask|call|contact|talk|speak|go|visit|knock|post|send|write|make|list|email|e-?mail|message|text|offer|sell|run|try|pick|choose|set|find|reach|draft|create|build|put|show|count|test|get|start|begin|book|schedule|interview|meet|print|hand|launch|record|track|watch|look|check|map|sketch|define|identify|price|charge|collect|note|read|take|give|use|say|tell|do';
/** A sentence that tells them to do something: an order, a list to follow, what the mentor would do. */
const INSTRUCTS = new RegExp(
  String.raw`^(?:(?:so|and|then|now|first|next|also|instead|today|tomorrow|this week|orders|try this|here(?:['’]s| is) (?:what|how)[^.!?:]{0,40})[,:]? )*(?:(?:i(?:['’]d| would)|you(?:['’]ll| can| could| should| might| need to| may want to)|let['’]?s|we (?:can|should|could)) (?:(?:just|also|then|simply|start by|begin by) )*)?(?:${DO_VERBS})\b(?! (?:that|it|this) (?:tells|shows|means)\b)`,
  'iu',
);
/** "The safest bet is to try it": another one thing. */
const THE_THING_IS =
  /^(?:so |and |then )?(?:the|your|my) (?:least \w+|best|smartest|one|only|first|single|safest|quickest|most useful|right) (?:thing|move|step|bet|option)\b[^.!?]{0,30}\b(?:is|would be)\b/iu;
/** The first of a sequence the answer itself is ("First, … Next, …"). */
const SEQUENCE = /^(?:first(?:ly)?|to start|start (?:by|with)|begin (?:by|with)|step (?:one|1))\b/iu;

const PARAGRAPH = /^[ \t]*\n\s*\n|^\s*\n[ \t]*\n/;

/** What the stream of a reply's units says of steps, read unit by unit: the model's own step talk goes, block by block. */
export class StepTalk {
  /** The rest of a paragraph a step line opened. */
  #inBlock = false;
  /** The list right under a step line, or one that opened with the step's own first part. */
  #inList = false;
  /** What the server's lead shows of a template, by label: the model never writes it a second time. */
  readonly #shown: ReadonlySet<string>;
  /** The server's lead is the message they asked for: a draft of the model's own beside it goes, to its end. */
  readonly #sent: boolean;
  #inDraft = false;
  #draftClosed = false;
  /** The answer is a sequence ("First, …"): its "Next, …" is part of it. */
  #sequence = false;
  /** An item of a list that stays: what follows it on its line stays too. */
  #listStays = false;
  /** The server's lead is the plan they asked for, as a list: another one of the model's goes. */
  readonly #planned: boolean;
  /** The server's lead is their dated story: the model's own dates of it go. */
  readonly #dated: boolean;
  /** The template of labelled lines is the server's: the model's lines of it, and what only announces them, go. */
  readonly #served: boolean;
  /** The turn's template is another one: the five lines of the idea's page are none of it. */
  readonly #otherPage: boolean;
  #wroteTemplate = false;
  /** An order of their own is under way ("First, …"): its "Next, …" is part of it. */
  #ordered = false;

  constructor(private readonly guidance: PromptGuidance) {
    this.#served = guidance.template !== undefined && guidance.restate === undefined;
    const body = guidance.step?.template?.body ?? '';
    this.#otherPage =
      (guidance.lead?.text ?? '') !== '' &&
      guidance.step !== null &&
      !this.#served &&
      !/\bwho\s*:/iu.test(body);
    this.#planned = (guidance.lead?.text ?? '').includes('\n1. ') && guidance.template !== 'opens';
    this.#dated = DATED_LINES.test(guidance.lead?.text ?? '');
    this.#sent =
      (guidance.lead?.text ?? '').startsWith('Here is the message.') ||
      (this.#served && guidance.draft !== true && guidance.template === 'shown');
    this.#copies = this.#served && guidance.template === 'shown' ? saidSentences(body) : [];
    this.#shown = new Set(
      (guidance.lead?.text ?? '')
        .split('\n')
        .flatMap((l) => labelOf(l))
        .slice(0, 24),
    );
  }

  /** The model started the template itself (its lines went). */
  get wroteTemplate(): boolean {
    return this.#wroteTemplate;
  }

  /** The draft that is left out opened without quotes. */
  #unquoted = false;

  /** A sentence of a letter nobody asked for just went. */
  #draftRuns = false;

  /** The rest of a template's line that went ("Ask: "I am taking the first five. Shall I put you down?""). */
  #inLine = false;

  /** What the step's template says, sentence by sentence (a letter, a script): the card's, when the turn asks for none of it. */
  readonly #copies: readonly SaidSentence[];

  /** A line of the template, or a sentence that only says that there is one. */
  #ofTemplate(unit: string): boolean {
    const text = unit.trim();
    // A letter or a message nobody asked for: the template's own sentences, and blanks in running text.
    if (
      this.#served &&
      this.guidance.draft !== true &&
      this.guidance.howTo !== true &&
      !isListUnit(text) &&
      (saysAgain(text, this.#copies, COPY_SHARE) ||
        (/\[[a-z][^\]]{1,40}\]/u.test(text) && !/^[\s*_]*\p{L}[\p{L} ]{0,24}:/u.test(text)))
    ) {
      this.#draftRuns = true;
      return true;
    }
    if ((this.#draftRuns || this.#inDraft) && this.#served && SIGNED.test(text)) return true;
    // "I would love to have you with me." of a letter whose other sentences went.
    if (this.#draftRuns && !/^\s*\n/.test(unit) && /^["“]?(?:i|we|my|our)\b/iu.test(text)) return true;
    this.#draftRuns = false;
    if (this.#inLine && !/^\s*\n/.test(unit)) return true;
    this.#inLine = false;
    if (this.#otherPage && isListUnit(text) && PAGE_LINE.test(text)) {
      this.#inLine = true;
      return true;
    }
    if (this.#otherPage && ABOUT_A_PAGE.test(bare(text)) && wordsIn(text) <= 24) return true;
    if (!this.#served) return false;
    if (isTemplateLine(text, this.guidance)) {
      this.#wroteTemplate = this.#inLine = true;
      return true;
    }
    const t = bare(text);
    // What a sentence says of one of its lines goes on to the end of its paragraph.
    if (LINE_OF_IT.test(t) || OF_A_LINE.test(t) || WRITES_THE_LINES.test(t)) {
      this.#inLine = true;
      return true;
    }
    return (
      TEMPLATE_TALK.test(t) ||
      (this.guidance.template === 'opens' && (SHEET_TALK.test(t) || ONLY_FRAMES.test(t))) ||
      (ABOUT_A_PAGE.test(t) && wordsIn(t) <= 34)
    );
  }

  /** The step's own title, as a sentence of its own ("Email the five theatre groups."). */
  #saysTitle(text: string): boolean {
    const { step } = this.guidance;
    if (step === null || QUESTION_END.test(text)) return false;
    const said = stemsOf(text);
    const title = stemsOf(step.title);
    return title.size >= 2 && coverage(title, said) >= 0.8 && coverage(said, title) >= 0.9;
  }

  /** A plan of the model's own beside the server's step ("Next, let's …"), never a part of the answer's own sequence. */
  #secondPlan(unit: string, text: string): boolean {
    const { guidance } = this;
    if (guidance.step === null || guidance.howTo === true || this.#sequence) return false;
    if (!SECOND_PLAN.test(bare(text))) return false;
    return (
      PARAGRAPH.test(unit) ||
      (guidance.lead ?? null) !== null ||
      guidance.kind === 'news' ||
      guidance.kind === 'report'
    );
  }

  /**
   * Whether the unit is the model's own step talk. A step line takes the rest of its paragraph with it, and the list right
   * under it; a deadline or a done-when goes by itself with what follows it in its paragraph; a list that opens with one of
   * the step's parts goes whole, any other list stays whole (an item left out would be a hole in it).
   */
  drops(unit: string): boolean {
    const text = unit.trim();
    // The words themselves were asked for: its lines are theirs, whatever labels they have.
    const newParagraph = PARAGRAPH.test(unit);
    const item = isListUnit(text);
    // A draft in quotes ends with them: what is said after it is the answer's own.
    if (this.#inDraft && this.#draftClosed && newParagraph && !/^["“]/u.test(text)) this.#inDraft = false;
    // One that opened without them ends where what is said is no letter's any more.
    if (this.#inDraft && this.#unquoted && newParagraph && !OF_A_LETTER.test(bare(text)))
      this.#inDraft = false;
    if (this.#sent && (this.#inDraft || OWN_DRAFT.test(bare(text)))) {
      if (!this.#inDraft) this.#unquoted = !/^[\s*_>]*["“]/u.test(text);
      this.#inDraft = true;
      this.#draftClosed = /["”]\s*$/u.test(text);
      return true;
    }
    const [label] = labelOf(text);
    if (label !== undefined && this.#shown.has(label)) return true;
    if (this.#ofTemplate(unit)) return true;
    if (/^first\b/iu.test(bare(text))) this.#ordered = true;
    const template = isTemplateLine(text, this.guidance);
    if (item && template) {
      this.#inBlock = this.#inList = false;
      this.#listStays = true;
      return false;
    }
    if (SEQUENCE.test(bare(text))) this.#sequence = true;
    if (
      this.guidance.orders === true &&
      (INSTRUCTS.test(bare(text)) ||
        THE_THING_IS.test(bare(text)) ||
        (!QUESTION_END.test(text) && (item || /:[*_\s]*$/.test(text))))
    ) {
      this.#inBlock = this.#inList = true;
      return true;
    }
    if (
      opensStep(text) ||
      this.#secondPlan(unit, text) ||
      (this.#planned && (item || OWN_PLAN.test(bare(text))))
    ) {
      this.#inBlock = this.#inList = true;
      this.#listStays = false;
      return true;
    }
    if (!item && NEXT_COMMA.test(bare(text)) && !this.#ordered) return true;
    if (item && this.#dated && OWN_DATED.test(bare(text.replace(/^\s*(?:[-*+•]|\d{1,3}[.)])\s+/u, ''))))
      return true;
    if (item) {
      if (this.#inList) {
        this.#inBlock = true;
        return true;
      }
      if (!this.#listStays && restatesItem(text, this.guidance)) {
        this.#inList = this.#inBlock = true;
        return true;
      }
      this.#listStays = true;
      this.#inBlock = false;
      return saysDue(text);
    }
    if (newParagraph) {
      this.#inBlock = false;
      // The list under a step line may come after a blank line; anything else ends it.
      this.#inList = false;
      this.#listStays = false;
    }
    if (this.#saysTitle(text) || (this.#dated && OWN_DATED.test(bare(text)))) return true;
    if (this.#inBlock) return !(QUESTION_END.test(text) && !/["“”]/.test(text));
    if (saysDue(text)) {
      this.#inBlock = DONE_LINE.test(bare(text)) || DONE_SAID.test(bare(text));
      return true;
    }
    return false;
  }
}

/** Share of a sentence's words that make it the template's own. */
const COPY_SHARE = 0.75;
/** What a letter says: in their own voice, to someone, with blanks, or its sign-off. */
const OF_A_LETTER =
  /\[|^(?:hi|hello|hey|dear|subject|i|i['’]\p{L}+|we|we['’]\p{L}+|my|our|could|would|can|may|thanks|thank you|best|regards|cheers|sincerely|yours)\b|^\p{Lu}\p{Ll}+(?: \p{Lu}\p{Ll}+)?[.!]?$/iu;
/** A name alone, under a message. */
const SIGNED =
  /^(?:(?:best|thanks|thank you|cheers|regards|sincerely|yours)[,.! ]*)?(?:\p{Lu}\p{Ll}+(?: \p{Lu}\p{Ll}+)?)?[.!]*$/u;

/** A line of the five-line page of an idea. */
const PAGE_LINE = /^\s*(?:[-*+•]\s+|\d{1,3}[.)]\s+)[*_]{0,2}(?:who|problem|today|idea|why me)[*_]{0,2}\s*:/iu;
/** "Line 2: what goes wrong.", "Then line 2: …", "Start with line 1: …". */
const LINE_OF_IT =
  /^(?:(?:so|and|then|now|next)[, ]+)?(?:(?:start|begin|go) with )?(?:the (?:first|second|next) line|line (?:\d|one|two|three|four|five))\b/iu;
const OF_A_LINE = /\b(?:first|second|third|next) line\b/iu;
/** "Write the five lines in plain words.": what goes with it ("No buzzwords.") goes too. */
const WRITES_THE_LINES =
  /\b(?:write|fill in|fill out|finish) (?:down )?(?:the|these|your|all) (?:five|5) lines\b/iu;
/** A sentence about the template itself. */
const TEMPLATE_TALK =
  /\b(?:five lines|five-line|(?:the|this|that|your) (?:\w+[- ])?template|(?:the|these|those) (?:\[)?brackets(?:\])?|\[brackets\])\b/iu;
/** "This frames the work.", "That is a good start.": nothing of theirs, under a page the server gave. */
const ONLY_FRAMES =
  /^(?:this|it|that)(?: \w+)? (?:sets the stage|captures|puts the core|gets (?:you|the core|this)|helps? you (?:stay|see|focus)|lays (?:out|the)|is a (?:quick|simple|good|great) (?:way|start|snapshot)|keeps? (?:this|it|your))\b[^.!?]{0,90}[.!]*$/iu;
const SHEET_TALK = /\b(?:the|this|that|your) (?:canvas|table|sheet|card|worksheet)\b/iu;
/** "Let's put it on one page.", "This one-pager frames it…", "Begin with line one, and tell me when you have it." */
const ABOUT_A_PAGE =
  /^(?:(?:so|and|okay|ok|now|got it|then|first)[,. ]+)*(?:let['’]?s|let us|we['’]?ll|we will|i['’]?d|i would|i['’]?ll|i will|start|begin|here['’]?s|here is|here are|this|that|these|it|your idea is clear|the idea is clear|the rest|fill|you['’]ve got the)\b[^.!?]*\b(?:on one page|one[- ]page(?:r)?|first line|the lines?|this page|the page|lines? done|clear)\b/iu;

/** Dated lines, as the server tells a story; a date of it the model tells again, or the step by its record's name. */
const DATED_LINES = new RegExp(String.raw`\n- ${MONTH} \d{1,2}: `, 'u');
const OWN_DATED = new RegExp(
  String.raw`^(?:(?:on )?${MONTH} \d{1,2}\s*[:,–—-]|open step(?: now)?\s*:)`,
  'iu',
);
/** A plan of the model's own ("Week 1: …", "Here's a two-week plan to get there."). */
const OWN_PLAN =
  /^(?:(?:week|day|month) (?:\d|one|two|three|four)\b|here(?:['’]s| is) (?:a|the|your) [^.!?]{0,40}\b(?:plan|schedule|roadmap)\b)/iu;

/** A message of the model's own beside the one the server gave ("Here's a short email you can send:", "Hi [Name],"). */
const OWN_DRAFT =
  /^(?:(?:sure|yes|of course|okay|ok|absolutely)[,!. ]+)?(?:here(?:['’]s| is| are) (?:a|an|the|your|one|another|my)\b[^.!?]{0,90}\b(?:e-?mails?|messages?|drafts?|notes?|templates?|texts?|versions?|scripts?)\b|(?:you (?:can|could) (?:say|send|write|use)|try (?:this|sending)|subject)\b[^.!?]{0,60}:|(?:hi|hello|hey|dear) (?:\[|there|everyone)|["“](?:hi|hello|hey|dear)\b)/iu;

/** The label of a template's line ("1. Who: …"), in lower case; [] when it has none. */
function labelOf(line: string): string[] {
  const label = /^\s*(?:[-*+•]\s+|\d{1,3}[.)]\s+)[*_]{0,2}([\p{L}][\p{L}\d '’/-]{1,40}?)[*_]{0,2}\s*:/u.exec(
    line,
  )?.[1];
  return label === undefined ? [] : [label.toLowerCase()];
}

const WHY_LABEL = /^(\s*)[*_]{0,2}why[*_]{0,2}:[*_]{0,2}\s+(?=\S)/iu;
/** A list marker with nothing after it: where a reply broke off. */
const BARE_MARKER = /^\s*(?:\d{1,3}[.)]|[-*•])\s*$/u;

/** A unit without a label that is ours ("Why: Customers judge…"); '' when it is only a list marker. */
const READING_LABEL =
  /^(\s*)[*_]{0,2}what (it (?:means(?: for (?:the|your) (?:venture|idea))?|does(?: not|n['’]t) show(?: yet)?|changes|shows))[*_]{0,2}:[*_]{0,2}\s+(?=\p{L})/iu;

/** "Your math: 40 x 3 = 120": the sum needs no name. */
const SUM_LABEL =
  /^(\s*)[*_]{0,2}(?:your|the|my|our) (?:math|maths|sums?|calculation|arithmetic)[*_]{0,2}:[*_]{0,2}\s+(?=\S)/iu;

export function withoutLabel(unit: string): string {
  if (BARE_MARKER.test(unit)) return '';
  const without = unit.replace(WHY_LABEL, '$1').replace(SUM_LABEL, '$1');
  if (without !== unit) return capital(without);
  // "What it does not show: whether they pay." → "It does not show whether they pay."
  const read = READING_LABEL.exec(unit);
  if (read === null) return unit;
  const rest = unit.slice(read[0].length);
  const clause = /^(?:whether|if|how|what|who|that|why|when|where|which)\b/iu.test(rest);
  return clause ? `${read[1] ?? ''}${capital(read[2] ?? '')} ${rest}` : `${read[1] ?? ''}${capital(rest)}`;
}

/** A unit of the model's without a label of ours, or what leads into it from the prompt. */
export const contractUnit = (unit: string): string => withoutLabel(unit);

/**
 * What says nothing, or what it may not, whether the message was read or not: the prompt's own line for who decides, a bare
 * verdict ("Good price."), a verdict on terms a person decides, agreement with what the reply just denied.
 */
export function emptyOrRuled(unit: string, guidance: PromptGuidance, before: string): boolean {
  if (guidance.restate !== undefined) return false;
  if (guidance.referral !== null && echoesReferral(unit)) return true;
  if (guidance.kind === 'rehearsal' || guidance.kind === 'social' || quoteOpen(before)) return false;
  if (bareVerdict(unit)) return true;
  // Money for a part of it (turn.ts `seenBefore`).
  if (guidance.referral?.before === 'you talk terms' && rulesTerms(unit)) return true;
  return guidance.denies === true && agreesWith(unit);
}

/** A question that only asks how they will do the step just given, or for what nothing needs. */
const OF_THE_STEP =
  /^(?:(?:so|and|now|okay|ok)[, ]+)*(?:how (?:will|are|do|would|can) you (?:going to |plan(?:ning)? to |intend to |want to )?|what(?:['’]s| is| will be) (?:your|the)(?: \w+)? (?:next|first) (?:step|move)|who (?:will|are) you(?: going)?(?: to)? )/iu;
export function needlessQuestion(question: string, guidance: PromptGuidance): boolean {
  const { step } = guidance;
  if (step === null || question.trim() === '' || guidance.restate !== undefined || guidance.kind === 'recall')
    return false;
  if ((guidance.askBack ?? '').trim() !== '') return false;
  const said = stemsOf(question);
  const held = stemsOf(`${step.title}. ${step.doneWhen}. ${step.items.map((i) => i.do).join('. ')}`);
  return OF_THE_STEP.test(bare(question)) && sharedCount(said, held) >= 2;
}

/** Whether a unit only announces the step's parts ("Here's what to do:"). */
export function announcesSteps(unit: string): boolean {
  return ANNOUNCES_STEPS.test(bare(unit));
}

/** A line of a template written for them: its label, as the template gives it or as any five-line page does. */
const TEMPLATE_LABEL =
  /^\s*(?:[-*+•]\s+|\d{1,3}[.)]\s+)?[*_]{0,2}(who|problem|today(?: they)?|idea|my idea|why me|offer|price|customer|user|buyer)[*_]{0,2}\s*(?::|[—–])/iu;

export function isTemplateLine(unit: string, guidance: PromptGuidance | null | undefined): boolean {
  const text = unit.trim();
  if (TEMPLATE_LABEL.test(text)) return true;
  const label = /^(?:[-*+•]\s+|\d{1,3}[.)]\s+)?[*_]{0,2}([\p{L}][\p{L}\d '’/-]{1,40}?)[*_]{0,2}\s*:/u.exec(
    text,
  )?.[1];
  if (label === undefined) return false;
  const body = [guidance?.step?.template?.body ?? '', guidance?.ask?.block ?? ''].join('\n');
  return body.split('\n').some((l) =>
    l
      .replace(/^\s*(?:\d{1,3}[.)]|[-*])\s+/u, '')
      .toLowerCase()
      .startsWith(`${label.toLowerCase()}:`),
  );
}

const DEADLINE_CLAUSE = new RegExp(
  String.raw`,?\s+\b(by|before|no later than|due(?: on| by)?)\s+((?:the )?(?:end of )?(?:(?:this|next) )?(?:${WEEKDAY}|${MONTH}\.? \d{1,2}|today|tonight|tomorrow)(?:,? (?:the )?(?:${MONTH}\.? \d{1,2}|\d{1,2} ${MONTH})(?:st|nd|rd|th)?)?)(?=[.,;:!?)]|$|\s+(?:and|so|to|then)\b)`,
  'giu',
);

/** A sentence without the deadline the model gave: the one day of a reply is the step line's, and theirs. */
export function withoutDeadline(unit: string, guidance: PromptGuidance, today?: string | null): string {
  const { step } = guidance;
  if (step === null || QUESTION_END.test(unit.trim())) return unit;
  // What they asked back is told with the step's own day: another day of the notes for it is no one's now.
  const recalled = guidance.kind === 'recall' && namesStep(unit, step);
  if (
    !recalled &&
    /\byou (?:said|were|are|had|have|set|wanted|planned|agreed|promised|told)\b|\b(?:pitch|competition|meeting|exam|conference|class|event|demo day)\b/iu.test(
      unit,
    )
  )
    return unit;
  const own = ` ${(guidance.said ?? '').toLowerCase()} `;
  const due = [sayDay(step.dueOn, today), sayDay(step.dueOn)].flatMap((d) =>
    d === null ? [] : [d.toLowerCase()],
  );
  return unit.replace(DEADLINE_CLAUSE, (whole, _prep: string, day: string) => {
    const said = day.toLowerCase().replace(/^the /, '');
    // A day of theirs that is not the step's stays.
    if (!recalled && own.includes(said) && !due.some((d) => d === said || d.startsWith(`${said},`)))
      return whole;
    return '';
  });
}

// The answer -------------------------------------------------------------------------------------------------

/** The answer's first sentences: its pick, said whole, at most about `max` words. */
function pickOf(answer: string, max: number): string {
  const units = unitsOf(answer.replace(/\s+/g, ' ').trim());
  let out = '';
  for (const u of units) {
    if (out !== '' && wordsIn(out) + wordsIn(u.text) > max) break;
    out = out === '' ? u.text : `${out} ${u.text}`;
    if (wordsIn(out) >= 14) break;
  }
  return out;
}

/** The play's own steps, written after its answer when they are not the turn's step: the card has them. */
const HOW_LIST = /\s+How: 1\)[\s\S]*$/u;
/** What the server says of an answer on text: at most this many sentences and characters, whole. */
const WRITTEN = { sentences: 4, chars: 420 } as const;
/** A recall is the venture's record: said whole. */
const RECALLED = { text: { sentences: 8, chars: 700 }, voice: { sentences: 4, chars: 320 } } as const;
const SPOKEN_ANSWER_WORDS = 48;
/** A first sentence this short is only the verdict ("No, it is not enough."): it takes no sentence's place. */
const VERDICT_WORDS = 8;
/** A sentence that says what would prove it, what would make it fail, or where it stops. */
const WEIGHTY =
  /\b(?:what counts|weak(?:est)? (?:spot|point)|risks?|risky|prove[sn]?|proof|pass(?:es)?|fails?|unless|only (?:if|when)|until|never)\b/iu;
/** A sentence that leans on the one before it. */
const LEANS = /^(?:that|this|these|those|then|so|and|but|or|also|they|it) /iu;

/** Consecutive sentences within `limit`, the first always. */
function sentencesWithin(
  units: readonly TextUnit[],
  limit: { readonly sentences: number; readonly chars: number },
): string {
  let out = '';
  for (const u of units.slice(0, limit.sentences)) {
    const next = out === '' ? u.text : `${out} ${u.text}`;
    if (out !== '' && next.length > limit.chars) break;
    out = next;
  }
  return out;
}

/** The answer on a call: its pick and the sentence that says what would prove or sink it (else the next one). */
function spokenAnswer(units: readonly TextUnit[]): string {
  const first = units[0];
  if (first === undefined) return '';
  const head = wordsIn(first.text) < VERDICT_WORDS && units.length > 2 ? units.slice(0, 2) : [first];
  const rest = units.slice(head.length);
  const said = head.map((u) => u.text).join(' ');
  const fits = (u: TextUnit): boolean => wordsIn(said) + wordsIn(u.text) <= SPOKEN_ANSWER_WORDS;
  const second =
    rest.find((u) => WEIGHTY.test(u.text) && !LEANS.test(u.text) && fits(u)) ?? rest.slice(0, 1).find(fits);
  return second === undefined ? said : `${said} ${second.text}`;
}

/**
 * The answer as the server says it: on text its first sentences, whole (its pick, what proves it and what would make it
 * fail), at most four; on a call two.
 */
export function shortAnswer(ask: { readonly answer: string }, channel: TurnChannel, recall = false): string {
  const units = unitsOf(ask.answer.replace(HOW_LIST, '').replace(/\s+/g, ' ').trim());
  if (recall) return sentencesWithin(units, RECALLED[channel]);
  return channel === 'voice' ? spokenAnswer(units) : sentencesWithin(units, WRITTEN);
}

/** {@link shortAnswer} of a turn's ask ('' with none). */
function answerOf(guidance: PromptGuidance, channel: TurnChannel): string {
  return guidance.ask === null ? '' : shortAnswer(guidance.ask, channel, guidance.kind === 'recall');
}

/** Words that mean the same in an answer: who buys, what it costs, whom they talk to. */
const SAME_WORD: Readonly<Record<string, string>> = Object.fromEntries(
  (
    [
      ['buyer', 'customer client buyer user subscriber student person people visitor guest shop'],
      ['price', 'price cost charge fee pay spend amount money dollar'],
      ['talk', 'talk ask interview conversation speak question tell'],
      ['sell', 'sell sale offer order buy'],
      ['test', 'test try experiment pilot trial'],
      ['now', 'today now current currently'],
    ] as const
  ).flatMap(([to, words]) => words.split(' ').map((w) => [stemOf(w), to])),
);
const folded = (stems: ReadonlySet<string>): Set<string> => new Set([...stems].map((w) => SAME_WORD[w] ?? w));

/** Words of an answer long enough to be whole by itself, typed and on a call. */
const WHOLE_ANSWER = { text: 28, voice: 10 } as const;

/** Whether a reply uses a fact of theirs: two of its own words, or most of them. */
export function usesFact(reply: string, guidance: PromptGuidance): boolean {
  const said = stemsOf(reply);
  return [guidance.prior?.fact ?? '', ...(guidance.facts ?? [])].some((f) => {
    const fact = stemsOf(f);
    const shared = sharedCount(fact, said);
    return fact.size > 0 && shared >= 2 && shared >= fact.size * 0.34;
  });
}

function saysAnswer(
  reply: string,
  guidance: PromptGuidance,
  founderText: string | undefined,
  channel: TurnChannel,
): boolean {
  if (guidance.ask === null || (guidance.lead ?? null) !== null) return true;
  // Given in this conversation already: what is new of it stands.
  if ((guidance.more ?? []).length > 0) return true;
  const said = stemsOf(reply);
  const own = new Set([...stemsOf(founderText ?? ''), ...stemsOf(guidance.ask.title)]);
  const without = (text: string): Set<string> => {
    const all = stemsOf(text);
    const rest = new Set([...all].filter((w) => !own.has(w)));
    return rest.size >= 3 ? rest : all;
  };
  const answer = guidance.ask.answer.replace(HOW_LIST, '');
  const pick = without(pickOf(answer, 40));
  const whole = without(`${answer} ${guidance.ask.why}`);
  const inPick = sharedCount(pick, said);
  const inWhole = sharedCount(whole, said);
  if ((inPick >= 2 && inPick / pick.size >= 0.25) || (inWhole >= 4 && inWhole / whole.size >= 0.2))
    return true;
  // What a qualified person decides, and what is never shared, is said in the program's own words or not at all.
  if (guidance.referral !== null || guidance.ask.keeps !== undefined) return false;
  // A whole answer of its own that covers the pick in other words, or is about them, needs nothing of the program's after it.
  const words = read(reply)
    .filter((u) => u.kind === 'statement' || u.kind === 'block')
    .reduce((n, u) => n + wordsIn(u.text), 0);
  // A line to say or send is the thing itself.
  if (words >= WHOLE_ANSWER.voice && /[“"][^“”"]{16,}[”"]/u.test(reply)) return true;
  if (words < WHOLE_ANSWER[channel]) return false;
  if (usesFact(reply, guidance)) return true;
  const sameIn = sharedCount(folded(pick), folded(said));
  const sameWhole = sharedCount(folded(whole), folded(said));
  // Heard once, one short answer that is about the same thing is enough.
  if (channel === 'voice') return sameIn >= 1 || sameWhole >= 2;
  return (
    (sameIn >= 2 && sameIn / folded(pick).size >= 0.3) ||
    (sameWhole >= 4 && sameWhole / folded(whole).size >= 0.25)
  );
}

/** Whether the answer of the turn's ask must be said for the reply: not when it answers a match by meaning itself. */
function lacksAnswer(
  reply: string,
  guidance: PromptGuidance,
  founderText: string | undefined,
  channel: TurnChannel,
): boolean {
  if (guidance.ask === null || saysAnswer(reply, guidance, founderText, channel)) return false;
  if (guidance.matched !== 'semantic') return true;
  const units = read(reply);
  const answered = units.filter((u) => u.kind === 'statement' || u.kind === 'block');
  return !saysSomething(
    answered,
    units.some((u) => u.kind === 'deferral'),
  );
}

const CHANGES_DIRECTION = /\bpivot\w*|\bchang\w+ (?:of )?direction|\bswitch\w*|\breplac\w+|\binstead of\b/iu;
const STANDS_APART = /\bseparate\w*|\b(?:new|own|second|another) (?:workspace|venture)\b/iu;

/** What a new idea needs said that `reply` did not say: that it is another one, a fact of the venture's, both ways on. */
function newIdeaRest(reply: string, guidance: PromptGuidance): string {
  const idea = guidance.newIdea;
  if (idea === null) return '';
  const name = idea.ventureName.trim();
  const ways = CHANGES_DIRECTION.test(reply) && STANDS_APART.test(reply);
  if (!reply.toLowerCase().includes(name.toLowerCase())) return newIdeaLine(guidance);
  const fact = stripEnd(idea.fact ?? '');
  const factSaid = coverage(stemsOf(fact), stemsOf(reply)) >= 0.5;
  if (!ways && !factSaid) return newIdeaLine(guidance);
  return [
    factSaid || fact === '' ? '' : `That is not ${name}${whereFact(fact)}.`,
    ways
      ? ''
      : `Make it a change of direction for ${name}, or ask your program lead for a separate workspace.`,
  ]
    .filter((p) => p !== '')
    .join(' ');
}

/** A fact of the record as it goes into another sentence ("where one shop kept 900 tools on a clipboard"). */
function whereFact(fact: string | null): string {
  const said = stripEnd(fact ?? '');
  return said === '' ? '' : `, where ${lowerFirst(said)}`;
}

function newIdeaLine(guidance: PromptGuidance): string {
  const idea = guidance.newIdea;
  if (idea === null) return '';
  return `This is a different idea from ${idea.ventureName}${whereFact(idea.fact)}: make it a change of direction for ${idea.ventureName}, or ask your program lead for a separate workspace.`;
}

/** Generic words of who decides ("the university's office"): naming them alone names no one. */
const WHO_GENERIC = new Set(
  'university program programme campus school team person qualified local talk anything before sign decide office expert ask referral introduction start'
    .split(' ')
    .map(stemOf),
);

function saysWho(reply: string, referral: NonNullable<PromptGuidance['referral']>): boolean {
  const who = new Set([...stemsOf(referral.who)].filter((w) => !WHO_GENERIC.has(w)));
  const said = stemsOf(reply);
  return who.size === 0 || sharedCount(who, said) >= Math.min(2, who.size) || coverage(who, said) >= 0.4;
}

/** Whether a reply names the office or person alone ("UR Ventures"). */
function namesOffice(reply: string, referral: NonNullable<PromptGuidance['referral']>): boolean {
  const office = (referral.who.split(/[,;]/u)[0] ?? '').replace(/^(?:a|an|the|your) /iu, '').trim();
  return office !== '' && reply.toLowerCase().includes(office.toLowerCase());
}

/** A sentence that says to have something with them ("take the form", "see them with your notes"). */
const CARRIES =
  /\b(?:bring(?:ing)?|tak(?:e|ing)|carry|with|show(?:ing)?|hand(?:ing)?|send(?:ing)?|attach|have (?:ready|on hand))\b/iu;

function saysBring(reply: string, referral: NonNullable<PromptGuidance['referral']>): boolean {
  const bring = stemsOf(referral.bring);
  if (bring.size === 0 || coverage(bring, stemsOf(reply)) >= 0.6) return true;
  return unitsOf(reply).some((u) => {
    if (!CARRIES.test(u.text)) return false;
    const shared = sharedCount(bring, stemsOf(u.text));
    return shared >= Math.min(2, bring.size) && shared / bring.size >= 0.2;
  });
}

/** The first items of a list, as a call says them: whole clauses, at most about `max` words. */
function clipped(text: string, max: number): string {
  const whole = stripEnd(text);
  if (wordsIn(whole) <= max) return whole;
  const parts = whole.split(/(?:,|;)\s+/u);
  let out = parts[0] ?? whole;
  for (const part of parts.slice(1)) {
    if (wordsIn(`${out} ${part}`) > max) break;
    out = `${out}, ${part}`;
  }
  return out.replace(/,\s+(?:and|or)$/iu, '');
}

const SPOKEN_WHO_WORDS = 16;
const SPOKEN_BRING_WORDS = 14;

/** Who decides and what to bring: what of it `reply` did not say ('' when it said both). */
export function referralRest(reply: string, guidance: PromptGuidance, channel: TurnChannel): string {
  const { referral } = guidance;
  if (referral === null) return '';
  const voice = channel === 'voice';
  const who = voice ? clipped(referral.who, SPOKEN_WHO_WORDS) : stripEnd(referral.who);
  const bring = lowerFirst(voice ? clipped(referral.bring, SPOKEN_BRING_WORDS) : stripEnd(referral.bring));
  const said = saysWho(reply, referral) || (referral.told === true && namesOffice(reply, referral));
  const brought = bring === '' || referral.told === true || saysBring(reply, referral);
  // "Bring them who offered what" is told, not brought.
  const verb = /^(?:who|what|how|when|why) /iu.test(bring) ? 'Tell' : 'Bring';
  if (!said) return `${talkTo(who, referral.before ?? '')}${brought ? '' : ` ${verb} them ${bring}.`}`;
  return brought ? '' : `${verb} ${officeOf(referral)} ${bring}.`;
}

/** The same where the opening named who decides: how to reach them, and what to bring, unless the reply said it. */
export function heldRest(body: string, guidance: PromptGuidance, channel: TurnChannel): string {
  const { referral } = guidance;
  if (referral === null || referral.told === true) return '';
  const voice = channel === 'voice';
  const said = norm(body);
  const how = referral.who
    .split(/;\s+/u)
    .slice(1)
    .map((h) => `${capital(stripEnd(h))}.`)
    .filter((h) => !said.includes(norm(h)));
  const bring = lowerFirst(voice ? clipped(referral.bring, SPOKEN_BRING_WORDS) : stripEnd(referral.bring));
  const brought = bring === '' || coverage(stemsOf(bring), stemsOf(body)) >= 0.5;
  const verb = /^(?:who|what|how|when|why) /iu.test(bring) ? 'Tell' : 'Bring';
  return [...(voice ? how.slice(0, 1) : how), brought ? '' : `${verb} ${officeOf(referral)} ${bring}.`]
    .filter((p) => p !== '')
    .join(' ');
}

/**
 * Who decides, as a person says it, before what, and how to reach them ("Talk to a business lawyer before you sign anything.
 * Ask the program lead for a referral.").
 */
function talkTo(who: string, before: string): string {
  const [first = who, ...rest] = who.split(/;\s+/u);
  const own = /,? (before .+)$/iu.exec(first);
  const person = (own === null ? first : first.slice(0, own.index)).replace(/^(?:An?|The|Your)(?= )/u, (w) =>
    w.toLowerCase(),
  );
  const when = own?.[1] ?? (before === '' ? 'before you decide' : `before ${before}`);
  const how = rest.map((r) => ` ${capital(stripEnd(r))}.`).join('');
  return `Talk to ${person}${person.includes(', ') ? ',' : ''} ${when}.${how}`;
}

/** The office or person alone, as it goes after "Bring" ("UR Ventures", "the lawyer"). */
function officeOf(referral: NonNullable<PromptGuidance['referral']>): string {
  const office = (referral.who.split(/[,;(]/u)[0] ?? referral.who).trim();
  const named = office.replace(/^(?:an?|the|your) /iu, '');
  return /^(?:an?|your) /iu.test(office)
    ? `the ${(named.split(' who ')[0] ?? named).split(' ').slice(-2).join(' ')}`
    : lowerFirst(office);
}

/** "Bring a one-page timeline…" of the model's own, said to the one who decides. */
export function bringWho(unit: string, guidance: PromptGuidance, before = ''): string {
  const { referral } = guidance;
  if (referral === null) return unit;
  const m = /^(\s*)Bring (?=(?:an?|the|your|any|all|one|both|every|what|who|\d)\b)([^\n]*)$/u.exec(unit);
  const office = officeOf(referral);
  if (
    m === null ||
    namesOffice(unit, referral) ||
    unit.toLowerCase().includes(office.toLowerCase()) ||
    /\bto (?:the|your|an?|them|him|her|that)\b/iu.test(unit)
  )
    return unit;
  // Named in the sentence before it.
  const last = unitsOf(before).at(-1)?.text ?? '';
  const them = namesOffice(last, referral) || last.toLowerCase().includes(office.toLowerCase());
  return `${m[1] ?? ''}Bring ${them ? 'them' : office} ${m[2] ?? ''}`;
}

/**
 * A text of the play's with the play's own key: `ask.evidenceKeys` starts with it, and what comes after it there (the
 * program's notes of the same subject) is the model's to cite, never the server's.
 */
function cited(text: string, guidance: PromptGuidance, channel: TurnChannel): string {
  const key = playKey(guidance);
  return channel === 'voice' || key === null ? text : withKey(text, key);
}

/** `text` with `key` on its last sentence that says something of its own ("Sign nothing yet. I am not one." → the first). */
export function withKey(text: string, key: string): string {
  const units = unitsOf(text);
  const at = units.findLastIndex((u) => stemsOf(u.text).size >= 4);
  const unit = units[at < 0 ? units.length - 1 : at];
  if (unit === undefined) return text;
  const end = unit.start + unit.raw.trimEnd().length;
  const head = text.slice(0, end);
  const stop = /[.!?…]+["'”’)\]]*$/u.exec(head)?.[0] ?? '';
  return `${head.slice(0, head.length - stop.length).trimEnd()} [${key}]${stop}${text.slice(end)}`;
}

/** The evidence key of the play that answers the ask. */
export function playKey(guidance: PromptGuidance): string | null {
  return guidance.ask?.evidenceKeys.find((k) => /^E\d+$/.test(k)) ?? null;
}

/** What the server says first on this turn ('' when the model's answer opens the reply). */
export function leadText(guidance: PromptGuidance | null | undefined, channel: TurnChannel): string {
  if (!contractApplies(guidance) && !wholeApplies(guidance)) return '';
  const lead = guidance.lead ?? null;
  if (lead === null) return '';
  return (channel === 'voice' ? lead.voice.replace(/\s+/g, ' ') : lead.text).trim();
}

/** The step's parts: a numbered list on text, a spoken sequence on a call. */
export function subSteps(step: NonNullable<PromptGuidance['step']>, channel: TurnChannel): string {
  if (channel === 'voice') {
    const [first, second] = step.items;
    if (first === undefined) return '';
    const then = second === undefined ? '' : `, then ${lowerFirst(stripEnd(second.do))}`;
    return `First ${lowerFirst(stripEnd(first.do))}${then}.`;
  }
  return step.items
    .map((item, i) => {
      const how = stripEnd(item.how);
      const time = item.minutes === null ? '' : ` (${String(item.minutes)} min)`;
      return `${String(i + 1)}. ${stripEnd(item.do)}${time}${how === '' ? '.' : `: ${lowerFirst(how)}.`}`;
    })
    .join('\n');
}

/** Most pieces of what was not said yet that stand for an answer the conversation holds. */
const MOST_MORE = 3;

/** The answer as the server gives it: its lead, the program's answer, or where they stand and the step's parts. */
export function composedAnswer(guidance: PromptGuidance, channel: TurnChannel): string {
  const voice = channel === 'voice';
  const lead = leadText(guidance, channel);
  if (lead !== '') return lead;
  const { ask, step, stage } = guidance;
  if (guidance.restate !== undefined) {
    const said = unitsOf(guidance.restate.reply).filter(
      (u) => !isListUnit(u.text) && !QUESTION_END.test(u.text),
    );
    const short = said
      .slice(0, 2)
      .map((u) => u.text)
      .join(' ');
    if (short !== '') return `In short: ${short}`;
  }
  if (guidance.reading !== undefined) {
    // The claims the answer was to make.
    if (guidance.reading.inOrder && !voice) return inOrder(guidance.reading.points);
    const given = (voice ? guidance.fallback?.voice : guidance.fallback?.text) ?? '';
    if (given.trim() !== '') return given;
  }
  const more = guidance.more ?? [];
  if (more.length > 0) return voice ? (more[0] ?? '') : more.slice(0, MOST_MORE).join(' ');
  if (ask !== null) {
    if (voice) return answerOf(guidance, channel);
    return [
      cited(ask.answer.trim(), guidance, channel),
      ask.block === undefined || ask.block.trim() === ''
        ? cited(ask.why.trim(), guidance, channel)
        : ask.block.trim(),
    ]
      .filter((p) => p !== '')
      .join('\n\n');
  }
  const given = (voice ? guidance.fallback?.voice : guidance.fallback?.text) ?? '';
  if (given.trim() !== '') return given;
  if (step === null || step.items.length === 0)
    return `You are at ${lowerFirst(stage.title)}, stage ${String(stage.number)} of ${String(stage.count)}.`;
  const parts = subSteps(step, channel);
  return voice ? parts : `Here is how the step goes:\n\n${parts}`;
}

/** The whole reply the path alone gives: the answer, who decides and the step (no model). */
export function composeFromGuidance(
  guidance: PromptGuidance,
  channel: TurnChannel,
  today?: string | null,
): string {
  const gap = channel === 'voice' ? ' ' : '\n\n';
  const answer = composedAnswer(guidance, channel);
  return [
    answer,
    newIdeaRest(answer, guidance),
    referralRest('', guidance, channel),
    sayStep(guidance, channel, today),
    guidance.askBack ?? '',
  ]
    .filter((p) => p.trim() !== '')
    .join(gap);
}

// The check --------------------------------------------------------------------------------------------------

/** Words of help a reply needs to be more than questions. */
const MIN_HELP_WORDS = 6;

/** Words of answer a reply needs: with fewer, the server gives the answer (a step line alone is never a reply). */
export const MIN_ANSWER_WORDS = 12;
/** The same on a call, where an answer is one short sentence. */
const MIN_SPOKEN_ANSWER_WORDS = 8;

/** Whether the reply answers with substance of its own (a match by meaning may be about something else). */
function saysSomething(answered: readonly ReadUnit[], deferred: boolean): boolean {
  const said = answered.reduce((n, u) => n + wordsIn(u.text), 0);
  return said >= (deferred ? 2 : 1) * MIN_ANSWER_WORDS;
}

const norm = (text: string): string =>
  text
    .replace(/\[\s*E\d+(?:\s*[,;]\s*E\d+)*\s*\]/gi, '')
    .replace(/[*_]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** `text` without `part` at its start (spacing and emphasis apart); null when it does not start with it. */
export function withoutStart(text: string, part: string): string | null {
  const want = norm(part);
  if (want === '') return null;
  // Word by word, so spacing and emphasis inside never matter.
  let seen = '';
  const step = /\S+\s*/gy;
  step.lastIndex = /^\s*/.exec(text)?.[0].length ?? 0;
  for (let m = step.exec(text); m !== null; m = step.exec(text)) {
    seen = norm(`${seen} ${m[0]}`);
    if (seen === want) return text.slice(m.index + m[0].length);
    if (!want.startsWith(seen)) return null;
  }
  return null;
}

interface Parts {
  /** The model's own part of the reply. */
  readonly body: string;
  /** The answer the server wrote opens it. */
  readonly answerFirst: boolean;
  readonly hadLead: boolean;
  readonly hadStep: boolean;
  /** The answer the server wrote already is in it. */
  readonly hadAnswer: boolean;
}

/** A reply without what the server wrote around it (it may have been written already: the check is idempotent). */
function partsOf(
  reply: string,
  guidance: PromptGuidance,
  channel: TurnChannel,
  today?: string | null,
): Parts {
  let body = reply.trim();
  const lead = leadText(guidance, channel);
  const rest = withoutStart(body, lead);
  const hadLead = lead !== '' && rest !== null;
  if (rest !== null && hadLead) body = rest.trim();
  const askBack = (guidance.askBack ?? '').trim();
  if (askBack !== '' && body.endsWith(askBack)) body = body.slice(0, -askBack.length).trimEnd();
  const line = sayStep(guidance, channel, today);
  let hadStep = false;
  if (line !== '') {
    const at = body.lastIndexOf(line);
    if (at >= 0) {
      hadStep = true;
      body = `${body.slice(0, at).trimEnd()}${body.slice(at + line.length)}`.trim();
    }
  }
  const composed = composedAnswer(guidance, channel);
  const at = lead === '' && composed !== '' ? body.indexOf(composed) : -1;
  if (at >= 0)
    body = `${body.slice(0, at).trimEnd()}\n\n${body.slice(at + composed.length).trimStart()}`.trim();
  return { body, hadLead, hadStep, hadAnswer: at >= 0, answerFirst: at === 0 };
}

interface Cleaned {
  readonly wroteTemplate: boolean;
  /** The model's own help, in its order, without step talk, deferrals, flattery and the questions left out. */
  readonly text: string;
  readonly question: string;
  readonly findings: ReadonlySet<ReplyContractFinding>;
  readonly answerWords: number;
}

/** The model's part of a reply as the contract lets it stand. */
function clean(
  body: string,
  guidance: PromptGuidance,
  channel: TurnChannel,
  today?: string | null,
  founderText = '',
): Cleaned {
  const source = withoutFences(body);
  const units = read(source);
  const findings = new Set<ReplyContractFinding>();
  const talk = new StepTalk(guidance);
  const kept: { raw: string; unit: ReadUnit; index: number }[] = [];
  const owned = guidance.step !== null;
  const leadSaid = leadText(guidance, channel);
  const lead = stemsOf(leadSaid);
  const founder = stemsOf(founderText);
  const questions = units.flatMap((u, i) => (u.kind === 'question' ? [i] : []));
  const asking = stacked(units, questions).at(-1) ?? [];
  if (stacked(units, questions).length > 1) findings.add('stacked_questions');
  const trailing = asking.length > 0 && asking.at(-1) === units.length - 1;
  const question = trailing ? asking.map((i) => units[i]?.text ?? '').join(' ') : '';
  const mayAsk =
    question !== '' &&
    !PLAN_QUESTION.test(bare(question)) &&
    !DEFERRAL_LEAD.test(bare(question)) &&
    !asking.some((i) => REQUEST.test(bare(units[i]?.text ?? ''))) &&
    !asking.some((i) => isListUnit(units[i]?.text ?? ''));
  let broke = false;
  /** An item of a list was left out. */
  const left = { item: false };
  const leave = (u: ReadUnit, finding: ReplyContractFinding): void => {
    findings.add(finding);
    if (PARAGRAPH.test(u.raw)) broke = true;
    if (isListUnit(u.raw)) left.item = true;
  };
  let leaned = false;
  units.forEach((u, i) => {
    if (leaned && leansBack(u.raw) && !isServerText(u.text, guidance, channel)) {
      leave(u, 'step_talk');
      return;
    }
    const inDropped = leaned;
    leaned = false;
    if (owned && talk.drops(u.raw) && !(!inDropped && isServerText(u.text, guidance, channel))) {
      leave(u, 'step_talk');
      leaned = true;
      return;
    }
    if (u.kind === 'deferral' || u.kind === 'flattery') {
      leave(u, u.kind);
      return;
    }
    if (u.kind === 'question') {
      const text = bare(u.text);
      if (DEFERRAL_LEAD.test(text) || PLAN_QUESTION.test(text)) findings.add('deferral');
      if (!asking.includes(i) || trailing) return; // left out, or said last
    }
    let raw = owned ? contractUnit(u.raw) : u.raw;
    if (raw === '') return;
    if (u.kind === 'statement') {
      const without = withoutLead(raw);
      if (without !== null) {
        findings.add(FLATTERY_LEAD.test(bare(u.text)) ? 'flattery' : 'deferral');
        raw = without;
      }
    }
    if (owned) {
      const undated = withoutDeadline(raw, guidance, today);
      if (undated !== raw) {
        findings.add('wrong_date');
        raw = undated;
        if (wordsIn(raw) < 3) return;
      }
    }
    // Who decides, said a second time.
    if (
      repeatsReferral(raw, kept.map((k) => k.raw).join(''), guidance) &&
      // How to reach them, in the server's own words, goes with who it is.
      !norm(referralRest('', guidance, channel)).includes(norm(raw))
    ) {
      leave(u, 'missing_referral');
      return;
    }
    if (!isServerText(u.text, guidance, channel) && emptyOrRuled(raw, guidance, source.slice(0, u.start))) {
      leave(u, 'step_talk');
      leaned = bareVerdict(raw) ? false : true;
      return;
    }
    // Said above in this reply, a blank nobody filled, or the prompt's own label.
    if (
      !isProtectedLine(u.text) &&
      (saysAgain(raw, saidSentences(kept.map((k) => k.raw).join(''))) ||
        saysNothing(raw, guidance) ||
        echoesThem(raw, founderText) ||
        danglingLine(u.raw, kept.map((k) => k.raw).join(''), guidance))
    ) {
      leave(u, 'step_talk');
      leaned = true;
      return;
    }
    // What the server already said first, or a verdict on it.
    if (
      lead.size > 0 &&
      (repeatsLead(raw, lead) ||
        restates(raw, lead, founder) ||
        onlyVerdict(raw) ||
        saidInLead(raw, leadSaid) ||
        announcesLead(raw, leadSaid) ||
        refusesUnderLead(raw, lead) ||
        (!isProtectedLine(u.text) && readsAgain(raw, guidance, lead, founder)))
    ) {
      leave(u, 'step_talk');
      leaned = true;
      return;
    }
    if (rulesOnIt(raw, guidance)) {
      leave(u, 'missing_referral');
      return;
    }
    if (
      !isProtectedLine(u.text) &&
      meansNothing(raw, kept.length === 0 ? leadSaid : kept.map((k) => k.raw).join(''))
    ) {
      leave(u, 'step_talk');
      leaned = true;
      return;
    }
    raw = bringWho(raw, guidance, kept.map((k) => k.raw).join(''));
    if (
      channel === 'text' &&
      u.kind !== 'question' &&
      !isProtectedLine(u.text) &&
      overTyped(raw, wordsIn(kept.map((k) => k.raw).join('')), kept.map((k) => k.raw).join(''), guidance)
    ) {
      leave(u, 'step_talk');
      leaned = true;
      return;
    }
    if (kept.length === 0 && lead.size === 0) raw = withPick(raw, guidance, founderText);
    if (broke && kept.length > 0 && !/^\s*\n/.test(raw)) raw = `\n\n${raw.trimStart()}`;
    broke = false;
    kept.push({ raw, unit: u, index: i });
  });
  // "Here's what to do:" of a list that went.
  const shown = kept.filter((k) => {
    if (!/:[*_\s]*$/.test(k.unit.text)) return true;
    const next = units[k.index + 1];
    if (next === undefined) return !announcesSteps(k.unit.text);
    const after = kept.find((x) => x.index > k.index);
    return after !== undefined && (after.index === k.index + 1 || isListUnit(after.raw));
  });
  // Only questions, however they are put: the last of them is asked after the help.
  const onlyAsks =
    shown.length > 0 && shown.every((k) => k.unit.kind === 'question' || k.unit.kind === 'asked');
  if (onlyAsks && question === '') {
    const last = shown.at(-1)?.unit.text ?? '';
    const asks = !isListUnit(last) && !REQUEST.test(bare(last)) && !PLAN_QUESTION.test(bare(last));
    return {
      text: '',
      question: asks ? last : '',
      findings,
      answerWords: 0,
      wroteTemplate: talk.wroteTemplate,
    };
  }
  // A question everything after it was left out of is asked last, as any other.
  const ended = shown.at(-1)?.unit.kind === 'question' ? shown.pop() : undefined;
  const whole = shown.map((k) => k.raw).join('');
  const text = tidy(left.item ? renumbered(whole) : whole);
  const last = ended === undefined ? (mayAsk ? question : '') : ended.raw.trim();
  const answerWords = shown
    .filter((k) => k.unit.kind === 'statement' || k.unit.kind === 'block')
    .reduce((n, k) => n + wordsIn(k.raw), 0);
  return {
    text,
    question:
      pointsNowhere(last, `${text} ${leadSaid} ${guidance.said ?? ''}`) ||
      danglingAsk(last, guidance) ||
      needlessQuestion(last, guidance)
        ? ''
        : last,
    findings,
    answerWords,
    wroteTemplate: talk.wroteTemplate,
  };
}

/** Whether a unit is text of the server's own (the program's answer, who decides, what it builds on). */
export function isServerText(unit: string, guidance: PromptGuidance, channel: TurnChannel): boolean {
  const own = norm(unit);
  if (own.length < 8) return false;
  const { ask, prior, askBack } = guidance;
  return [
    ask === null ? '' : `${ask.answer} ${ask.why} ${ask.block ?? ''}`,
    ...(guidance.more ?? []),
    ...(guidance.parts ?? []).flatMap((part) => [part.text, part.voice]),
    ...(guidance.limits ?? []).map((l) => l.text),
    prior?.sentence ?? '',
    prior?.spoken ?? '',
    prior?.gap ?? '',
    ask?.keeps ?? '',
    askBack ?? '',
    referralRest('', guidance, channel),
    newIdeaLine(guidance),
  ].some((t) => norm(t).includes(own));
}

const HAS_A_VERB =
  /\b(?:is|are|was|will|can|decides?|knows?|says?|tells?|ask|see|talk|bring|book|call|contact|email|go|take|answers?|helps?|has|have|owns?)\b/iu;

/** Whether a unit only says again who decides, or what to bring, when the reply said both. */
export function repeatsReferral(unit: string, before: string, guidance: PromptGuidance): boolean {
  const { referral } = guidance;
  if (referral === null || before.trim() === '') return false;
  if (!saysWho(before, referral) || !saysBring(before, referral)) return false;
  const own = stemsOf(
    `${referral.who} ${referral.bring} bring take decide decides question answer qualified person one this that`,
  );
  const said = stemsOf(unit);
  // Who it is, with nothing said of them ("UR Ventures, the technology transfer office.").
  if (said.size >= 2 && coverage(said, stemsOf(referral.who)) === 1 && !HAS_A_VERB.test(unit)) return true;
  return (
    said.size >= 2 &&
    coverage(said, own) >= 0.8 &&
    (saysWho(unit, referral) || coverage(stemsOf(referral.bring), said) >= 0.4)
  );
}

const PICKS_YES_NO =
  /\b(?:yes|no|nope|yep|not|never|partly|neither|only|both|cannot|can['’]t|don['’]t|doesn['’]t|isn['’]t|won['’]t|shouldn['’]t|aren['’]t)\b/iu;

/** Whether a reply's first sentence picks, when they asked to have a choice made of options they named. */
export function picks(reply: string, guidance: PromptGuidance): boolean {
  const choice = guidance.choice ?? null;
  if (choice === null || choice.options.length === 0 || (guidance.lead ?? null) !== null) return true;
  const first = read(reply).find((u) => u.kind === 'statement' || u.kind === 'block')?.text ?? '';
  const text = bare(first);
  if (choice.kind === 'yes_no') return PICKS_YES_NO.test(text);
  if (/\b(?:both|neither|in this order)\b/iu.test(text)) return true;
  const said = stemsOf(text);
  return choice.options.some((o) => {
    const others = new Set(choice.options.filter((x) => x !== o).flatMap((x) => [...stemsOf(x)]));
    const own = [...stemsOf(o)].filter((w) => !others.has(w));
    return (own.length > 0 ? own : [...stemsOf(o)]).some((w) => said.has(w));
  });
}

/** A ruling on what a qualified person decides ("File a provisional now.", "Yes, sign it.", "You own it."). */
const RULES_ON_IT =
  /^(?:(?:yes|no|okay|ok|so|well|honestly|my (?:read|view|take))[,.:]? )*(?:you (?:should|can|could|may)(?: just| now| safely)? |go ahead and |i(?:['’]d| would) |just )?(?:(?:file|submit) (?:a|an|the|it|for|now|that)\b|sign (?:it|the|that|now|off)\b|(?:you|we) own (?:it|the|all|your)\b|it(?:['’]s| is) yours\b|the (?:lab|university|school|advis[eo]r) (?:owns|does not own|doesn['’]t own)\b|take the (?:money|deal|check|cheque|offer)\b|accept (?:it|the)\b|give (?:him|her|them|the relative|your \w+) \d)/iu;

/** Who owns it, said of their own case ("so it looks like the lab owns it", "your work belongs to the lab"). */
const RULES_OWNERSHIP =
  /\b(?:points?|pointing|means?|suggests?|shows?|looks like|likely|probably|most likely|so)\b[^.!?]{0,60}\b(?:the )?(?:university|lab|school|u of r|advis[eo]r|you|they)\b(?:['’]s)? (?:likely |probably |most likely |almost certainly |already |would )?(?:own(?:s|ing|ed|ership)?)\b|\b(?:your|the|this) (?:patch|work|invention|idea|coating|device|result|research|data|code|project|venture)\b[^.!?]{0,30}\b(?:belongs to|is owned by|is (?:the )?(?:university|lab|school)['’]s)\b|\b(?:default )?ownership (?:is|lies|rests|sits|stays|falls) (?:\w+ )?(?:with|to) (?:the )?(?:university|lab|school|advis[eo]r|you)\b/iu;
const OWNERSHIP_OPEN =
  /\b(?:if|whether|who|may|might|could|can|when|depends?|decides?|ask|cannot|can['’]t|not|policy|until|unless)\b/iu;

/** Whether a text rules on what a person decides (file it, sign it, who owns it), whatever the turn's referral is. */
export function rulesForAPerson(text: string): boolean {
  const said = bare(text);
  if (RULES_ON_IT.test(said)) return true;
  const ruled = RULES_OWNERSHIP.exec(said);
  return ruled !== null && !OWNERSHIP_OPEN.test(said.slice(0, ruled.index + ruled[0].length));
}

/** What talking of it does to a patent: for the office that decides, and nobody else. */
const OF_PATENTS = /\b(?:ur ventures|patent|technology transfer)\b/iu;
const RULES_DISCLOSURE =
  /^yes\b[^.!?]{0,80}\b(?:talk|tell|show|share|speak|demo|present|pitch|result|method)\b|\b(?:won['’]?t|will not|does(?:n['’]?t| not)|should(?:n['’]?t| not)|can(?:no|['’])t|without) (?:hurt|harm|affect|risk|endanger|damage|ruin|jeopardi[sz]|threaten|weaken|put)\w*\b[^.!?]{0,40}\b(?:patent|rights?|invention|protection|filing|claim)\b|\b(?:keeps?|stays?|leaves?|remains?|is|are) (?:(?:the|your|it) )?(?:invention |patent |rights |idea )?(?:safe|protected|intact)\b|\bit(?:['’]s| is) (?:safe|fine|okay|ok) to (?:talk|tell|show|share|speak|present)\b/iu;

/** Whether a unit decides what the turn's referral decides: never the coach's to say. */
export function rulesOnIt(unit: string, guidance: PromptGuidance): boolean {
  if (guidance.referral === null) return false;
  const text = bare(unit);
  if (OF_PATENTS.test(guidance.referral.who) && RULES_DISCLOSURE.test(text)) return true;
  if (guidance.ask !== null && RULES_ON_IT.test(text)) return true;
  const ruled = RULES_OWNERSHIP.exec(text);
  return ruled !== null && !OWNERSHIP_OPEN.test(text.slice(0, ruled.index + ruled[0].length));
}

const numbersOf = (text: string): string[] => text.match(/\d[\d,.]*\d|\d/gu) ?? [];
/** A sentence that says nothing where it stands: what a figure comes from under no figure, a change told back, so many things with none named. */
export function meansNothing(unit: string, before: string): boolean {
  const text = bare(unit);
  if (
    /^(?:two|three|four|five|\d) (?:\w+ )?things (?:change|matter|stay|count|decide)\b[^:]*\.$/iu.test(text)
  )
    return true;
  if (
    /^(?:so,? |and,? |then,? )?you(?:['’]re| are) (?:now )?(?:focusing|shifting|moving|solving|going|working|pivoting|switching)\b[^.!?]*\binstead\.$/iu.test(
      text,
    )
  )
    return true;
  if (!/^(?:that|this|it) comes from\b/iu.test(text)) return false;
  const last =
    before
      .trim()
      .split(/(?<=[.!?])\s+/u)
      .at(-1) ?? '';
  const own = numbersOf(text);
  return numbersOf(last).every((n) => own.includes(n));
}

/** "Is a pilot the same as a sale?" */
const SAME_AS =
  /\bis (?:an? |the |my |our |that |this |it )?[^?]{0,40}\b(?:the same (?:as|thing)|as good as|enough to be|really an?|the equivalent of)\b[^?]*\?/iu;
const SAYS_NOT =
  /\bnot (?:an?|the|quite|really|yet|exactly|the same)\b|\bis(?:n['’]t| not)\b|\bdiffer\w*\b|\brather than\b/iu;

/** A yes-or-no question about two things being one, answered "A pilot is not yet one": with the No it says. */
export function withPick(unit: string, guidance: PromptGuidance, founderText: string): string {
  if (guidance.choice?.kind !== 'yes_no' || !SAME_AS.test(founderText)) return unit;
  const text = bare(unit);
  if (/^(?:yes|no|nope|not|partly|only|almost)\b/iu.test(text) || !SAYS_NOT.test(text)) return unit;
  return unit.replace(/^(\s*[*_]*)/u, '$1No. ');
}

/** A reply's first sentence that leans on one that went ("It does not prove that they pay"): what it is said of. */
export function anchored(unit: string): string {
  return unit.replace(
    /^(\s*)(?:but |and |so )?(?:it|this|that)(?= (?:does(?:n['’]t| not)|is(?:n['’]t| not)|did(?:n['’]t| not)|only|also|still) )/iu,
    '$1What you told me',
  );
}

/** A blank of a formula nobody filled ("If X or more agree"), and the label of what the prompt asks for. */
const PLACEHOLDER =
  /(?<![\p{L}\d'’])(?:[XYN]) (?:or more|of (?:them|the|\d|your)|people|customers?|buyers?|strangers?|percent|dollars?|out of|yeses)\b|\$[XYN]\b|\b(?:at least|more than|fewer than|under|over) [XYN]\b/u;
const PROMPT_LABEL =
  /^what (?:you|they) (?:found|told me|reported)(?:,? in (?:your|their) (?:own )?words)?\s*:/iu;
/** "Here it is to fill in.", "Here's the template:" of one the server gives, or gave. */
const ANNOUNCES_TEMPLATE =
  /^(?:(?:so|okay|ok|and|now)[, ]+)*here (?:it )?(?:is|are)(?: (?:it|the|a|your|this))*(?: (?:one-page|simple|short|quick|filled|blank))*(?: (?:template|page|sheet|canvas|table|one-?pager|version|idea))?(?: (?:to|for you to) (?:fill(?: in| out)?|use|copy|start with|complete))?[.:!]*$|^here(?:['’]s| is) (?:the|your|a) (?:one-?page(?:r)?|page|canvas|template)\b[^.!?]{0,60}[.:!]*$/iu;

const TEMPLATE_BELOW =
  /^(?:use|copy|send|try|follow|take|fill in|start (?:with|from)) (?:the|this|that|your) [^.!?:]{0,40}\b(?:script|template|message|draft|note|email|card|page|questions) below\b/iu;

/** Whether a unit holds nothing to say: a blank, a label of ours, the announcement of a template that is the server's. */
export function saysNothing(unit: string, guidance: PromptGuidance): boolean {
  const text = bare(unit);
  if (PLACEHOLDER.test(text) || PROMPT_LABEL.test(text)) return true;
  // "Use the short script below": there is none below, the card has it.
  if (guidance.template === 'shown' && TEMPLATE_BELOW.test(text)) return true;
  return guidance.template !== undefined && guidance.restate === undefined && ANNOUNCES_TEMPLATE.test(text);
}

/** Whether a unit's words stand in what the server said first, one after the other ("No buzzwords."). */
export function saidInLead(unit: string, lead: string): boolean {
  if (lead === '' || wordsIn(unit) < 2) return false;
  const own = plainWords(unit.replace(/^\s*(?:[-*+•]|\d{1,3}[.)])\s+/u, ''));
  return own.trim() !== '' && plainWords(lead).includes(own);
}

/** "Here is your note, the [brackets] are for you…", under the message itself. */
export function announcesLead(unit: string, lead: string): boolean {
  return (
    lead.includes('[') &&
    /\[?\bbrackets\b\]?|^here it is to fill in\b|^here(?:['’]s| is) (?:the|a|your) (?:\w+ )?(?:message|draft|text|template|note|email)\b/iu.test(
      bare(unit),
    )
  );
}

/** Whether a question is about something nothing of the conversation's says ("those talks", of a sentence that went). */
export function pointsNowhere(question: string, said: string): boolean {
  const m = /\b(?:those|these) (?:\p{L}+ )??(\p{L}{3,}s)\b/iu.exec(question);
  return m?.[1] !== undefined && !stemsOf(said).has(stemOf(m[1].toLowerCase()));
}

/** Whether a unit only says what the lead said. */
export function repeatsLead(unit: string, lead: ReadonlySet<string>): boolean {
  const said = stemsOf(unit);
  if (said.size >= 3 && coverage(said, lead) >= 0.85) return true;
  // The same figures again, in other words ("so the contribution is $3.50").
  const figures = [...said].filter((w) => /^\d/.test(w));
  return (
    figures.length >= 1 &&
    figures.every((f) => lead.has(f)) &&
    coverage(said, lead) >= (figures.length >= 2 ? 0.4 : 0.65) &&
    !isListUnit(unit)
  );
}

/** Whether a statement says nothing but what they just told, under the server's lead (a denial of it says something). */
export function restates(unit: string, lead: ReadonlySet<string>, founder: ReadonlySet<string>): boolean {
  if (lead.size === 0 || founder.size === 0 || isListUnit(unit) || /\?["'”’)\]*_]*\s*$/u.test(unit))
    return false;
  if (/\b(?:not|no|never|none|nobody|nothing|only|\w+n['’]t)\b/iu.test(unit)) return false;
  const said = stemsOf(unit.replace(/,? which (?:makes sense|is fair|is understandable)\b/iu, ''));
  said.delete('say');
  if (said.size < 3) return false;
  let held = 0;
  for (const w of said) if (lead.has(w) || founder.has(w)) held += 1;
  return held / said.size >= 0.95 && sharedCount(said, founder) / said.size >= 0.7;
}

/** A verdict on what they said that says nothing of it ("Got it.", "That's a strong signal.", "That's useful news."). */
export function onlyVerdict(unit: string): boolean {
  const t = bare(unit);
  return (
    FILLER.test(t) ||
    /^(?:yes|no|yep|nope|nah|yeah|neither|not yet|not really|continue|keep going|go on|stop|pause|carry on|don['’]t stop|it depends)[.!]*$/iu.test(
      t,
    ) ||
    /^i (?:get it|see|hear you|understand)\b[^.!?]{0,120}[.!]*$/iu.test(t) ||
    // "Hello Rae, good to see you are further along.", "Let's put some order in it…", "It's fine to be early."
    /^(?:(?:hi|hello|hey|okay|ok|alright|great)\b,? ?(?:\p{Lu}\p{L}+)?[,!.—–-]* ?)?(?:it['’]s |i['’]m )?(?:so |really )?(?:great|good|glad|nice|lovely|happy|wonderful) to (?:hear|see|know|have)\b[^.!?]{0,90}[.!]*$/iu.test(
      t,
    ) ||
    /^(?:(?:okay|ok|alright|great|right|so|now)[,. ]+)*let['’]?s (?:get|do|dive|go|make|put|focus)\b[^.!?]{0,60}\b(?:done|started|going|organi[sz]ed|to it|into it|right now|together)\b[^.!?]{0,60}[.!]*$/iu.test(
      t,
    ) ||
    /^(?:it|that)(?:['’]s| is) (?:totally |completely |perfectly )?(?:fine|okay|ok|normal) (?:to|that|if)\b[^.!?]{0,60}[.!]*$/iu.test(
      t,
    ) ||
    // A greeting under what already opened, or the stage it said.
    /^(?:(?:hi|hello|hey)\b[^.!?]{0,30}|(?:good|great|nice|lovely) to (?:see|hear from) you(?: again)?|welcome back)[,!.\s]*(?:\p{L}+)?[.!]*$/iu.test(
      t,
    ) ||
    /^you(?:['’]re| are) (?:now )?(?:at|on|in) stage (?:\d|one|two|three|four|five|six|seven)\b[^.!?]{0,60}[.!]*$/iu.test(
      t,
    ) ||
    /^(?:that|this|it)(?:['’]s| is| was) (?:a |an )?(?:really |very |pretty |such )?(?:clear|strong|useful|solid|great|good|helpful|big|real|promising|positive|important|valuable|exciting|fantastic|excellent|nice)\b[^.!?]{0,40}[.!]*$/iu.test(
      t,
    )
  );
}

function tidy(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Whether the reply says the prior fact the answer builds on: two of its own words, or its figure. */
export function saysPrior(reply: string, guidance: PromptGuidance): boolean {
  const prior = guidance.prior ?? null;
  if (prior === null) return true;
  const said = stemsOf(reply);
  const says = (text: string): boolean => {
    const fact = stemsOf(text);
    const shared = sharedCount(fact, said);
    return (
      fact.size === 0 || shared >= Math.max(2, Math.ceil(fact.size * 0.34)) || (shared >= 1 && fact.size <= 2)
    );
  };
  // Another fact of theirs, with its number, does as well; of what was read, any line.
  return (
    says(prior.fact) || (guidance.facts ?? []).some((f) => /\d/.test([...stemsOf(f)].join(' ')) && says(f))
  );
}

/** What the end of a reply adds, after the model's own part (`said`: all of it, the lead too). */
function tailOf(
  said: string,
  answerWords: number,
  guidance: PromptGuidance,
  channel: TurnChannel,
  founderText: string | undefined,
  findings: Set<ReplyContractFinding>,
  hadAnswer = false,
  wroteTemplate = false,
): string[] {
  const voice = channel === 'voice';
  const parts: string[] = [];
  const lead = leadText(guidance, channel);
  // The reply before, in other words, is as short as it is.
  const again = guidance.restate !== undefined && lead === '';
  const little =
    lead === '' &&
    !saysTheSum(said, guidance) &&
    answerWords < (again ? LEAST_RESTATED : voice ? MIN_SPOKEN_ANSWER_WORDS : MIN_ANSWER_WORDS);
  const recall = guidance.kind === 'recall';
  // Nothing of it twice in one reply, whoever said it first.
  const fresh = (text: string): string => {
    const held = saidSentences([said, ...parts].join('\n'));
    return text.includes('\n') ? text : unsaidOf(text, held);
  };
  if (hadAnswer) parts.push(composedAnswer(guidance, channel));
  else if (little) {
    findings.add(answerWords < MIN_HELP_WORDS ? 'question_only' : 'missing_answer');
    const whole = composedAnswer(guidance, channel);
    const given = fresh(whole);
    // All of it is there already: the rest of the program's answer, or nothing.
    const other = given === '' ? fresh(answerOf(guidance, channel)) : given;
    parts.push(other === '' && wordsIn(said) < LEAST_RESTATED ? whole : other);
  } else if (!again && lacksAnswer(said, guidance, founderText, channel)) {
    findings.add('missing_answer');
    parts.push(cited(fresh(answerOf(guidance, channel)), guidance, channel));
  }
  // Each thing they asked is answered, and what they set themselves is kept to.
  if (!recall && !again) {
    for (const part of guidance.parts ?? []) {
      const text = voice ? part.voice : part.text;
      if (text === '' || answersPart(part, [said, ...parts].join(' '))) continue;
      const rest = fresh(text);
      if (rest === '') continue;
      findings.add('missing_part');
      parts.push(rest);
    }
    for (const limit of voice ? [] : (guidance.limits ?? [])) {
      if (limit.text === '' || saysLimit([said, ...parts].join(' '), limit.said)) continue;
      findings.add('missing_part');
      parts.push(limit.text);
    }
  }
  const keeps = lead === '' ? (guidance.ask?.keeps ?? '') : '';
  if (
    keeps !== '' &&
    !norm(said).includes(norm(keeps)) &&
    coverage(stemsOf(keeps), stemsOf([said, ...parts].join(' '))) < 0.6
  ) {
    findings.add('missing_answer');
    parts.unshift(keeps);
  }
  if (wroteTemplate && !voice && guidance.template === 'offer' && answerWords < MOST_WITH_TEMPLATE) {
    const body = guidance.step?.template?.body ?? '';
    if (body !== '') parts.push(`Here it is to fill in, and the [brackets] are yours:\n\n${body}`);
  }
  const idea = newIdeaRest(said, guidance);
  if (idea !== '') {
    findings.add('missing_answer');
    parts.push(idea);
  }
  if (!recall && lead === '' && !again) {
    const told = [said, ...parts].join(' ');
    const prior = (voice ? guidance.prior?.spoken : guidance.prior?.sentence) ?? '';
    const gap = voice && guidance.prior?.spoken === undefined ? '' : (guidance.prior?.gap ?? '');
    const held = norm(told);
    if (prior !== '' && !held.includes(norm(prior)) && !saysPrior(told, guidance)) {
      const rest = fresh(prior);
      if (rest !== '') {
        findings.add('missing_prior');
        parts.push(rest);
      }
    } else if (gap !== '' && !held.includes(norm(gap)) && coverage(stemsOf(gap), stemsOf(told)) < 0.75) {
      findings.add('missing_prior');
      parts.push(gap);
    }
  }
  const whole = [said, ...parts].join(' ');
  const referral = referralRest(whole, guidance, channel);
  if (referral !== '') {
    findings.add('missing_referral');
    parts.push(referral);
  }
  return parts.filter((p) => p.trim() !== '');
}

/**
 * Whether a reply holds a figure nobody had told, worked out from theirs (any other went): short as it is, it is the answer
 * to an asked sum, or to a question the program has no answer to.
 */
function saysTheSum(said: string, guidance: PromptGuidance): boolean {
  const asks = guidance.asksSum === true || (guidance.ask === null && guidance.kind === 'coaching');
  if (!asks || guidance.said === undefined) return false;
  const told = knownNumbersIn(`${guidance.said}\n${guidanceText(guidance)}`);
  return numbersIn(said.replace(/\[\s*E\d+[^\]]*\]/giu, ' ')).some(
    (n) => n > 0 && !told.some((t) => Math.abs(t - n) < 0.005),
  );
}

/** Share of what the server would add that a reply holds when it answered that part itself. */
const PART_SAID = 0.4;

/** Whether a reply answers one of the things they asked: it says enough of what the program would. */
function answersPart(part: { readonly ask: string; readonly text: string }, said: string): boolean {
  const own = stemsOf(part.ask);
  const all = stemsOf(part.text);
  const rest = new Set([...all].filter((w) => !own.has(w)));
  const held = stemsOf(said);
  return coverage(rest.size >= 3 ? rest : all, held) >= PART_SAID;
}

/** Whether a reply says what they set ("10", "this month", "one evening"). */
function saysLimit(said: string, limit: string): boolean {
  if (/^\d+$/.test(limit)) return stemsOf(said).has(limit);
  return norm(said).includes(limit.toLowerCase());
}

/** Several claims, each on its line. */
const inOrder = (points: readonly string[]): string =>
  `In this order:\n\n${points.map((p, i) => `${String(i + 1)}. ${asSentence(p)}`).join('\n')}`;
const asSentence = (text: string): string => `${capital(stripEnd(text))}.`;

/** Fewest words of a reply said again in other words. */
const LEAST_RESTATED = 4;
/** A reply with more of its own than this needs no template the model only began. */
const MOST_WITH_TEMPLATE = 30;

/** The questions put to the founder, an "Or …?" that goes on from the one before it counted with it. */
function stacked(units: readonly ReadUnit[], questions: readonly number[]): number[][] {
  const groups: number[][] = [];
  for (const i of questions) {
    const last = groups.at(-1);
    const text = bare(units[i]?.text ?? '');
    if (last?.at(-1) === i - 1 && /^or\b/iu.test(text)) last.push(i);
    else groups.push([i]);
  }
  return groups;
}

/**
 * Reads a whole reply against the path's decision and writes the server's parts around the model's own: what must be said
 * first (the lead), the program's answer when the model gave too little of one, who decides, the one step line, and at most
 * one question. The model's own help stays, in its order; the step lines, deadlines, done-whens and sub-steps it wrote go,
 * whole blocks of them. `repaired` is null when the reply is already as it should be (so the check is idempotent).
 */
export function checkReplyContract(input: ReplyContractInput): ReplyContractResult {
  const { guidance, channel } = input;
  const reply = input.reply;
  if (!contractApplies(guidance, input.founderText)) return { ok: true, findings: [], repaired: null };
  const voice = channel === 'voice';
  const gap = voice ? ' ' : '\n\n';
  const parts = partsOf(reply, guidance, channel, input.today);
  const c = clean(parts.body, guidance, channel, input.today, input.founderText);
  const findings = new Set<ReplyContractFinding>(c.findings);
  const lead = leadText(guidance, channel);
  if (!picks(parts.body, guidance)) findings.add('missing_pick');
  if (lead !== '' && !parts.hadLead) findings.add('missing_lead');
  const step = sayStep(guidance, channel, input.today);
  if (step !== '' && !parts.hadStep) findings.add('missing_step');
  const tail = tailOf(
    [lead, c.text].join(' '),
    c.answerWords,
    guidance,
    channel,
    input.founderText,
    findings,
    parts.hadAnswer,
    c.wroteTemplate,
  );
  const onlyComposed = voice && findings.has('question_only');
  const question =
    (guidance.askBack ?? '').trim() !== '' ? (guidance.askBack ?? '') : onlyComposed ? '' : c.question;
  // The answer the server wrote stays where it was said.
  const first = parts.answerFirst ? tail.slice(0, 1) : [];
  const text = [lead, ...first, c.text, ...tail.slice(first.length), step, question]
    .filter((p) => p.trim() !== '')
    .join(gap);
  const changed = norm(text) !== norm(reply);
  if (!changed) return { ok: findings.size === 0, findings: [...findings], repaired: null };
  return { ok: false, findings: [...findings], repaired: text };
}

// Streaming --------------------------------------------------------------------------------------------------

/**
 * What the sentence gate does with a unit of a streamed reply:
 * - `release`: it may be shown or said (the rule for any statement: no waiting);
 * - `replace`: its answer stands without the clause that put it off ("Before we pick, sell it as a service" → "Sell …");
 * - `hold`: a question put to the founder: shown only after the reply's help, at most one;
 * - `drop`: it only puts the answer off or flatters.
 */
export type ContractVerdict =
  | { readonly action: 'release' }
  | { readonly action: 'replace'; readonly text: string }
  | { readonly action: 'hold' }
  | { readonly action: 'drop'; readonly finding: 'deferral' | 'flattery' | 'question_only' };

/**
 * The early gate: reads one unit of a streamed reply (`before`: what the reply said so far) as the contract would,
 * without waiting for the next one. Only a question ({@link ContractVerdict} `hold`) or a sentence that says nothing is
 * ever kept back.
 */
export function firstUnitVerdict(
  before: string,
  unit: string,
  guidance: PromptGuidance | null | undefined,
): ContractVerdict {
  if (!contractApplies(guidance)) return { action: 'release' };
  const replaced = withoutLead(unit);
  const kind = classOf(before, unit, null);
  if (kind === 'statement' && replaced !== null) return { action: 'replace', text: replaced };
  // "It depends." may be the start of the rule: what follows decides at the end of the reply.
  if (kind === 'deferral' && IT_DEPENDS.test(bare(unit))) return { action: 'release' };
  if (kind === 'deferral') return { action: 'drop', finding: 'deferral' };
  if (kind === 'flattery') return { action: 'drop', finding: 'flattery' };
  if (kind === 'question') {
    const text = bare(unit);
    if (DEFERRAL_LEAD.test(text)) return { action: 'drop', finding: 'deferral' };
    return PLAN_QUESTION.test(text) || REQUEST.test(text)
      ? { action: 'drop', finding: 'question_only' }
      : { action: 'hold' };
  }
  return { action: 'release' };
}

/**
 * What the end of a streamed reply (`released`: what was shown or said, the lead too) must add: the answer when the model
 * gave too little of one, who decides, what the answer builds on; then, after the held question's place, the step line and
 * the one question the path asks. '' when nothing.
 */
export function contractTail(
  input: Omit<ReplyContractInput, 'reply'> & {
    readonly released: string;
    readonly answerWords: number;
    readonly wroteTemplate?: boolean;
  },
): { readonly before: string; readonly step: string; readonly findings: readonly ReplyContractFinding[] } {
  const { guidance, channel, released } = input;
  if (!contractApplies(guidance, input.founderText)) return { before: '', step: '', findings: [] };
  const findings = new Set<ReplyContractFinding>();
  const parts = tailOf(
    released,
    input.answerWords,
    guidance,
    channel,
    input.founderText,
    findings,
    false,
    input.wroteTemplate === true,
  );
  return {
    before: parts.filter((p) => p.trim() !== '').join(channel === 'voice' ? ' ' : '\n\n'),
    step: sayStep(guidance, channel, input.today),
    findings: [...findings],
  };
}

/**
 * Whether a unit carries the contract (the step, or the path's answer): never left out as something an earlier reply
 * already said. The step is the same on every turn until it is done; that is the point of it.
 */
export function carriesContract(unit: string, guidance: PromptGuidance | null | undefined): boolean {
  if (!contractApplies(guidance)) return false;
  if (isTemplateLine(unit, guidance)) return true;
  const own = norm(unit);
  if (
    own !== '' &&
    [
      guidance.lead?.text,
      guidance.lead?.voice,
      guidance.prior?.sentence,
      guidance.prior?.spoken,
      guidance.prior?.gap,
      guidance.ask?.block,
      ...(guidance.calc ?? []),
    ].some((t) => t !== undefined && norm(t).includes(own))
  )
    return true;
  if (guidance.step !== null && SERVER_STEP.test(unit.trim())) return namesStep(unit, guidance.step);
  if (
    guidance.step !== null &&
    DONE_LINE.test(bare(unit)) &&
    coverage(stemsOf(unit), stemsOf(guidance.step.doneWhen)) >= 0.6
  )
    return true;
  const said = stemsOf(unit);
  // Who decides, and what to bring, are said on every turn that needs them.
  if (
    guidance.referral !== null &&
    // Said in full before in this conversation: not again word for word.
    guidance.referral.told !== true &&
    said.size >= 3 &&
    (saysWho(unit, guidance.referral) || (CARRIES.test(unit) && saysBring(unit, guidance.referral)))
  )
    return true;
  if (guidance.ask === null) return false;
  const pick = stemsOf(pickOf(guidance.ask.answer, 40));
  if (pick.size >= 3 && coverage(pick, said) >= 0.6) return true;
  // A sentence of the path's own answer, or of its why.
  const whole = `${guidance.ask.answer} ${guidance.ask.why}`;
  if (wordsIn(unit) >= 4 && plainWords(whole).includes(plainWords(unit))) return true;
  return said.size >= 4 && coverage(said, stemsOf(whole)) >= 0.85;
}

/**
 * Whether a unit may be said again though an earlier reply of the conversation said it: the step line, a line of a template,
 * what the server says first, a working, who decides while it was not said in full. The program's answer is said once.
 */
export function mayRepeat(unit: string, guidance: PromptGuidance | null | undefined): boolean {
  if (!contractApplies(guidance)) return false;
  if (isTemplateLine(unit, guidance)) return true;
  const own = norm(unit);
  if (
    own !== '' &&
    [
      guidance.lead?.text,
      guidance.lead?.voice,
      guidance.askBack,
      guidance.ask?.keeps,
      ...(guidance.calc ?? []),
    ].some((t) => t !== undefined && norm(t).includes(own))
  )
    return true;
  if (guidance.step !== null && SERVER_STEP.test(unit.trim())) return namesStep(unit, guidance.step);
  const { step, referral } = guidance;
  if (step !== null && DONE_LINE.test(bare(unit)) && coverage(stemsOf(unit), stemsOf(step.doneWhen)) >= 0.6)
    return true;
  return (
    referral !== null &&
    referral.told !== true &&
    stemsOf(unit).size >= 3 &&
    (saysWho(unit, referral) || (CARRIES.test(unit) && saysBring(unit, referral))) &&
    // Mostly that, and not the answer with a lawyer in it.
    coverage(
      stemsOf(unit),
      stemsOf(`${referral.who} ${referral.bring} bring ask see take decide help right qualified`),
    ) >= 0.5
  );
}

/** Most words of the model's own in a typed answer, and beside what the server says first (fewest of it, whatever opens). */
const TYPED_WORDS = { alone: 110, whole: 125, least: 20 } as const;
/** What a list, once begun, may run over by: an item left out would be a hole in it. */
const LIST_OVER = 60;

/**
 * Whether a unit of the model's is more than a typed answer holds (`words`: of its own so far): a sentence that goes over is
 * left out whole, and what comes after it. A list goes on to its end, and what they asked to have written is as long as it is.
 */
export function overTyped(unit: string, words: number, before: string, guidance: PromptGuidance): boolean {
  if (guidance.draft === true || guidance.restate !== undefined || words === 0) return false;
  // What the server adds is never counted out; the program's answer, recited under what it already said first, is.
  if (isServerText(unit, (guidance.lead ?? null) === null ? guidance : { ...guidance, ask: null }, 'text'))
    return false;
  const lead = (guidance.lead?.text ?? '').split(/\n\n(?=Here it is|\s*(?:1\. |Who:|"))/u)[0] ?? '';
  const limit = TYPED_WORDS;
  const most = lead === '' ? limit.alone : Math.max(limit.least, limit.whole - wordsIn(lead));
  const inList =
    isListUnit(unit) && /(?:^|\n)\s*(?:[-*+•]|\d{1,3}[.)])\s[^\n]*$|:[*_\s]*$/u.test(before.trimEnd());
  const announces = /:[*_\s]*$/u.test(unit) ? 25 : 0;
  return words + wordsIn(unit) + announces > most + (inList || quoteOpen(before) ? LIST_OVER : 8);
}

/** The words of `text` alone, spaced, without citation keys. */
function plainWords(text: string): string {
  return ` ${bare(text)
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/\bwon't\b/g, 'will not')
    .replace(/\b(do|does|did|is|are|was|were|have|has|would|should|could)n't\b/g, '$1 not')
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .trim()} `;
}

/** Most words of a call's whole reply on the path: the model's part, and the step said after it. */
export const SPOKEN_REPLY_WORDS = 65;

/** Words the step, and who decides, take on a call: kept free of a reply's spoken budget until they were said. */
export function spokenReserve(
  guidance: PromptGuidance | null | undefined,
  released: string,
  today?: string | null,
): number {
  if (!contractApplies(guidance) && !wholeApplies(guidance)) return 0;
  return (
    wordsIn(referralRest(released, guidance, 'voice')) +
    wordsIn(sayStep(guidance, 'voice', today)) +
    wordsIn(guidance.prior?.spoken ?? '') +
    wordsIn(guidance.askBack ?? '')
  );
}

/**
 * A spoken reply within `maxWords` that still says the step: over the budget, the last sentences that do not carry the
 * contract go first.
 */
export function fitSpoken(
  text: string,
  guidance: PromptGuidance | null | undefined,
  maxWords: number,
): string {
  if (!contractApplies(guidance) || wordsIn(text) <= maxWords) return text;
  const units = unitsOf(text).map((u) => u.text);
  for (let i = units.length - 1; i >= 1 && wordsIn(units.join(' ')) > maxWords; i -= 1) {
    if (!carriesContract(units[i] ?? '', guidance)) units.splice(i, 1);
  }
  return units.join(' ');
}

/** Whether `quote` is in the founder's own message, word for word (case, spacing and quote marks apart). */
export function saidVerbatim(quote: string | null | undefined, founderText: string): boolean {
  const norm = (t: string): string =>
    t
      .normalize('NFKC')
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^["']+|["'.!,]+$/g, '')
      .toLowerCase();
  const q = norm(quote ?? '');
  return q.length >= 2 && norm(founderText).includes(q);
}
