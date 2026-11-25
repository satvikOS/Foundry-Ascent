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
 * 4. a push is never answered with a claim to have had evidence, and made-up work never with friends in its place;
 * 5. nothing speaks of how the turn was prepared ("The opening says …"), goes against the figure code worked out (its sign,
 *    its size) or says that something is what a claim says it is not.
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

/** Different words for one thing said of a talk, money or a wish. */
const SAME: Readonly<Record<string, string>> = Object.fromEntries(
  (
    [
      ['talk', 'talk chat speak conversation call meet interview'],
      ['pay', 'pay spend charge cost price fee'],
      ['keep', 'keep hold retain stay'],
      ['again', 'again second repeat return'],
      ['want', 'want wish like love'],
    ] as const
  ).flatMap(([to, words]) => words.split(' ').map((w) => [stemOf(w), to])),
);

/** Names a text says mid-sentence. */
const namesIn = (text: string): string[] =>
  [...text.matchAll(/(?<=[\p{L}\p{N},;:)'’-]\s)\p{Lu}[\p{L}'’-]{2,}/gu)].map((m) => m[0].toLowerCase());

const figures = (text: string): number[] => [...numbersIn(text), ...spelledNumbersIn(text)];

/** Whether a unit adds something to what the server opened with. */
export function addsToLead(unit: string, reading: Reading, lead: string): boolean {
  const text = plain(unit);
  const held = stemsOf(lead);
  const given = [...figures(lead), ...(reading.figures ?? []).map((f) => f.value)];
  if ((TO_ANYONE.test(text) || GREETS.test(text)) && !/\d/.test(text)) return false;
  // "About six months" under 6.2 months is that figure again.
  if (figures(text).some((n) => n > 1 && !given.some((g) => Math.abs(g - n) <= Math.abs(g) * 0.05)))
    return true;
  const names = namesIn(lead);
  const said = stemsOf(text);
  const telling = [...said].filter((w) => !EMPTY.has(w));
  const same = new Set([...held].map((w) => SAME[w] ?? w));
  const fresh = new Set(telling.filter((w) => !same.has(SAME[w] ?? w)));
  if (fresh.size === 0) return false;
  // Mostly what was just said, in other words: a name in it adds nothing.
  const doing = DOES.test(text);
  if (!doing && telling.length >= 5 && fresh.size / telling.length <= 0.5) return false;
  if (namesIn(text).some((n) => !names.includes(n))) return true;
  const from = (source: string): boolean => {
    const own = [...stemsOf(source)].filter((w) => !held.has(w) && !EMPTY.has(w));
    return sharedCount(new Set(own), fresh) >= Math.min(2, own.length) && own.length > 0;
  };
  if ([...reading.points, ...reading.record].some(from)) return true;
  return fresh.size >= 3 && (doing || /["“][^"”]{12,}["”]/u.test(text));
}

const AGREES =
  /^(?:yes|yeah|yep|sure|absolutely|exactly|right|that(?:'s| is) (?:fair|right|true|fine|ok(?:ay)?|honest|accurate)|it(?:'s| is) (?:fair|fine|honest|accurate)|you(?:'re| are) (?:right|correct)|fair enough|agreed)\b|\b(?:matches|is consistent with|lines up with|fits with|is in line with) what (?:you|the|your)\b/iu;
/** A verdict on an offer, terms, a price named for a part of it, or a split. */
const RULES_TERMS =
  /\b(?:good|great|fair|bad|low|high|strong|weak|cheap|expensive|reasonable|decent|generous|solid|right|standard)\b[^.!?]{0,30}\b(?:price|offer|deal|terms?|valuation|split|share|stake|amount)\b|\b(?:price|offer|deal|terms?|valuation|split|stake|\d{1,3}\s?[/-]\s?\d{1,3})\b[^.!?]{0,30}\b(?:is|are|looks?|seems?|sounds?) (?:a )?(?:very |pretty |quite )?(?:good|great|fair|bad|low|high|strong|weak|cheap|reasonable|decent|generous|right|standard|fine|ok)\b|^(?:yes,? )?(?:take|accept|sign|agree to|go with) (?:it|the|this|that|his|her|their)\b/iu;
const ASKS_FIRST =
  /\b(?:before (?:you (?:sign|answer|agree|say|take|accept)|(?:an?|the|your) (?:lawyer|office|\w+ (?:has|have) (?:read|said)))|until|unless|whether|not|never|don't|only|ask|lawyer|who decides|decides?)\b/iu;

/** "I'm not asserting anything without evidence.": a mentor's own defence. */
const DEFENDS =
  /\bi(?:'m| am| was|'ve| have)(?: not|n't)? (?:just |simply )?(?:assert|claim|making (?:this|that|it) up|guess|saying (?:this|that) without|(?:got )?evidence|basing)\w*|\bmy (?:evidence|claim|advice) (?:is|comes)\b|\bthe evidence (?:i|we) have\b/iu;

/** Good advice to anyone. */
const TO_ANYONE =
  /^(?:(?:also|and|just|then),? )?(?:make sure|be sure|ensure|keep (?:this|that|it|the \w+(?: \w+)?|in) (?:in )?mind|remember (?:to|that)|don['’]t forget|stay focused|take (?:your|the) time)\b/iu;

/** "Hi Ana and Bo, great to see you both." under what already opened. */
const GREETS = /^(?:hi|hello|hey|good (?:morning|afternoon|evening))\b[^.!?]{0,60}[.!]+$/iu;

/** A line of what to do first: the server's alone. */
const STARTS_WITH = /^(?:start with\s*[:—–]|next(?: up)?, )/iu;

const FRIENDS =
  /\b(?:friends?|roommates?|room mates?|flatmates?|family|your (?:mom|dad|parents|sister|brother))\b/iu;
const NO_FRIENDS =
  /\b(?:not|no|never|n't|except|without|instead of|rather than|other than|beyond|outside|do not count|don't count)\b/iu;

/** Comfort in place of help. */
const COMFORTS =
  /\b(?:focus on what you can control|one (?:step|thing|day) at a time|take a (?:deep )?breath|it(?:'s| is) going to be (?:ok|okay|fine|all right)|you(?:'ve| have) got this|don't panic|things will work out)\b/iu;

// How the turn was prepared ------------------------------------------------------------------------------------------

/** What only the prompt knows of, said as if they had seen it. */
const WORKS =
  '(?:opening|brief|prompt|points?|claims?|notes?|reading|record|data|program|programme|method|guidance|instructions?|answer above|reply above|first sentence)';
/** A sentence that only leads into what it says ("What the opening did not say is that …", "The record shows that …"). */
const LEADS_IN = new RegExp(
  String.raw`^(\s*[*_]*)(?:what (?:the|your|my|this) ${WORKS} (?:did not|didn['’]t|does not|doesn['’]t|leaves out|left out)(?: yet)?(?: say| mention| tell you| show| include)?(?: yet)? is(?: that)?|(?:the|this|my) (?:opening|brief|prompt|reading|notes?|points?|claims?|guidance|answer above|reply above|first sentence) (?:already )?(?:says?|said|shows?|showed|states?|stated|mentions?|mentioned|notes?|noted|tells? you|explains?|explained)(?: already)?(?: that)?|(?:according to|as) (?:the|your|this|my) (?:opening|brief|prompt|reading|notes?|points?|program|method)(?: (?:says?|said|shows?))?,?)[,:]?\s+`,
  'iu',
);

/** "…, and the program's method is to fill …": what to do, without whose it is. */
const METHOD_IS = /(,? and |;? ?)(?:the|our) (?:program|programme)(?:['’]s)? (?:method|way|answer) is to /iu;

/** A sentence without what leads into it from the prompt; as it is when nothing does. */
export function withoutWorks(raw: string): string {
  const unit = raw.replace(METHOD_IS, (_m, before: string, at: number) =>
    /^\s*$/u.test(raw.slice(0, at)) && before.trim() === '' ? before : '; ',
  );
  if (unit !== raw)
    return unit.replace(/^(\s*)(\p{Ll})/u, (_m, gap: string, c: string) => `${gap}${c.toUpperCase()}`);
  const m = LEADS_IN.exec(unit);
  if (m === null) return unit;
  const rest = unit.slice(m[0].length);
  return rest === '' ? unit : `${m[1] ?? ''}${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
}

const OF_THE_WORKS = new RegExp(
  String.raw`\b(?:the|this|my) (?:opening|brief|prompt)\b|\b(?:the|this) (?:mentor|coach|assistant|vEIR)(?:['’]s)? (?:\w+ )?(?:says?|said|cites?|cited|thinks?|believes?|has|have|had|own|notes?|noted|shows?|suggests?|points?|already|recommends?|advised?)\b|\bthe founders?(?:['’]s?)?\b(?! (?:of|who|that) )|\bthe (?:program|programme)(?:['’]s)? (?:method|answer|play|step|way)\b|\bthe (?:record|reading|notes?) (?:says?|shows?|states?|lists?)\b|\b(?:points?|claims?) (?:\d|one|two|three|above|below)\b|\byou(?:['’]re| are) doing this for the first time\b`,
  'iu',
);
/** Whether a unit speaks of how the turn was prepared, or of them as someone else. */
export const ofTheWorks = (unit: string): boolean => OF_THE_WORKS.test(plain(unit));

/** "A qualified person decides this: …", the prompt's own line for who decides. */
export const echoesReferral = (unit: string): boolean =>
  /^(?:(?:a|the) qualified (?:person|professional) (?:decides|must decide|should decide|needs to decide|has to decide)\b|bring:\s)/iu.test(
    plain(unit),
  );

// Beside a figure -----------------------------------------------------------------------------------------------------

const LOSES =
  /\b(?:you(?:['’]re| are)? (?:still |now |actually )*(?:los(?:e|ing) (?:money|overall|\$)|in the red|at a loss|underwater|negative)|(?:that|this|it)(?:['’]s| is) (?:still )?a loss|los(?:e|ing) money (?:overall|on (?:each|every|it))|don['’]t (?:make|earn|keep) (?:anything|money)|nothing (?:is )?left)\b|\b(?:leaves?|left with|keep) (?:you )?(?:with )?\$0(?![\d.,])|\$0 (?:is )?left\b/iu;
const GAINS =
  /\b(?:you(?:['’]re| are)? (?:still |now )*(?:mak(?:e|ing) (?:money|a profit)|profitable|in the black|earn(?:ing)? money|ahead)|(?:that|this|it)(?:['’]s| is) (?:still )?a profit)\b/iu;
const IF = /\b(?:if|unless|once|until|would|could|might|when|without|before)\b/iu;
const COMPARES =
  /^(?:so |and )?(?:that(?:['’]s| is)|this is|it(?:['’]s| is)|you (?:keep|make|earn|need|have)|which is) (?:only |just |still |about )?(less than|under|below|fewer than|more than|over|above|at least|at most) (\$?)([\d][\d,.]*)/iu;

/** Whether a unit goes against a figure code worked out: its sign, or its size. */
export function againstFigure(unit: string, figures: Reading['figures']): boolean {
  const all = figures ?? [];
  if (all.length === 0) return false;
  const text = plain(unit);
  const money = all.filter((f) => f.unit === '$');
  if (money.length > 0 && !IF.test(text)) {
    if (money.every((f) => f.value > 0) && LOSES.test(text)) return true;
    if (money.every((f) => f.value <= 0) && GAINS.test(text)) return true;
  }
  const m = COMPARES.exec(text);
  if (m === null) return false;
  const than = Number((m[3] ?? '').replace(/,/gu, ''));
  const less = /^(?:less|under|below|fewer|at most)/iu.test(m[1] ?? '');
  const same = all.filter((f) => (m[2] === '$') === (f.unit === '$'));
  return same.length > 0 && same.every((f) => (less ? f.value > than : f.value < than));
}

// Beside a claim ------------------------------------------------------------------------------------------------------

/** What a claim says something is not ("a grant is not a customer", "friendly is not a yes"). */
const IS_NOT =
  /\b(?:is|are|was|were|['’]s|counts? as)(?: not|n['’]t)(?: yet)? (?:an? |the |any |really )?([\p{L}-]{3,})\b|\bnot an? ([\p{L}-]{3,})\b|\bno ([\p{L}-]{3,}) yet\b/giu;
const IS_ONE =
  /(?:\b(?:is|are|was|were)|['’](?:s|re)) (?:an? |the |really an? |definitely an? |indeed an? )([\p{L}-]{3,})\b/giu;
const DENIES = /\b(?:not|no|never|neither|nor|if|unless|until|without|whether|only)\b|n['’]t\b/iu;
/** Adjectives and nouns too wide to be denied by a word. */
const WIDE = new Set([
  'one',
  'thing',
  'way',
  'good',
  'sure',
  'time',
  'reason',
  'step',
  'part',
  'lot',
  'few',
  'same',
]);

/** Whether a unit says that something is what a claim says it is not. */
export function deniesClaim(unit: string, reading: Reading): boolean {
  const text = plain(unit);
  if (DENIES.test(text) || /\?["'”’)]*$/u.test(text)) return false;
  const not = new Set(
    reading.points.flatMap((p) =>
      [...p.matchAll(IS_NOT)].map((m) => stemOf((m[1] ?? m[2] ?? m[3] ?? '').toLowerCase())),
    ),
  );
  return [...text.matchAll(IS_ONE)].some((m) => {
    const word = (m[1] ?? '').toLowerCase();
    return !WIDE.has(word) && not.has(stemOf(word));
  });
}

/** "Good price.", "Good.", "Yes, that's fair.": a verdict with nothing beside it. */
const BARE_VERDICT =
  /^(?:(?:yes|yeah|yep|sure|no|nope|well|honestly|okay|ok)[,.:!—-]*\s+)?(?:(?:that|this|it)(?:['’]s| is| looks| sounds)(?: (?:a|an|the|definitely|really|pretty|quite|totally))*\s+|(?:a|an|really|pretty|very)\s+)?(?:good|great|fair|bad|fine|perfect|solid|strong|excellent|amazing|fantastic|reasonable|decent|right|(?<=\b(?:a|an|the)\s)yes)(?:\s+(?:price|deal|offer|sign|news|result|results|start|number|numbers|idea|plan|move|call|point))?[.!]+$/iu;
/** Whether a unit is a verdict and nothing else: never an answer. */
export const bareVerdict = (unit: string): boolean =>
  BARE_VERDICT.test(plain(unit).replace(/^[-—–\s]+/u, ''));

/** A verdict on an offer, terms, or a price named for a part of it: a person's to give. */
export const rulesTerms = (unit: string): boolean => {
  const text = plain(unit);
  return RULES_TERMS.test(text) && !ASKS_FIRST.test(text);
};

/** Whether a unit agrees with what it stands under. */
export const agreesWith = (unit: string): boolean => AGREES.test(plain(unit));

/** A pick, or what speaks for one, of what a person decides. */
function picksHeld(text: string, options: readonly string[]): boolean {
  if (
    /^(?:my pick|i(?:['’]d| would) (?:go with|pick|choose|change my mind)|go with|choose|pick)\b/iu.test(text)
  )
    return true;
  if (
    /\b(?:main|most of the|more of the|bigger|real) (?:value|work|contribution)\b|\bdeserves?\b|\bshould (?:get|own|have) (?:more|less|the)\b/iu.test(
      text,
    )
  )
    return true;
  if (options.length < 2 || ASKS_FIRST.test(text) || DOES.test(text)) return false;
  const said = stemsOf(text);
  return options.some((o) => {
    const others = new Set(options.filter((x) => x !== o).flatMap((x) => [...stemsOf(x)]));
    const own = [...stemsOf(o)].filter((w) => !others.has(w));
    return own.length > 0 && own.every((w) => said.has(w));
  });
}

/** Something brought to who decides that is none of theirs ("Bring the new price to the visa office"). */
function wrongErrand(text: string, guidance: PromptGuidance): boolean {
  const { referral } = guidance;
  if (referral === null) return false;
  const m = /^(?:bring|take|send|show|give) (.{3,70}?) to (?:the |your |an? )?(.{3,70})/iu.exec(text);
  if (m === null) return false;
  const office = stemsOf(referral.who.split(/[,;(]/u)[0] ?? referral.who);
  if (sharedCount(office, stemsOf(m[2] ?? '')) < Math.min(2, office.size)) return false;
  const brought = stemsOf(m[1] ?? '');
  return (
    brought.size > 0 &&
    sharedCount(brought, stemsOf(`${referral.bring} ${referral.who} question list note page summary`)) === 0
  );
}

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
  if (emptyVerdict(unit) || bareVerdict(unit)) return 'empty_verdict';
  if (ofTheWorks(unit)) return 'scaffolding';
  if (againstFigure(unit, reading.figures)) return 'against_figure';
  if (deniesClaim(unit, reading)) return 'denies_claim';
  if ((reading.opened === 'contradiction' || reading.opened === 'held') && AGREES.test(text)) return 'agrees';
  const decided =
    reading.referral !== null && reading.referral !== 'wellbeing' && reading.referral !== 'grants';
  if (decided && rulesTerms(unit)) return 'rules';
  if (reading.opened === 'held' && picksHeld(text, reading.heldOptions ?? [])) return 'rules';
  if (STARTS_WITH.test(text)) return 'second_plan';
  if (wrongErrand(text, guidance)) return 'wrong_errand';
  if (reading.inOrder && COMFORTS.test(text)) return 'comforts';
  if (reading.kind === 'pushback' && DEFENDS.test(text)) return 'defends';
  if (reading.kind === 'integrity' && FRIENDS.test(text) && !NO_FRIENDS.test(text)) return 'friends';
  // A question is held apart, a line that announces waits for what it announces, and a draft is as long as it is.
  if (lead === '' || guidance.draft === true || /[?:]["'”’)]*$/u.test(text) || isListUnit(unit)) return null;
  return addsToLead(unit, reading, lead) ? null : 'adds_nothing';
}

/** A question of the method's own table (validators/method.ts), as it stands in a sentence. */
export const FROM_THE_TABLE =
  /\bwhat (?:they|he|she) spent on (?:this|it) last time\b|\bwhen (?:they|he|she) last (?:dealt with|had|did) (?:it|this)\b/iu;

/** Whether a reply makes a claim it was given. */
export function makesPoint(point: string, said: ReadonlySet<string>, share = 0.5): boolean {
  const own = new Set([...stemsOf(point)].filter((w) => !EMPTY.has(w)));
  return own.size === 0 || sharedCount(own, said) / own.size >= share;
}
