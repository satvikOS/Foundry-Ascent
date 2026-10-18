import { CoachMode } from '@foundry/contracts';

/**
 * Meta-narration: the model thinking aloud about its prompt instead of talking to the founder. Production
 * (LAB-M1, run 39081466804, a voice call) spoke every unit of three replies like this, paraphrased: "Okay, let's
 * see. The founder says … First, I need to figure out the mode. The venture is in the discovery stage…" and
 * "…this is a social turn. According to the rules…". Nothing caught it.
 *
 * A sentence is narration when it shows one of these cues ({@link metaNarrationCue}):
 * - `founder_third_person`: the founder reported on in the third person ("The founder says…", "the user is asking
 *   me…", "the founder's message is a greeting");
 * - `planning`: the reply being planned ("I need to figure out the mode", "my reply should…", "I'll respond
 *   warmly", "let me think about how to respond");
 * - `rules`: the prompt itself ("according to the rules", "the system prompt", "my instructions");
 * - `mode`: the coaching mode as a decision ("figure out the mode", "the mode is coach", "in the teach mode");
 * - `classification`: the founder's message classified ("this is a social turn", "since this is a greeting");
 * - `internal_names`: prompt block and response field names (`<evidence>`, `founder_message`, `next_actions`,
 *   "E2 says").
 *
 * Calibrated against real answers (the mock model's lines, the evals fixtures, the identity cases) and natural
 * phrases that look close but are human: "Let me think about that with you", "Let's see what the numbers say",
 * "Investors back the founder, not the deck", "I want to check I've understood", "survival mode". A thinking-aloud
 * opener ("Okay, let's see.", "Let me think.") is only narration when narration follows it
 * ({@link isThinkingAloudOpener}).
 *
 * Callers: the sentence gate (per unit, typed and spoken: before the first unit the reply is written whole
 * instead; later the reply ends before the unit) and `validateCoachResponse` (the answer and the spoken reply are
 * cut before the first narrated sentence, or held back when nothing of the reply comes before it).
 */

export type MetaNarrationCue =
  'founder_third_person' | 'planning' | 'rules' | 'mode' | 'classification' | 'internal_names';

const MODES = CoachMode.options.join('|');

/** Discourse markers a thinking-aloud sentence opens with ("Okay, so, first, …"). */
const LEAD = String.raw`^(?:(?:okay|ok|alright|all right|so|now|well|hmm+|um+|uh+|right|first(?:ly)?|second(?:ly)?|next|then|finally|basically|here|anyway|also|and|but)\b[,.!:;\s—–-]*)*`;

/** A reporting verb about what the founder did in this conversation. */
const REPORTING =
  'says|said|just said|is saying|asks|asked|just asked|is asking|wants|wanted|would like|mentioned|mentions|told|tells|stated|states|greeted|thanked|replied|responded|shared|provided|wrote|typed|is venting|vented|is joking|joked|seems to want';
const STATES =
  'stressed|frustrated|anxious|nervous|happy|excited|upset|confused|unsure|worried|overwhelmed|curious|busy|tired|annoyed|sarcastic|joking|venting|greeting|asking|looking for|wanting|trying to|in a hurry|short on time';

