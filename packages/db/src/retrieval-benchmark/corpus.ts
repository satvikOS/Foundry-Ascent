/**
 * The passages of the retrieval benchmark (docs/runbooks/conversation-lab.md, "Models benchmark"): the shared knowledge
 * production holds, cut into passages exactly as the seed, the pack sync and the corpus sync store them and with exactly
 * the text production embeds (`embedText`), each with an id that stays the same as long as the passage does. No
 * venture's record, no founder's words: shared, committed text only.
 *
 * - `skb/<item>#<n>`: the startup knowledge base (frameworks, documented cases, lifecycle stages);
 * - `curriculum/<source>#<n>`: the programme's curriculum notes;
 * - `notes/<source>#<n>` and `open/<source>#<n>`: the cited corpus (the programme's course notes, the open library);
 * - `method/<source>#<n>`: the programme handbook;
 * - `doctrine/<persona>/<framework>`: a framework of an approved doctrine (stored as passages for the Foundry Guide
 *   only; the others are in their vEIR's release, read whole, and are here as hard neighbours);
 * - `library/<persona>/<item>#<n>` and `lesson/<persona>/<lesson>`: a persona's library and published lessons;
 * - `play/<id>`: a play of the founder path's playbook (title, answer, why). The playbook is `@foundry/core`'s, so the
 *   caller passes it; production chooses a play by the path's rules and never by similarity.
 */
import { CORPUS, PROGRAMME_NOTES_URI_PREFIX } from '../knowledge-pack/corpus.js';
import { loadKnowledgePack } from '../knowledge-pack/pack.js';
import { packItems } from '../knowledge-pack/render.js';
import { AIN_CURRICULUM } from '../seed/curriculum.js';
import { GUIDE_DOCTRINE, PROGRAM_METHOD_SOURCE } from '../seed/doctrine.js';
import { THOMAS_RELEASE } from '../seed/owner-releases.js';
import { CORIN_VEIR, RUTH_VEIR, sectionChunks, type SeedVeir } from '../seed/veir-content.js';

export interface BenchmarkPassage {
  readonly id: string;
  /** `<source> — <heading>`, as evidence is titled. */
  readonly title: string;
  readonly source: string | null;
  readonly heading: string | null;
  readonly text: string;
  /** What production embeds for it: the heading and the text (`knowledgeRepo.listChunksMissingEmbeddings`). */
  readonly embedText: string;
  /** Where production keeps it: a retrievable chunk, a lesson (found by its words), a play, or a vEIR's release. */
  readonly store: 'chunk' | 'lesson' | 'play' | 'release';
}

/** A play as the benchmark reads it (`PLAYBOOK.plays` of `@foundry/core`). */
export interface BenchmarkPlay {
  readonly id: string;
  readonly title: string;
  readonly answer: string;
  readonly why: string;
}

function passage(
  id: string,
  source: string | null,
  heading: string | null,
  text: string,
  store: BenchmarkPassage['store'] = 'chunk',
): BenchmarkPassage {
  return {
    id,
    title: [source, heading].filter((x) => x !== null && x !== '').join(' — '),
    source,
    heading,
    text,
    embedText: heading === null || heading === '' ? text : `${heading}\n\n${text}`,
    store,
  };
}

interface Framework {
  readonly name: string;
  readonly whenToUse: string;
  readonly keyQuestions: readonly string[];
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function doctrinePassages(
  persona: string,
  title: string,
  frameworks: readonly Framework[],
  store: BenchmarkPassage['store'],
): BenchmarkPassage[] {
  return frameworks.map((f) =>
    passage(
      `doctrine/${persona}/${slug(f.name)}`,
      title,
      f.name,
      // As seed.ts stores the Foundry Guide's.
      `${f.whenToUse}\n\nKey questions:\n${f.keyQuestions.map((q) => `- ${q}`).join('\n')}`,
      store,
    ),
  );
}

function veirPassages(persona: string, veir: SeedVeir): BenchmarkPassage[] {
  return [
    ...doctrinePassages(persona, `${veir.name} (approach)`, veir.doctrine.frameworks, 'release'),
    ...veir.library.flatMap((item) =>
      sectionChunks(item.body).map((chunk, i) =>
        // As veir.ts stores it: the item's title is in the heading too.
        passage(
          `library/${persona}/${item.key}#${String(i + 1)}`,
          item.title,
          chunk.heading === null ? item.title : `${item.title}: ${chunk.heading}`,
          chunk.content,
        ),
      ),
    ),
    ...veir.lessons.map((lesson) =>
      passage(
        `lesson/${persona}/${lesson.key}`,
        null,
        lesson.title,
        `${lesson.context} ${lesson.signal} ${lesson.intervention} ${lesson.outcome} ${lesson.limits}`,
        'lesson',
      ),
    ),
  ];
}

/** Every passage, in a stable order; `plays` are the playbook's (`@foundry/core`). */
export function benchmarkPassages(plays: readonly BenchmarkPlay[] = []): BenchmarkPassage[] {
  return [
    ...packItems(loadKnowledgePack()).flatMap((item) =>
      item.passages.map((p, i) =>
        passage(`skb/${item.key}#${String(i + 1)}`, item.title, p.heading, p.content),
      ),
    ),
    ...AIN_CURRICULUM.flatMap((source) =>
      source.chunks.map((chunk, i) =>
        passage(`curriculum/${source.key}#${String(i + 1)}`, source.title, chunk.heading, chunk.content),
      ),
    ),
    ...CORPUS.flatMap((source) => {
      const notes = source.uri.startsWith(PROGRAMME_NOTES_URI_PREFIX);
      const key = notes ? source.uri.slice(PROGRAMME_NOTES_URI_PREFIX.length) : source.key;
      return source.notes.map((note, i) =>
        passage(
          `${notes ? 'notes' : 'open'}/${key}#${String(i + 1)}`,
          source.title,
          note.heading,
          note.content,
        ),
      );
    }),
    ...PROGRAM_METHOD_SOURCE.chunks.map((chunk, i) =>
      passage(
        `method/${PROGRAM_METHOD_SOURCE.key}#${String(i + 1)}`,
        PROGRAM_METHOD_SOURCE.title,
        chunk.heading,
        chunk.content,
      ),
    ),
    ...doctrinePassages('guide', 'Foundry Guide doctrine (release v1)', GUIDE_DOCTRINE.frameworks, 'chunk'),
    passage(
      'doctrine/guide/evidence-standard',
      'Foundry Guide doctrine (release v1)',
      'Evidence standard',
      GUIDE_DOCTRINE.evidenceStandard,
    ),
    ...doctrinePassages('thomas', 'Thomas (approach)', THOMAS_RELEASE.doctrine.frameworks, 'release'),
    ...veirPassages('corin', CORIN_VEIR),
    ...veirPassages('ruth', RUTH_VEIR),
    ...plays.map((play) =>
      passage(`play/${play.id}`, 'Playbook', play.title, `${play.answer} ${play.why}`, 'play'),
    ),
  ];
}
