import { createHash } from 'node:crypto';

import { type FaceTranscriptLine } from '../ports.js';

/**
 * What a FULL face said, checked against what the server admitted (docs/architecture/calls.md §4). The browser
 * sends the vendor the words of each admitted unit; the vendor's transcript of the avatar must be made of those
 * words and nothing else. Only salted digests of admitted words are stored (`call_face_texts`), never the words.
 */

/**
 * Words as the vendor may transcribe them: Unicode-normalized, lower case, letters and digits only, single
 * spaces. Punctuation, quotes and spacing never decide a match.
 */
export function normalizeFaceWords(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/'/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The salted digest of normalized words on one call (empty words have none). */
export function faceWordsDigest(callId: string, words: string): string | null {
  const normalized = normalizeFaceWords(words);
  if (normalized === '') return null;
  return createHash('sha256').update(`face-text|${callId.toLowerCase()}|${normalized}`, 'utf8').digest('hex');
}

/** At most this many digests per unit (the whole unit and each of its sentences). */
const MAX_DIGESTS = 40;

/**
 * The digests of an admitted unit: its whole words and each sentence of it, so a vendor that transcribes a unit
 * as one line or sentence by sentence matches either way.
 */
export function faceTextDigests(callId: string, text: string): string[] {
  const sentences = text.split(/(?<=[.!?…])\s+/u);
  const digests = new Set<string>();
  for (const part of [text, ...sentences]) {
    const digest = faceWordsDigest(callId, part);
    if (digest !== null) digests.add(digest);
    if (digests.size >= MAX_DIGESTS) break;
  }
  return [...digests];
}

/** Consecutive transcript lines that may together make one admitted unit (a vendor splitting a long one). */
const JOIN_WINDOW = 6;

export type TranscriptVerdict =
  /** Every avatar line is admitted words. `verified`: the avatar lines checked so far. */
  | { readonly verdict: 'ok'; readonly verified: number }
  /**
   * The last avatar lines match nothing yet (a unit still being transcribed, or words never admitted): checked
   * again (after the first `verified` lines) next time, and treated as an injection if they stay unmatched.
   */
  | { readonly verdict: 'pending'; readonly verified: number }
  /** The avatar said words the server never admitted (a tampered page). */
  | { readonly verdict: 'mismatch' };

/**
 * Checks the avatar's lines of a whole transcript (in order; user lines are ignored) after the first `verified`
 * (checked before) against the digests of admitted units (pure). A line matches when its words, or its words
 * joined with the next few lines', are an admitted unit or a sentence of one. A line that matches nothing is a
 * mismatch as soon as a later line matches on its own (the vendor moved on to other words), or when too many lines
 * follow it to be the rest of one unit; while nothing after it matches, it is pending. Counting lines (not the
 * vendor's timestamps) means a unit the vendor split over lines is always read again whole.
 */
export function reconcileFaceTranscript(input: {
  readonly callId: string;
  readonly lines: readonly FaceTranscriptLine[];
  readonly admitted: ReadonlySet<string>;
  /** Avatar lines verified by earlier checks. */
  readonly verified: number;
}): TranscriptVerdict {
  const lines = input.lines
    .filter((line) => line.role === 'avatar' && normalizeFaceWords(line.text) !== '')
    .slice(Math.max(0, input.verified));
  const matches = (from: number, to: number): boolean => {
    const words = lines
      .slice(from, to + 1)
      .map((line) => line.text)
      .join(' ');
    const digest = faceWordsDigest(input.callId, words);
    return digest !== null && input.admitted.has(digest);
  };
  const base = Math.max(0, input.verified);
  let i = 0;
  while (i < lines.length) {
    let matched = -1;
    for (let j = i; j < Math.min(lines.length, i + JOIN_WINDOW); j += 1) {
      if (matches(i, j)) {
        matched = j;
        break;
      }
    }
    if (matched >= 0) {
      i = matched + 1;
      continue;
    }
    // Nothing starting here matches: words never admitted, unless the vendor is still transcribing them.
    for (let k = i + 1; k < lines.length; k += 1) {
      if (matches(k, k)) return { verdict: 'mismatch' };
    }
    if (lines.length - i >= JOIN_WINDOW) return { verdict: 'mismatch' };
    return { verdict: 'pending', verified: base + i };
  }
  return { verdict: 'ok', verified: base + i };
}

/** Lines pending longer than this (two heartbeats and a little) are treated as words never admitted. */
export const FACE_TRANSCRIPT_PENDING_SECONDS = 35;
