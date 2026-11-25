import { stemsOf } from '../validators/stems.js';
import { figuresIn } from './figures.js';
import type { UnderstoodReferral } from './types.js';

/**
 * What a message itself says of three things the calls may miss: whether something happened (a verdict needs an outcome), who
 * has to decide it, and a second question in it. Narrow on purpose: each only adds what the words leave no doubt of. Pure.
 */

const sentencesOf = (message: string): string[] =>
  message
    .split(/(?<=[.!?;])\s+|\n+|\s\/\/\s|,? (?=but )/u)
    .map((s) => s.trim())
    .filter((s) => s !== '');

// An outcome -----------------------------------------------------------------------------------------------------------

/** Somebody did something, or it came out so. */
const HAPPENED =
  /\b(?:said|told|sold|bought|paid|signed|booked|ordered|cancel+ed|refused|declined|agreed|replied|answered|wrote|writes|emailed|texted|messaged|called (?:me|us|them|him|her|back|\d|the |a )|rang|phoned|came|returned|left|quit|stopped|joined|offered|sent|showed up|turned up|turned .{1,28}? down|asked (?:me|us)|writes? (?:me|us)|tried|tested|rented|subscribed|prepaid|pre-?ordered|pulled out|dropped|clicked|scanned|downloaded|installed|won|lost|launched|approved|rejected|liked|loved|hated|laughed|cried|asked (?:for|if|whether|them|him|her|\d)|interviewed|talked (?:to|with)|spoke (?:to|with)|met with|pitched|presented|renewed|complained|promised|lent|pays|loves?)\b/iu;
/** Plain present of a second-language speaker. */
const THEY_DO =
  /\b(?:students?|customers?|clients?|buyers?|guests?|people|peoples?|they|he|she|mothers?|famil(?:y|ies)|kids|neighbou?rs?) (?:\w+ )?(?:say|says|buy|buys|pay|pays|come|comes|write|writes|ask|asks|return|returns|complain|complains)\b/iu;
/** "Got 12 answers", "did four", "had 30 people". */
const HAD_SOME = /\b(?:got|had|made|did|ran|run|held|given|have|has|went|reached|hit)\b/iu;
/** Their time, what they have and what it costs count nothing that came of it. */
const OF_MEANS =
  /\b(?:hours?|hrs?|weeks?|days?|minutes?|months?|exams?|dollars?|bucks|bank|budget|saved)\b|\$/iu;
/** Somebody else will do it for them. */
const PROMISED =
  /(?<!\b(?:i|we|you)) (?:will|would|['’]ll|['’]d) (?:lend|give|take|pay|let|host|carry|stock|put|buy|book)\b.{0,16}\b(?:us|me|our|my|\d+)\b/iu;
/** Not so, or not yet. */
const NOT_SO =
  /\b(?:would|will|might|could|should|want to|wanna|hope|hopes|plan|plans|planning|going to|gonna|gotta|thinking (?:of|about)|what if|suppose|imagine|once i|when i)\b|(?:^|[,;] ?)if\b|\beven if\b/iu;
const NOT_DONE =
  /\b(?:did ?n['’]?o?t|have ?n['’]?t|haven['’]?t|never|not yet|could ?n['’]?t|keep (?:opening|putting|not))\b/iu;
/** Advice is no outcome. */
const ADVISED =
  /\b(?:says?|said|tells?|told|thinks?|wants)\b(?: me| us)?(?: to| that)? (?:we|i|you|to|get|keep|make|add|sell|charge|hire|do|go|put|start|stop|ask|focus|drop|raise|just|should)\b/iu;
