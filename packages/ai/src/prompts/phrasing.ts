/**
 * The vEIR's phrasing ledger (coaching v3; owner round 3, 2026-11-06: "the vEIR repeats the same question the same way,
 * like a script"). The repeat guard already keeps a question's substance from being asked twice
 * (validators/social.ts `reasksQuestion`); what the founder heard as a script was the same *shape* asked again about
 * new things: live pilot 42124259353's coach opened 395 questions with 45 three-word frames it had already used in the
 * same run ("What's the smallest…", "What's the single…", "How will you…", "What's the one…").
 *
 * - {@link questionFrame} reads a question's form: its first words without a lead-in ("So, what's the smallest step…"
 *   → "what's the smallest"). Short questions ("Who pays?") have no form to vary.
 * - {@link phrasingLedger} counts the forms and the openings of the vEIR's own replies in this conversation and at the
 *   end of its last conversations, and {@link renderPhrasingLedger} says them compactly in `<conversation_state>`, so
 *   the model varies wording and manner while the substance stays consistent.
 * - Lab run 42238272157 (Haiku, long sessions): replies closed on the same line again ("shape the proposal around what
 *   you learn instead of what you assumed" twice, "You're set… go get those answers" three times). The ledger also
 *   names the closing lines of the latest replies and the whole phrases two of them shared, so the model says neither
 *   again; the repeat guard leaves out a sentence that does (validators/social.ts `repeatsPrevious`).
 * - {@link rephraseQuestion} is the generation-time backstop: a question whose form was used recently is said in
 *   another form with the same substance ("Of the steps you could take this week, which is the smallest?"), never
 *   dropped. Only forms with a known, grammatical alternative are rephrased; any other question stands as written.
 */

import { escapeData } from './escape.js';

/** Words read as a question's form. */
const FRAME_WORDS = 3;
/** Most replies of this conversation read for the ledger (newest first). */
const LEDGER_REPLIES = 8;
/** Most replies of the last conversations read for the ledger (newest first). */
const LEDGER_PAST_REPLIES = 12;
/** Most question forms the ledger reports. */
const LEDGER_MAX_QUESTIONS = 4;
/** Most openings the ledger reports. */
const LEDGER_MAX_OPENINGS = 3;
/** Closing lines the ledger reports: the last statement of the latest replies of this conversation. */
const LEDGER_MAX_CLOSINGS = 3;
/** Most phrases said twice the ledger reports. */
const LEDGER_MAX_PHRASES = 3;
/** Words of a closing line the ledger quotes. */
const CLOSING_WORDS = 16;
/** Words in a row two replies share that make a phrase said twice, with at least {@link PHRASE_CONTENT} content words. */
const PHRASE_WORDS = 7;
const PHRASE_CONTENT = 3;
/** Short function words: a phrase of nothing but these is no phrase worth naming. */
const FUNCTION_WORDS = new Set(
  (
    "a an the and or but so to of in on at for with from by as is are was were be been it it's this that these those " +
    "you you're your i i'm we our they their he she his her what what's how who when where which if then than there " +
    'here about into out up down over just also can could would should will do does did have has had not no'
  ).split(' '),
);

/** Discourse words before the question proper ("So,", "And now", "Okay —"). */
const LEAD =
  /^(?:(?:so|and|but|now|then|okay|ok|well|also|first|next|right|alright|quick question|one more thing|last thing)\b[\s,:;—–-]*)+/iu;

