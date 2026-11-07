import { contentWords } from '../prompts/conversation-state.js';

/**
 * Notes about the founder are how they like to work, never a verdict on them, and the threads they keep are what to help
 * with, never pressure. Shared by the distillation's sanitizer (neither is written) and the turn's notes and "Where you
 * left off" (what the model stored before is never shown to the model as it was; what a person wrote is shown as they
 * wrote it).
 */

/**
 * A note that judges the founder instead of saying how they like to work (production, 2026-11-07: after a call in which
 * the founder had no answer to the same question twice, the notebook gained a note that they fail to report what experts
 * told them and stay vague when pressed, and the next turns read it as who they are): a deficit word, a failure in the
 * coaching exchange itself (reporting, preparing, following up, giving specifics), or "even when pressed". A boundary or
 * a preference the founder stated is none of them ("Does not want to share revenue figures yet", "Won't commit to dates
 * until the board meets": {@link STATED_BOUNDARY}).
 */
const DEFICIT = String.raw`\b(?:vague(?:ly)?|evasive(?:ly)?|deflects?|deflecting|unprepared|disorgani[sz]ed|careless(?:ly)?|lazy|defensive(?:ly)?|superficial(?:ly)?|sloppy|unfocused|unreliable|uncooperative|dismissive(?:ly)?|stubborn(?:ly)?|scattered|clueless|naive(?:ly)?|unrealistic(?:ally)?|non-?specific|lacks? (?:clarity|focus|depth|rigou?r|follow-through|preparation|understanding|initiative|specifics|detail))\b`;
const JUDGMENTAL = new RegExp(
  [
    DEFICIT,
    String.raw`\b(?:fails? to|failed to|unable to|struggles? (?:to|with)|refuses? to|neglects? to|tends? to (?:avoid|dodge|deflect|summari[sz]e|generali[sz]e|gloss))\b`,
    String.raw`\b(?:does ?n[o']t|did ?n[o']t|has ?n[o']t|have ?n[o']t|never|rarely|seldom|can'?t|cannot|won'?t)\s+(?:\w+\s+){0,2}?(?:extract|report|follow(?:s|ed)? (?:up|through)|prepare[ds]?|retain|recall|articulate|specify|engage|listen|take notes|give (?:specifics|details|concrete)|do (?:the|their|his|her) homework)\b`,
    String.raw`\bneeds? (?:repeated |constant |a lot of |much |frequent )?(?:prompting|pushing|chasing|reminding|reminders)\b`,
    String.raw`\b(?:even when (?:pressed|asked|prompted|pushed|challenged)|when pressed|despite (?:committing|promising|agreeing|saying)|without (?:specifics|details|concrete (?:details|answers)))\b`,
  ].join('|'),
  'i',
);

/** A boundary or preference the founder stated: what they want, prefer or will do once something happens. */
const STATED_BOUNDARY = /\b(?:wants?|wanted|prefers?|preferred|would rather|likes?|until|yet|for now)\b/i;

/** Within a stated boundary, only a deficit word is a verdict ("Vague until pressed"). */
const DEFICIT_WORD = new RegExp(DEFICIT, 'i');

/**
 * Whether a founder-profile note judges the founder ({@link JUDGMENTAL}): the model's is never written, nor shown to the
 * model.
 */
export function isJudgmentalNote(text: string): boolean {
  const t = text.replace(/[‘’ʼ]/g, "'");
  return STATED_BOUNDARY.test(t) ? DEFICIT_WORD.test(t) : JUDGMENTAL.test(t);
}

/**
 * Pressure framing a thread ("…, which cannot wait", "(urgent)", "blocks the go-to-market strategy", "is a blocker for
 * launch"), said of the thread itself: a fact that only uses such a word ("Critical care units are a second market",
 * "Overdue invoices are a cash risk", "starts immediately after clearance", "can't wait to launch") is none.
 */
