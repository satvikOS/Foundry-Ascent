import { classifyRisk } from '../risk/classifier.js';
import { CONVERSATION_STATE_TAG, OVERUSED_PHRASES } from './craft.js';
import { escapeData, truncate } from './escape.js';
import { phrasingLedger, renderPhrasingLedger, type PhrasingLedger } from './phrasing.js';

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
  | 'help'
  | 'rehearse'
  | 'step_out'
  | 'defer'
  | 'restart'
  | 'summary'
  | 'complaint'
  | 'lost_reply'
  | 'hesitant'
  | 'unknown'
  | 'goal';

/** A completed earlier exchange (the shape of `HistoryTurn`). */
export interface StateTurn {
  readonly founderText: string;
  readonly answer: string | null;
  /** The escalation category the turn's reply escalated to, or null/absent (`HistoryTurn.escalated`). */
  readonly escalated?: string | null;
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
   * The message reports having done something they committed to ("I did the thing I said I'd do", "Done!"): the reply
   * names which commitment it was and asks how it went ({@link reportsCommitmentDone}).
   */
  readonly reportsDone?: boolean;
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
   * What the founder already told in the turns in view: something done, a constraint, or their own numbers (one line
   * each, unescaped, newest first): never asked for again, and never a step they said is done or ruled out.
   */
  readonly told?: readonly string[];
  /** How the founder asked to be answered ("yes/no answers", "short answers"), newest first: kept to until changed. */
  readonly preferences?: readonly string[];
  /**
   * The message takes the advice on board and says what they will do, asking nothing ("Got it, I'll send it Friday"):
   * a short confirmation and sign-off, no new homework ({@link wrapUpOf}).
   */
  readonly wrapUp?: boolean;
  /** The message reads as being about another venture or team, or asks for a message to be passed on. */
  readonly aboutOthers?: boolean;
  /**
   * Escalation categories already referred in this conversation's turns (deterministic, from the turn records, oldest
   * first, distinct): the referral is not said again, and the vEIR helps them prepare. `safety_wellbeing` is never
   * listed: wellbeing support is offered whenever it is needed (diagnosis fix 4, "escalate once, then help").
   */
  readonly escalatedEarlier?: readonly string[];
  /**
   * Whether the question the vEIR's last reply asked (the first of `askedQuestions`) is still open: the new message
   * neither answers it nor takes it up (it asks something else, or changes the topic).
   */
  readonly openQuestion: boolean;
  /** Completed exchanges in view. */
  readonly earlierTurns: number;
  /**
   * How many of the vEIR's latest replies in a row were in character in a role-play (a line for the counterpart,
   * "**Investor:** …"): 0 when it is not role-playing ({@link inRole}).
   */
  readonly inRoleReplies?: number;
  /** The new message is the founder's previous message again, word for word (a resend). */
  readonly duplicate?: boolean;
  /**
   * The vEIR's advice earlier in this conversation, one line each, oldest first (replies before the last two): built
   * on, never given again (long sessions: live pilot 42124259353's marathon and long-session runs repeated feedback).
   */
  readonly adviceGiven?: readonly string[];
  /**
   * The new message is the founder's first reply to the vEIR's own opening line (the conversation's stored opener,
   * which already picked up the last conversation): the reply must not say it again.
   */
  readonly afterOpener: boolean;
  /**
   * The message names a goal or a step ahead of the founder (the `goal` move), or is their first reply to the opener and
   * names what they want to work on (a statement, not a question or a hello): the reply teaches the usual path and
   * prepares them for it (production, 2026-11-07: a goal of bringing the product to market got a request to walk the
   * coach through where they were).
   */
  readonly goal?: boolean;
  /**
   * The vEIR's own phrasing lately (coaching v3): question forms and openings it used twice or more in this
   * conversation, or at the end of its last conversations (prompts/phrasing.ts). Absent: none.
   */
  readonly phrasing?: PhrasingLedger;
}

/** Longest gist of a thread. */
export const GIST_CHARS = 90;
/** Most parked threads reported. */
export const MAX_PARKED = 3;
/** Most recent openings reported. */
export const MAX_OPENINGS = 3;
/**
 * Most questions the vEIR already asked that are reported (so it never asks one again). Live pilot 42099643194: with
 * the last two only, 83 of 122 repeated sentences repeated the reply two turns back.
 */
