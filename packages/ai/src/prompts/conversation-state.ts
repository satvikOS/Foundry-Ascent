import { CONVERSATION_STATE_TAG, OVERUSED_PHRASES } from './craft.js';
import { escapeData, truncate } from './escape.js';

/**
 * Where the conversation stands, derived deterministically from the turns already in the prompt (no model call,
 * no storage): what the founder's new message does (greets, changes topic, asks what the vEIR remembers, wraps
 * up…), how long their messages usually are, the thread the conversation was on, threads the founder left before
 * they were settled (so the vEIR can come back to them), and the vEIR's own recent habits (replies that all ended
 * in a question, how its recent replies opened). Rendered as a short `<conversation_state>` block of escaped
 * observations next to the founder's message; the system prompt's "Conversation craft" says how to use it.
 *
 * Topic tracking follows conversation analysis: talk moves stepwise unless a move is marked ("by the way",
 * "different question"); the turn after the vEIR's question is heard as its answer (an adjacency pair) unless it is
 * marked as a new topic; a later message that shares content words with a parked thread resumes it.
 */

/** What a founder message does in the conversation. A message can do several things ("Thanks! By the way…"). */
export type FounderMove =
  | 'greeting'
  | 'recall'
  | 'resume'
  | 'topic_shift'
  | 'repair'
  | 'closing'
  | 'thanks'
  | 'stress'
  | 'humour'
  | 'sarcasm'
  | 'news'
  | 'short_reply'
  | 'question'
  | 'help';

/** A completed earlier exchange (the shape of `HistoryTurn`). */
export interface StateTurn {
  readonly founderText: string;
  readonly answer: string | null;
}

export interface ConversationThread {
  /** The founder's words that opened the thread (one line, at most {@link GIST_CHARS} characters, unescaped). */
  readonly gist: string;
  /** Founder messages since the thread was last touched (1 = the message before the new one). */
  readonly messagesAgo: number;
}

/** A message that is only social: thanks, a wrap-up or a hello, with nothing asked or told ({@link socialTurnOf}). */
export type SocialTurn = 'thanks' | 'closing' | 'greeting';

export interface ConversationState {
  /** What the new message does, in order of importance. */
  readonly moves: readonly FounderMove[];
  /** The message is only social (thanks, a wrap-up, a hello): a short reply and nothing to report. */
  readonly social?: SocialTurn | null;
  /** The message asks the vEIR to choose or give its view ("per branch or a flat fee?"): answer it first. */
  readonly directChoice?: boolean;
  /** The message asks for a number ("give me a number", "how much should we charge?"): a reasoned range first. */
  readonly asksForNumber?: boolean;
  /**
   * Overused phrases ({@link OVERUSED_PHRASES}) the vEIR already said in this conversation (in the replies in view or
   * its opener), so it never says them again.
   */
  readonly usedPhrases?: readonly string[];
  /** The opening line it answers said hello (a call's intro): never greet again. */
  readonly openerGreeted?: boolean;
  /** Words in the new message. */
  readonly words: number;
  /** Median words of the founder's earlier messages in view, or null without any. */
  readonly typicalWords: number | null;
  /** The thread the conversation was on before the new message (null at the start). */
  readonly previous: ConversationThread | null;
  /** Threads the founder left before they were settled, newest first (the one the new message returns to excluded). */
  readonly parked: readonly ConversationThread[];
  /** How many of the vEIR's latest replies in a row ended with a question. */
  readonly questionStreak: number;
  /** How the vEIR's latest replies opened (first words, newest first). */
  readonly recentOpenings: readonly string[];
  /** Questions the vEIR asked in this conversation (one line each, unescaped, newest first, distinct). */
  readonly askedQuestions: readonly string[];
  /**
   * Whether the question the vEIR's last reply asked (the first of `askedQuestions`) is still open: the new message
   * neither answers it nor takes it up (it asks something else, or changes the topic).
   */
  readonly openQuestion: boolean;
  /** Completed exchanges in view. */
  readonly earlierTurns: number;
  /**
   * The new message is the founder's first reply to the vEIR's own opening line (the conversation's stored opener,
   * which already picked up the last conversation): the reply must not say it again.
   */
  readonly afterOpener: boolean;
}

/** Longest gist of a thread. */
export const GIST_CHARS = 90;
/** Most parked threads reported. */
export const MAX_PARKED = 3;
/** Most recent openings reported. */
export const MAX_OPENINGS = 3;
/** Most questions the vEIR already asked that are reported (so it never asks one again). */
export const MAX_ASKED = 2;
/** Longest question reported. */
export const QUESTION_CHARS = 110;
const OPENING_WORDS = 6;

const APOSTROPHES = /[‘’ʼ]/g;

