/**
 * The cited corpus: short notes in our own words, each with the passage it comes from (locator), the page it can be read
 * on, its licence and its attribution, so an answer can show exactly what supports it.
 *
 * - the programme's course notes (`../seed/programme-notes.ts`), in the programme's own tenant, scope `program`;
 * - the open library (`knowledge/open-library`): U.S. government pages and CC BY-SA textbooks, every tenant, scope
 *   `public`. Licences: `knowledge/open-library/LICENSE.md`.
 */
import { createHash } from 'node:crypto';

import rawLibrary from '../../knowledge/open-library/open_library.json' with { type: 'json' };
import { PROGRAMME_NOTES, PROGRAMME_NOTES_URI_PREFIX } from '../seed/programme-notes.js';
import { contentTerms, PLATFORM_WORDS } from './query-terms.js';
import { stem } from './stem.js';
import { corpusTopics, isCorpusTopic, type CorpusTopic } from './topics.js';

export interface CorpusNote {
  readonly heading: string;
  /** At most {@link MAX_NOTE_CHARS} characters, so the coach reads all of it. */
  readonly content: string;
  /** Where in the source: module, unit and timestamp, section or chapter. */
  readonly locator: string;
}

export interface CorpusSource {
  readonly key: string;
  /** `knowledge_sources.uri`. */
  readonly uri: string;
  readonly title: string;
  readonly kind: 'note' | 'document';
  readonly topics: readonly CorpusTopic[];
  /** Keys of the playbook's source list (`PlaySource.id`) that mean this source. */
  readonly playSources: readonly string[];
  /** A public page about or of the source. */
  readonly url: string;
  readonly licence: string;
  readonly attribution: string;
  /** ISO date the source was read. */
  readonly accessedOn: string;
  readonly notes: readonly CorpusNote[];
}

export const MAX_NOTE_CHARS = 550;
/** URI prefix of the open library's sources. */
export const LIBRARY_URI_PREFIX = 'library:';
export { PROGRAMME_NOTES_URI_PREFIX };

interface RawSource {
  readonly key: string;
  readonly title: string;
  readonly publisher: string;
  readonly url: string;
  readonly licence: string;
  readonly attribution: string;
  readonly accessed: string;
  readonly topics: readonly string[];
  readonly playSources: readonly string[];
  readonly notes: readonly { readonly heading: string; readonly locator: string; readonly content: string }[];
}

function librarySource(raw: RawSource): CorpusSource {
  return {
    key: raw.key,
    uri: `${LIBRARY_URI_PREFIX}${raw.key}`,
    // A book's title names its author; a page's, who publishes it.
    title: raw.publisher.startsWith('University') ? raw.title : `${raw.title} (${raw.publisher})`,
    kind: 'document',
    topics: raw.topics.map((t) => {
      if (!isCorpusTopic(t)) throw new Error(`open library: unknown topic ${t} in ${raw.key}`);
      return t;
    }),
    playSources: raw.playSources,
    url: raw.url,
    licence: raw.licence,
    attribution: raw.attribution,
    accessedOn: raw.accessed,
    notes: raw.notes,
  };
}

export const OPEN_LIBRARY: readonly CorpusSource[] = (
  rawLibrary as { readonly sources: readonly RawSource[] }
).sources.map(librarySource);

/** Every source of the corpus; the programme's first. */
export const CORPUS: readonly CorpusSource[] = [...PROGRAMME_NOTES, ...OPEN_LIBRARY];

/** What the document viewer shows of a source: its notes, then where they come from. */
export function corpusBody(source: CorpusSource): string {
  return [
    ...source.notes.map((n) => `## ${n.heading}\n\n${n.content}\n\n_${n.locator}_`),
    `## Source\n\n${source.attribution}. ${source.url} (read ${source.accessedOn}). Licence: ${source.licence}.`,
  ].join('\n\n');
}

/** Identifies a source's stored text: a change re-ingests it. */
export function corpusChecksum(source: CorpusSource): string {
  const { title, url, licence, attribution, accessedOn, notes } = source;
  return `corpus:sha256:${createHash('sha256')
    .update(JSON.stringify([title, url, licence, attribution, accessedOn, notes]), 'utf8')
    .digest('hex')}`;
}

/** `knowledge_sources.uri`s of the sources about any of `topics`. */
export function corpusUrisForTopics(topics: readonly CorpusTopic[]): string[] {
  if (topics.length === 0) return [];
  const wanted = new Set(topics);
  return CORPUS.filter((s) => s.topics.some((t) => wanted.has(t))).map((s) => s.uri);
}

/** What the founder's own message asks the corpus for. */
export function corpusUrisForMessage(founderText: string): string[] {
  return corpusUrisForTopics(corpusTopics(founderText));
}

export interface CitedSource {
  readonly sourceId: string;
  readonly locator: string | null;
}

