import { classifyRisk } from '../risk/classifier.js';
import { asksAboutIdentity, type IdentityCheckOptions } from '../validators/identity.js';
import { CONVERSATION_STATE_TAG, OVERUSED_PHRASES } from './craft.js';
import { escapeData, truncate } from './escape.js';
import { DEFAULT_PERSONA_NAME } from './version.js';

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
  | 'reports_done';

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
   * The message asks for the vEIR's advice or how to do something ("How do I position myself?"), without handing the
   * work over (that is the `help` move): the advice comes first, in the reply's first sentences.
   */
  readonly asksAdvice?: boolean;
  /**
   * The message sincerely asks whether the vEIR is a person or an AI ("How can I tell if you are an AI?"): the identity
   * rules decide the reply, so no advice, and no help in its first sentences, is asked for. Help, a pick or a number
   * asked for in a sentence of its own ("Are you a bot? Either way can you help me with my pitch?") is still theirs.
   */
  readonly asksWhoYouAre?: boolean;
  /**
   * The risk check flags the message as an instruction to change the vEIR's rules or a request about another venture
   * (by its text alone): the turn's rules decline it, so no advice, and no help in its first sentences, is asked for.
   * Help, a pick or a number asked for in a sentence the check does not flag ("Sorry, ignore the previous message, I
   * meant the dean. Can you help me write to the dean?") is still theirs.
   */
  readonly declined?: boolean;
  /**
   * The message says how they feel (the `stress` move, or nervous, frustrated, embarrassed, confused, excited, proud,
   * relieved…): any help or advice comes after a line that acknowledges it.
   */
  readonly feeling?: boolean;
  /**
   * The message says how the founder is in words the feeling and low-mood cues do not hold ("I'm at my limit", "can't
   * stop crying", "Nothing I do matters"): no advice line, and the help line asks for no help "in your first
   * sentences" (`saysHowTheyAre`).
   */
  readonly unwell?: boolean;
  /**
   * The message also asks something of its own (help, advice or a question): a report in it (`reports_done`) is named
   * in passing, and what they ask comes first.
   */
  readonly asksToo?: boolean;
  /**
   * When the message reports on something the founder said they would do (`reports_done`): the commitments of the
   * notes it most likely means, likeliest first (at most {@link MAX_REPORTED}), one line each, unescaped. None when the
   * report says what was done ("Sent!") and no commitment is about it.
   */
  readonly reportedCommitments?: readonly string[];
  /**
   * When the message reports on something they said they would do and the vEIR's last reply asked them to do
   * something ("Write your one-line pitch now and paste it here when you're done."): that sentence, unescaped.
   */
  readonly requestedStep?: string | null;
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
/** Most commitments named as the one a report ("I did the thing I said I'd do") most likely means. */
export const MAX_REPORTED = 2;
/** Longest commitment named. */
export const COMMITMENT_CHARS = 120;
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

/**
 * Verbs of a step done, said with "it" or "that" ("I posted it", "we finally did it"). Not "tried": "we tried that" is
 * pushback on a suggestion more often than a report. Not "nailed": "I nailed it. The pitch. Judges loved it." is how
 * something went, news of its own.
 */
const DONE_VERBS =
  'did|finished|completed|sent|posted|submitted|booked|emailed|shipped|published|launched|wrote|ran|uploaded|delivered|scheduled';
/** The same as participles, after "I've" or "we have" ("I've posted it"). */
const DONE_PARTICIPLES =
  'done|finished|completed|sent|posted|submitted|booked|emailed|shipped|published|launched|written|run|uploaded|delivered|scheduled';
/** Participles that are a whole report on their own ("Sent!", "Posted.", "Just booked."). */
const BARE_DONE =
  'sent|posted|submitted|booked|emailed|shipped|published|launched|uploaded|delivered|scheduled';
/** Between the subject and a verb of a step done ("I finally did it"). */
const DONE_ADVERBS = 'just|finally|already|actually|totally|literally|officially|now';
/**
 * Verbs of a step done that name the step ("Sent it to the dean last night.", "Emailed the dean.", "Called the dean,
 * like we agreed."), said with no subject at the start of a sentence. Never "did", "ran" or "wrote" ("Did it hurt",
 * "Ran the numbers again"): what it was is then anyone's guess. What such a step says is held to a commitment or the
 * step asked for ({@link ReportCue.mustFit}).
 */
const NAMED_STEP_VERBS =
  'sent|posted|submitted|booked|emailed|shipped|published|launched|uploaded|delivered|scheduled|finished|completed|called|phoned|interviewed|installed|messaged|texted|met|visited|surveyed|contacted|talked|spoke|pitched|followed up';
/** What a step named by its verb was done to or with ("emailed the dean", "talked to all five"). */
const STEP_OBJECT = String.raw`(?: (?:to|with|up with|on))? (?:it|that|the|my|our|all|both|those|these|every|each|\d+|two|three|four|five|six|seven|eight|nine|ten)\b`;
/** The end of a clause, on a sentence without its final stop. */
const CLAUSE_END = String.raw`(?=\s*(?:$|[,;:—–]|\s-\s))`;
/**
 * The end of what was done "like we said" (a voice transcript has no comma: "i emailed the dean like we said and she
 * replied").
 */
const AGREED_END = String.raw`(?=\s*(?:$|[,;:—–]|\s-\s)|\s+(?:and|but|so)\b)`;
/**
 * "I said I'd", "we said we were gonna", "i said id" (a transcript without the apostrophe); never "I said I'd rather…",
 * "…I'd never…" or "…I'd like to…", which say what they want, not what they agreed to do.
 */
const SAID_THEY_WOULD = String.raw`(?:i|we) (?:said|told you|promised|agreed) (?:(?:i|we)(?:'d| would| was going to| were going to| was gonna| were gonna| will| had to| should)|id)\b(?! (?:rather|sooner|never|not|prefer|like|love|hate)\b)`;
/**
 * Something "I" or "we" did, in the past tense ("I talked to the five librarians like I said"); not what they wanted,
 * tried or planned ("I wanted it done like I said").
 */
const DID_SOMETHING = String.raw`\b(?:i|we) (?:[\w']+ ){0,2}?(?!(?:wanted|needed|hoped|tried|planned|intended|expected|wished|liked|loved|hated|preferred|seemed|looked)\b)(?:[a-z]{2,}(?<!e)ed|agreed|did|sent|wrote|ran|went|met|spoke|made|got|took|built|put|set|found|gave|held|paid|rang|saw|told|brought|bought|sold|left|began|drew|chose)\b`;
/** Lead-ins before a report that opens its sentence ("So, did the thing we discussed", "Okay update: done"). */
const REPORT_LEAD = String.raw`(?:(?:ok|okay|so|so yeah|yeah so|well|yes|yep|yeah|update|good news|guess what|and|alright|right|anyway|phew|woo+|woohoo|yay|um+|uh+)[,.!: ]+)*`;

/** With no subject, at the start of a sentence: a verb that names the step ("Called the dean, like we agreed."). */
const BARE_STEP = String.raw`^${REPORT_LEAD}(?:(?:${DONE_ADVERBS}) )?(?:${NAMED_STEP_VERBS})\b`;

/** A step done, by what they did with it ("I finished the interviews…", "we booked the room…", "Finished the…"). */
const DID_A_STEP = String.raw`(?:\b(?:i|we)(?: (?:${DONE_ADVERBS}))? (?:${DONE_VERBS}|called|interviewed|met|made|built|tested|surveyed|visited|contacted|texted|messaged|pitched|filed|got|had|set up|sorted|wrapped up|knocked out|handed in)|${BARE_STEP})`;

/** "Like I said", "as we agreed", "as planned", "like you suggested". */
const AS_AGREED = String.raw`(?:(?:like|as) (?:i|we) (?:said|agreed|promised|planned)|(?:like|as) you (?:said|suggested|recommended|told me)|as (?:agreed|planned))`;

/**
 * A report on something the founder said they would do, named as such (evals G12, MX-0003, MX-0011, MX-0031: "So, I
 * did the thing I said I'd do." was answered without naming the commitment): "the thing I said I'd do", "update on
 * what I said I'd do", "I did the thing we talked about", "I did what you suggested", "like I said I would", "like we
 * agreed", "I finished the interviews I said I would", "Did the thing we discussed". Heard in any statement, next to a
 * question of their own too.
 */
