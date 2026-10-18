import { normalizeForMatching } from '../risk/normalize.js';
import { textsContainOtherVenture } from './coach-response.js';
import {
  identifiesHonestly,
  identityQuestionOf,
  identityFindingsAdded,
  identityReplacementFor,
  isStyleFinding,
  rewriteIdentity,
  withoutLeaningConnector,
  type IdentityCheckOptions,
  type IdentityFinding,
  type IdentityQuestion,
  type IdentityViolationKind,
} from './identity.js';
import { sanitizeMarkdown } from './markdown.js';
import { REPEATED_GREETING_FALLBACK, withoutRepeatedGreeting } from './greeting.js';
import { findMetaNarration, isThinkingAloudOpener, type NarrationNames } from './meta-narration.js';
import { REPEAT_FALLBACK, asksToRepeat, fourGramsOf, repeatsPrevious } from './social.js';
import { clampWords, toSpeakable } from './speech.js';

/**
 * Validate-before-show for streamed answers. A model's text arrives in arbitrary chunks; the gate cuts it
 * into sentence units and releases a unit only after it passed the same checks the final validator
 * (`validateCoachResponse`) applies to the whole answer:
 *
 * 1. the Markdown subset (raw HTML, images and unsafe links removed). A unit never ends inside a link or
 *    image (`[label](target)`) or on a reference definition line, and the shown text as a whole is checked
 *    again with each unit: when joining a unit to what was shown would form something the subset removes,
 *    the rest of the answer is withheld from the preview (`turn.completed` brings it);
 * 2. citations: `[E#]` keys that were not shown to the model are removed;
 * 3. identity, per sentence: claims to be human are rewritten like the validator does; claims to be (or
 *    sign as) the EIR block the stream, as they block the turn; a volunteered AI disclaimer ("I'm just an AI")
 *    is rewritten out, never blocking, and never takes the honest answer with it: the first disclaimer sentence
 *    that says what the coach is becomes its honest line unless an earlier unit already said it, and nothing is
 *    rewritten out of the answer to a sincere question about it (`founderText`). Each unit is also read after a
 *    bounded tail
 *    of the one before it (typed, and as heard on a call), so a claim split across units ("This is" then
 *    "Corin.", "Has Corin approved your plan?" then "Yes, she has.") is judged whole: a unit that completes
 *    a blocking claim stops the stream, one that completes another claim is replaced by the disclosure;
 * 4. cross-venture, cumulatively: another venture's name, canary or member name anywhere in the text so far
 *    blocks the stream, read as written and as rendered (a name split by Markdown, "Bench**Tally**", counts).
 *    A unit is held back until enough text follows it (the hold-back window, at least twice the longest
 *    guarded string) that a guarded string starting inside it is complete when checked. On a call the spoken
 *    form of each unit is checked too, after a bounded tail of what was said before it.
 *
 * Before the first unit, a reply that opens like structured output (JSON, a code fence, a field label such
 * as `answer:`) is not prose for the founder: the gate releases nothing and asks for the whole-reply path.
 *
 * 5. meta-narration, per unit (typed and spoken): a unit in which the model thinks aloud about its prompt ("The
 *    founder says…", "I need to figure out the mode", "According to the rules…"; validators/meta-narration.ts) is
 *    never released. Before the first unit the reply is written whole instead (`fallback: 'meta_narration'`); a
 *    reply that opens with a thinking-aloud sentence ("Okay, let's see.") is held until the next unit shows whether
 *    narration follows. After units were released, the reply ends before the unit (`cut`), and nothing more is
 *    released: what follows a narrated sentence is more of the same.
 *
 * A lead-in of at most {@link LEAD_IN_MAX_WORDS} words that ends a sentence ("Got it.", "Talk soon.", "That's the
 * right question.") is released the moment it ends (LAB-P1: the gate held every first sentence 383–526 ms, and 8 of
 * 12 first sentences were such lead-ins). It passes every per-unit check like any unit; it skips only the waits
 * that cannot change its verdict: the opening's 20 characters (a finished sentence is prose, never the start of
 * structured output), the hold-back (a guarded string that starts inside it would have to span its sentence end,
 * so the skip applies only when no guarded string contains sentence punctuation), and, for an acknowledgement
 * ("Got it.", "Okay.") on a typed turn, the look at the next unit (a thinking-aloud opener such as "Let me think."
 * still waits, and on a call so does an acknowledgement that can open thinking aloud: said, it cannot be taken back
 * when narration follows it).
 *
 * The final validation of the whole response stays authoritative: units are a preview the client replaces
 * with `turn.completed`. Units never carry raw model output that failed a check, and their concatenation
 * passes the Markdown subset unchanged.
 */