/** Afraid of it, or low about it. */
const AFRAID =
  /\b(?:nervous|scared|afraid|anxious|worried|shy|shaky|terrified|embarrass\w*|overwhelm\w*|dread\w*|freak\w*|panick\w*|stress\w*|bad at|put(?:ting)? (?:it|this|that) off|can['’]?t sleep|feel (?:so |really |like |kind of )?(?:bad|stupid|dumb|behind|lost|alone)|burn(?:ed|t) out|guilty)\b/iu;

/** Whether a message tells an outcome: what somebody did or said, or a count of it. */
export function tellsOutcome(message: string): boolean {
  return sentencesOf(message).some((s) => {
    if (ADVISED.test(s)) return false;
    const counts = figuresIn(s).length > 0;
    const did = HAPPENED.test(s) || THEY_DO.test(s);
    if (s.endsWith('?') && !(did && counts)) return false;
    if (ASKING.test(s)) return false;
    if (PROMISED.test(s) && !/^(?:if|what if)\b/iu.test(s)) return true;
    if (NOT_SO.test(s) && !/\b(?:said|told|offered|promised|asked|wrote|paid|bought)\b/iu.test(s))
      return false;
    if (NOT_DONE.test(s) && !counts) return false;
    return did || (counts && HAD_SOME.test(s) && !OF_MEANS.test(s));
  });
}

/** Whether they ask what something told just before is worth. */
const OF_IT =
  /\b(?:is|was|isn['’]?t) (?:that|this|it)\b.{0,20}\b(?:good|bad|ok(?:ay)?|enough|proof|normal|fine|low|high|a (?:yes|no|result))\b|\bgood or (?:bad|not)\b|\bdo(?:es)? (?:that|this|it) (?:mean|show|prove|count)\b|\bwhat (?:does|do|did) (?:that|this|it|they|i)\b.{0,16}\b(?:mean|show|tell|prove|learn)\b/iu;

/** Whether a verdict may stand: over an outcome told now, or told before and asked about. Never over a fear or a question. */
export function verdictStands(message: string, earlier: readonly string[], read: boolean): boolean {
  if (tellsOutcome(message)) return true;
  if (OF_IT.test(message) && earlier.slice(-2).some(tellsOutcome)) return true;
  // The call reads a result where no word of it says so: a plain statement with a count, and no fear.
  return (
    read &&
    !AFRAID.test(message) &&
    !message.includes('?') &&
    !NOT_SO.test(message) &&
    figuresIn(message).length > 0
  );
}

/** Only people close to them, and only kind words. */
export const onlyPraise = (message: string): boolean =>
  /\b(?:friends?|family|mom|mum|dad|parents|aunts?|uncles?|brothers?|sisters?|roommates?|cousins?|grandm\w+|girlfriend|boyfriend|floor|teammates?|classmates?)\b/iu.test(
    message,
  ) &&
  !/\b(?:paid|pays?|bought|sold|deposit\w*|prepaid|ordered|signed|strangers?|customers?)\b/iu.test(message);
/** Money, a signature, or coming back. */
export const gaveSomething = (text: string): boolean =>
  /\b(?:paid|pays?|paying|bought|sold|signed|ordered|order\w*|came back|come back|again|return\w*|renew\w*|deposits?|prepaid|rented|rents?|booked|subscrib\w*|orders)\b/iu.test(
    text,
  );

/** A promise, a change of plan or a record put right, and nothing asked: what they tell is an update. */
export const tellsUpdate = (message: string): boolean =>
  !message.includes('?') &&
  /^\W*(?:(?:ok(?:ay)?|got it|cool|great|fine|alright|so)[,. ]+)*(?:(?:i|we)(?:['’]ll| will|['’]?m (?:going to|gonna)| am going to| are going to)\b|(?:i|we)(?:['’]m|['’]re| am| are) (?:changing|switching|pivoting|stopping|dropping)\b|change (?:it|of plans?)\b)|\b(?:is|are|it['’]s) \S+ now,? (?:and )?not\b/iu.test(
    message,
  );

// Who decides ----------------------------------------------------------------------------------------------------------

interface Decides {
  readonly who: UnderstoodReferral;
  readonly all: readonly RegExp[];
}
const DECIDES: readonly Decides[] = [
  {
    who: 'legal',
    all: [
      /\b(?:letter|notice|e-?mail\w*|mail|wrote|writes|sent|sends|lawyers?|attorneys?|threat\w*)\b/iu,
      /\b(?:stop (?:using|selling)|cease|desist|infring\w*|trade ?marks?|copyright\w*|logos?|seal|crest|emblem|mascot|(?:our|my|the) name\b.{0,20}\b(?:too (?:close|similar)|theirs|taken)|too (?:close|similar) to|su(?:e|ing) (?:us|me)|legal action|take (?:it|them|that) down)\b/iu,
    ],
  },
  {
    who: 'legal',
    all: [
      /\b(?:contract|agreements?|sign\w*|terms|clauses?|draft|paper(?:work|s)?|form|letter of intent|loi|version|distributor|buyer|district|they want|wants? us|they own)\b/iu,
      /\b(?:exclusiv\w*|(?:to|with) (?:nobody|no one) else|source ?code|escrow|indemnif\w*|non-?competes?|owns? (?:any|every|all)\b.{0,30}\b(?:change|work|idea|code|improvement)|personal guarantee|auto-?renew\w*|penalt(?:y|ies)|liable|liability)\b/iu,
    ],
  },
  {
    who: 'equity',
    all: [
      /\b(?:shares|equity|stake|(?:\d{1,2} ?(?:%|percent)|third|quarter|half|tenth|piece|bit|part|slice) of (?:the |my |our )?(?:company|business|startup|venture))\b|\b(?:third|quarter|half|tenth|\d{1,2} ?(?:%|percent)) of it (?:instead|for|in place)\b/iu,
      /\b(?:invest\w*|gives? (?:us|me)|puts? in|putting in|offer\w*|wants?|instead of (?:pay|money|salary|wages)|asks? for|in return|for \$?\d)\b/iu,
    ],
  },
  {
    who: 'irb',
    all: [
      /\b(?:kids?|children|toddlers?|babies|patients?|residents|minors|daycare)\b/iu,
      /\b(?:record(?:ing)?|log(?:ging)?|measure|monitor|track|study|trial|experiment|collect)\b/iu,
      /\b(?:them|their|how they|under|on|with|give|put|her|his)\b/iu,
    ],
  },
  {
    who: 'regulatory',
    all: [
      /\b(?:heals?|cures?|treats?|prevents?|detects?|diagnos\w+|lowers? (?:blood|cholesterol|anxiety|stress|sugar)|relieves?)\b/iu,
      /\b(?:say|says|claim|claims|label|flyer|site|page|poster|ads?|write|put|package|sign)\b/iu,
      /\b(?:eczema|asthma|pain|anxiety|depression|blood|pressure|diabetes|allerg\w+|disease|illness|infection|cancer|insomnia|acne|symptoms?|attacks?|arthritis|migraines?|adhd)\b/iu,
    ],
  },
  {
    who: 'immigration',
    all: [
      /\b(?:visa|f-?1|j-?1|on opt|on cpt|green card|immigration|international student)\b/iu,
      /\b(?:pay|pays|paid|salary|payroll|wages?|work|working|job|hire|earn|own company|my company)\b/iu,
    ],
  },
];
/** It is done with. */
const DONE_WITH =
  /\b(?:handled|settled|sorted|resolved|dealt with|taken care of|already (?:signed off|read|checked))\b/iu;

/** Who the message leaves no doubt must decide; null: it names nobody. */
export function decidedBy(message: string): UnderstoodReferral | null {
  // Sentence and the next together: "they sent a letter. it says to stop using the logo".
  const parts = sentencesOf(message);
  const near = parts.map((s, i) => `${s} ${parts[i + 1] ?? ''}`).filter((s) => !DONE_WITH.test(s));
  return DECIDES.find((d) => near.some((s) => d.all.every((re) => re.test(s))))?.who ?? null;
}

// A second question ----------------------------------------------------------------------------------------------------

const ASKING =
  /^(?:(?:and|also|but|so|ok|okay|um|uh|like|or|plus|then|oh|btw|then)[ ,]+)*(?:how|what(?:['’]?s)?|when|where|who|why|which|is|are|am|do|does|did|can|could|should|shld|would|will)\b/iu;
const TAGS = /^(?:\W*(?:right|ok|okay|no|yes|huh|lol|idk|you know|isn['’]?t it)\W*)$/iu;

/** The second thing a message asks, in their words, where it asks two; null: it asks one. */
export function secondQuestion(message: string, ask: string): string | null {
  const clauses = message
    .split(
      /(?<=[.!?;])\s+|\n+|,? (?=(?:and|also|but|plus) (?:also )?(?:how|what|whats|when|where|who|why|which|is|are|do|does|can|should|would|will)\b)|(?<=\w) (?=also\b)/iu,
    )
    .map((c) => c.replace(/[?!.,;\s]+$/u, '').trim())
    .filter((c) => c !== '' && !TAGS.test(c) && ASKING.test(c) && c.split(/\s+/u).length >= 3);
  const [first, ...more] = clauses;
  if (first === undefined) return null;
  const asked = stemsOf(`${ask} ${first}`);
  const second = more.find((c) => {
    const own = [...stemsOf(c)];
    return own.length > 0 && own.filter((w) => !asked.has(w)).length >= Math.max(1, own.length / 2);
  });
  return second === undefined
    ? null
    : second
        .replace(/^(?:(?:and|also|but|so|plus|then|oh|btw)[ ,]+)+/iu, '')
        .split(/\s+/u)
        .slice(0, 20)
        .join(' ');
}