/** Sources of one play citation, narrowed by "Module 2, Unit 1" in a programme locator. */
function urisOfCitation(citation: CitedSource): string[] {
  const sources = CORPUS.filter((s) => s.playSources.includes(citation.sourceId));
  if (!sources.some((s) => s.uri.startsWith(PROGRAMME_NOTES_URI_PREFIX))) {
    // A locator that names one of the source's pages ("Choose a business structure") means that page.
    const named = (citation.locator ?? '').trim().toLowerCase();
    const pages = named === '' ? [] : sources.filter((s) => s.title.toLowerCase().includes(named));
    return (pages.length > 0 ? pages : sources).map((s) => s.uri);
  }
  // The programme's material is one source to the playbook: only a named unit says which notes.
  const unit = /module\s*(\d)\D{0,12}unit\s*(\d)/i.exec(citation.locator ?? '');
  if (unit === null) return [];
  return sources
    .filter((s) => s.uri.startsWith(`${PROGRAMME_NOTES_URI_PREFIX}m${unit[1] ?? ''}u${unit[2] ?? ''}-`))
    .map((s) => s.uri);
}

/** The corpus sources a play's citations mean, one list per citation that means any. */
export function corpusUrisForCitations(citations: readonly CitedSource[]): string[][] {
  return citations.map(urisOfCitation).filter((uris) => uris.length > 0);
}

/** The play a turn answers with, as far as its cited notes are chosen by it. */
export interface CitingPlay {
  readonly title: string;
  /** Its answer and why. */
  readonly text: string;
  readonly citations: readonly CitedSource[];
}

/**
 * How much a note must be about the play that cites its source ({@link pinnedNote}). A play cites a whole unit of the
 * programme for one point of it: below this, none of the unit's notes supports what the play says (a client's run: a
 * note on cold outreach was shown, and cited, for "Tell me my idea is great").
 */
export const PIN_FLOOR = 0.19;

interface IndexedNote {
  readonly uri: string;
  /** `knowledge_chunks.ordinal`. */
  readonly ordinal: number;
  readonly words: readonly string[];
  readonly heading: readonly string[];
}

/**
 * The distinct stemmed content words of a text of any length (a query's are cut, {@link contentTerms}), without those
 * every venture uses ("idea", "customer"): sharing them says nothing.
 */
function subjectWords(text: string): string[] {
  return [
    ...new Set(
      text.split(/(?<=[.?!:])\s/).flatMap((s) =>
        contentTerms(s)
          .filter((w) => !PLATFORM_WORDS.has(w))
          .map(stem),
      ),
    ),
  ];
}

let noteIndex: { readonly notes: readonly IndexedNote[]; readonly idf: (word: string) => number } | null =
  null;

function indexedNotes(): NonNullable<typeof noteIndex> {
  if (noteIndex !== null) return noteIndex;
  const notes = CORPUS.flatMap((source) =>
    source.notes.map((note, i) => ({
      uri: source.uri,
      ordinal: i + 1,
      words: subjectWords(`${note.heading}. ${note.content}`),
      heading: subjectWords(note.heading),
    })),
  );
  const held = new Map<string, number>();
  for (const { words } of notes) for (const w of words) held.set(w, (held.get(w) ?? 0) + 1);
  noteIndex = {
    notes,
    idf: (word) => {
      const n = held.get(word) ?? 0;
      return Math.log(1 + (notes.length - n + 0.5) / (n + 0.5));
    },
  };
  return noteIndex;
}

/**
 * How much a note is about a play: the cosine of their content words weighted by rarity, plus a little for how much of
 * the play's title the note holds and of the note's heading the play holds. Deterministic, no database.
 */
function aboutPlay(note: IndexedNote, play: { title: readonly string[]; words: readonly string[] }): number {
  const { idf } = indexedNotes();
  const sum = (words: readonly string[], power: number): number =>
    words.reduce((acc, w) => acc + idf(w) ** power, 0);
  const share = (part: readonly string[], whole: readonly string[]): number => {
    const total = sum(whole, 1);
    return total === 0
      ? 0
      : sum(
          whole.filter((w) => part.includes(w)),
          1,
        ) / total;
  };
  const size = Math.sqrt(sum(note.words, 2)) * Math.sqrt(sum(play.words, 2));
  const shared = sum(
    note.words.filter((w) => play.words.includes(w)),
    2,
  );
  return (
    (size === 0 ? 0 : shared / size) +
    0.08 * share(note.words, play.title) +
    0.05 * share(play.words, note.heading)
  );
}

/**
 * The one note of the sources a play cites that is most about the play itself, or null when none of them is
 * ({@link PIN_FLOOR}): always evidence of a turn that answers with the play, whatever the founder's words are.
 */
export function pinnedNote(play: CitingPlay): { readonly uri: string; readonly ordinal: number } | null {
  const uris = new Set(corpusUrisForCitations(play.citations).flat());
  if (uris.size === 0) return null;
  const about = { title: subjectWords(play.title), words: subjectWords(`${play.title}. ${play.text}`) };
  let best: { note: IndexedNote; score: number } | null = null;
  for (const note of indexedNotes().notes) {
    if (!uris.has(note.uri)) continue;
    const score = aboutPlay(note, about);
    if (score >= PIN_FLOOR && (best === null || score > best.score)) best = { note, score };
  }
  return best === null ? null : { uri: best.note.uri, ordinal: best.note.ordinal };
}