const REPORT_NAMED = new RegExp(
  [
    String.raw`\b(?:(?:the|teh|that|this|one) things?|what|everything|the stuff|the task)(?: that)? ${SAID_THEY_WOULD}`,
    String.raw`\b(?:(?:the|teh|that|this|one) things?|what|everything)(?: that)? (?:i|we) (?:promised|committed to)\b`,
    // "I finished the interviews I said I would", "we booked the room we said we'd book": the step, then the promise,
    // in one clause ("We had a call where I said I'd send the deck" tells of a promise, not of a step done).
    String.raw`${DID_A_STEP} (?:(?!(?:where|when|while|and|but|so|because|after|before|then|which|that|if|until|since|as)\b)[\w'-]+ ){1,4}?(?:that )?${SAID_THEY_WOULD}`,
    // "…like I said I would." or "…like I said I'd do", never "like I said I'd rather focus on…".
    String.raw`\b(?:like|as) (?:i|we) (?:said|promised|told you) (?:(?:i|we)(?:'d| would)|id)(?=(?: do| it| that)\b|\s*$|\s*[,;:—–])|\b(?:as promised|like i promised)\b`,
    // "…like I said", "like we agreed", "as planned" with something they did, after it ("I called the dean, like we
    // agreed") or before it ("As we agreed, I called the dean"). "Pricing matters most, like I said" only repeats a
    // point, and "Like we agreed, pricing comes first" only recalls an agreement.
    String.raw`(?:${DID_SOMETHING}|${BARE_STEP})[^;:—–]*?\b${AS_AGREED}${AGREED_END}`,
    String.raw`\b${AS_AGREED}\s*[,;:—–]?\s*${DID_SOMETHING}`,
    // "I said I'd email the dean and I did": the promise, then that it was kept.
    String.raw`\b${SAID_THEY_WOULD}(?: [\w'-]+){0,6}? and (?:i|we) (?:did|have)(?: (?:it|that|too))?(?=\s*(?:$|[,;:—–]))`,
    // "I did what you suggested", or with no subject at the start of the sentence: "Did the thing we discussed."
    String.raw`(?:^${REPORT_LEAD}|\b(?:i|we) )(?:(?:${DONE_ADVERBS}) )?(?:${DONE_VERBS}) (?:what|the thing|that thing|the stuff|everything) (?:you|we|i) (?:said|suggested|told me|recommended|agreed(?: on)?|discussed|planned|talked about|mentioned)\b(?! (?:i|we)(?:'d| would) (?:rather|sooner|never|not|prefer|like|love|hate)\b)`,
    String.raw`\b(?:i|we) (?:took|followed|tried) your (?:advice|suggestion)\b`,
    String.raw`\b(?:i|we) followed through\b|\bmission (?:accomplished|complete(?:d)?)\b|\bdone and dusted\b|\b(?:ticked|checked|crossed) (?:it|that) off\b`,
  ].join('|'),
);

/**
 * What may follow a step done in a clause that is the whole report ("Sent it off last night", "I did it at last").
 */
const REPORT_TAIL = String.raw`(?: (?:off|out|over|in|up|already|finally|now|too|at last|yesterday|today|tonight|last night|this (?:morning|afternoon|evening|week|weekend)|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|like (?:i|we) (?:said|agreed|promised)|as (?:promised|planned|agreed)))*`;

/**
 * A clause that is the whole report ("Done!", "Finally done!", "All done.", "Sent!", "I posted it.", "Finished it last
 * night.", "Got it done.", "I've done the thing.", "Mission complete.", "It went live yesterday.").
 */
const REPORT_CLAUSE = new RegExp(
  String.raw`^${REPORT_LEAD}(?:` +
    [
      String.raw`(?:(?:all|it's|its|that's|it is|that is|finally|just|now|officially|totally) )*(?:done|finished|complete|completed)(?: and (?:dusted|done))?`,
      String.raw`mission (?:accomplished|complete(?:d)?)`,
      String.raw`(?:(?:i|we) )?(?:(?:${DONE_ADVERBS}) )?(?:${DONE_VERBS}) (?:it|that)${REPORT_TAIL}`,
      String.raw`(?:i|we)(?:'ve| have) (?:(?:${DONE_ADVERBS}) )?(?:${DONE_PARTICIPLES}) (?:it|that)${REPORT_TAIL}`,
      String.raw`(?:(?:${DONE_ADVERBS}) )?(?:${BARE_DONE})${REPORT_TAIL}`,
      String.raw`(?:(?:i|we) )?(?:(?:${DONE_ADVERBS}) )?got (?:it|that|it all|everything) done${REPORT_TAIL}`,
      String.raw`(?:(?:i|we)(?:'ve| have)? )?(?:(?:${DONE_ADVERBS}) )?(?:did|done) (?:the|teh) thing`,
      String.raw`(?:it|that)(?:'s| is| went)(?: (?:finally|now|officially))? live${REPORT_TAIL}`,
    ].join('|') +
    ')$',
);

/**
 * A clause that says what is done ("Interviews are done.", "The interviews I promised are done", "All 5 library
 * interviews done like I said"): a report only on a commitment or a step asked for that it names ({@link reportOf}).
 * Never "I'm done", "we're done here", "almost done", "the interviews are not done" or "how much is done".
 */
const DONE_THING = new RegExp(
  String.raw`^${REPORT_LEAD}(?!(?:i|i'm|im|i've|we|we're|we've|you|it|it's|that|that's|this|they|he|she|what|what's|how|which|who|when|where|why|is|are|was|were|almost|nearly|half|not)\b)(?!.*(?:\b(?:not|never|almost|nearly|half|halfway|partly|mostly|no|yet|if|when|once|until|whether)\b|n't\b))(?:[\w'-]+ ){1,4}?(?:(?:is|are|was|were) )?(?:(?:all|finally|now|officially|totally) )*(?:done|finished|complete|completed)(?: all (?:of (?:them|it)|\d+|two|three|four|five|six|seven|eight|nine|ten))?${REPORT_TAIL}$`,
);

/**
 * A step done with "it" or "that" inside a longer sentence ("I posted it on the staff noticeboard yesterday"): weak on
 * its own ("We launched it last month… How do we get more users?" is background to a question of their own), so it
 * counts only on the terms of {@link reportOf}, and only as a report on something the notes or the conversation hold
 * (`deriveConversationState`).
 */
const STEP_DONE = new RegExp(
  [
    String.raw`\b(?:i|we)(?: (?:${DONE_ADVERBS}))? (?:${DONE_VERBS}) (?:it|that)\b`,
    String.raw`\b(?:i|we)(?:'ve| have)(?: (?:${DONE_ADVERBS}))? (?:${DONE_PARTICIPLES}) (?:it|that)\b`,
    String.raw`\b(?:i|we)(?: (?:${DONE_ADVERBS}))? got (?:it|that|it all|everything) done\b`,
    String.raw`\b(?:it|that|(?:the|our|my) [\w-]+(?: [\w-]+)?)(?:(?: finally| just| officially)? went|'s| is)(?: (?:finally|now|officially))? live\b`,
    // With no subject, a verb that names the step and what it was done to: "Sent it to the dean last night.",
    // "Emailed the dean.", "Just finished the last library interview!". ("I met the dean and then I said I would send
    // the plan" tells of a meeting: with a subject, only "it" or "that" is a step reported.)
    String.raw`${BARE_STEP}${STEP_OBJECT}`,
  ].join('|'),
);

/** After a step done, what makes it background ("We shipped it in March", "We did that last year") rather than news. */
const BACKGROUND = new RegExp(
  String.raw`^(?: [\w']+){0,3}? (?:last (?:year|month|spring|summer|fall|autumn|winter|semester|term|quarter|time)|(?:[\w']+ )?(?:years|months|ages|year|month) ago|a while (?:ago|back)|back in|in the past|once before|before${CLAUSE_END}|in (?:january|february|march|april|may|june|july|august|september|october|november|december|\d{4}|(?:the )?(?:spring|summer|fall|autumn|winter))|(?:at|in|for) (?:my|our) (?:last|previous|old|first|other) [\w-]+)\b`,
);

/**
 * Idioms of "<verb> it/that" that report no step done ("I ran it by my cofounder", "I wrote that down", "I did it for
 * the money", "I think I did it wrong").
 */
