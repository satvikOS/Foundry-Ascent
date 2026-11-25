import type { TurnChannel } from '@foundry/contracts';

import { inDistress } from '../prompts/conversation-state.js';
import { sayDay, weekdayOf } from '../prompts/due-day.js';
import type { PromptGuidance, ReplyContractFinding, ReplyContractResult } from '../prompts/guidance.js';
import { handBackCandidate, putToFounder } from './social.js';
import { coverage, sharedCount, stemOf, stemsOf } from './stems.js';
import { isBlockUnit, isListUnit, unitsOf, wordsIn, type TextUnit } from './units.js';

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
 * never a founder in distress (`founderText`), who is answered as a person first, whatever step is open.
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
    (founderText === undefined || !inDistress(founderText))
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
  /\bwhat(?:['’]s| is| are) your (?:plan|plans|thinking|strategy|approach|thoughts|take|goal|next step)s? (?:for|on|about|to|with|here)\b/iu;

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
  if (isBlockUnit(raw) || quoteOpen(before) || /^\s*>/.test(raw)) {
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

const NEXT_LINE = /^[\s*_]*next(?: step)?[*_]*\s*(?::|—|–|-)/iu;
/** "A good next step: …", "Your next step is to …": a sentence that says what to do next, whatever it opens with. */
const NEXT_SAID = new RegExp(
  String.raw`^${LEAD_WORDS}[\s*_]*(?:here(?:['’]s| is) )?(?:a|an|your|the|my|one) (?:(?:really |very )?(?:good|great|best|better|solid|useful|obvious|simple|smart|clear|logical|natural|real|right|immediate|concrete|practical) )*next (?:step|move|action|thing to do)[*_]*\s*(?::|—|–|-|(?:is|would be|could be|should be)\b)`,
  'iu',
);
/** What done means, on its own line. */
export const DONE_LINE = /^[\s*_]*done (?:when|once)\b/iu;
const DATE_SAID = new RegExp(
  String.raw`\b(?:${WEEKDAY}s?|${MONTH}\.? \d{1,2}|\d{1,2} ${MONTH}|today|tonight|tomorrow|this (?:week|weekend|afternoon|evening|morning)|next week|end of (?:the |this )?(?:day|week)|(?:in|within) (?:a|an|one|two|three|four|five|six|seven|\d+) (?:hours?|days?|weeks?)|\d{4}-\d{2}-\d{2})\b`,
  'iu',
);

/** A line that gives a next step of its own: what follows its opening says enough to be one. */
function givesNext(text: string): boolean {
  const t = text.trim();
  if (QUESTION_END.test(t)) return false;
  if (NEXT_LINE.test(t)) return true;
  const said = NEXT_SAID.exec(t);
  // "Your next step is below." points at the card.
  return said !== null && stemsOf(t.slice(said[0].length)).size >= 3;
}

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

function byDay(dueOn: string | null, today: string | null | undefined): string | null {
  const day = sayDay(dueOn, today);
  if (day === null) return null;
  return day === 'today' ? 'the end of today' : day;
}

function doneClause(doneWhen: string): string {
  return lowerFirst(stripEnd(doneWhen.replace(/^\s*done when:?\s*/iu, '')));
}

/** The step as the server says it: "Next: … by Thursday. Done when …" (text), one sentence on a call. */
export function stepLine(
  step: NonNullable<PromptGuidance['step']>,
  channel: TurnChannel,
  today?: string | null,
): string {
  const day = byDay(step.dueOn, today);
  const title = stripEnd(step.title);
  const by = day === null ? '' : ` by ${day}`;
  if (channel === 'voice') return `Your next step: ${lowerFirst(title)}${day === null ? '' : `, by ${day}`}.`;
  return `Next: ${title}${by}. Done when ${doneClause(step.doneWhen)}.`;
}

/** What is missing of a step the reply names without saying by when, or when it is done (text only). */
function stepRest(
  step: NonNullable<PromptGuidance['step']>,
  said: string,
  channel: TurnChannel,
  today: string | null | undefined,
): string {
  const day = byDay(step.dueOn, today);
  const dated = day === null || DATE_SAID.test(said);
  const done =
    channel === 'voice' ||
    /\b(?:done|finished|complete) (?:when|once)\b/iu.test(said) ||
    coverage(stemsOf(step.doneWhen), stemsOf(said)) >= 0.5;
  const parts: string[] = [];
  if (!dated) parts.push(channel === 'voice' ? `Have that done by ${day}.` : `Do it by ${day}.`);
  if (!done) parts.push(`Done when ${doneClause(step.doneWhen)}.`);
  return parts.join(' ');
}

const DAY_SAID = new RegExp(
  String.raw`\b(by|due|before)(\s+)((?:(?:this|next|the end of) )?${WEEKDAY}(?:,? (?:the )?(?:${MONTH}\.? \d{1,2}|\d{1,2} ${MONTH})(?:st|nd|rd|th)?)?|${MONTH}\.? \d{1,2}(?:st|nd|rd|th)?|today|tonight|tomorrow)\b`,
  'giu',
);

/** The step's unit with its day as the path gives it, when it names another one. */
function withStepDay(text: string, dueOn: string | null, today: string | null | undefined): string {
  const said = byDay(dueOn, today);
  const weekday = dueOn === null ? null : weekdayOf(dueOn);
  if (said === null || weekday === null || dueOn === null) return text;
  const long = sayDay(dueOn) ?? '';
  const monthDay = long.split(', ')[1] ?? '';
  const right = (day: string): boolean => {
    const d = day
      .toLowerCase()
      .replace(/[.,]/g, '')
      .replace(/(\d)(?:st|nd|rd|th)$/, '$1');
    const short = monthDay.toLowerCase().split(' ');
    const words = d.split(/\s+/);
    if (said.endsWith('today') && (d === 'today' || d === 'tonight')) return true;
    if (d === 'tomorrow' || d === 'today' || d === 'tonight') return d === said;
    if (words.includes(weekday.toLowerCase())) {
      const number = /\d{1,2}/.exec(d)?.[0];
      return number === undefined || number === short[1];
    }
    if (new RegExp(`^${WEEKDAY}`, 'iu').test(d)) return false;
    return (short[0] ?? '').startsWith(words[0] ?? '-') && words[1] === short[1];
  };
  return text.replace(DAY_SAID, (whole, prep: string, space: string, day: string) =>
    right(day) ? whole : `${prep}${space}${said}`,
  );
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

function saysAnswer(reply: string, guidance: PromptGuidance, founderText: string | undefined): boolean {
  if (guidance.ask === null) return true;
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
  // What they asked to be told again is facts: most of them are said, or the record is.
  if (guidance.kind === 'recall') {
    const facts = without(answerOf(guidance, 'text'));
    return coverage(facts, said) >= 0.4;
  }
  return (inPick >= 2 && inPick / pick.size >= 0.25) || (inWhole >= 4 && inWhole / whole.size >= 0.2);
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
    factSaid ? '' : `${name} has this on record: ${fact}.`,
    ways
      ? ''
      : `You can make it a change of direction for ${name}, or ask your program lead for a separate workspace.`,
  ]
    .filter((p) => p !== '')
    .join(' ');
}

function newIdeaLine(guidance: PromptGuidance): string {
  const idea = guidance.newIdea;
  if (idea === null) return '';
  const fact = idea.fact === null || idea.fact.trim() === '' ? '' : ` (${stripEnd(idea.fact)})`;
  return `This is a different idea from ${idea.ventureName}${fact}. You can make it a change of direction for ${idea.ventureName}, or ask your program lead for a separate workspace; either way, here is how it starts.`;
}

/** Generic words of who decides ("the university's office"): naming them alone names no one. */
const WHO_GENERIC = new Set(
  'university program programme campus school team person qualified local talk anything before sign decide office expert'
    .split(' ')
    .map(stemOf),
);

function saysWho(reply: string, referral: NonNullable<PromptGuidance['referral']>): boolean {
  const who = new Set([...stemsOf(referral.who)].filter((w) => !WHO_GENERIC.has(w)));
  const said = stemsOf(reply);
  return who.size === 0 || sharedCount(who, said) >= Math.min(2, who.size) || coverage(who, said) >= 0.4;
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
    return shared >= Math.min(2, bring.size) && shared / bring.size >= 0.25;
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
function referralRest(reply: string, guidance: PromptGuidance, channel: TurnChannel): string {
  const { referral } = guidance;
  if (referral === null) return '';
  const voice = channel === 'voice';
  const who = voice ? clipped(referral.who, SPOKEN_WHO_WORDS) : stripEnd(referral.who);
  const bring = voice ? clipped(referral.bring, SPOKEN_BRING_WORDS) : stripEnd(referral.bring);
  const said = saysWho(reply, referral);
  return [
    said ? '' : `A qualified person decides this: ${lowerFirst(who)}.`,
    bring === '' || saysBring(reply, referral) ? '' : `Bring ${lowerFirst(bring)}.`,
  ]
    .filter((p) => p !== '')
    .join(' ');
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

/** The whole reply the path alone gives: the answer, why, who decides and the step (no model). */
export function composeFromGuidance(
  guidance: PromptGuidance,
  channel: TurnChannel,
  today?: string | null,
): string {
  const voice = channel === 'voice';
  const recall = guidance.kind === 'recall';
  const parts: string[] = [];
  if (guidance.newIdea !== null) parts.push(newIdeaLine(guidance));
  if (guidance.ask !== null) {
    const answer = voice || recall ? answerOf(guidance, channel) : guidance.ask.answer.trim();
    parts.push(cited(answer, guidance, channel));
    if (!voice && !recall) parts.push(cited(guidance.ask.why.trim(), guidance, channel));
  } else if (guidance.step === null || recall) {
    parts.push(
      `You are at ${lowerFirst(guidance.stage.title)}, stage ${String(guidance.stage.number)} of ${String(guidance.stage.count)}.`,
    );
  }
  const gap = voice ? ' ' : '\n\n';
  parts.push(referralRest('', guidance, channel));
  const text = parts.join(gap);
  if (guidance.step !== null) {
    const { step } = guidance;
    // The answer may give the step itself ("Next: …" of a report, the open step of a recall): only what it left out.
    const given =
      (recall && guidance.ask !== null && namesStep(text, step)) ||
      unitsOf(text).some((u) => givesNext(u.text) && namesStep(u.text, step));
    const rest = recall ? '' : stepRest(step, text, channel, today);
    parts.push(given ? rest : stepLine(step, channel, today));
  }
  return parts.filter((p) => p.trim() !== '').join(gap);
}

// The check --------------------------------------------------------------------------------------------------

/** Words of help a reply needs to be more than questions. */
const MIN_HELP_WORDS = 6;

interface Analysis {
  readonly units: readonly ReadUnit[];
  readonly findings: ReplyContractFinding[];
  /** Questions put to the founder, as indexes into `units`. */
  readonly questions: readonly number[];
  readonly helpWords: number;
  /** The units that name the step, as indexes. */
  readonly stepUnits: readonly number[];
}

function analyse(
  text: string,
  guidance: PromptGuidance,
  founderText: string | undefined,
  channel: TurnChannel,
): Analysis {
  const units = read(text);
  const findings: ReplyContractFinding[] = [];
  const questions = units.flatMap((u, i) => (u.kind === 'question' ? [i] : []));
  const help = units.filter((u) => u.kind === 'statement' || u.kind === 'block');
  const helpWords = help.reduce((n, u) => n + wordsIn(u.text), 0);
  const helpText = help.map((u) => u.text).join(' ');
  const deferred = units.some(
    (u, i) =>
      u.kind === 'deferral' ||
      (u.kind === 'question' && DEFERRAL_LEAD.test(bare(u.text))) ||
      (i < 2 && withoutLead(u.raw) !== null && DEFERRAL_LEAD.test(bare(u.text))) ||
      (u.kind === 'question' && i < 2 && PLAN_QUESTION.test(bare(u.text))),
  );
  const onlyAsks =
    helpWords < MIN_HELP_WORDS &&
    (units.length === 0 ||
      units.some((u) => u.kind === 'question' || u.kind === 'asked' || u.kind === 'deferral'));
  if (onlyAsks) findings.push('question_only');
  if (deferred) findings.push('deferral');
  // The step's own line is not the answer, whatever words they share.
  const answered = help.filter((u) => !givesNext(u.text) && !DONE_LINE.test(u.text));
  if (
    !saysAnswer(answered.map((u) => u.text).join(' '), guidance, founderText) ||
    newIdeaRest(text, guidance) !== ''
  )
    findings.push('missing_answer');
  if (referralRest(helpText, guidance, channel) !== '') findings.push('missing_referral');

  const stepUnits: number[] = [];
  const step = guidance.step;
  if (step !== null) {
    units.forEach((u, i) => {
      if (u.kind === 'question' || u.kind === 'asked' || u.kind === 'deferral') return;
      const next = units[i + 1];
      const pair =
        next === undefined || next.kind === 'question' || next.kind === 'deferral'
          ? u.text
          : `${u.text} ${next.text}`;
      if (namesStep(u.text, step)) stepUnits.push(i);
      else if (
        next !== undefined &&
        wordsIn(pair) <= 40 &&
        !namesStep(next.text, step) &&
        namesStep(pair, step)
      )
        stepUnits.push(i, i + 1);
    });
    if (guidance.kind !== 'recall') {
      const from = stepUnits[0];
      const said =
        from === undefined
          ? ''
          : units
              .slice(from)
              .map((u) => u.text)
              .join(' ');
      if (from === undefined || stepRest(step, said, channel, '1970-01-01') !== '')
        findings.push('missing_step');
    }
    if (
      units.some(
        (u, i) => u.kind !== 'question' && u.kind !== 'asked' && givesNext(u.text) && !stepUnits.includes(i),
      )
    )
      findings.push('other_step');
    const named = units.filter((u, i) => stepUnits.includes(i) || NEXT_LINE.test(u.text));
    if (named.some((u) => withStepDay(u.text, step.dueOn, null) !== u.text)) findings.push('wrong_date');
  }
  if (stacked(units, questions).length > 1) findings.push('stacked_questions');
  if (
    units.some((u) => u.kind === 'flattery' || (u.kind === 'statement' && FLATTERY_LEAD.test(bare(u.text))))
  )
    findings.push('flattery');
  return { units, findings, questions, helpWords, stepUnits };
}

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
 * Reads a whole reply against the path's decision and repairs what is missing from it (see the module comment). The
 * model's own help stays, in its order: what only puts the answer off or flatters goes, the answer leads when it was not
 * given, at most one question stays (the last one), and the step and its day come before it. `repaired` is null when the
 * reply keeps the contract.
 */
export function checkReplyContract(input: ReplyContractInput): ReplyContractResult {
  const { guidance, channel } = input;
  const reply = input.reply;
  if (!contractApplies(guidance, input.founderText)) return { ok: true, findings: [], repaired: null };
  const a = analyse(reply, guidance, input.founderText, channel);
  if (a.findings.length === 0) return { ok: true, findings: [], repaired: null };
  const has = (f: ReplyContractFinding): boolean => a.findings.includes(f);

  const groups = stacked(a.units, a.questions);
  const asking = groups.at(-1) ?? [];
  const trailing = asking.length > 0 && asking.at(-1) === a.units.length - 1;
  const question = asking.map((i) => a.units[i]?.text ?? '').join(' ');
  const keepQuestion =
    question !== '' &&
    !PLAN_QUESTION.test(bare(question)) &&
    !DEFERRAL_LEAD.test(bare(question)) &&
    !asking.some((i) => REQUEST.test(bare(a.units[i]?.text ?? ''))) &&
    !asking.some((i) => isListUnit(a.units[i]?.text ?? ''));

  if (has('question_only')) {
    const composed = composeFromGuidance(guidance, channel, input.today);
    const repaired = keepQuestion && channel === 'text' ? `${composed}\n\n${capital(question)}` : composed;
    return { ok: false, findings: a.findings, repaired };
  }

  // The model's own reply, unit by unit, without what the contract leaves out.
  const body: string[] = [];
  let afterOtherStep = false;
  a.units.forEach((u, i) => {
    // "Done when it is live." of a step that is not the path's goes with it.
    const itsDone = afterOtherStep && DONE_LINE.test(u.text);
    afterOtherStep = false;
    if (itsDone) return;
    if (u.kind === 'deferral' || u.kind === 'flattery') return;
    if (u.kind === 'question') {
      const last = asking.includes(i);
      if (!last || (trailing && !keepQuestion)) return;
      if (trailing) return; // after the step
    }
    let raw = u.raw;
    if (u.kind === 'statement') raw = withoutLead(raw) ?? raw;
    if (guidance.step !== null && givesNext(u.text) && !a.stepUnits.includes(i)) {
      afterOtherStep = true; // another step: never
      return;
    }
    if (guidance.step !== null && (a.stepUnits.includes(i) || NEXT_LINE.test(u.text)))
      raw = withStepDay(raw, guidance.step.dueOn, input.today);
    body.push(raw);
  });
  let text = body.join('').trim();

  const gap = channel === 'voice' ? ' ' : '\n\n';
  if (has('missing_answer')) {
    const lead = [
      newIdeaRest(text, guidance),
      guidance.ask === null || saysAnswer(text, guidance, input.founderText)
        ? ''
        : cited(answerOf(guidance, channel), guidance, channel),
    ]
      .filter((p) => p !== '')
      .join(gap);
    text = lead === '' ? text : `${lead}${gap}${text}`;
  }
  if (has('missing_referral')) text = `${text}${gap}${referralRest(text, guidance, channel)}`.trim();
  if (guidance.step !== null && has('missing_step')) {
    const from = a.stepUnits[0];
    const said =
      from === undefined
        ? ''
        : a.units
            .slice(from)
            .map((u) => u.text)
            .join(' ');
    const line =
      from === undefined
        ? stepLine(guidance.step, channel, input.today)
        : stepRest(guidance.step, said, channel, input.today);
    if (line !== '') text = `${text}${from === undefined ? gap : ' '}${line}`;
  }
  if (trailing && keepQuestion) text = `${text}${gap}${question}`;
  text = text.trim();
  return { ok: false, findings: a.findings, repaired: text === reply.trim() ? null : text };
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

/** Whether another wording of the step is written on a "Next:" line that is not the path's step. */
export function isOtherNextLine(unit: string, guidance: PromptGuidance | null | undefined): boolean {
  if (!contractApplies(guidance) || guidance.step === null) return false;
  return givesNext(unit) && !namesStep(unit, guidance.step);
}

/** A unit of a streamed reply with the step's day as the path gives it (unchanged when it names no other). */
export function withPathDay(
  unit: string,
  guidance: PromptGuidance | null | undefined,
  today?: string | null,
): string {
  if (!contractApplies(guidance) || guidance.step === null) return unit;
  return NEXT_LINE.test(unit.trim()) || namesStep(unit, guidance.step)
    ? withStepDay(unit, guidance.step.dueOn, today)
    : unit;
}

/**
 * What the end of a streamed reply (`released`: what was shown or said) must add so it keeps the contract: the whole
 * answer and step when nothing of help was released, else the answer (shortly), who decides and the step that are
 * missing; '' when nothing is. A question the gate held comes after it.
 */
export function contractTail(
  input: Omit<ReplyContractInput, 'reply'> & { readonly released: string },
): string {
  const { guidance, channel, released } = input;
  if (!contractApplies(guidance, input.founderText)) return '';
  const a = analyse(released, guidance, input.founderText, channel);
  if (a.findings.includes('question_only')) return composeFromGuidance(guidance, channel, input.today);
  const parts: string[] = [];
  if (a.findings.includes('missing_answer')) {
    parts.push(newIdeaRest(released, guidance));
    if (guidance.ask !== null && !saysAnswer(released, guidance, input.founderText)) {
      // Said plainly, with no lead-in: the same one on every reply is what a founder hears as canned.
      parts.push(cited(answerOf(guidance, channel), guidance, channel));
    }
  }
  if (a.findings.includes('missing_referral'))
    parts.push(referralRest([released, ...parts].join(' '), guidance, channel));
  if (guidance.step !== null && a.findings.includes('missing_step')) {
    const from = a.stepUnits[0];
    const said =
      from === undefined
        ? ''
        : a.units
            .slice(from)
            .map((u) => u.text)
            .join(' ');
    parts.push(
      from === undefined
        ? stepLine(guidance.step, channel, input.today)
        : stepRest(guidance.step, said, channel, input.today),
    );
  }
  return parts.filter((p) => p.trim() !== '').join(channel === 'voice' ? ' ' : '\n\n');
}

/**
 * Whether a unit carries the contract (the step, or the path's answer): never left out as something an earlier reply
 * already said. The step is the same on every turn until it is done; that is the point of it.
 */
export function carriesContract(unit: string, guidance: PromptGuidance | null | undefined): boolean {
  if (!contractApplies(guidance)) return false;
  if (NEXT_LINE.test(unit.trim()) || namesStep(unit, guidance.step)) return !QUESTION_END.test(unit.trim());
  if (guidance.step !== null && DONE_LINE.test(unit)) return true;
  const said = stemsOf(unit);
  // Who decides, and what to bring, are said on every turn that needs them.
  if (
    guidance.referral !== null &&
    said.size >= 3 &&
    (saysWho(unit, guidance.referral) || (CARRIES.test(unit) && saysBring(unit, guidance.referral)))
  )
    return true;
  if (guidance.ask === null) return false;
  const pick = stemsOf(pickOf(guidance.ask.answer, 40));
  if (pick.size >= 3 && coverage(pick, said) >= 0.6) return true;
  // A sentence of the path's own answer, or of its why.
  const own = `${guidance.ask.answer} ${guidance.ask.why}`;
  if (wordsIn(unit) >= 4 && plainWords(own).includes(plainWords(unit))) return true;
  return said.size >= 4 && coverage(said, stemsOf(own)) >= 0.85;
}

/** The words of `text` alone, spaced, without citation keys. */
function plainWords(text: string): string {
  return ` ${bare(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .trim()} `;
}

/** Words the step, and who decides, take on a call: kept free of a reply's spoken budget until they were said. */
export function spokenReserve(
  guidance: PromptGuidance | null | undefined,
  released: string,
  today?: string | null,
): number {
  if (!contractApplies(guidance)) return 0;
  const referral = wordsIn(referralRest(released, guidance, 'voice'));
  if (guidance.step === null || guidance.kind === 'recall') return referral;
  return (
    referral + (namesStep(released, guidance.step) ? 0 : wordsIn(stepLine(guidance.step, 'voice', today)))
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
