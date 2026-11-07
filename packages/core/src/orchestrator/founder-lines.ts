import { classifyRisk, contentTokens, founderMoves } from '@foundry/ai';

/**
 * Which of the founder's lines say something worth carrying into the next conversation (LAB-R3): never a greeting, a
 * check of the line, a recall or memory question, small talk or a question about the vEIR itself, thanks or a wrap-up.
 * Read only for the "Where you left off" section of the turn prompt (continuity-prompt.ts `keyFounderLines`: what the
 * founder told, in their own words, as untrusted data for the model); never for what an opener says (production
 * 2026-11-06: "hows your perosnal life going on.." became "Hi, want to carry on with your perosnal life?").
 */

/**
 * Words that open, check or fill a conversation without naming anything to talk about: greetings, "can you hear
 * me", acknowledgements, and the bare frame of a request ("I have a quick question").
 */
const FILLER = new Set(
  (
    'hi hello hey hiya howdy yo hullo greetings morning afternoon evening good day night test testing tested ' +
    'hear me can you there are ok okay sure yes yeah yep yup no nope nah thanks thank cheers please sorry um ' +
    'uh umm hmm right great cool fine well again back just quick question something talk chat call start let ' +
    'what how about anything want would like need help got minute moment am doing do going today now here ' +
    'news big huge exciting update updates guess'
  ).split(' '),
);

/** Words that name something to talk about (content words that are not {@link FILLER}). */
function topicWords(text: string): string[] {
  return [...contentTokens(text)].filter((w) => !FILLER.has(w));
}

/** Adverbs and discourse words that say how, when or how sure, never what: no topic word on their own. */
const DISCOURSE_WORDS = new Set(
  (
    'instead too also anyway anyways though then again either yet already now later first really maybe probably ' +
    'perhaps just actually basically honestly still even definitely obviously literally seriously totally ' +
    'eventually finally certainly hopefully personally'
  ).split(' '),
);
/** Discourse words that say when or in what order: what a plan is about when its verb has nothing else ("hire later"). */
const TIMING = new Set(['now', 'later', 'first', 'again', 'already', 'yet']);

/** Recall and memory questions the conversation-state cues do not cover ("What did I tell you in our chat…?"). */
const RECALL =
  /\b(?:remember|recall|remind me|last time|(?:we|you and i) (?:talked|spoke|discussed|chatted|covered)|did i (?:tell|say|mention|ask)|i (?:told|asked|said to|mentioned to) you|what did (?:i|we) (?:say|tell|talk|discuss|decide|agree|ask)|(?:in|from|during) our (?:last |previous |earlier |first )?(?:chat|call|conversation|session|talk)|you (?:said|told me|mentioned)|(?:forgot|forget)\b)/i;
/**
 * Questions about the vEIR itself, not the venture ("Is this a real person?", "Do you even have a life?"), and small talk
 * asked of it ("hows your perosnal life going on..", "how are you?": production 2026-11-06).
 */
const ABOUT_THE_VEIR =
  /\b(?:are you (?:really |actually )?(?:a |an |the )?(?:(?:real|actual|live|genuine) )?(?:bot|robot|human|real|ai|person|machine|man|woman|really)|is (?:this|it|that) (?:really |actually )?(?:a |an )?(?:(?:real|actual|live|genuine) )?(?:bot|human|ai|person|robot|machine)\b|is this (?:really |actually )?(?:you|real|[A-Z][a-z]+\b(?=\s*\?))|am i (?:talking|speaking|chatting) (?:to|with)|who (?:am i talking to|are you|is this)|what are you|your name|do you (?:even )?(?:have a life|sleep|eat|feel|dream)|you(?:'re| are) (?:a bot|an ai|not real|a robot|human)|how(?:'?s| is| are| was)? (?:your|ur) (?:[\p{L}']+ )?(?:life|day|week|weekend|morning|evening|family|health|holiday|vacation)|how (?:are|r) (?:you|u)\b|how(?:'?s| is) it going\b)/iu;
/** Checks of the line itself. */
const META = /\b(?:can you hear me|are you there|is this (?:working|on)|mic check|testing|test test)\b/i;

/** Whether a founder line names something worth carrying over (see the module comment). */
export function isTopicLine(text: string): boolean {
  const line = text.replace(/[‘’ʼ]/g, "'").trim();
  if (line === '') return false;
  const moves = founderMoves(line);
  if (moves.some((m) => m === 'recall' || m === 'resume' || m === 'closing' || m === 'short_reply'))
    return false;
  if (RECALL.test(line) || ABOUT_THE_VEIR.test(line) || META.test(line)) return false;
  // What the risk rules read as an attempt on the vEIR's instructions, or a crisis, is never carried over as the
  // founder's own words; the turn's label is the same rules' verdict.
  const risk = classifyRisk(line);
  if (risk.injection || risk.crisis) return false;
  // A discourse word is no topic word ("I really want to quit" names one thing, as "I want to quit" does), but for a
  // timing word ("hire later") or "even" in "break even".
  const breakEven = /\b(?:break|breaks|breaking|broke|broken)\s+even\b/i.test(line);
  return (
    topicWords(line).filter((w) => !DISCOURSE_WORDS.has(w) || TIMING.has(w) || (w === 'even' && breakEven))
      .length >= 2
  );
}