const PRESSURE_SOURCE = [
  String.raw`\b(?:cannot|can'?t) wait\b(?! (?:to|for)\b)`,
  String.raw`\b(?:is|are|remains?|becomes?|feels?|it's) (?:now |very |extremely |most |the most )?urgent(?:ly)?\b`,
  String.raw`(?:,\s*)?\burgently\b(?=[.!?)]|$)|\(urgent\)|\burgent:|\btime-sensitive:`,
  String.raw`\bmust be (?:resolved|settled|answered|done) (?:now|first)\b`,
  String.raw`\b(?:needs?|has) to be (?:resolved|settled|answered) (?:now|first|immediately)\b`,
  String.raw`\bblock(?:s|ing)? (?:everything(?: else)?|all (?:progress|else)|the (?:whole |entire )?(?:go-to-market|launch|plan|strategy|venture|progress)(?: (?:strategy|plan|work))?)`,
  String.raw`\bgates? everything(?: else)?\b`,
  String.raw`\b(?:is|are) (?:a |the )?(?:main |big |key )?blockers? (?:for|to|on) (?:the |a |our |their )?[\w-]+`,
].join('|');
const PRESSURE = new RegExp(PRESSURE_SOURCE, 'i');
/** A pressure phrase with the connective before it ("and cannot wait", "which blocks the launch"). */
const PRESSURE_PHRASE = new RegExp(
  String.raw`(?:,?\s*\b(?:and|which|that|but)\s+)?(?:${PRESSURE_SOURCE})`,
  'gi',
);
/** Words that only point at the threads ("These unknowns", "The open questions"): with the pressure gone, nothing. */
const POINTERS = new Set([
  'open',
  'question',
  'unknown',
  'issu',
  'issue',
  'thread',
  'item',
  'point',
  'topic',
  'matter',
]);

function plain(text: string): string {
  return text.replace(/[‘’ʼ]/g, "'");
}

function tidy(sentence: string): string {
  return sentence
    .replace(/\(\s*\)/g, '')
    .replace(/\s+([.!?…])/gu, '$1')
    .replace(/\s+(?:and|or|but|which|that)([.!?…]?)$/iu, '$1')
    .replace(/[\s,;:—–-]+([.!?…]?)$/u, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * `text` without the pressure that frames it ({@link PRESSURE}): the threads a notebook keeps are what to help with,
 * never an agenda to push (production, 2026-11-07: the digest wrote the open unknowns as blocking the go-to-market plan
 * and unable to wait, and the call came back to them every turn). Clauses that are pressure go (cut at commas,
 * semicolons, dashes and brackets); a sentence that is pressure all through keeps what it says besides the phrase,
 * and goes only when that is nothing but a pointer at the threads ("These unknowns cannot wait."). Model-written text
 * only: what a person wrote is shown as they wrote it.
 */
export function withoutPressure(text: string): string {
  if (!PRESSURE.test(plain(text))) return text;
  const kept = text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.trim() !== '')
    .map((sentence) => {
      if (!PRESSURE.test(plain(sentence))) return sentence;
      const parts = sentence.split(/(?=[,;(—–])|(?<=[)])|\s(?=-\s)|\s(?=and (?:which|that|it|they)\b)/u);
      const clean = tidy(parts.filter((part) => !PRESSURE.test(plain(part))).join(''));
      if (/[\p{L}\p{N}]/u.test(clean.replace(/^[\s,;:—–(-]+/u, ''))) return clean;
      const rest = tidy(plain(sentence).replace(PRESSURE_PHRASE, '')).replace(/^[\s,;:—–-]+/u, '');
      if (![...contentWords(rest)].some((word) => !POINTERS.has(word))) return '';
      return /^\p{Lu}/u.test(sentence.trim()) ? `${rest.charAt(0).toUpperCase()}${rest.slice(1)}` : rest;
    })
    .filter((sentence) => /[\p{L}\p{N}]/u.test(sentence))
    .map((sentence) => (/[.!?…]$/u.test(sentence) ? sentence : `${sentence}.`));
  return kept.join(' ');
}