const NOT_A_STEP =
  /^(?:(?:i|we)(?:'ve| have)? )?(?:[\w']+ )?(?:(?:ran|run) (?:it|that) (?:by|past)|(?:wrote|written) (?:it|that) down|did (?:it|that) (?:for(?! the first time)|on purpose)|[\w']+ (?:it|that) (?:wrong|badly|incorrectly|all wrong|the wrong way))\b/;

/** Pushback on a suggestion, not a report: "I already did that", "we did that already". */
const PUSHBACK = /\balready (?:[\w']+ )?(?:did|done|tried|do) that\b|\b(?:did|done|tried) that already\b/;

/** Words that say how a founder talks, not what they say ("not gonna lie", "tbh", "lowkey"): no negation. */
const FILLERS = /\b(?:not (?:gonna|going to) lie|not to lie|ngl|tbh|to be honest|honestly|lowkey|no cap)\b/g;

/**
 * Before a report's words, in the same clause (at most six words between, none of them a conjunction), what says the
 * step is not done: a negation or a failure ("I didn't really get around to…", "I kept putting off…", "I'm behind on
 * …", "I'm not sure we finished it", "I thought I sent it") or what is still to come ("I still need to…", "I'll…").
 */
const NOT_DONE = new RegExp(
  String.raw`(?:\b(?:didn't|did not|didnt|don't|do not|dont|doesn't|does not|haven't|have not|havent|hasn't|has not|hadn't|had not|never|not|no|couldn't|could not|can't|cannot|cant|wasn't|was not|weren't|were not|won't|wouldn't|failed|fail|forgot|forget|forgetting|putting off|put off|putting it off|procrastinat\w*|bailed on|bail on|behind on|skipped|missed|gave up on|give up on|ran out of time|yet to|tried to|meant to|wanted to|attempted to|almost|nearly|wish|wished|thought|assumed|started|starting|began|need to|needs to|have to|has to|gotta|going to|gonna|want to|wanna|(?<=\b(?:i|we|i'm|im|we're|still|also|now|really|just|do|did|i'd|we'd)\s)plan to|planning to|about to|trying to|try to|hope to|hoping to|will|should|shall|must|might)|'ll)\s+(?:(?!(?:but|and|so|then|yet|though|although|because|now)\s)[\w']+\s+){0,6}$`,
);

/**
 * Just before a report's words (at most three words between), a condition ("when we've finished it") or a question
 * about the notes ("remind me what I said I'd do").
 */
const CONDITIONAL =
  /\b(?:if|when|once|after|until|before|whether|unless|remind me|remember|recall|forgot|forget)\s+(?:[\w']+\s+){0,3}$/;

/** Whether the words before a report's (in its sentence) say it is not done, or not yet, or only if. */
function notDone(before: string): boolean {
  const words = before.replace(FILLERS, ' ').replace(/\s+/g, ' ').trimStart();
  return NOT_DONE.test(words) || CONDITIONAL.test(words);
}

/**
 * After a report's words, what takes it back: "…but I didn't." (the verb left out, so it is the same step: "but I
 * haven't heard back" is how it went), "Not really.", "jk", "or so I thought", each a clause of its own ("Not really
 * sure it's any good" or "Not exactly how I wanted it" is how it went).
 */
const RETRACTED = new RegExp(
  [
    String.raw`\b(?:but|though|except|only|actually)[,]? (?:i|we) (?:(?:really|actually|still) )?(?:didn't|did not|didnt|haven't|have not|havent|hadn't|had not|never did|never|couldn't|could not|wasn't|was not|weren't|were not|forgot(?: to)?)(?: (?:really|actually|yet|in the end|after all|though|it|that))*\s*(?:$|[.!,;…])`,
    String.raw`(?:^|[.!?;,…]\s*)(?:(?:well|ok|okay|haha|lol|ha|hmm)[,.!]?\s+)*(?:not really|not quite|not exactly|nope|jk|j/k|just kidding|kidding|or so i thought|not yet|lol no)(?: (?:tho|though|lol|haha|honestly))?(?=\s*(?:$|[.!?;,…]))`,
  ].join('|'),
);

/**
 * What says the founder walked away from it or lost it ("I'm quitting the startup", "I gave up, like I said I would",
 * "We lost the client, as I said we would", "I told my parents I am dropping out"): no commitment kept. Said before a
 * report's words, it is what they did "like I said"; said next to a report that names nothing ("Done. I'm quitting the
 * startup.", "I finally did it. I quit."), it is what the report is about. Time lost on the way ("Done! Lost a day to
 * the printer but it's up.") is no setback.
 */
const SETBACK =
  /\b(?:quit|quitting|resign(?:ed|ing)?|gave up|give up|giving up|drop(?:ping|ped)? out|walk(?:ed|ing)? away|shut(?:ting)? (?:it |us |the [\w-]+ )?down|pull(?:ed|ing)? the plug|bailed|lost (?:the|a|an|our|my|it|them|him|her|that|this|everything)(?! (?:whole |full |few |couple of )?(?:days?|weeks?|hours?|nights?|morning|afternoon|evening|weekend|bit|time|sleep)\b)|losing (?:the|a|an|our|my)|got (?:fired|kicked out))\b/;

/** Most content words a message may hold besides a step done in it ({@link STEP_DONE}) and still be a report. */
const REPORT_EXTRA_WORDS = 5;

/** A report on something the founder said they would do, as {@link reportOf} reads it. */
export interface ReportCue {
  /**
   * `named`: the commitment named as such ("the thing I said I'd do", "like we agreed"); `clause`: a clause that is the
   * whole report ("Done!", "I posted it."); `step`: a step done inside a longer sentence ("I posted it on the staff
   * noticeboard yesterday"), a report only when the notes or the conversation hold that step.
   */
  readonly strength: 'named' | 'clause' | 'step';
  /**
   * What the report says was done ({@link reportWords}: what it was done to or with, and the kind of step: "posted",
   * "the interviews"); empty for one that says nothing of it ("Done!", "I did the thing I said I'd do"), which any
   * commitment may be.
   */
  readonly says: ReadonlySet<string>;
  /**
   * A report only when the step the last reply asked for, or a commitment of the notes, is about what it says
   * ({@link reportFit}): a step done inside a longer sentence ("I posted it on the staff noticeboard"), a clause that
   * says what is done ("Interviews are done."), or a report that says nothing of what was done next to words that say
   * what it was ("Done! Interviewed all five library staff."). Otherwise those words are news or a setback of their
   * own, never a commitment kept: "We did it! We got into the accelerator!!", "It's done, the deal fell through.",
   * "Did it! First prize at the hackathon", "I did it again, I overspent on ads".
   */
  readonly mustFit: boolean;
  /**
   * What {@link says} holds is what the rest of a report named as such says ("Mission accomplished, the counter's on
   * the door."): the commitments it fits come first, and with none, any commitment may be it.
   */
  readonly hint?: boolean;
}

interface ReportInSentence extends ReportCue {
  /** Where the report's own words (what it says of itself) start, in the sentence. */
  readonly from: number;
  /** Where the report's words end, in the sentence. */
  readonly end: number;
  /** Where its clause ends (its words and what they say of the step), in the sentence. */
  readonly to: number;
  /** A setback ({@link SETBACK}) in the sentence before the report's words. */
  readonly setbackBefore: boolean;
}

const CLAUSE_SEPARATOR = /\s*(?:[,;:]|—|–|\s-\s)\s*/;

/** Emoji and pictographs ("Done! 🎉", "All five interviews done ✅"): they say nothing a cue reads. */
const PICTOGRAPHS = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;

/**
 * What a report in `sentence` says was done: its words up to `end`, and on to the end of their clause (`to`: "I posted
 * it on the staff noticeboard"), not how it went ("I did it and it was a disaster").
 */
function saysOf(sentence: string, end: number): { readonly says: Set<string>; readonly to: number } {
  const rest = /^.*?(?=\s+(?:and|but|so|though|yet|because|which)\b|\s*(?:[,;:—–]|\s-\s)|$)/.exec(
    sentence.slice(end),
  );
  const to = end + (rest?.[0].length ?? 0);
  return { says: reportWords(sentence.slice(0, to)), to };
}

/** A question of their own after a clause break ("…, but how do I turn them into a pricing decision?"). */
const QUESTION_AFTER =
  /,\s*(?:but|and|so)\s+(?=(?:how|what|why|when|where|who|which|should|could|would|can|do|does|is|are|will)\b)/;

/** The report named as such in `sentence` ({@link REPORT_NAMED}), or null. */
function namedIn(sentence: string): ReportInSentence | null {
  const named = REPORT_NAMED.exec(sentence);
  if (named === null || notDone(sentence.slice(0, named.index))) return null;
  const end = named.index + named[0].length;
  return {
    strength: 'named',
    ...saysOf(sentence, end),
    mustFit: false,
    from: 0,
    end,
    setbackBefore: SETBACK.test(sentence.slice(0, named.index)),
  };
}

/** The report in one sentence of a normalised message (`asks`: the message asks something), or null. */
function reportIn(raw: string, text: string, asks: boolean): ReportInSentence | null {
  const sentence = raw.replace(/[.!…]+$/, '').trim();
  if (sentence === '' || PUSHBACK.test(sentence)) return null;
  if (sentence.endsWith('?')) {
    // "I did the interviews I said I would, but how do I turn them into a pricing decision?": a report named as such,
    // then a question of their own. Any other sentence that ends in a question asks it.
    const cut = QUESTION_AFTER.exec(sentence);
    return cut === null || QUESTION_START.test(sentence) ? null : namedIn(sentence.slice(0, cut.index));
  }
  const named = namedIn(sentence);
  if (named !== null) return named;
  let from = 0;
  for (const clause of sentence.split(CLAUSE_SEPARATOR)) {
    const at = sentence.indexOf(clause, from);
    from = at + clause.length;
    const whole = REPORT_CLAUSE.test(clause.trim()) && !(asks && /\bthat\b/.test(clause));
    if (!whole && !DONE_THING.test(clause.trim())) continue;
    const says = reportWords(clause);
    // "Interviews are done." says what: a report on the interviews, if a commitment is about them.
    const what = [...says].some((w) => !isStepKind(w));
    if (!whole && !what) continue;
    return {
      strength: 'clause',
      says,
      mustFit: what,
      from: at,
      end: at + clause.length,
      to: at + clause.length,
      setbackBefore: SETBACK.test(sentence.slice(0, at)),
    };
  }
  if (asks) return null;
  const step = STEP_DONE.exec(sentence);
  if (step === null || notDone(sentence.slice(0, step.index))) return null;
  if (
    NOT_A_STEP.test(sentence.slice(step.index)) ||
    BACKGROUND.test(sentence.slice(step.index + step[0].length))
  ) {
    return null;
  }
  const cue = contentWords(step[0]);
  if ([...contentWords(text)].filter((w) => !cue.has(w)).length > REPORT_EXTRA_WORDS) return null;
  const end = step.index + step[0].length;
  return {
    strength: 'step',
    ...saysOf(sentence, end),
    mustFit: true,
    from: 0,
    end,
    setbackBefore: SETBACK.test(sentence.slice(0, step.index)),
  };
}

/**
 * The start of a clause that says how it went, of the step or of someone ("it was a disaster", "she said no", "but
 * it's up", "nobody replied"), not what was done.
 */
const HOW_IT_WENT =
  /^(?:(?:and|but|so|then|though|honestly|well|ok|okay|lol|haha|omg)[,]?\s+)*(?:it|it's|its|that|that's|thats|this|she|she's|shes|he|he's|hes|they|they're|theyre|everyone|everybody|nobody|no one|someone|somebody)\b/;

/** What the words of a message besides its report say was done (not how it went: {@link HOW_IT_WENT}). */
function toldWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const clause of text.split(
    /[.!?…]+\s*|\s*(?:[,;:]|—|–|\s-\s)\s*|\s+(?=(?:and|but|so|though|because)\s)/,
  )) {
    if (HOW_IT_WENT.test(clause.trim())) continue;
    for (const w of reportWords(clause)) out.add(w);
  }
  return out;
}

/**
 * Whether `text` reports on something the founder said they would do, and how ({@link ReportCue}): a statement, never
 * a question, a negation ("I didn't do the thing I said I'd do", "I thought I sent it but I didn't"), a condition
 * ("when we've finished it"), pushback ("I already did that") or a setback ("I gave up, like I said I would", "Done.
 * I'm quitting the startup."). The commitment named as such counts anywhere ({@link REPORT_NAMED}); a clause that is
 * the whole report counts next to a question too ("I posted it. Can you help me write the follow-up email?"), unless
 * it says "that" ("We did that. What else could we try?" is pushback); a step done inside a longer sentence counts only
 * in a message that asks nothing, is no background ("last month", "in March") or idiom ("ran it by"), and says little
 * else. A report that says nothing of what was done ("I did it", "Done!") takes what the rest of the message says it
 * was ({@link ReportCue.mustFit}).
 */
export function reportOf(text: string): ReportCue | null {
  const t = normalize(text).replace(PICTOGRAPHS, ' ').replace(/\s+/g, ' ').trim();
  const asks = t.includes('?');
  let from = 0;
  for (const raw of t.split(/(?<=[.!?])\s+/)) {
    const at = t.indexOf(raw, from);
    from = at + raw.length;
    const report = reportIn(raw, t, asks);
    if (report === null) continue;
    if (report.setbackBefore || RETRACTED.test(t.slice(at + report.end))) return null;
    if (report.says.size === 0 && SETBACK.test(t)) return null;
    const { strength, says, mustFit } = report;
    if (says.size > 0) return { strength, says, mustFit };
    // "I did it" says nothing of what: the rest of the message may ("I did it — I failed the module."). Said of a
    // commitment named as such ("Mission accomplished, the counter's on the door."), it only says which one.
    const told = toldWords(`${t.slice(0, at + report.from)} . ${t.slice(at + report.to)}`);
    if (told.size === 0) return { strength, says, mustFit };
    return strength === 'named'
      ? { strength, says: told, mustFit, hint: true }
      : { strength, says: told, mustFit: true };
  }
  return null;
}

/**
 * A request for the vEIR's advice or for how to do something (the agenda suite on calls, 9a2a41f: "How do I position
 * myself?" got a question back). "How do I know you're not a bot?" is about the vEIR, not advice.
 */
const ADVICE_REQUEST = new RegExp(
  [
    String.raw`\bhow(?: else)? (?:do|should|can|could|would|might|shall) (?:i|we)\b(?! know (?:if |whether |that )?(?:you|this|it's you)\b)`,
    String.raw`\bhow (?:would|do|should) you (?:approach|handle|tackle|go about|start|pitch|frame|position|price|structure|deal with|answer|respond)\b`,
    String.raw`\bwhat(?:'s| is| would be) (?:the |a )?(?:best|right|smartest|simplest|fastest|easiest|good) way (?:to|of)\b`,
    String.raw`\b(?:any|got any|have any|some|need|want) (?:advice|tips|pointers|suggestions)\b|\bwhat(?:'s| is| would be) your (?:advice|recommendation|suggestion|take)\b`,
    String.raw`\b(?:can|could|would) you (?:advise|recommend)\b|\badvi[sc]e (?:me|us)\b`,
    // The matrix's "Where would you start with <topic>?", "Got it. So what's the very next step?", "What's the move
    // here?", "what would you prioritise this week".
    String.raw`\bwhere would you (?:start|begin)\b|\bwhat(?:'s| is| would be) (?:the |my |our )?(?:very )?next (?:step|move)\b|\bwhat(?:'s| is)? next\s*(?:[?.!]|$)|\bwhat(?:'s| is) the (?:move|play)\b|\bwhat would you prioriti[sz]e\b`,
  ].join('|'),
);

/**
 * Just before an advice cue (at most two words between), what turns it down ("I don't want advice right now, I just
 * need to vent").
 */
const NO_ADVICE = /\b(?:don't|do not|dont|not|no|never|without)\s+(?:[\w']+\s+){0,2}$/;

/**
 * Whether the message asks for the vEIR's advice or how to do something ({@link ADVICE_REQUEST}), in a sentence that
 * does not turn it down.
 */
export function asksForAdvice(text: string): boolean {
  return normalize(text)
    .split(/(?<=[.!?])\s+/)
    .some((sentence) => {
      const match = ADVICE_REQUEST.exec(sentence);
      return match !== null && !NO_ADVICE.test(sentence.slice(0, match.index));
    });
}

const FEELING_DEGREE = String.raw`(?:(?:so|really|very|pretty|quite|super|totally|completely|kind of|kinda|a (?:bit|little)(?: bit)?|honestly|actually|just|getting|more and more|a lot|slightly|incredibly|seriously|also|still|all)\s+)*`;

/**
 * Who feels it: "I feel", "we've been feeling", "I'm feeling", or no one named at the start of a sentence ("Feeling
 * hopeless.", "Exhausted and feeling hopeless."); never someone or something else ("make students feel better", "the
 * price feels low", "students are tired and feeling lost").
 */
const SELF_FEEL = String.raw`(?:(?:(?:^|[.!?;,…]\s*)(?:[\w']+ (?:[\w']+ )?and )?|\b(?:i|we)(?:'ve been|'ve| have been| have| do| did| still| just| really| honestly| actually| genuinely| truly| seriously| definitely| totally| now| already| kind of| kinda| sometimes| often| always| keep| also)* )(?:feel|felt|feeling)|\b(?:i'm|i am|im|we're|we are)(?: (?:just|really|still|also|honestly))? feeling)`;

/** The end of what is said of themselves ("I'm not okay.", "I'm not coping well lately"), not "not ok with the price". */
const SAID_OF_THEMSELVES = String.raw`(?=\s*(?:$|[.!?,;:…—–]|(?:at all|lately|right now|today|these days|this week|anymore|any more|honestly|tbh|to be honest|and|but)\b))`;

/**
 * How the founder says they are ("I'm", "I feel", "we've been feeling"…, or "Feeling…" at the start of a sentence), before
 * how they feel; never someone else ("students feeling lost on the signup page").
 */
const SELF_STATE = String.raw`(?:\b(?:(?:i'm|i am|im|we're|we are|i've been|i have been|we've been)(?: feeling)?|(?:i|we)(?: just| still| really)? (?:feel|felt)|i was|we were|i get|i got|we get|we got|i'm getting|we're getting)|(?:^|[.!?;,…]\s*)feeling)`;

/** How they feel, said of themselves ("I'm devastated", "we were so frustrated"). */
const FELT = [
  'nervous|anxious|worried|scared|afraid|terrified|stressed|stressing(?: out)?|overwhelmed|panicking|panicked|freaking out|freaked out',
  'frustrated|annoyed|irritated|upset|angry|mad|furious|livid|pissed(?: off)?|bitter|jealous',
  'sad|unhappy|miserable|bummed(?: out)?|heartbroken|devastated|crushed|gutted|shattered|hurt|betrayed|lonely|isolated',
  // "Hopeless" is low mood (LOW_MOOD), never "I'm hopeless at maths".
  'disappointed|discouraged|deflated|defeated|demotivated|demoralis(?:ed)|demoraliz(?:ed)|helpless|powerless',
  'embarrassed|humiliated|mortified|ashamed|guilty|insecure|confused|lost|numb',
  'tired|exhausted|drained|worn out|drowning|burn(?:ed|t) out|fed up|sick of|in tears|crying|close to tears|beside myself',
  'excited|hyped|thrilled|stoked|pumped|proud|relieved|grateful',
].join('|');

/**
 * The founder says how they feel, beyond the `stress` move: the matrix's emotion bank (templates.yaml: nervous,
 * "so much going on, I'm kind of drowning", "this is getting really frustrating", "a bit embarrassing to admit",
 * confused, excited, a proud moment, relief) and the feelings a setback brings ("I'm heartbroken, my cofounder left",
 * "I feel like an idiot", "That was so embarrassing", "I'm so tired of this"). The matrix's emotion.acknowledged wants
 * the feeling acknowledged "in the first sentences, before any advice", so help and advice come after a line that does
 * that. A plan judged ("It's pointless to build before the interviews") is no feeling.
 */
const FEELING = new RegExp(
  [
    String.raw`${SELF_STATE}\s+${FEELING_DEGREE}(?:${FELT})\b`,
    // "I'm so down", "I'm feeling low"; not "I'm down to two options", "I'm down for that".
    String.raw`\b(?:i'm|i am|im|we're|we are|i've been|i have been)\s+(?:(?:so|really|very|pretty|quite|kind of|kinda|a (?:bit|little)|super|totally|feeling)\s+)+(?:down|low)${SAID_OF_THEMSELVES}`,
    String.raw`${SELF_FEEL}\s+${FEELING_DEGREE}(?:better|down|low|awful|terrible|horrible|bad|stupid|silly|dumb|useless|small|sick|empty|numb|like (?:(?:such )?an? (?:idiot|fraud|failure|fake|imposter|impostor|joke|loser|mess|wreck)|crap|garbage|giving up|quitting|crying|screaming|(?:i'm|i am|we're|we are) (?:failing|drowning|losing it)|nothing (?:works|matters)))\b`,
    String.raw`\b(?:this|it|that|things|everything|life)(?:'s| is| are| was| were| has been|'s been| have been| feels| feel| felt)\s+${FEELING_DEGREE}(?:frustrating|stressful|overwhelming|exhausting|embarrassing|humiliating|devastating|heartbreaking|crushing|demoralising|demoralizing|confusing|scary|terrifying|nerve-?wracking|discouraging|depressing|disappointing|painful|exciting|rough|awful|horrible|terrible|brutal|a (?:mess|disaster|nightmare|relief)|too much)\b`,
    String.raw`\b(?:i|we) (?:(?:totally|completely|kind of|kinda|just|really) )?(?:freaked out|panicked)\b|\bso much going on\b|\bdrowning\b|\bembarrassing (?:to admit|confession)\b|\bproud moment\b|\bsmall win\b|\bphew\b|\bwhat a relief\b|\byou're not listening\b`,
  ].join('|'),
);

/**
 * Low mood or worse, without a crisis statement ("Everything feels pointless lately", "I'm not coping well", "I'm at
 * rock bottom", "I can't take this anymore", "I haven't eaten in days"): like `stress`, heard first (Conversation
 * craft), never handed advice at once. Said of themselves (a first-person subject, or none at the start of a sentence)
 * or of everything, never of a plan, a product or someone else: "It's pointless to build an app before the
 * interviews", "There's no point charging students", "a depressed market", "Our free tier feels pointless", "The
 * servers are not coping", "We can't eat the cost of the servers", "breaking down the costs", "We're about to give up
 * 10% equity".
 */
const LOW_MOOD = new RegExp(
  [
    String.raw`${SELF_FEEL}\s+${FEELING_DEGREE}(?:pointless|hopeless|meaningless|worthless|useless|down|low|empty|numb|broken|dead inside)\b`,
    String.raw`\b(?:everything|it all|all of (?:this|it)|life|my life|nothing)(?:'s|\s+(?:is|seems|feels|has been|'s been|looks))\s+${FEELING_DEGREE}(?:pointless|hopeless|meaningless|worthless|(?:dark|empty)${SAID_OF_THEMSELVES})\b|\b(?:it|this|that)(?:'s| is) all\s+${FEELING_DEGREE}(?:pointless|hopeless|meaningless)\b|\b(?:everything|it all|my life|my world)(?:'s| is| keeps)? falling apart\b`,
    String.raw`\b(?:i'm|i am|im|i've been|i have been|we're|we are|i was|we were)\s+${FEELING_DEGREE}(?:depressed|(?:hopeless|worthless|useless)(?! (?:at|with)\b)|broken${SAID_OF_THEMSELVES}|(?:in (?:a|such a) )?(?:really |very |pretty )?dark (?:place|space)|at rock bottom|at (?:the )?end of my (?:rope|tether)|(?:not (?:okay|ok|coping(?: (?:well|very well|at all))?|doing (?:well|ok|okay|great|so well|too well))|a (?:mess|wreck)|done with (?:everything|it all|all of (?:this|it)|life))${SAID_OF_THEMSELVES}|falling apart|(?:down|low) about)\b`,
    String.raw`\b(?:what's|what is) the point(?: (?:of|in) (?:any of (?:this|it)|it all|anything|trying|going on|even trying))?\s*(?:[?.!,]|$)|\b(?:i|we) (?:don't|do not|dont|can't|cannot) see (?:the|any) point(?: (?:anymore|any more|(?:of|in) (?:anything|any of (?:this|it)|it all|trying|going on)))?\s*(?:[?.!,]|$)|\bno point (?:in )?(?:(?:trying|going on|in anything)(?: any ?more)?|any ?more)\s*(?:[?.!,;]|$)`,
    // Said of themselves: "I can't take this anymore", "we can't go on like this", "I haven't eaten in days".
    String.raw`(?:\b(?:i|we)(?: (?:just|really|honestly|seriously|literally|simply|genuinely))? |(?:^|[.!?;,…]\s*))(?:can't|cannot|can not|cant) (?:take (?:this|it)(?: any ?more)?|take any ?more|go on(?: like this)?|keep going|cope(?: with (?:this|it|all (?:of )?(?:this|it)|everything))?|do (?:this|it) any ?more|handle (?:this|it)(?: any ?more)?|get out of bed|eat|sleep)${SAID_OF_THEMSELVES}`,
    String.raw`(?:\b(?:i|we)(?: (?:just|really|honestly|literally))? |(?:^|[.!?;,…]\s*))(?:haven't|have not|havent|hadn't|had not) (?:eaten|slept|been (?:eating|sleeping))\b|(?:^|[.!?;,…]\s*)not coping\b`,
    String.raw`\b(?:i|i've|i have|we|we've)(?: (?:just|finally|really))? (?:hit|reached) rock bottom\b|\b(?:i|i'm|i am|im|i keep|i've been|i have been|we're|we are)(?: (?:just|totally|completely|kind of|kinda))? break(?:ing)? down(?=\s*(?:$|[.!?,;…]|(?:in tears|crying|again|all the time|every)\b))`,
    String.raw`\b(?:i|i'm|i am|im|i was|i've|i have|i've been|i have been|i just|we)\s+(?:[\w']+\s+)?(?:having|had) (?:a |another )?(?:breakdown|break down|meltdown)\b(?! (?:of|in|on)\b)|\bpanic attacks?\b`,
    String.raw`\bend of my (?:rope|tether)\b|\bi (?:just |really |kind of |kinda )?(?:want to|wanna) disappear\b|\bi(?:'m| am) going to disappear\b|\bhate my life\b|\bnothing matters(?: (?:any ?more|to me))?\s*(?:[.!?,;…]|$)|\bgive up on everything\b`,
    String.raw`\b(?:(?:i|we) (?:just |really |honestly )?(?:want to|wanna|feel like)|(?:i'm|i am|im|we're|we are) (?:just |really )?(?:ready|about) to) giv(?:e|ing) up(?=\s*(?:$|[.!?,;…]|on (?:this|it|everything|myself|the (?:startup|venture|company|idea|business))\b))`,
  ].join('|'),
);

/**
 * How a founder is, said in words no feeling or low-mood cue holds and that are about them whoever says the sentence:
 * their limit or breaking point, dark thoughts, hating themselves, "what's even the point", nothing they do mattering,
 * their mental health.
 */
const UNWELL = new RegExp(
  [
    String.raw`\b(?:at|reached|hit|hitting|reaching) (?:my|our) (?:limit|breaking point)\b|\bbreaking point\b|\bdark thoughts?\b`,
    String.raw`\bhate (?:myself|ourselves|my life|my self)\b|\bmy mental (?:health|state|wellbeing)\b|\bnothing (?:i|we) (?:[\w']+ ){0,2}matters\b`,
    String.raw`\b(?:what's|whats|what is)(?: even)? the point(?: (?:of|in) (?:any of (?:this|it)|it all|anything|trying|going on|even trying))?\s*(?:[?.!,]|$)`,
  ].join('|'),
);

/**
 * How a founder is, in words that may be about anyone or anything else ("can't stop crying" or "students can't sleep
 * before exams", "our users lost 5kg"): theirs only in a sentence said of themselves ({@link saidOfThemselves}). Not
 * getting out of bed or leaving their room, not sleeping or eating, crying, shaking, panic, drinking, stress, weight
 * lost, not caring about anything, holding it together, feeling a fraud, being alone…
 */
const UNWELL_OF_THEM = new RegExp(
  [
    String.raw`\b(?:can't|cannot|cant|can not|couldn't) get out of bed\b|\b(?:haven't|have not|havent|hasn't|not) (?:left|been out of) (?:my|the|our) (?:room|house|flat|apartment|bed)\b`,
    String.raw`\bholding (?:it|myself|ourselves|things|everything) together\b|\b(?:don't|do not|dont|can't|cant) care (?:about anything|any ?more)\b`,
    String.raw`\b(?:lost|losing|gained) (?:\d+ ?(?:kg|kgs|kilos?|pounds|lbs|stone)|(?:so much |a lot of )?weight)\b|\b(?:feel|feeling|felt) like (?:a |such a |an )?(?:fraud|impostor|imposter)\b|\bimpost[eo]r syndrome\b`,
    String.raw`\b(?:cry(?:ing)?|cried|in tears|sobb(?:ing|ed)|shak(?:ing|y)|trembl(?:ing|e)|panic(?:king|ked|ky)?|freak(?:ing|ed)? out|sleep(?:ing)?|slept|insomnia|eating|ate|eaten|appetite|drink(?:ing)?|drunk|hungover|alcohol|booze)\b`,
    String.raw`\b(?:stress(?:ed|ing)?|overwhelm(?:ed|ing)?|anxious|anxiety|drowning|terrified|struggling|depress(?:ed|ion)|miserable|devastated|heartbroken|gutted|crushed|breaking down|falling apart)\b`,
    String.raw`\b(?:disappear(?:ed|ing)?|alone|lonely|isolated|hate (?:this|it|everything|that)|hating (?:this|it|everything)|ugh+|argh+|fml|exhausted|burn(?:ed|t)? ?out|burning out|numb|empty inside|worthless)\b`,
  ].join('|'),
);

/** A sentence that opens with someone or something else ("The servers are not coping", "We can't eat the cost"). */
const OTHER_SUBJECT =
  /^(?:(?:so|and|but|also|ok|okay|well|plus|anyway|honestly|actually|basically|btw|ngl|tbh|lowkey)[,]?\s+)*(?:the|a|an|our|their|his|her|its|this|that|these|those|we|we're|we've|we'd|we'll|us|they|they're|they've|it|it's|there|there's|everyone|everybody|nobody|someone|everything|nothing|something|students?|users?|customers?|people|patients?)\b/;

/**
 * Whether a sentence is said of the founder themselves: it says "I", "me" or "my", or it opens with no one else and
 * names no one else ("Can't stop crying.", "Lowkey panicking ngl.", "Ugh.").
 */
function saidOfThemselves(sentence: string): boolean {
  if (/\b(?:i|i'm|im|i've|ive|i'd|i'll|me|my|myself|mine)\b/.test(sentence)) return true;
  return (
    !OTHER_SUBJECT.test(sentence) &&
    !/\b(?:we|we're|we've|our|us|they|their|students?|users?|customers?|people|patients?)\b/.test(sentence)
  );
}

/**
 * Whether the message says how the founder is in words the feeling and low-mood cues do not hold ({@link UNWELL},
 * {@link UNWELL_OF_THEM}). The differential audit of fix-c: "I'm at my limit. How do I get through this week?", "can't
 * stop crying. how do i reply to the investor", "Nothing I do matters. How do I even start on the pitch?" were each
 * told to give advice "in your first sentences". No cue bank holds every way to say it, so these words only take the
 * push for advice or help first away (the reply then follows Conversation craft, as before the advice line); they name
 * no feeling.
 */
function saysHowTheyAre(text: string): boolean {
  const t = normalize(text);
  if (UNWELL.test(t)) return true;
  return t
    .split(/(?<=[.!?…])\s+/)
    .some((sentence) => UNWELL_OF_THEM.test(sentence) && saidOfThemselves(sentence));
}

/** Verbs the vEIR asks a step with ("Write your one-line pitch now…"). */
const STEP_VERBS =
  'write|draft|try|send|call|email|text|post|book|list|jot|sketch|ask|pick|record|message|schedule|share|paste|put|make|run|do|spend|find|go|take';

/**
 * In the vEIR's reply, a sentence that asks the founder to do something, now or before they come back ("Write your
 * one-line pitch now and paste it here when you're done.", "Send the bursar the plan today and tell me when it is
 * out."): a "Done." after it most likely reports on that step, not on a commitment of the notes.
 */
const STEP_REQUEST = new RegExp(
  [
    String.raw`\b(?:when|once) you(?:'re| are|'ve| have)? (?:done|finished|through)\b`,
    String.raw`\b(?:let me know|tell me) (?:when|once)\b|\b(?:paste|drop|send) (?:it|that|them) (?:here|over|back|to me)\b`,
    // An imperative for now or a near time, in one clause: "Now write the three questions…", "Send the email today.";
    // not a tip with "now" after a break ("Make the pitch about her, not the app; you have the story now.").
    String.raw`^(?:(?:so|okay|ok|then|right|first|next|and)[,:]? )*(?:(?:now|right now|today|tonight)[,:]? (?:${STEP_VERBS})\b|(?:go ahead and )?(?:${STEP_VERBS})\b[^,;:—–]*\b(?:now|today|tonight|right now|this week|before (?:we|you|our|tomorrow|the end)|by (?:tomorrow|tonight|the end|friday|monday))\b)`,
  ].join('|'),
);

/** The last sentence of `reply` that asks the founder to do something ({@link STEP_REQUEST}), or null. */
function requestedStepOf(reply: string): string | null {
  const sentences = stripLinks(reply)
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s !== '' && !s.endsWith('?'));
  for (const sentence of sentences.reverse()) {
    if (STEP_REQUEST.test(normalize(sentence))) return sentence;
  }
  return null;
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
  const report = reportOf(t);
  if (report !== null) moves.push('reports_done');
  const words = wordCount(t);
  if (words <= 5 && SHORT_REPLY.test(t) && !moves.includes('thanks')) moves.push('short_reply');
  // "Did the thing we discussed." starts like a question, and without a question mark it is a report; one that is a
  // report only if a commitment is about it ("Did it! First prize at the hackathon") stays as it was read before.
  const startsAsking =
    QUESTION_START.test(t) && words > 2 && !(report !== null && !report.mustFit && !t.includes('?'));
  if (t.endsWith('?') || startsAsking) moves.push('question');
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

// What a report says was done ---------------------------------------------------------------------------------

/**
 * Words of a report that say nothing of what was done ("Finally done!", "mission complete", "like we agreed", "after a
 * long week", "big news").
 */
const GENERIC_REPORT_WORDS = contentWords(
  'done finished finish complete completed finally officially literally totally agreed promised committed planned ' +
    'suggested discussed mentioned recommended followed advice suggestion update news guess mission accomplished ' +
    'dusted ticked checked crossed nailed task tonight night morning afternoon evening weekend monday tuesday ' +
    'wednesday thursday friday saturday sunday woo woohoo yay phew alright teh frfr lol haha omg long everything ' +
    'big huge exciting ive weve youve theyve went gone step',
);

/**
 * Verbs of one kind of step: as a report says it was done (its past forms: "sent", "talked") and as a commitment or a
 * step asked for says it (any form). A report and a commitment whose verbs are of two kinds are about two steps ("I
 * posted it on the staff noticeboard" is no "Interview five library staff"; "I asked my professor…" is no "Book the
 * advisor session").
 */
const STEP_KINDS: readonly (readonly [done: string, asked: string])[] = [
  ['sent emailed mailed messaged texted forwarded', 'send email mail message text forward'],
  ['posted published shared uploaded', 'post publish share upload'],
  ['launched shipped released live', 'launch ship release live'],
  [
    'called phoned rang spoke talked met interviewed chatted visited',
    'call phone ring speak talk meet interview chat visit',
  ],
  ['booked scheduled arranged', 'book schedule arrange'],
  ['wrote written drafted', 'write draft'],
  ['submitted applied', 'submit apply'],
  ['built prototyped', 'build prototype'],
  ['installed', 'install'],
  ['asked', 'ask'],
];
/** A past form, as the founder says it (never "on my phone", "the email"), to its kind. */
const DONE_KIND: ReadonlyMap<string, string> = new Map(
  STEP_KINDS.flatMap(([done], i) => done.split(' ').map((w): [string, string] => [w, `#${i}`])),
);
/** Any form of the verb, stemmed, to its kind. */
const ANY_KIND: ReadonlyMap<string, string> = new Map(
  STEP_KINDS.flatMap(([done, asked], i) =>
    `${done} ${asked}`.split(' ').map((w): [string, string] => [stem(w), `#${i}`]),
  ),
);

function isStepKind(word: string): boolean {
  return word.startsWith('#');
}

function wordsOf(text: string): string[] {
  return [
    ...normalize(text)
      .replace(FILLERS, ' ')
      .matchAll(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu),
  ].map((m) => m[0].replace(/'s$/, '').replace(/'/g, ''));
}

/**
 * What a report says was done: the kind of step of a verb said done ({@link DONE_KIND}: "sent" is "#0") and the content
 * words of what it was done to or with ("the dean", "all five"), without the words any report says
 * ({@link GENERIC_REPORT_WORDS}) or how the founder talks ("ngl", "tbh", "lowkey", "no cap": {@link FILLERS}).
 */
function reportWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of wordsOf(text)) {
    const kind = DONE_KIND.get(word);
    if (kind !== undefined) out.add(kind);
    else for (const w of contentWords(word)) if (!GENERIC_REPORT_WORDS.has(w)) out.add(w);
  }
  return out;
}

/** What a commitment or a step asked for is: its content words, and the kind of each verb in it. */
function stepWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of wordsOf(text)) {
    const kind = ANY_KIND.get(stem(word));
    if (kind !== undefined) out.add(kind);
    for (const w of contentWords(word)) if (!GENERIC_REPORT_WORDS.has(w)) out.add(w);
  }
  return out;
}