const CUES: readonly (readonly [MetaNarrationCue, RegExp])[] = [
  [
    'founder_third_person',
    new RegExp(
      [
        `${LEAD}(?:the|this|our) (?:founder|user)(?:'s)? (?:${REPORTING})\\b`,
        `${LEAD}(?:the|this) (?:founder|user) (?:is|seems|sounds|appears|feels) (?:(?:very|quite|a bit|a little|really|pretty|clearly|probably|likely|just) )?(?:${STATES})\\b`,
        String.raw`\b(?:the|this) (?:founder|user)(?:'s)? (?:just said|just asked|is asking (?:me|about|for|if|whether)|asked me|told me|wants me to|wants to know|is wondering|greeted me|thanked me|mentioned (?:that|earlier|before)|(?:last|latest|new|current|first) (?:message|question|line|turn)|(?:message|question|request|reply|greeting|turn|tone) (?:is|was|seems|sounds))\b`,
      ].join('|'),
    ),
  ],
  [
    'planning',
    new RegExp(
      [
        // "First, I need to figure out the mode." / "I have to decide which response fits."
        String.raw`${LEAD}i (?:need|have|should|must|want|ought|will need|am going|'m going|'ll need) to (?:figure out|determine|decide(?: on)?|work out|identify|classify|choose|pick|select|analy[sz]e)\b(?:.{0,40}?)\b(?:mode|response|reply|answer|tone|intent|move|category|rule|rules|what (?:the founder|the user|they) (?:wants?|means?|is asking)|how (?:to|i should|best to) (?:respond|reply|answer))\b`,
        String.raw`${LEAD}i (?:need|have|should|must|want|ought|will need|am going|'m going|'ll) to (?:respond|reply|craft|draft|compose|write (?:a|the|my) (?:reply|response|answer)|keep (?:the|my) (?:reply|response|answer)|make sure (?:the|my) (?:reply|response|answer)|follow the (?:rules|instructions)|stick to the (?:rules|instructions))\b`,
        String.raw`${LEAD}(?:i'll|i will|i should|i'd|i can|let me|i'm going to|i am going to|i want to) (?:respond|reply)\b`,
        String.raw`\bmy (?:response|reply|answer) (?:should|must|will|needs to|has to|could|can|would)\b`,
        String.raw`\bthe (?:response|reply) (?:should|must|needs to|has to)\b`,
        String.raw`\b(?:keep|make) (?:the|my) (?:reply|response|answer) (?:short|brief|concise|warm|natural|friendly|simple|under)\b`,
        String.raw`\bhow (?:i should|should i|do i|best to|i'll|i will|i'd) (?:respond|reply)(?: (?:here|to (?:this|that|it|them|the founder|the user|their (?:message|question|greeting))))?\s*(?:[.?:,;]|$)`,
        String.raw`\blet me (?:think about|figure out|work out|decide|consider) (?:how to (?:respond|reply|answer)|what to (?:say|reply|respond)|the (?:mode|response|reply|best response|right response))\b`,
        String.raw`\b(?:let me|let's|i'll|i will) think (?:this )?(?:through )?step by step\b`,
      ].join('|'),
    ),
  ],
  [
    'rules',
    new RegExp(
      [
        String.raw`\b(?:according to|per|following|as per|based on|under|by) (?:the|my) (?:rules|instructions|system prompt|system message|prompt|doctrine|conversation craft)\b(?!\s+(?:of|for|in|on|at|from|to)\b)`,
        String.raw`\b(?:the|my) (?:system prompt|system message|instructions (?:say|tell|state|require)|rules (?:say|tell|state|require|are clear)|prompt (?:says|tells)|doctrine (?:says|tells))\b`,
        String.raw`\bmy (?:instructions|system prompt|prompt|doctrine)\b`,
        String.raw`\b(?:the )?(?:conversation craft|non-negotiables|"how you talk"|"where you left off")(?: section| rules)?\b`,
      ].join('|'),
    ),
  ],
  [
    'mode',
    new RegExp(
      [
        String.raw`\b(?:figure out|determine|decide(?: on)?|choose|pick|select|identify|classify) (?:the |which |what |a )?(?:right |best |correct |appropriate |coaching )?mode\b`,
        String.raw`\b(?:the|which|what) (?:right |best |correct |appropriate )?mode (?:is|should|would|fits|to use|applies|here|for this)\b`,
        `\\b(?:in|use|using|answer in|respond in|reply in|switch to|go with|stay in|the) (?:the )?["']?(?:${MODES})["']? mode\\b`,
        `\\bmode\\s*(?:is|should be|would be|will be|=|:)\\s*["']?(?:${MODES})\\b`,
        String.raw`\bauto mode\b`,
      ].join('|'),
    ),
  ],
  [
    'classification',
    new RegExp(
      [
        String.raw`\b(?:this|that|it)(?:'s| is| was| seems like| looks like) (?:a |an |just a |just an |mainly a |more of a |purely a |only a )?(?:social|greeting|closing|wrap-up|thank-you|thanks|identity|recall|venting|small[- ]talk|banter|pushback|repair|meta|off-topic) (?:turn|message|move|question|request)\b`,
        String.raw`\b(?:social|greeting|closing|recall|identity) turn\b`,
        String.raw`\bfounder (?:move|turn)\b`,
        String.raw`\b(?:since|because|as) (?:this|it|that)(?:'s| is) (?:a |an |just a |just an |only a )?(?:greeting|social turn|wrap-up|thank-you|closing|recall question|identity question|social message)\b`,
      ].join('|'),
    ),
  ],
  [
    'internal_names',
    new RegExp(
      [
        String.raw`\b(?:founder_message|your_notes|where_you_left_off|conversation_state|annotation_request|venture_context|session_transcript|previous_notebook|next_actions|memory_candidates|follow_up_questions|evidence_ids|requested_role|coachresponse|coachannotations|submit_response)\b`,
        String.raw`<\/?(?:evidence|item|founder_message|your_notes)\b`,
        String.raw`\bthe (?:<)?evidence(?:>)? (?:block|section|items|tag)\b`,
        String.raw`\b(?:evidence|item|source) e\d+\b`,
        String.raw`(?<!\[)\be\d+ (?:says|shows|states|mentions|notes|indicates|is about|confirms|suggests)\b`,
        String.raw`"(?:answer|spoken|mode|claims|next_actions)"\s*:`,
      ].join('|'),
    ),
  ],
];