export const MAX_ASKED = 6;
/** Most things the founder already told that are reported. */
export const MAX_TOLD = 4;
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
    /(?:\b(?:that's not what i (?:meant|said|asked|was asking)|that isn't what i (?:meant|said|asked)|you misunderstood|you misread|you got (?:that|it|me) wrong|i didn't (?:mean|say|ask) that|you (?:were|are) wrong|(?:that's|that is|that was) (?:not right|wrong|incorrect|not true|not correct)|you made a mistake|you said (?:something )?wrong|correction:)\b|^(?:no|nope|not quite|not exactly|sorry|wait)[,.!]?\s+(?:i|what i)\s+(?:meant|mean|was asking|asked|said)\b|^i meant\b)/,
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
    /(?:\b(?:by the way|btw|(?:a )?(?:different|another|unrelated|separate|random|new) (?:question|topic|thing|subject)|(?:talk|focus|move on) (?:about|on|to) something (?:else|different)|something else (?:entirely|now)|(?:let's|can we|could we) (?:now )?(?:move on|switch|turn) to (?!(?:it|that|this)\b)|(?:let's|can we|could we) (?:now )?talk about [\w' -]{1,40} instead|on (?:another|a different|a separate) note|chang(?:e|ing) (?:the )?(?:topic|subject)|before i forget|switching gears|quick (?:question|one))\b|^(?:oh|also)[,.]? (?:and |also )?(?:what|how|can|could|should|one more)\b|^actually[,.]? (?:can|could|let's|i want|i'd like)\b)/,
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
  // Live pilot 42124259353 (pitch rehearsal 1.83, conversation control 1.83, recovery 1.83): the moves below were
  // answered as ordinary messages: a request to practise got advice, "can we go back to a simpler question?" got the
  // next in-character question, "can we come back to that later?" got the topic pushed, "your replies seem generic
  // today" got more of the same.
  [
    'rehearse',
    /\b(?:(?:let's|let us|can we|could we|shall we|i want to|i'd like to|i wanna|help me) (?:do (?:a |an |some )?(?:quick )?)?(?:practi[cs]e|rehearse|role-?play|(?:mock|dry|practice) (?:run|pitch|interview|q ?& ?a|panel|meeting|call)|run through (?:my|the|our) (?:pitch|interview|meeting|call|presentation|demo))|(?:can|could|would|will) (?:you|we) (?:help me )?(?:practi[cs]e|rehearse|role-?play)|(?:do|run|try) (?:a |an )?(?:quick )?(?:mock|practice|dry) (?:pitch|interview|q ?& ?a|run|panel|meeting|call)|drill me|pretend (?:you(?:'re| are)|to be)|(?:(?:can|could|would|will) you (?:please )?|^(?:please |ok,? |okay,? |now )?)(?:play|be|act as) (?:a |an |the |my )?(?:\w+ )?(?:investor|vc|judge|panel(?:list)?|customer|buyer|landlord|board(?: member)?|reviewer|procurement|skeptic|sceptic|grant panel|dean|partner|cofounder)\b|you (?:play|be) (?:the |my |an? )(?:\w+ )?(?:investor|vc|judge|customer|buyer)\b|^role-?play\b)/,
  ],
  [
    'step_out',
    /\b(?:how did i do|how was (?:that|my (?:answer|pitch))|(?:give me|i want|real|honest) feedback|pause (?:the |this )?(?:role-?play|rehearsal|practice|drill)?|(?:stop|end|break) (?:the )?(?:role-?play|rehearsal|practice|drill|character)|out of (?:character|role)|time ?out|(?:can|could) we (?:go back|stop|pause|step out)|let me (?:try|start) (?:that |it )?(?:again|over)|start (?:the pitch )?over|i froze|i'm (?:blanking|frozen))\b/,
  ],
  [
    'defer',
    /(?:\b(?:come|get|circle) back to (?:that|this|it) (?:later|another time|next time)\b|(?:^|\b(?:let's|can we|could we|i'd like to|i want to|please) )(?:park|shelve|table) (?:that|this|it)\b|\b(?:let's |can we )?leave (?:that|this|it) (?:for (?:now|later|another time)|aside)\b|^(?:not (?:right )?now|later)(?:,? (?:though|please|thanks))?[.!]*$|\bsave (?:that|this|it) for (?:later|another time|next time)\b)/,
  ],
  [
    'restart',
    /(?:\b(?:let's|let us|can we|could we|i want to|i'd like to)(?: just)? (?:start (?:over|again|fresh|from scratch)|restart|reset|begin again)(?: (?:this|the conversation|our conversation|the chat|everything))?(?=[\s,.!?;]|$)|^(?:ok,? |okay,? )?(?:fresh start|start over|reset|restart)[.!?]*$|\bforget (?:everything|all (?:of )?(?:that|this))(?: (?:we|i|you)(?:'ve| have)? (?:said|discussed|talked about|covered))?\s*(?:[,.!;—–-]|$|and (?:let's|start)))/,
  ],
  [
    'summary',
    /(?:\b(?:can you |could you |please |pls )?(?:summari[sz]e|recap|sum up) (?:what we|this (?:conversation|chat|session|discussion|call)?|our (?:conversation|chat|session|discussion|call)|the (?:conversation|chat|session|discussion|call)|everything (?:we|so far)|where we|so far|it all|for me)|\b(?:give me|can i (?:get|have)|can you give me|let's have) (?:a |the )?(?:quick |short |brief )?(?:recap|summary)(?: of (?:what we (?:decided|agreed|covered|discussed|said)(?: on)?(?: today| so far)?|(?:this|our|the|today's) (?:conversation|chat|session|discussion|call)))?(?: please)?[.!?]*$|^(?:quick |short )?(?:summary|recap|tl;?dr)(?: please)?[.!?]*$|\bwhat (?:did|have) we (?:decide|agree)d?(?: on)?\b|\bwhere did we land\b)/,
  ],
  [
    'complaint',
    /\b(?:you(?:'re| are) not (?:listening|getting it|helping)|you keep (?:saying|repeating|asking|telling)|you already (?:said|asked|told me)(?: that)?|(?:that|this)(?:'s| is| was) not (?:what i asked|an answer)|that doesn't answer (?:my|the) question|you didn't answer|(?:^|please |just )answer my question|(?:you(?:'re| are| seem| feel| sound)|your (?:replies|answers|responses)(?: are| seem| feel| sound)?) (?:so |really |pretty |a bit |kind of |very )?(?:generic|robotic|repetitive|useless|vague|canned|slow)|(?:your )?(?:replies|answers|responses) (?:seem|are|feel|sound) (?:so |really |pretty |a bit |kind of )?(?:generic|slow|off|robotic|canned)|stop repeating)\b/,
  ],
  [
    'lost_reply',
    /\b(?:(?:your|the) (?:last )?(?:reply|message|answer|response)s? (?:just )?(?:got )?(?:cut off|didn't (?:come through|load|arrive|send)|was cut|stopped|broke|failed)|you (?:got )?cut off|didn't (?:get|see) your (?:reply|message|answer|response)|(?:our|this) (?:call|line|connection|audio|video) (?:dropped|cut out|froze|died|stopped working|broke up)|(?:the|my) (?:connection|audio|wifi|wi-fi|internet) (?:dropped|cut out|froze|died|stopped working)|(?:i )?lost (?:you|the connection|connection)\b|i only (?:heard|got|saw) (?:half|part) of (?:that|it|your|what you)|(?:re-?posting|re-?sending) my (?:question|message)|got an error (?:here|just now|on (?:my|your|this) (?:side|end|reply|message))|(?:the |this )?(?:chat|app|page) (?:gave me an error|errored|crashed|froze))/,
  ],
  [
    'hesitant',
    /^(?:hmm+|hm+|uh+|um+|i guess|i suppose|maybe|sure\.{2,}|ok\.{2,}|okay\.{2,}|i don't know\.{2,}|if you say so|not sure)[.!?…]*$/,
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

/**
 * A sentence that says the founder has no answer yet: they did not do it, it has not happened, nobody told them
 * (production, 2026-11-07: "I didn't do that" and "I don't know" were answered with the question they had just said
 * they could not answer, in other words, two replies later). Never a question of its own.
 */
const NO_ANSWER = new RegExp(
  [
    String.raw`^(?:(?:no|nope|honestly|um+|uh+|well|sorry|so)[,.]? )*(?:i|we) (?:really |honestly |just |actually )?(?:didn't|did not|haven't|have not|never|couldn't|could not) (?:(?:really|actually|yet|even|get to|got to|manage to|managed to|get around to|got around to) )*(?:do|done|did|ask|asked|book|booked|call|called|talk|talked|speak|spoke|try|tried|hear|heard|check|checked|look|looked|follow|followed|reach|reached|find|found|meet|met|write|wrote|written|send|sent)\b(?:(?: (?:that|it|this|them|him|her|one|anything|up|out|back|yet|either|so far|to (?:them|him|her|anyone)))*$|\b.* yet$)`,
    String.raw`^(?:(?:no|nope|honestly|well|sorry|so)[,.]? )*(?:i|we) (?:didn't|did not|haven't|have not|never) (?:get|got|gotten) (?:around )?to (?:it|that|this|them)$`,
    String.raw`^(?:(?:no|nope|honestly|well|sorry|so)[,.]? )*(?:i|we) (?:didn't|did not|haven't|have not)(?: yet)?$`,
    String.raw`^(?:(?:no|nope|well|so)[,.]? )*(?:not yet|nothing yet|not so far|no clue|no idea|not really sure|no one (?:told|said)|nobody (?:told|said))\b`,
    String.raw`^(?:(?:no|nope|well|so)[,.]? )*(?:they|he|she|it|the \w+) (?:didn't|did not|never|wouldn't|would not) (?:really )?(?:say|tell|mention|specify|explain|answer|give|cover|get into)\b`,
    String.raw`\b(?:i|we) (?:can't|cannot|don't|do not) (?:really )?remember\b`,
  ].join('|'),
);

/**
 * Whether `text` says the founder does not know, has not done it or has no answer yet ({@link DONT_KNOW},
 * {@link NO_ANSWER}), and asks nothing of its own ("Not sure. Does it matter who pays?": that question is what to
 * answer).
 */
function hasNoAnswer(text: string): boolean {
  if (text.includes('?')) return false;
  // Clause by clause: "I don't know, I didn't do that" says it twice in one sentence.
  return text
    .split(/(?<=[.!,;])\s+/)
    .map((clause) => clause.replace(/[.!,;…]+$/, '').trim())
    .some((clause) => DONT_KNOW.test(clause) || NO_ANSWER.test(clause));
}

/**
 * A goal or a step ahead of the founder, said as theirs ("taking the device to market", "we need to raise a seed round",
 * "I want to find our first clinics"): production, 2026-11-07, a goal of bringing the product to market was answered
 * with a request to walk the coach through where they were, where the founder needed the usual path laid out and the
 * prep for it.
 */
const GOAL = new RegExp(
  [
    String.raw`\b(?:get(?:ting)?|bring(?:ing)?|tak(?:e|ing)|go(?:ing)?) (?:(?:the|our|my|this|it|product|device|app|platform)\s+){0,2}(?:to|into) (?:the )?market\b|\bgo[- ]to[- ]market\b`,
    String.raw`\b(?:launch(?:ing)?|ship(?:ping)?) (?:the|our|my|a|it|first)\b`,
    String.raw`\b(?:rais(?:e|ing)|secur(?:e|ing)|land(?:ing)?) (?:(?:a|our|my|the|some|more|first|pre-?seed|seed|angel)\s+){0,2}(?:money|funding|capital|round|investment|grant|investors?)\b|\bfundrais(?:e|ing)\b`,
    String.raw`\b(?:find(?:ing)?|land(?:ing)?|sign(?:ing)?|get(?:ting)?|win(?:ning)?) (?:(?:my|our|the|a|more|some|first|paying|real)\s+){0,3}(?:customers?|clients?|users?|pilots?|investors?|co-?founders?|clinics?|hospitals?|schools?|buyers?|distributors?|partners?)\b`,
    String.raw`\b(?:get(?:ting)?|obtain(?:ing)?|apply(?:ing)? for|go(?:ing)? through) (?:(?:the|a|an|our|my|regulatory|fda|ce)\s+){0,2}(?:approval|clearance|certification|patent|licen[cs]e|accreditation)\b`,
    String.raw`\b(?:my|our|the) (?:main |big |next |biggest )?(?:goal|aim|priority|focus|next step)(?: right now| now| this (?:week|month|term|year))? (?:is|would be)\b`,
    String.raw`\b(?:i|we) (?:want|need|have|plan|hope|'d like|would like|am trying|are trying|'m trying|'re trying) to (?:get|launch|raise|find|build|ship|sell|start|scale|grow|hire|pitch|apply|prepare|figure out|work out)\b`,
    String.raw`\b(?:prepar(?:e|ing) for|get(?:ting)? ready for)\b`,
  ].join('|'),
);

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

// A report of having done what they committed to ------------------------------------------------------------

/** Lead-ins before a report said at the start of a sentence ("So, I did…", "Okay, did the thing…"). */
const REPORT_LEAD = String.raw`(?:(?:so|ok|okay|well|yeah|yes|yep|and|alright|right|anyway|update)[,.!:]* )*`;
/** Words between the subject and the verb that keep it a report ("I finally did…"); a negation is none of them. */
const REPORT_ADVERBS = String.raw`(?:(?:finally|actually|just|already|also|totally|now|officially) )*`;
/**
 * A subject the report is said of: "I" or "we", never in a clause that only supposes it ("if I did what you
 * suggested", "I hope we did…") or asks it ("have I done the thing I said I'd do", a transcript without its "?"), or
 * none at the start of a sentence ("Did the thing I said I'd do").
 */
const REPORT_SUBJECT = String.raw`(?:^${REPORT_LEAD}${REPORT_ADVERBS}|(?<!\b(?:if|when|whenever|once|until|unless|whether|before|after|wish|hope|suppose|imagine|have|has|had|did|do|does|should|could|would|can|will|shall|must|might|may)\s)\b(?:i|we)(?:'ve| have)? ${REPORT_ADVERBS})`;

/** "I said I'd", typed or transcribed ("i said id", "I said I was gonna"). */
const SAID_WOULD = String.raw`said (?:i|we)(?:'?d| would| (?:was|were) (?:gonna|going to))`;
/** Not what they committed to but what they said they would never do ("the thing I said I'd never do"). */
const NOT_NEGATED = String.raw`(?! (?:(?:i|we|you)(?:'?d| would)? )?(?:never|not|no longer|rather|sooner|wouldn't|won't|shouldn't)\b)`;

/** The commitment named as such: "the thing I said I'd do", "what you suggested", "what we agreed on". */
const NAMED_COMMITMENT = String.raw`(?:(?:the|that|this) things? (?:that )?(?:i|we) (?:${SAID_WOULD}(?: do)?|promised(?: to do)?|committed to)|(?:what|everything) (?:i|we) ${SAID_WOULD}(?: do)?|(?:the thing|what|everything) you (?:suggested|recommended)|what we agreed(?: on)?)\b${NOT_NEGATED}`;

/**
 * "I did the thing I said I'd do", "We tried what you suggested", "I've finally done what I said I would". Global: a
 * sentence can say it twice, once under a doubt ({@link doubtedBefore}) and once plainly.
 */
const DID_NAMED = new RegExp(
  String.raw`${REPORT_SUBJECT}(?:did|done|finished|completed|tried|followed|went (?:ahead )?with) (?:exactly )?${NAMED_COMMITMENT}`,
  'g',
);

/**
 * A negation or a doubt that the report is said under: "I don't think", "I doubt", "I can't say", "I'm not sure", "I'd
 * be lying if (I said)", "didn't", "haven't", "never", "failed to", "forgot to", "couldn't", "wasn't able to". "No
 * doubt", "without a doubt", "I never doubted" and "never mind" are none.
 */
const DOUBT_CUE = new RegExp(
  String.raw`\b(?:(?:don'?t|do not|didn'?t|did not) (?:really |honestly |actually |even )?(?:think|believe|feel like|reckon)|(?<!\b(?:no|without|without a|beyond|beyond a|never|not|don'?t|do not|didn'?t|did not) )doubt(?:s|ed|ful)?|(?:can'?t|cannot|can not|couldn'?t|could not) (?:really |honestly |truly )?say|not (?:so |too |really |entirely |totally |quite |that |a hundred percent |100% )?(?:sure|convinced)|unsure|(?:lying|lie) if|(?:didn'?t|did not|haven'?t|have not|hasn'?t|has not|never(?! mind\b))(?! (?:once |ever |really )?doubt)|failed to|forgot to|couldn'?t|could not|(?:wasn'?t|was not|weren'?t|were not) able to)\b`,
  'g',
);

/**
 * After a negation, a feeling about the report that takes it as true all the same ("I've never been so glad I did…",
 * "I'd be lying if I said I wasn't proud we did…", "I can't say I'm sorry I did…").
 */
const FEELS_ABOUT =
  /\b(?:glad|happy|happier|proud|prouder|relieved|thankful|grateful|sorry|surprised|shocked|amazed|regret(?:ted|s)?)\b/;
/**
 * After any negation but "lying if", telling, knowing or believing the report, which takes it as true too ("I forgot to
 * tell you I did what you suggested", "I don't think you noticed I did…", "I couldn't believe I did…"); "I'd be lying if
 * I told you I did…" denies it.
 */
const KNOWS_OF =
  /\b(?:tell|told|telling|mention|mentioned|let (?:you|them|him|her|everyone|anyone|people|the team) know|update(?:d)? (?:you|them|him|her)|know|knew|noticed|heard|reali[sz]ed?|remember(?:ed)?|believe)\b/;

/**
 * Where the clause the report is in begins: after a comma, semicolon, colon, dash or bracket, or before a word that
 * joins another clause ("I didn't think it would work, but I did what you suggested", "…so I did what you suggested";
 * "not so sure" keeps its "so").
 */
const CLAUSE_BREAK =
  /[,;:()—–]| - |\b(?:and|but|(?<!\b(?:not|never|not really|not quite) )so|then|yet|because|cause|cos|coz|since|though|although|while|plus|anyway|however)\b/g;

/** How far before the report a doubt is looked for, so a pasted wall of reports stays linear. */
const DOUBT_LOOKBACK = 200;
/**
 * At most this many words between the doubt and the report ("I'd be lying if | I said that | I did…"), so a negation
 * further back in an unpunctuated run-on is another clause.
 */
const DOUBT_WORDS = 6;

/**
 * Whether the report that starts at `index` of `sentence` is said under a negation or a doubt in its own clause ("I
 * don't think I did what you suggested", "I doubt we did what we agreed", "I can't say I did…", "I'd be lying if I said
 * I did…"): then it is no report. A negation in a clause before it ("I didn't think it would work, but I did what you
 * suggested") or after it ("I did what you suggested and it didn't work") leaves it one, and so does a word after the
 * negation that takes it as true ({@link FEELS_ABOUT}, {@link KNOWS_OF}).
 */
function doubtedBefore(sentence: string, index: number): boolean {
  let before = sentence.slice(Math.max(0, index - DOUBT_LOOKBACK), index);
  // A window that cuts a word drops it, so the rest of "knot" is never "not".
  if (index > DOUBT_LOOKBACK) before = before.replace(/^\S*\s?/, '');
  let start = 0;
  for (const m of before.matchAll(CLAUSE_BREAK)) start = m.index + m[0].length;
  const clause = before.slice(start);
  let cue: RegExpExecArray | null = null;
  for (const m of clause.matchAll(DOUBT_CUE)) cue = m;
  if (cue === null) return false;
  const between = clause.slice(cue.index + cue[0].length).trim();
  if (between !== '' && between.split(' ').length > DOUBT_WORDS) return false;
  if (FEELS_ABOUT.test(between)) return false;
  return /^(?:lying|lie) if$/.test(cue[0]) || !KNOWS_OF.test(between);
}

/** "like we agreed", "as we agreed", "as promised", "like I said I would", "as you suggested". */
const AS_AGREED = String.raw`(?:just )?(?:(?:like|as) (?:we(?:'d| had)? agreed|i ${SAID_WOULD}(?: do(?: it)?)?|i promised|you suggested)|as (?:agreed|promised))`;

/**
 * A step said as done, in the past ("called", "sent", "talked"). News (launched, signed, hired…) is not here: it is
 * heard as news, and running out of something is no step. Without a subject, only a form that is past and nothing else
 * ("Sent it", not "Set up the call" or "Run the numbers", which ask for it, nor "Did…", which asks whether it was done).
 */
const PAST_STEP = String.raw`(?:finished|completed|tried|sent|called|emailed|e-mailed|messaged|texted|booked|scheduled|talked|spoke|met|ran(?! out\b)|wrote|posted|interviewed|asked|contacted|reached out|submitted|followed up|drafted|got (?:it|that|them|everything) done)`;
/** The same step after "I've" or "we have": "I've sent it", "We've run the numbers". */
const DONE_STEP = String.raw`(?:done|finished|completed|tried|sent|called|emailed|e-mailed|messaged|texted|booked|scheduled|talked|spoken|met|run(?! out\b)|written|posted|interviewed|asked|contacted|reached out|set up|submitted|followed up|drafted|got (?:it|that|them|everything) done)`;

/**
 * A word that starts another clause, or is the subject of one ("…and, as we agreed, I'll send the deck Friday", "Did I
 * send it like we agreed"): the words after the step stop before it, so "as we agreed" is said of the step and nothing
 * else.
 */
const CLAUSE_WORD = String.raw`(?:and|but|so|then|or|nor|because|cause|cos|while|though|although|since|until|till|unless|once|when|whenever|before|after|if|whether|that|which|who|what|where|why|how|i|we|you|he|she|they|(?:i|we|you|he|she|they|it|that|there)'[a-z]+|will|would|won't|wouldn't|gonna|going|shall|should|can|could|might|may|must|not|never|no)`;

/**
 * The step itself, from its subject ("I", "we", or none at the start of the sentence) to its object, in one clause:
 * "I called the dean", "Sent the plan to the dean", "We've run the numbers".
 */
const STEP_CLAUSE = String.raw`(?:(?:i|we) ${REPORT_ADVERBS}(?:${PAST_STEP}|set up)|(?:i|we)(?:'ve| have) ${REPORT_ADVERBS}${DONE_STEP}|${REPORT_ADVERBS}${PAST_STEP})(?: (?!${CLAUSE_WORD}(?![\p{L}\p{N}']))[^\s,;:]+){0,16}`;

/**
 * A step done "like we agreed", as the whole sentence: the step and then the commitment named ("I called the dean like
 * we agreed", "Sent it, as we agreed"), or the commitment named and then the step ("As we agreed, I sent the survey to
 * 30 nurses"). The two touch, so "We talked about pricing and, as we agreed, I'll send the deck Friday" (what is
 * agreed comes next, after a past act it is no part of) is none: the audit of 21515bd found ten of those.
 */
const STEP_AS_AGREED = new RegExp(
  String.raw`^${REPORT_LEAD}(?:${STEP_CLAUSE},? ${AS_AGREED}|${AS_AGREED},? ${STEP_CLAUSE})$`,
  'u',
);

/** A whole message that is only a report: "Done!", "I did it", "Did it!", "Finished it", "Sent it", "Got it done". */
const WHOLE_REPORT = /^(?:done|(?:i )?(?:did it|finished it|sent it|got it done))[\s.!]*$/;

/**
 * Quoted words (a draft: "Draft email: 'Hi Dr Shah, I sent the pilot plan as promised…'", what someone said) are not
 * what they report. A single quote opens after no letter and closes before none, so "I'd" inside one stays in it. A
 * quote runs at most {@link QUOTE_CHARS} characters, so a pasted wall of unclosed quotes stays linear.
 */
const QUOTE_CHARS = 600;
const QUOTED = new RegExp(
  String.raw`"[^"]{0,${QUOTE_CHARS}}"|“[^”]{0,${QUOTE_CHARS}}”|(?<![\p{L}\p{N}])'(?=[^\s'])(?:[^']|'(?=\p{L})){0,${QUOTE_CHARS}}?'(?![\p{L}\p{N}])`,
  'gu',
);

/**
 * Whether the message reports having done something they committed to, explicitly (evals G12, the matrix's commitment
 * probe: "I did the thing I said I'd do" was answered without naming the commitment): the commitment named as such
 * ("I did the thing I said I'd do", "I tried what you suggested", "I called the dean like we agreed"), or a whole
 * message that is only a report ("Done!", "I did it", "Sent it"). Nothing broader: a celebration ("We did it!!"), news
 * ("We launched it"), a question ("Done with the deck?") or a negation ("I didn't do it", "Not done yet") is no report,
 * nor is a report said under a negation or a doubt ("I don't think I did what you suggested", {@link doubtedBefore}).
 */
export function reportsCommitmentDone(text: string): boolean {
  const t = normalize(text);
  if (WHOLE_REPORT.test(t)) return true;
  return t
    .replace(QUOTED, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.replace(/[.!…]+$/, '').trim())
    .some(
      (sentence) =>
        sentence !== '' &&
        !sentence.endsWith('?') &&
        (STEP_AS_AGREED.test(sentence) ||
          [...sentence.matchAll(DID_NAMED)].some((m) => !doubtedBefore(sentence, m.index))),
    );
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
  if (hasNoAnswer(t)) moves.push('unknown');
  if (GOAL.test(t) && !t.endsWith('?')) moves.push('goal');
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
 * The founder asks to hear something again, or to run a rehearsal or a drill again ("ok stop, run it again from the
 * top", "same questions again"): then a reply may repeat it (diff3-A3; the brief: repetition the student asked for is
 * not a fault).
 */
const REPEAT_REQUEST =
  /\b(?:from the top|(?:run|do|go through|ask|start) (?:(?:it|that|this|them|those|the (?:\w+ )?(?:questions|pitch|run|round|drill|rehearsal|role-?play)) )?(?:again|over)|again,? (?:the )?same (?:questions|run|round|drill)|same questions again|(?:another|one more) (?:round|run|pass)|repeat (?:that|it|this|yourself|what you said)|say (?:that|it|this) again|one more time|come again|(?:what|which) was (?:that|it|the (?:first|second|last|next) (?:step|one|thing|point))|remind me what you (?:said|suggested)|go over (?:that|it) again|(?:can|could) you (?:say|explain) (?:that|it) again|(?:sorry|pardon),? what\?)/i;

/**
 * Whether the founder asks to hear the last reply (or part of it) again: in so many words, or by asking what the
 * vEIR remembers or where they were (the answer names it again, on purpose).
 */
export function asksToRepeat(founderText: string): boolean {
  if (REPEAT_REQUEST.test(founderText.replace(/[‘’ʼ]/g, "'"))) return true;
  const moves = founderMoves(founderText);
  return moves.includes('recall') || moves.includes('resume');
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

// What the founder already told, and how they want answers ---------------------------------------------------

/**
 * A sentence telling something done, a constraint or a number of their own (live pilot 42099643194, paraphrased: "I
 * already went to the tech-transfer office", "we can't afford a second batch", "70% of 200 sales were two sizes":
 * the advice to do it, or the question for it, came back in five of seven replies).
 */
const TOLD = new RegExp(
  [
    String.raw`\balready\b`,
    String.raw`\b(?:i|we)(?:'ve| have)? (?:just )?(?:done|did|tried|talked|spoke|spoken|met|sent|asked|interviewed|called|emailed|went|gone|checked|filed|submitted|built|sold|signed|ran|run|booked|launched|shipped)\b`,
    String.raw`\b(?:i|we)(?:'ve| have| got| already have) (?:got )?(?:the|a|an|our|my|some|all|both)\b`,
    String.raw`\b(?:can't|cannot|can not|couldn't|don't have|do not have|doesn't work|won't work|isn't possible|is not possible|not allowed|too expensive|no (?:budget|money|time|access|way))\b`,
    String.raw`\p{N}`,
  ].join('|'),
  'u',
);

/** How a founder asks to be answered, and the label it is kept under. */
const PREFERENCES: readonly (readonly [string, RegExp])[] = [
  ['yes/no answers', /\b(?:yes(?: or |\/)no(?: answers?| only)|(?:just|only) (?:a )?yes(?: or |\/)no)\b/],
  [
    'short answers',
    /\b(?:keep (?:it|them|answers?|replies) (?:short|brief|tight)|short(?:er)? (?:answers?|replies)|be (?:brief|quick)|no essays?|(?:one|a) (?:line|sentence) (?:answers?|only)|tl;?dr|too long|less text|fewer words|(?:shorter|briefer),? please)\b/,
  ],
  [
    'just the steps',
    /\b(?:just|only) (?:give|tell|list) (?:me|us) the (?:\w+ )?(?:steps|answer|bottom line)\b/,
  ],
  ['no frameworks', /\bno (?:more )?(?:frameworks?|theory|lectures?|jargon)\b/],
  [
    'no questions',
    /\b(?:stop asking(?: me)?(?: so many| all these)? questions|no more questions|(?:don't|do not) ask me (?:any(?:thing| more| questions)|more questions|questions)|(?:fewer|less) questions|without (?:the |all the )?questions|enough (?:with the )?questions|just tell me,? (?:don't|do not|no) ask)\b/,
  ],
];

/** The preferences a message states ({@link PREFERENCES}). */
export function preferencesOf(text: string): string[] {
  const t = normalize(text);
  return PREFERENCES.filter(([, cue]) => cue.test(t)).map(([label]) => label);
}

/**
 * How the founder asked to be answered in this conversation (`earlier` messages oldest first, then `latest`), newest
 * first and distinct: kept to until they change it (the turn engine also enforces "yes/no answers", "short answers" and
 * "no questions" on the reply: validators/social.ts budgets, the sentence gate's `noQuestions`).
 */
export function statedPreferences(earlier: readonly string[], latest: string): string[] {
  const out: string[] = [];
  for (const text of [latest, ...[...earlier].reverse()]) {
    for (const p of preferencesOf(text)) if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** A first-person plan of their own: what they will do next. */
const WILL_DO =
  /(?:\b(?:i'll|i will|we'll|we will|i'm going to|we're going to|i'm gonna|we're gonna|gonna|i plan to|we plan to)|(?:^|[.!,;]\s*)going to)\s+(?!think about\b|see\b|need\b|have to\b)[\p{L}]/u;
/** Taking advice on board: thanks or an assent. */
const ON_BOARD =
  /^(?:(?:ok|okay|alright|right|great|perfect|cool|thanks|thank you|thx|cheers|got it|makes sense|sounds good|will do|understood|noted|fair enough|yes|yeah|yep)\b|.*\b(?:thanks|thank you|that helps|super helpful|very helpful|that's helpful)\b)/u;

/** A reservation or a worry in a message that otherwise takes the advice on board. */
const RESERVATION =
  /\b(?:but|though|although|however|unless|except|worried|not sure|no idea|can't|cannot|won't)\b/;

/**
 * A plan that touches the founder's wellbeing, or reads as crisis-adjacent however casually it is put ("I'll just stop
 * eating until the launch", "I'm going to end it after the demo"): never signed off on as a wrap-up. Recall over
 * precision: a false positive only means the message is answered in full.
 */
const WELLBEING_CUE =
  /\b(?:end (?:it|it all|everything|my life)|ending (?:it|it all|everything)|(?:stop|quit|skip(?:ping)?|not) (?:eating|sleeping|meals|food)|starv\w*|no (?:food|sleep|meals)|all[- ]nighters?|(?:hurt|harm|kill)\w* (?:myself|me)|die|dying|dead|disappear\w*|give up on (?:everything|life|myself)|done with (?:everything|life|it all)|(?:can't|cannot) (?:go on|do this anymore|take (?:it|this) anymore)|no point|pills|overdose|self[- ]harm|nobody (?:cares|would notice)|burn(?:ed|t)? out|breakdown|panic attacks?)\b/;

/**
 * Whether the message takes the advice on board and says what they will do, asking nothing ("Got it, I'll call the
 * three stores by Friday. Thanks!"). Live pilot 42099643194: 35 of 47 such turns got more than 40 words of new homework.
 * A message that is only social ({@link socialTurnOf}) is not one: it is answered as that. Never a plan the risk
 * classifier flags (signing an agreement tonight, taking 70% of the equity, filing a patent alone, testing a supplement
 * on friends) or one that touches their wellbeing ({@link WELLBEING_CUE}): that moment needs the escalation or a
 * check-in, not a warm sign-off.
 */
export function wrapUpOf(text: string, moves: readonly FounderMove[] = founderMoves(text)): boolean {
  if (asksSomething(text, moves)) return false;
  if (
    moves.some((m) => m === 'help' || m === 'news' || m === 'stress' || m === 'repair' || m === 'topic_shift')
  ) {
    return false;
  }
  const t = normalize(text);
  // A reservation is something to answer ("I'll call them, but the owner never picks up").
  if (RESERVATION.test(t)) return false;
  if (!(ON_BOARD.test(t) && WILL_DO.test(t) && socialTurnOf(text) === null)) return false;
  if (WELLBEING_CUE.test(t)) return false;
  const risk = classifyRisk(text);
  return !risk.crisis && risk.categories.length === 0;
}

/**
 * The message reads as being about another venture or team on the platform, or asks for a message to be passed on
 * (live pilot 42099643194: "what discount did they get?", "can you pass this to their founder?"). By phrasing alone,
 * never by whether a name is a real venture's: the turn-level cue then cannot tell anyone which ventures exist (the
 * classifier's own flag stays out of the prompt for that reason, `answer.ts`).
 */
const ABOUT_OTHERS = new RegExp(
  [
    String.raw`\b(?:another|other|the other|that other|a different|some other) (?:team|venture|startup|founder|company|cohort team|group)s?\b(?! (?:members?|mates?|meetings?|leads?|roles?|sizes?|names?|ideas?|structures?))`,
    String.raw`\b(?:the other team's|the other founder's|the other company's) (?:deal|discount|terms|pricing|price|contract|numbers|rate|rent)\b`,
    // What a deal of someone else's came to: "what kind of discount did they end up getting on their rent?".
    String.raw`\b(?:what|how much|which)(?: kind of| sort of| size of)? (?:deal|discount|terms|price|rate|rent|percentage|cut)s? (?:did|do|does|has|have|had|could|would) (?:they|he|she|their \w+|the (?:\w+ )?(?:company|startup|team|studio|firm|venture|business|founder|shop|brand)) (?:end up |actually |manage to |finally )?(?:get|getting|got|negotiate|negotiated|pay|paid|land|landed|sign|signed|secure|secured)\b`,
    String.raw`\b(?:same|similar) (?:kind of )?(?:deal|discount|terms|rate|rent) (?:as|to) (?:the|that|their) (?!last\b|first\b|previous\b|one\b)\w+`,
    // Recalling a deal by name: "remind me the scale of the X deal", "remind me of their deal with the hotel".
    String.raw`\bremind me(?: again)?(?: of| about| what| how big)? (?:the |their )?(?:(?:scale|size|terms|details|numbers|value|amount) of (?:the |their )?)?(?:\w+ ){0,2}deal\b`,
    // A relay: "pass on a message to their founder", "can you pass this on", "put me in touch".
    String.raw`\bpass (?:on |along )?(?:a |my |the |this |that |our )?(?:message|note|word|it|this|that|my number|my details|my info)(?: on| along)?(?: to\b| for\b|$|[,.!?])`,
    String.raw`\b(?:put me in touch|introduce me to|connect me (?:with|to)|get me in touch)\b`,
    String.raw`\b(?:can|could|would|will) you (?:please |just )?(?:tell|ask|let|message|contact|reach out to|email|ping) (?:him|her|them|their (?:founder|team|ceo|cofounder|co-?founder|people)|the other (?:founder|team)|the founder of)\b`,
    String.raw`\b(?:rumou?r(?:s|ed)?|heard (?:that )?the other)\b`,
  ].join('|'),
);

/** Whether the message reads as being about another venture or team, or asks for a relay ({@link ABOUT_OTHERS}). */
export function aboutOthersOf(text: string): boolean {
  return ABOUT_OTHERS.test(normalize(text));
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

/**
 * A reply in character in a role-play: a line for the counterpart ("**Investor:** "…"", "Judge: "…""), or a reply that
 * is a quoted line and nothing before it (REHEARSE mode, `rehearsal.line`).
 */
const IN_ROLE =
  /(?:^|\n)\s*(?:\*\*|__)?(?:[A-Z][\w'’.-]*)(?: [A-Za-z][\w'’.-]*){0,4}:(?:\*\*|__)?\s*["“]|^\s*(?:\*\*|__)?["“][^"”]{12,}["”]/u;

/** Whether a reply is in character in a role-play ({@link IN_ROLE}). */
export function inRole(answer: string): boolean {
  return IN_ROLE.test(answer);
}

/** Most earlier advice lines reported. */
export const MAX_ADVICE = 4;

/** The first sentence of a reply that says something (not a greeting, thanks or a question), one bounded line. */
function adviceLineOf(answer: string): string | null {
  for (const raw of plain(answer).split(/(?<=[.!?])\s+/)) {
    const sentence = raw.trim();
    if (wordCount(sentence) < 6 || sentence.endsWith('?')) continue;
    if (inRole(sentence)) return null;
    return truncate(sentence, GIST_CHARS);
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
  // "I don't know. You tell me." says something, but hands the question back: it is still open. So does "I didn't do
  // that": there is no answer to take up.
  if (moves.includes('help') || moves.includes('unknown')) return false;
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
    /**
     * The vEIR's replies at the end of its last conversations with this founder, newest first: read for the phrasing
     * ledger only (how it asked and opened), never quoted as what was said.
     */
    readonly pastReplies?: readonly (string | null | undefined)[];
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
  // What they already told (earlier messages only: the new one is right there), and how they want answers.
  const told: string[] = [];
  for (let i = turns.length - 1; i >= 0 && told.length < MAX_TOLD; i -= 1) {
    const sentences = plain(turns[i]?.founderText ?? '').split(/(?<=[.!?])\s+/);
    for (let j = sentences.length - 1; j >= 0 && told.length < MAX_TOLD; j -= 1) {
      const sentence = (sentences[j] ?? '').trim();
      if (wordCount(sentence) < 4 || !TOLD.test(normalize(sentence))) continue;
      const line = truncate(sentence, GIST_CHARS);
      if (!told.includes(line)) told.push(line);
    }
  }
  const escalatedEarlier: string[] = [];
  for (const t of turns) {
    const category = t.escalated ?? null;
    if (category !== null && category !== 'safety_wellbeing' && !escalatedEarlier.includes(category)) {
      escalatedEarlier.push(category);
    }
  }
  const preferences = statedPreferences(
    turns.map((t) => t.founderText),
    founderText,
  );
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
  // A role-play under way: the vEIR's latest replies in character, newest first.
  let inRoleReplies = 0;
  for (let i = turns.length - 1; i >= 0 && inRole(turns[i]?.answer ?? ''); i -= 1) inRoleReplies += 1;
  const lastFounder = turns.at(-1)?.founderText ?? '';
  const duplicate = wordCount(founderText) >= 3 && normalize(lastFounder) === normalize(founderText);
  const adviceGiven: string[] = [];
  for (const t of turns.slice(0, -2)) {
    const line = adviceLineOf(t.answer ?? '');
    if (line !== null && !adviceGiven.includes(line)) adviceGiven.push(line);
  }

  // Their first reply to the opener's invitation names what they want to work on ("taking the device to market").
  const namesWork =
    afterOpener &&
    !moves.includes('question') &&
    !moves.includes('short_reply') &&
    !moves.includes('unknown') &&
    socialTurnOf(founderText) === null &&
    substantive(founderText, moves);
  const prev: Thread | null = previous;
  const open = parked.filter((p) => p !== current).slice(0, MAX_PARKED);
  const said = [...turns.map((t) => t.answer ?? ''), opener].join('\n').replace(/[‘’ʼ]/g, "'").toLowerCase();
  const usedPhrases = OVERUSED_PHRASES.filter((phrase) => said.includes(phrase));
  return {
    moves,
    social: socialTurnOf(founderText),
    directChoice: directChoiceOf(founderText),
    asksForNumber: asksForNumber(founderText),
    reportsDone: reportsCommitmentDone(founderText),
    told,
    preferences,
    wrapUp: wrapUpOf(founderText, moves),
    aboutOthers: aboutOthersOf(founderText),
    escalatedEarlier,
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
    goal: moves.includes('goal') || namesWork,
    inRoleReplies,
    duplicate,
    adviceGiven: adviceGiven.slice(-MAX_ADVICE),
    phrasing: phrasingLedger(
      [...turns.map((t) => t.answer)].reverse().concat(opener === '' ? [] : [opener]),
      options.pastReplies ?? [],
      {
        founderSaid: [...turns.map((t) => t.founderText), founderText],
        repeatAsked: asksToRepeat(founderText),
      },
    ),
  };
}

/** Whether the vEIR leaned on a phrasing worth naming (prompts/phrasing.ts). */
function hasPhrasing(state: ConversationState): boolean {
  const p = state.phrasing;
  return (
    (p?.questions.length ?? 0) +
      (p?.openings.length ?? 0) +
      (p?.closings.length ?? 0) +
      (p?.phrases.length ?? 0) >
    0
  );
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
  rehearse: 'asks to practise a conversation with you playing the other side',
  step_out: 'steps out of the practice',
  defer: 'parks something for later',
  restart: 'wants a fresh start',
  summary: 'asks for a summary',
  complaint: 'is unhappy with your replies',
  lost_reply: 'says a reply or the connection failed',
  hesitant: 'sounds unsure',
  unknown: 'says they do not know, have not done it or have no answer yet',
  goal: 'names a goal or a step ahead of them',
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
  'rehearse',
  'step_out',
  'defer',
  'restart',
  'summary',
  'complaint',
  'lost_reply',
  'hesitant',
  'unknown',
  'goal',
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
    state.moves.some((m) => NOTABLE.has(m)) ||
    state.directChoice === true ||
    state.asksForNumber === true ||
    state.reportsDone === true ||
    state.wrapUp === true ||
    state.aboutOthers === true ||
    (state.escalatedEarlier ?? []).length > 0 ||
    (state.preferences ?? []).length > 0 ||
    state.duplicate === true ||
    state.goal === true ||
    (state.inRoleReplies ?? 0) > 0 ||
    hasPhrasing(state);
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
  } else if (state.wrapUp === true) {
    lines.push(
      '- They took it on board and said what they will do: confirm it in a line and sign off warmly. No new advice,',
      '  homework or question.',
    );
  }
  if (state.aboutOthers === true) {
    lines.push(
      '- If they ask about another venture, team or founder, or for a message to be passed on: you know nothing about',
      '  other ventures and discuss no rumours or deals, and you cannot pass messages. Say so in one line, then help',
      '  with their own case (a draft they could send is fine).',
    );
  }
  if ((state.escalatedEarlier ?? []).length > 0) {
    lines.push(
      `- Already referred earlier in this conversation (${(state.escalatedEarlier ?? []).join(', ')}): do not say the`,
      '  referral again; help them prepare for it (what that person will decide, what to bring, what not to do meanwhile).',
    );
  }
  if ((state.preferences ?? []).length > 0) {
    const prefs = state.preferences ?? [];
    lines.push(`- They asked for ${prefs.join(' and ')}: keep to it until they say otherwise.`);
    // Live pilot 42124259353: "yes or no answers only" was answered "Yes." to a statement and to "raise or keep?".
    if (prefs.includes('yes/no answers')) {
      lines.push(
        '  A yes/no question gets yes or no and one short reason; "this or that" gets the pick in a few words; a',
        '  statement gets a few words of acknowledgement. Never a bare "Yes." to anything else.',
      );
    }
    if (prefs.includes('no questions')) {
      lines.push('  No questions at all: say what you recommend and why, in statements.');
    }
  }
  if (state.moves.includes('news')) {
    lines.push(
      '- They bring news: react to it and ask about it first, in your own words. In this reply never steer back to an',
      '  earlier question, plan or parked thread.',
    );
  }
  // Evals G12, the matrix's commitment probe: "I did the thing I said I'd do" was answered without naming which
  // commitment it was. What they say of how it went, or ask, is taken up instead of the question.
  if (state.reportsDone === true) {
    lines.push(
      // Said neutrally: a doubt or a denial the cues miss ("I wouldn't say I did what you suggested") is still about the
      // commitment, so naming it and taking up what they said of it is right either way (differential audit, diff5-C3).
      '- They speak of something they committed to: name which commitment it is, in your own words (one agreed in',
      '  this conversation, else one from your notes), and respond to what they said of it (done, not done or partly)',
      '  with at most one short question, unless they already asked you something. If neither says which, ask that.',
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
  // Production, 2026-11-07: "I didn't do that" and "I don't know" were met by the question they had just said they could
  // not answer, two replies later and in other words.
  if (state.moves.includes('unknown')) {
    lines.push(
      '- They do not know, have not done it or have no answer yet, and that is fine. Never ask it again, in any words.',
      '  Acknowledge it in a few plain words, without judgement; then say what the answer most likely is or how it',
      '  usually works, the fastest way to find out, and the next step.',
    );
    const unanswered = state.openQuestion ? (state.askedQuestions[0] ?? null) : null;
    if (unanswered !== null && !state.moves.includes('help')) {
      lines.push(
        `- Your question ${quoted(unanswered)} has no answer yet: answer it yourself from how it usually goes.`,
      );
    }
  }
  if (state.goal === true) {
    lines.push(
      '- They name a goal or a step ahead of them: teach and prepare. Most of the reply is how it usually works (the',
      '  usual path, its steps, what the terms mean, what good looks like) and the prep they will need (questions to ask,',
      '  a checklist or a first plan), specific to their venture; at most one question, after it.',
    );
  }
  if (state.duplicate === true) {
    lines.push(
      '- They sent the same message as last time (most likely a resend): do not answer it as new. Say in a few words',
      '  that it looks like a repeat and add only what your last reply left out, or ask whether they meant something else.',
    );
  }
  if (state.moves.includes('lost_reply')) {
    lines.push(
      '- Something failed on their side (a reply cut off, an error, a dropped line): give briefly what they missed, from',
      '  where it broke; never start over, recap everything or introduce yourself again.',
    );
  }
  if (state.moves.includes('complaint')) {
    lines.push(
      '- They are unhappy with your replies: own it in a few plain words (no excuses, no technical talk, no apology',
      '  loop), then give something specific and new on what they actually asked.',
    );
  }
  if (state.moves.includes('restart')) {
    lines.push(
      '- They want a fresh start: drop your earlier framing and advice and take their message as the beginning; keep',
      '  only the facts they gave. No recap of what came before.',
    );
  }
  if (state.moves.includes('summary')) {
    lines.push(
      '- They want a summary: the decisions and next steps of this conversation only, briefly (a short list is fine);',
      '  nothing new, no question.',
    );
  }
  if (state.moves.includes('defer')) {
    const parkedNow = state.previous?.gist ?? null;
    lines.push(
      parkedNow === null
        ? '- They parked something for later: drop it now; bring it back once, later, at a natural moment.'
        : `- They parked ${quoted(parkedNow)} for later: drop it now; bring it back once, later, at a natural moment.`,
    );
  }
  // A first message has no subject to change from.
  if (state.moves.includes('topic_shift') && state.earlierTurns > 0) {
    lines.push(
      '- They changed the subject: follow them fully. Do not steer back to the earlier thread unless they return to it.',
    );
  }
  if (state.moves.includes('hesitant') && state.earlierTurns > 0) {
    lines.push(
      '- A short, unsure reply: check lightly, in one line, whether your last suggestion fits or something is off,',
      '  instead of ploughing on.',
    );
  }
  const rolePlaying = (state.inRoleReplies ?? 0) > 0;
  if (rolePlaying && (state.moves.includes('step_out') || state.moves.includes('summary'))) {
    lines.push(
      '- They stepped out of the role-play: answer as yourself at once (say you are stepping out). Give two or three',
      '  focused points (what worked, the one thing to fix, a stronger line they could use) or answer what they asked,',
      '  then offer to go back in.',
    );
  } else if (rolePlaying && (state.moves.includes('topic_shift') || state.moves.includes('stress'))) {
    lines.push(
      '- They left the role-play for something real: pause it, answer as yourself, then offer to resume.',
    );
  } else if (rolePlaying) {
    const n = state.inRoleReplies ?? 0;
    lines.push(
      '- You are role-playing: stay in character for their answer. React as that person would, in a line or two: one',
      '  pointed follow-up, or cut in on a vague, inflated or unsupported claim. Never a new question unrelated to it.',
      ...(n >= 2
        ? [
            `  Your last ${n} replies were all in character: after this answer, step out briefly with two or three focused`,
            '  points (what worked, the one thing to fix, a stronger line), then offer to go on.',
          ]
        : []),
    );
  } else if (state.moves.includes('rehearse')) {
    lines.push(
      '- They want to practise: play the person they name (else the obvious one for their situation, and say who) in',
      "  character, starting with that person's first question or opening line. No preamble, rules or homework.",
    );
  }
  if ((state.adviceGiven ?? []).length > 0) {
    lines.push(
      `- Earlier in this conversation you already said: ${(state.adviceGiven ?? []).map(quoted).join(' | ')}. Build on`,
      '  it; never give it again.',
    );
  }
  const asks = state.moves.includes('help') || state.moves.includes('question');
  const aboutNotes = state.moves.includes('recall') || state.moves.includes('resume');
  if ((state.social ?? null) === null && asks && !aboutNotes) {
    lines.push(
      '- Make this reply about what they just said. Bring nothing up from your notes (commitments, open questions,',
      '  earlier advice) unless it bears on it (their plan repeats a recorded pattern or breaks a commitment).',
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
      // Live pilot 42099643194: pressed for a number after a correct referral, the coach gave a device class, a timeline
      // and a cost range. Rule 5 holds for legal, regulatory, medical, equity and investment questions.
      '- They asked for a number: give a reasoned range and the one assumption behind it, before anything else; never',
      '  withhold it for want of evidence. Not for a legal, regulatory, medical, equity or investment question (rule 5).',
    );
  }
  if (state.previous !== null) lines.push(`- You were on: ${quoted(state.previous.gist)}.`);
  for (const p of state.parked) {
    lines.push(`- Parked, left before it was settled: ${quoted(p.gist)} (${ago(p.messagesAgo)}).`);
  }
  if (state.questionStreak >= 2) {
    lines.push(
      `- Your last ${state.questionStreak} replies all ended with a question: this one gives substance (a teaching point,`,
      '  a draft or your view) and ends without a question.',
    );
  } else if (state.questionStreak === 1) {
    lines.push('- Your last reply ended with a question.');
  }
  if (state.recentOpenings.length > 0) {
    lines.push(`- Your recent replies opened with: ${state.recentOpenings.map(quoted).join(' | ')}`);
  }
  if (state.askedQuestions.length > 0) {
    lines.push(`- You already asked: ${state.askedQuestions.map(quoted).join(' | ')}`);
  }
  const phrasing = state.phrasing === undefined ? '' : renderPhrasingLedger(state.phrasing);
  if (phrasing !== '') lines.push(phrasing);
  if ((state.told ?? []).length > 0) {
    lines.push(
      `- They already told you: ${(state.told ?? []).map(quoted).join(' | ')}. Build on it; never ask for it again or`,
      '  suggest what they said is done or ruled out.',
    );
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
