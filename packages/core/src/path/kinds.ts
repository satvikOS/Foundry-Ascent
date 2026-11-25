import { inDistress, inRole, socialTurnOf, wrapUpOf } from '@foundry/ai';

import { daySaid } from './dates.js';
import { countsIn, contentStems, plain, sentences, subjectStems } from './words.js';

/**
 * What kind of message the founder sent, read from its words by rule (never by a model): a social turn, a question
 * about what was said before, a report on a step, a rehearsal, "get me organized", a choice between options, an idea
 * the venture's record does not hold.
 */

const QUESTION_START =
  /^(?:(?:so|and|but|ok|okay|well|hi|hey|hello|then|also|now|just)[, ]+)*(?:how|what|when|where|which|who|whose|why|should|would|could|can|do|does|did|is|are|am|will|may|shall|tell me|show me|help|give me|draft|write|explain|teach|walk me|make me|find|suggest|recommend|review|prepare|list|compare|choose|pick|decide|let us (?:plan|do|work))\b/;

/** A question after a statement, as it is typed or heard without its mark ("had my first interview, what do I note down"). */
const ASKS_AFTER =
  /[,;.] (?:so |and |but |then |now )*(?:how|what|when|where|which|who|why|should|would|could|can|do|does|did|is|are|am|will) (?:\w+ )?(?:i|we|you|it|that|this|they|the|my|our|do|should|is|are|would|can)\b|\bor (?:not|wait|later|now)\s*[?.!]*$/;
