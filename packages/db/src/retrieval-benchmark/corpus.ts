/**
 * The passages of the retrieval benchmark (docs/runbooks/conversation-lab.md, "Models benchmark"): the repository's
 * own shared knowledge, cut into passages exactly as the seed and the pack sync store them, with an id that stays
 * the same as long as the passage does. No venture's record, no founder's words: shared, committed text only.
 *
 * - `skb/<item>#<n>`: the startup knowledge base (frameworks, documented cases, lifecycle stages);
 * - `curriculum/<source>#<n>`: the programme's curriculum notes;
 * - `method/<source>#<n>`: the programme handbook;
 * - `doctrine/<persona>/<framework>`: a framework of an approved doctrine;
 * - `library/<persona>/<item>#<n>` and `lesson/<persona>/<lesson>`: a persona's library and published lessons.
 */
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
  readonly text: string;
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
): BenchmarkPassage[] {
  return frameworks.map((f) => ({
    id: `doctrine/${persona}/${slug(f.name)}`,
    title: `${title} — ${f.name}`,
    text: `${f.whenToUse} Questions: ${f.keyQuestions.join(' ')}`,
  }));
}

function veirPassages(persona: string, veir: SeedVeir): BenchmarkPassage[] {
  return [
    ...doctrinePassages(persona, `${veir.name} (approach)`, veir.doctrine.frameworks),
    ...veir.library.flatMap((item) =>
      sectionChunks(item.body).map((chunk, i) => ({
        id: `library/${persona}/${item.key}#${String(i + 1)}`,
        title: chunk.heading === null ? item.title : `${item.title} — ${chunk.heading}`,
        text: chunk.content,
      })),
    ),
    ...veir.lessons.map((lesson) => ({
      id: `lesson/${persona}/${lesson.key}`,
      title: lesson.title,
      text: `${lesson.context} ${lesson.signal} ${lesson.intervention} ${lesson.outcome} ${lesson.limits}`,
    })),
  ];
}

/** Every passage, in a stable order. */
export function benchmarkPassages(): BenchmarkPassage[] {
  return [
    ...packItems(loadKnowledgePack()).flatMap((item) =>
      item.passages.map((p, i) => ({
        id: `skb/${item.key}#${String(i + 1)}`,
        title: `${item.title} — ${p.heading}`,
        text: p.content,
      })),
    ),
    ...AIN_CURRICULUM.flatMap((source) =>
      source.chunks.map((chunk, i) => ({
        id: `curriculum/${source.key}#${String(i + 1)}`,
        title: `${source.title} — ${chunk.heading}`,
        text: chunk.content,
      })),
    ),
    ...PROGRAM_METHOD_SOURCE.chunks.map((chunk, i) => ({
      id: `method/${PROGRAM_METHOD_SOURCE.key}#${String(i + 1)}`,
      title: `${PROGRAM_METHOD_SOURCE.title} — ${chunk.heading}`,
      text: chunk.content,
    })),
    ...doctrinePassages('guide', 'Foundry Guide (approach)', GUIDE_DOCTRINE.frameworks),
    ...doctrinePassages('thomas', 'Thomas (approach)', THOMAS_RELEASE.doctrine.frameworks),
    ...veirPassages('corin', CORIN_VEIR),
    ...veirPassages('ruth', RUTH_VEIR),
  ];
}
