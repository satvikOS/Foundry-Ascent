/**
 * Notes about the founder are how they like to work, never a verdict on them. Shared by the distillation's sanitizer
 * (a judging note is never written) and the turn's notes (one already stored is never shown to the model).
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
