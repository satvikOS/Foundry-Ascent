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

/** At most this many digests per unit (its whole words and its sentences; `call_face_texts.digests`). */
const MAX_DIGESTS = 40;

/** The digests of an admitted unit, as `call_face_texts` keeps them. */
export interface FaceTextDigests {
  /**
   * The whole unit's words first (`wholes` of them: the words the browser says, and the signed words when they
   * differ), then each of its sentences in order, a repeated sentence as often as it occurs (none for a unit of
   * one sentence, whose sentence is the whole).
   */
  readonly digests: string[];
  readonly wholes: number;
}

/**
 * The digests of an admitted unit, so a vendor that transcribes a unit as one line or sentence by sentence matches
 * either way, and each piece can be said once. `also`: the same unit as signed, when its words may differ.
 */
export function faceTextDigests(callId: string, text: string, also?: string): FaceTextDigests {
  const wholes: string[] = [];
  for (const whole of also === undefined ? [text] : [text, also]) {
    const digest = faceWordsDigest(callId, whole);
    if (digest !== null && !wholes.includes(digest)) wholes.push(digest);
  }
  const sentences = text
    .split(/(?<=[.!?…])\s+/u)
    .map((part) => faceWordsDigest(callId, part))
    .filter((digest): digest is string => digest !== null);
  const pieces = sentences.length > 1 ? sentences : [];
  if (wholes.length === 0) return { digests: [], wholes: 0 };
  return { digests: [...wholes, ...pieces].slice(0, MAX_DIGESTS), wholes: wholes.length };
}

/** Consecutive transcript lines that may together make one admitted unit (a vendor splitting a long one). */
const JOIN_WINDOW = 6;

/**
 * A unit a FULL face was allowed to say, with what of it the face already said: `said` has bit `i` set once
 * `digests[i]` was matched. A whole digest matches only while nothing of the unit was said (and then sets every
 * bit); a sentence matches once. So every admitted unit is said at most once.
 */
export interface AdmittedFaceUnit {
  /** `call_face_texts.unit`. */
  readonly unit: string;
  readonly digests: readonly string[];
  readonly wholes: number;
  readonly said: number;
}

/** Where the last check stopped: after the first `skip` avatar lines at the vendor timestamp `at`. */
export interface TranscriptCursor {
  readonly at: number | null;
  readonly skip: number;
}

/** The avatar lines a check has not verified yet: user lines and lines with no words are never checked. */
export function linesAfter(
  lines: readonly FaceTranscriptLine[],
  cursor: TranscriptCursor,
): FaceTranscriptLine[] {
  let skip = cursor.at === null ? 0 : cursor.skip;
  return lines.filter((line) => {
    if (line.role !== 'avatar' || normalizeFaceWords(line.text) === '') return false;
    if (cursor.at === null) return true;
    if (line.at < cursor.at) return false;
    if (line.at === cursor.at && skip > 0) {
      skip -= 1;
      return false;
    }
    return true;
  });
}

/** The cursor after the first `verified` of the lines `linesAfter` gave were verified. */
export function cursorAfter(
  cursor: TranscriptCursor,
  lines: readonly FaceTranscriptLine[],
  verified: number,
): TranscriptCursor {
  const last = lines[verified - 1];
  if (verified <= 0 || last === undefined) return cursor;
  const sameSecond = lines.slice(0, verified).filter((line) => line.at === last.at).length;
  return { at: last.at, skip: sameSecond + (cursor.at === last.at ? cursor.skip : 0) };
}

export type TranscriptVerdict =
  /**
   * Every line is admitted words. `verified`: the lines checked; `said`: the new `said` of each unit they matched.
   */
  | { readonly verdict: 'ok'; readonly verified: number; readonly said: ReadonlyMap<string, number> }
  /**
   * The last lines match nothing yet (a unit the vendor is still splitting over lines, or words never admitted):
   * read again next time, and an injection if they still match nothing then, or when the face ends.
   */
  | { readonly verdict: 'pending'; readonly verified: number; readonly said: ReadonlyMap<string, number> }
  /** The avatar said words the server never admitted, or said an admitted unit again (a tampered page). */
  | { readonly verdict: 'mismatch'; readonly why: 'words_not_admitted' | 'said_again' };

