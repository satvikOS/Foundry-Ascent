/**
 * Text normalisation shared by the deterministic risk classifier and the output validators.
 *
 * The goal is to make keyword rules robust against trivial evasion (full-width letters, zero-width
 * joiners, curly quotes, mixed-script homoglyphs, leetspeak, spaced-out letters) without mangling
 * ordinary non-English text: homoglyph folding only applies to tokens that already mix Latin
 * letters with look-alike Cyrillic/Greek letters.
 */
import { COMMON_WORDS } from './common-words.js';

/** Invisible and bidi-control characters that can hide or split keywords. */
const INVISIBLE =
  // eslint-disable-next-line no-misleading-character-class -- deliberate list of individual invisible code points
  /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g;

/** Look-alike Cyrillic and Greek letters → Latin. */
const CONFUSABLES: Readonly<Record<string, string>> = {
  а: 'a',
  в: 'b',
  е: 'e',
  ё: 'e',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  і: 'i',
  ї: 'i',
  ј: 'j',
  ѕ: 's',
  ԁ: 'd',
  ԛ: 'q',
  ԝ: 'w',
  ӏ: 'l',
  һ: 'h',
  ո: 'n',
  ս: 'u',
  α: 'a',
  β: 'b',
  ε: 'e',
  η: 'n',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
  ϲ: 'c',
  ɡ: 'g',
};
const CONFUSABLE_CLASS = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'u');

const LEET: Readonly<Record<string, string>> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
  '!': 'i',
};

function foldToken(token: string): string {
  if (!/[a-z]/i.test(token) || !CONFUSABLE_CLASS.test(token.toLowerCase())) return token;
  let out = '';
  for (const ch of token) {
    const lower = ch.toLowerCase();
    out += CONFUSABLES[lower] ?? ch;
  }
  return out;
}

/** Removes zero-width / bidi characters. */
export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, '');
}

/**
 * NFKC, invisible characters removed, typographic quotes and dashes mapped to ASCII, mixed-script
 * homoglyph tokens folded to Latin, whitespace collapsed. Case is preserved.
 */
export function normalizeText(text: string): string {
  return stripInvisible(text.normalize('NFKC'))
    .replace(/[‘’‚‛′ʼ＇`´]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐-―−﹘﹣－]/g, '-')
    .replace(/[\p{L}\p{M}]+/gu, foldToken)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Removes Latin combining diacritics (`légal` → `legal`, `möchte` → `mochte`, `ameaça` → `ameaca`) so
 * multilingual rules can be written once without accents. Only the Combining Diacritical Marks block is
 * removed: vowel signs of other scripts (Devanagari, Arabic) are untouched, and the result is recomposed.
 */
export function foldDiacritics(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC');
}

/** Lower-cased {@link normalizeText}. */
export function normalizeForMatching(text: string): string {
  return normalizeText(text).toLowerCase();
}

/**
 * Leetspeak folding (`1gn0r3` → `ignore`) for tokens that mix letters with digits or symbols.
 * Pure numbers (`510`, `2026`) are left alone.
 */
export function foldLeetspeak(lower: string): string {
  return lower.replace(/[\p{L}\p{N}@$!]+/gu, (token) => {
    if (!/\p{L}/u.test(token) || !/[0-9@$!]/.test(token)) return token;
    let out = '';
    for (const ch of token) out += LEET[ch] ?? ch;
    return out;
  });
}

/**
 * Joins runs of single letters separated by spaces or punctuation (`i g n o r e`, `s.y.s.t.e.m`)
 * and returns the squashed runs (letters only). Used to catch spaced-out evasion.
 */
export function spacedLetterRuns(lower: string): string[] {
  const runs: string[] = [];
  for (const match of lower.matchAll(
    /(?<![\p{L}\p{N}])(?:\p{L}[ .\-_*|/+]{1,3}){4,}\p{L}(?![\p{L}\p{N}])/gu,
  )) {
    runs.push(match[0].replace(/[^\p{L}]/gu, ''));
  }
  return runs;
}

/**
 * Escapes a literal string for use inside a regular expression (valid with the `u` flag, which
 * rejects identity escapes such as `\-` outside character classes).
 */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Unicode-aware "word" boundaries (JavaScript's `\b` is ASCII-only). */
export const WORD_START = '(?<![\\p{L}\\p{N}_])';
export const WORD_END = '(?![\\p{L}\\p{N}_])';

/**
 * Builds a case-insensitive, Unicode-aware regex that matches `name` as a whole phrase, tolerant
 * of whitespace differences. Returns null for names too short to match safely (< 3 characters).
 */
export function phraseRegExp(name: string): RegExp | null {
  const normalized = normalizeForMatching(name);
  if (normalized.replace(/[^\p{L}\p{N}]/gu, '').length < 3) return null;
  const body = normalized.split(' ').map(escapeRegExp).join('[\\s\\-_]+');
  return new RegExp(`${WORD_START}${body}${WORD_END}`, 'giu');
}

/**
 * Like {@link phraseRegExp}, for a person's display name. Only names with at least two words of two or
 * more letters ("Amara Nwosu-Belling") are matched: a single given name ("Will", "Grace") is too often an
 * ordinary word to block safely. Returns null for names that are not matched.
 */
export function personNameRegExp(name: string): RegExp | null {
  const words = normalizeForMatching(name)
    .split(/[\s]+/)
    .filter((word) => word.replace(/[^\p{L}]/gu, '').length >= 2);
  return words.length >= 2 ? phraseRegExp(name) : null;
}

/** Why a venture name is not distinctive enough for the cross-venture guard, or null when it is. */
export type VentureNameProblem = 'too_short' | 'common_word' | 'only_common_words';

/**
 * Distinctiveness rule for venture names (they feed the cross-venture guard, which blocks every turn of
 * the tenant whose text contains another venture's name):
 *  - at least three letters or digits in total;
 *  - a single-word name has at least 4 characters and is not a common word ({@link COMMON_WORDS});
 *  - a name of several words contains at least one word of 3+ characters that is not a common word
 *    ("Quiet Quad" is distinctive, "Customer Discovery" or "of the" are not).
 * Words are compared after {@link normalizeForMatching} and diacritic folding.
 */
export function ventureNameProblem(name: string): VentureNameProblem | null {
  const words = foldDiacritics(normalizeForMatching(name))
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '');
  if (words.join('').length < 3) return 'too_short';
  if (words.length === 1) {
    const [word = ''] = words;
    if (word.length < 4) return 'too_short';
    return COMMON_WORDS.has(word) ? 'common_word' : null;
  }
  return words.some((w) => w.length >= 3 && !COMMON_WORDS.has(w)) ? null : 'only_common_words';
}

/**
 * The cross-venture guard's pattern for another venture's name: the full name as a whole phrase
 * ({@link phraseRegExp}), or null when the name is not distinctive ({@link ventureNameProblem}) and so
 * would match ordinary text. Non-distinctive names are not guarded by name (their canaries and their
 * members' names still are).
 */
export function ventureNameRegExp(name: string): RegExp | null {
  return ventureNameProblem(name) === null ? phraseRegExp(name) : null;
}
