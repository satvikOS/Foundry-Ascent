import { sanitizeMarkdown, sanitizePlainText } from './markdown.js';

/** A call speaks at most this many words per reply (`CoachResponse.spoken`). */
export const SPOKEN_MAX_WORDS = 70;
/** Hard character bound on spoken text (well under the speech endpoint's 1 500). */
export const SPOKEN_MAX_CHARS = 600;

const CITATION = /\s*[[(]\s*E\d+(?:\s*[,;]\s*E\d+)*\s*[\])]/gi;
const URL = /\b(?:https?:\/\/|www\.)\S+|\bmailto:\S+/gi;

/**
 * Plain sentences for text-to-speech: HTML, Markdown syntax (headings, emphasis, lists, quotes, tables,
 * code), links (their label is kept), URLs and citation keys such as [E1] are removed, and list items
 * and headings become sentences.
 */
export function toSpeakable(text: string): string {
  const md = sanitizeMarkdown(text).text;
  const lines = md
    .replace(/```[\s\S]*?(?:```|$)/g, ' ') // code is never read aloud
    .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, '$1')
    .replace(CITATION, '')
    .replace(URL, '')
    .split('\n')
    .map((line) => ({
      item: /^\s*(?:[-*+•]|\d{1,3}[.)])\s+/.test(line),
      text: line
        .replace(/^\s*(?:[-*_]\s*){3,}$/, '') // horizontal rule
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/^\s*(?:[-*+•]|\d{1,3}[.)])\s+/, '')
        .replace(/\|/g, ' ')
        .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
        .replace(/(^|[^\p{L}\p{N}])[*_](?=\S)(.+?)(?<=\S)[*_](?![\p{L}\p{N}])/gu, '$1$2')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/[*_~`#]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    }))
    .filter((line) => line.text !== '');
  // A line without closing punctuation (a heading, a list item) becomes its own sentence; a line ending
  // in a comma runs on ("Best,\nCorin" reads "Best, Corin.").
  // Consecutive list items run on with commas ("People to ask: Ruth, Corin."), so a bare name in a list is
  // never heard as a sign-off sentence.
  const joined = lines
    .map((line, i) =>
      /[.!?:;…,]$/.test(line.text)
        ? line.text
        : `${line.text}${line.item && lines[i + 1]?.item === true && /^(?:\p{Lu}[\p{L}'’-]*\s*){1,4}$/u.test(line.text) ? ',' : '.'}`,
    )
    .join(' ');
  return sanitizePlainText(joined)
    .text.replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,;:])(?:[,;:])+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(text: string): string[] {
  return text.split(/\s+/).filter((w) => w !== '');
}

/**
 * At most `maxWords` words, cut at a sentence boundary when one fits; a single over-long first sentence
 * is cut at a word boundary and closed with a full stop.
 */
export function clampWords(
  text: string,
  maxWords = SPOKEN_MAX_WORDS,
  maxChars = SPOKEN_MAX_CHARS,
): { text: string; truncated: boolean } {
  const all = text.trim();
  if (words(all).length <= maxWords && all.length <= maxChars) return { text: all, truncated: false };
  const sentences = all.split(/(?<=[.!?…])\s+/);
  let out = '';
  for (const sentence of sentences) {
    const next = out === '' ? sentence : `${out} ${sentence}`;
    if (words(next).length > maxWords || next.length > maxChars) break;
    out = next;
  }
  if (out === '') {
    let cut = words(all).slice(0, maxWords).join(' ');
    if (cut.length > maxChars) cut = cut.slice(0, maxChars).replace(/\s+\S*$/, '');
    const trimmed = cut.replace(/[\s,;:–—-]+$/, '');
    out = /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  }
  return { text: out, truncated: true };
}

/** What a call says when the model gave no spoken reply: the answer, made speakable and clamped. */
export function deriveSpoken(answer: string, maxWords = SPOKEN_MAX_WORDS): string {
  return clampWords(toSpeakable(answer), maxWords).text;
}
