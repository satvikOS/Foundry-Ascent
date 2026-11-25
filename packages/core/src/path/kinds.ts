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
      /\b(?:can|could|would|will) you\b|\b(?:just |please |so |now |then )?(?:tell|show|teach) me (?:what|how|why|where|which|who|if|whether|exactly|honestly|straight)\b|\bwhat is wrong with\b|\bi (?:need|want|would like) (?:you |some |your )*(?:help|advice|to (?:know|understand|learn|figure|decide|get|find))\b|\bhelp me\b|\bi (?:do not|am not sure|am unsure)(?: know)? (?:how|what|which|who|where|whether|if)\b|\bnot sure (?:how|what|which|who|where|whether|if)\b/.test(
        s,
      ),
  );
}

const ACKNOWLEDGES =
  /^(?:(?:ok(?:ay)?|kk?|cool|great|nice|perfect|awesome|got it|sounds good|makes sense|understood|alright|all right|fine|sure|noted|thanks?|thank you|cheers|yep|yeah|yes|good|will do|lol|haha|wow)[ ,.!]*){1,4}$/;

/** Small talk about the coach: never something to plan. */
const SMALL_TALK =
  /\bweather\b.*\b(?:there|you|where you are)\b|\bhow(?: is| was) your (?:day|week|weekend|morning|evening)\b|\bwhere are you (?:right now|based|from)\b|\byour favou?rite (?:\w+ )?(?:food|colou?r|movie|song|book|team|band)\b|\bdo you (?:even |ever |really )?(?:sleep|eat|dream|have (?:kids|a dog|a cat|hobbies|a family|a life|feelings))\b/;

/** Wishes, farewells and hellos the social turn's own words do not know ("have a great weekend", "I'm back", "see you Monday"). */
const COURTESY: readonly RegExp[] = [
  /\b(?:have|enjoy) (?:a|an|the|your) (?:(?:very|really|super) )?(?:(?:great|good|nice|lovely|fun|happy|safe|restful|wonderful) )?(?:day|evening|night|morning|afternoon|weekend|week|break|holidays?|one|rest|trip)\b(?: (?:everyone|all|too|off|ahead|of your day))?/g,
  /\b(?:happy|merry) (?:new year|\p{L}+(?:day|days|mas|giving|s))\b(?: to (?:you|all)(?: and (?:yours|your family))?)?/gu,
  /\bsee (?:you|ya|u)(?: (?:on|later|soon|tomorrow|then|around|next (?:week|time)|again|(?:mon|tues|wednes|thurs|fri|satur|sun)day|there))*\b/g,
  /\b(?:talk|speak|chat) (?:to you |soon|later|tomorrow|then|again)+\b|\b(?:catch you (?:later|soon)|ttyl|bye|goodbye|good ?night|take (?:care|it easy))\b/g,
  /\bi am back\b/g,
  /\b(?:nice|good|great|lovely) to meet you\b(?:[,.! ]+i am \p{L}+)?|\b(?:nice|good|great|lovely) to (?:see|hear from) you\b|\bhope (?:you are|all is|your \w+ is) (?:well|good|going well|doing well)\b/gu,
  /\byou (?:are|rock)(?: (?:so|the|a|very|really|just))* (?:best|funny|great|awesome|kind|sweet|nice|legend|lifesaver|star)\b|\byou (?:really |just )?(?:helped|saved)(?: me| us)?(?: (?:so much|a lot|today|out|again))*\b/g,
  /\b(?:yo|hi|hello|hey|hiya|good (?:morning|afternoon|evening|day)|thanks?|thank you|cheers|thx|ty|what is up)\b/g,
];
/** Words beside a courtesy that add nothing to it. */
const BESIDE_COURTESY =
  /\b(?:i )?(?:have|got|need) to (?:go|run)\b|\bi have (?:a )?(?:class|lab|practice|work)(?: now| soon)?\b|\b(?:alright|welcome|tons?|a lot|so much|a million|again|there|lol|haha+|ok(?:ay)?|well|and|a|too|then|now|later|soon|today|for now|this was (?:great|helpful))\b/g;

/** Nothing but courtesy: once the polite words are out, nothing is left. */
function isCourtesy(text: string): boolean {
  const said = plain(text);
  if (said.includes('?') || said.length > 90 || /\d/.test(said)) return false;
  let rest = said;
  for (const part of COURTESY) rest = rest.replace(part, ' ');
  return rest !== said && !/[\p{L}\p{N}]/u.test(rest.replace(BESIDE_COURTESY, ' '));
}

/** A few words that only react to what was said: they name nothing to plan, whatever words they hold. */
const REACTIONS =
  /^(?:(?:ok(?:ay)?|so|well|yeah|yes|no|hmm+|oh|ah|wow|wait|lol|right|honestly|i mean|but|um+|uh+)[,.! ]+)*(?:(?:that |this |it )?(?:all |really |kind of |sort of |totally )?makes? (?:a lot of |total |more |perfect |some )?sense(?: (?:now|to me|i guess))?|(?:that is |this is )?(?:fair|fair enough|a (?:good|fair|great) point|good point|interesting|fascinating|helpful|useful|a lot(?: to take in)?|new to me|good to (?:know|hear)|what i thought|funny|wild|crazy|true|right|wrong)|i (?:see|get it|got it|agree|disagree|guess so|think so|do not (?:think so|agree|get it|know)|hear you|like (?:that|it|this|(?:the )?(?:first|second|third|last|other) (?:one|idea|option)(?: better| more| best)?)|am not sure(?: (?:about that|i (?:agree|follow|buy (?:it|that))))?(?: with (?:that|you|this))?)|(?:wait|really|seriously|huh|what|sorry|pardon|no way|is it|are you (?:sure|serious))|what do you mean(?: by (?:that|this|it))?|(?:can you )?(?:say|explain) (?:that|it|this)(?: again)?(?: but)?(?: (?:slower|more slowly|simpler|differently|in other words))?|come again|not (?:quite|really|exactly|sure|yet)|maybe|perhaps|i will think about (?:it|that)|let me think(?: about (?:it|that))?|got it|noted|understood|interesting)(?:[,.! ]+(?:maybe|i will think about (?:it|that)|i guess|though|then|not quite|thanks?|really|wow|interesting|that is a lot))*[\s.!?]*$/;

/** Only a reaction ("fair enough", "wait, really?", "what do you mean by that?"): it goes on about what was said. */
export function isReaction(text: string): boolean {
  const said = plain(text).replace(/\s+/g, ' ').trim();
  return said !== '' && said.length <= 90 && REACTIONS.test(said);
}

