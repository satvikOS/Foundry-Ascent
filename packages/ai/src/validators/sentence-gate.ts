import { normalizeForMatching } from '../risk/normalize.js';
import { textsContainOtherVenture } from './coach-response.js';
import { rewriteIdentity, type IdentityCheckOptions, type IdentityViolationKind } from './identity.js';
import { sanitizeMarkdown } from './markdown.js';
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
 *    sign as) the EIR block the stream, as they block the turn;
 * 4. cross-venture, cumulatively: another venture's name, canary or member name anywhere in the text so far
 *    blocks the stream. A unit is held back until enough text follows it (the hold-back window, at least
 *    twice the longest guarded string) that a guarded string starting inside it is complete when checked.
 *
 * Before the first unit, a reply that opens like structured output (JSON, a code fence, a field label such
 * as `answer:`) is not prose for the founder: the gate releases nothing and asks for the whole-reply path.
 *
 * The final validation of the whole response stays authoritative: units are a preview the client replaces
 * with `turn.completed`. Units never carry raw model output that failed a check, and their concatenation
 * passes the Markdown subset unchanged.
 */

export type GateBlockReason = 'cross_venture' | 'identity';

/** Why the stream cannot be shown at all and the reply must be written whole instead. */
export type GateFallbackReason = 'structured_output';

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
  readonly #maxUnitChars: number;
  readonly #blockOn: ReadonlySet<IdentityViolationKind>;
  readonly #keys: ReadonlySet<string> | null;
  #raw = '';
  #cursor = 0;
  #shown = '';
  #ended = false;
  #blocked: GateBlockReason | null = null;
  #fallback: GateFallbackReason | null = null;
  /** Set once joining a unit to the shown text would form Markdown the subset removes. */
  #withholding = false;
  #spokenWords = 0;
  /** Length of the stable text already checked for other ventures as a whole. */
  #leakCheckedTo = 0;
  #stats = { units: 0, withheld: 0, identityRewrites: 0, citationsRemoved: 0, markdownRemovals: 0 };

  constructor(options: SentenceGateOptions) {
    this.#options = options;
    this.#holdBack = holdBackFor([
      ...options.otherVentureNames,
      ...options.otherVentureCanaries,
      ...(options.otherVentureMemberNames ?? []),
    ]);
    this.#maxUnitChars = Math.max(80, options.maxUnitChars ?? DEFAULT_MAX_UNIT_CHARS);
    this.#blockOn = new Set(options.blockOnIdentity ?? ['claims_eir']);
    this.#keys = options.evidenceKeys ? new Set([...options.evidenceKeys].map(normalizeKey)) : null;
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
    return this.#blocked !== null || this.#fallback !== null;
  }

  #nothing(): GateResult {
    return { units: [], blocked: this.#blocked, fallback: this.#fallback };
  }

  /** Text that cannot change any more: all of it once ended, else up to the last whitespace. */
  #stable(): string {
    if (this.#ended) return this.#raw;
    const cut = this.#raw.search(/\s\S*$/);
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
    if (this.#shown === '' && this.#stats.withheld === 0) {
      // Nothing is shown before the opening is known to be prose.
      const opening = this.#raw.trimStart();
      if (STRUCTURED_OPENING.test(opening)) {
        this.#fallback = 'structured_output';
        return this.#nothing();
      }
      if (!this.#ended && opening.length < OPENING_CHARS) return this.#nothing();
    }
    const stable = this.#stable();
    let checked = false;
    for (;;) {
      let end = findUnitEnd(this.#raw, this.#cursor, this.#maxUnitChars);
      if (end === null) {
        if (!this.#ended || this.#cursor >= this.#raw.length) break;
        end = this.#raw.length; // the tail of a finished stream
      }
      if (!this.#ended && stable.length < end + this.#holdBack) break;
      if (!checked) {
        checked = true;
        // Only what is new since the last check, with a window before it for a string that straddles it.
        const from = Math.max(0, this.#leakCheckedTo - CUMULATIVE_WINDOW_CHARS);
        this.#leakCheckedTo = stable.length;
        if (this.#leaks([stable.slice(from)])) return this.#block('cross_venture', units);
      }
      const unit = this.#process(this.#raw.slice(this.#cursor, end));
      this.#cursor = end;
      if (unit === 'identity') return this.#block('identity', units);
      if (unit === null) continue;
      if (this.#leaks([this.#shown.slice(-CUMULATIVE_WINDOW_CHARS) + unit.text])) {
        return this.#block('cross_venture', units);
      }
      if (!this.#withholding && this.#formsRemovedMarkdown(unit.text)) this.#withholding = true;
      if (this.#withholding) {
        this.#stats.withheld += 1;
        if (unit.spoken !== '') units.push({ text: '', spoken: unit.spoken });
        continue;
      }
      this.#shown += unit.text;
      this.#stats.units += 1;
      units.push(unit);
    }
    return { units, blocked: null, fallback: null };
  }

  /**
   * Whether the shown text followed by `text` contains Markdown the subset removes (built across units). Units
   * never end inside a link, image or tag, so such a construct can only open in the recent shown text: the
   * check reads a bounded tail of it. A construct the tail cuts in two can only withhold the preview.
   */
  #formsRemovedMarkdown(text: string): boolean {
    const joined = sanitizeMarkdown(this.#shown.slice(-MARKDOWN_WINDOW_CHARS) + text);
    return joined.htmlRemoved + joined.unsafeLinksRemoved + joined.imagesRemoved > 0;
  }

  #block(reason: GateBlockReason, units: GateUnit[]): GateResult {
    this.#blocked = reason;
    return { units, blocked: reason, fallback: null };
  }

  #process(raw: string): GateUnit | 'identity' | null {
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
    const identity = rewriteIdentity(text, this.#identity);
    if (identity.findings.some((f) => this.#blockOn.has(f.kind))) return 'identity';
    this.#stats.identityRewrites += identity.findings.length;
    text = identity.text.trim();
    if (text === '') return null;
    const spoken = this.#speak(text);
    if (spoken === null) return 'identity';
    return { text: `${lead}${text}`, spoken };
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

  /** The unit's spoken form within the word budget; null when, heard on a call, it speaks as the EIR. */
  #speak(text: string): string | null {
    const budget = this.#options.spokenWordBudget;
    let speakable = toSpeakable(text);
    if (this.#options.spoken === true && speakable !== '') {
      // Heard, not read: the spoken form is checked as speech before it is said.
      const heard = rewriteIdentity(speakable, { ...this.#identity, spoken: true });
      if (heard.findings.some((f) => this.#blockOn.has(f.kind))) return null;
      this.#stats.identityRewrites += heard.findings.length;
      speakable = heard.text.trim();
    }
    if (budget === undefined || speakable === '') return speakable;
    const left = budget - this.#spokenWords;
    if (left <= 0) return '';
    const clamped = words(speakable) > left ? clampWords(speakable, left).text : speakable;
    this.#spokenWords += words(clamped);
    return clamped;
  }
}