/** A few words that name a thing ("cofounder shares", "llc or c corp"), not a sentence about someone. */
const FRAGMENT =
  /^(?!(?:(?:so|and|but|ok|okay|well|yes|no|the|an?|my|our|their|his|her|i|we|he|she|they|it|you|this|that|there|every\w+|some\w+|no ?one|nobody|thanks?|great|good|nice|cool|done|sorry|read|cite)\b))(?:[\w$'&/+-]+[, ]*){1,6}[?.!]*$/;
/** They name a thing in a few words: an ask when it names something of the playbook's. */
export function isFragment(text: string): boolean {
  return FRAGMENT.test(plain(text));
}

/** An instruction to do a piece of work with them ("calculate my unit economics", "need an LOI template"). */
const WORK_START =
  /^(?:(?:so|and|but|ok|okay|well|hi|hey|hello|then|also|now|just|please)[, ]+)*(?:need|calculate|plan|grill|build me|build a|fill|brainstorm|check|improve|fix|rewrite|edit|design|outline|critique|challenge|poke|polish|size|work out|put my|describe|summarize my|name my|got (?:a|an|my)\b.*\bhelp)\b|\b(?:vs|versus)\b|\bhelp\s*[?.!]*$|\bi think i should\b|\bmaybe i should\b|\b(?:thinking (?:of|about)|want to|about to) (?:quit|stop|quitting|stopping|dropping out)\b/;

/** The message asks for something (a question, or an instruction to help). */
export function asksFor(text: string): boolean {
  return sentences(text).some(
    (s) =>
      s.endsWith('?') ||
      QUESTION_START.test(s) ||
      WORK_START.test(s) ||
      ASKS_AFTER.test(s) ||
      /\b(?:can|could|would|will) you\b|\bi (?:need|want|would like) (?:you |some |your )*(?:help|advice|to (?:know|understand|learn|figure|decide|get|find))\b|\bhelp me\b|\bi (?:do not|am not sure|am unsure)(?: know)? (?:how|what|which|who|where|whether|if)\b|\bnot sure (?:how|what|which|who|where|whether|if)\b/.test(
        s,
      ),
  );
}

const ACKNOWLEDGES =
  /^(?:(?:ok(?:ay)?|kk?|cool|great|nice|perfect|awesome|got it|sounds good|makes sense|understood|alright|all right|fine|sure|noted|thanks?|thank you|cheers|yep|yeah|yes|right|true|good|will do|lol|haha|wow|hmm+|interesting)[ ,.!]*){1,4}$/;

/** Small talk about the coach: never something to plan. */
const SMALL_TALK =
  /\bweather\b.*\b(?:there|you|where you are)\b|\bhow(?: is| was) your (?:day|week|weekend|morning|evening)\b|\bwhere are you (?:right now|based|from)\b|\byour favou?rite (?:\w+ )?(?:food|colou?r|movie|song|book|team|band)\b|\bdo you (?:even |ever |really )?(?:sleep|eat|dream|have (?:kids|a dog|a cat|hobbies|a family|a life|feelings))\b|\b(?:you have no idea|you do not know) what you are (?:talking|saying)\b/;

/** A social message: a hello, thanks, a goodbye, small talk, a bare "ok" that answers nothing the coach asked. */
export function isSocial(text: string, previousReply: string | null): boolean {
  if (socialTurnOf(text) !== null || wrapUpOf(text)) return true;
  const own = sentences(text);
  if (own.length > 0 && own.every((s) => SMALL_TALK.test(s))) return true;
  if (!ACKNOWLEDGES.test(plain(text).trim())) return false;
  // A bare "yes" to a question answers it.
  return !/\?["'”’)\]*_]*\s*$/.test((previousReply ?? '').trim());
}

const RECALL: readonly RegExp[] = [
  /\bwhat (?:did|have|had) (?:we|you and i|i) (?:just |already )?(?:talk|talked|speak|spoken|say|said|discuss|discussed|decide|decided|agree|agreed|cover|covered|work|worked|plan|planned|do|done)\b.*(?:\b(?:about|on|last|yesterday|before|earlier|previous(?:ly)?|today|session|call|time|week|so far)\b|\?|$)/,
  /\bwhat (?:was|is|were|are) (?:(?:the )?name of )?(?:my|our) (?:startup|venture|idea|business|company|product|plan|decision|goal)(?: idea| name| plan)?\b/,
  /\b(?:do|did) you (?:still )?remember\b|\bremember (?:our|my|the|what) (?:plan|idea|pivot|decision|goal|we|i)\b/,
  /\bremind (?:me|us) (?:what|of|about|where|which|who|how we|how i)\b/,
  /\bhow (?:we|i) got (?:here|to (?:this|where))\b/,
  /\bwhat do you (?:know|remember|have) (?:about|on|of) (?:me|us|my|our)\b/,
  /\bwhere (?:did|had) we (?:leave|left|stop|get)\b|\bwhere were we\b|\blast (?:time|session|call) we\b|\bour last (?:session|call|conversation|chat|talk)\b/,
  /\b(?:summari[sz]e|recap|sum up) (?:what we|our|the|my|where|everything|last|this)\b/,
  /\bwhat (?:have|did) i (?:tell|told) you\b/,
  /\bwhat (?:was|were|is|are) (?:my|our|the) (?:[\w-]+ ){1,5}again\b/,
  // Heard badly: "what does what does my startup idea".
  /^(?:(?:um+|uh+|so|like)[, ]+)*what (?:does|about|is|was) (?:what (?:does|about|is|was) )?(?:my|our) (?:startup |business |venture )?idea\s*[?.!]*$/,
  /\b(?:and )?did (?:i|we) have (?:something|anything) to do\b|\bwhat (?:was|were) (?:i|we) (?:supposed|going|meant) to do\b/,
  /\bwhat did you (?:tell|give|say to) (?:me|us)\b(?! to do)/,
];

/** The message asks what was said, decided or known before. */
export function asksRecall(text: string): boolean {
  return sentences(text).some((s) => RECALL.some((r) => r.test(s)));
}

const REHEARSES =
  /\b(?:role[- ]?play|rehearse|(?:let us |can we |could we |help me )?practi[cs]e (?:my|the|a|our|this) (?:\w+ ){0,2}(?:pitch|interview|call|conversation|meeting|presentation|answer|demo)|pretend (?:to be|you are|you were)|act as (?:a|an|my|the)|play (?:the|a|an) (?:\w+ )?(?:investor|customer|judge|buyer|skeptic|manager|user)|mock (?:pitch|interview|call|meeting))\b/;
const STOPS_REHEARSAL =
  /\b(?:stop|end|pause|finish|out of) (?:the )?(?:role[- ]?play|rehearsal|rehearsing|practice|practicing|character)\b|\bhow did i do\b|\bback to (?:normal|coaching)\b|\bthat is enough\b/;

/** A rehearsal is asked for, or goes on (the coach's last reply was in role and the founder did not stop it). */
export function isRehearsal(args: {
  readonly text: string;
  readonly mode: string | null;
  readonly counterpart: string | null;
  readonly conversationMode: string | null;
  readonly previousReply: string | null;
}): boolean {
  if (args.mode === 'rehearse' || (args.counterpart !== null && args.mode === null)) return true;
  const t = plain(args.text);
  if (args.mode !== null || STOPS_REHEARSAL.test(t)) return false;
  // "How do I rehearse my pitch?" asks for advice; "Can we practise my pitch?" asks to do it.
  if (REHEARSES.test(t) && !/\bhow (?:do|should|can|to|would|could)\b/.test(t)) return true;
  return args.conversationMode === 'rehearse' && args.previousReply !== null && inRole(args.previousReply);
}

const OVERVIEW: readonly RegExp[] = [
  /\b(?:get|getting|be|help me|help us) (?:more )?organized\b|\borganize (?:me|us|my (?:thoughts|work|plan|ideas?|venture|startup|business|time|week))\b/,
  /\bwhat (?:do|should|would|can|must) (?:i|we) (?:do|work on|focus on|tackle|start with)(?: (?:now|next|first|today|this week|from here))?\s*[?.!]*$/,
  /\bwhat (?:is|are|comes?|would be) (?:(?:the|my|our|your) )?(?:next|first|following|right|best) (?:step|thing|move|action|task|priorit)/,
  /\bwhat (?:(?:is|come|comes) )?next(?: (?:for|on|with) (?:me|us|my|our|the)\b.*)?\s*[?.!]*$|\bnext steps?\s*[?.!]*$/,
  /\bwhere (?:do|should|would|can) (?:i|we) (?:start|begin|go from here)\b|\bhow (?:do|should|can) (?:i|we) (?:start|begin|get started)\s*[?.!]*$/,
  /\bwhere (?:am i|are we|do i stand|do we stand)\b(?: (?:at|now|on|in|with) ?(?:this|the|my|our)?)?/,
  /\b(?:give|show|make|build|create|write|draft|need|want) (?:me |us )?(?:a |an |the |my |our )?(?:clear |simple |proper |rigid |concrete |step by step |full |overall )*(?:plan|road ?map|action plan|checklist|to ?do list|path|game plan|next steps)\s*(?:please|for (?:me|us|my (?:venture|startup|idea|business)|the (?:week|month|semester))|to follow)?\s*[?.!]*$/,
  /\b(?:do not know|am not sure|not sure|have no idea|no idea|idk) (?:where to (?:start|begin)|what to do(?: next| now| first)?)\b/,
  /\bwhat did you (?:tell|ask|want) (?:me|us) to do\b/,
  /\b(?:help (?:me|us)|let us|can we|want to|ready to) (?:to )?(?:get started|begin)\b/,
  /\bwhere do (?:i|we) even (?:start|begin)\b|^(?:(?:ok(?:ay)?|so|and|alright|great|done|right)[, ]+)*what (?:now|next)\s*[?.!]*$/,
  /\b(?:give|make|build|write|need|want) (?:me |us )?(?:a |an |the |my )?(?:\w+ )?plan for (?:the |this |my )?(?:next )?(?:\w+ )?(?:weeks?|month|semester|term)\b/,
  /\b(?:ok(?:ay)?,? )?(?:let us get |get |getting )?back to (?:it|work|business|the plan|my plan|our plan)\b/,
  /\bi am (?:lost|overwhelmed|all over the place|stuck and do not know)\b/,
];

/** "What would I do first for that?": about what was just said, not about the whole path. */
const ABOUT_THAT = /\b(?:for|with|on|about) (?:that|this|it|those|these|them|that one|this one)\s*[?.!]*$/;

/** "Get me organized", "what do I do next", "where do I start": the whole path is the answer. */
export function asksOverview(text: string): boolean {
  return sentences(text).some((s) => !ABOUT_THAT.test(s) && OVERVIEW.some((r) => r.test(s)));
}

// ------------------------------------------------------------------------------------------------
// Too big for the time they have
// ------------------------------------------------------------------------------------------------

/** They ask for a smaller step, or say how much time there is for one. */
export interface SmallerAsk {
  /** The time they have for it; null: none said. */
  readonly minutes: number | null;
  /** They said it is too big (a step that would fit is still made smaller). */
  readonly strict: boolean;
  /** For today. */
  readonly today: boolean;
}

const TOO_BIG =
  /\b(?:that|this|it) is (?:(?:a bit|a lot|way|still|kind of|just|probably|honestly|really) )*too (?:much|big|long)\b(?! (?:money|cash|to pay|to charge))|\btoo (?:much|big|long) (?:for me |to do |work )?(?:before|right now|this week|today|tonight|at once)\b|\bsomething (?:much |a bit |a little |a lot )?(?:smaller|shorter|quicker|lighter|easier)\b|\b(?:smaller|shorter|quicker|lighter|mini) (?:step|version|one|task|piece|thing)\b|\bsmallest (?:step|piece|task|first step|thing (?:that )?(?:i|we) can (?:do|finish|get done))\b|\b(?:break|split|cut) (?:it|that|this) (?:down|up|into)\b|\bi (?:can not|do not) (?:fit|have (?:the )?time for) (?:that|this|it|all)\b/;
const EXAMS =
  /\b(?:it is|this is|i am in|i have|i have got|we have|during|until after|because of|in the middle of) (?:my |our |the |an? )?(?:\w+ ){0,2}(?:(?:exam|finals|midterms?) (?:week|season|period)|exams|finals|midterms)\b|^(?:(?:ok|okay|but|sorry|so)[, ]+)?(?:exam|finals|midterms?) week\b|\bmy (?:\w+ )?(?:exam|final|midterm) is (?:today|tomorrow|this week|on (?:mon|tues|wednes|thurs|fri|satur|sun)day)\b/;
const ONE_OR_N = '(half an|an?|one|two|three|four|five|six|seven|eight|ten|\\d+(?:\\.\\d+)?)';
const UNIT = '(hours?|hrs?|minutes?|mins?|evenings?|nights?|afternoons?|mornings?)';
const TIME_HAVE = new RegExp(
  `\\b(?:(?:i|we) (?:only |just |really )*(?:have|got|have got|can give it|can spare|can spend)(?: (?:only|just|about|around|maybe|like|roughly))*|(?:do|finish|fit|done)(?: (?:it|that|this))? (?:in|within|under)|in (?:under|less than|just|only)|what can (?:i|we) do (?:in|with)) ${ONE_OR_N} (?:free |spare |short |single )?${UNIT}\\b(?! of\\b)( (?:a|per|each|every) (?:week|month|day)\\b)?`,
);
const NUMBERS: Readonly<Record<string, number>> = {
  'half an': 0.5,
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  ten: 10,
};
const UNIT_MINUTES: readonly (readonly [RegExp, number])[] = [
  [/^h/, 60],
  [/^min/, 1],
  [/^(?:evening|night)/, 120],
  [/^(?:afternoon|morning)/, 180],
];

/** The time they have in minutes, and whether it is a week's. */
function timeHad(t: string): { minutes: number; weekly: boolean } | null {
  const found = TIME_HAVE.exec(t);
  if (found === null) return null;
  const n = NUMBERS[found[1] ?? ''] ?? Number(found[1]);
  const unit = UNIT_MINUTES.find(([re]) => re.test(found[2] ?? ''))?.[1] ?? 60;
  const minutes = Math.round(n * unit);
  return Number.isFinite(minutes) && minutes > 0 ? { minutes, weekly: found[3] !== undefined } : null;
}

/**
 * "That's too much", "I only have an hour", "it's exam week", "something smaller": the step is to be made smaller, for
 * the time they have when they say it. Null when they ask for nothing of the kind.
 */
export function smallerOf(text: string): SmallerAsk | null {
  const t = plain(text);
  const strict = TOO_BIG.test(t) || EXAMS.test(t);
  const had = timeHad(t);
  if (!strict && had === null) return null;
  // "Tonight" is a time of its own ("what can I do tonight", "something for tonight").
  const tonight = /\b(?:tonight|this evening)\b/.test(t);
  return {
    minutes: had?.minutes ?? (tonight && strict ? 120 : null),
    strict,
    today: tonight || /\b(?:today|right now|this (?:afternoon|morning))\b/.test(t),
  };
}

// ------------------------------------------------------------------------------------------------
// Reports on a step
// ------------------------------------------------------------------------------------------------

export type ReportState = 'done' | 'started' | 'not_yet' | 'blocked' | 'dropped';
export interface MessageReport {
  readonly state: ReportState;
  /** The founder's own sentence that says it. */
  readonly quote: string;
}

const ACTED =
  '(?:did|done|finished|completed|sent|emailed|messaged|called|talked|spoke|spoken|met|interviewed|asked|ran(?! out\\b)|run|launched|posted|published|shipped|signed|built|made|wrote|written|drafted|tested|surveyed|visited|collected|got(?! it\\b)|closed|sold|presented|pitched|submitted|recorded|listed|booked|filed|set up|put up|showed|observed|counted|charged|invoiced|heard)';
const BARE_DONE =
  /^(?:(?:yes|yep|yeah|ok|hi|hey|update|quick update|good news)[,:.! ]+)*(?:done|finished|completed|all done|did it|(?:i|we) did(?: it| that| them)?|it went out|sent(?: it| them)?|it is done|that is done|it worked)\b/;
const ACTED_BY_THEM = new RegExp(
  `\\b(?:i|we|my cofounder|my co-founder|my team|our team) (?:(?:have|had|just|already|finally|also|actually|only|even|then|now) )*${ACTED}\\b`,
);
const NOT_YET =
  /^(?:(?:hi|hey|sorry|honestly|no|nope)[,:.! ]+)*not yet\b|^(?:no|nope)(?:[,.! ]|$)|\b(?:have|had|did|could|was|were) not (?:yet |really |quite |even )*(?:do|done|get|got|gotten|manage|managed|finish|finished|start|started|send|sent|reach|reached|call|called|talk|talked|able|had (?:time|a chance)|have (?:time|a chance)|it|that|them)\b|\b(?:ran out of|no|not enough) time\b|\b(?:i|we) (?:forgot|missed (?:it|that|the))\b/;
const BLOCKED =
  /\b(?:(?:i|we) (?:am|are|was|were|got|get) (?:stuck|blocked)|(?:no ?one|nobody|none of them) (?:has |have |had )?(?:replied|answered|responded|showed|wants?|wanted)|(?:still )?waiting (?:on|for) (?:a |an |the |their |his |her )?(?:reply|answer|response|approval|permission)|(?:could|can) not (?:find|reach|get) (?:anyone|any|them|a single))\b/;
const DROPPED =
  /\bchang(?:ed|ing) (?:of )?(?:the |my |our )?plans?\b|\bchange of plans?\b|\bdecided (?:not to|against)\b|\b(?:dropp?ed|dropping|skipp?ed|skipping|abandon(?:ed|ing)) (?:it|that|this|the (?:step|idea|plan|task))\b|\bno longer (?:going to|doing|need(?:ing)? to)\b|\bgave up on\b/;
const STARTED =
  /\b(?:(?:i|we) (?:have |just )?(?:started|began|begun)|(?:i|we) (?:am|are) (?:working on|half ?way|in the middle of|still doing)|in progress|so far (?:i|we) (?:have)?)\b/;
const FUTURE =
  /\b(?:will|going to|plan(?:ning)? to|want to|hope to|would|should|could|might|about to|need to|have to|if)\b/;
const NEGATED = /\b(?:not|never|no one|nobody|without|nothing)\b/;

/** What others said or asked ("four asked when they could start"): no plan of the founder's. */
const SAID_BY_OTHERS =
  /\b(?:asked|said|told (?:me|us)|wanted to know|wondered)(?: (?:me|us))? (?:(?:when|if|whether|how|where|that) )?(?:they|he|she|it|we|i|people)\b.*$/;

/** A sentence of the founder's that states something happened: not a question, a plan, a wish or a denial. */
export function statesItHappened(sentence: string): boolean {
  const s = plain(sentence);
  if (s.trim().endsWith('?') || QUESTION_START.test(s)) return false;
  const own = s.replace(SAID_BY_OTHERS, '');
  return !FUTURE.test(own) && !NEGATED.test(own);
}

/** The message's own sentences beside their normalised form, so a quote is the founder's words as they wrote them. */
export function ownSentences(text: string): string[] {
  return text
    .split(/(?<=[.?!;])\s+|\n+/u)
    .map((s) => s.trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s));
}

/**
 * What the message reports about something they were to do, with their sentence that says it; null when it reports
 * nothing. The most telling state wins: dropped, blocked, not yet, done, started.
 */
export function reportOf(text: string): MessageReport | null {
  const own = ownSentences(text);
  const find = (test: (s: string) => boolean): string | null => own.find((s) => test(plain(s))) ?? null;
  const asked = (s: string): boolean => s.trim().endsWith('?') || QUESTION_START.test(s);
  const dropped = find((s) => !asked(s) && DROPPED.test(s));
  if (dropped !== null) return { state: 'dropped', quote: dropped };
  const blocked = find((s) => !asked(s) && BLOCKED.test(s));
  const done = find(
    (s) =>
      !asked(s) &&
      ((BARE_DONE.test(s) && !NOT_YET.test(s)) || (ACTED_BY_THEM.test(s) && statesItHappened(s))),
  );
  if (done !== null) return { state: 'done', quote: done };
  if (blocked !== null) return { state: 'blocked', quote: blocked };
  const notYet = find((s) => !asked(s) && NOT_YET.test(s));
  if (notYet !== null) return { state: 'not_yet', quote: notYet };
  const started = find((s) => !asked(s) && STARTED.test(s) && !NEGATED.test(s));
  return started === null ? null : { state: 'started', quote: started };
}

const FINISHED = /\b(?:done|finished|completed|did it|did that|did them|sent (?:it|them)|it went out)\b/;

/**
 * Whether the founder's own report finishes `step` with something to show: it states it happened, it is about this step
 * (or is a plain "done" right after it was asked about), it gives evidence (a count, or a sentence of it), and a count
 * the step's done-when asks for is reached.
 */
export function reportFinishes(
  text: string,
  report: MessageReport,
  step: {
    readonly title: string;
    readonly doneWhen: string;
    readonly items: readonly { readonly do: string }[];
  },
): boolean {
  if (report.state !== 'done') return false;
  const said = plain(text);
  if (asksFor(text) && !FINISHED.test(said)) return false;
  const words = said.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  const counts = countsIn(text);
  if (counts.length === 0 && words < 8) return false;
  const about = new Set(
    contentStems(`${step.title} ${step.doneWhen} ${step.items.map((i) => i.do).join(' ')}`),
  );
  const shared = contentStems(text).filter((w) => about.has(w) && !/^\d+$/.test(w)).length;
  const plainlyDone = FINISHED.test(said);
  if (shared < 2 && !(plainlyDone && shared >= 1) && !(plainlyDone && BARE_DONE.test(said))) return false;
  // A step cut to a part of it asks for no count.
  const needed = /^(?:This one part|These \d+ parts)/.test(step.doneWhen)
    ? null
    : (countsIn(step.doneWhen)[0] ?? null);
  if (needed === null) return true;
  if (counts.length === 0) return plainlyDone;
  return Math.max(...counts) >= needed;
}

// ------------------------------------------------------------------------------------------------
// A choice, a first-time founder, a new idea
// ------------------------------------------------------------------------------------------------

/**
 * The options of a choice the founder asks to have made ("A fixed service, consulting, or some of each?"), as they said them;
 * [] when they ask for none ("or not?" is a yes-or-no question).
 */
export function choiceOf(text: string): string[] {
  const asked = ownSentences(text).filter(
    (s) => /\bor\b/i.test(s) && (s.trim().endsWith('?') || QUESTION_START.test(plain(s))),
  );
  for (const sentence of asked) {
    const body = sentence
      .replace(/[?!.]+\s*$/u, '')
      .replace(/^(?:so|and|but|ok|okay|well|then)[,\s]+/i, '')
      .replace(
        /^(?:should|would|could|do|does|is|are|will|shall|which|what)\b.{0,60}?\b(?:better|best|go with|go for|look for|file|raise|hire|launch|focus on|form|register as|incorporate as|choose|pick|be|do|start with|build|use|sell(?: to)?|target|charge|first|it|this|a|an|the)\b[:,]?\s+(?=\S)/i,
        '',
      );
    const options = body
      .split(/\s*,\s*(?:or\s+)?|\s+or\s+(?:should (?:i|we)\s+)?/i)
      .map((o) => o.replace(/^(?:a|an|the|either)\s+/i, '').trim())
      .filter((o) => o !== '');
    if (options.length < 2 || options.length > 5) continue;
    if (
      options.some((o) => /^(?:not|no|something|anything|whatever|so)$/i.test(o) || o.split(/\s+/).length > 9)
    )
      continue;
    return options;
  }
  return [];
}

const FIRST_TIME =
  /\b(?:never (?:done|started|built|run|had|tried) (?:this|that|anything|one|it|a (?:startup|business|venture|company))|first[- ]time (?:founder|entrepreneur)|(?:this is )?(?:my|our) first (?:startup|venture|business|company|time)|(?:do not|did not) know (?:anything|much|a thing|the first thing) about (?:business|startups?|entrepreneurship|running)|know nothing about (?:business|startups?)|new to (?:business|startups?|entrepreneurship|commerciali[sz]ation|this)|no (?:business|startup) (?:experience|background|knowledge)|(?:complete |total )?beginner)\b/;

/** They say they have never done this before. */
export function saysFirstTime(text: string): boolean {
  return sentences(text).some((s) => FIRST_TIME.test(s));
}

// ------------------------------------------------------------------------------------------------
// What they say they will do, the idea in their own words, and a change of it
// ------------------------------------------------------------------------------------------------

/** What they say they will do, in their words, and the day they said. */
export interface Commitment {
  /** "Email the five theatre groups": their clause, without "I'll" and the day. */
  readonly clause: string;
  readonly dueOn: string | null;
  /** The clause is about what was just agreed ("I'll do that", "eight of those"). */
  readonly about: boolean;
}

const WILL_DO =
  /\b(?:(?:the|my|our) plan is to|(?:i|we)(?:['’]ll| will| am going to| are going to|['’]m going to|['’]re going to|['’]m gonna| gonna| can)) (?:(?:go|just|then|also|definitely|try to|get to|start by|go ahead and) )*((?:email|call|text|message|dm|talk|speak|interview|ask|meet|visit|send|write|draft|build|make|post|launch|run|test|sell|survey|list|set up|book|finish|do|try|show|print|hand out|put up|submit|file|read|contact|reach out|pitch|find|pick|choose|count|track|offer|charge|follow up|start with|get)\b[^.!?;\n]*)/iu;
const DAY_PHRASE =
  /[,\s]+(?:(?:by|before|on|until|for) )?(?:the )?(?:end of (?:the |this )?(?:day|week)|this (?:week|weekend|afternoon|evening|morning)|next (?:week|\w+day)|(?:this )?(?:mon|tues|wednes|thurs|fri|satur|sun)day(?: (?:night|evening|morning|afternoon))?|today|tonight|tomorrow(?: (?:night|evening|morning|afternoon))?|(?:in|within) (?:the next )?\w+ (?:days?|weeks?)|(?:january|february|march|april|may|june|july|august|september|october|november|december)\.? \d{1,2}(?:st|nd|rd|th)?)\b/giu;

/** What the message says they will do; null for a question, a condition, a wish, or nothing. */
export function commitmentOf(text: string, today: string): Commitment | null {
  for (const sentence of ownSentences(text)) {
    const s = plain(sentence);
    if (
      s.endsWith('?') ||
      /\b(?:if|when|once|unless|maybe|might|someday|eventually|not sure|should|could)\b/.test(s)
    )
      continue;
    const found = WILL_DO.exec(sentence);
    if (found?.[1] === undefined) continue;
    const said = found[1].replace(/\s+/g, ' ').trim();
    const clause = said
      .replace(DAY_PHRASE, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[\s,.:;]+$/u, '')
      .trim();
    if (clause === '' || /^(?:get|make|find) (?:it|sure|there|back to you)\b/i.test(clause)) continue;
    const about =
      /^(?:do|try|start with|run|finish|send|write|make|test|get) (?:just )?(?:that|this|it|those|these|them|so)\b/i.test(
        clause,
      ) || /\b(?:of|with|like) (?:those|these|them|that|it)\b/i.test(clause);
    return { clause, dueOn: daySaid(sentence, today), about };
  }
  return null;
}

/** A commitment worth keeping: to what was just agreed, for a day, or of a number. */
export function isCommitted(c: Commitment | null): c is Commitment {
  return c !== null && (c.about || c.dueOn !== null || countsIn(c.clause).length > 0);
}

/**
 * Pushes on what a qualified person decides, or on what is never shared: who exactly, what to bring, "you decide", "yes or
 * no", "just a hint", "the lead said you can".
 */
const PUSHES =
  /\b(?:who (?:exactly |else )?(?:do|should|can|would) (?:i|we) (?:ask|see|talk|speak|go|contact|call|email|meet|write)|what (?:exactly )?(?:do|should) (?:i|we) (?:bring|take|tell|show|say|ask)|lawyers?|attorneys?|you decide|your call|just (?:decide|tell|say|answer|give)|a hint|come on|yes or no|guarantee|promise me|sign(?:ing|ed)?|take it away|off the record|between (?:us|you and me)|hypothetically|said (?:that )?(?:you|it is)|you can tell|you (?:also )?(?:coach|know) (?:them|him|her|that team)|your (?:opinion|guess|view)|what would you do|is (?:that|it) (?:right|legal|allowed|ok|okay|safe)|are you sure|but (?:you|i) (?:must|have to|need))\b/;
export function pushesOn(text: string): boolean {
  return PUSHES.test(plain(text));
}

/** Objects that are a task of the work, never the venture ("I'm building a prototype", "I want to make a survey"). */
const TASK_OBJECT =
  /^(?:(?:an?|the|my|our|some|this|that|it|them|one|another|first) )*(?:it|this|that|them|prototype|mock-?ups?|pitch|deck|slides?|landing page|survey|plan|list|website|site|mvp|canvas|model|interviews?|company|business plan|money|sense|progress|sure|decision|call|calls|list|test|demo|video|logo|name|friends?|start|something)\b/i;
/** What they think of it, never what it is ("my idea is really good"). */
const OPINION =
  /^(?:(?:really|so|very|pretty|quite|just|still|not|kind of|only|a bit|too) )*(?:great|good|bad|promising|stupid|dumb|amazing|simple|new|ok|okay|solid|unique|brilliant|crazy|early|rough|vague|big|small|ready|done|working|failing|better|different|the same|an? (?:idea|mess|start|joke))\b/i;
const IDEA_FORMS: readonly RegExp[] = [
  /\b(?:my|our|the) (?:startup |business |venture |new |big )*idea (?:is|was)(?: (?:simple|this))?(?: (?:to|for|about))?[:,]?\s+(\S.*)$/iu,
  /\b(?:i|we)(?:['’]m| am|['’]re| are) (?:currently |now )?(?:building|making|creating|developing|starting|launching|designing|selling|opening|running|inventing)\s+(\S.*)$/iu,
  /\b(?:i|we)(?:['’]ve| have|['’]ve got| got| had)? (?:had |got )?an? (?:startup |business |venture |app )?idea for (\S.*)$/iu,
  /\b(?:i|we)(?:['’]ve| have) been (?=(?:offering|selling|making|building|running|renting)\b)\w+ (\S.*)$/iu,
  /\b(?:i|we)(?:['’]d like to| would like to| want to| plan to| hope to|['’]d| would) (?=(?:build|make|create|start|sell|open|offer|rent|launch|run|fix|design|develop|deliver|repair|bring)\b)(\S.*)$/iu,
  /^(?:(?:so|well|basically|hi|hello|ok|okay)[, ]+)*(?:we|i) (?=(?:sell|make|rent|repair|deliver|print|offer|match|teach|run|design|build)\b)(\S.*)$/iu,
];
const CALLED =
  /\b(?:[Ii]t|[Tt]he (?:app|venture|startup|company|project|idea))(?:['’]s| is) (?:called|named)\s+(["“]?[\p{Lu}\d][\p{L}\d&'’-]*(?: [\p{Lu}\d][\p{L}\d&'’-]*){0,2}["”]?)/u;

/** Most characters of an idea kept (`PathIntake.idea`). */
const IDEA_CHARS = 400;

function clip(text: string, most = IDEA_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= most) return flat;
  const cut = flat.slice(0, most);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), most - 40)).trim();
}

const endless = (text: string): string => text.replace(/[\s.!,;:]+$/u, '').trim();

/**
 * The founder's idea as they state it, word for word (a clause of at most 400 characters): "my idea is…", "we're
 * building…", "we sell…", "it's called X, an app that…", "X matches…" with the venture's own name. Null when the message
 * states none (a question, a task, a report).
 */
export function statedIdea(text: string, ventureName: string): string | null {
  const own = ownSentences(text);
  const named = ventureName.trim();
  for (let i = 0; i < own.length; i += 1) {
    const sentence = own[i] ?? '';
    const s = plain(sentence);
    if (s.endsWith('?') || QUESTION_START.test(s) || HYPOTHESIS.test(s)) continue;
    const called = CALLED.exec(sentence);
    if (called?.[1] !== undefined) {
      const from = endless(sentence.slice(sentence.indexOf(called[1])));
      const next = own[i + 1];
      const told =
        contentStems(from).length >= 4 || next === undefined || plain(next).endsWith('?')
          ? from
          : `${from}. ${endless(next)}`;
      if (contentStems(told).length >= 3) return clip(told);
      continue;
    }
    if (named.length >= 3 && sentence.toLowerCase().startsWith(named.toLowerCase())) {
      const rest = sentence.slice(named.length);
      if (
        /^\s+(?:is|are|would|will|lets?|helps?|gives?|\p{Ll}+s)\s/u.test(rest) &&
        contentStems(rest).length >= 3
      )
        return clip(endless(sentence));
    }
    for (const form of IDEA_FORMS) {
      const clause = form.exec(sentence)?.[1];
      if (clause === undefined) continue;
      const bare = endless(clause.replace(/[,;]?\s+(?:but|and (?:nobody|no one|it|they))\b.*$/iu, ''));
      const object = bare.replace(
        /^(?:build|make|create|start|sell|open|offer|rent|launch|run|fix|design|develop|deliver|repair|bring|help|print|match|teach)\s+/i,
        '',
      );
      if (TASK_OBJECT.test(object) || OPINION.test(bare) || contentStems(bare).length < 3) continue;
      return clip(bare);
    }
  }
  return null;
}

const HYPOTHESIS = /\b(?:if i|if we|what if|suppose|imagine|thinking (?:of|about) (?:quitting|stopping))\b/;

/** A change of the idea: their sentence that says so, and the new idea in their words. */
export interface Pivot {
  readonly quote: string;
  readonly to: string;
}

const PIVOTS =
  /\b(?:i|we|my team|our team)(?: are| am| have)?(?: now| just| all| both| finally)* (?:decided (?:to pivot|on a pivot)|decided: (?:we|i) pivot|agreed to pivot|pivoting|pivoted|pivot)\b|\bwe pivot\b/;
const SWITCHES =
  /\b(?:i|we)(?: are| am| have)?(?: now| just)* (?:(?:switch(?:ed|ing)|chang(?:ed|ing)) (?:(?:the|our|my) (?:whole )?(?:idea|business|product|venture|startup|customers?)|direction)\b|switch(?:ed|ing) (?:from [^.,;]{3,60} )?to (?:selling|building|making|renting|offering|serving|targeting|doing)\b)/;
const NOW_DOING =
  /\b(?:i|we) are now (?:doing|building|selling|making|offering|renting|focusing on|going after|serving|targeting)\b/;
const PIVOT_TO =
  /\b(?:pivot(?:ing|ed)?|switch(?:ed|ing)?|chang(?:ed|ing))(?: (?:the|our|my) (?:whole )?(?:idea|business|product|venture|startup|customers?)| direction)?(?: from [^.,;]{3,80}?)? (?:to|toward|towards|into) (?:(?:we|i) (?:['’]?(?:re|ll|m)|are|will|am) )?(?:now )?(\S.*)$/iu;
const NOW_CLAUSE =
  /\bnow ((?:doing|building|selling|making|offering|renting|focusing on|going after|serving|targeting)\b.*)$/iu;
const INSTEAD =
  /\b(?:instead|no more|no longer|stop(?:ped|ping)? (?:selling|making|doing|building|serving)|from now on|rather than)\b/;

/**
 * The change of direction a message states ("we decided to pivot to…", "I'm pivoting. No more lunches, I'll rent…
 * instead"), with the new idea in their own words; null when it asks about one, recalls one, or names no new idea.
 */
export function pivotOf(text: string): Pivot | null {
  const own = ownSentences(text);
  for (let i = 0; i < own.length; i += 1) {
    const sentence = own[i] ?? '';
    const s = plain(sentence);
    if (
      s.endsWith('?') ||
      QUESTION_START.test(s) ||
      WORK_START.test(s) ||
      ASKS_AFTER.test(s) ||
      /\b(?:if|should|might|maybe|thinking (?:of|about)|not)\b/.test(s)
    )
      continue;
    const cue =
      PIVOTS.test(s) || (SWITCHES.test(s) && contentStems(sentence).length >= 3) || NOW_DOING.test(s);
    if (!cue) continue;
    const to = PIVOT_TO.exec(sentence)?.[1] ?? NOW_CLAUSE.exec(sentence)?.[1];
    if (to !== undefined && contentStems(to).length >= 2) return { quote: sentence, to: clip(endless(to)) };
    // The sentences after "we're pivoting" tell the new idea.
    const told: string[] = [];
    for (const later of own.slice(i + 1, i + 4)) {
      const l = plain(later);
      if (l.endsWith('?') || QUESTION_START.test(l)) break;
      if (told.length === 0 && !INSTEAD.test(l) && !/\b(?:i|we) (?:will|are|am) \w+/.test(l)) continue;
      told.push(endless(later));
      if (INSTEAD.test(l)) break;
    }
    if (told.length > 0 && contentStems(told.join('. ')).length >= 3)
      return { quote: sentence, to: clip(told.join('. ')) };
  }
  return null;
}

/** Names an idea outright ("I have an idea for…", "we want to build…", "what if there was an app…"). */
const IDEA_CUE =
  /\b(?:(?:my|our|the|an|a new|another|new|different|second) (?:startup |business |venture )?idea (?:is|was|for|about|of|to)|(?:i|we) (?:have|had|got|came up with|am thinking of|are thinking of|thought of) (?:an?|another|a new|this) (?:startup |business |venture |new )*idea|(?:i|we) (?:want|would like|plan|am going|are going|hope|am thinking|are thinking|am planning|are planning)(?: to| of| about)+ (?:build|building|start|starting|make|making|create|creating|launch|launching|found|founding|open|opening|offer|offering|sell|selling|develop|developing)|what if (?:there (?:was|were|is)|we|i) (?:built?|made|an?|created?)|(?:i am|we are) (?:building|starting|creating|launching|working on) (?:an?|some)|how about (?:an?|building))\b/;
/** "What about AI helpers that fill in forms for clinics?": an idea put as a question, when it describes one. */
const ABOUT_CUE = /\b(?:how|what) about\b/;
/** A noun phrase that describes a venture ("AI agents for companies' admin processes"). */
const IDEA_SHAPE =
  /\b(?:apps?|helpers?|assistants?|platforms?|tools?|services?|agents?|software|marketplaces?|websites?|devices?|products?|business|startups?|agency|saas|robots?|bots?|subscriptions?|kits?|machines?|drones?|sensors?|network|shop|store|brand)\b(?: \w+){0,3} (?:for|that|to help|which|where)\b/;
/** Ideas are told, not asked about ("is there a tool for…", "what app do I use for…"). */
const ASKS_ABOUT = /^(?:is|are|do|does|what|which|where|who|how|when|why|can|could|should|would|any)\b/;

/** The sentences of the message that describe a venture idea. */
export function ideaSentences(text: string): string[] {
  const own = ownSentences(text);
  const out: string[] = [];
  own.forEach((sentence, i) => {
    const s = plain(sentence);
    const cue = IDEA_CUE.test(s) || (ABOUT_CUE.test(s) && IDEA_SHAPE.test(s));
    const shape = IDEA_SHAPE.test(s) && !s.endsWith('?') && !ASKS_ABOUT.test(s);
    if (!cue && !shape) return;
    // "I've got a venture idea, could you get me organised?" names none.
    out.push(sentence);
    // "My idea is this. Scooters that…": the sentence after a bare cue tells it.
    const next = own[i + 1];
    if (cue && subjectStems(sentence).length < 2 && next !== undefined && !plain(next).endsWith('?'))
      out.push(next);
  });
  return out;
}

/**
 * Whether the message describes a venture idea the record does not hold: at least two subject words, none of them in
 * what names the venture, and at most a quarter of them anywhere in its record. A venture without a record of its own
 * has no other idea to differ from.
 */
export function bringsNewIdea(
  text: string,
  record: { readonly core: string; readonly all: string; readonly substantial: boolean },
): boolean {
  if (!record.substantial) return false;
  const described = ideaSentences(text);
  if (described.length === 0) return false;
  const subjects = [...new Set(described.flatMap(subjectStems))];
  if (subjects.length < 2) return false;
  const core = new Set(subjectStems(record.core));
  if (subjects.some((w) => core.has(w))) return false;
  const all = new Set(subjectStems(record.all));
  const known = subjects.filter((w) => all.has(w)).length;
  return known * 4 <= subjects.length;
}

/** Words of the work itself: a question that names one asks about the venture, whatever else it says. */
const WORK_WORDS: ReadonlySet<string> = new Set(
  (
    'idea venture startup start business company app product customer user client market sell sale buyer pay price pricing ' +
    'money cost revenue pitch investor funding grant competition prototype interview email plan step launch page deck canvas ' +
    'cofounder patent contract tax visa equity'
  ).split(' '),
);

/** The founder is upset: nothing is pushed on them. */
export function isInDistress(text: string): boolean {
  return inDistress(text);
}

/** The founder is upset and asks nothing about the work ("I'm overwhelmed. Where do I start?" does). */
export function needsAPerson(text: string): boolean {
  if (!inDistress(text)) return false;
  return !sentences(text).some(
    (s) => (s.endsWith('?') || QUESTION_START.test(s)) && contentStems(s).some((w) => WORK_WORDS.has(w)),
  );
}