function normalize(text: string): string {
  return text.normalize('NFKC').replace(APOSTROPHES, "'").replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Cues for each move (on the normalised, lower-cased message), in order of importance. */
const MOVE_CUES: readonly (readonly [FounderMove, RegExp])[] = [
  [
    'recall',
    /\b(?:(?:do|did|can|could) you (?:still |even |actually )?(?:remember|recall)|what (?:did|were|have) we (?:just )?(?:talk(?:ed|ing)?|discuss(?:ed|ing)?|cover(?:ed|ing)?|go(?:ne)? over|decide[d]?|agree[d]?|land(?:ed)? on)|remind me (?:what|where|of what|how)|where did we (?:leave|land|end up|get to)|what do you (?:remember|know) about (?:me|us|our|my|what we))\b/,
  ],
  [
    'resume',
    /\b(?:where were we|where was i|(?:go|going|get|getting|come|coming|circle|circling|loop|looping) back to|back to (?:the|what|my|our|where|that|your)|as i was saying|pick(?:ing)? (?:it )?(?:up|back up) (?:where|from|again)|returning to)\b/,
  ],
  [
    'repair',
    /(?:\b(?:that's not what i (?:meant|said|asked|was asking)|that isn't what i (?:meant|said|asked)|you misunderstood|you misread|you got (?:that|it|me) wrong|i didn't (?:mean|say|ask) that)\b|^(?:no|nope|not quite|not exactly|sorry|wait)[,.!]?\s+(?:i|what i)\s+(?:meant|mean|was asking|asked|said)\b|^i meant\b)/,
  ],
  [
    'closing',
    // Pre-closings only: a farewell, or leaving ("I have to run.") with nothing after the verb, so "we need to run
    // a pilot" or "I have to run the numbers" stay ordinary talk.
    new RegExp(
      [
        String.raw`\b(?:goodbye|bye(?:-bye)?|talk (?:soon|later|tomorrow|next week)|speak soon|catch you later|signing off|good night|i'll let you go|until next time)\b`,
        String.raw`\bsee you(?: (?:soon|later|tomorrow|next (?:week|time)|then))?(?=\s*(?:[.!,]|$))`,
        String.raw`(?:^|(?:^|[\s,.!;])(?:i|we|i've|we've|ok|okay|anyway|sorry|well|so|but|alright|right|and|thanks)(?: really| actually| just)?[\s,]+)(?:(?:have|need|got|have got) to|gotta|must)\s+(?:go|run|jump|dash|head (?:off|out)|hop off|leave)(?: now| soon| in a (?:sec|second|minute|bit))?(?=\s*(?:[.!,;:]|$|(?:but|thanks|thank|bye|talk|see)\b))`,
        String.raw`\b(?:(?:that's|that is) (?:all|it|everything|enough) for (?:now|today)|let's (?:stop|wrap(?: it)? up|leave it) (?:here|there|for (?:now|today))|i'm done for (?:now|today))\b`,
      ].join('|'),
    ),
  ],
  [
    'thanks',
    /(?:^(?:(?:thanks|thank you|thx|ty|cheers)(?! to\b)|much appreciated|appreciate (?:it|that|you)|(?:that's|that is|that was) (?:really |super |very )?(?:helpful|useful|great|perfect))\b|\b(?:thanks|thank you)(?: so much| a lot| again)?[.!]*$)/,
  ],
  [
    'topic_shift',
    /(?:\b(?:by the way|btw|(?:a )?(?:different|another|unrelated|separate|random|new) (?:question|topic|thing|subject)|on (?:another|a different|a separate) note|chang(?:e|ing) (?:the )?(?:topic|subject)|before i forget|switching gears|quick (?:question|one))\b|^(?:oh|also)[,.]? (?:and |also )?(?:what|how|can|could|should|one more)\b|^actually[,.]? (?:can|could|let's|i want|i'd like)\b)/,
  ],
  [
    'greeting',
    /(?:^(?:hi|hey|hello|hiya|howdy|good (?:morning|afternoon|evening|day)|morning|evening)\b|\bhow(?:'s| is| are| have) (?:it going|you(?: been| doing)?|things|your (?:day|week))\b)/,
  ],
  [
    'stress',
    // The founder's own state ("I'm stressed", "we're worried"), not their customers' ("lab managers are worried").
    new RegExp(
      [
        String.raw`\b(?:i'm|i am|im|i've been|i have been|i feel|i felt|feeling|i'm feeling|we're|we are|we've been|we feel|i'm getting|we're getting|i was|we were|i get|we get)\s+(?:(?:so|really|very|pretty|quite|super|totally|completely|kind of|kinda|a (?:bit|little)|getting|more and more|just|honestly|also|incredibly|seriously|starting to (?:feel|get)|a little bit)\s+)*(?:stressed(?: out)?|overwhelmed|exhausted|burn(?:ed|t)[- ]?out|burning out|anxious|worried|panick(?:ed|ing)|freaking out|frustrated|discouraged|demoralis(?:ed)|demoraliz(?:ed)|scared|terrified|drained|struggling|at a loss|losing (?:sleep|hope|motivation|it))\b`,
        String.raw`\b(?:i|we) (?:feel|felt) like (?:a failure|giving up|quitting|i'm failing|we're failing)\b`,
        String.raw`\b(?:rough|tough|awful|terrible|brutal) (?:day|week|month|few days|few weeks)\b`,
        String.raw`\b(?:this|it)(?:'s| is| has been|'s been) (?:so |really |getting |all )?(?:stressful|overwhelming|exhausting|too much)\b`,
        // Worn down without saying "stressed" (the matrix's crisis-adjacent turn).
        String.raw`\b(?:i |we )?(?:haven't|have not|hardly|barely) slept\b|\b(?:don't|do not) know how (?:much )?longer (?:i|we) can\b|\bcan't keep (?:doing|going on with) (?:this|it)\b`,
      ].join('|'),
    ),
  ],
  [
    'humour',
    /(?:\b(?:ha(?:ha)+|hah|he(?:he)+|lol|lmao|rofl)\b|[\u{1F602}\u{1F923}\u{1F605}\u{1F604}\u{1F606}\u{1F61C}\u{1F609}])/u,
  ],
  [
    'sarcasm',
    // Praise for something unwelcome ("Oh great, ANOTHER meeting. Love that for me."): the matrix's SM-08.
    /(?:\blove (?:that|this) for (?:me|us)\b|^oh,? (?:great|joy|wonderful|perfect|fantastic|lovely|brilliant|goody)\b[^?]*\b(?:another|more|again)\b|\bjust what (?:i|we) (?:needed|wanted)\b|\b(?:yay|woohoo|whoopee),? (?:another|more)\b|\bcan't wait (?:for|to do) (?:another|more)\b|\bthanks a lot,? (?:for nothing|really)\b)/,
  ],
];

/**
 * News the founder brings (LAB-R8: "we're hiring Noor" and "the union will promote us" were answered with the vEIR's
 * own pending question): a sentence that tells something happened or is happening, never one that asks about it.
 */
const NEWS = new RegExp(
  [
    String.raw`\b(?:big|good|great|bad|some|exciting|quick|huge|sad) (?:news|update)\b|\bguess what\b|^update\b|\bheads up\b`,
    String.raw`\b(?:we|i)(?:'ve| have)? (?:just |finally |officially |actually )?(?:signed|landed|closed|won|lost|raised|launched|hired|shipped|secured|onboarded|got (?:a|an|the|our|my|into|accepted)|got approved|were accepted|was accepted)\b`,
    String.raw`\b(?:we're|we are|i'm|i am) (?:officially |finally |now )?(?:hiring|bringing (?:on|in)|onboarding|launching|pivoting|moving|joining|leaving|signing)\b`,
    String.raw`\b(?:signed (?:a|an|the|our)? ?(?:letter of intent|loi|contract|deal|agreement|lease)|letter of intent|\bloi\b)`,
    String.raw`\b(?:said yes|agreed to|approved (?:our|the)|offered (?:us|me|a|to)|promised (?:us|to)|committed to|(?:will|'ll|would) promote|(?:is|are) joining|joined (?:us|the team)|pulled out|dropped out|backed out|quit|resigned|signed (?:on|up|the|it))\b`,
  ].join('|'),
);

/**
 * The founder hands the work to the vEIR, or says they are stuck. Production, 2026-10-20: "I don't know. You tell
 * me." twice, "Could you help me prepare for that?" and "You tell me what I should ask" were each answered with the
 * question they had just said they could not answer, five replies in a row. The reply must give the substance itself.
 */
const HELP_REQUEST = new RegExp(
  [
    String.raw`\byou tell me\b|\btell me (?:what|how|which|where|who|if|whether)\b|\bjust tell me\b`,
    String.raw`\b(?:can|could|would|will) you (?:please |just |maybe )?(?:help|show|walk|give|write|draft|suggest|list|come up|tell|teach|explain|navigate|guide|prep|prepare)\b`,
    String.raw`(?<!\b(?:would|could|will|might|may|can|it|that|this|which|they|to|also) )\bhelp (?:me|us)\b`,
    String.raw`\b(?:i|we) (?:need|want|would like|'d like) (?:some |your )?(?:help|ideas|examples|suggestions|guidance|a hand)\b`,
    String.raw`\bwhat (?:should|do|would|could) (?:i|we) (?:even )?(?:ask|say|do|write|focus on|start with|prepare|bring|lead with)\b`,
    String.raw`\bwhat would you (?:ask|do|say|write|suggest|recommend|start with|focus on)\b`,
    String.raw`\b(?:give|show) (?:me|us) (?:some |a few |a couple of |three |two |an? )?(?:ideas|examples|options|questions|list|draft|template|example|starting point|steps|pointers)\b`,
    String.raw`\b(?:walk|talk) (?:me|us) through\b|\bshow (?:me|us) how\b|\bwhere (?:do|should) (?:i|we) (?:even )?(?:start|begin)\b|\bget (?:me |us )?started\b`,
    String.raw`\b(?:i'm|i am|im|we're|we are) (?:so |totally |completely |a bit |kind of |kinda |just )?(?:blank|stuck|lost|clueless|drawing a blank)\b`,
  ].join('|'),
);

/** A sentence that only says they don't know ("I don't know.", "idk", "No idea what to ask"). */
const DONT_KNOW =
  /^(?:(?:honestly|um+|uh+|well|that's the thing|thats the thing)[,.]? )*(?:i (?:really |honestly |just )?(?:don't|do not|dont) know|idk|dunno|no idea|not sure|i'm not sure|i have no idea|no clue)(?: (?:what|how|where|which)\b.*)?$/;

/** Whether `text` hands the work to the vEIR or says the founder is stuck ({@link HELP_REQUEST}, {@link DONT_KNOW}). */
function asksForHelp(text: string): boolean {
  if (HELP_REQUEST.test(text)) return true;
  // "Not sure. Does it matter who pays?" asks something of its own: that question is what to answer.
  if (text.includes('?')) return false;
  return text
    .split(/(?<=[.!?])\s+/)
    .some((sentence) => DONT_KNOW.test(sentence.replace(/[.!?…]+$/, '').trim()));
}

/** Whether `text` brings news: a statement with a news cue (a question about the same thing is no news). */
function bringsNews(text: string): boolean {
  return text
    .split(/(?<=[.!?])\s+/)
    .some((sentence) => !/\?\s*$/.test(sentence) && NEWS.test(sentence.replace(/[.!]+$/, '')));
}

/** A request for a number: the matrix's SM-16 ("Give me a number") and a price asked outright. */
const NUMBER_REQUEST =
  /\b(?:give me (?:a|the|some) (?:number|figure|price|ballpark|range)|(?:just )?(?:tell|give) me (?:a|the) (?:number|figure|price)|how much should (?:we|i)|what (?:should|would) (?:we|i) charge|what(?:'s| is) (?:a|the) (?:right|fair|good) (?:price|number|figure)|(?:a )?ballpark|rough (?:number|figure|estimate)|put a number on)\b/;

const SHORT_REPLY =
  /^(?:yes|yeah|yep|yup|sure|ok|okay|right|exactly|correct|no|nope|maybe|makes sense|got it|true|fair|fair enough|sounds good|will do|agreed|definitely|of course|not really|kind of|sort of|perfect|great)\b/;

const QUESTION_START =
  /^(?:what|how|why|when|where|who|which|should|could|would|can|do|does|did|is|are|will|any)\b/;

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** What `text` does in the conversation (deterministic cues; English). */
export function founderMoves(text: string): FounderMove[] {
  const t = normalize(text);
  if (t === '') return [];
  const moves: FounderMove[] = MOVE_CUES.filter(([, cue]) => cue.test(t)).map(([move]) => move);
  if (bringsNews(t)) moves.push('news');
  if (asksForHelp(t)) moves.push('help');
  const words = wordCount(t);
  if (words <= 5 && SHORT_REPLY.test(t) && !moves.includes('thanks')) moves.push('short_reply');
  if (t.endsWith('?') || (QUESTION_START.test(t) && words > 2)) moves.push('question');
  return moves;
}

// Social turns and direct questions ------------------------------------------------------------------------

/** Social lead-ins before a founder's actual question ("Sure, but who pays?"). */
const SOCIAL_LEAD =
  /^(?:(?:hi|hey|hello|hiya|good (?:morning|afternoon|evening)|thanks|thank you|thx|cheers|ok|okay|sure|yes|yeah|yep|no|nope|right|great|perfect|cool|got it|makes sense|fair enough|sounds good|and|but|so)\b[\s,.!:;-]*)+/i;
/** "How are you?" and its kin: a social question, answered socially. */
const HOW_ARE_YOU =
  /\bhow(?:'s| is| are| have) (?:it going|you(?: been| doing)?|things|your (?:day|week))\b[?!.]*/gi;
const ASKING_WORD =
  /^(?:what|how|why|when|where|who|which|should|could|would|can|do|does|did|is|are|will|any)\b/i;

/**
 * Whether the founder's message asks something that needs an answer, however short ("Sure, but who pays?"): a
 * question left after the greeting, thanks or "ok" around it. "How are you?" alone is social.
 */
export function asksSomething(text: string, moves: readonly FounderMove[] = founderMoves(text)): boolean {
  if (!moves.includes('question')) return false;
  const rest = text.replace(SOCIAL_LEAD, '').replace(HOW_ARE_YOU, '').replace(SOCIAL_LEAD, '').trim();
  return rest.includes('?') || (ASKING_WORD.test(rest) && wordCount(rest) > 2);
}

/**
 * The words of a social message that say nothing else: thanks and appreciation, a goodbye, a hello, an "okay". What a
 * message keeps once they are taken out is what it tells ({@link tellsSomething}).
 */
const SOCIAL_PHRASES = new RegExp(
  [
    // Thanks and appreciation ("Thanks so much for your help", "I really appreciate it", "That's genuinely helpful").
    String.raw`\b(?:many |big )?(?:thanks|thank you|thank u|thx|ty|cheers)(?: (?:so|very) much| a (?:lot|ton|bunch)| again| heaps)?(?: (?:for|4) (?:(?:all )?(?:the|your) (?:help|time|advice|input|tips|ideas|insights?|support|chat|call|talk|thoughts|feedback)|(?:helping|listening|that|this|everything|all (?:that|this|of (?:that|this))|today|the chat|the call)))?`,
    String.raw`\b(?:much appreciated|(?:i )?(?:really |truly )?appreciate (?:it|that|this|you|the help|your help|your time)(?: a lot| so much)?)`,
    String.raw`\b(?:that's|that is|that was|this is|this was|it's|it is|it was|you're|you are|you've been|that has been|this has been)(?: (?:really|super|very|so|genuinely|incredibly|truly|extremely|honestly|actually|quite|such|a|so so))* (?:helpful|useful|great|perfect|amazing|awesome|brilliant|clear|good|excellent|fantastic|the best|(?:a )?(?:big|huge|real) help|a lifesaver|gold|clarifying)`,
    String.raw`\b(?:(?:super|really|very|so|genuinely) (?:helpful|useful|clear)|(?:that|this) (?:helps|helped)(?: a lot| loads)?|(?:that |this )?makes (?:total |a lot of |perfect )?sense|got it|sounds (?:good|great|perfect)|will do|love (?:it|that|this))`,
    // Taking the advice on board, with nothing new in it ("Thanks, I'll do that.").
    String.raw`\b(?:i'll|i will|we'll|we will) (?:do (?:that|it|this|so)|try (?:that|it|this)|think about (?:it|that)|keep (?:that|it|this) in mind|give (?:it|that) a (?:go|try|shot)|let you know(?: how (?:it|that|they) (?:goes|go|went))?|see)\b`,
    // A goodbye ("Talk soon", "I have to run", "Have a good one").
    String.raw`\b(?:goodbye|bye(?:-bye| for now)?|talk (?:soon|later|tomorrow|next week)|speak soon|catch you later|signing off|good ?night|i'll let you go|until next time|take care|see you(?: (?:soon|later|tomorrow|next (?:week|time)|then))?|have a (?:good|great|nice|lovely) (?:one|day|evening|night|weekend|week))`,
    String.raw`\b(?:(?:i|we|i've|we've|i'm|we're)(?: really| actually| just)? (?:(?:have |'ve )?got to|have to|need to|gotta|going to have to)|gotta|must) (?:go|run|jump|dash|head (?:off|out)|hop off|leave)(?: now| soon| in a (?:sec|second|minute|bit))?`,
    // Relief, said in passing ("Phew, that takes some pressure off", "I feel a lot better about this now").
    String.raw`\b(?:phew|whew|(?:that's|that is|what) a relief|relieved|(?:that |this )?takes (?:some |the |a lot of )?(?:pressure|weight) off|i feel (?:a lot |so much |much |way )?(?:better|calmer|lighter)(?: about (?:this|it|that|things))?)`,
    // Chat slang that adds nothing ("talk soon! no cap", "thanks! fr").
    String.raw`\b(?:no cap|fr|frfr|ngl|not gonna lie|tbh|tbf|lol|lmao|haha+|ty|thx|bro|dude|mate|fam)\b`,
    String.raw`\b(?:(?:that's|that is) (?:all|it|everything|enough) for (?:now|today)|let's (?:stop|wrap(?: it)? up|leave it) (?:here|there|for (?:now|today))|i'm done for (?:now|today))`,
    // A hello ("Hey, good morning", "How's it going?").
    String.raw`\b(?:hi|hey|hello|hiya|howdy|yo|good (?:morning|afternoon|evening|day)|morning|evening)(?: there| again)?`,
    String.raw`\bhow(?:'s| is| are| have) (?:it going|you(?: been| doing)?|things|your (?:day|week))`,
    // Acknowledgements and fillers.
    String.raw`\b(?:ok|okay|alright|all right|right|sure|yes|yeah|yep|yup|great|perfect|cool|nice|awesome|amazing|brilliant|excellent|wonderful|lovely|fantastic|so|well|anyway|again|and|oh|ah|wow|haha|lol|too|as always|then|now)\b`,
  ].join('|'),
  'giu',
);

/** A first-person subject or possessive: the founder telling something of their own ("we signed", "my cofounder"). */
const FIRST_PERSON =
  /(?<![\p{L}'])(?:i|im|i'm|i've|ive|i'll|i'd|we|we're|we've|we'll|we'd|my|our|ours)(?![\p{L}'])/iu;

/**
 * Whether a message tells something besides its social words ({@link SOCIAL_PHRASES}): a number, the founder's own
 * news or plan (a first-person subject: "we signed", "my cofounder left"), or any content word ("the dean said yes").
 * A name said to them ("Thanks, Corin!") tells nothing.
 */
function tellsSomething(text: string): boolean {
  const rest = text.normalize('NFKC').replace(APOSTROPHES, "'").replace(SOCIAL_PHRASES, ' ');
  if (/\p{N}|[$€£¥%]/u.test(rest)) return true;
  if (FIRST_PERSON.test(rest)) return true;
  const content = (rest.match(/\p{L}[\p{L}'-]*/gu) ?? []).filter((w) => contentWords(w).size > 0);
  if (content.length === 0) return false;
  // One capitalised word and nothing else: a name they said to the vEIR.
  return !(content.length === 1 && /^\p{Lu}/u.test(content[0] ?? ''));
}

/**
 * What a message that is only social does (doctrine "Conversation craft"; the lab's SM-19 and SM-13): thanks
 * ("Thank you, this is genuinely helpful"), a wrap-up ("Okay, thanks, that's helpful. Talk soon.") or a hello, with
 * nothing asked and nothing told: once its social words are taken out, nothing is left ({@link tellsSomething}).
 * Null for a message with a real question, or with news, a decision, a number or a plan in it ("Thanks! We signed
 * Hartwell.", "Okay, we'll go with $900. Talk soon."): that is answered, and kept, like any other.
 */
export function socialTurnOf(text: string): SocialTurn | null {
  const moves = founderMoves(text);
  if (asksSomething(text, moves)) return null;
  const kind: SocialTurn | null = moves.includes('closing')
    ? 'closing'
    : moves.includes('thanks')
      ? 'thanks'
      : moves.includes('greeting')
        ? 'greeting'
        : null;
  return kind === null || tellsSomething(text) ? null : kind;
}

/** "X or Y?" asked of the vEIR, or a request for its pick or verdict. */
const CHOICE =
  /(?:\b(?:should|shall|do|would|could|can|is|are)\b[^?]{1,120}\bor\b[^?]{1,80}\?|^[^?]{1,60}\bor\b[^?]{1,60}\?$|\b(?:which (?:one|is better|would you|should (?:we|i))|what would you (?:do|pick|choose|go with)|(?:just )?(?:decide|pick|choose) for (?:me|us)|your (?:pick|call|honest (?:view|take)|recommendation)|what do you recommend|which do you recommend|yes or no)\b)/i;

/** Whether the message asks for a number ("Give me a number", "how much should we charge?"): SM-16. */
export function asksForNumber(text: string): boolean {
  return NUMBER_REQUEST.test(normalize(text));
}

/**
 * Whether the message asks the vEIR to choose or give its view, directly (LAB-V3: "per branch or a flat campus
 * fee?" was answered with demand-validation questions). The reply answers it in its first sentence.
 */
export function directChoiceOf(text: string): boolean {
  const flat = normalize(text);
  return flat.includes('?') || /\b(?:decide|pick|choose) for (?:me|us)\b|\byour (?:pick|call)\b/.test(flat)
    ? CHOICE.test(flat)
    : false;
}

// Content words ------------------------------------------------------------------------------------------

const STOPWORDS = new Set(
  (
    'a about above after again against all also am an and any are aren as at be because been before being below ' +
    'between both but by can cannot could couldn did didn do does doesn doing don down during each few for from ' +
    'further had hadn has hasn have haven having he her here hers herself him himself his how i if in into is isn ' +
    'it its itself just let me more most my myself no nor not now of off on once only or other our ours ourselves ' +
    'out over own same she should shouldn so some such than that the their theirs them themselves then there these ' +
    'they this those through to too under until up very was wasn we were weren what when where which while who whom ' +
    'why will with won would wouldn you your yours yourself yourselves ok okay yeah yes yep no nope sure thanks ' +
    'thank hi hey hello please maybe really actually think know like just want need get got going go make made ' +
    'thing things something anything stuff lot lots much many way kind sort bit good great nice cool helpful useful ' +
    'perfect right well also still even already ever never always one two last time next today tomorrow yesterday ' +
    'week day said say says tell told ask asked mean meant talk talked talking back anyway btw remember recall ' +
    'question different another topic quick oh wait sorry per via etc'
  ).split(' '),
);

function suffixless(word: string): string {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** A crude stem that lets "price", "prices", "priced" and "pricing" meet. */
function stem(word: string): string {
  const base = suffixless(word);
  return base.length > 3 && base.endsWith('e') ? base.slice(0, -1) : base;
}

/** The content words of `text` (lower-cased, stop words removed, crudely stemmed). */
export function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of normalize(text).matchAll(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)) {
    const word = match[0].replace(/'s$/, '').replace(/'/g, '');
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    out.add(stem(word));
  }
  return out;
}

function shared(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n += 1;
  return n;
}

// Plain text helpers -------------------------------------------------------------------------------------

/** For each position, the index of the first of `stops` at or after it (`text.length` when none). */
function nextOf(text: string, stops: string): Int32Array {
  const next = new Int32Array(text.length + 1);
  next[text.length] = text.length;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    next[i] = stops.includes(text.charAt(i)) ? i : (next[i + 1] ?? text.length);
  }
  return next;
}

/**
 * Markdown links and images (`[text](url)`, `![alt](url)`) replaced by their text, in one linear pass: a regular
 * expression for them backtracks quadratically on a founder's pasted "[x](" runs.
 */
export function stripLinks(text: string): string {
  if (!text.includes('](')) return text;
  const bracket = nextOf(text, ']\n');
  const paren = nextOf(text, ')\n');
  let out = '';
  let from = 0;
  for (let i = text.indexOf('['); i >= 0; i = text.indexOf('[', i + 1)) {
    const close = bracket[i + 1] ?? text.length;
    if (text.charAt(close) !== ']' || text.charAt(close + 1) !== '(') continue;
    const end = paren[close + 2] ?? text.length;
    if (text.charAt(end) !== ')') continue;
    const start = i > from && text.charAt(i - 1) === '!' ? i - 1 : i;
    out += text.slice(from, start) + text.slice(i + 1, close);
    from = end + 1;
    i = end;
  }
  return out + text.slice(from);
}

/** Markdown and citation keys removed, one line (linear in the length of `text`). */
function plain(text: string): string {
  return stripLinks(text)
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/\s+/g, ' ')
    .replace(/ ?\[ ?E\d+(?: ?[,;] ?E\d+)* ?\]/gi, '')
    .replace(/[#>*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const LEADING_SOCIAL =
  /^(?:(?:hi|hey|hello|ok|okay|so|well|thanks|thank you|yeah|yes|right|by the way|btw|anyway|also|oh|actually|quick question|different question|another question|one more thing)\b[\s,.!:;-]*)+/i;

/** A thread's gist: the founder's words without the social lead-in, first sentence, one bounded line. */
export function gistOf(text: string): string {
  const flat = plain(text).replace(LEADING_SOCIAL, '').trim();
  const sentence = /^[\s\S]*?[.!?](?=\s|$)/.exec(flat)?.[0] ?? flat;
  return truncate(sentence.length >= 12 ? sentence : flat, GIST_CHARS);
}

/** Whether a reply ends in a question (its last sentence). */
export function endsWithQuestion(answer: string): boolean {
  return /\?["'”’)\]]*$/.test(plain(answer));
}

/** The first words of a reply. */
export function openingOf(answer: string): string {
  const words = plain(answer)
    .split(' ')
    .filter((w) => w !== '');
  if (words.length === 0) return '';
  return words.length > OPENING_WORDS ? `${words.slice(0, OPENING_WORDS).join(' ')}…` : words.join(' ');
}

/** The last question a reply asks (its last sentence ending in "?"), one bounded line, or null. */
export function lastQuestionOf(answer: string): string | null {
  const sentences = plain(answer).split(/(?<=[.!?]["'”’)\]]*)\s+/);
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    const sentence = (sentences[i] ?? '').trim();
    if (/\?["'”’)\]]*$/.test(sentence)) return truncate(sentence, QUESTION_CHARS);
  }
  return null;
}

/** A hello and nothing else ("Hi!", "Good morning", "Hi, it's me again", "How are you?"). */
function onlyGreets(text: string, moves: readonly FounderMove[]): boolean {
  if (!moves.includes('greeting')) return false;
  const rest = normalize(text).replace(
    /\bgood (?:morning|afternoon|evening|day)\b|\b(?:morning|evening|howdy|hiya)\b/g,
    ' ',
  );
  return contentWords(rest).size === 0;
}

/** Whether the founder's message takes up the vEIR's question: answers it, or at least says something to it. */
function takesUp(question: string, text: string, moves: readonly FounderMove[]): boolean {
  // A hello is not an answer: "Hi!" after "How did the facilities call go?" leaves the question open.
  if (onlyGreets(text, moves)) return false;
  // "I don't know. You tell me." says something, but hands the question back: it is still open.
  if (moves.includes('help')) return false;
  if (moves.includes('short_reply')) return true;
  if (moves.some((m) => m === 'topic_shift' || m === 'recall' || m === 'resume' || m === 'closing'))
    return false;
  if (shared(contentWords(question), contentWords(text)) > 0) return true;
  // Something said, not only a question of their own.
  return normalize(text)
    .split(/(?<=[.!?])\s+/)
    .some((s) => s !== '' && !s.endsWith('?'));
}

// Derivation ---------------------------------------------------------------------------------------------

interface Thread {
  gist: string;
  words: Set<string>;
  /** Index (in founder messages) of the last message in this thread. */
  last: number;
  settled: boolean;
}

/** Whether a message carries venture substance (not only social words or a one-word reply). */
function substantive(text: string, moves: readonly FounderMove[]): boolean {
  if (moves.includes('short_reply')) return false;
  const content = contentWords(text).size;
  if (moves.includes('closing') || moves.includes('thanks'))
    return content >= 3 && moves.includes('question');
  return content >= 2;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

/**
 * The state of the conversation for the new founder message: `history` holds the completed earlier exchanges in
 * view (oldest first; turns without an answer are skipped).
 */
export function deriveConversationState(
  history: readonly StateTurn[],
  founderText: string,
  options: {
    /**
     * The conversation's opener (the vEIR's first message, replayed before the history): on the founder's first
     * message it counts as the vEIR's last reply (its question, how it opened).
     */
    readonly opener?: string | null;
  } = {},
): ConversationState {
  const turns = history.filter(
    (t) => t.answer !== null && t.answer.trim() !== '' && t.founderText.trim() !== '',
  );
  const messages = [...turns.map((t) => t.founderText), founderText];
  const newIndex = messages.length - 1;

  let current: Thread | null = null;
  let previous: Thread | null = null;
  const parked: Thread[] = [];
  const park = (thread: Thread | null): void => {
    if (thread === null || thread.settled) return;
    if (!parked.includes(thread)) parked.unshift(thread);
  };

  for (let i = 0; i < messages.length; i += 1) {
    const text = messages[i] ?? '';
    const moves = founderMoves(text);
    if (i === newIndex) previous = current;
    const words = contentWords(text);
    if (
      current !== null &&
      (moves.includes('thanks') || moves.includes('closing')) &&
      !moves.includes('question')
    ) {
      current.settled = true;
    }
    if (!substantive(text, moves)) continue;

    // A message that shares content words with a parked thread returns to it ("back to…" needs only one).
    const needed = moves.includes('resume') ? 1 : 2;
    const resumed = parked.find((p) => shared(words, p.words) >= Math.min(needed, p.words.size));
    if (resumed !== undefined) {
      parked.splice(parked.indexOf(resumed), 1);
      if (current !== resumed) park(current);
      resumed.last = i;
      for (const w of words) resumed.words.add(w);
      current = resumed;
      continue;
    }
    const lastAnswer = i > 0 ? (turns[i - 1]?.answer ?? '') : '';
    const answered = i > 0 && endsWithQuestion(lastAnswer);
    const overlap =
      current === null ? 0 : shared(words, current.words) + shared(words, contentWords(lastAnswer));
    const marked = moves.includes('topic_shift');
    // Unmarked talk continues the thread (stepwise), and the turn after the vEIR's question is its answer.
    const shift = current === null || marked || (!answered && overlap === 0 && words.size >= 4);
    if (shift) {
      park(current);
      current = { gist: gistOf(text), words: new Set(words), last: i, settled: false };
    } else if (current !== null) {
      current.last = i;
      for (const w of words) current.words.add(w);
    }
  }
  const asThread = (t: Thread): ConversationThread => ({ gist: t.gist, messagesAgo: newIndex - t.last });

  let streak = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (!endsWithQuestion(turns[i]?.answer ?? '')) break;
    streak += 1;
  }
  const openings = turns
    .slice(-MAX_OPENINGS)
    .reverse()
    .map((t) => openingOf(t.answer ?? ''))
    .filter((o) => o !== '');

  const asked: string[] = [];
  for (let i = turns.length - 1; i >= 0 && asked.length < MAX_ASKED; i -= 1) {
    const question = lastQuestionOf(turns[i]?.answer ?? '');
    if (question !== null && !asked.includes(question)) asked.push(question);
  }
  // The founder's first message answers the opener: it is the vEIR's last reply so far.
  const opener = options.opener?.trim() ?? '';
  const afterOpener = turns.length === 0 && opener !== '';
  if (afterOpener) {
    const question = lastQuestionOf(opener);
    if (question !== null) asked.push(question);
    if (endsWithQuestion(opener)) streak = 1;
    const opening = openingOf(opener);
    if (opening !== '') openings.push(opening);
  }
  const lastAsked = lastQuestionOf(afterOpener ? opener : (turns.at(-1)?.answer ?? ''));
  const moves = founderMoves(founderText);

  const prev: Thread | null = previous;
  const open = parked.filter((p) => p !== current).slice(0, MAX_PARKED);
  const said = [...turns.map((t) => t.answer ?? ''), opener].join('\n').replace(/[‘’ʼ]/g, "'").toLowerCase();
  const usedPhrases = OVERUSED_PHRASES.filter((phrase) => said.includes(phrase));
  return {
    moves,
    social: socialTurnOf(founderText),
    directChoice: directChoiceOf(founderText),
    asksForNumber: asksForNumber(founderText),
    usedPhrases,
    openerGreeted: afterOpener && /^(?:hi|hello|hey|hiya)\b/i.test(opener),
    words: wordCount(founderText),
    typicalWords: median(turns.map((t) => wordCount(t.founderText))),
    // A thread the new message leaves unsettled is reported once, as parked.
    previous: prev === null || open.includes(prev) ? null : asThread(prev),
    parked: open.map(asThread),
    questionStreak: streak,
    recentOpenings: openings,
    askedQuestions: asked,
    openQuestion: lastAsked !== null && !takesUp(lastAsked, founderText, moves),
    earlierTurns: turns.length,
    afterOpener,
  };
}

const MOVE_LABELS: Readonly<Record<FounderMove, string>> = {
  recall: 'asks what you remember from before',
  resume: 'wants to go back to an earlier thread',
  repair: 'corrects how you understood them',
  closing: 'is wrapping up',
  thanks: 'thanks you',
  topic_shift: 'changes the topic',
  greeting: 'greets you',
  stress: 'sounds stressed or discouraged',
  humour: 'is joking around',
  sarcasm: 'is being sarcastic',
  news: 'brings news',
  short_reply: 'is a short reply to your last message',
  question: 'asks a question',
  help: 'asks you to do it, or says they are stuck',
};

/** Moves worth reporting even on the first message of a conversation. */
const NOTABLE: ReadonlySet<FounderMove> = new Set([
  'recall',
  'resume',
  'repair',
  'closing',
  'thanks',
  'topic_shift',
  'greeting',
  'stress',
  'humour',
  'sarcasm',
  'news',
  'help',
]);

function quoted(text: string): string {
  return `"${escapeData(text.replace(/"/g, "'"))}"`;
}

function ago(n: number): string {
  return n <= 1 ? 'just before this message' : `${n} messages ago`;
}

/**
 * The `<conversation_state>` block, or '' when there is nothing worth saying (the first message of a
 * conversation with no notable move). Founder words in it are escaped data.
 */
export function renderConversationState(state: ConversationState): string {
  const notable =
    state.moves.some((m) => NOTABLE.has(m)) || state.directChoice === true || state.asksForNumber === true;
  if (state.earlierTurns === 0 && !notable && !state.afterOpener) return '';
  const what = state.moves.map((m) => MOVE_LABELS[m]);
  const length =
    state.typicalWords === null
      ? `${state.words} words`
      : `${state.words} words (their messages usually run about ${state.typicalWords})`;
  const lines = [`- Their message${what.length > 0 ? ` ${what.join(', ')}` : ''}; ${length}.`];
  if (state.afterOpener) {
    lines.push(
      state.openerGreeted === true
        ? '- It answers your opening line, which already greeted them and picked up last time: never greet them or say that again.'
        : '- It answers your opening line, which already picked up last time: never say that again.',
    );
  }
  if (state.social === 'thanks') {
    lines.push(
      '- A thanks and nothing more: a short, warm reply only. No advice, plan or recap, and no other field.',
    );
  } else if (state.social === 'closing') {
    lines.push(
      '- They are wrapping up: a warm sign-off (their one next step in a line at most), no new question, no other field.',
    );
  } else if (state.social === 'greeting' && state.earlierTurns > 0) {
    lines.push('- A hello and nothing more: a few warm words, no advice.');
  }
  if (state.moves.includes('news')) {
    lines.push(
      '- They bring news: react to it and ask about it first, in your own words. In this reply never steer back to an',
      '  earlier question, plan or parked thread.',
    );
  }
  if (state.moves.includes('help')) {
    lines.push(
      '- They want you to do it, or they are stuck: do the work in this reply. Give the thing itself, specific to their',
      '  venture (a draft, concrete options or questions, an example, the first steps), then at most a short check that',
      '  it fits. Never hand the question back or ask them for what they just said they cannot give.',
    );
    const handedBack = state.openQuestion ? (state.askedQuestions[0] ?? null) : null;
    // Lab run 39780304879: "I don't know. You tell me." after "Where are things with the advisor session and your three
    // questions?" got "What are the three questions you want to ask?" back.
    if (handedBack !== null) {
      lines.push(
        `- They handed your question back (${quoted(handedBack)}): answer it yourself now, concretely.`,
      );
    }
  }
  const asks = state.moves.includes('help') || state.moves.includes('question');
  const aboutNotes = state.moves.includes('recall') || state.moves.includes('resume');
  if ((state.social ?? null) === null && asks && !aboutNotes) {
    lines.push(
      '- Make this reply about what they just said. Bring nothing up from your notes (commitments, open questions,',
      '  earlier advice) unless it serves that.',
    );
  }
  if (state.moves.includes('sarcasm')) {
    lines.push(
      '- They are being sarcastic: meet it lightly in a few words of your own, then one practical line; no framework.',
    );
  }
  if (state.directChoice === true) {
    lines.push(
      '- They asked you to choose or give your view: open with one pick, outright (no "only if"), and why in a line,',
      '  before anything you ask.',
    );
  }
  if (state.asksForNumber === true) {
    lines.push(
      '- They asked for a number: give a reasoned range and the one assumption behind it, before anything else; never',
      '  withhold it for want of evidence.',
    );
  }
  if (state.previous !== null) lines.push(`- You were on: ${quoted(state.previous.gist)}.`);
  for (const p of state.parked) {
    lines.push(`- Parked, left before it was settled: ${quoted(p.gist)} (${ago(p.messagesAgo)}).`);
  }
  if (state.questionStreak >= 2) {
    lines.push(`- Your last ${state.questionStreak} replies all ended with a question.`);
  } else if (state.questionStreak === 1) {
    lines.push('- Your last reply ended with a question.');
  }
  if (state.recentOpenings.length > 0) {
    lines.push(`- Your recent replies opened with: ${state.recentOpenings.map(quoted).join(' | ')}`);
  }
  if (state.askedQuestions.length > 0) {
    lines.push(`- You already asked: ${state.askedQuestions.map(quoted).join(' | ')}`);
  }
  if (state.openQuestion) {
    lines.push('- They did not take up your last question: answer what they said, and do not ask it again.');
  }
  if ((state.usedPhrases ?? []).length > 0) {
    lines.push(
      `- Phrases you already used in this conversation (never again): ${(state.usedPhrases ?? []).map(quoted).join(' | ')}`,
    );
  }
  return [`<${CONVERSATION_STATE_TAG}>`, ...lines, `</${CONVERSATION_STATE_TAG}>`].join('\n');
}
