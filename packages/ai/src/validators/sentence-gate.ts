import { normalizeForMatching } from '../risk/normalize.js';
import { textsContainOtherVenture } from './coach-response.js';
import { rewriteIdentity, type IdentityViolationKind } from './identity.js';
import { sanitizeMarkdown } from './markdown.js';
import { clampWords, toSpeakable } from './speech.js';

/**
 * Validate-before-show for streamed answers. A model's text arrives in arbitrary chunks; the gate cuts it
 * into sentence units and releases a unit only after it passed the same checks the final validator
 * (`validateCoachResponse`) applies to the whole answer:
 *
 * 1. the Markdown subset (raw HTML, images and unsafe links removed);
 * 2. citations: `[E#]` keys that were not shown to the model are removed;
 * 3. identity, per sentence: claims to be human are rewritten like the validator does; claims to be (or
 *    sign as) the EIR block the stream, as they block the turn;
 * 4. cross-venture, cumulatively: another venture's name, canary or member name anywhere in the text so far
 *    blocks the stream. A unit is held back until enough text follows it (the hold-back window, at least
 *    twice the longest guarded string) that a guarded string starting inside it is complete when checked.
 *
 * The final validation of the whole response stays authoritative: units are a preview the client replaces
 * with `turn.completed`. Units never carry raw model output that failed a check.
 */

export type GateBlockReason = 'cross_venture' | 'identity';

export interface SentenceGateOptions {
  /** Persona display name ("Corin's vEIR"). */
  personaName: string;
  /** EIR / staff names the vEIR must never speak as. */
  eirNames?: readonly string[];
  /** Display name of the EIR the persona is built from ("Corin Halvorsen"). */
  personaEirName?: string | null;
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
   * concatenation of all units reads as the answer.
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
}

export interface GateStats {
  readonly units: number;
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
const CITATION = / ?\[\s*(E\d+(?:\s*[,;]\s*E\d+)*)\s*\](?!\()/gi;
const DEFAULT_MAX_UNIT_CHARS = 360;
const MAX_HOLD_BACK = 200;

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
 * once they reach `maxChars`.
 */
export function findUnitEnd(text: string, from: number, maxChars: number): number | null {
  let start = from;
  while (start < text.length && /\s/.test(text.charAt(start))) start += 1;
  for (let i = start; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === '\n') {
      if (i + 1 >= text.length) return null;
      if (text.charAt(i + 1) === '\n') return i;
      if (BLOCK_LINE.test(text.slice(lineStart(text, i), i))) return i;
      const next = text.slice(i + 1, i + 1 + BLOCK_LOOKAHEAD);
      if (BLOCK_LINE.test(next)) return i;
      if (next.length < BLOCK_LOOKAHEAD && !next.includes('\n')) return null;
      continue;
    }
    if (SENTENCE_END.has(ch)) {
      let j = i + 1;
      while (j < text.length && CLOSERS.has(text.charAt(j))) j += 1;
      if (j >= text.length) return null;
      if (!/\s/.test(text.charAt(j))) continue;
      if (ch === '.' && quietFullStop(text, start, i)) continue;
      return j;
    }
    if (i - start >= maxChars) {
      const cut = text.slice(start, i).search(/\s\S*$/);
      return cut > 0 ? start + cut : i;
    }
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
  #spokenWords = 0;
  #stats = { units: 0, identityRewrites: 0, citationsRemoved: 0, markdownRemovals: 0 };

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

  /** Counts for audit metadata (no content). */
  get stats(): GateStats {
    return { ...this.#stats };
  }

  /** Adds a chunk and returns the units it completes. */
  push(chunk: string): GateResult {
    if (this.#ended) throw new Error('SentenceGate.push after end');
    if (this.#blocked !== null) return { units: [], blocked: this.#blocked };
    this.#raw += chunk;
    return this.#release();
  }

  /** The stream ended: checks the whole text and releases what is left. */
  end(): GateResult {
    if (this.#ended) return { units: [], blocked: this.#blocked };
    this.#ended = true;
    if (this.#blocked !== null) return { units: [], blocked: this.#blocked };
    return this.#release();
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
        if (this.#leaks([stable])) return this.#block('cross_venture', units);
      }
      const unit = this.#process(this.#raw.slice(this.#cursor, end));
      this.#cursor = end;
      if (unit === 'identity') return this.#block('identity', units);
      if (unit === null) continue;
      if (this.#leaks([this.#shown + unit.text])) return this.#block('cross_venture', units);
      this.#shown += unit.text;
      this.#stats.units += 1;
      units.push(unit);
    }
    return { units, blocked: null };
  }

  #block(reason: GateBlockReason, units: GateUnit[]): GateResult {
    this.#blocked = reason;
    return { units, blocked: reason };
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
    const identity = rewriteIdentity(text, {
      personaName: this.#options.personaName,
      ...(this.#options.eirNames ? { eirNames: this.#options.eirNames } : {}),
      ...(this.#options.personaEirName !== undefined ? { personaEirName: this.#options.personaEirName } : {}),
    });
    if (identity.findings.some((f) => this.#blockOn.has(f.kind))) return 'identity';
    this.#stats.identityRewrites += identity.findings.length;
    text = identity.text.trim();
    if (text === '') return null;
    return { text: `${lead}${text}`, spoken: this.#speak(text) };
  }

  #speak(text: string): string {
    const budget = this.#options.spokenWordBudget;
    const speakable = toSpeakable(text);
    if (budget === undefined || speakable === '') return speakable;
    const left = budget - this.#spokenWords;
    if (left <= 0) return '';
    const clamped = words(speakable) > left ? clampWords(speakable, left).text : speakable;
    this.#spokenWords += words(clamped);
    return clamped;
  }
}