/**
 * Checks avatar lines (in order, from `linesAfter`) against the units the face was allowed to say (pure). A line
 * matches when its words, or its words joined with the next few lines', are a unit or a sentence of one that the
 * face has not said yet. Words of a unit it already said are a mismatch at once (`said_again`), so a page can
 * neither replay admitted words nor flood the transcript with them. A line that matches nothing is a mismatch as
 * soon as a later line matches admitted words on its own (the vendor moved on), or when too many lines follow it to
 * be the rest of one unit; while nothing after it matches, it is pending.
 */
export function reconcileFaceTranscript(input: {
  readonly callId: string;
  readonly lines: readonly FaceTranscriptLine[];
  readonly units: readonly AdmittedFaceUnit[];
}): TranscriptVerdict {
  const lines = input.lines;
  const said = new Map<string, number>();
  const saidOf = (unit: AdmittedFaceUnit): number => said.get(unit.unit) ?? unit.said;
  const digestOf = (from: number, to: number): string | null =>
    faceWordsDigest(
      input.callId,
      lines
        .slice(from, to + 1)
        .map((line) => line.text)
        .join(' '),
    );
  const admitted = (digest: string | null): boolean =>
    digest !== null && input.units.some((unit) => unit.digests.includes(digest));
  /** The first unit (in admission order) that may still say `digest`, and what it has said after it. */
  const take = (digest: string | null): { readonly unit: string; readonly said: number } | null => {
    if (digest === null) return null;
    for (const unit of input.units) {
      const before = saidOf(unit);
      const all = 2 ** unit.digests.length - 1;
      for (let i = 0; i < unit.digests.length; i += 1) {
        if (unit.digests[i] !== digest) continue;
        if (i < unit.wholes) {
          if (before === 0) return { unit: unit.unit, said: all };
        } else if (Math.floor(before / 2 ** i) % 2 === 0) {
          return { unit: unit.unit, said: before + 2 ** i };
        }
      }
    }
    return null;
  };
  let i = 0;
  while (i < lines.length) {
    let matched = -1;
    let again = false;
    for (let j = i; j < Math.min(lines.length, i + JOIN_WINDOW); j += 1) {
      const digest = digestOf(i, j);
      const taken = take(digest);
      if (taken !== null) {
        said.set(taken.unit, taken.said);
        matched = j;
        break;
      }
      if (admitted(digest)) again = true;
    }
    if (matched >= 0) {
      i = matched + 1;
      continue;
    }
    if (again) return { verdict: 'mismatch', why: 'said_again' };
    // Nothing starting here matches: words never admitted, unless the vendor is still splitting them.
    for (let k = i + 1; k < lines.length; k += 1) {
      if (admitted(digestOf(k, k))) return { verdict: 'mismatch', why: 'words_not_admitted' };
    }
    if (lines.length - i >= JOIN_WINDOW) return { verdict: 'mismatch', why: 'words_not_admitted' };
    return { verdict: 'pending', verified: i, said };
  }
  return { verdict: 'ok', verified: i, said };
}

/**
 * Lines still matching nothing this long after a check first saw them are words never admitted. The vendor
 * transcribes a `speak_text` as it is sent, so the next heartbeat (15 s on) always finds them; a few seconds only
 * cover a vendor splitting one unit over lines while a check reads it.
 */
export const FACE_TRANSCRIPT_PENDING_SECONDS = 5;

/** A live FULL face whose transcript could not be read in full for this long stops (it never goes unchecked). */
export const FACE_TRANSCRIPT_UNREAD_SECONDS = 60;