/**
 * Whether a commitment (or a step asked for) is what a report says was done ({@link ReportCue.says}), and how closely:
 * 0 when it is about something else. What the report says it was done to or with has to be in it ("I sent it to my
 * mum" is no "Email the dean the pilot plan", whatever the verb), and a verb said done has to be of the commitment's
 * kind when the commitment's verb has one ("I posted it on the staff noticeboard" is no "Interview five library
 * staff"); a report that says only its verb meets a commitment of the same kind ("Sent!" and "Email the dean").
 */
export function reportFit(says: ReadonlySet<string>, commitment: string): number {
  const of = stepWords(commitment);
  const kinds = [...says].filter(isStepKind);
  const objects = [...says].filter((w) => !isStepKind(w));
  const sameKind = kinds.some((k) => of.has(k));
  if (kinds.length > 0 && !sameKind && [...of].some(isStepKind)) return 0;
  if (objects.length === 0) return sameKind ? 1 : 0;
  const met = objects.filter((w) => of.has(w)).length;
  return met === 0 ? 0 : met + (sameKind ? 1 : 0);
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

/** A question asking whether they did something ("Have you checked what the library already offers?"). */
const DID_YOU =
  /^(?:(?:so|and|but|also|ok|okay|quick question|one thing)[,:]? )*(?:have|has|had|did) (?:you|u)\b/;

/**
 * What a report on something the founder said they would do is about, or null when it is no such report after all:
 * - "Yeah I did that." after the vEIR asked "Have you checked what the campus library already offers?" answers that
 *   question (a report that names the commitment as such, "I did the thing I said I'd do", is still one);
 * - a report that says what it was ("We launched it last week, 20 signups so far", "We did it! We got into the
 *   accelerator!!", {@link ReportCue.mustFit}) that no step asked for and no commitment of the notes is about is news,
 *   not a report.
 * The step the last reply asked for is named when the report could be it; the notes' commitments when it could be one
 * of them (those it says something of first, see `buildMessages`), next to a step asked for only when the commitment
 * is named as such ("the thing I said I'd do" may be one of the notes, where a "Done." answers the step).
 */
function readReport(
  report: ReportCue,
  lastReply: string,
  commitments: readonly string[],
): { readonly commitments: string[]; readonly step: string | null } | null {
  if (report.strength !== 'named' && endsWithQuestion(lastReply)) {
    const question = lastQuestionOf(lastReply);
    if (question !== null && DID_YOU.test(normalize(question))) return null;
  }
  const open = commitments.map((c) => c.replace(/\s+/g, ' ').trim()).filter((c) => c !== '');
  const asked = requestedStepOf(lastReply);
  // What the rest of a report named as such says picks the commitment or step it fits; fitting none, it says nothing.
  const says =
    report.hint === true && ![asked ?? '', ...open].some((c) => c !== '' && reportFit(report.says, c) > 0)
      ? new Set<string>()
      : report.says;
  // "Sent!" is about something sent; "Done!" may be about anything.
  const fits = (text: string): boolean => says.size === 0 || reportFit(says, text) > 0;
  const noted = open.filter(fits).slice(0, MAX_REPORTED);
  // The step asked for, unless a commitment is more plainly what the report says ("Well, I did it. Five interviews. My
  // brain is fried but I have notes." after "Send the bursar a one-paragraph note today" is the interviews).
  const closest = Math.max(0, ...noted.map((c) => reportFit(says, c)));
  const step =
    asked !== null && fits(asked) && (says.size === 0 || reportFit(says, asked) >= closest) ? asked : null;
  if (report.mustFit && says.size > 0 && step === null && noted.length === 0) return null;
  return { step, commitments: step === null || report.strength === 'named' ? noted : [] };
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
     * The open commitments of the vEIR's notes a report on one would most likely mean, likeliest first (see
     * `buildMessages`): named in the state only when the new message reports on something they said they would do.
     */
    readonly commitments?: readonly string[];
    /**
     * Who the vEIR is (its persona and the EIR it is built from), so a sincere "Is this really Corin?" is heard as a
     * question about it. Default: the default persona's name alone.
     */
    readonly identity?: IdentityCheckOptions;
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
  const lastReply = afterOpener ? opener : (turns.at(-1)?.answer ?? '');
  const lastAsked = lastQuestionOf(lastReply);
  // A sincere "are you a bot?" is answered by the identity rules, and what the risk check flags (an instruction to
  // change the rules, another venture) is declined: neither is advice to give in the first sentences. The check here
  // is the text's own, without the tenant's venture names, so it says nothing about who is on the platform.
  const identity = options.identity ?? { personaName: DEFAULT_PERSONA_NAME };
  const asksWhoYouAre = asksAboutIdentity(founderText, identity);
  const risk = classifyRisk(founderText);
  const declined = risk.injection || risk.crossVentureRequest;
  // Help, a pick or a number they ask for is theirs unless every sentence that asks it is itself declined or about
  // what the vEIR is ("Help me out here, am I talking to a bot?"): "Sorry, ignore the previous message, I meant the
  // dean. Can you help me write to the dean?" or "Are you a bot? Either way can you help me with my pitch?" still asks
  // for the help (the differential audit of fix-c; the evals' CO-011).
  const sentences = founderText.split(/(?<=[.!?…])\s+/).filter((s) => s.trim() !== '');
  const aside = (sentence: string): boolean => {
    const flagged = classifyRisk(sentence);
    return flagged.injection || flagged.crossVentureRequest || asksAboutIdentity(sentence, identity);
  };
  const onlyAside = (cue: (sentence: string) => boolean): boolean => {
    const asking = sentences.filter((s) => cue(normalize(s)));
    return asking.length > 0 && asking.every(aside);
  };
  const report = reportOf(founderText);
  const reading = report === null ? null : readReport(report, lastReply, options.commitments ?? []);
  const moves = founderMoves(founderText).filter(
    (m) => !(m === 'help' && onlyAside(asksForHelp)) && !(m === 'reports_done' && reading === null),
  );

  const prev: Thread | null = previous;
  const open = parked.filter((p) => p !== current).slice(0, MAX_PARKED);
  const said = [...turns.map((t) => t.answer ?? ''), opener].join('\n').replace(/[‘’ʼ]/g, "'").toLowerCase();
  const usedPhrases = OVERUSED_PHRASES.filter((phrase) => said.includes(phrase));
  const normalised = normalize(founderText);
  const low = moves.includes('stress') || LOW_MOOD.test(normalised);
  const unwell = saysHowTheyAre(founderText);
  // Help has its own line; someone stressed or low is heard first (Conversation craft), never handed a plan at once,
  // and nor is someone who says how they are in words the cues do not hold.
  const asksAdvice =
    !moves.includes('help') && !low && !unwell && !asksWhoYouAre && !declined && asksForAdvice(founderText);
  return {
    moves,
    social: socialTurnOf(founderText),
    directChoice: directChoiceOf(founderText) && !onlyAside((s) => CHOICE.test(s)),
    asksForNumber: asksForNumber(founderText) && !onlyAside((s) => NUMBER_REQUEST.test(s)),
    asksAdvice,
    asksWhoYouAre,
    declined,
    feeling: low || FEELING.test(normalised),
    unwell,
    asksToo: moves.includes('help') || asksAdvice || normalised.includes('?'),
    reportedCommitments: reading?.commitments ?? [],
    requestedStep: reading?.step ?? null,
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
  reports_done: 'reports on something they said they would do',
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
  'reports_done',
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
  const reports = state.moves.includes('reports_done');
  if (state.moves.includes('news')) {
    lines.push(
      // News that reports what they said they would do is about that commitment: naming it is no steering back.
      ...(reports
        ? ['- They bring news: react to it and ask about it first, in your own words.']
        : [
            '- They bring news: react to it and ask about it first, in your own words. In this reply never steer back to an',
            '  earlier question, plan or parked thread.',
          ]),
    );
  }
  // Evals G12 (MX-0003, MX-0011, MX-0031): "I did the thing I said I'd do" got "what surprised you from those commuter
  // insights?" and "Tell me the story of the last time…", never which commitment. With a request or question of their
  // own ("I posted it. Can you help me write the follow-up email?"), that comes first and the commitment is named in
  // passing: "ask how it went" would put a question before the help.
  const reportLines: string[] = [];
  if (reports) {
    reportLines.push(
      ...(state.asksToo === true
        ? [
            '- They also report on something they said they would do: name which it is in passing, in a few words of your own',
            '  (a step agreed in this conversation, else one from your notes). What they ask comes first, and no question about',
            '  how it went in this reply.',
          ]
        : [
            // "I sent it to 50 people and nobody replied" already says how it went.
            '- They report on something they said they would do: say which it is, specifically (what, and where or with whom),',
            '  in a sentence of your own (a step agreed in this conversation, else one from your notes), then take up what they',
            '  say of how it went, or ask how it went or what they learned if they say nothing of it. Never a reply that would',
            '  fit any founder.',
          ]),
    );
    const [likeliest, other] = (state.reportedCommitments ?? []).map((c) =>
      quoted(truncate(c, COMMITMENT_CHARS)),
    );
    // A "Done." right after the vEIR asked for a step answers that step, whatever the notes hold; "the thing I said I'd
    // do" may be the step or a commitment of the notes.
    const requested = state.requestedStep ?? null;
    if (requested !== null && likeliest !== undefined) {
      reportLines.push(
        `- It is the step your last reply asked them to do, ${quoted(truncate(requested, COMMITMENT_CHARS))}, or from your notes most likely ${likeliest}; if you cannot tell which, ask in one short question.`,
      );
    } else if (requested !== null) {
      reportLines.push(
        `- Your last reply asked them to do something, so it is most likely that: ${quoted(truncate(requested, COMMITMENT_CHARS))}.`,
      );
    } else if (likeliest === undefined) {
      reportLines.push(
        '- If neither this conversation nor your notes say what it was, ask what it was in one short question.',
      );
    } else if (other === undefined) {
      reportLines.push(
        `- Unless it is a step agreed in this conversation, from your notes it is most likely: ${likeliest}.`,
      );
    } else {
      reportLines.push(
        `- Unless it is a step agreed in this conversation, from your notes it is most likely ${likeliest}, else ${other}; if you cannot tell which, ask in one short question.`,
      );
    }
  }
  if (state.asksToo !== true) lines.push(...reportLines);
  // A feeling they name is acknowledged first (the matrix's emotion.acknowledged: "in the first sentences, before any
  // advice"), then the help or advice.
  const feeling = state.feeling === true;
  if (state.moves.includes('help')) {
    // The agenda suite on calls (9a2a41f): a pitch to prepare got "tell me the one thing you want the judges to walk away
    // believing…": the help comes first, a check after it. Next to what the turn declines or the identity rules answer,
    // the help line is as it was before (the differential audit of fix-c).
    const aside = state.declined === true || state.asksWhoYouAre === true;
    lines.push(
      '- They want you to do it, or they are stuck: do the work in this reply. Give the thing itself, specific to their',
      ...(feeling && !aside
        ? [
            '  venture (a draft, concrete options or questions, an example, the first steps), after a line that acknowledges how',
            '  they feel, then at most a short check that it fits. Never hand the question back or ask them for what they just said they cannot give.',
          ]
        : state.unwell === true || aside
          ? [
              // Said how they are in words no cue holds ("I don't care about anything anymore. What should I do with the
              // pilot?"), or next to what the turn declines or the identity rules answer ("Are you a bot? Either way can
              // you help me with my pitch?"): the help asked for, with no push into the first sentences.
              '  venture (a draft, concrete options or questions, an example, the first steps), then at most a short check that',
              '  it fits. Never hand the question back or ask them for what they just said they cannot give.',
            ]
          : [
              '  venture (a draft, concrete options or questions, an example, the first steps), in your first sentences, then',
              '  at most a short check that it fits. Never hand the question back or ask them for what they just said they cannot give.',
            ]),
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
  if (state.asksAdvice === true) {
    lines.push(
      ...(feeling
        ? [
            '- They ask for your advice and say how they feel: first acknowledge the feeling in a line of your own, then give the',
            '  advice (a concrete suggestion, a line they could use, two or three points or a first step), then at most one short',
            '  question about it; never a question in place of the advice.',
          ]
        : [
            '- They ask for your advice: give it in your first sentences (a concrete suggestion, a line they could use, two or',
            '  three points or a first step), then at most one short question about it; never a question in its place.',
          ]),
    );
  }
  if (state.asksToo === true) lines.push(...reportLines);
  const asks = state.moves.includes('help') || state.moves.includes('question');
  // Asked what the vEIR remembers, to go back, or told what they did of what they said they would: the notes serve it.
  const aboutNotes = state.moves.some((m) => m === 'recall' || m === 'resume' || m === 'reports_done');
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
