/**
 * Notes about the founder are how they like to work, never a verdict on them, and the threads they keep are what to help
 * with, never pressure. Shared by the distillation's sanitizer (neither is written) and the turn's notes and "Where you
 * left off" (what was stored before is never shown to the model as it was).
 */

/**
 * A note that judges the founder instead of saying how they like to work (production, 2026-11-07: after a call in which
 * the founder had no answer to the same question twice, the notebook gained a note that they fail to report what experts
 * told them and stay vague when pressed, and the next turns read it as who they are): a deficit word, a failure to do
 * something, or "even when pressed".
 */
const JUDGMENTAL = new RegExp(
  [
    String.raw`\b(?:vague(?:ly)?|evasive(?:ly)?|deflects?|deflecting|unprepared|disorgani[sz]ed|careless(?:ly)?|lazy|defensive(?:ly)?|superficial(?:ly)?|sloppy|unfocused|unreliable|uncooperative|dismissive(?:ly)?|stubborn(?:ly)?|scattered|clueless|naive(?:ly)?|unrealistic(?:ally)?|lacks? (?:clarity|focus|depth|rigou?r|follow-through|preparation|understanding|initiative))\b`,
    String.raw`\b(?:does ?n[o']t|did ?n[o']t|never|rarely|seldom|fails? to|failed to|unable to|struggles? to|can'?t|cannot|won'?t|refuses? to|avoids?|neglects? to)\s+(?:\w+\s+){0,2}?(?:extract|report|follow (?:up|through)|prepare|answer|engage|share|commit|listen|focus|deliver|retain|recall|remember|explain|articulate|specify|complete|finish|take notes|think (?:through|ahead)|do (?:the|their|his|her) homework|learn)\b`,
    String.raw`\beven when (?:pressed|asked|prompted|pushed|challenged)\b`,
  ].join('|'),
  'i',
);

/** Whether a founder-profile note judges the founder ({@link JUDGMENTAL}): it is never written, nor shown to the model. */
export function isJudgmentalNote(text: string): boolean {
  return JUDGMENTAL.test(text.replace(/[‘’ʼ]/g, "'"));
}

/** A clause that frames a thread as pressure ("…, which cannot wait", "(urgent)", "blocks the go-to-market strategy"). */
const PRESSURE = new RegExp(
  String.raw`\b(?:cannot wait|can'?t wait|urgent(?:ly)?(?! care)|overdue|asap|as soon as possible|right away|immediately|critical(?:ly)?|must be (?:resolved|settled|answered|done) (?:now|first|before)|blocks? (?:everything|all|the (?:whole|entire)? ?(?:go-to-market|launch|plan|strategy|venture|progress))|blocking (?:everything|all progress|the (?:launch|go-to-market|plan|strategy)))\b`,
  'i',
);

/**
 * `text` without the clauses that frame it as pressure ({@link PRESSURE}): the threads a notebook keeps are what to help
 * with, never an agenda to push (production, 2026-11-07: the digest wrote the open unknowns as blocking the
 * go-to-market plan and unable to wait, and the call came back to them every turn). Clauses are cut at commas,
 * semicolons, dashes and brackets; a sentence that is nothing but pressure goes whole. '' when nothing is left.
 */
export function withoutPressure(text: string): string {
  if (!PRESSURE.test(text.replace(/[‘’ʼ]/g, "'"))) return text;
  const kept = text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.trim() !== '')
    .map((sentence) => {
      const parts = sentence.split(/(?=[,;(—–])|(?<=[)])|\s(?=-\s)|\s(?=and (?:which|that|it|they)\b)/u);
      const clean = parts.filter((part) => !PRESSURE.test(part.replace(/[‘’ʼ]/g, "'"))).join('');
      return clean
        .replace(/\(\s*\)/g, '')
        .replace(/\s+([.!?…])/gu, '$1')
        .replace(/[\s,;:—–-]+([.!?…]?)$/u, '$1')
        .trim();
    })
    .filter((sentence) => /[\p{L}\p{N}]/u.test(sentence))
    .map((sentence) => (/[.!?…]$/u.test(sentence) ? sentence : `${sentence}.`));
  return kept.join(' ');
}
