import type { PromptGuidance } from '../prompts/guidance.js';
import { knownNumbersIn, numbersIn, spelledNumbersIn } from './figures.js';
import { sharedCount, stemOf, stemsOf } from './stems.js';

/**
 * A reply whose message was read (`PromptGuidance.reading`): the writer writes all of it, and a sentence of it goes only for
 * what is false or not the writer's to say. Deterministic, per unit, with the reason in a word.
 *
 * 1. nothing speaks of how the turn was prepared, or of them as someone else;
 * 2. nothing goes against the figure code worked out (its sign, its size), says that something is what a claim says it is
 *    not, says a number they took back, or concludes a sum that nobody worked out;
 * 3. nothing agrees with what the record denies, or rules on what a person decides;
 * 4. friends are no evidence, and made-up work never has friends in its place.
 */

type Reading = NonNullable<PromptGuidance['reading']>;

const plain = (text: string): string =>
  text
    .replace(/\[\s*E\d+[^\]]*\]/giu, '')
    .replace(/[‘’ʼ]/gu, "'")
    .replace(/[*_]+/gu, '')
    .replace(/^\s*(?:[-•+]|\d{1,3}[.)])\s+/u, '')
    .trim();

const DOES =
  /^(?:(?:so|and|then|now|first|next|instead|today|tonight|tomorrow|this week)[,:]? )*(?:(?:you (?:can|could|should|need to|might)|i(?:'d| would)|let's) (?:(?:just|also|first) )?)?(?:ask|call|ring|email|e-mail|message|text|write|send|offer|sell|charge|count|track|mark|list|show|bring|take|tell|visit|talk|meet|book|try|run|test|set|price|cut|stop|drop|pick|choose|give|get|put|make|print|post|check|read|open|close|hand|pay|split|compare|measure|start|begin|use|say|reply|answer|wait|hold)\b/iu;

const figures = (text: string): number[] => [...numbersIn(text), ...spelledNumbersIn(text)];

const AGREES =
  /^(?:yes|yeah|yep|sure|absolutely|exactly|right|that(?:'s| is) (?:fair|right|true|fine|ok(?:ay)?|honest|accurate)|it(?:'s| is) (?:fair|fine|honest|accurate)|you(?:'re| are) (?:right|correct)|fair enough|agreed)\b|\b(?:matches|is consistent with|lines up with|fits with|is in line with) what (?:you|the|your)\b/iu;
/** A verdict on an offer, terms, a price named for a part of it, or a split. */
const RULES_TERMS =
  /\b(?:good|great|fair|bad|low|high|strong|weak|cheap|expensive|reasonable|decent|generous|solid|right|standard)\b[^.!?]{0,30}\b(?:price|offer|deal|terms?|valuation|split|share|stake|amount)\b|\b(?:price|offer|deal|terms?|valuation|split|stake|\d{1,3}\s?[/-]\s?\d{1,3})\b[^.!?]{0,30}\b(?:is|are|looks?|seems?|sounds?) (?:a )?(?:very |pretty |quite )?(?:good|great|fair|bad|low|high|strong|weak|cheap|reasonable|decent|generous|right|standard|fine|ok)\b|^(?:yes,? )?(?:take|accept|sign|agree to|go with) (?:it|the|this|that|his|her|their)\b/iu;
const ASKS_FIRST =
  /\b(?:before (?:you (?:sign|answer|agree|say|take|accept)|(?:an?|the|your) (?:lawyer|office|\w+ (?:has|have) (?:read|said)))|until|unless|whether|not|never|don't|only|ask|lawyer|who decides|decides?)\b/iu;

const FRIENDS =
  /\b(?:friends?|roommates?|room mates?|flatmates?|family|your (?:mom|dad|parents|sister|brother))\b/iu;
const NO_FRIENDS =
  /\b(?:not|no|never|n't|except|without|instead of|rather than|other than|beyond|outside|do not count|don't count)\b/iu;

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
export function withoutWorks(said: string): string {
  // The server's own way to open a denial, said by the model of something else.
  const raw = said.replace(
    /^(\s*[*_]*)your (?:own )?(?:numbers|record|data) (?:say|says|speak|speaks) (?:otherwise|against (?:it|that|this))(?: too)?:\s+(\p{L})/iu,
    (_m, gap: string, c: string) => `${gap}${c.toUpperCase()}`,
  );
  if (raw !== said) return raw;
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
  /^(?:(?:a|the) qualified (?:person|professional) (?:decides|must decide|should decide|needs to decide|has to decide)\b|bring:\s|who decides (?:what to bring|it|this|that)\b[^.!?]*\?)/iu.test(
    plain(unit),
  );

/** Who decides, as a line with nobody doing anything ("A startup lawyer, and you start with your EIR."). */
export function namesWho(unit: string, who: string): boolean {
  const said = stemsOf(plain(unit));
  if (said.size < 2 || !/^(?:an?|the|your)\b/iu.test(plain(unit))) return false;
  const own = stemsOf(`${who} start lawyer office person`);
  return (
    sharedCount(said, own) / said.size >= 0.75 &&
    !/\b(?:talk|ask|see|bring|book|call|email|meet|decides?|reads?|says?|tells?|helps?|is|are|can|will)\b/iu.test(
      plain(unit),
    )
  );
}

// Beside a figure -----------------------------------------------------------------------------------------------------

const LOSES =
  /\b(?:you(?:['’]re| are)? (?:still |now |actually )*(?:los(?:e|ing) (?:money|overall|\$)|in the red|at a loss|underwater|negative)|(?:that|this|it)(?:['’]s| is) (?:still )?a loss|los(?:e|ing) money (?:overall|on (?:each|every|it))|don['’]t (?:make|earn|keep) (?:anything|money)|nothing (?:is )?left)\b|\b(?:leaves?|left with|keep) (?:you )?(?:with )?\$0(?![\d.,])|\$0 (?:is )?left\b/iu;
const GAINS =
  /\b(?:you(?:['’]re| are)? (?:still |now )*(?:mak(?:e|ing) (?:money|a profit)|profitable|in the black|earn(?:ing)? money|ahead)|(?:that|this|it)(?:['’]s| is) (?:still )?a profit)\b/iu;
/** A loss that is there already, whatever the rest supposes. */
const THE_LOSS =
  /\b(?:the|this|that|your) loss(?:es)? (?:will |would |can |could |only |still )?(?:gets?|grows?|widens?|doubles?|shrinks?)\b/iu;
const IF = /\b(?:if|unless|once|until|would|could|might|when|without|before)\b/iu;
const COMPARES =
  /^(?:so |and )?(?:that(?:['’]s| is)|this is|it(?:['’]s| is)|you (?:keep|make|earn|need|have)|which is) (?:only |just |still |about )?(less than|under|below|fewer than|more than|over|above|at least|at most) (\$?)([\d][\d,.]*)/iu;

/** Whether a unit goes against a figure code worked out: its sign, or its size. */
export function againstFigure(unit: string, figures: Reading['figures']): boolean {
  const all = figures ?? [];
  if (all.length === 0) return false;
  const text = plain(unit);
  const money = all.filter((f) => f.unit === '$');
  if (money.length > 0 && money.every((f) => f.value > 0) && THE_LOSS.test(text)) return true;
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

/** A number they took back in this message, said as it was. */
function saysGone(text: string, gone: readonly number[]): boolean {
  return (
    gone.length > 0 &&
    !/\b(?:not|no longer|instead|before|was|were|used to|from|down|up)\b/iu.test(text) &&
    figures(text).some((n) => gone.includes(n))
  );
}

/** A figure they ask for that nobody worked out, concluded by the model in plain words: no marker, and no sum of code's. */
const CONCLUDES =
  /\b(?:fewest|least|lowest|minimum|at least|break(?:s|ing)? ?even|(?:need|have|must) (?:to )?sell|to cover|pays? (?:for itself|it back|off)|earn(?:s|ed)? (?:it|that) back)\b/iu;
function concludes(text: string, guidance: PromptGuidance): boolean {
  const { reading } = guidance;
  if (reading === undefined || (reading.figures ?? []).length > 0 || text.includes('[[')) return false;
  if (guidance.asksSum !== true && (guidance.calc ?? []).length === 0) return false;
  const known = knownNumbersIn(`${guidance.said ?? ''}\n${(guidance.calc ?? []).join('\n')}`);
  return CONCLUDES.test(text) && figures(text).some((n) => !known.some((k) => Math.abs(k - n) < 0.005));
}

/** Whether a quotation is open at the end of `before`. */
export function inQuote(before: string): boolean {
  let open = false;
  for (const ch of before) {
    if (ch === '"') open = !open;
    else if (ch === '“') open = true;
    else if (ch === '”') open = false;
  }
  return open;
}

/** What hands over made-up work: "here are three", "these are made up, but". */
const MADE_UP_SAID =
  /^(?:here (?:are|is)|these are (?:made up|invented|examples)|this is (?:made up|invented))\b|\b(?:made up|invented),? but\b/iu;

/** Friends who like it, said as if it showed something. */
const FRIENDS_LIKE =
  /\b(?:friends?|roommates?|flatmates?|classmates?|family|dorm|hall|floor)\b[^.!?]{0,40}\b(?:love|loves|loved|like|likes|liked|want|wants|said|say)\b/iu;
const SHOWS_IT =
  /\b(?:shows?|proves?|means?|validat\w+|confirms?|signal|sign|proof|demand|evidence|promising|great)\b/iu;

/** Why a unit is cut from a reply whose message was read. */
export type FalseReason =
  | 'broken'
  | 'works'
  | 'against_figure'
  | 'denies_claim'
  | 'agrees'
  | 'rules'
  | 'gone'
  | 'own_sum'
  | 'friends'
  | 'made_up';

/** Why a unit of the writer's is false, or not theirs to say; null: it stands. */
export function falseUnit(unit: string, guidance: PromptGuidance, before = ''): FalseReason | null {
  const { reading } = guidance;
  if (reading === undefined) return null;
  const text = plain(unit);
  if (text === '') return null;
  if (ofTheWorks(unit) || (guidance.referral !== null && echoesReferral(unit))) return 'works';
  if (guidance.referral !== null && namesWho(unit, guidance.referral.who)) return 'broken';
  // A line to say or send is theirs to change: none of its sentences is read alone.
  if (/^["“]/u.test(text) || inQuote(before)) return null;
  if (againstFigure(unit, reading.figures)) return 'against_figure';
  if (deniesClaim(unit, reading)) return 'denies_claim';
  if ((reading.contradicts != null || reading.opened === 'held') && AGREES.test(text)) return 'agrees';
  const decided =
    reading.referral !== null && reading.referral !== 'wellbeing' && reading.referral !== 'grants';
  if (decided && rulesTerms(unit)) return 'rules';
  if (reading.opened === 'held' && picksHeld(text, reading.heldOptions ?? [])) return 'rules';
  if (saysGone(text, reading.gone ?? [])) return 'gone';
  if (concludes(text, guidance)) return 'own_sum';
  if (NO_FRIENDS.test(text)) return null;
  if (reading.kind === 'integrity' && FRIENDS.test(text)) return 'friends';
  if (reading.kind === 'integrity' && MADE_UP_SAID.test(text)) return 'made_up';
  return FRIENDS_LIKE.test(text) && SHOWS_IT.test(text) ? 'friends' : null;
}
