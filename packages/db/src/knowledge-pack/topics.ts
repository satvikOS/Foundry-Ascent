/**
 * What a founder's message asks about, for the cited corpus (the programme's course notes and the open library,
 * ./corpus.ts). The coaching diagnosis of 2026-11-05 (C1) traced fixation to library notes injected whatever was asked,
 * so a note is a candidate only when the founder's OWN message asks for something, and then in one of three ways: the
 * message names one of its source's topics (here), the play the path chose cites the source, or, for a question in words
 * no table foresees, the note itself is strongly about it (`RETRIEVAL_FLOORS.open…`).
 */
import { asks } from './gate.js';

/** Sentences read as asking for help besides questions and requests (`asks`): a need, a plan, not knowing. */
const NEED =
  /\b(?:(?:i|we)(?:'m| am|'re| are)? (?:also |still |really |just )?(?:need|needing|have to|want|wanna|would like|hope|hoping|trying|planning|thinking (?:of|about)|looking|supposed|stuck|lost|unsure|worried|scared|afraid|nervous|confused|not sure|struggling|don't know|dont know|do not know|can't|cant|cannot|don't get|dont get|don't understand|dont understand|have no (?:idea|clue)|have a question|keep (?:hearing|getting))|no idea|no clue|not sure|unsure|don't know|dont know|idk|help(?: me| us)?|advice|tips?|difference between|vs\.?|versus|explain|walk me through|template)\b/;

/** One topic: what names it. A pattern is read on a lower-case sentence with plain apostrophes. */
const PATTERNS = {
  mindset: [
    /\bmind ?set\b/,
    /\bwhat (?:makes|it takes to be|does it take to be) (?:a |an )?(?:good |great |successful )?(?:founder|entrepreneur)/,
    /\b(?:am i|i(?:'m| am)) (?:cut out|ready) (?:for|to be)/,
    /\bcut out (?:for|to be)\b/,
    /\bambiguity\b/,
    /\bintrapreneur/,
    /\buncertainty\b/,
  ],
  'job-security': [
    /\bjob security\b/,
    /\b(?:take|taking|get|getting|turn down|quit|quitting|leave|leaving) (?:a|the|my|that)\b[^.?!]{0,20}\bjob\b/,
    /\bjob (?:offer|or (?:a |my |the )?(?:startup|start-up|venture|business|company))\b/,
    /\b(?:full[- ]time|corporate|safe|stable) job\b/,
  ],
  idea: [
    /\b(?:find|come up with|get|pick|choose|brainstorm|generate|evaluate|judge|assess)\b[^.?!]{0,30}\b(?:ideas?|opportunit)/,
    /\bis (?:my|this|the|our) idea (?:any )?good\b/,
    /\b(?:good|great|better|right) (?:business |startup )?(?:ideas?|opportunit)/,
    /\bopportunity recognition\b/,
    /\bwhere do (?:good )?ideas\b/,
  ],
  'design-thinking': [/\bdesign thinking\b/, /\bhuman[- ]centered\b/],
  'business-model': [
    /\bbusiness models?\b/,
    /\b(?:make|makes|making|earn|earns) (?:any |some |the |our |my |its )?money\b/,
    /\brevenue (?:model|streams?)\b/,
    /\bmoneti[sz]/,
    /\bnorth star\b/,
    /\b(?:one|key|right) metric\b/,
    /\bhow (?:do|would|will|should|can) (?:we|i|it|they) (?:get|be) paid\b/,
    /\bb2b or b2c\b|\bb2c or b2b\b/,
    /\b(?:freemium|subscription|ad[- ]supported|ads or)\b/,
  ],
  canvas: [/\bcanvas\b/, /\bbmc\b/],
  'customer-user': [
    /\b(?:customers?|buyers?|payers?)\b[^.?!]{0,40}\b(?:users?|uses it|using it|end[- ]users?)\b/,
    /\b(?:users?|end[- ]users?)\b[^.?!]{0,40}\b(?:customers?|buyers?|pays?|payers?|paying|purchas)/,
    /\b(?:who|which (?:one|person)) (?:actually )?(?:pays|is (?:my|the|our) (?:real )?customer|buys)\b/,
    /\b(?:use|uses|used|using)\b[^.?!]{0,40}\b(?:pays?|buys?|paying|buying|purchas)/,
    /\b(?:pays?|buys?|paying|buying)\b[^.?!]{0,40}\b(?:use|uses|used|using)\b/,
    /\b(?:person|people|one|kids?|students?|doctors?|nurses?|teachers?|schools?) (?:who |that )?(?:uses?|using) (?:it|this|the|our|my)\b[^.?!]{0,60}\b(?:pays?|buys?|paying|buying)\b/,
  ],
  'customer-discovery': [
    /\bcustomer (?:discovery|interviews?|development|research)\b/,
    /\binterview/,
    /\b(?:talk|talking|speak|speaking|listen|listening) (?:to|with) (?:my |our |potential |real |some |the |more |any )*(?:customers?|users?|people|buyers?|students?)\b/,
    /\bvoice of the customer\b/,
    /\bvalidat/,
    /\b(?:people|customers?|users?|anyone|someone|anybody|they)\b[^.?!]{0,30}\b(?:would |will |'d |actually |really )*(?:want|need|buy|pay for|use) (?:it|this|my|our)\b/,
    /\bwhether (?:people|anyone|they)\b/,
    /\bdemand for\b/,
  ],
  mvp: [
    /\bmvp\b/,
    /\bminimum viable\b/,
    /\bprototype\b/,
    /\blean start-?up\b/,
    /\bbuild (?:it |the app |the product |something )?(?:before|first)\b/,
    /\bsmallest (?:version|thing)\b/,
    /\bpivot\b/,
  ],
  team: [
    /\b(?:build|find|choose|pick|hire|recruit|manage|managing|building|form)\b[^.?!]{0,30}\b(?:team|teammates?)\b/,
    /\b(?:my|our|the|a (?:good|great|strong)) team\b/,
    /\bteammates?\b/,
  ],
  cofounder: [
    /\bco-?founders?\b/,
    /\b(?:find|need|looking for)\b[^.?!]{0,25}\b(?:technical|business) (?:partner|person|founder)\b/,
  ],
  fundraising: [
    /\b(?:raise|raising) (?:(?:some|any|a|more|our|my|the|outside|seed|angel|venture|vc) )*(?:money|capital|funds?|funding|rounds?|investment|seed)\b/,
    /\bfund-?rais/,
    /\b(?:seed|angel|pre-seed|funding|investment) (?:rounds?|money|funding)\b/,
    /\bseries [a-d]\b/,
    /\b(?:get|find|need|looking for|seek(?:ing)?|take|want) (?:(?:some|any|more|outside|an?|the) )*(?:funding|investment|investors?|investor money|capital)\b/,
    /\bfund (?:my|our|this|the|a|it)\b/,
    /\bconvertible (?:note|debt)/,
    /\bdilut/,
    /\bequity\b/,
    /\b(?:other people's|investor|outside) (?:money|funding|capital|investment)\b/,
    /\bfriends and family\b/,
    /\b(?:give|gives|giving|invest|invests|put|offer|offered|offering)\b[^.?!]{0,30}\d[^.?!]{0,30}(?:%|\bpercent\b)/,
    /\bwhere (?:do|can|should) (?:i|we) (?:get|find) (?:the )?(?:money|funding)\b/,
  ],
  investors: [/\binvestors?\b/, /\bangels?\b/, /\bvcs?\b/, /\bventure capital/, /\bboard seat\b/],
  bootstrapping: [
    /\bbootstrap/,
    /\bself[- ]fund/,
    /\bwithout (?:raising|investors?|funding|outside money|investment)\b/,
    /\b(?:own|personal) (?:money|cash|savings)\b/,
    /\bno money\b/,
    /\bkeep (?:all )?(?:my|our|the) equity\b/,
  ],
  loans: [/\bloans?\b/, /\bborrow/, /\blenders?\b/, /\bdebt\b/, /\bbank (?:lend|financ)/],
  grants: [/\bgrants?\b/, /\bsbir\b/, /\bsttr\b/, /\bnon-?dilutive\b/, /\bprize money\b/],
  crowdfunding: [/\bcrowd-?fund/, /\bkickstarter\b/, /\bindiegogo\b/, /\bgofundme\b/],
  securities: [
    /\bsecurities\b/,
    /\baccredited\b/,
    /\breg(?:ulation)? (?:d|cf|a|crowdfunding)\b/,
    /\b506\b/,
    /\bform d\b/,
    /\bgeneral solicitation\b/,
    /\bsec\b(?= (?:rules?|filing|exempt|registration|law))/,
    /\b(?:sell|selling|give|giving|offer|offering|trade|issue|issuing) (?:them |him |her |people |friends |someone |my [a-z]+ |some |our |the )*(?:shares|stock|equity|a percentage|part of (?:my|the|our) company|[0-9]+ ?%)/,
    /\b(?:legal|allowed|illegal|legally)\b[^.?!]{0,40}\b(?:rais(?:e|ing)|invest(?:ors?|ing|ment)?)\b/,
    /\b(?:post|advertise|announce|tweet)\b[^.?!]{0,40}\b(?:raise|raising|round|investors?|investment)\b/,
  ],
  'safe-notes': [
    /\bsafes?\b(?= (?:note|agreement|or|round))/,
    /\b(?:a|the|using|sign(?:ing)?|with) safes\b/,
    /\bsimple agreement\b/,
    /\bconvertible note/,
    /\b(?:common|preferred) stock\b/,
    /\bcap table\b/,
    /\bvs\.? (?:a )?safe\b/,
  ],
  'legal-structure': [
    /\bllcs?\b/,
    /\binc\b(?=\.|orporat|\b)/,
    /\bincorporat/,
    /\b(?:c|s)[- ]corps?\b/,
    /\b(?:c|s) corporation/,
    /\bsole proprietor/,
    /\blegal (?:structure|entity|form)\b/,
    /\bbusiness (?:structure|entity)\b/,
    /\bpartnership (?:agreement|or|vs)\b/,
    /\b(?:general|limited) partnership\b/,
    /\bdba\b/,
    /\bdoing business as\b/,
    /\b(?:form|register|set up|create) (?:a|my|our|the) (?:legal |actual |real )?(?:company|entity|corporation|nonprofit)\b/,
    /\bpartnerships?\b/,
    /\b(?:legally|legal) (?:a |an |my |our )?(?:company|business|partners?|owners?)\b/,
    /\bbenefit corp/,
    /\bb[- ]corp\b/,
    /\bnon-?profit\b/,
    /\b(?:personal(?:ly)? )?liab(?:le|ility)\b/,
    /\bsued?\b/,
  ],
  registration: [
    /\bregister(?:ing)? (?:a|my|our|the|as a) (?:business|company|llc)\b/,
    /\bregister with the state\b/,
    /\bregistered agent\b/,
    /\blicen[cs]es? (?:and|or) permits?\b/,
    /\b(?:business|food|vend(?:or|ing)|health|city|sales|seller'?s?) (?:permits?|licen[cs]es?)\b/,
    /\bbusiness license\b/,
    /\bbusiness bank account\b/,
    /\bbank account\b/,
  ],
  'business-name': [
    /\b(?:business|company|startup|brand|product) name\b/,
    /\bname (?:for )?(?:my|our|the) (?:business|company|startup|app|brand)\b/,
    /\btrade name\b/,
    /\bdomain name\b/,
    /\bdba\b/,
  ],
  ein: [/\bein\b/, /\bemployer identification\b/, /\btax id\b/, /\bfederal id\b/],
  taxes: [/\btax(?:es|ed)?\b/, /\bschedule c\b/, /\bself-?employ/, /\b1099\b/, /\birs\b/],
  patent: [/\bpatents?\b/, /\bpatent pending\b/, /\bprovisional\b/, /\binvent(?:ion|or|ed)\b/],
  trademark: [
    /\btrade-?marks?\b/,
    /\b(?:write|put|use|add) (?:the )?(?:tm|sm|®|™)\b/,
    /\b(?:protect|own) (?:my|our|the) (?:name|logo|brand)\b/,
  ],
  ip: [
    /\bintellectual property\b/,
    /\bcopyright/,
    /\bprotect (?:my|our|the|an) (?:ideas?|code|software|design|work)\b/,
    /\b(?:ip|i\.p\.) (?:protection|rights|strategy)\b/,
  ],
  'idea-sharing': [
    /\b(?:steal|stealing|stole|copy|copying|copied|rip off)\b[^.?!]{0,25}\b(?:idea|it|me|us|this|concept)\b/,
    /\bndas?\b/,
    // Not "tell me my idea is great", which asks for a judgement.
    /\b(?:share|sharing|(?:tell|telling)(?! (?:me|us)\b)|talk about)\b[^.?!]{0,25}\b(?:my|our|the) idea\b/,
    /\bkeep (?:it|my idea|our idea|this) (?:a )?secret\b/,
  ],
  'business-plan': [
    /\bbusiness plans?\b/,
    /\bexecutive summary\b/,
    /\bfinancial projections?\b/,
    /\bfunding request\b/,
    /\bwrite (?:a|my|the|our) plan\b/,
  ],
  'market-research': [
    /\bmarket research\b/,
    /\bmarket (?:size|sizing|analysis)\b/,
    /\bhow (?:big|large) (?:is|the) (?:my|the|our|this)? ?market\b/,
    /\btam\b|\bsam and som\b/,
    /\bindustry (?:data|trends?|analysis)\b/,
    /\bcensus\b/,
    /\bpestel\b/,
    /\bmarket data\b/,
  ],
  competition: [
    /\bcompetit/,
    /\balternatives?\b/,
    /\bstand out\b/,
    /\bdifferent from\b/,
    /\bsomeone (?:else )?(?:is )?already (?:doing|does|built)\b/,
  ],
  'target-market': [
    /\btarget (?:market|customers?|audience)\b/,
    /\bwho (?:should|do) (?:we|i) (?:target|sell to|focus on)\b/,
    /\bcustomer segments?\b/,
    /\bniche\b/,
    /\bbeachhead\b/,
  ],
  pricing: [
    /\bpric(?:e|es|ing)\b/,
    /\b(?:how much|what) (?:should|do|can|would) (?:i|we) charge\b/,
    /\bsales forecasts?\b/,
    /\bforecast/,
  ],
  'startup-costs': [
    /\bstart-?up costs?\b/,
    /\bhow much (?:money |cash |capital )?(?:do|will|would|does|should) (?:i|we|it) (?:need|cost|take)\b/,
    /\b(?:costs?|expenses?|budget)\b[^.?!]{0,30}\b(?:start|launch|open|first year)\b/,
    /\b(?:list|estimate|calculate|figure out) (?:my|our|the|all)?[^.?!]{0,15}\b(?:costs?|expenses?)\b/,
    /\bone-?time costs?\b/,
    /\bmonthly (?:costs?|expenses?)\b/,
  ],
  'break-even': [
    /\bbreak[- ]?even\b/,
    /\bfixed costs?\b/,
    /\bvariable costs?\b/,
    /\bcontribution margin\b/,
    /\bhow many (?:do|should|must|would) (?:i|we) (?:need|have) to sell\b/,
  ],
  pitch: [
    /\bpitch(?:es|ing)?\b/,
    /\bpitch deck\b/,
    /\bslide deck\b/,
    /\belevator\b/,
    /\bdemo day\b/,
    /\binvestor deck\b/,
  ],
  'pitch-investors': [/\bdemo day\b/, /\bgeneral solicitation\b/],
  networking: [
    /\bnetwork(?:ing)?\b(?! (?:effects?|security|engineer|protocol|model))/,
    /\bintrovert/,
    /\bmentors?\b(?=[^.?!]{0,30}\b(?:find|reach|meet|ask)|)/,
    /\b(?:meet|reach|connect with|approach) (?:new |other |more |the right )*(?:people|founders|mentors|experts|alumni|investors|strangers)\b/,
    /\bthank[- ]you (?:email|note)\b/,
    /\bsmall talk\b|\bice ?breaker\b|\bbreak the ice\b/,
    /\b(?:conference|networking event|career fair)\b/,
    /\binformational (?:call|interview)\b/,
  ],
  outreach: [
    /\bcold[- ](?:email|call|message|outreach|dm)/,
    /\blinkedin\b/,
    /\boutreach\b/,
    /\b(?:email|message|dm|write to|write|reach out to)\b[^.?!]{0,30}\b(?:strangers?|people|someone|professors?|executives?|founders?|alumni|customers?|investors?|mentors?)\b/,
    /\bfollow[- ]?up\b/,
    /\bconnection request\b/,
  ],
  icorps: [/\bi-?corps\b/],
} as const satisfies Record<string, readonly RegExp[]>;

export type CorpusTopic = keyof typeof PATTERNS;
export const CORPUS_TOPICS = Object.keys(PATTERNS) as readonly CorpusTopic[];

export function isCorpusTopic(value: string): value is CorpusTopic {
  return Object.hasOwn(PATTERNS, value);
}

const MAX_CHARS = 2_000;

function sentencesOf(text: string): string[] {
  return text
    .slice(0, MAX_CHARS)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** The sentences of `text` that ask, request or say what they need, each with the sentence before it. */
function askingText(text: string): string {
  const sentences = sentencesOf(text);
  const asking = sentences.map((s) => asks(s) || NEED.test(s));
  return sentences.filter((_, i) => asking[i] === true || asking[i + 1] === true).join(' \n ');
}

/** Whether the founder's message asks for something (a question, a request, a need), and not only tells. */
export function seeksHelp(founderText: string): boolean {
  return askingText(founderText) !== '';
}

/**
 * The topics `founderText` (the founder's own message, nothing else) asks about, in the order of the table: a topic
 * counts only in a sentence that asks, requests or says what they need; a short message with no such sentence asks
 * nothing. A question that follows a statement asks about it ("I have two co-founders. How do we split equity?"), so
 * the sentence right before an asking one is read with it.
 */
export function corpusTopics(founderText: string): CorpusTopic[] {
  const read = askingText(founderText);
  if (read === '') return [];
  return CORPUS_TOPICS.filter((topic) => PATTERNS[topic].some((pattern) => pattern.test(read)));
}
