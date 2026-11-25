import { READING_EXAMPLE } from '../prompts/guidance.js';
import { numbersIn } from './figures.js';
import { coverage, stemOf, stemsOf } from './stems.js';
import { unitsOf, wordsIn } from './units.js';

/**
 * The method lint (2026-11-25, the strict judge on live news and judgement replies: 1 to 2 of 5 on critical reading): a
 * sentence of the model's that contradicts the method the programme teaches, or reads more into a fact than it shows, is
 * put right or left out. Deterministic, one unit (a sentence, a list item) at a time, so a streamed reply waits for
 * nothing:
 *
 * 1. a question about a future nobody can know, given to the founder to ask someone ("How much would you pay?"), becomes
 *    the one about the past that the programme teaches in its place;
 * 2. a survey as the next thing to do; a pass line on what people say they would do;
 * 3. sign-ups, a spoken yes, kind words or a few payments read as demand, proof, a market, "validated";
 * 4. praise, and sentences that say nothing ("This is the core of your venture");
 * 5. an empty bracket; a question they answered in this very message;
 * 6. a price set above what the customer pays now, or by what people say they would pay; a verdict on a price from a
 *    comparison that cannot carry it (a total against the price of one).
 *
 * A sentence that warns of these says the same words and stays: each rule reads what the words claim (who proves what,
 * denied or not, only if, only to), never a word alone (method.test.ts holds both, and the whole playbook: it must pass).
 */
export type MethodFinding =
  | 'hypothetical_question'
  | 'survey'
  | 'stated_pass_line'
  | 'over_claim'
  | 'praise'
  | 'filler'
  | 'empty_bracket'
  | 'answered_question'
  | 'price_rule'
  | 'verdict_without_basis';

export interface MethodUnit {
  /** The unit as it may be said; '' when nothing of it may. */
  readonly text: string;
  readonly findings: readonly MethodFinding[];
}

export interface MethodContext {
  /** The founder's message: what they just told is never asked, and what they counted may be read as it is. */
  readonly founderText?: string;
  /** What the reply said before the unit: whether a question is given to ask, and which was given already. */
  readonly before?: string;
}

// Reading a sentence -----------------------------------------------------------------------------------------------

/** The text with straight quotes, character for character (positions hold), and emphasis as spaces. */
const straight = (text: string): string =>
  text.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/[*_]/g, ' ');

