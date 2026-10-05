/**
 * Access code input mask for FA-XXXXX-XXXXX-XXXXX-XXXXX (Crockford base32, 20 symbols).
 *
 * The "FA-" prefix is rendered as a fixed adornment; the input holds the four groups. Input is
 * paste-friendly: lower case, spaces, missing/extra dashes, with or without the "FA-" prefix, and
 * the Crockford look-alikes O→0 and I/L→1 are mapped. Other characters (incl. U) are dropped.
 */
export const ACCESS_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ACCESS_CODE_SYMBOLS = 20;
export const ACCESS_CODE_PREFIX = 'FA-';
export const ACCESS_CODE_PLACEHOLDER = 'XXXXX-XXXXX-XXXXX-XXXXX';

const LOOKALIKES: Record<string, string> = { O: '0', I: '1', L: '1' };

function mapSymbol(ch: string): string | null {
  const upper = LOOKALIKES[ch] ?? ch;
  return ACCESS_CODE_ALPHABET.includes(upper) ? upper : null;
}

function countSymbols(text: string): number {
  let n = 0;
  for (const ch of text) if (mapSymbol(ch) !== null) n++;
  return n;
}

function stripPrefix(upper: string): string {
  const trimmed = upper.trimStart();
  // "FA" followed by a separator is always the prefix: the mask never puts a dash after 2 symbols.
  const visible = /^FA[\s\u2010-\u2015-]+/.exec(trimmed);
  if (visible) return trimmed.slice(visible[0].length);
  // "FA" glued to a full code (pasted without a dash): only when it can't be part of the code itself.
  if (trimmed.startsWith('FA') && countSymbols(trimmed.slice(2)) >= ACCESS_CODE_SYMBOLS)
    return trimmed.slice(2);
  return trimmed;
}

/** The (up to 20) code symbols contained in arbitrary input. */
export function accessCodeSymbols(raw: string): string {
  let out = '';
  for (const ch of stripPrefix(raw.toUpperCase())) {
    const mapped = mapSymbol(ch);
    if (mapped) out += mapped;
    if (out.length === ACCESS_CODE_SYMBOLS) break;
  }
  return out;
}

/** "ABCDEFGHJK" → "ABCDE-FGHJK" (what the input shows after the fixed "FA-" prefix). */
export function formatAccessCodeGroups(symbols: string): string {
  return (symbols.match(/.{1,5}/g) ?? []).join('-');
}

/** Normalise any input to the input's display value. */
export function maskAccessCodeInput(raw: string): string {
  return formatAccessCodeGroups(accessCodeSymbols(raw));
}

/** Full code for submission: "FA-ABCDE-…" ("" when nothing was entered). */
export function fullAccessCode(raw: string): string {
  const groups = maskAccessCodeInput(raw);
  return groups ? ACCESS_CODE_PREFIX + groups : '';
}

/**
 * Caret position after masking: right after the same number of code symbols that preceded the caret
 * in the raw value, so editing in the middle doesn't jump to the end.
 */
export function caretAfterMask(raw: string, caret: number, masked: string): number {
  const before = accessCodeSymbols(raw.slice(0, caret)).length;
  if (before === 0) return 0;
  let seen = 0;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== '-') seen++;
    if (seen === before) return i + 1;
  }
  return masked.length;
}

export function isCompleteAccessCode(value: string): boolean {
  return accessCodeSymbols(value).length === ACCESS_CODE_SYMBOLS;
}