/** A whole sentence that only opens thinking aloud: narration only when narration follows it. */
const THINKING_ALOUD = new RegExp(
  `${LEAD}(?:let's see|let me see|let me think|let me think about (?:this|that|it)|let me figure (?:this|it) out|hmm+|okay|ok|alright|got it|thinking)[\\s.…!,:—–-]*$`,
);

function normalize(text: string): string {
  return (
    text
      .normalize('NFKC')
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[“”]/g, '"')
      // Emphasis markers, but not the underscores inside a field name ("founder_message").
      .replace(/[*`~]+|(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, '')
      .replace(/^[\s>#]*(?:[-+•]|\d{1,3}[.)])?\s*/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
  );
}

/** The strongest sign that `sentence` (one sentence or a short unit) narrates the prompt; null when it is speech. */
export function metaNarrationCue(sentence: string): MetaNarrationCue | null {
  const text = normalize(sentence);
  if (text === '') return null;
  for (const [cue, pattern] of CUES) if (pattern.test(text)) return cue;
  return null;
}

/** Whether `sentence` is only a thinking-aloud opener ("Okay, let's see.", "Let me think.", "Hmm."). */
export function isThinkingAloudOpener(sentence: string): boolean {
  const text = normalize(sentence);
  return text !== '' && THINKING_ALOUD.test(text);
}

/** One sentence of a text: its offsets (the whitespace after it excluded). */
export interface SentenceSpan {
  readonly start: number;
  readonly end: number;
}

const SENTENCE_END = '.!?…';
const CLOSERS = '"\'”’)]*_';

/** The sentences of `text`: cut after sentence punctuation (and closing quotes) followed by space, and at line ends. */
export function sentenceSpans(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  const push = (from: number, to: number): void => {
    let a = from;
    let b = to;
    while (a < b && /\s/.test(text.charAt(a))) a += 1;
    while (b > a && /\s/.test(text.charAt(b - 1))) b -= 1;
    if (b > a) spans.push({ start: a, end: b });
  };
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === '\n') {
      push(start, i);
      start = i + 1;
      continue;
    }
    if (!SENTENCE_END.includes(ch)) continue;
    let j = i + 1;
    while (j < text.length && SENTENCE_END.includes(text.charAt(j))) j += 1;
    while (j < text.length && CLOSERS.includes(text.charAt(j))) j += 1;
    if (j >= text.length || /\s/.test(text.charAt(j))) {
      push(start, j);
      start = j;
    }
    i = j - 1;
  }
  push(start, text.length);
  return spans;
}

/** The first narrated sentence of `text`, with the thinking-aloud openers right before it, or null. */
export function findMetaNarration(
  text: string,
): { readonly cue: MetaNarrationCue; readonly start: number; readonly sentence: number } | null {
  const spans = sentenceSpans(text);
  for (let i = 0; i < spans.length; i += 1) {
    const span = spans[i];
    if (span === undefined) continue;
    const cue = metaNarrationCue(text.slice(span.start, span.end));
    if (cue === null) continue;
    let first = i;
    while (first > 0) {
      const before = spans[first - 1];
      if (before === undefined || !isThinkingAloudOpener(text.slice(before.start, before.end))) break;
      first -= 1;
    }
    return { cue, start: spans[first]?.start ?? span.start, sentence: first };
  }
  return null;
}

export interface MetaNarrationCut {
  /** The text before the narration (trimmed), or '' when the narration opens it. */
  readonly text: string;
  /** The cue found, or null when the text is speech (then `text` is unchanged). */
  readonly cue: MetaNarrationCue | null;
  /** Where the narration began: `opening` (nothing of the reply comes before it) or `later`. */
  readonly at: 'opening' | 'later' | null;
}

/**
 * `text` up to its first narrated sentence (see the module comment): everything from that sentence on is the model
 * thinking, not talking, so it is cut whole (the sentences after a cue are usually more of the same, worded like
 * speech: "The venture is in the discovery stage."). `at: 'opening'` when nothing of the reply comes before it.
 */
export function cutMetaNarration(text: string): MetaNarrationCut {
  const found = findMetaNarration(text);
  if (found === null) return { text, cue: null, at: null };
  const kept = text.slice(0, found.start).trimEnd();
  const substantive = /\p{L}/u.test(kept.replace(/^[\s>#*_\-+•\d.)]+/gm, ''));
  return substantive
    ? { text: kept, cue: found.cue, at: 'later' }
    : { text: '', cue: found.cue, at: 'opening' };
}