/** Markup and quotes a sentence may open with. */
const MARKUP = /^[\s*_"“'‘(]*/u;

function straight(text: string): string {
  return text.normalize('NFKC').replace(/[‘’ʼ]/g, "'");
}

/** Lower-case words of `text` ("what is" read as "what's", so both say the same form). */
function wordsOf(text: string): string[] {
  return straight(text)
    .toLowerCase()
    .replace(/\[e\d+(?:\s*,\s*e\d+)*\]/giu, ' ')
    .replace(/\b(what|who|where|how|that|it) is\b/gu, "$1's")
    .split(/[^\p{L}\p{N}']+/u)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter((w) => w !== '');
}

/** The question without its lead-in and markup, as written. */
function core(question: string): { readonly lead: string; readonly body: string } {
  const markup = MARKUP.exec(question)?.[0] ?? '';
  const rest = question.slice(markup.length);
  const lead = LEAD.exec(rest)?.[0] ?? '';
  return { lead: question.slice(0, markup.length + lead.length), body: rest.slice(lead.length) };
}

/**
 * A question's form: its first {@link FRAME_WORDS} words, lower case, without a lead-in. Null for a question too short
 * to have a form worth varying (fewer than five words), or a line in quotes (a line the founder could say).
 */
export function questionFrame(question: string): string | null {
  const trimmed = question.trim();
  if (/^[*_]*["“]/u.test(trimmed)) return null;
  const words = wordsOf(core(trimmed).body);
  if (words.length < FRAME_WORDS + 2) return null;
  return words.slice(0, FRAME_WORDS).join(' ');
}

/** The sentences of `text` that ask something (end in a question mark), as written. */
function questionSentences(text: string): string[] {
  return straight(text)
    .split(/(?<=[.!?…]["'”’)\]*_]*)\s+|\n+/u)
    .map((s) => s.trim())
    .filter((s) => /\?["'”’)\]*_]*$/u.test(s));
}

/** How a reply opens: its first {@link FRAME_WORDS} words, lower case (null for a reply shorter than that). */
function openingFrame(reply: string): string | null {
  const words = wordsOf(reply.replace(MARKUP, ''));
  return words.length < FRAME_WORDS ? null : words.slice(0, FRAME_WORDS).join(' ');
}

/** The forms of the questions a text asks. */
export function questionFramesOf(text: string): string[] {
  return questionSentences(text)
    .map(questionFrame)
    .filter((f): f is string => f !== null);
}

export interface PhrasingForm {
  /** The form, lower case ("what's the smallest"). */
  readonly form: string;
  /** How often the vEIR used it in the replies read. */
  readonly count: number;
  /** It was used at the end of an earlier conversation. */
  readonly earlier: boolean;
}

export interface PhrasingLedger {
  /** Question forms used twice or more, or in an earlier conversation; most used first. */
  readonly questions: readonly PhrasingForm[];
  /** Openings used twice or more, or in an earlier conversation; most used first. */
  readonly openings: readonly PhrasingForm[];
  /** How the latest replies of this conversation closed: each one's last statement, as written (newest first). */
  readonly closings: readonly string[];
  /** Whole phrases ({@link PHRASE_WORDS} words or more) two replies of this conversation both said, lower case. */
  readonly phrases: readonly string[];
}

function tally(
  current: readonly string[],
  past: readonly string[],
  read: (reply: string) => readonly string[],
  max: number,
): PhrasingForm[] {
  const forms = new Map<string, { count: number; earlier: boolean; order: number }>();
  const add = (reply: string, earlier: boolean): void => {
    for (const form of read(reply)) {
      const entry = forms.get(form) ?? { count: 0, earlier: false, order: forms.size };
      entry.count += 1;
      entry.earlier ||= earlier;
      forms.set(form, entry);
    }
  };
  for (const reply of current) add(reply, false);
  for (const reply of past) add(reply, true);
  return [...forms.entries()]
    .filter(([, e]) => e.count >= 2 || e.earlier)
    .sort((a, b) => b[1].count - a[1].count || a[1].order - b[1].order)
    .slice(0, max)
    .map(([form, e]) => ({ form, count: e.count, earlier: e.earlier }));
}

function texts(replies: readonly (string | null | undefined)[], max: number): string[] {
  return replies.filter((r): r is string => typeof r === 'string' && r.trim() !== '').slice(0, max);
}

/**
 * The ledger of the vEIR's own recent phrasing: `replies` are this conversation's (newest first, its opener included),
 * `past` the end of its last conversations with this founder (newest first). Bounded: the latest
 * {@link LEDGER_REPLIES} and {@link LEDGER_PAST_REPLIES} replies.
 */
export function phrasingLedger(
  replies: readonly (string | null | undefined)[],
  past: readonly (string | null | undefined)[] = [],
): PhrasingLedger {
  const current = texts(replies, LEDGER_REPLIES);
  const earlier = texts(past, LEDGER_PAST_REPLIES);
  return {
    closings: closingLines(current),
    phrases: sharedPhrases(current),
    questions: tally(current, earlier, questionFramesOf, LEDGER_MAX_QUESTIONS),
    openings: tally(
      current,
      earlier,
      (r) => {
        const o = openingFrame(r);
        return o === null ? [] : [o];
      },
      LEDGER_MAX_OPENINGS,
    ),
  };
}

/** Sentences of a reply, as written. */
function sentencesOf(text: string): string[] {
  return straight(text)
    .split(/(?<=[.!?…]["'”’)\]*_]*)\s+|\n+/u)
    .map((s) => s.trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s));
}

/** The last statement of each of the latest replies (a closing question is read as a form instead), clipped. */
function closingLines(replies: readonly string[]): string[] {
  const out: string[] = [];
  for (const reply of replies.slice(0, LEDGER_MAX_CLOSINGS)) {
    const last = sentencesOf(reply).at(-1);
    if (last === undefined || /\?["'”’)\]*_]*$/u.test(last)) continue;
    const words = last.split(/\s+/);
    // A short close ("Fine.", "Good luck!") is no line worth naming.
    if (words.length < 4) continue;
    const line = words.length > CLOSING_WORDS ? `${words.slice(0, CLOSING_WORDS).join(' ')} …` : last;
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

/** Words of a reply read for shared phrases (a pasted wall of text stays bounded). */
const PHRASE_SCAN_WORDS = 400;

/**
 * Whole phrases two replies share: runs of {@link PHRASE_WORDS} words or more with content in them, longest first. Linear
 * in the words read: each reply's {@link PHRASE_WORDS}-word sequences are looked up in the others' sets, and a run is
 * consecutive sequences found in the same reply.
 */
function sharedPhrases(replies: readonly string[]): string[] {
  const lists = replies.map((r) => wordsOf(r).slice(0, PHRASE_SCAN_WORDS));
  const grams = (words: readonly string[]): string[] => {
    const out: string[] = [];
    for (let i = 0; i + PHRASE_WORDS <= words.length; i += 1)
      out.push(words.slice(i, i + PHRASE_WORDS).join(' '));
    return out;
  };
  const sets = lists.map((words) => new Set(grams(words)));
  const found: string[] = [];
  for (let a = 0; a < lists.length; a += 1) {
    const words = lists[a] ?? [];
    const own = grams(words);
    for (let b = a + 1; b < lists.length; b += 1) {
      const other = sets[b] ?? new Set<string>();
      let i = 0;
      while (i < own.length) {
        if (!other.has(own[i] ?? '')) {
          i += 1;
          continue;
        }
        let last = i;
        while (last + 1 < own.length && other.has(own[last + 1] ?? '')) last += 1;
        const run = words.slice(i, last + PHRASE_WORDS);
        if (run.filter((w) => !FUNCTION_WORDS.has(w)).length >= PHRASE_CONTENT) {
          const phrase = run.join(' ');
          if (!found.some((f) => f.includes(phrase))) found.push(phrase);
        }
        i = last + 1;
      }
    }
  }
  return found.sort((x, y) => y.length - x.length).slice(0, LEDGER_MAX_PHRASES);
}

function said(form: PhrasingForm): string {
  const times = form.count >= 2 ? ` ×${form.count}` : '';
  return `"${escapeData(form.form.replace(/"/g, "'"))} …"${times}${form.earlier ? ' (also last time)' : ''}`;
}

/**
 * The ledger as one compact line of `<conversation_state>` ('' when nothing repeats): the shapes the vEIR leaned on, so
 * it keeps the substance and changes the wording and manner. The forms are three words of the vEIR's own, never the
 * founder's.
 */
export function renderPhrasingLedger(ledger: PhrasingLedger): string {
  const quote = (text: string): string => `"${escapeData(text.replace(/"/g, "'"))}"`;
  const parts: string[] = [];
  if (ledger.questions.length > 0) parts.push(`questions shaped ${ledger.questions.map(said).join(', ')}`);
  if (ledger.openings.length > 0) parts.push(`replies opening ${ledger.openings.map(said).join(', ')}`);
  const lines = parts.length === 0 ? [] : [`- Your own phrasing lately: ${parts.join('; ')}.`];
  const already: string[] = [];
  if (ledger.closings.length > 0) already.push(`closing lines ${ledger.closings.map(quote).join(', ')}`);
  if (ledger.phrases.length > 0) already.push(`phrases said twice ${ledger.phrases.map(quote).join(', ')}`);
  if (already.length > 0) {
    lines.push(
      `- Already said in this conversation: ${already.join('; ')}; never say them again, nor a variant.`,
    );
  }
  if (lines.length === 0) return '';
  lines.push(
    '  Keep the substance consistent, but word this reply afresh: another way into a question (or none), another',
    '  opening, another close (or none), the manner of a person talking.',
  );
  return lines.join('\n');
}

// Rephrasing ----------------------------------------------------------------------------------------------------

/** Superlatives a "What's the … X …?" question is built on. */
const SUPERLATIVE =
  'smallest|biggest|largest|first|next|earliest|easiest|quickest|simplest|cheapest|fastest|hardest|toughest|riskiest|costliest|clearest|strongest|weakest|best|main|top|key|most important|single most important';

/** Words that start what follows the noun ("…step you could take", "…risk to the pilot"). */
const REST_START = new Set(
  (
    "you you'd you'll you've you're your that which who whom to for in on of from with we they she he it i this " +
    'these those between if when before after by at about behind holding standing blocking keeping left here there ' +
    'now still anyone right'
  ).split(' '),
);

/** Words never read as the noun of a superlative question. */
const NOT_NOUN = new Set(['one', 'of', 'a', 'an', 'the', 'most', 'more', 'other']);

/** The plural of a noun ("step" → "steps", "company" → "companies", "person" → "people"). */
function pluralOf(noun: string): string {
  const irregular: Readonly<Record<string, string>> = {
    person: 'people',
    criterion: 'criteria',
    child: 'children',
    analysis: 'analyses',
    hypothesis: 'hypotheses',
  };
  const lower = noun.toLowerCase();
  if (irregular[lower] !== undefined) return irregular[lower];
  if (/[^aeiou]y$/u.test(lower)) return `${noun.slice(0, -1)}ies`;
  if (/(?:s|x|z|ch|sh)$/u.test(lower)) return `${noun}es`;
  return `${noun}s`;
}

const SUPERLATIVE_Q = new RegExp(
  String.raw`^what(?:'s| is) the (?:(single|one|very) )?(?:(${SUPERLATIVE}) )?([a-z][a-z-]*)(?: (.+?))?\s*\?$`,
  'iu',
);

/** Alternatives of a superlative question ("What's the smallest step you could take?"), best first. */
function superlativeForms(body: string): string[] {
  const m = SUPERLATIVE_Q.exec(body);
  if (m === null) return [];
  const [, mod, sup, noun = '', restRaw] = m;
  if (mod === undefined && sup === undefined) return [];
  if (NOT_NOUN.has(noun.toLowerCase()) || REST_START.has(noun.toLowerCase())) return [];
  const rest = restRaw?.trim() ?? '';
  // A second question or a clause joined on ("…, and who will own it?") would end up inside the noun phrase.
  if (
    rest.includes(',') ||
    /\b(?:and|or) (?:who|what|when|where|how|which|why|is|are|do|does|did|will|would)\b/iu.test(rest)
  ) {
    return [];
  }
  const restFirst =
    rest
      .split(/\s+/)[0]
      ?.toLowerCase()
      .replace(/[^\p{L}']/gu, '') ?? '';
  if (rest !== '' && !REST_START.has(restFirst)) return [];
  const tail = rest === '' ? '' : ` ${rest}`;
  const nouns = pluralOf(noun);
  const which = (sup ?? (mod === 'one' || mod === 'single' ? 'one' : '')).toLowerCase();
  if (which === '' || which === 'very') return [];
  if (which === 'one') {
    return rest === ''
      ? [`If you had to pick one ${noun}, which would it be?`]
      : [
          `Of the ${nouns}${tail}, which matters most?`,
          `If you had to pick one ${noun}${tail}, which would it be?`,
        ];
  }
  if (which === 'first' || which === 'next') {
    return rest === ''
      ? [`Which ${noun} comes ${which}?`]
      : [`Of the ${nouns}${tail}, which comes ${which}?`];
  }
  const grade = /^(?:main|top|key)$/u.test(which) ? `the ${which} one` : `the ${which}`;
  return rest === ''
    ? [`Which ${noun} is ${grade}?`]
    : [
        `Of the ${nouns}${tail}, which is ${grade}?`,
        `If you had to pick ${grade} ${noun}${tail}, which would it be?`,
      ];
}

/** Families of question forms with the same meaning, each read on the question's body (lead-in and markup apart). */
const FAMILIES: readonly ((body: string) => string[])[] = [
  superlativeForms,
  (b) => {
    const m = /^(what|how|who|when|where) will you (.+?)\s*\?$/iu.exec(b);
    if (m === null) return [];
    const wh = m[1] ?? '';
    const forms = [`${wh} are you going to ${m[2] ?? ''}?`];
    if (!/^how$/iu.test(wh)) forms.push(`${wh} do you plan to ${m[2] ?? ''}?`);
    return forms;
  },
  (b) => {
    const m = /^(what|how|who|when|where) are you going to (.+?)\s*\?$/iu.exec(b);
    return m === null ? [] : [`${m[1] ?? ''} will you ${m[2] ?? ''}?`];
  },
  (b) => {
    const m = /^do you have (.+?)\s*\?$/iu.exec(b);
    return m === null ? [] : [`Have you got ${m[1] ?? ''}?`];
  },
  (b) => {
    const m = /^have you got (.+?)\s*\?$/iu.exec(b);
    return m === null ? [] : [`Do you have ${m[1] ?? ''}?`];
  },
  (b) => {
    const m = /^what would it take (to .+?)\s*\?$/iu.exec(b);
    return m === null ? [] : [`What do you need in place ${m[1] ?? ''}?`];
  },
  (b) => {
    const m = /^what do you need in place (to .+?)\s*\?$/iu.exec(b);
    return m === null ? [] : [`What would it take ${m[1] ?? ''}?`];
  },
  (b) => {
    const m = /^what(?:'s| is) your plan (for|to) (.+?)\s*\?$/iu.exec(b);
    if (m === null) return [];
    return m[1]?.toLowerCase() === 'to'
      ? [`How are you planning to ${m[2] ?? ''}?`]
      : [`How are you planning to handle ${m[2] ?? ''}?`];
  },
  (b) => {
    const m = /^how are you planning to (.+?)\s*\?$/iu.exec(b);
    return m === null ? [] : [`What's your plan to ${m[1] ?? ''}?`];
  },
  (b) => {
    const m = /^what(?:'s| is) your next (?:step|move)( .+?)?\s*\?$/iu.exec(b);
    return m === null ? [] : [`Where do you go from here${m[1] ?? ''}?`];
  },
  (b) => {
    const m = /^would you like to (.+?)\s*\?$/iu.exec(b);
    return m === null ? [] : [`Do you want to ${m[1] ?? ''}?`];
  },
  (b) => {
    const m = /^do you want to (.+?)\s*\?$/iu.exec(b);
    return m === null ? [] : [`Would you like to ${m[1] ?? ''}?`];
  },
  (b) => {
    const m = /^can you (.+?)\s*\?$/iu.exec(b);
    return m === null ? [] : [`Could you ${m[1] ?? ''}?`];
  },
  (b) => {
    const m = /^could you (.+?)\s*\?$/iu.exec(b);
    return m === null ? [] : [`Can you ${m[1] ?? ''}?`];
  },
];

function capitalised(text: string): string {
  return text.replace(/^(\p{Ll})/u, (c) => c.toUpperCase());
}

export interface Rephrased {
  readonly text: string;
  /** The question was said in another form. */
  readonly changed: boolean;
}

/**
 * `question` (one sentence ending in a question mark) in another form with the same substance when its form is in
 * `used` (see the module comment); unchanged when its form was not used, when no alternative is known, or when every
 * alternative's form was used too. A lead-in ("So,") and markup stay; a line in quotes is never touched.
 */
export function rephraseQuestion(question: string, used: ReadonlySet<string>): Rephrased {
  const frame = questionFrame(question);
  if (frame === null || !used.has(frame)) return { text: question, changed: false };
  const trailing = /\s*$/u.exec(question)?.[0] ?? '';
  const trimmed = question.slice(0, question.length - trailing.length);
  const { lead, body } = core(trimmed);
  // Emphasis or quotes closing after the question mark stay where they were.
  const close = /\?(["'”’)\]*_]*)$/u.exec(body)?.[1] ?? '';
  const plain = straight(body.slice(0, body.length - close.length));
  for (const family of FAMILIES) {
    for (const form of family(plain)) {
      const next = questionFrame(form);
      if (next === null || next === frame || used.has(next)) continue;
      const cased =
        lead.trim() === '' || /[*_"“(]$/u.test(lead)
          ? capitalised(form)
          : form.replace(/^(\p{Lu})(?=\p{Ll})/u, (c) => c.toLowerCase());
      // The reply's own apostrophes: a curly one stays curly.
      const said = body.includes('’') ? cased.replace(/'/g, '’') : cased;
      return { text: `${lead}${said}${close}${trailing}`, changed: true };
    }
  }
  return { text: question, changed: false };
}

/**
 * `text` with each question whose form is in `used` said in another form ({@link rephraseQuestion}), and the forms it
 * asks added as it goes (two questions of one reply never share a form either). `rephrased` counts the questions said
 * in another form.
 */
export function withVariedQuestions(
  text: string,
  used: ReadonlySet<string>,
): { readonly text: string; readonly rephrased: number } {
  if (!text.includes('?')) return { text, rephrased: 0 };
  const seen = new Set(used);
  let rephrased = 0;
  const out = text.replace(/[^.!?…\n]*\?["'”’)\]*_]*/gu, (sentence) => {
    const lead = /^\s*/u.exec(sentence)?.[0] ?? '';
    const body = sentence.slice(lead.length);
    const r = rephraseQuestion(body, seen);
    const frame = questionFrame(r.text);
    if (frame !== null) seen.add(frame);
    if (!r.changed) return sentence;
    rephrased += 1;
    return `${lead}${r.text}`;
  });
  return { text: out, rephrased };
}