/** What someone who is having a hard time says of themselves, about nothing to work on. */
const VENTS =
  /\bugh\b|\b(?:i|me) (?:just |really |still |also |so |kind of )*(?:feel|am feeling|felt|have been feeling)\b|\bi (?:am|have been) (?:so|just|really|very|too|honestly|super|completely)? ?(?:tired|exhausted|sad|lonely|alone|sick of|done|fed up|homesick|drained|overwhelmed|stressed|anxious|miserable|angry|upset|over it)\b|\b(?:i|we) (?:hate|cried|miss|(?:bombed|failed) (?:my|the|a|an) (?:\w+ )?(?:exam|quiz|midterm|final|class|course|paper)|cannot (?:think|sleep|focus|cope|stand)|want to (?:hide|cry|scream|sleep))\b|\b(?:worst|awful|terrible|horrible|bad|rough) (?:day|week|month|semester|night)\b|\b(?:nobody|no one) (?:understands (?:me|us|this|that|how hard)|cares|gets it|likes me)\b|\bdriving me (?:crazy|nuts|insane)\b|\bin the hospital\b|\bsick of\b|\bmy brain is\b|\beverything (?:went|is going|goes) wrong\b|\bcut out for\b/;

/** What they work on, beside the words of a question about it: hard, it is the work's to help with. */
const AT_WORK: ReadonlySet<string> = new Set(
  'test pilot demo cold call calling outreach selling meeting survey competitor marketing channel hire experiment lead lawyer team'.split(
    ' ',
  ),
);

/** They tell how hard things are, and nothing of the work: nothing is planned for it, and no task pushed. */
export function isVenting(text: string): boolean {
  if (asksFor(text)) return false;
  const said = plain(text);
  return VENTS.test(said) && !contentStems(said).some((w) => WORK_WORDS.has(w) || AT_WORK.has(w));
}

/** Anger or weariness at the work or at the advice: answered, with what stands on their path. */
const FRUSTRATED =
  /\bugh+\b|\bhate (?:this|it|that|everything about|you|these)\b|\bsick of (?:this|it|that|you|doing)\b|\bdriving me (?:crazy|nuts|insane)\b|\bfed up\b|\bover it\b|\bi am done\b|\b(?:useless|pointless|nonsense|waste of (?:my )?time)\b|\bnothing (?:works|is working)\b/;

const THEIR_PEOPLE =
  /\bmy (?:\w+ )?(?:roommate|housemate|mom|mum|mother|dad|father|parents?|brother|sister|family|boyfriend|girlfriend|partner|friends?|grandma|grandpa|professor|boss|ex)\b/;

/** They tell how hard their life is right now, and nothing of the work: a person first, and no step. */
export function isHardship(text: string): boolean {
  const said = plain(text);
  return isVenting(text) && (!FRUSTRATED.test(said) || THEIR_PEOPLE.test(said));
}

/** A statement that says what they want, lack, fear or cannot get done: it asks for help without asking. */
const NEEDS =
  /\b(?:need|want|wish|hope|trying|try|looking for|search(?:ing)?|struggl\w*|stuck|lost|unsure|not sure|wonder\w*|confus\w*|worried|nervous|afraid|scared|torn|undecided|no (?:idea|clue)|cannot|can not|could not|will not|would not|do not|does not|did not|never|nobody|no one|none|nothing|keeps?|too (?:many|much|few|big|small|expensive|early|late)|instead|rather|should|might|maybe|thinking (?:of|about)|supposed to|have to|must|only (?:have|know)|how|what|which|whether|where|who|why|if|but|or)\b/;

