/**
 * How a reply is cut into units (a sentence, a list item, a heading): the sentence gate releases it unit by unit
 * (validators/sentence-gate.ts), and the reply contract and the citation check read it in the same units.
 */

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

/** A unit of a reply: what it says, with where it starts and ends in the text (leading whitespace included). */
export interface TextUnit {
  readonly start: number;
  readonly end: number;
  /** The unit as written, with the whitespace before it. */
  readonly raw: string;
  /** The unit without the whitespace around it. */
  readonly text: string;
}

const WHOLE_UNIT = 100_000;

/** The units of a finished text, in order; their `raw` parts joined are the text. */
export function unitsOf(text: string): TextUnit[] {
  const out: TextUnit[] = [];
  let from = 0;
  while (from < text.length) {
    const end = findUnitEnd(text, from, WHOLE_UNIT) ?? text.length;
    const next = end <= from ? text.length : end;
    const raw = text.slice(from, next);
    if (raw.trim() !== '') out.push({ start: from, end: next, raw, text: raw.trim() });
    else if (out.length > 0) {
      const last = out[out.length - 1];
      if (last !== undefined) out[out.length - 1] = { ...last, end: next, raw: last.raw + raw };
    }
    from = next;
  }
  return out;
}

/** A list item or a heading line. */
export function isBlockUnit(unit: string): boolean {
  return BLOCK_LINE.test(unit.replace(/^\s*\n/, '').replace(/^\n+/, ''));
}

/** Whether a list item ("1. …", "- …"). */
export function isListUnit(unit: string): boolean {
  return /^\s*(?:[-*+•]|\d{1,3}[.)])\s/.test(unit);
}

/** The words of a text. */
export function wordsIn(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}