/** Words that deny, or keep open, what follows them in their clause. */
const DENIES =
  /\b(?:not|never|no|nothing|nobody|no one|none|neither|nor|hardly|barely|rarely|seldom|cannot|without|instead of|rather than|avoid(?:ing)?|skip(?:ping)?|stop|drop|beware|far from|less than|too (?:early|few|small)|\w+n't)\b/iu;
/** Words that make what follows a condition, a plan or a definition, never a claim about what they found. */
const OPEN =
  /\b(?:if|when|once|until|unless|whether|would|could|might|may|can|should|must|to|only|what|which (?:one|of)|how|before|imagine|suppose|think(?:s|ing)?|hopes?|hoping|wants?|needs?|looks?(?: like)?|seems?|feels?|as if|as though|even if|call(?:ing|s)?|treat(?:ing|s)?|count(?:ing|s)?|read(?:ing|s)?|mistak(?:e|ing|es)|assum(?:e|es|ing)|claim(?:ing|s)?|say(?:ing|s)?|anyone|nobody|far more|more than|the (?:test|step|next|question|goal|point|thing|way))\b/iu;
/** Whether what follows a claim keeps it open, up to a "but". */
const opensAfter = (rest: string): boolean =>
  OPEN_AFTER.test(rest.split(/[,;:—–]?\s+(?:but|although|though|however)\b/iu)[0] ?? '');
/** What keeps a claim open after it ("… when strangers repeat it", "… only if they pay"). */
const OPEN_AFTER =
  /\b(?:(?:only )?(?:if|when|once|unless|until)\b|only (?:for|after|because|among)|before you|at most|at best)/iu;
/** A limit said right after it ("but it does not show they would pay"). */
const LIMITED =
  /(?:,|;|\bbut\b|—|–)[^.]*\b(?:not|yet|no|never|nothing|only|(?:does|do|did|is|are)n't|still (?:have|need|do|open|unknown)|unproven|untested|open)\b/iu;

/** The start of the clause that `at` is in. */
function clauseStart(text: string, at: number): number {
  const head = text.slice(0, at);
  let start = 0;
  for (const m of head.matchAll(/[,;:—–.!?]\s+|\s-\s|\b(?:but|and|so|while|though|which|because)\s+/giu))
    start = m.index + m[0].length;
  return start;
}

/** Money that changed hands, or was signed for: what counts. */
const PAYS =
  /\b(?:pay(?:s|ing|ments?|ers?)?|paid|deposits?|pre-?orders?|pre-?sales?|orders?|ordered|bought|buyers?|purchases?|sales?|sold|signed|contracts?|signatures?|cards?|cash|money|invoices?|subscribed|renew(?:s|ed|als?))\b/iu;
/** What costs nothing: attention, words, kindness. */
const WEAK =
  /\b(?:sign-?ups?|signed up|e-?mails?(?: addresses)?|addresses|likes?|liked|followers?|views?|visits?|visitors?|clicks?|downloads?|upvotes?|shares?|comments?|waitlist|wait list|waiting list|surveys?|poll|responses?|replies|answers?|feedback|compliments?|praise|friends?|family|mom|mum|dad|roommates?|housemates?|classmates?|teammates?|professors?|yes(?:es)?|interest|interviews?|conversations?|talks?|remembered|excited|enthusias\w+|hands?)\b/iu;
const SMALL_COUNT =
  /\b(?:one|two|three|four|five|six|seven|eight|nine|both|a couple|a few|a handful|several|some|[1-9])\b/iu;
const DEMONSTRATIVE =
  /^(?:(?:and|so|well|now|clearly|honestly|this|that|it|these|those|they|which|together|plus|also|altogether)\b[\s,]*)+(?:(?:alone|already|really|clearly|definitely|also|just|now)\s*)*$/iu;

/** Whether what they told, or the unit itself, counts at least this many who paid: enough to read as demand. */
const ENOUGH_PAID = 10;
function enoughPaid(text: string): boolean {
  return text.split(/(?<=[.!?;])\s+|,\s+/u).some((part) => {
    if (
      !/\b(?:paid|pay(?:ing)?|bought|ordered|pre-?ordered|sold|signed(?! up)|subscribed|renewed)\b/iu.test(
        part,
      )
    )
      return false;
    // People they do not know are the ones that count.
    if (
      /\b(?:nobody|no one|none|not|never|\w+n't)\b/iu.test(
        part.replace(/\b(?:do not|don['’]t) know\b/giu, ' '),
      )
    )
      return false;
    // How many did it, never how many were asked ("I asked 40 people and only 3 bought").
    const t = digitsOf(part.replace(/\$\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:dollars|bucks|usd|%|percent)/giu, ' '));
    const counts = [...t.matchAll(PAYERS), ...t.matchAll(WON)].map((m) => Number(m[1]));
    return counts.some((n) => n >= ENOUGH_PAID);
  });
}
const SPELLED: Readonly<Record<string, string>> = Object.fromEntries(
  'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'
    .split(' ')
    .map((w, i): [string, string] => [w, String(i)])
    .concat([
      ['thirty', '30'],
      ['forty', '40'],
      ['fifty', '50'],
      ['sixty', '60'],
      ['hundred', '100'],
    ]),
);
const digitsOf = (text: string): string => text.toLowerCase().replace(/\b[a-z]+\b/g, (w) => SPELLED[w] ?? w);
/** "14 marinas pay", "11 of 20 people ordered", "3 bought". */
const PAYERS =
  /(?<![\d.$])(\d+)(?: (?:of|out of) (?:the |my |our |those )?\d+)?(?: (?!(?:and|but|or|of|to|who|were|was|asked|said|did)\b)[a-z'-]+){0,3} (?:(?:have|has|had|already|now|each|who|that) )*(?:paid|pay|paying|bought|ordered|pre-?ordered|signed(?! (?:up|in|on)\b)|subscribed|renewed)\b/g;
/** "Sold 30 jars", "signed 12 clinics". */
const WON = /\b(?:sold|signed|won|got paid by|charged) (?:all |about |over )?(\d+)\b/g;

/**
 * Whether the claim at `at` (its verb) is one about what they found: its clause neither denies it nor keeps it open, and
 * its subject is not money in general ("A deposit proves more than a yes").
 */
function claimed(text: string, at: number, end: number, context: MethodContext): boolean {
  const start = clauseStart(text, at);
  // "What they said shows …" is about what they said; "what proves it" defines.
  const subject = text.slice(start, at).replace(WHAT_THEY_SAID, '').replace(WHAT_THIS_SAYS, '');
  if (DENIES.test(subject) || OPEN.test(subject)) return false;
  if (opensAfter(text.slice(end))) return false;
  if (/^\s*(?:if|when|once|until|unless|before|suppose|imagine)\b/iu.test(text)) return false;
  if (enoughPaid(`${context.founderText ?? ''}. ${text}`)) return false;
  if (DEMONSTRATIVE.test(subject.trim()) || subject.trim() === '') return true;
  if (PAYS.test(subject) && !WEAK.test(subject))
    return SMALL_COUNT.test(subject) || /\b(?:this|that|these|those|your|the)\b/iu.test(subject);
  return true;
}

// What is read into a fact -------------------------------------------------------------------------------------------

const HARD = String.raw`(?:prov(?:e|es|ed|ing)|confirm(?:s|ed|ing)?|validat(?:e|es|ed|ing)|demonstrat(?:e|es|ed|ing)|establish(?:es|ed|ing)?|guarantee(?:s|d)?)`;
const SOFT = String.raw`(?:show(?:s|ed|ing|n)?|mean(?:s|t)?|tell(?:s|ing)? (?:us|you|me)|told (?:us|you)|suggest(?:s|ed|ing)?|indicat(?:e|es|ed|ing)|signal(?:s|ed|ling|ing)?|reveal(?:s|ed)?|point(?:s|ed|ing)? to|reflect(?:s|ed)?|highlight(?:s|ed)?|speaks? to)`;
const STRONG = String.raw`(?:real|strong|clear|genuine|true|serious|solid|actual|proven|huge|big|great|high|significant|unmet|obvious|definite|growing|early|good|healthy|promising|plenty of|a lot of|lots of|validated)`;
const DEMAND = String.raw`(?:interest|demand|needs?|markets?|traction|appetite|pull|willingness|potential|opportunity|product-?market fit|validation|momentum|customer love)`;
const PEOPLE = String.raw`(?:people|customers|they|students|users|buyers|clients|families|parents|teachers|nurses|owners|founders|folks|shops|clinics|gyms|owners|your (?:\w+ )?(?:customers|users|audience|market)|the (?:\w+ )?(?:market|customers|users|team|buyers)|others|everyone|the world)`;
const WANTS = String.raw`(?:(?:really|truly|actually|already|clearly|do|definitely|genuinely) )*(?:will|would|want|need|care|love|value|like|crave|see (?:the |real |its )?(?:value|benefit)|(?:are|is) (?:willing|ready|happy|interested|eager|keen|hungry))`;
const IDEA = String.raw`(?:the|your|this|that) (?:\w+ )?(?:idea|concept|product|business|model|venture|solution|approach|pricing|price|service|offer|app)`;
const WORKS = String.raw`(?:(?:really|actually|already|clearly) )?(?:works?|is (?:working|viable|valid|fine|needed|wanted|good|right|solid|strong|sound|proven|real|on track|a (?:good|great|winner|real))|has (?:legs|potential|value|traction|a (?:real )?market|promise)|resonates?|solves (?:it|their|the|a real)|can (?:work|sell|succeed|scale)|will (?:work|sell|succeed|scale))`;
const THERE = String.raw`(?:(?:that )?(?:there(?:'s| is| are)|you(?:'ve| have)(?: now| already)?(?: got| found)?|you (?:found|got)) )`;
const THAT = String.raw`(?:(?:us|you) )?(?:(?:clearly|already|really|definitely) )?(?:that |how much |just how much )?`;

const CLAIMS: readonly RegExp[] = [
  // "… shows real interest", "which means there's a real need".
  new RegExp(
    String.raw`\b(?:${HARD}|${SOFT}) ${THAT}${THERE}?(?:is )?(?:an? |some |the |that )?${STRONG} (?:\w+[ -]){0,2}?${DEMAND}\b`,
    'giu',
  ),
  // "… proves demand", "confirms the market", "validates your idea".
  new RegExp(
    String.raw`\b${HARD} (?:that )?${THERE}?(?:an? |the |your |some |market |customer |buyer )*(?:${DEMAND}|idea|concept|business(?: model)?|product|problem|hypothesis|hunch|theory|instincts?|gut feeling|assumption|solution|approach|price|value(?: proposition)?)\b`,
    'giu',
  ),
  // "… proves people will pay", "it shows they see the value".
  new RegExp(String.raw`\b${HARD} ${THAT}${PEOPLE} ${WANTS}\b`, 'giu'),
  new RegExp(String.raw`\b${HARD} ${THAT}(?:${IDEA}|it|this) ${WORKS}`, 'giu'),
  new RegExp(String.raw`\b${SOFT} ${THAT}${IDEA} ${WORKS}`, 'giu'),
  new RegExp(
    String.raw`\b${SOFT} ${THAT}(?:it|this) (?:works|has (?:legs|potential|a market)|is working)\b`,
    'giu',
  ),
  new RegExp(
    String.raw`\b${SOFT} ${THAT}${THERE}(?:an? |the )?(?:real |paying |proven |big |clear |good )?(?:${DEMAND}|business|customer segment|paying customers|customers|audience)\b`,
    'giu',
  ),
];
/** What is said to be known, clear or proven, with no verb of proof: "it's clear that students want this". */
const SAID_KNOWN: readonly RegExp[] = [
  /\b(?:real|clear|strong|solid|good|early|great|hard) (?:evidence|proof|signs?) (?:that|of (?:demand|interest|need|a market|value|traction))\b/giu,
  new RegExp(
    String.raw`\bthere(?:'s| is)(?: now| already)? (?:clearly|definitely|obviously|certainly|plenty of|a lot of|lots of) (?:\w+ )?(?:${DEMAND})\b`,
    'giu',
  ),
  new RegExp(
    String.raw`\b${PEOPLE} (?:clearly|obviously|definitely) (?:do )?(?:love|want|need|like|value|care)\b`,
    'giu',
  ),
  /\b(?:perform(?:ed|s|ing)|did|doing|going|went|worked|working) (?:really|very|so|extremely|incredibly|super) (?:well|great)\b/giu,
  new RegExp(
    String.raw`\b(?:it(?:'s| is)(?: now| already)? (?:clear|obvious|evident|plain|safe to say|fair to say)|you(?: now| already)? (?:know|can (?:see|tell|say)|have shown|have seen)|we(?: now| already)? know|no doubt|clearly|obviously),? (?:that )?(?:(?:${PEOPLE}|\w+s) ${WANTS}|${THERE}(?:an? |real |strong |clear )*(?:${DEMAND}|customers)\b)`,
    'giu',
  ),
  new RegExp(String.raw`\b(?:${HARD}|${SOFT}) [^.,;]{0,40}? and (?:that )?${PEOPLE} ${WANTS}\b`, 'giu'),
  new RegExp(
    String.raw`\b(?:the|your|this) (?:${DEMAND}|idea|concept|model|price|pricing|need|business) is (?:now |already |clearly |basically )*(?:proven|proved|confirmed|validated)\b`,
    'giu',
  ),
  /\b(?:the|that the|your) (?:need|demand|interest|market|appetite) (?:is|are) (?:really |clearly |definitely )?(?:real|there|strong|clear|proven|huge)\b|\bthat the (?:need|demand|interest|market) exists\b/giu,
  /\byou(?:'re| are) (?:really |clearly |definitely )?on(?:to| to) something\b|\byou have something (?:that )?(?:people|they|customers|students|users) (?:really )?(?:need|want|love|will pay|would pay)\b/giu,
  /\byou (?:clearly|definitely|already|now|obviously) have (?:an? |some |real |strong |clear |genuine )*(?:traction|demand|interest|momentum|a market|market|product-?market fit|pull)\b/giu,
  /\b(?:the|this is the|that's the|exactly the) kind of (?:signal|result|traction|number|response|evidence|proof|news|start)\b/giu,
];
/** "A 5% conversion is really encouraging": a verdict with no noun. */
const GLOWS =
  /(?:'s|\bis|\bare|\bwas|\blooks|\bsounds|\bfeels) (?:(?:really|very|pretty|quite|truly|super|genuinely|extremely|so|already|incredibly|hugely) )*(?:encouraging|promising|impressive|exciting|fantastic|amazing|awesome|remarkable|excellent|outstanding|wonderful|brilliant|incredible|phenomenal)(?=\s*(?:[.!,;:—–]|$| for (?:an?|your|this)\b| at this\b| news| so))/giu;

/** They remembered it, so they are keen. */
const KEEN = new RegExp(
  String.raw`\b(?:remembered|signed up|replied|answered|clicked|opened it|responded)\b[^.]{0,20} and (?:are|is|were|seem) (?:still |really |clearly )?(?:interested|keen|excited|engaged)\b`,
  'giu',
);
/** A soft reading of people ("it tells us people care"): stays when the sentence says its limit. */
const SOFT_PEOPLE = new RegExp(
  String.raw`\b${SOFT} ${THAT}${PEOPLE} (?:${WANTS}(?! to (?:know|talk|see|hear))|(?:will|would) pay)\b`,
  'giu',
);
/** "You have a market", "there is clearly real demand", "you've validated it": said of them, with no verb of proof. */
const STANDING: readonly RegExp[] = [
  new RegExp(
    String.raw`\b(?:you(?:'ve| have| now have| already have)(?: now| already)?(?: got| found| proven| proved| shown| validated| hit| reached)?|there(?:'s| is)(?: clearly| definitely| now| already| obviously)?) (?:an? |some |your )?(?:(?:real|clear|strong|proven|genuine|solid|early|true|obvious|validated|growing|serious) )(?:\w+ ){0,1}?(?:${DEMAND}|customer segment|customers|audience|business|product|idea)\b`,
    'giu',
  ),
  /\byou(?:'ve| have| now have| already have)(?: now| already| just)?(?: got| found| reached| hit| achieved)? (?:product-?market fit|traction|a (?:market|customer segment|winner|viable business|real business))\b/giu,
  /\byou(?:'ve| have)(?: now| already| just| basically| essentially)? (?:proven|proved|validated|confirmed)\b(?! (?:nothing|only|that (?:one|two|a few)))/giu,
];
const VALIDATED: readonly RegExp[] = [
  /\b(?:is|are|was|were|been|gets?|now|already|fully|partly) (?:now |already |fully |pretty much |clearly |basically )*validated\b/giu,
  /\b(?:is|are|was|that's|it's|this is) (?:\w+ ){0,2}(?:validation|proof of (?:demand|the market|interest|value)|proof (?:that )?(?:people|they|there|the market|customers|students|your (?:idea|price|concept)))\b/giu,
];
/** A price set by what people say, or above what the workaround costs: the program's is below that, and above one's own cost. */
const PRICE_RULE: readonly RegExp[] = [
  /\b(?:price|charge|fee|set it)\b[^.;]{0,60}\babove (?:the (?:price|cost) of )?(?:the |their |that |your )?(?:alternatives?|workarounds?|current (?:fix|solution|cost|way)|what (?:they|people|customers|students) (?:pay|paid|spend|spent)(?: now| today)?)\b/iu,
  /\bprice (?:it )?above (?:it|that|this|them|the alternatives?)\b/iu,
  /\b(?:that|this|the) (?:sum|total|cost|number|amount|price of the alternative) (?:is|becomes|sets) (?:the |your )?(?:floor|minimum|lowest)(?: (?:for|of) (?:your|the))? (?:price|fee)?\b/iu,
  /\b(?:price|charge|fee|set)\b[^.;]{0,80}\bwhat (?:they|people|customers|students|the \w+) (?:say|said|tell|told you) (?:that )?they(?:'d| would)(?: be willing to)? pay\b/iu,
];
/** "If that is more than $30, the raise is right": a total against the price of one, and a verdict on top. */
const NO_BASIS =
  /\bif (?:it(?:'s| is)?|that(?:'s| is)?|the (?:total|money|profit|sum|amount)|what (?:you keep|is left|'s left)|you keep|you make)(?: is| comes?(?: out)?| ends? up)? (?:higher|more|greater|above|bigger|over|better|lower|less) (?:than )?\$\s?\d[^.;]{0,40}?\b(?:raise|price|fee|increase|change|it) (?:is|was|works|holds|makes sense|was right)\b/iu;

/** "If they don't, you'll know $25 was the right price": a no to one price proves nothing of the other. */
const OTHER_PRICE_PROVEN =
  /\byou(?:'ll| will|'d| would) (?:then )?know (?:that )?(?:the )?\$?\s?\d[\d.,]* ?(?:dollars |price )?(?:is|was) (?:the |a )?(?:right|best|correct|better|fair)\b/iu;

/** "Their answer will tell us if there's a paying market", "this will show what price works": what words cannot tell. */
const WORDS_WILL_TELL =
  /\b(?:(?:their|the|these|those|your) (?:answers?|replies|responses|feedback|survey|results?)|(?:this|that|it)) (?:will|would|should|can|helps?|lets?) (?:also )?(?:(?:us|you|to) )?(?:help (?:us|you) )?(?:tell|show|reveal|prove|confirm|validate|know|see|learn|understand)(?: (?:us|you))? (?:if|whether|how much|what (?:price|they(?:'d| would))|which price|who(?:'d| would)|(?:that )?there(?:'s| is)) ?(?:there(?:'s| is)|they(?:'ll| will|'d| would)? ?(?:pay|buy|use|want)?|people|customers|students|works?|would|the|to charge|a)\b/iu;

const GOOD = String.raw`(?:solid|great|strong|good|promising|encouraging|excellent|positive|fantastic|impressive|nice|healthy|amazing|exciting|remarkable|wonderful|powerful|terrific|superb|super|awesome|incredible|brilliant|outstanding|smart|clever|decent|fine|big|huge|clear|useful|helpful|valuable|important|meaningful|respectable|perfect|real|genuine)`;
const THING = String.raw`(?:start|starts|signals?|signs?|results?|traction|numbers?|response|rates?|foundation|indicators?|momentum|proof|evidence|validation|margins?|progress|wins?|milestones?|achievements?|news|outcome|base|basis|conversion(?: rate)?|feedback|data points?|findings?|accomplishment|point|insight|indications?|beginning|turnout|work|job|effort|thinking|instinct|move|idea|news)`;
const WEAK_GOOD =
  /\b(?:clear|useful|helpful|valuable|important|meaningful|big|smart|fine|decent|real|genuine)\b/iu;
const WEAK_THING =
  /\b(?:starts?|signals?|signs?|indications?|results?|traction|response|momentum|validation|proof|milestones?|wins?|news|progress|beginning|turnout)\b/iu;
/** "That's a solid start", "Nine emails is a strong signal": a verdict on what they found. */
const VERDICT = new RegExp(
  String.raw`(?:'s|\bis|\bare|\bwas|\bwere|\bmakes?(?: for)?|\blooks like|\brepresents?|\bgives? you)(?: (?:also|already|really|actually|certainly|definitely|still|quite|such|truly|clearly))* (?:an? |the |some |such an? )?(?:(?:really|very|pretty|quite|truly|super|genuinely|early|incredibly) )*(${GOOD})(?:(?:,| and) ${GOOD})?(?: (?:early|first|initial|little|student|business|market|customer|buying|demand))* (${THING})\b`,
  'giu',
);

/** "What that shows is that they care": the claim, with its verb inside. */
const WHAT_THIS_SAYS = /^\s*what (?:this|that|it) $/iu;
const WHAT_THEY_SAID =
  /^\s*what (?:they|he|she|you|your \w+) (?:said|did|told you|have|heard|saw|found|got|did there)\b/iu;

/** Where a claim starts in the sentence that stands as one; null when there is none. */
function overClaim(text: string, context: MethodContext): number | null {
  for (const re of CLAIMS) {
    for (const m of text.matchAll(re)) {
      if (claimed(text, m.index, m.index + m[0].length, context)) return m.index;
    }
  }
  for (const m of text.matchAll(SOFT_PEOPLE)) {
    const end = m.index + m[0].length;
    if (claimed(text, m.index, end, context) && !LIMITED.test(text.slice(end))) return m.index;
  }
  for (const re of [KEEN, GLOWS, ...SAID_KNOWN, ...STANDING, ...VALIDATED]) {
    for (const m of text.matchAll(re)) {
      if (claimed(text, m.index, m.index + m[0].length, context)) return m.index;
    }
  }
  const words = WORDS_WILL_TELL.exec(text);
  if (words !== null && !DENIES.test(text) && !PAYS.test(text.slice(0, words.index))) {
    // "This will tell you if they pay" of an offer just made is the test itself.
    const offered =
      /^\s*(?:this|that|it)\b/iu.test(words[0]) && OFFERS.test((context.before ?? '').slice(-300));
    if (!offered) return 0;
  }
  return null;
}

/** A real offer, made in what was said before. */
const OFFERS =
  /\b(?:offer(?:s|ed|ing)?|sell(?:s|ing)?|charg(?:e|es|ing)|deposits?|pay now|pre-?orders?|orders?|price [AB])\b/iu;

/** Friends' and family's kindness read as more than that. */
const FRIENDS_PROVE =
  /\b(?:friends?|family|mom|mum|dad|parents|roommates?|housemates?|classmates?|professors?)\b[^.]{0,40}\b(?:love|loves|loved|like|likes|liked|excited|want|wants|said yes|think|thinks)\b[^.]{0,40}\b(?:so (?:you|there|it|that|the|keep|go)|which (?:shows|means|proves|is)|that (?:shows|means|proves)|good sign|great sign|is (?:a )?(?:good|great|encouraging|promising))/iu;

function verdict(text: string, context: MethodContext): { readonly at: number; readonly end: number } | null {
  for (const m of text.matchAll(VERDICT)) {
    const adjective = m[1] ?? '';
    const thing = m[2] ?? '';
    if (WEAK_GOOD.test(adjective) && !WEAK_THING.test(thing)) continue;
    const end = m.index + m[0].length;
    const start = clauseStart(text, m.index);
    const subject = text.slice(start, m.index).replace(WHAT_THEY_SAID, '');
    if (DENIES.test(subject) || DENIES.test(m[0]) || OPEN.test(subject) || opensAfter(text.slice(end)))
      continue;
    // What makes a good result in general: "A stranger who pays is a strong signal".
    if (
      PAYS.test(subject) &&
      !WEAK.test(subject) &&
      !SMALL_COUNT.test(subject) &&
      !/\b(?:this|that|these|those|your)\b/iu.test(subject)
    )
      continue;
    if (
      enoughPaid(`${context.founderText ?? ''}. ${text}`) &&
      /\b(?:result|signal|sign|traction|evidence)/iu.test(thing)
    )
      continue;
    if (/^\s*(?:if|when|once|until|unless)\b/iu.test(text)) continue;
    return { at: start, end };
  }
  return null;
}

// Praise and filler --------------------------------------------------------------------------------------------------

const PRAISE_OPEN =
  /^\s*(?:(?:hey|hi|hello)\b[^,.!?]{0,24},\s+)?(?:(?:wow|oh|ok(?:ay)?|well|and|so|honestly|first off)[,!]?\s+)*(?:congrat(?:s|ulations)|well done|kudos|bravo|way to go|hats off|nicely done|good for you|good stuff|love (?:it|this|that)|(?:that(?:'s| is|,?) )?(?:amazing|awesome|fantastic|brilliant|wonderful|impressive|incredible)(?= *[.!,;]|$)|(?:great|good|nice|excellent|amazing|fantastic|awesome|super|terrific|solid|strong|lovely) (?:job|work|going|progress|start|stuff|one|news|move|effort|thinking|call|instinct|question|hustle|initiative|momentum|energy|to (?:hear|see)))\b(?:\s+(?:on|with|for|at|to|getting|there|here|so far|that|in|already|this|from|,? \w+)\b[^.!?,;:—–]{0,60})?/iu;
const PRAISE_LINE: readonly RegExp[] = [
  /^\s*(?:it(?:'s| is) )?(?:great|amazing|awesome|fantastic|impressive|wonderful|brilliant|excellent|exciting|good) that (?:(?:an? )?\w+ )?(?:you|they|he|she|people|\w+ (?:people|customers|students))\b/iu,
  /^\s*(?:good|great|nice|excellent|amazing) (?:job|work) (?:\w+ing|on|with|at|getting|here)\b/iu,
  /^\s*(?:you(?:'re| are) on a roll|your (?:hard work|effort|persistence|hustle|dedication|grit) (?:is|has|will|shows|paid|pays)|you(?:'ve| have) (?:set yourself up|earned|come (?:so|a long) |built a (?:strong|solid|great)))/iu,
  /^\s*(?:that|this|it) (?:shows|takes|demonstrates) (?:great|real|true|a lot of|incredible|such) (?:initiative|courage|grit|dedication|drive|hustle|leadership|resilience|determination|guts|effort)\b/iu,
  /^\s*what an? (?:\w+ )?(?:achievement|milestone|start|result|win|accomplishment|week|journey|story|effort|turnaround|move)\b/iu,
  /^\s*(?:i|we) (?:really |truly |absolutely |just )?(?:love|loved|admire|appreciate|like) (?:how|that|your|what|the way|where|this|seeing)\b/iu,
  /^\s*(?:super|so|really|very|truly|absolutely|seriously) (?:impressive|great|good|cool|exciting|strong|smart|solid|proud|well done|amazing)\b/iu,
  /^\s*(?:great|good|nice|smart|clever|brilliant|excellent|strong) (?:thinking|instincts?|hustle|call|point|question|work|job|stuff)(?:,? \w+)?\s*[.!]*\s*$/iu,
  /^\s*(?:i(?:'m| am)|we(?:'re| are)) (?:so |really |very |truly |genuinely )?(?:impressed|proud|excited|thrilled|delighted|amazed|glad|happy)\b(?! to send)/iu,
  /^\s*you(?:'ve| have) (?:done|made|put in|shown|built) (?:such )?(?:an? )?(?:great|good|amazing|fantastic|excellent|solid|real|impressive|strong|incredible|wonderful|huge|terrific|awesome) (?:work|job|progress|start|effort|strides|headway|steps?|courage|initiative|momentum)\b/iu,
  /^\s*you(?:'re| are) (?:already |clearly |really )?(?:doing|making|off to|showing|building|killing|crushing|nailing|onto|well on) (?:it\b|(?:an? )?(?:great|good|well|amazing|fantastic|excellent|solid|real|impressive|strong|wonderful|something|huge|your way))/iu,
  /^\s*(?:you(?:'ve| have) got (?:this|what it takes|something (?:here|special|real))|you should (?:be|feel) (?:\w+ )?(?:proud|good|great|happy|excited)|be proud|keep (?:it|this|that) up|that takes (?:real )?(?:courage|guts|grit|discipline)|that(?:'s| is) (?:solid|strong|perfect|good|nice)(?=\s*(?:[.!,;:—–]|$))|that(?:'s| is) (?:so |really |very |truly |absolutely )?(?:great|amazing|awesome|fantastic|impressive|exciting|wonderful|brilliant|incredible|encouraging|promising|huge|excellent)\b)/iu,
];
const PRAISED_IDEA =
  /^\s*(?:your|this|that|the) (?:\w+ )?(?:idea|concept|venture|plan|product|approach|startup|business) (?:sounds?|is|looks?|seems?|feels?) (?:already |really |very |so |truly |genuinely |like an? |an? )*(?:exciting|great|amazing|promising|interesting|fantastic|brilliant|impressive|cool|wonderful|excellent|awesome|compelling|clever|smart)\b/iu;
const FILLER: readonly RegExp[] = [
  // A plan with nobody, no day and no number in it.
  /^\s*[^.!?:\d]{0,90}\bdiscuss (?:the |your |our )?next steps\b[^.!?:\d]{0,90}[.!]*\s*$/iu,
  /^\s*(?:(?:that|this|it) is for (?:your|this) idea\b|(?:put|set|hold) (?:that|this|it) (?:beside|next to|against) your idea\b|for you,? that means your idea\b)/iu,
  /^\s*(?:that(?:'s| is) (?:a )?(?:tough|hard|rough|difficult) (?:feeling|spot|place|one),? (?:but|and|so) )?(?:so |now |ok(?:ay)?,? )?let(?:'s| us) (?:just )?look at the (?:facts|numbers|evidence|data)[.!]*\s*$/iu,
  /^\s*we (?:haven't|have not) hit (?:our|the) target\b[^.!?]*[.!]*\s*$/iu,
  /^\s*(?:ok(?:ay)?|alright|all right|right|great|sure|perfect),? (?:\p{Lu}\p{L}+,? )?let(?:'s| us) (?:get (?:this|that|it) (?:done|sorted|going|moving)|do (?:this|it|that)|get (?:started|going|to it))[.!]*\s*$/iu,
  /^\s*(?:\p{Lu}\p{L}+, )?here(?:'s| is) (?:the|your|a) (?:one-?page(?:r)?|page|sheet|canvas|table) (?:idea |plan |sheet |version )?(?:for|of|with|on) [^.!?:]{1,50}[.!]*\s*$/iu,
  /^\s*(?:i(?:'m| am) )?sorry (?:if|that) (?:that|it|this|my (?:last )?\w+) (?:came across|sounded|felt|seemed|was) [^.!?:]{1,30}[.!]*\s*$/iu,
  /^\s*you said ["'‘“][^"'’”]{1,40}["'’”][.!]*\s*$/iu,
  /^\s*understanding (?:the reasons? (?:behind|for|why)|why|how|what)\b[^.!?]{0,60}\bis (?:key|crucial|important|essential|critical|vital) (?:to|for)\b/iu,
  /^\s*what matters (?:now|most|here|right now) is (?:how|that|to|what) you (?:respond|react|keep|stay|learn|do (?:next|now|with))\b/iu,
  /\b(?:this|that)(?:'s| is) (?:exactly |precisely |just )?(?:the |a )?(?:kind|sort|type) of (?:learning|feedback|insight|progress|work|thinking)\b/iu,
  /^\s*(?:just |so )?(?:keep )?focus(?:ing)? on what you can control\b/iu,
  /\byour progress (?:is(?:n't| not)) (?:about|measured)\b|\bnot a measure of your progress\b/iu,
  /^\s*you(?:'re| are) not failing\b|\byou(?:'re| are) learning what works\b/iu,
  /^\s*(?:so |now )?let(?:'s| us) make (?:that|this|the|your) (?:next )?\w+ count\b/iu,
  /^\s*(?:that|this) feeling is (?:common|normal|natural)\b|^\s*(?:it|this|that)(?:'s| is) (?:just )?a starting point\b/iu,
  /^\s*you have a clear (?:next step|path|way forward|roadmap)\b/iu,
  /^\s*(?:it|this|that|the page|one page|a one-?page(?:r)?|putting (?:it|this|\w+) on one page|having (?:it|this) on one page) (?:will |can )?(?:lines up what|keeps? everything|puts? everything|forces? you|helps? you (?:see|separate|know)|makes? it (?:easy|easier)|tells? you who cares|shows? (?:you )?what you know|is a (?:great|quick|good|simple|fast|useful) way)\b/iu,
  /\bwe need to refine our approach\b|\brefine (?:your|our) approach\b/iu,
  /\bRome (?:wasn't|was not) built\b/iu,
  /^\s*(?:this|that|it|doing (?:this|that|so)) (?:will|would|can|should) (?:also )?(?:strengthen|boost|elevate|enhance|improve|sharpen|propel|accelerate) your (?:venture|business|idea|case|position|startup|story|credibility|chances|pitch|journey)\b/iu,
  /^\s*(?:this|that|it)(?:'s| is) an? (?:big|huge|great|real|important|major|giant|significant) step (?:forward|in the right direction|ahead)\b/iu,
  /^\s*you(?:'re| are) (?:already )?laying (?:an? )?(?:strong |solid |great |good )?(?:foundations?|groundwork)\b/iu,
  /^\s*(?:so |now )?let(?:'s| us) (?:make the most of|build on|capitalize on|lean into|double down on|harness|seize) (?:that|this|it|the|your)\b[^:]{0,40}$/iu,
  /^\s*(?:this|that|it) (?:helps|keeps|lets|gets) you (?:to )?(?:stay|focused|keep|remain|grounded|on track|aligned)\b/iu,
  /^\s*(?:stay|be|remain) (?:consistent|patient|persistent|resilient|open|hungry|bold|brave|confident|true)\b/iu,
  /^\s*(?:success|growth|progress|momentum|great (?:things|companies)) (?:comes?|takes?|starts?|begins?|happens?|requires?|is) (?:from|from within|time|with|when|a|about|patience|by)\b/iu,
  /^\s*(?:this|that|here) is where (?:the|your) (?:magic|real work|fun|journey)\b/iu,
  /^\s*(?:every|each) (?:small |single |little )?(?:step|talk|conversation|no|yes|test|day|bit) (?:brings?|takes?|gets?|moves?|counts|matters|adds up)\b[^.!?:]{0,60}[.!]*\s*$/iu,
  /^\s*(?:the|your) (?:journey|adventure|road|real work) (?:is|has|starts|begins)\b/iu,
  /^\s*(?:this|it|that)(?:'s| is) an? (?:exciting|important|critical|crucial|key|pivotal|big|great) (?:time|moment|milestone|stage|phase|opportunity|chance|turning point|part)\b(?! (?:if|when|to (?:ask|pay|check)))/iu,
  /^\s*(?:so |now |ok(?:ay)?,? )?let(?:'s| us) (?:dive|dig|explore|unpack|take a (?:closer|deeper) look|break (?:it|this) down|see where)\b[^:]{0,60}$/iu,
  /^\s*you(?:'re| are) (?:building|creating|making|doing) something (?:meaningful|special|great|important|amazing|real|valuable|worthwhile)\b/iu,
  /^\s*(?:this|that|it) (?:sets|puts|positions|primes) you (?:up )?(?:for|in|on)\b/iu,
  /^\s*you(?:'re| are) at an? (?:key|critical|pivotal|exciting|crucial|important) (?:moment|point|stage|juncture)\b/iu,
  /^\s*(?:so |and )?(?:this|that|it)(?:'s| is| will be| becomes) (?:really |truly )?(?:the |a |an |at the |your )?(?:very )?(?:core|heart|foundation|backbone|cornerstone|essence|key|bedrock|north star|roadmap|crucial|essential|critical|key|vital|important) (?:part |step |piece |point |moment |phase |element )?(?:of|to|for|in) (?:your|the|any|every\w*|building|success|this|making|growing|moving)\b/iu,
  /\b(?:will|can|should|helps?|lets?) (?:(?:to )?(?:guide|shape|drive|inform|steer|anchor|underpin)) (?:every|all|each|everything|any)\b/iu,
  /^\s*(?:so |now |ok(?:ay)?,? |and |but |well,? )?let(?:'s| us) (?:just )?(?:keep (?:moving|going|pushing|building|at it|the momentum)|move forward|stay focused|stay on track|push on|press on|make it happen|get to work|keep things moving|focus on what matters|look at what (?:that|this) means(?: for (?:you|your (?:idea|venture)))?)\b[^.!?:]{0,60}[.!]*\s*$/iu,
  /\bforces? you to (?:be|get|think) (?:crystal |really |very |more )?(?:clear|clearly|deeply|hard|precise|specific|honest)\b/iu,
  /^\s*(?:you(?:'re| are)) (?:definitely |clearly |absolutely |well )?(?:on the right (?:track|path)|headed in the right direction|heading in the right direction|moving in the right direction|making progress|getting there|in a (?:good|great|strong) (?:place|position|spot))\b/iu,
  /^\s*(?:just )?keep (?:going|pushing|moving(?: forward)?|building|at it|learning|iterating|up the (?:good|great|hard|momentum)\b|the momentum)[^.!?:]{0,30}[.!]*\s*$/iu,
  /^\s*(?:remember|don't forget|know),? (?:that )?(?:every|all|most|many|even) (?:great |successful )?(?:founders?|startups?|entrepreneurs?|compan(?:y|ies)|business(?:es)?)\b/iu,
  /^\s*(?:every|all|most) (?:great |successful )?(?:founders?|startups?|entrepreneurs?) (?:face|faces|goes? through|start|starts|struggle|struggles|has|have been)\b/iu,
  /^\s*(?:this|that|it|doing (?:this|that|so)) (?:will|would|can|should)?\s*(?:also )?(?:help|helps|allow|allows|enable|enables|let|lets|put|puts|set|sets|give|gives) you (?:to )?(?:craft|create|build|shape|refine|understand|up|develop|make|move|in|stay|a|get) (?:an? |your |the |for |more |forward|on track|clear(?:er)?|strong(?:er)?|better|deep(?:er)?|sharp(?:er)?|solid)\b/iu,
  /^\s*(?:it(?:'s| is) all about|the key (?:here )?is to (?:stay|keep|find|focus|understand|remain|be)|the important thing is to (?:stay|keep|remain|be|start)|building a (?:startup|business|company|venture) (?:is|takes)|(?:startups|entrepreneurship) (?:is|are) (?:a )?(?:hard|journey|marathon|tough|about)|it(?:'s| is) (?:a )?(?:journey|marathon|process|part of the (?:journey|process)))\b/iu,
  /^\s*(?:i(?:'m| am) (?:always )?here (?:to|for|if|whenever)|feel free to (?:reach|ask|share|let)|let me know (?:if|how|what|when|whether)|happy to help|good luck|best of luck|you can do (?:it|this)|i believe in you|stay (?:positive|focused|curious|strong|the course)|believe in (?:yourself|your|it)|trust the process|onwards?|excited to see)\b[^?:]{0,90}$/iu,
  /^\s*(?:this|that|it)(?:'s| is| was| can be) (?:a )?(?:real|big|huge|tough|major|significant|difficult|hard|serious|exciting) (?:shift|change|moment|challenge|setback|blow|step|milestone)(?: for (?:you|any \w+|a \w+|your \w+))?[.!]*\s*$/iu,
];

// Surveys and pass lines ---------------------------------------------------------------------------------------------

const SURVEY = String.raw`(?:surveys?|polls?|questionnaires?|google forms?|typeforms?|instagram polls?)(?! (?:tool|app|company|software|platform|product|startup|business|service|data|for a living|fatigue|maker|says|said|results? (?:show|said)))`;
const SURVEY_ADVISED: readonly RegExp[] = [
  new RegExp(
    String.raw`\b(?:run(?:ning)?|send(?:ing)?|make|making|create|creating|launch(?:ing)?|post(?:ing)?|do(?:ing)?|conduct(?:ing)?|put(?: out| up| together)?|share|consider(?:ing)?(?: running| sending| making)?|with|set up|design(?:ing)?|build|draft|write|start with|begin with|try|use|using|via|through|with|into|as|circulate|distribute|email|do) (?:(?:out|up|them|people|those|your|the|this|that|it|\w+ a) )?(?:(?:an?|the|your|another|some|one|this) )?(?:(?:quick|short|simple|online|brief|small|free|anonymous|two-question|three-question|one-question|five-question|follow-up|mini|customer|campus|little) )*${SURVEY}\b`,
    'iu',
  ),
  /\b(?:survey|poll) (?:your|the|them|those|these|people|students|some|more|at least|about|around|everyone|\d+|ten|twenty|thirty|fifty|a (?:few|group|hundred|bigger)|as many)\b/iu,
  /\bask (?:them|people|students|your \w+|the \w+|everyone) (?:to (?:fill (?:in|out)|complete|take|answer) (?:an? |the |your )?(?:\w+ )?(?:survey|poll|questionnaire|form))\b/iu,
];
const SURVEY_LATER =
  /\b(?:after|once|only|later|until|unless|when you(?:'ve| have)|pause|cancel|already|had|sent|ran|if you (?:still|must)|under six|about the past|how common|calling|call it)\b/iu;

/** What people only say: a yes, an interest, a liking, a would. */
const STATES = String.raw`(?:say(?:s)? (?:they|that they|he|she|it(?:'s| is| would| sounds)|"?yes|"?i)(?:'d| would|'ll| will|'re| are)?(?:,? (?:would |definitely |probably )?(?:pay|use|buy|want|love|like|try|be|sign up|interested|consider|download|subscribe|recommend)| |"|\b)|(?:say|said|says|answer|answers|reply|replies|respond|tell you|vote) (?:with )?["']?(?:yes|maybe|definitely|they(?:'d| would))|["']?yes["']? (?:answers?|responses?|votes?|replies)|yeses|(?:express|show|have|voice) (?:an? )?(?:strong |real |clear |any |some )?(?:interest|enthusiasm|excitement)|(?:are|seem|sound|get) (?:\w+ )?(?:interested|excited|enthusiastic|keen|into it)|(?:like|likes|love|loves|liked|loved) (?:it|the idea|your idea|this|the concept|your \w+)|would (?:definitely |probably |happily )?(?:pay|use|buy|try|sign up|recommend|want|be interested)|they'd (?:pay|use|buy|try|sign up|want)|rate (?:it|the idea|your \w+)|agree(?:s)? (?:that|it|with))`;
const COUNTS = String.raw`(?:(?:at least|more than|over|around|about|even|just) )?(?:\d+%?|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|most|half|enough|many|several|a majority|the majority|everyone|all|a few|some|any)\b`;
const PASS_LINE: readonly RegExp[] = [
  new RegExp(
    String.raw`\b(?:if|when|once) (?:you (?:get|have|hear|see|collect|receive) )?${COUNTS}(?:(?! (?:pays?|paid|buys?|orders?|signs?|deposit)\b)[^.;:]){0,50}?${STATES}`,
    'iu',
  ),
  new RegExp(
    String.raw`\b(?:aim for|shoot for|look for|you(?:'d)? need|wait for|get|until you (?:get|have|hear)) ${COUNTS}[^.;:]{0,40}?(?:say(?:ing)? (?:yes|they(?:'d| would))|yeses|(?:who|that) (?:would|say|are interested)|["']yes["'])`,
    'iu',
  ),
  new RegExp(
    String.raw`\b(?:pass line|pass mark|success|target|threshold|goal|bar|it passes|you pass)\b[^.;]{0,30}?(?:is|=|:|at|means|when|if|would be|should be|as) (?:\w+ ){0,3}?${COUNTS}(?:(?! (?:pays?|paid|buys?|orders?|signs?|deposit)\b)[^.;]){0,40}?${STATES}`,
    'iu',
  ),
  new RegExp(
    String.raw`\b(?:if|when|once) (?:they|people|customers|students|users|buyers|someone|the \w+) (?:all |both |mostly |really )?(?:say (?:yes|they(?:'d| would))(?: (?:pay|buy|use|want)\w*(?: (?:it|for it|that))?)?|love it|like it|like the idea|seem interested|sound interested|are (?:excited|interested))[^.;:]{0,30}, (?:then )?(?:you(?:'ve| have| can| know|'re| are)|it(?:'s| is| works)|that(?:'s| is| means)|there(?:'s| is)|go ahead|go on|build|start building|move on|keep going|continue|carry on|proceed|stick with|you're good)`,
    'iu',
  ),
];
/** What makes a line of stated yeses a line of money, or a warning. */
const COSTS =
  /\b(?:pay(?:s|ing)? (?:now|today|up front|upfront|in advance|you|for (?:it|one|the first))|paid|deposits?|pre-?orders?|with money|with their (?:card|wallet)|(?:and|but|only) (?:\w+ )?(?:then )?(?:pay|buy|order|sign)s?|money down|card|cash|sign(?:s|ed)? (?:it|the|a)|book(?:s|ed)?|ask (?:them|each|those|all|the|him|her|for)|do(?:es)? not|don't|doesn't|isn't|not (?:a|yet|enough|proof)|nothing|zero|never|still|only a promise|promise)\b/iu;

/** Money was asked for in what was said before: a yes is a yes with money then. */
const ASKED_MONEY =
  /\b(?:ask(?:ed)? (?:\w+ ){1,3}to pay|pay now|paid orders?|deposits?|place an? (?:paid )?order|at a (?:real )?price|with a price)\b/iu;

// Questions about the future -----------------------------------------------------------------------------------------

type QuestionKind = 'price' | 'use' | 'problem' | 'opinion' | 'recommend' | 'choice';

const ASKS: readonly (readonly [QuestionKind, RegExp])[] = [
  [
    'price',
    /\bhow much (?:money )?(?:would|will|could|might|do you think you(?:'d| would)|are you willing to|should (?:i|we|it))\b|\bwhat (?:price|amount)\b[^?]{0,60}\b(?:would|will|feels?|seems?|sounds?|makes?|is|fair|reasonable|right)\b|\bwhat(?:'s| is) (?:the most|a fair price|your budget)\b[^?]{0,30}\b(?:would|for|pay)\b|\bwhat would you (?:pay|be (?:willing|happy|ready) to pay|spend)\b|\b(?:would|will|could|might) you (?:really |ever |actually |be (?:willing|happy|ready|prepared|open|likely) to |consider )*(?:pay(?:ing)?|spend(?:ing)?)\b|\bare you (?:willing|ready|prepared|happy) to pay\b|\bis (?:it|this|that|\$?\d+\S*(?: dollars)?(?: an? \w+)?) (?:worth (?:\$|paying|that|the (?:price|money))|too (?:much|expensive)|a fair price|reasonable|fair|cheap)\b/iu,
  ],
  [
    'recommend',
    /\b(?:would|will|could) you (?:\w+ )?(?:recommend|tell (?:a |your |their )?friends?|refer|share (?:it|this) with)\b|\bhow likely (?:are|would) you\b[^?]{0,20}\brecommend\b/iu,
  ],
  [
    'choice',
    /\bwhat (?:would|might|could|will) (?:make|get|convince|lead|persuade|cause|take for) (?:you|this|that|it|the \w+|an? \w+|my \w+|our \w+)\b|\bwhat would you (?:change|improve|add|remove|do differently)\b|\bwhat would (?:it take|have to)\b[^?]{0,30}\byou\b[^?]{0,20}\b(?:switch|buy|use|choose|pay|try)\b|\bwhich (?:features?|version|option|one|price|plan) (?:would|do|will|could|might) you (?:like|prefer|want|choose|pick|use|need|rather)\b|\bwhat (?:features?|else)? ?(?:would|should) you (?:like|want|love|wish|expect|look for)(?! (?:to know|me|us))(?: to (?:see|have)| in| from| it| the| most)?\b|\bwhat features?\b/iu,
  ],
  [
    'use',
    /\b(?:would|will|could|might) you (?:really |ever |actually |personally |honestly |also )*(?:be (?:interested|open|willing|likely|keen|excited|up for|happy|ready|comfortable)|use|try|buy|order|sign up|subscribe|download|join|switch|(?:want|need)(?! to (?:see|decide|know|hear))|consider|like (?:to (?:try|use|have|see)|this|it|an?|something)|find (?:it|this|that) (?:useful|helpful|valuable)|love|rent|book|come|attend|prefer|choose|see yourself|purchase|help(?:ful)?|get|adopt|pick|play|wear|eat|drink|trust)\b|\b(?:would|will|could) (?:this|it|that|such an? \w+|an? \w+(?: \w+){0,4}|something like (?:this|that)|my \w+|our \w+|the \w+) (?:\w+ )?(?:be (?:useful|helpful|valuable|interesting|something|of (?:use|value|interest)|good)|help|work for|save|solve|interest|make (?:your|life))\b|\b(?:can|could) you (?:see|imagine|picture) (?:yourself|yourselves) (?:\w+ing)\b|\bare you interested in\b|\bhow (?:likely|often|soon) (?:would|are|will|do you think you(?:'d| would)) you?\b(?! (?:use|buy|do|have) (?:it|this)? ?(?:now|today|currently))|\bon a scale (?:of|from)\b|\bif (?:i|we|there|someone|it|you could|this|that|an? \w+)\b[^?]{0,80}\bwould (?:you|that|it)\b(?! need to)|\bdo you (?:think )?(?:you(?:'d| would)|want|need) (?:an? |to |this|it|something)\b/iu,
  ],
  [
    'opinion',
    /\bdo you (?:\w+ )?(?:like|love|enjoy|prefer) (?:it|this|that|the|my|our|an?|these|your)\b|\bwhat do you think(?: (?:of|about)\b|\?)|\b(?<!what )do you think (?:it|this|that|the|my|our|there|people|others|your)\b|\bis (?:this|it|that|my|the) (?:\w+ )?(?:a )?(?:good|great|useful|helpful|interesting|valuable|bad|stupid|silly|fun) ?(?:idea|concept|product)?\b|\bdoes (?:this|it|that|my idea|the idea) (?:sound|seem|look|feel|appeal|excite|interest|resonate|make sense)\b|\bhow (?:do|does|would) (?:you|that|this|it) (?:feel|sound)\b|\bwhat(?:'s| is) your (?:opinion|reaction|impression|feedback|view|take)\b|\bhow (?:much )?do you (?:like|feel about)\b|\bare you excited\b/iu,
  ],
  [
    'problem',
    /\bis (?:this|it|that|\w+(?: \w+){0,3}) (?:really |ever |actually )?(?:an? )?(?:problem|issue|annoying|frustrating|painful|pain|struggle|headache|hassle|concern|challenge)\b(?: for you)?|\bdo you (?:\w+ )?(?:have|face|struggle with|find) (?:this|that|it|the) (?:problem|issue|annoying|frustrating|hard)\b|\bdoes (?:this|it|that) (?:bother|annoy|frustrate|affect) you\b/iu,
  ],
];

/**
 * What the programme asks in place of each (its own table in the plays "interview-mistakes" and "interview-script", in the
 * founder's voice): the past, what it cost, what they did.
 */
const PAST: Readonly<Record<QuestionKind, readonly [string, string, string]>> = {
  price: [
    'What did you spend on this last time, in money or hours?',
    'What have you paid for to deal with this so far?',
    'What did doing nothing about it cost you last month?',
  ],
  use: [
    'What do you use now, and when did you last use it?',
    'What did you do about it the last time it came up?',
    'What have you tried so far, and why did you stop?',
  ],
  problem: [
    'When did this last go wrong, and what did you do?',
    'What was the worst part of it last week?',
    'What did it cost you the last time?',
  ],
  opinion: [
    'When did you last deal with this, and how did it go?',
    'Who else did you ask for help with this?',
    'What did you try before that?',
  ],
  recommend: [
    'Who have you told about this so far, and what did you say?',
    'Who else deals with this that I should talk to?',
    'Who did you ask for help the last time?',
  ],
  choice: [
    'What made you pick what you use now?',
    'When did you last switch to something else for this, and why?',
    'What goes wrong with what you use today?',
  ],
};

/** A real offer, put to them now: money, a date, a signature. The programme asks it. */
const REAL_OFFER =
  /\b(?:now|today|right here|right now|deposit|up ?front|in advance|pre-?order|this (?:week|friday|monday|tuesday|wednesday|thursday)|put you down|card|with the first|sign (?:here|it|this|the)|can i (?:put|book|sign)|shall we)/iu;

const isRealOffer = (text: string): boolean =>
  REAL_OFFER.test(text) && !/\bif (?:you|i|we|there)\b|\bfair\b/iu.test(text);

/** A question a mentor asks of the founder, or an offer of help, never one for a customer. */
const TO_FOUNDER =
  /^\W*would you like (?:me|us|to (?:start|work|draft|go|see|talk|begin|practi[sc]e|try that))\b|\bwould you (?:rather|prefer to) (?:start|work|draft|talk|begin|go)\b|\bdo you want (?:me|to (?:start|work|draft|go over|talk|practi[sc]e))\b|\bwhat do you think (?:is|are|was|comes|would|went|stops|keeps|they|he|she|your|you)\b/iu;

/** What gives a question to the founder to ask someone else: in the sentence, or just before it. */
const GIVES =
  /\b(?:ask(?:ing|s)?|question(?:s|naire)?|interview(?:s|ing)?|survey|poll|say to (?:them|each)|(?:email|message|text|send|tell) (?:them|each|those|the|your|people|all)|find out from)\b/iu;

const QUESTION_END = /\?["')\]*_\s]*$/u;

function kindOf(question: string): QuestionKind | null {
  if (TO_FOUNDER.test(question)) return null;
  for (const [kind, re] of ASKS) if (re.test(question)) return kind;
  return null;
}

/** The programme's question in place of one of this kind: the first not given in this reply already. */
function pastQuestion(kind: QuestionKind, before: string): string {
  const options = PAST[kind];
  return options.find((q) => !before.includes(q)) ?? '';
}

/** The last words of what was said before that may give a question ("Ask them two questions:"). */
function givesBefore(before: string): boolean {
  const tail = straight(before).slice(-260);
  const last = tail
    .split(/\n\s*\n/u)
    .slice(-2)
    .join('\n');
  const lead = /[^.!?\n]*:[\s*_]*(?:\n|$|[^:\n]*$)/u.exec(last)?.[0] ?? '';
  return (
    GIVES.test(lead) ||
    /\b(?:ask|questions?)\b[^.!?\n]{0,60}[:.][\s*_]*(?:[^.!\n]*\?\s*)*$/iu.test(last) ||
    // A list of questions goes on.
    (/\?["')\]*_]*\s*$/u.test(last) && GIVES.test(last))
  );
}

/** Indirect: "ask them if they would use it", "ask how much they'd pay". */
const INDIRECT =
  /\b(ask(?:ing|s)?|find out(?: from)?|learn|figure out|discover|check with)((?: (?:them|him|her|people|students|customers|users|buyers|each(?: of them| one)?|those \w+|these \w+|the \w+(?: \w+){0,2}|your \w+|all (?:of )?\w+|everyone|(?:two|three|four|five|six|seven|eight|nine|ten|twelve|twenty|\d+|some|a few) (?:\w+ )?\w+|\w+ (?:people|students|customers|users|friends|nurses|parents|owners|teachers)))?) (if|whether|how much|what(?: price)?|which \w+|how likely|how often)((?: it is)?) (they|he|she|people|it)?(?:'d|'ll|'re| would| will| might| could| are| is|)? ?((?:definitely |really |ever |actually |be )*)(pay|spend|use|buy|borrow|rent|hire|book|try|order|like|love|want|interested|willing|likely|sign up|subscribe|consider|prefer|recommend|feels? fair|fair|worth|useful|download|join|switch|need)\b[^.;:!?"]*/giu;
/** "…, and what they would pay", of a sentence that says what to ask. */
const INDIRECT_TAIL =
  /(,\s*(?:and |or )?|\s(?:and|or) )(if|whether|how much|what(?: price)?|how likely|how often) (?:they|he|she|people|students|customers|users|buyers|it)(?:'d|'ll| would| will| might| could) (?:(?:definitely|really|ever|actually|be|willing|to|consider|happily) )*(pay|spend|use|buy|borrow|rent|hire|book|try|order|want|like|love|switch|subscribe|sign up)\b[^,.;:!?"]*/giu;
const INDIRECT_PAST: Readonly<Record<QuestionKind, string>> = {
  price: 'what they spent on this last time',
  use: 'what they use now and when they last used it',
  problem: 'when it last went wrong and what they did',
  opinion: 'when they last dealt with it and how it went',
  recommend: 'who else deals with it',
  choice: 'what made them pick what they use now',
};
function indirectKind(how: string, verb: string): QuestionKind {
  if (/how much|what/iu.test(how) && /pay|spend|fair|worth/iu.test(verb)) return 'price';
  if (/pay|spend|fair|worth|willing/iu.test(verb)) return 'price';
  if (/recommend/iu.test(verb)) return 'recommend';
  if (/like|love/iu.test(verb)) return 'opinion';
  if (/prefer|want|need/iu.test(verb) && /which|what/iu.test(how)) return 'choice';
  return 'use';
}

/** The unit with each question about the future in it put as the programme puts it; null when it holds none. */
function withoutHypotheticals(unit: string, context: MethodContext): string | null {
  const plain = straight(unit);
  const before = context.before ?? '';
  if (plain.includes(' | ')) return null;
  // "Never ask: would you buy this?": the warning is the method.
  if (warnsOfQuestion(plain, before)) return null;
  // In quotes: a line to say.
  let out = unit;
  let said = before;
  for (const m of plain.matchAll(/"([^"]{6,240}\?)[^"]{0,40}"/gu)) {
    const inner = unit.slice(m.index + 1, m.index + m[0].length - 1);
    const kind = kindOf(straight(inner));
    if (kind === null || isRealOffer(inner)) continue;
    const past = pastQuestion(kind, said);
    if (past === '') return '';
    out = out.replace(inner, past);
    said = `${said} ${past}`;
  }
  if (out !== unit) return out;
  if (plain.includes('"')) return indirect(unit, plain);
  const list = /^(\s*(?:[-*+•]|\d{1,3}[.)])\s+)([\s\S]*)$/u.exec(unit);
  const body = list === null ? unit : (list[2] ?? '');
  const text = straight(body);
  if (QUESTION_END.test(text.trim())) {
    const colon =
      /^([^?]*\b(?:ask|question|start with|open with|say|like)\b[^?:]*:\s*)([^:]+\?[\s\S]*)$/iu.exec(text);
    const given = list !== null || colon !== null || givesBefore(before);
    const asked = colon === null ? text : (colon[2] ?? '');
    const kind = given ? kindOf(asked) : null;
    if (kind !== null && !isRealOffer(asked)) {
      const past = pastQuestion(kind, before);
      if (past === '') return '';
      const lead = colon === null ? '' : body.slice(0, (colon[1] ?? '').length);
      const space = list === null && colon === null ? (/^\s*/u.exec(unit)?.[0] ?? '') : '';
      return `${space}${list?.[1] ?? ''}${lead}${past}${/\s*$/u.exec(body)?.[0] ?? ''}`;
    }
    if (list !== null || colon !== null) return null;
  }
  return indirect(unit, plain);
}

function indirect(unit: string, plain: string): string | null {
  let out = unit;
  let changed = false;
  for (const m of [...plain.matchAll(INDIRECT)]) {
    const whole = unit.slice(m.index, m.index + m[0].length);
    if (REAL_OFFER.test(whole) || DENIES.test(plain.slice(clauseStart(plain, m.index), m.index))) continue;
    if (/\b(?:you|your|we|i|me)\b/iu.test(m[5] ?? '')) continue;
    // What doing it tells ("you learn what they need") is no question to put to anyone.
    if (
      /\b(?:you|we|they|i)(?:'ll| will| can| also)? $/iu.test(plain.slice(0, m.index)) &&
      !/^ask/iu.test(m[1] ?? '')
    )
      continue;
    const verb = m[7] ?? '';
    // "Ask them what they use now" is the method itself.
    if (
      /^(?:what|which \w+|how often)$/iu.test(m[3] ?? '') &&
      !/(?:'d|'ll| would| will| might| could)\b/iu.test(m[0]) &&
      !/fair|worth/iu.test(verb)
    )
      continue;
    if (/^(?:if|whether)$/iu.test(m[3] ?? '') && /\b(?:paid|used|bought|tried|had|did)\b/iu.test(m[0]))
      continue;
    const kind = indirectKind(m[3] ?? '', verb);
    const who = (m[2] ?? '').trim();
    const them = who !== '' ? ` ${who}` : /^ask/iu.test(m[1] ?? '') ? ' them' : '';
    out = out.replace(whole, `${m[1] ?? 'ask'}${them} ${INDIRECT_PAST[kind]}`);
    changed = true;
  }
  // "… what the tear cost them, and what they would pay to skip that": the rest of what they are told to ask.
  if (GIVES.test(plain)) {
    for (const m of [...straight(out).matchAll(INDIRECT_TAIL)]) {
      const whole = out.slice(m.index, m.index + m[0].length);
      if (REAL_OFFER.test(whole) || DENIES.test(straight(out).slice(0, m.index))) continue;
      const past = INDIRECT_PAST[indirectKind(m[2] ?? '', m[3] ?? '')];
      out = out.replace(whole, out.includes(past) ? '' : `${m[1] ?? ' and '}${past}`);
      changed = true;
    }
  }
  return changed ? out : null;
}

/** Whether the sentence, or what leads into it, says not to ask it, or what is wrong with it. */
const WARNS =
  /\b(?:never|not|don't|do not|avoid|stop|drop|skip|no|without|instead of|rather than|replace|cut|bad|wrong|weak|useless|worthless|polite|politeness|kind|lies?|lying|mislead\w*|guess(?:es)?|opinions?|hypothetical|future|trap|mistake|nobody|anyone|everyone answers|nearly everyone|costs? (?:them )?nothing|free to say|tells? you (?:nothing|little)|worth nothing|means (?:nothing|little)|isn't|doesn't|won't|can't)\b/iu;
function warnsOfQuestion(plain: string, before: string): boolean {
  // The words of the question itself ("Would you not miss it?") are no warning: only what stands outside it.
  const outside = plain
    .replace(/"[^"]*"/gu, ' ')
    // "… to skip that" warns of nothing.
    .replace(/\bto (?:avoid|skip|stop|cut|replace) (?:it|that|this|them)\b/giu, ' ')
    .replace(/[^.!?:;—]*\?/gu, (q) => (/\bask\b/iu.test(q) ? q : ' '));
  if (WARNS.test(outside)) return true;
  const lead =
    straight(before)
      .split(/(?<=[.!?])\s+|\n/u)
      .filter((s) => s.trim() !== '')
      .at(-1) ?? '';
  return /:\s*$/u.test(lead) && WARNS.test(lead);
}

// What they answered -------------------------------------------------------------------------------------------------

const ASK_WORDS: ReadonlySet<string> = new Set(
  'many much did does have has had how what when who why where which tell said say ask exactly specifically actually far already could share'
    .split(' ')
    .map(stemOf),
);

/** What they say others said. */
const SAYS = /\b(?:sa(?:ys?|id)|t(?:old|ells)|explained|answered|replied)\b/iu;
const WHAT_SAID =
  /\bwhat (?:exactly |specifically |else )?(?:did|does|has) (?:the |your |that )?(he|she|they|\w+(?: \w+){0,2}?) (?:specifically |exactly |actually )?(?:say|said|tell|answer|reply)\b/iu;

/** Whether a question gives their own question back to them (they ask how many came back, it asks how many they think came back). */
function handsBack(q: string, founderText: string): boolean {
  const word = /\b(how (?:many|much)|what share|what price|what|which|who|why|when|where)\b/iu
    .exec(q)?.[1]
    ?.toLowerCase();
  if (word === undefined || !QUESTION_END.test(q.trim())) return false;
  const mine = stemsOf(q);
  return founderText
    .split(/(?<=[.!?])\s+|\n/u)
    .filter((s) => s.trim().endsWith('?'))
    .some((s) => {
      const theirs = new Set([...stemsOf(s)].filter((w) => !ASK_WORDS.has(w)));
      return theirs.size >= 2 && s.toLowerCase().includes(word) && coverage(theirs, mine) >= 0.65;
    });
}

/** Whether a question put to the founder was answered by the message it answers. */
function answered(unit: string, founderText: string): boolean {
  const q = straight(unit);
  if (handsBack(q, straight(founderText))) return true;
  if (!QUESTION_END.test(q.trim()) || founderText.trim() === '') return false;
  const stems = new Set([...stemsOf(q)].filter((w) => !ASK_WORDS.has(w) && !/^\d/.test(w)));
  const why = /^\s*(?:and |so |but )?why\b/iu.test(q);
  if (stems.size < (why ? 1 : 2)) return false;
  const told = straight(founderText)
    .split(/(?<=[.!])\s+|\n/u)
    .filter((s) => !s.trim().endsWith('?'));
  if (/\bhow (?:many|much)\b/iu.test(q))
    return told.some((s) => numbersIn(s).length > 0 && coverage(stems, stemsOf(s)) >= 0.75);
  const whose = WHAT_SAID.exec(q)?.[1];
  if (whose !== undefined) {
    const who = /^(?:he|she|they)$/iu.test(whose) ? new Set<string>() : stemsOf(whose);
    const all = stemsOf(told.join(' '));
    if (told.some((s) => SAYS.test(s)) && coverage(who, all) === 1)
      return coverage(stems, all) >= 0.75 || /\b(?:specifically|exactly)\b/iu.test(q);
  }
  if (why)
    return told.some(
      (s) => /\b(?:because|since|so that|due to)\b/iu.test(s) && coverage(stems, stemsOf(s)) >= 0.6,
    );
  return coverage(stems, stemsOf(told.join(' '))) >= 0.9 && stems.size >= 3;
}

// The unit -----------------------------------------------------------------------------------------------------------

const EMPTY = /\[\s*(?:\.{2,}|…|_+|-+)?\s*\]|_{3,}/u;
const EMPTY_RUN =
  /(?:\[\s*(?:\.{2,}|…|_+|-+)?\s*\]|_{3,})(?:\s*[,;/|]?\s*(?:and |or )?(?:\[\s*(?:\.{2,}|…|_+|-+)?\s*\]|_{3,}))*/gu;
const LABELLED = /^\s*(?:(?:[-*+•]|\d{1,3}[.)])\s+)?[*_]{0,2}[\p{L}][\p{L}\d '’/-]{0,40}?[*_]{0,2}\s*:/u;
/** What stands in a line of a template where it has only an empty bracket. */
export const TO_FILL = '[yours to fill in]';

/** A line of a template with one plain blank in place of each run of empty brackets. */
export function withoutEmptyBrackets(line: string): string {
  return line.replace(EMPTY_RUN, TO_FILL);
}

const capital = (text: string): string =>
  text.replace(/^([\s*_"“(]*)(\p{Ll})/u, (_m, pre: string, c: string) => `${pre}${c.toUpperCase()}`);

/** What follows a verdict or praise in its sentence, when it says something of its own. */
function restAfter(unit: string, end: number, context: MethodContext): string {
  const rest = unit.slice(end);
  const m =
    /^[^,;:—–-]{0,40}?(?:[,;:]|[—–]|\s-)\s*(?:(?:but|and|so|though|however|yet|still|now)\b,?\s+)?/u.exec(
      rest,
    );
  if (m === null) return '';
  const left = rest.slice(m[0].length);
  if (
    wordsIn(left) < 4 ||
    /^(?:not|just|only|rather|for|with|in|on|at|to|of|especially|even|given|considering)\b/iu.test(left)
  )
    return '';
  const read = methodUnit(left, context);
  if (read.text.trim() === '') return '';
  const space = /^\s*/u.exec(unit)?.[0] ?? '';
  const marker = /^\s*(?:(?:[-*+•]|\d{1,3}[.)])\s+)/u.exec(unit)?.[0] ?? space;
  return `${marker}${capital(read.text.trimStart())}`;
}

const plainWords = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
/** The sentences of the prompt's own example: copied word for word they say nothing of the founder's. */
const EXAMPLE: ReadonlySet<string> = new Set(unitsOf(READING_EXAMPLE).map((u) => plainWords(u.text)));

/** Whether a quotation is open at the end of `text`. */
function quoteOpens(text: string): boolean {
  let open = false;
  for (const ch of text.slice(text.lastIndexOf('\n\n') + 1)) {
    if (ch === '"') open = !open;
    else if (ch === '\u201C') open = true;
    else if (ch === '\u201D') open = false;
  }
  return open;
}

/** One unit of a reply as the method lets it stand (see the module comment). Idempotent. */
export function methodUnit(unit: string, context: MethodContext = {}): MethodUnit {
  if (unit.trim() === '') return { text: unit, findings: [] };
  const out = (text: string, finding: MethodFinding): MethodUnit => ({ text, findings: [finding] });
  if (EMPTY.test(unit)) {
    if (!LABELLED.test(unit)) return out('', 'empty_bracket');
    return out(withoutEmptyBrackets(unit), 'empty_bracket');
  }
  const asked = withoutHypotheticals(unit, context);
  if (asked !== null) return out(asked, 'hypothetical_question');
  const plain = straight(unit).replace(/\[\s*E\d+(?:\s*[,;]\s*E\d+)*\s*\]/giu, '');
  const body = plain.replace(/^\s*(?:(?:[-*+•]|\d{1,3}[.)])\s+)?/u, '');
  // A line for them to say or send is theirs to say: nothing in it is the coach's verdict.
  const inDraft = quoteOpens(context.before ?? '');
  const own = (inDraft ? body.replace(/^[^"]*(?:"|$)/u, ' ') : body)
    .replace(/"[^"]*(?:"|$)/gu, ' ')
    .replace(
      /^(\s*)what (this|that|it) ((?:tells|shows|means|says|suggests)(?: us| you)?) is (?:that )?/iu,
      '$1$2 $3 that ',
    );
  if (context.founderText !== undefined && answered(unit, context.founderText))
    return out('', 'answered_question');
  // All of it is a draft in quotes, over several sentences.
  if (own.trim() === '' && (inDraft || /"[^"]*$/u.test(body))) return { text: unit, findings: [] };
  if (PRICE_RULE.some((re) => re.test(own)) && !DENIES.test(own.slice(0, 30))) return out('', 'price_rule');
  if (NO_BASIS.test(own) || OTHER_PRICE_PROVEN.test(own)) return out('', 'verdict_without_basis');
  const question = QUESTION_END.test(own.trim());
  if (
    !question &&
    SURVEY_ADVISED.some((re) => {
      const m = re.exec(own);
      return m !== null && !DENIES.test(own.slice(0, m.index)) && !SURVEY_LATER.test(own);
    })
  )
    return out('', 'survey');
  if (
    !question &&
    // "They would pay for it" costs them nothing yet.
    !COSTS.test(own.replace(/(?:\bwould|'d|\bwill) pay(?: for (?:it|that|one))?\b/giu, ' ')) &&
    !ASKED_MONEY.test((context.before ?? '').slice(-300)) &&
    PASS_LINE.some((re) => re.test(body.replace(/"/gu, '')))
  )
    return out('', 'stated_pass_line');
  if (question) return { text: unit, findings: [] };
  const offset = plain.length - body.length;
  const praise = PRAISE_OPEN.exec(body);
  if (
    praise !== null &&
    !/^\s*(?:great|good|nice|solid|strong)\b[^.!?]*\b(?:is|are|means|needs?|comes?|start|starts)\b/iu.test(
      body,
    )
  ) {
    const after = body.slice(praise[0].length);
    if (/^[\s.!,;:—–-]*$/u.test(after)) return out('', 'praise');
    if (/^\s*(?:[,;:!.]|[—–]|-\s)/u.test(after))
      return out(restAfter(unit, offset + praise[0].length, context), 'praise');
  }
  const praises = [...PRAISE_LINE, PRAISED_IDEA];
  if (praises.some((re) => re.test(own)) && !DENIES.test(own.slice(0, 40)) && !opensAfter(own)) {
    const m = praises.map((re) => re.exec(body)).find((x) => x !== null);
    return out(m == null ? '' : restAfter(unit, offset + m[0].length, context), 'praise');
  }
  if (EXAMPLE.has(plainWords(own)) || FILLER.some((re) => re.test(own))) return out('', 'filler');
  const found = verdict(own, context);
  if (found !== null && own.length === body.length && own === body)
    return out(restAfter(unit, offset + found.end, context), 'over_claim');
  if (found !== null || overClaim(own, context) !== null || FRIENDS_PROVE.test(own)) {
    if (
      FRIENDS_PROVE.test(own) &&
      found === null &&
      overClaim(own, context) === null &&
      (DENIES.test(own) || opensAfter(own))
    )
      return { text: unit, findings: [] };
    return out('', 'over_claim');
  }
  return { text: unit, findings: [] };
}

/** A whole text as {@link methodUnit} reads it, unit by unit. */
export function methodText(
  text: string,
  options: {
    readonly founderText?: string;
    /** Units left as they are: `text` the unit, `raw` with the whitespace before it. */
    readonly protect?: (text: string, raw: string) => boolean;
  } = {},
): { readonly text: string; readonly findings: readonly MethodFinding[] } {
  const findings: MethodFinding[] = [];
  let before = '';
  let broke = false;
  for (const u of unitsOf(text)) {
    if (options.protect?.(u.text, u.raw) === true) {
      before += u.raw;
      broke = false;
      continue;
    }
    const read = methodUnit(u.raw, {
      before,
      ...(options.founderText === undefined ? {} : { founderText: options.founderText }),
    });
    findings.push(...read.findings);
    if (read.text.trim() === '') {
      if (/^[ \t]*\n\s*\n/u.test(u.raw)) broke = true;
      continue;
    }
    before +=
      broke && before !== '' && !/^\s*\n/u.test(read.text) ? `\n\n${read.text.trimStart()}` : read.text;
    broke = false;
  }
  return findings.length === 0
    ? { text, findings }
    : { text: before.replace(/\n{3,}/gu, '\n\n').trim(), findings };
}

/**
 * Whether what leans on a sentence left out for `finding` ("This will show us …") goes with it: advice is gone with its
 * reasons; a fact that was over-read stands, and what it does not show is the best of the reply.
 */
export const leansAfter = (finding: MethodFinding): boolean =>
  finding === 'survey' || finding === 'stated_pass_line' || finding === 'hypothetical_question';