/** A social message: a hello, thanks, a goodbye, small talk, a bare "ok" that answers nothing the coach asked. */
export function isSocial(text: string, previousReply: string | null): boolean {
  if (socialTurnOf(text) !== null || wrapUpOf(text) || isCourtesy(text)) return true;
  const own = sentences(text);
  if (own.length > 0 && own.every((s) => SMALL_TALK.test(s))) return true;
  if (!ACKNOWLEDGES.test(plain(text).trim())) return false;
  // A bare "yes" to a question answers it.
  return !/\?["'”’)\]*_]*\s*$/.test((previousReply ?? '').trim());
}

const RECALL: readonly RegExp[] = [
  /\bwhat (?:did|have|had) (?:we|you and i|i) (?:just |already )?(?:talk|talked|speak|spoken|say|said|discuss|discussed|decide|decided|agree|agreed|cover|covered|work|worked|plan|planned|do|done)\b.*(?:\b(?:about|on|last|yesterday|before|earlier|previous(?:ly)?|today|session|call|time|week|so far)\b|\?|$)/,
  /\bwhat (?:was|is|were|are) (?:(?:the )?name of )?(?:my|our) (?:startup|venture|idea|business|company|product|plan|decision|goal)(?: idea| name| plan)?\b(?! (?:really |actually |even )?worth\b)/,
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
  // The story.
  /\b(?:tell|give|walk|take|show|read) (?:me|us)(?: through| over)?(?: back)? (?:the |my |our |this )?(?:(?:whole|full|entire|complete|short) )?(?:story|history|journey|timeline)\b/,
  /\b(?:whole|full|entire) (?:story|history|journey)\b|\b(?:the|our|my) (?:story|journey|timeline) so far\b/,
  /\bhow (?:did|have) (?:we|i) (?:get|got|end up|ended up|arrive|come) (?:here|to (?:this|where)|this far)\b|\bwhy (?:we|i) are where (?:we|i) are\b|\bwhy are (?:we|i) where (?:we|i) are\b/,
  /\b(?:everything|all) (?:that )?(?:we|i)(?: have)? (?:did|done|tried|decided|learned|found)(?: out)?(?: so far| until now| up to now)?\s*[?.!]*$|\bwhat (?:has|have) (?:happened|i done|we done|i tried|we tried|i learned|we learned) (?:so far|until now|up to now|since)\b/,
  /\b(?:recap|summary|rundown|run ?down|overview) of (?:everything|what (?:we|i)|our|my|where|the (?:story|last))\b|\b(?:give|need|want) (?:me |us )?(?:a |the )?(?:quick |short |full )?recap\b|^(?:quick |please |a )*recap(?: please| me| us)?\s*[?.!]*$/,
  // Which idea, and what the venture has.
  /\bwhich (?:of (?:the|my|our|those|these) (?:two |three |2 |3 )?)?(?:ideas?|ventures?|directions?|versions?|plans?|one) (?:are|am|is) (?:we|i|it)(?: still)? (?:on|doing|working on|at|with|in|building|following)\b|\bwhich (?:idea|venture|direction|version) (?:is|are) (?:it|this|we|the current|current|live|open|active|now)\b/,
  /\bwhat (?:idea|venture|direction|version) (?:are|am) (?:we|i)(?: currently| still)? (?:on|doing|working on|building|pursuing)\b|\bwhat (?:is|was) (?:the|my|our) (?:current|latest|new|first|old|original|previous) (?:idea|direction|venture|version|plan)\b/,
  /\bare (?:we|i) still (?:on|doing|building|going with|working on)\b|\bwhat (?:are|am) (?:we|i) (?:building|making|selling|doing) (?:now|again|these days|at the moment)\b/,
  /\bwhat (?:[\w'&-]+ ){1,3}(?:has|have|had)(?: got| proven| shown)?(?: so far)?,? (?:and|and what) (?:what )?(?:it |we |i |they |is |are )?(?:has|have|had|do|does|is|are|still)?\s*(?:not|no|missing|lacks?|left|to (?:do|prove|show))\b|\bwhat (?:do|does) (?:[\w'&-]+ ){1,3}have (?:and|or) (?:not|lack|what)\b/,
  /\bwhat (?:have|has) (?:we|i|[\w'&-]+) (?:actually |really )?(?:proven|proved|shown|achieved|learned|got|validated)(?: so far| yet)?\s*[?.!]*$|\bwhat (?:do|does) (?:we|i|[\w'&-]+) (?:actually |really )?(?:have|know)(?: for sure)? so far\b|\bwhat (?:do|does) (?:we|i) know for (?:sure|certain)\b/,
  /\bwhat (?:is|are)(?: still)? (?:missing|left to (?:prove|show)|proven|proved|not proven)(?: (?:for|in|from|with) (?:my|our|the|this) (?:venture|startup|idea|business|company|project|path|record))?\s*[?.!]*$|\bwhat (?:am|are) (?:i|we)(?: still)? missing\b|\bwhat (?:has|have) (?:[\w'&-]+ )?(?:not been|still to be) (?:proven|shown)\b/,
  /\b(?:status|state) of (?:my|our|the) (?:venture|startup|idea|business|company|project)\b|\bwhere (?:does|is) (?:my|our|the) (?:venture|startup|idea|business|company|project) (?:stand|at|now)\b/,
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
  /\b(?:get|getting|be|help me|help us) (?:(?:more|me|us|it|this|that|all of (?:it|this)|everything|my (?:\w+ ){0,2}\w+) )?organized\b|\borganize (?:me|us|my (?:thoughts|work|plan|ideas?|venture|startup|business|time|week))\b/,
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
  /\bi am (?:lost|overwhelmed|all over the place|stuck and do not know)\b/,
  // In fewer words, and other words.
  /\bwhat should (?:i|we) be (?:doing|working on|focusing on)\b|\bwhat (?:do|should|can|would) (?:i|we) do (?:this|next|the coming) (?:week|weekend|month|semester)\b/,
  /\bwhat (?:i|we) (?:must |should |can |have to |need to )?do (?:tomorrow|tonight|today|now|right now|next|first|this week|on monday)\b/,
  /\bwhat (?:do|should|would|can) (?:i|we) do (?:tomorrow|tonight|today|now|right now|on monday)(?: (?:morning|afternoon|evening|night))?\b/,
  /\bwhat would you do(?: (?:first|next|now|right now))?(?: if (?:you|this|it) (?:were|was) (?:me|yours?|your (?:idea|venture|startup))| in my (?:place|shoes|position|situation)| as me)\b/,
  /\b(?:my|your|the|any|give me|marching) orders(?: please| boss| now| for (?:today|this week))?\s*[?.!]*$|^(?:(?:ok(?:ay)?|yes|so|fine|right|alright|boss|chief|captain|coach)[,. ]+)*orders(?: please| boss)?\s*[?.!]*$/,
  /\b(?:just )?tell me (?:exactly |straight |simply )?what (?:to do|i (?:do|should do|have to do|need to do|must do))(?: (?:next|now|first|today|this week|tomorrow))?\s*[?.!]*$/,
  /\b(?:give|tell|name) me (?:just |only )?(?:one|a single|the one) (?:thing|task|job|action|step)(?: (?:to do|i (?:can|should|must) do|that i (?:can|should) do)\b.{0,60})?\s*[?.!]*$|\bone thing,? what (?:would|should|is) it (?:be)?\b/,
  /\b(?:the |your |my )?least (?:dumb|stupid|bad|risky)(?: one| thing| move| option)?\b/,
  /\bwhat is the (?:one|single|most (?:useful|important)|smartest|best|least (?:dumb|stupid|bad)) (?:thing|move|step) (?:i|we|to|that i|that we)\b/,
  /\bwhat (?:is|are) my (?:step|steps|task|tasks|homework|assignment|to ?do|job)(?: (?:now|today|this week|right now|for (?:today|this week|now)))?\s*[?.!]*$/,
];

/** "What would I do first for that?": about what was just said, not about the whole path. */
const ABOUT_THAT = /\b(?:for|with|on|about) (?:that|this|it|those|these|them|that one|this one)\s*[?.!]*$/;

/** "Get me organized", "what do I do next", "where do I start": the whole path is the answer. */
export function asksOverview(text: string): boolean {
  const own = sentences(text);
  if (own.some((s) => !ABOUT_THAT.test(s) && OVERVIEW.some((r) => r.test(s)))) return true;
  // "Okay, back to it." alone; with a question of its own, that is what they ask.
  return own.some((s) => BACK_TO_IT.test(s)) && !own.some((s) => !BACK_TO_IT.test(s) && asksFor(s));
}

const BACK_TO_IT = /\b(?:let us get |get |getting )?back to (?:it|work|business|the plan|my plan|our plan)\b/;

const THAT = '(?:that|this|it|them|those|these|(?:the|that|this) (?:first )?(?:step|part|thing|bit))';
const HOW_TO: readonly RegExp[] = [
  new RegExp(
    `\\bhow (?:exactly )?(?:do|would|should|can|could|am|will) (?:i|we) (?:even |actually |exactly |best |go about |supposed to )*(?:do|doing|start|starting|begin|run|running|make|write|go about|tackle|approach) (?:with |on )?${THAT}\\b(?! (?:faster|cheaper|better|without|if|when|for))`,
  ),
  new RegExp(
    `\\bwhat (?:would|do|should|will|must|can) (?:i|we) (?:have to )?(?:do|start with) first (?:for|with|on|of) ${THAT}\\b`,
  ),
  new RegExp(
    `\\bwhat (?:is|would be) the (?:very )?first (?:thing|part|bit|step|move) (?:of|for|with|in|on) ${THAT}\\b`,
  ),
  new RegExp(`\\bwhere (?:do|would|should) (?:i|we) (?:start|begin) with ${THAT}\\b`),
  new RegExp(`\\b(?:walk|talk|take|guide) me through ${THAT}\\b`),
  new RegExp(
    `\\b(?:can|could|will) you (?:help me (?:do|start|with)|show me how to do|do) ${THAT}(?: with me)?\\s*[?.!]*$`,
  ),
  /\b(?:show me how|how exactly|how so|like how|how would that work|how does that work)\s*[?.!]*$/,
];

/** They ask how to do the step just given ("how do I do that?", "what would I do first for that?"). */
export function asksHowTo(text: string): boolean {
  return sentences(text).some((s) => HOW_TO.some((r) => r.test(s)));
}

const WHEN_DONE =
  /\bhow (?:will|do|would|can|should) (?:i|we) (?:know|tell)(?: that| if| when)? (?:i|we|it|this|that)(?: am| are| is| have|'ve)? (?:done|finished|enough|did|worked|works|good enough|ready|complete|through)\b|\bhow (?:will|do|would|can) (?:i|we) know (?:(?:i|we) have |(?:i|we) |it is |that is |this is )?(?:(?:done )?enough|when to stop|when it is (?:done|enough))\b|\bwhen (?:is|am|are|will) (?:it|this|that|i|we|the step)(?: be)? (?:done|finished|enough|complete|through)\b|\bwhat (?:does|would) (?:done|enough|good enough) (?:look like|mean)\b|\bwhat counts as (?:done|enough|finished)\b|\bhow (?:much|many) is enough\b/;

/** They ask when the step just given is done. */
export function asksWhenDone(text: string): boolean {
  return sentences(text).some((s) => WHEN_DONE.test(s));
}

/** What they want done with the reply just given: said plainly, shorter, longer, for a doubter, in other words. */
export type Restating = 'plain' | 'short' | 'more' | 'convince' | 'translate' | 'explain';

const IT =
  '(?:that|this|it|them|those|these|(?:the |your )?(?:last |previous )?(?:reply|answer|message|part|bit|sentence|point|paragraph)|what you (?:just )?(?:said|wrote|told me))';
const SAY =
  '(?:say|put|write|word|explain|phrase|rephrase|reword|rewrite|redo|repeat|give me|tell me|try|make)';
const LEAD_IN_WORDS =
  '^(?:(?:ok(?:ay)?|so|and|but|now|hmm+|um+|uh+|sorry|wait|please|thanks?|cool|great|fine|right|no|yes|hey|lol)[,.! ]+)*(?:(?:can|could|would|will) you (?:please )?|please |just |now |i need you to |i want you to )*';
const RESTATES: readonly (readonly [Restating, RegExp])[] = [
  [
    'translate',
    new RegExp(
      `${LEAD_IN_WORDS}translate\\b.{0,40}$|\\b${SAY} ${IT} (?:again )?in (?:spanish|french|german|chinese|mandarin|hindi|arabic|portuguese|japanese|korean|italian|russian|urdu|vietnamese|turkish|polish)\\b`,
    ),
  ],
  [
    'convince',
    new RegExp(
      `${LEAD_IN_WORDS}(?:convince|persuade|win over|sell (?:it|that|this) to) (?:me|(?:a|an|the|my|some) (?:skeptic\\w*|sceptic\\w*|doubter|cynic|critic|(?:hard|tough|grumpy) \\w+|doubting \\w+|judge|professor|co-?founder|partner|dad|mom|mum|parents?|boss|investor))\\b.{0,30}$|\\b(?:a|the|my) (?:skeptic|sceptic|doubter|cynic)\\b.{0,30}(?:say|believe|think|buy)\\b.{0,20}$`,
    ),
  ],
  [
    'short',
    new RegExp(
      `${LEAD_IN_WORDS}(?:(?:${SAY} ${IT} (?:much |a lot |a bit |even )?|(?:make )?(?:${IT} )?(?:much |a lot |a bit |even )?)(?:shorter|briefer|tighter|more concise|punchier)(?: please)?|(?:shorten|condense|summari[sz]e|tl;?dr|compress|trim) ?${IT}?(?: please)?|tl;?dr|${SAY} ${IT} in (?:one|a single|two|a|1|2) (?:lines?|sentences?|words?|breath)|(?:give me )?(?:in |the )?(?:one|a single|two|1|2)[- ](?:line|sentence|word)s?(?: version)?(?: please)?|too long(?:,? (?:again|shorter))?.{0,12})\\s*[?.!]*$`,
    ),
  ],
  [
    'plain',
    new RegExp(
      `\\b${SAY} ${IT} (?:again |to me )?(?:like (?:a |an )?(?:normal|regular|real|actual|human|ordinary|sane) ?(?:person|human|being|people)?|like i(?: am|['’]m)? ?(?:a )?(?:five|5|ten|12|new|kid|child|beginner|stupid|dumb).{0,16}|(?:in |more )?(?:plain(?:er|ly)?|simple(?:r)?|simply|normal|everyday|human|easy|easier|regular|common)(?: (?:english|words|language|terms|way))?|without (?:the |all the |any )?(?:jargon|buzzwords|business words|fancy words|big words))|${LEAD_IN_WORDS}(?:in |use )?(?:plain|simple|simpler|normal|human|everyday) (?:english|words|language|terms)(?: please)?\\s*[?.!]*$|\\b(?:simplify|dumb down|demystify) ${IT}|\\beli5\\b|\\bdumb (?:it|that|this) down\\b|\\b(?:less|no) jargon\\b|\\bspeak (?:plain )?english\\b|\\blike a (?:normal|real) (?:person|human)(?: please)?\\s*[?.!]*$|\\b(?:talk|speak) (?:to me )?like a (?:normal|real|regular) (?:person|human)\\b`,
    ),
  ],
  [
    'explain',
    new RegExp(
      `${LEAD_IN_WORDS}(?:what (?:do|did) you mean(?: by (?:that|this|it|the (?:last|first|second) (?:part|bit|point)))?|what does (?:that|this|it) (?:even )?mean|explain (?:that|this|it|the last (?:part|bit|point))(?: (?:again|better|differently))?|(?:i do not|did not|do not) (?:get|understand|follow) (?:that|it|this|what you (?:mean|said))|you lost me|come again|in other words|say (?:that|it|this) (?:again )?(?:differently|another way|in other words|but (?:differently|simpler|slower))|rephrase(?: ${IT})?|reword(?: ${IT})?)(?: please)?\\s*[?.!]*$`,
    ),
  ],
  [
    'more',
    new RegExp(
      `${LEAD_IN_WORDS}(?:(?:go|say|tell me) (?:a bit |a little )?(?:deeper|more)(?: (?:about|on|into) ${IT})?|(?:elaborate|expand)(?: on ${IT})?|more detail(?:s)?(?: on ${IT})?)(?: please)?\\s*[?.!]*$`,
    ),
  ],
];

/**
 * What they ask done with the reply just given ("say that like a normal person", "shorter", "convince a sceptic", "what do
 * you mean?"); null: it asks nothing of it. A message with an ask of its own beside it is that ask.
 */
export function asksAboutReply(text: string): Restating | null {
  const own = sentences(text);
  const found = own.map((s) => RESTATES.find(([, r]) => r.test(s))?.[0] ?? null);
  const at = found.findIndex((f) => f !== null);
  if (at < 0) return null;
  // "Shorter. And how do I price it?" asks two things: the question is the ask.
  if (own.some((s, i) => found[i] === null && s.endsWith('?'))) return null;
  return plain(text).split(/\s+/).length > 22 ? null : (found[at] ?? null);
}

const MEANING =
  /\b(?:so )?what (?:does|did|would) (?:that|this|it|all (?:of )?(?:that|this)|the (?:result|finding|answer)s?) (?:mean|tell|show|say|change|prove)\b|\bwhat (?:did|do|have) (?:i|we) (?:learn|learned|find out|take from|make of)\b|\bwhat (?:do|should|would|can) (?:i|we) do with (?:that|this|it|them|what (?:they|the \w+) (?:said|told)|the (?:result|answer|finding)s?)\b|\bwhat(?: now| then)?,? with (?:that|this)\b|^(?:ok(?:ay)?[, ]+)?so what\s*[?.!]*$|\bwhat (?:do|should) (?:i|we) make of (?:that|this|it)\b/;

/** They ask what they just found means ("so what does that mean for what I'm building?", "what do I do with that?"). */
export function asksMeaning(text: string): boolean {
  return sentences(text).some((s) => MEANING.test(s));
}

const REJECTS =
  /\b(?:that|this|it) is (?:just |all |pure |such |total |complete |so )*(?:textbook|nonsense|useless|generic|rubbish|garbage|bullshit|bs|wrong|obvious|no help|not helpful|not useful|a waste(?: of (?:my )?time)?|vague|boilerplate|what everyone says)\b|\byou (?:have no idea|do not (?:know|understand|get)|are not (?:listening|helping)|did not (?:listen|answer|read)|keep (?:saying|repeating)|said that already|already said (?:that|this))\b|\b(?:textbook|generic|useless|boilerplate) (?:nonsense|advice|answer|stuff|crap)\b|\bgive me something (?:that works|real|useful|specific|concrete|i can use)\b|\bi (?:already )?(?:know|knew) (?:all )?(?:that|this) already\b|\btell me something (?:new|i do not know|useful)\b/;

/** They reject what they were just told ("that's textbook nonsense", "you have no idea what you're talking about"). */
export function rejectsAdvice(text: string): boolean {
  const said = plain(text);
  return said.length <= 160 && REJECTS.test(said) && !sentences(text).some((s) => s.endsWith('?'));
}

const ONE_THING: readonly RegExp[] = [
  /\b(?:just |only |give me |name |tell me |pick )?(?:one|a single|the one|1) (?:small |tiny |little |concrete |simple )?(?:thing|task|job|move|action)\b/,
  /\b(?:small|smallest|tiny|tiniest|little|quick|quickest|easiest) (?:thing|task|move|action|first step)\b/,
  /\b(?:my|your|the|any|give me|marching) orders\b|^(?:(?:ok(?:ay)?|yes|so|fine|right|alright|boss|chief|captain|coach)[,. ]+)*orders(?: please| boss)?\s*[?.!]*$/,
  /\bwhat would (?:you|u) do\b.{0,60}\b(?:me|place|shoes|position|situation|yours?)\b/,
  /\bleast (?:dumb|stupid|bad|risky)\b/,
  /\bwhat (?:do|should|must|can|would) (?:i|we) do (?:tomorrow|tonight|today|right now|now|on monday)\b|\bwhat (?:i|we) (?:should |must |can )?do (?:tomorrow|tonight|today|right now)\b/,
  /\b(?:most useful|smartest) (?:thing|move|step)\b/,
];

/** They want one thing to do, never a page to fill in. */
export function asksOneThing(text: string): boolean {
  return sentences(text).some((s) => ONE_THING.some((r) => r.test(s)));
}

const FILLS_IN =
  /\b(?:write|fill(?: (?:in|out))?|draft|give|show|send|paste|make|do|type|complete|prepare)(?: (?:me|us|up|out))?(?: (?:just|all|of))*(?: (?:the|a|an|my|that|this|these|those|your))*(?: (?!landing\b|web\b|home\b)[a-z-]+){0,3}? (?:(?:five|5|six|four|two|three) lines|lines|template|table|canvas|sheet|script|page|card|worksheet|one[- ]pager)\b|\bwhat (?:does|would|should) (?:the|a|my|that|this) (?:[a-z-]+ )?(?:template|table|canvas|sheet|page|card|one[- ]pager) (?:look like|say|have)\b/;

/** They ask to have the step's own template, written out for them. */
export function asksForTemplate(text: string): boolean {
  return sentences(text).some((s) => FILLS_IN.test(s));
}

const MESSAGE_ASKED =
  /\b(?:write|draft|give|send|show|make|compose|type)(?: me| us)?(?: out)? (?:the|a|an|that|my|this|some)(?: (?:short|first|cold|quick|exact|actual|whole|good|simple))* (?:message|e-?mail|text|note|dm|script|invitation|invite|post|lines?)\b|\bwhat (?:do|should|would) (?:i|we) (?:write|say|text|send)(?: to)? (?:them|him|her|to them|people|someone|that person)\b|\bwhat (?:should|would) the (?:message|e-?mail|text|note) (?:say|be)\b/;

/** They ask for the message to send, written out. */
export function asksMessage(text: string): boolean {
  return sentences(text).some((s) => MESSAGE_ASKED.test(s));
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
  /\b(?:that|this|it) is (?:(?:a bit|a lot|way|still|kind of|just|probably|honestly|really) )*too (?:much|big|long)\b(?! (?:money|cash|to pay|to charge))|\btoo (?:much|big|long) (?:for me |to do |work )?(?:before|right now|this week|today|tonight|at once)\b|\bsomething (?:much |a bit |a little |a lot )?(?:smaller|shorter|quicker|lighter|easier)\b|\b(?:smaller|shorter|quicker|lighter|mini) (?:step|version|one|task|piece|thing)\b|\b(?:a |one |some )?small (?:thing|step|task)\b|\bsomething small\b|\bsmallest (?:step|piece|task|first step|thing (?:that )?(?:i|we) can (?:do|finish|get done))\b|\b(?:break|split|cut) (?:it|that|this) (?:down|up|into)\b|\bi (?:can not|do not) (?:fit|have (?:the )?time for) (?:that|this|it|all)\b/;
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

const HAVE_TIME = new RegExp(
  `\\b(?:i|we) (?:only |just |really )*(?:have|got|get)(?: (?:only|just|about|around|maybe|like|roughly))* ((?:${ONE_OR_N}) ${UNIT}(?: (?:a|per|each|every) (?:week|month|day))?)\\b|\\bmy ((?:${ONE_OR_N}) ${UNIT})\\b`,
);

/** The time they say they have for it, in minutes and in their words ("four hours a week"); null: none said. */
export function timeSaid(text: string): { readonly minutes: number; readonly said: string } | null {
  const m = HAVE_TIME.exec(plain(text));
  const said = m?.[1] ?? m?.[4];
  if (m === null || said === undefined) return null;
  const n = m[2] ?? m[5] ?? '';
  const unit = m[3] ?? m[6] ?? '';
  const minutes = Math.round(
    (NUMBERS[n] ?? Number(n)) * (UNIT_MINUTES.find(([re]) => re.test(unit))?.[1] ?? 60),
  );
  return Number.isFinite(minutes) && minutes > 0 ? { minutes, said } : null;
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
  '(?:did|done|finished|completed|sent|emailed|messaged|called|talked|spoke|spoken|met|interviewed|asked|ran(?! out\\b)|run|launched|posted|published|shipped|signed|built|made|wrote|written|drafted|tested|surveyed|visited|collected|got(?! it\\b| (?:an?|this|another|my|some) (?:\\w+ ){0,2}(?:idea|question|problem|feeling|plan)\\b)|closed|sold|presented|pitched|submitted|recorded|listed|booked|filed|set up|put up|showed|observed|counted|charged|invoiced|heard)';
/** "Got five people to try it", "Talked to my uncle": what they did, told without its "I". */
const TELLS_DONE = new RegExp(`^(?:(?:so|and|ok|okay|well|also|yes|yeah|just|finally)[, ]+)*${ACTED}\\b`);

/** Whether a statement asks for help ({@link NEEDS}): a plain fact, a report or a story does not. */
export function statesNeed(text: string): boolean {
  const said = plain(text);
  return NEEDS.test(said) && !TELLS_DONE.test(said);
}

const BARE_DONE =
  /^(?:(?:yes|yep|yeah|ok|hi|hey|update|quick update|good news)[,:.! ]+)*(?:done|finished|completed|all done|did it|(?:i|we) did(?: it| that| them)?|it went out|sent(?: it| them)?|it is done|that is done|it worked)\b/;
const ACTED_BY_THEM = new RegExp(
  `\\b(?:i|we|my cofounder|my co-founder|my team|our team) (?:(?:have|had|just|already|finally|also|actually|only|even|then|now) )*${ACTED}\\b`,
);
const NOT_YET =
  /^(?:(?:hi|hey|sorry|honestly|no|nope)[,:.! ]+)*not yet\b|^(?:no|nope)(?=[,.!]|$| (?:i|we|sorry|unfortunately|not|time|did|have) ?\b)(?![,.! ]+(?:i mean|wait|what i|that is|it is|the|not that|actually|more)\b)|\b(?:have|had|did|could|was|were) not (?:yet |really |quite |even )*(?:do|done|get|got|gotten|manage|managed|finish|finished|start|started|send|sent|reach|reached|call|called|talk|talked|able|had (?:time|a chance)|have (?:time|a chance)|it|that|them)\b|\b(?:ran out of|no|not enough) time\b|\b(?:i|we) (?:forgot|missed (?:it|that|the))\b/;
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
  return (
    text
      // "Outside the 9 a.m. lectures" is one sentence.
      .split(/(?<=[.?!;])(?<!\b[ap]\.m\.)(?<!\b(?:e\.g|i\.e|vs|approx|Dr|Mr|Ms|Mrs|Prof)\.)\s+|\n+/u)
      .map((s) => s.trim())
      .filter((s) => /[\p{L}\p{N}]/u.test(s))
  );
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

/** A text of theirs they paste to have read ("here is the paragraph from my summary: …"): what it says is no report. */
const PASTED =
  /\b(?:here (?:is|are|comes)|this is|below is|read|check|fix|look at|rate|review|edit) (?:the|my|our|a|this)(?: [\w'-]+){0,4}? (?:paragraph|text|draft|summary|pitch|e-?mail|post|abstract|copy|slides?|message|letter|page|plan|essay|proposal|bio|description|statement|intro|blurb|script|application)\b[^:\n]{0,90}:\s*/i;

/** The message without a text pasted into it: what they say themselves. */
export function ownWords(text: string): string {
  const m = PASTED.exec(text);
  if (m === null) return text;
  const pasted = text.slice(m.index + m[0].length);
  if (pasted.split(/\s+/).length < 25) return text;
  return text.slice(0, m.index + m[0].length).replace(/:\s*$/, '.');
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
  /\b(?:never (?:ever )?(?:done|started|built|run|had|tried) (?:this|that|anything|one|it|a (?:startup|business|venture|company))|first[- ]time (?:founder|entrepreneur)|(?:this is )?(?:my|our) first (?:startup|venture|business|company|time)|(?:do not|did not) know (?:anything|much|a thing|the first thing) about (?:business|startups?|entrepreneurship|running)|know nothing about (?:business|startups?)|new to (?:business|startups?|entrepreneurship|commerciali[sz]ation|this)|no (?:business|startup) (?:experience|background|knowledge)|(?:complete |total )?beginner|(?:do not|did not) (?:really )?(?:know|understand|get) (?:the |any of the |anything about the )?(?:business|money) (?:side|part|stuff)|zero business (?:background|experience|knowledge)|first (?:company|startup|venture|business) for me|never (?:taken|took|had) a business class|no clue about business|clueless about business)\b/;

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
  /\b(?:who (?:exactly |else )?(?:do|should|can|would) (?:i|we) (?:ask|see|talk|speak|go|contact|call|email|meet|write)|what (?:exactly )?(?:do|should) (?:i|we) (?:bring|take|tell|show|say|ask)|lawyers?|attorneys?|you decide|your call|just (?:decide|tell|say|answer|give)|a hint|come on|yes or no|guarantee|promise me|sign(?:ing|ed)?|take it away|off the record|between (?:us|you and me)|hypothetically|said (?:that )?(?:you|it is)|you can tell|you (?:also )?(?:coach|know) (?:them|him|her|that team)|your (?:opinion|guess|view)|what would you do|is (?:that|it) (?:right|legal|allowed|ok|okay|safe)|are you sure|but (?:you|i) (?:must|have to|need)|on (?:the )?(?:\w+ ){0,3}(?:staff|team)|work (?:for|at) the (?:center|program|office)|i am (?:an? )?(?:admin|staff|the program lead|an eir))\b/;
/** Another try at what another founder does. */
const ASKS_OF_OTHERS =
  /\bhints?\b|\bwho else\b|\bother (?:founders?|teams?|students?|ventures?|startups?|people|groups?)\b|\bwhat (?:they|he|she|others) (?:are|is|do|does|charge|charges)\b|\b(?:their|his|her) (?:plan|pitch|price|idea|deck|numbers|customers?)\b|\bsomeone else here\b/;
export function pushesOn(text: string, ofOthers = false): boolean {
  const said = plain(text);
  return PUSHES.test(said) || (ofOthers && ASKS_OF_OTHERS.test(said));
}

/** Objects that are a task of the work, never the venture ("I'm building a prototype", "I want to make a survey"). */
const TASK_OBJECT =
  /^(?:(?:an?|the|my|our|some|this|that|it|them|one|another|first) )*(?:it|this|that|them|prototype|mock-?ups?|pitch|deck|slides?|landing page|survey|plan|list|website|site|mvp|canvas|model|interviews?|company|business plan|money|sense|progress|sure|decision|call|calls|list|test|demo|video|logo|name|friends?|start|something|pilot|trial|meeting|term|semester|class|thesis|phd|job|internship|conversation|project with)\b/i;
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
  /** What they said of it ("back to the reading corners. A library lends its room"). */
  readonly to: string;
  /** The new idea alone ("an app with a story a night for parents"). */
  readonly idea: string;
  /** They go back to an idea they had: the first one, the one before, or one by its words. */
  readonly back: 'first' | 'last' | 'named' | null;
}

const PIVOTS =
  /\b(?:i|we|my team|our team)(?: are| am| have)?(?: now| just| all| both| finally)* (?:decided (?:to pivot|on a pivot)|decided: (?:we|i) pivot|agreed to pivot|pivoting|pivoted|pivot)\b|\bwe pivot\b|^(?:(?:so|ok(?:ay)?|big news|update|news)[,:. ]+)*pivot(?:ing)?(?: time)?\s*(?:[:,.-]|to\b|$)/;
const SWITCHES =
  /\b(?:i|we)(?: are| am| have)?(?: now| just)* (?:(?:switch(?:ed|ing)|chang(?:ed|ing)) (?:(?:the|our|my) (?:whole )?(?:idea|business|product|venture|startup|customers?)|direction)\b|switch(?:ed|ing) (?:from [^.,;]{3,60} )?to (?:selling|building|making|renting|offering|serving|targeting|doing)\b|shift(?:ed|ing)? (?:the |our |my )?(?:whole )?focus (?:to|toward|towards|onto)\b)/;
const NOW_DOING =
  /\b(?:i|we) are now (?:doing|building|selling|making|offering|renting|focusing on|going after|serving|targeting)\b/;
/** "I'm changing direction", "new direction:", "we go another way with it". */
const DIRECTION =
  /\b(?:chang(?:e|ed|ing)|switch(?:ed|ing)?|shift(?:ed|ing)?|taking (?:it|us|this)|going|went|head(?:ed|ing)|mov(?:ed|ing)) (?:in |into )?(?:a |the |our |my )?(?:(?:totally|completely|whole|very) )?(?:new |different |another )?direction\b|\b(?:chang(?:e|ed|ing)|switch(?:ed|ing)?) direction\b|^(?:(?:so|ok(?:ay)?|update|news)[,:. ]+)*(?:a )?(?:new|change of) direction\s*[:,.-]|\bnew direction (?:is|for us|from now)\b/;
/** "Ditching the corners for an app", "dropping lunches, doing soup instead", "scrapping X; now it's Y". */
const DROPS =
  /\b(?:i|we|my team)(?: are| am| have)?(?: now| just| finally| going to| decided to)* (?:drop(?:ped|ping)?|ditch(?:ed|ing)?|scrap(?:ped|ping)?|abandon(?:ed|ing)?|kill(?:ed|ing)?|leav(?:e|ing)|giv(?:e|ing) up on|gave up on|mov(?:e|ed|ing) (?:on |away )?from|stop(?:ped|ping)? (?:doing|selling|making|building|offering)) (?!it\b|that\b|this\b|out\b|class)(\S[^.;:]{2,80}?)(?:,| and|;| -)? (?:for|to|and (?:do|doing|sell|selling|build|building|make|making|start|starting|rent|renting|offer|offering|now)|now|instead|we|i)\b/;
const FROM_NOW =
  /^(?:(?:so|ok(?:ay)?|update|news)[,:. ]+)*from (?:now on|today)(?: on)?,? (?:i|we) (?:will |are |am |just )*(?:do|doing|sell|selling|build|building|make|making|rent|renting|offer|offering|serve|serving|target|targeting|run|running|focus(?:ing)? on)\b/;
/** "No corners: an app for parents instead." on its own. */
const NO_INSTEAD = /^no (?:more |longer )?[^.,;:]{2,60}[,;:.-]+ ?(?=\S).{8,}\binstead\b/;
const PIVOT_TO =
  /\b(?:pivot(?:ing|ed)?|switch(?:ed|ing)?|chang(?:ed|ing)|shift(?:ed|ing)?|mov(?:ed|ing)|go(?:ing)?|head(?:ing)?)(?: (?:the|our|my) (?:whole )?(?:idea|business|product|venture|startup|customers?|focus)| (?:in a |in |a )?(?:new |different )?direction| away| on)?(?: from [^.,;]{3,80}?)? (?:to|toward|towards|into) (?:(?:we|i) (?:['’]?(?:re|ll|m)|are|will|am) )?(?:now )?(\S.*)$/iu;
const NOW_CLAUSE =
  /\bnow ((?:doing|building|selling|making|offering|renting|focusing on|going after|serving|targeting)\b.*)$/iu;
const DROP_AND = /\band (?:now )?(?:(?:doing|do|starting|start)\s+)?(\S.*)$/iu;
const DROP_FOR = /\b(?:for|to|now (?:it is |it['’]s )?)\s+(\S.*)$/iu;
const AFTER_MARK = /^[^:]{2,60}?[:—–]\s*(\S.*)$/u;
const INSTEAD =
  /\b(?:instead|no more|no longer|stop(?:ped|ping)? (?:selling|making|doing|building|serving)|from now on|rather than)\b/;
/** A way of working, never a venture: "switching from email to calls" changes no idea. */
const METHOD =
  /\b(?:e-?mails?|calls?|calling|phone|texts?|texting|surveys?|interviews?|zoom|notion|excel|sheets?|slack|figma|python|react|flutter|stripe|venmo|fridays?|mondays?|tuesdays?|wednesdays?|thursdays?|saturdays?|sundays?|mornings?|evenings?|weekends?|majors?|minors?|classes|courses?|dorms?|teams?|templates?|fonts?|logos?|names?|titles?|colou?rs?|bank|lawyers?|advisors?|mentors?|script|deck|slides?)\b/i;
const NO_LEAD = /^no (?:more|longer)?\s*[^.,;:—–]{2,60}[,.;:—–-]+\s*(?:but |and |now |just |instead[, ]+)?/i;
const UNSURE = /\b(?:if|should|might|maybe|perhaps|thinking (?:of|about)|considering|wonder(?:ing)?|not)\b/;
const PAST_TOLD =
  /\b(?:ago|last (?:week|month|year|term|semester|time)|yesterday we talked|back then|used to|remember)\b/;

/** They go back to an idea they had. */
const BACK =
  /\b(?:(?:am|are|i|we|let us|will|have|had|is|are all)(?: now| just| both| all| decided to| have decided to| going to)* (?:going|go|went|gone|moving|move|moved|switching|switch|switched|turning|coming|come|came|returning|return|returned|reverting|revert|reverted|head(?:ed|ing)?|back)|^(?:(?:so|ok(?:ay)?|update|news|decided)[,:. ]+)*(?:going|switching|moving|returning|reverting|back)) (?:back )?(?:to|on|with) (?:the |my |our |doing |selling |making |building |that |those )*(\S[^.;!?]*)/;
const BACK_WORD =
  /\b(?:back|return(?:ing|ed)?|revert(?:ing|ed)?|original|first idea|old idea|earlier idea|previous idea)\b/;
const UNDO =
  /\b(?:undo|undoing|reverse|reversing|cancel(?:l?ing)?|scrap(?:ping)?|revert(?:ing)?|take back|taking back|forget|never mind|un-?pivot(?:ing)?) (?:the |that |this |my |our |about the )*(?:pivot|change of direction|switch|change of idea|new direction)\b|\b(?:the|that|our|my) pivot (?:was|is) (?:a mistake|wrong|off|cancel(?:l)?ed|undone)\b|\bun-?pivot\b/;
const FIRST_ONE =
  /^(?:(?:first|original|initial|very first|earliest) (?:idea|plan|version|venture|product|one|direction|concept)|where (?:we|i) started|what (?:we|i) (?:had|started with)(?: first)?)\b/;
const LAST_ONE =
  /^(?:(?:old|previous|earlier|former|last|other|prior) (?:idea|plan|version|venture|product|one|direction|concept)|what (?:we|i) (?:were|was) doing(?: before)?|the idea before)\b/;
/** Going back to these is no idea ("back to work", "back to it", "back to school"). */
const NOT_AN_IDEA =
  /^(?:it|this|that|work|business|basics|school|class|classes|sleep|bed|home|campus|town|you|me|them|him|her|us|the plan|plan|topic|question|point|start|beginning|square one|normal|step|first step|task|list|drawing board|boston|rochester|lab|work on|coaching|what you said|your (?:question|point|advice)|my (?:question|point)|pricing|price|email|emails|interviews|customers?)\b/;

/** The words of a new idea, without what it ends and the "instead" that says so. */
function newIdeaIn(text: string): string {
  const said = endless(text);
  const rest = said.replace(NO_LEAD, '');
  const kept = rest !== said && contentStems(rest).length >= 2 ? rest : said;
  return endless(
    (kept === said ? said : kept.replace(/[, ]+instead(?= of\b|$)/i, '')).replace(
      /,? (?:because|since) .*$/i,
      (tail) => (contentStems(kept.replace(tail, '')).length >= 2 ? '' : tail),
    ),
  );
}

/** What something is dropped for ("ditching the candles for soap", "dropping the app and building a tool"). */
function droppedFor(sentence: string): string | undefined {
  const from = sentence.slice(
    Math.max(0, sentence.search(/\b(?:drop|ditch|scrap|abandon|kill|leav|giv|gave|mov|stop)/iu)),
  );
  const and = /\band (?:now )?(?:do|sell|build|mak|start|rent|offer|run|serv)\w*\b/iu.test(from);
  return (and ? DROP_AND : DROP_FOR).exec(from)?.[1];
}

/** Going back to an idea they had; null: nothing of the kind. */
function backOf(own: readonly string[]): Pivot | null {
  for (let i = 0; i < own.length; i += 1) {
    const sentence = own[i] ?? '';
    const s = plain(sentence);
    if (
      s.endsWith('?') ||
      QUESTION_START.test(s) ||
      UNSURE.test(s) ||
      /\b(?:ago|last (?:week|month|time))\b/.test(s)
    )
      continue;
    const undone = UNDO.test(s);
    const found = undone ? null : BACK.exec(s);
    const target = (found?.[1] ?? '').trim();
    if (!undone && (found === null || !BACK_WORD.test(s) || NOT_AN_IDEA.test(target))) continue;
    const why = own
      .slice(i + 1, i + 3)
      .filter((x) => !plain(x).endsWith('?') && !QUESTION_START.test(plain(x)))
      .map(endless);
    const at = sentence.search(/\b(?:back|return\w*|revert\w*)\b/i);
    const said =
      undone || at < 0
        ? endless(sentence)
        : endless(sentence.slice(at)).replace(/^(?:return|revert)(?:ing|ed)? (?:back )?to\b/i, 'back to');
    return {
      quote: sentence,
      to: clip([/^back\b/i.test(said) ? said : `back: ${said}`, ...why].join('. ')),
      idea: '',
      back: undone || LAST_ONE.test(target) ? 'last' : FIRST_ONE.test(target) ? 'first' : 'named',
    };
  }
  return null;
}

/**
 * The change of direction a message states ("we decided to pivot to…", "I'm changing direction. No lunches: I'll rent jars
 * instead", "I'm going back to the first idea"), with the new idea in their own words; null when it asks about one, recalls
 * one, or names no new idea.
 */
export function pivotOf(text: string): Pivot | null {
  const own = ownSentences(text);
  const back = backOf(own);
  if (back !== null) return back;
  for (let i = 0; i < own.length; i += 1) {
    const sentence = own[i] ?? '';
    const s = plain(sentence);
    if (
      s.endsWith('?') ||
      QUESTION_START.test(s) ||
      WORK_START.test(s) ||
      ASKS_AFTER.test(s) ||
      UNSURE.test(s) ||
      PAST_TOLD.test(s)
    )
      continue;
    const drops = DROPS.exec(s);
    const alone = NO_INSTEAD.test(s);
    const cue =
      PIVOTS.test(s) ||
      (SWITCHES.test(s) && contentStems(sentence).length >= 3) ||
      NOW_DOING.test(s) ||
      DIRECTION.test(s) ||
      FROM_NOW.test(s) ||
      alone ||
      drops !== null;
    if (!cue) continue;
    const named =
      (alone ? sentence : undefined) ??
      PIVOT_TO.exec(sentence)?.[1] ??
      NOW_CLAUSE.exec(sentence)?.[1] ??
      (FROM_NOW.test(s) ? sentence.replace(/^.*?\bfrom (?:now on|today)(?: on)?,?\s*/iu, '') : undefined) ??
      (drops === null ? undefined : droppedFor(sentence)) ??
      (DIRECTION.test(s) || PIVOTS.test(s) ? AFTER_MARK.exec(sentence)?.[1] : undefined);
    if (named !== undefined && contentStems(named).length >= 2) {
      // "Switching from email to calls" is a way of working.
      if (METHOD.test(named) && contentStems(named.replace(new RegExp(METHOD.source, 'gi'), ' ')).length < 2)
        continue;
      if (METHOD.test(named) && !PIVOTS.test(s) && !DIRECTION.test(s) && !SWITCHES.test(s) && !alone)
        continue;
      const to = clip(endless(named));
      return { quote: sentence, to, idea: newIdeaIn(to), back: null };
    }
    if (drops !== null || alone) continue;
    // The sentences after "we're pivoting" tell the new idea.
    const told: string[] = [];
    for (const later of own.slice(i + 1, i + 4)) {
      const l = plain(later);
      if (l.endsWith('?') || QUESTION_START.test(l)) break;
      if (
        told.length === 0 &&
        !INSTEAD.test(l) &&
        !/\b(?:i|we) (?:will|are|am) \w+/.test(l) &&
        !/^(?:it is|the (?:new )?(?:idea|plan|product) is|now it is|an? |no )/.test(l)
      )
        continue;
      told.push(endless(later));
      if (INSTEAD.test(l)) break;
    }
    if (told.length > 0 && contentStems(told.join('. ')).length >= 3) {
      const to = clip(told.join('. '));
      return { quote: sentence, to, idea: newIdeaIn(to), back: null };
    }
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