/** Most words of a lead-in released as soon as its sentence ends (see the module comment). */
export const LEAD_IN_MAX_WORDS = 4;

/** An acknowledgement said to the founder, not a thinking-aloud opener: it never waits for the next unit. */
const ACKNOWLEDGEMENT =
  /^(?:okay|ok|alright|all right|got it|right|sure|understood|of course|fair enough)(?:[\s,]+\p{Lu}[\p{L}'’-]*)?[\s.!…]*$/iu;

export type GateBlockReason = 'cross_venture' | 'identity';

/** Why the stream cannot be shown at all and the reply must be written whole instead. */
export type GateFallbackReason = 'structured_output' | 'meta_narration';

/** Why the reply ends early: what was released stands, and nothing more is. */
export type GateCutReason = 'meta_narration';

export interface SentenceGateOptions {
  /** Persona display name ("Corin's vEIR"). */
  personaName: string;
  /** EIR / staff names the vEIR must never speak as. */
  eirNames?: readonly string[];
  /** Display name of the EIR the persona is built from ("Corin Halvorsen"). */
  personaEirName?: string | null;
  /** Display names of the founder and their team: "Thanks, Ruth." to one of them is not an EIR's sign-off. */
  addressees?: readonly string[];
  /**
   * The first name of the person the reply talks to: a unit that reports on them by name ("Maya's asking about…")
   * is narration (LAB-M1b), like "The founder says…".
   */
  founderName?: string | null;
  /**
   * The conversation's opening line already said hello (a call's intro, `openerSaidHello`) and this is the first
   * reply: a greeting it opens with is left out (validators/greeting.ts), and a reply that was only that greeting
   * becomes a short hand-back.
   */
  greeted?: boolean;
  /**
   * A short reply's budget (a social turn: thanks, a wrap-up, a hello; validators/social.ts `SOCIAL_BUDGETS`): once
   * the units released reach it, nothing more is released and the gate is `full` (the caller stops the model; the
   * reply is what was shown). The first unit is always released.
   */
  replyBudget?: { readonly sentences: number; readonly words: number } | null;
  /**
   * The vEIR's previous reply in this conversation: a unit that mostly says it again is never released (unless the
   * founder asked to hear it again, or sincerely asks who or what the coach is: the honest answer is never dropped).
   * A reply that was nothing but repeats becomes a short line instead.
   */
  previousReply?: string | null;
  /**
   * The founder's message this reply answers. When it sincerely asks who or what the coach is ("are you real?"),
   * the reply's honest answer stands as written: no disclaimer is rewritten out of it.
   */
  founderText?: string;
  /**
   * The reply is said on a call: each unit's spoken form is checked as speech too, where an EIR's name counts
   * in any case and a unit that is only the name ("Corin.", "Best, Corin.") signs off.
   */
  spoken?: boolean;
  otherVentureNames: readonly string[];
  otherVentureCanaries: readonly string[];
  otherVentureMemberNames?: readonly string[];
  /** Evidence keys shown to the model; other `[E#]` citations are removed. Null keeps every citation. */
  evidenceKeys?: ReadonlySet<string> | null;
  /** Identity findings that block (the validator's default: claims to be the EIR). */
  blockOnIdentity?: readonly IdentityViolationKind[];
  /** Longest unit before it is cut at a word boundary. Default 360 characters. */
  maxUnitChars?: number;
  /** Words the spoken forms of all units may use together (calls). Default: unlimited. */
  spokenWordBudget?: number;
}

export interface GateUnit {
  /**
   * Validated text to show, including the whitespace that separates it from the previous unit, so the
   * concatenation of all units reads as the answer. '' once the preview is withheld (the unit is still
   * spoken on a call).
   */
  readonly text: string;
  /** The same unit as plain speakable sentences (no Markdown, links or citations); '' when not spoken. */
  readonly spoken: string;
}

export interface GateResult {
  /** Units released by this call, in order. */
  readonly units: GateUnit[];
  /** Set once the stream must stop; nothing is released after it. */
  readonly blocked: GateBlockReason | null;
  /** Set when the reply is not prose (before any unit): stop the stream and write the reply whole. */
  readonly fallback: GateFallbackReason | null;
  /** Set when the reply ends before the rest of the stream (after units were released): stop the stream. */
  readonly cut: GateCutReason | null;
}

export interface GateStats {
  /** Units shown (`turn.delta`). */
  readonly units: number;
  /** Units that passed every check but were not shown, because the preview was withheld. */
  readonly withheld: number;
  readonly identityRewrites: number;
  readonly citationsRemoved: number;
  readonly markdownRemovals: number;
}

const SENTENCE_END = new Set(['.', '!', '?', '…']);
/** Characters that may close a sentence after its punctuation: quotes, brackets, emphasis markers. */
const CLOSERS = new Set(['"', "'", '”', '’', ')', ']', '*', '_']);
/** Words followed by a full stop that rarely end a sentence. */
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'vs',
  'cf',
  'approx',
  'e.g',
  'i.e',
  'a.m',
  'p.m',
]);
/** A Markdown block line: a list item or a heading. */
const BLOCK_LINE = /^[ \t]{0,3}(?:[-*+•][ \t]|\d{1,3}[.)][ \t]|#{1,6}[ \t])/;
/** Enough characters after a newline to tell whether the next line starts a block. */
const BLOCK_LOOKAHEAD = 5;
/** A reply that opens like structured output instead of prose: JSON, a code fence, a field label. */
const STRUCTURED_OPENING =
  /^(?:```|\{|\[\s*[{[]|<\/?(?:answer|reply|response)\b|[*_]{0,2}"?(?:answer|spoken|reply|response|mode|claims|next_actions)"?[*_]{0,2}\s*:)/i;
/** Characters of a reply's opening needed to tell it from structured output. */
const OPENING_CHARS = 20;
const CITATION = / ?\[\s*(E\d+(?:\s*[,;]\s*E\d+)*)\s*\](?!\()/gi;
const DEFAULT_MAX_UNIT_CHARS = 360;
const MAX_HOLD_BACK = 200;
/**
 * How much already-checked text the cumulative checks read again: a guarded string (at most
 * {@link MAX_HOLD_BACK} characters, spread out) or a Markdown construct formed across units starts within it.
 * Bounding it keeps a long stream of tiny units linear instead of re-reading everything shown per unit.
 */
const CUMULATIVE_WINDOW_CHARS = 4 * MAX_HOLD_BACK;
const MARKDOWN_WINDOW_CHARS = 2_048;
/** How much of the previous unit a unit's identity check reads before it (cut at a word boundary). */
const IDENTITY_TAIL_CHARS = 300;

/** The end of a released unit that the next unit's identity check reads first. */
function identityTail(text: string): string {
  if (text.length <= IDENTITY_TAIL_CHARS) return text;
  const cut = text.slice(-IDENTITY_TAIL_CHARS);
  const space = cut.search(/\s/);
  return space < 0 ? '' : cut.slice(space + 1);
}

/** The gravest finding first (claims to be the EIR, then human, then endorsements). */
const GRAVITY: Readonly<Record<IdentityViolationKind, number>> = {
  claims_eir: 0,
  claims_human: 1,
  endorsement: 2,
  ai_disclaimer: 3,
};

/**
 * Characters a unit is held back for: twice the longest guarded string (spacing and invisible characters
 * can stretch it) plus a margin, or 0 when nothing is guarded.
 */
export function holdBackFor(guarded: readonly string[]): number {
  const longest = guarded.reduce((max, g) => Math.max(max, normalizeForMatching(g).length), 0);
  return longest === 0 ? 0 : Math.min(MAX_HOLD_BACK, 2 * longest + 8);
}

function lineStart(text: string, index: number): number {
  const newline = text.lastIndexOf('\n', index - 1);
  return newline < 0 ? 0 : newline + 1;
}

/** Whether the full stop at `dot` follows an abbreviation, an initial or a list number ("1."). */
function quietFullStop(text: string, from: number, dot: number): boolean {
  let start = dot;
  while (start > from && /[\p{L}\p{N}.]/u.test(text.charAt(start - 1))) start -= 1;
  const token = text.slice(start, dot);
  if (/^\p{Lu}$/u.test(token)) return true; // an initial: "J. Smith"
  if (ABBREVIATIONS.has(token.toLowerCase())) return true;
  if (/^\d{1,3}$/.test(token)) return text.slice(lineStart(text, start), start).trim() === '';
  return false;
}

/**
 * End (exclusive) of the unit that starts at `from` (its leading whitespace included), or null when the
 * text so far does not yet show where it ends. Units end after sentence punctuation followed by
 * whitespace, before a paragraph break, at the end of a list item or heading line, or at a word boundary
 * once they reach `maxChars`. They never end inside a link or image (`[label](target)`, which the Markdown
 * check can only judge whole) or on a reference definition line, and never in the middle of a word.
 */
export function findUnitEnd(text: string, from: number, maxChars: number): number | null {
  let start = from;
  while (start < text.length && /\s/.test(text.charAt(start))) start += 1;
  let lineBegin = lineStart(text, start);
  let labels = 0; // unclosed `[` on this line: a link or image label may follow
  let target = 0; // parenthesis depth inside a `](…)` link or image target
  let labelOpensLine = false; // the outermost open `[` starts the line (a reference definition may follow)
  let definitionLine = false; // this line is a reference definition (`[id]: target "title"`)
  let lastSafeSpace = -1; // last whitespace outside any link, image or definition
  for (let i = start; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === '\n') {
      labels = 0;
      target = 0;
      definitionLine = false;
      lineBegin = i + 1;
      if (i + 1 >= text.length) return null;
      if (text.charAt(i + 1) === '\n') return i;
      if (BLOCK_LINE.test(text.slice(lineStart(text, i), i))) return i;
      const next = text.slice(i + 1, i + 1 + BLOCK_LOOKAHEAD);
      if (BLOCK_LINE.test(next)) return i;
      if (next.length < BLOCK_LOOKAHEAD && !next.includes('\n')) return null;
      lastSafeSpace = i;
      continue;
    }
    if (target > 0) {
      if (ch === '(') target += 1;
      else if (ch === ')') target -= 1;
    } else if (ch === '[') {
      if (labels === 0) labelOpensLine = /^[ \t]{0,3}$/.test(text.slice(lineBegin, i));
      labels += 1;
    } else if (ch === ']' && labels > 0) {
      labels -= 1;
      if (text.charAt(i + 1) === '(') {
        target = 1;
        i += 1;
      } else if (labels === 0 && labelOpensLine && text.charAt(i + 1) === ':') {
        definitionLine = true;
      }
    } else if (labels === 0 && !definitionLine) {
      if (SENTENCE_END.has(ch)) {
        let j = i + 1;
        while (j < text.length && CLOSERS.has(text.charAt(j))) j += 1;
        if (j >= text.length) return null;
        if (/\s/.test(text.charAt(j)) && !(ch === '.' && quietFullStop(text, start, i))) return j;
      }
      if (/\s/.test(ch)) lastSafeSpace = i;
    }
    if (i - start >= maxChars && lastSafeSpace > start) return lastSafeSpace;
  }
  return null;
}

function normalizeKey(raw: string): string {
  return raw.trim().toUpperCase();
}

function words(text: string): number {
  return text.split(/\s+/).filter((w) => w !== '').length;
}

/** Incremental sentence gate for one streamed answer. Feed chunks with `push`, then call `end` once. */
export class SentenceGate {
  readonly #options: SentenceGateOptions;
  readonly #holdBack: number;
  /** No guarded string contains sentence punctuation: a finished lead-in needs no hold-back. */
  readonly #leadInsSafe: boolean;
  readonly #maxUnitChars: number;
  readonly #blockOn: ReadonlySet<IdentityViolationKind>;
  readonly #keys: ReadonlySet<string> | null;
  #raw = '';
  #cursor = 0;
  #shown = '';
  #ended = false;
  #blocked: GateBlockReason | null = null;
  #fallback: GateFallbackReason | null = null;
  #cut: GateCutReason | null = null;
  /** Set once joining a unit to the shown text would form Markdown the subset removes. */
  #withholding = false;
  #spokenWords = 0;
  /** Length of the stable text already checked for other ventures as a whole. */
  #leakCheckedTo = 0;
  /** The end of the last unit released, as shown and as heard: the next unit's identity check reads it first. */
  #tail = '';
  #spokenTail = '';
  /** The end of what was said on the call (spoken forms), read again with each unit for other ventures. */
  #said = '';
  /** The last unit was only a volunteered disclaimer and was dropped: the next one loses a leaning "But". */
  #afterDroppedDisclaimer = false;
  /** A greeting the opening line already gave was left out of the reply's start (`greeted`). */
  #droppedGreeting = false;
  /** The previous reply's four-word sequences (null: no repeat check). */
  readonly #previousGrams: ReadonlySet<string> | null;
  /** Units left out because they said the previous reply again. */
  #repeatsDropped = 0;
  /** Units and words released (the reply budget). */
  #released = { units: 0, words: 0 };
  /** The reply budget is used up: nothing more is released. */
  #full = false;
  /**
   * What the founder's sincere question about the coach asks (`founderText`), or null: then no disclaimer is
   * rewritten out, and the first unit is read as its answer (a bare "Yes!" to "is this really Corin?").
   */
  readonly #question: IdentityQuestion | null;
  /** No unit was read yet: the next one opens the reply. */
  #opening = true;
  /** A released unit said honestly what the coach is: a later disclaimer that says it again is only removed. */
  #identified = false;
  #stats = { units: 0, withheld: 0, identityRewrites: 0, citationsRemoved: 0, markdownRemovals: 0 };

  constructor(options: SentenceGateOptions) {
    this.#options = options;
    const guarded = [
      ...options.otherVentureNames,
      ...options.otherVentureCanaries,
      ...(options.otherVentureMemberNames ?? []),
    ];
    this.#holdBack = holdBackFor(guarded);
    this.#leadInsSafe = !guarded.some((g) => /[.!?…]/.test(g));
    this.#maxUnitChars = Math.max(80, options.maxUnitChars ?? DEFAULT_MAX_UNIT_CHARS);
    this.#blockOn = new Set(options.blockOnIdentity ?? ['claims_eir']);
    this.#keys = options.evidenceKeys ? new Set([...options.evidenceKeys].map(normalizeKey)) : null;
    this.#question =
      options.founderText === undefined ? null : identityQuestionOf(options.founderText, this.#identity);
    const previous = options.previousReply ?? null;
    // No repeat check for a sincere question about the coach: its honest answer is said however recently it was
    // said (the intro of a first meeting, or the last reply when they ask again; the presence policy).
    this.#previousGrams =
      previous === null ||
      previous.trim() === '' ||
      asksToRepeat(options.founderText ?? '') ||
      this.#question !== null
        ? null
        : fourGramsOf(previous);
  }

  /** Everything received so far (unvalidated). */
  get text(): string {
    return this.#raw;
  }

  get blocked(): GateBlockReason | null {
    return this.#blocked;
  }

  get fallback(): GateFallbackReason | null {
    return this.#fallback;
  }

  get cut(): GateCutReason | null {
    return this.#cut;
  }

  /** The reply budget (`replyBudget`) is used up: the reply is what was released. */
  get full(): boolean {
    return this.#full;
  }

  /** Counts for audit metadata (no content). */
  get stats(): GateStats {
    return { ...this.#stats };
  }

  /** Adds a chunk and returns the units it completes. */
  push(chunk: string): GateResult {
    if (this.#ended) throw new Error('SentenceGate.push after end');
    if (this.#stopped()) return this.#nothing();
    this.#raw += chunk;
    return this.#release();
  }

  /** The stream ended: checks the whole text and releases what is left. */
  end(): GateResult {
    if (this.#ended || this.#stopped()) {
      this.#ended = true;
      return this.#nothing();
    }
    this.#ended = true;
    return this.#release();
  }

  #stopped(): boolean {
    return this.#blocked !== null || this.#fallback !== null || this.#cut !== null || this.#full;
  }

  #nothing(): GateResult {
    return { units: [], blocked: this.#blocked, fallback: this.#fallback, cut: this.#cut };
  }

  /** A unit of at most {@link LEAD_IN_MAX_WORDS} words that ends a sentence (see the module comment). */
  #isLeadIn(unit: string): boolean {
    const text = unit.trim();
    return (
      text !== '' &&
      words(text) <= LEAD_IN_MAX_WORDS &&
      /[.!?…]["'”’)\]*_]*$/.test(text) &&
      !/[[\]<>()`*_#]/.test(text.replace(/[*_]+$/, ''))
    );
  }

  /** Whether the unit starting at `from` is complete and a lead-in. */
  #leadInAt(from: number): boolean {
    const end = findUnitEnd(this.#raw, from, this.#maxUnitChars);
    return end !== null && this.#isLeadIn(this.#raw.slice(from, end));
  }

  /** Nothing of the reply was released yet (shown, or withheld from the preview and said). */
  #nothingReleased(): boolean {
    return this.#shown === '' && this.#stats.withheld === 0;
  }

  /**
   * Text that cannot change any more: all of it once ended, else up to the last whitespace. Read from the end
   * (only the last word), so a long stream of small chunks stays linear.
   */
  #stable(): string {
    if (this.#ended) return this.#raw;
    let cut = this.#raw.length - 1;
    while (cut >= 0 && !/\s/.test(this.#raw.charAt(cut))) cut -= 1;
    return cut < 0 ? '' : this.#raw.slice(0, cut + 1);
  }

  #leaks(texts: readonly string[]): boolean {
    return textsContainOtherVenture(
      texts,
      this.#options.otherVentureNames,
      this.#options.otherVentureCanaries,
      this.#options.otherVentureMemberNames ?? [],
    );
  }

  #release(): GateResult {
    const units: GateUnit[] = [];
    if (this.#nothingReleased()) {
      // Nothing is shown before the opening is known to be prose.
      const opening = this.#raw.trimStart();
      if (STRUCTURED_OPENING.test(opening)) {
        this.#fallback = 'structured_output';
        return this.#nothing();
      }
      // A finished lead-in is prose: nothing can make it structured output any more.
      if (!this.#ended && opening.length < OPENING_CHARS && !this.#leadInAt(this.#cursor)) {
        return this.#nothing();
      }
    }
    const stable = this.#stable();
    let checked = false;
    for (;;) {
      let end = findUnitEnd(this.#raw, this.#cursor, this.#maxUnitChars);
      if (end === null) {
        if (!this.#ended || this.#cursor >= this.#raw.length) break;
        end = this.#raw.length; // the tail of a finished stream
      }
      const leadIn = !this.#ended && this.#isLeadIn(this.#raw.slice(this.#cursor, end));
      if (!this.#ended && stable.length < end + this.#holdBack && !(leadIn && this.#leadInsSafe)) break;
      if (!checked) {
        checked = true;
        // Only what is new since the last check, with a window before it for a string that straddles it.
        const from = Math.max(0, this.#leakCheckedTo - CUMULATIVE_WINDOW_CHARS);
        this.#leakCheckedTo = stable.length;
        if (this.#leaks([stable.slice(from)])) return this.#block('cross_venture', units);
      }
      let rawUnit = this.#raw.slice(this.#cursor, end);
      if (this.#options.greeted === true && this.#opening) {
        // The opening line already said hello: the reply's own greeting is left out (a whole unit, or its start).
        const greeting = withoutRepeatedGreeting(rawUnit, this.#greetingNames);
        if (greeting.removed) {
          this.#droppedGreeting = true;
          if (greeting.text.trim() === '') {
            this.#cursor = end;
            continue;
          }
          rawUnit = greeting.text;
        }
      }
      if (
        this.#nothingReleased() &&
        isThinkingAloudOpener(rawUnit) &&
        // Typed, an acknowledgement is shown at once (the preview is replaced if the reply is written whole); said on a
        // call it cannot be taken back, so it waits like any thinking-aloud opener ("Okay." then narration).
        !(leadIn && this.#options.spoken !== true && ACKNOWLEDGEMENT.test(rawUnit.trim()))
      ) {
        // "Okay, let's see." opening a reply is said only once the next unit shows that speech follows it.
        const next =
          findUnitEnd(this.#raw, end, this.#maxUnitChars) ?? (this.#ended ? this.#raw.length : null);
        if (next === null || (!this.#ended && stable.length < next + this.#holdBack)) break;
        if (findMetaNarration(this.#raw.slice(end, next), this.#names) !== null) {
          this.#fallback = 'meta_narration';
          return { units, blocked: null, fallback: this.#fallback, cut: null };
        }
      }
      if (findMetaNarration(rawUnit, this.#names) !== null) {
        this.#cursor = end;
        if (this.#nothingReleased()) {
          this.#fallback = 'meta_narration';
          return { units, blocked: null, fallback: this.#fallback, cut: null };
        }
        this.#cut = 'meta_narration';
        return { units, blocked: null, fallback: null, cut: this.#cut };
      }
      if (this.#previousGrams !== null && repeatsPrevious(rawUnit, this.#previousGrams)) {
        // The previous reply again: never said twice.
        this.#cursor = end;
        this.#repeatsDropped += 1;
        continue;
      }
      const budget = this.#options.replyBudget ?? null;
      if (budget !== null && this.#released.units > 0) {
        const n = words(rawUnit);
        if (this.#released.units >= budget.sentences || this.#released.words + n > budget.words) {
          this.#full = true;
          break;
        }
      }
      const unit = this.#process(rawUnit);
      this.#cursor = end;
      if (unit === 'identity' || unit === 'cross_venture') return this.#block(unit, units);
      if (unit === null) continue;
      if (this.#leaks([this.#shown.slice(-CUMULATIVE_WINDOW_CHARS) + unit.text])) {
        return this.#block('cross_venture', units);
      }
      this.#show(unit, units);
      this.#released.units += 1;
      this.#released.words += words(unit.text);
    }
    if (this.#ended && this.#nothingReleased()) {
      // The reply was only the greeting the opening line already gave, or only the previous reply again: a short
      // line instead.
      const instead = this.#droppedGreeting
        ? REPEATED_GREETING_FALLBACK
        : this.#repeatsDropped > 0
          ? REPEAT_FALLBACK
          : null;
      const unit = instead === null ? null : this.#process(instead);
      if (unit !== null && typeof unit !== 'string') this.#show(unit, units);
    }
    return { units, blocked: null, fallback: null, cut: null };
  }

  /** Shows a checked unit, or withholds it from the preview (still said on a call). */
  #show(unit: GateUnit, units: GateUnit[]): void {
    if (!this.#withholding && this.#formsRemovedMarkdown(unit.text)) this.#withholding = true;
    if (this.#withholding) {
      this.#stats.withheld += 1;
      if (unit.spoken !== '') units.push({ text: '', spoken: unit.spoken });
      return;
    }
    this.#shown += unit.text;
    this.#stats.units += 1;
    units.push(unit);
  }

  /** The founder's names a greeting may carry ("Hi Maya"). */
  get #greetingNames(): string[] {
    return [this.#options.founderName ?? '', ...(this.#options.addressees ?? [])].filter(
      (n) => n.trim() !== '',
    );
  }

  /**
   * Whether the shown text followed by `text` contains Markdown the subset removes (built across units). Units
   * never end inside a link, image or tag, so such a construct can only open in the recent shown text: the
   * check reads a bounded tail of it. A construct the tail cuts in two can only withhold the preview.
   *
   * Every construct the subset removes ends in a letter (a tag or script name, a scheme), `>`, `)`, `]` or
   * `:`. A unit with none of them (". ", "?!") cannot complete one, so the shown text is not read again for it.
   */
  #formsRemovedMarkdown(text: string): boolean {
    if (!/[\p{L}<>)\]:]/u.test(text)) return false;
    const joined = sanitizeMarkdown(this.#shown.slice(-MARKDOWN_WINDOW_CHARS) + text);
    return joined.htmlRemoved + joined.unsafeLinksRemoved + joined.imagesRemoved > 0;
  }

  #block(reason: GateBlockReason, units: GateUnit[]): GateResult {
    this.#blocked = reason;
    return { units, blocked: reason, fallback: null, cut: null };
  }

  #process(raw: string): GateUnit | GateBlockReason | null {
    const core = raw.trimStart();
    const lead = this.#shown === '' ? '' : raw.slice(0, raw.length - core.length).replace(/\n{3,}/g, '\n\n');
    const md = sanitizeMarkdown(core);
    this.#stats.markdownRemovals += md.htmlRemoved + md.unsafeLinksRemoved + md.imagesRemoved;
    let text = md.text;
    const keys = this.#keys;
    if (keys !== null) {
      text = text.replace(CITATION, (whole, list: string) => {
        const ids = list.split(/[,;]/).map(normalizeKey);
        const kept = ids.filter((id) => keys.has(id));
        this.#stats.citationsRemoved += ids.length - kept.length;
        if (kept.length === ids.length) return whole;
        if (kept.length === 0) return '';
        return `${whole.startsWith(' ') ? ' ' : ''}[${[...new Set(kept)].join(', ')}]`;
      });
    }
    const answers = this.#opening ? this.#question : null;
    this.#opening = false;
    const identity = rewriteIdentity(text, { ...this.#identity, ...this.#disclaimers, answers });
    if (identity.findings.some((f) => this.#blockOn.has(f.kind))) return 'identity';
    this.#stats.identityRewrites += identity.findings.length;
    text = identity.text.trim();
    if (text === '') {
      this.#afterDroppedDisclaimer = identity.findings.length > 0 && identity.findings.every(isStyleFinding);
      return null;
    }
    if (this.#afterDroppedDisclaimer) {
      this.#afterDroppedDisclaimer = false;
      text = withoutLeaningConnector(text);
    }
    const split = this.#splitClaim(this.#tail, lead === '' ? ' ' : lead, text, this.#identity);
    if (split === null) return 'identity';
    text = split;
    const spoken = this.#speak(text);
    if ('blocked' in spoken) return spoken.blocked;
    this.#tail = identityTail(text);
    if (!this.#identified && identifiesHonestly(text, this.#identity)) this.#identified = true;
    return { text: `${lead}${text}`, spoken: spoken.said };
  }

  /**
   * The unit as released after `tail` (the end of the previous unit): itself, null when the two together
   * make a blocking claim neither makes alone, or the disclosure sentence when they make another one. A unit
   * without letters cannot complete a claim (every rule needs a name or a word), so it is not read again.
   */
  #splitClaim(tail: string, gap: string, unit: string, options: IdentityCheckOptions): string | null {
    if (tail === '' || !/\p{L}/u.test(unit)) return unit;
    // A disclaimer is judged within its own sentence (the unit itself, above); the whole answer is checked again.
    const added = identityFindingsAdded(tail, `${tail}${gap}${unit}`, options).filter(
      (f) => !isStyleFinding(f),
    );
    if (added.length === 0) return unit;
    if (added.some((f) => this.#blockOn.has(f.kind))) return null;
    this.#stats.identityRewrites += added.length;
    const gravest = added.reduce((a: IdentityFinding, b) => (GRAVITY[b.kind] < GRAVITY[a.kind] ? b : a));
    return identityReplacementFor(gravest.kind, options);
  }

  /** How a unit's volunteered disclaimers are rewritten out (one sentence of a reply that keeps its honest answer). */
  get #disclaimers(): { disclaimers: 'unit'; identityAsked: boolean; identified: boolean } {
    return { disclaimers: 'unit', identityAsked: this.#question !== null, identified: this.#identified };
  }

  /** Who a unit may narrate by name (meta-narration). */
  get #names(): NarrationNames {
    return { founder: this.#options.founderName ?? null, people: this.#options.addressees ?? [] };
  }

  get #identity(): IdentityCheckOptions {
    const o = this.#options;
    return {
      personaName: o.personaName,
      ...(o.eirNames ? { eirNames: o.eirNames } : {}),
      ...(o.personaEirName !== undefined ? { personaEirName: o.personaEirName } : {}),
      ...(o.addressees ? { addressees: o.addressees } : {}),
    };
  }

  /**
   * The unit's spoken form within the word budget, or why it cannot be said: heard on a call, it speaks as
   * the EIR, or it says another venture's name or canary (read after a bounded tail of what was said before,
   * where Markdown, links and citations no longer split a word).
   */
  #speak(text: string): { said: string } | { blocked: GateBlockReason } {
    const budget = this.#options.spokenWordBudget;
    let speakable = toSpeakable(text);
    if (this.#options.spoken === true && speakable !== '') {
      // Heard, not read: the spoken form is checked as speech before it is said, alone and after the end of
      // the unit said before it.
      const options = { ...this.#identity, spoken: true };
      const heard = rewriteIdentity(speakable, { ...options, ...this.#disclaimers });
      if (heard.findings.some((f) => this.#blockOn.has(f.kind))) return { blocked: 'identity' };
      this.#stats.identityRewrites += heard.findings.length;
      speakable = heard.text.trim();
      if (speakable !== '') {
        const split = this.#splitClaim(this.#spokenTail, ' ', speakable, options);
        if (split === null) return { blocked: 'identity' };
        speakable = split;
        this.#spokenTail = identityTail(speakable);
        const said = `${this.#said.slice(-CUMULATIVE_WINDOW_CHARS)} ${speakable}`;
        if (this.#leaks([said])) return { blocked: 'cross_venture' };
        this.#said = said.slice(-CUMULATIVE_WINDOW_CHARS);
      }
    }
    if (budget === undefined || speakable === '') return { said: speakable };
    const left = budget - this.#spokenWords;
    if (left <= 0) return { said: '' };
    const clamped = words(speakable) > left ? clampWords(speakable, left).text : speakable;
    this.#spokenWords += words(clamped);
    return { said: clamped };
  }
}
