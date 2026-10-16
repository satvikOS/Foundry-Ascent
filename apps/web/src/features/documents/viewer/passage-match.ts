import type { HastNode } from './find';

/*
 * Finding a cited passage in a document's own layout. A passage is extracted text (Markdown syntax and the
 * PDF's text runs included), so it is compared word by word with the rendered blocks or the PDF's text,
 * ignoring case, punctuation and Markdown.
 */

/** Lowercased words, everything but letters and digits removed. */
export function comparableWords(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '');
}

/** How many words in a row tie a block to a passage that starts or ends inside it. */
const ANCHOR_WORDS = 8;

function contains(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  return ` ${haystack.join(' ')} `.includes(` ${needle.join(' ')} `);
}

/** Whether the last words of `before` are the first words of `after` (at least `min` of them). */
function overlaps(before: string[], after: string[], min = 3): boolean {
  for (let k = Math.min(before.length, after.length); k >= min; k -= 1) {
    if (before.slice(-k).join(' ') === after.slice(0, k).join(' ')) return true;
  }
  return false;
}

/**
 * Which of a document's blocks (paragraphs, list items, headings, cells, in order) show the cited passage:
 * a block lies in it when all its words are in the passage, when it holds the passage's first or last
 * words, or when the passage starts or ends inside it (passages start and end inside paragraphs). The longest run of such consecutive blocks wins, so
 * a stray short block elsewhere is never marked. Returns their indices (empty when the passage is not found).
 */
export function citedBlocks(blocks: readonly string[], passage: string): number[] {
  const passageWords = comparableWords(passage);
  if (passageWords.length === 0) return [];
  const head = passageWords.slice(0, ANCHOR_WORDS);
  const tail = passageWords.slice(-ANCHOR_WORDS);
  const counts = blocks.map((block) => comparableWords(block));
  const inPassage = counts.map(
    (words) =>
      words.length > 0 &&
      (contains(passageWords, words) ||
        contains(words, head) ||
        contains(words, tail) ||
        // The passage starts inside this block, or ends inside it.
        overlaps(words, passageWords) ||
        overlaps(passageWords, words)),
  );
  // The run of consecutive blocks with the most words wins (the first one on a tie).
  let best: { from: number; to: number; words: number } | null = null;
  for (let i = 0; i < blocks.length; i += 1) {
    if (!inPassage[i]) continue;
    let j = i;
    while (j + 1 < blocks.length && inPassage[j + 1]) j += 1;
    const words = counts.slice(i, j + 1).reduce((n, w) => n + w.length, 0);
    if (best === null || words > best.words) best = { from: i, to: j, words };
    i = j;
  }
  // A run of nothing but a word or two (a heading that also occurs in the passage) is no match.
  if (best === null || best.words < Math.min(4, passageWords.length)) return [];
  const { from, to } = best;
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/**
 * Where the passage's words lie in a document's word stream: `[start, end)` word indices, found from a few
 * anchors (runs of words of the passage) so a stray difference in extraction does not lose it; null when
 * none of them occurs.
 */
export function locateWords(
  documentWords: readonly string[],
  passageWords: readonly string[],
): [number, number] | null {
  if (passageWords.length === 0 || documentWords.length === 0) return null;
  const joined = ` ${documentWords.join(' ')} `;
  // Character offset of each word in `joined` (each word is preceded by one space).
  const offsets: number[] = [];
  let at = 1;
  for (const word of documentWords) {
    offsets.push(at);
    at += word.length + 1;
  }
  const wordAt = (offset: number): number => {
    let lo = 0;
    let hi = offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((offsets[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const size = Math.min(6, passageWords.length);
  const find = (from: number): number | null => {
    const needle = ` ${passageWords.slice(from, from + size).join(' ')} `;
    const index = joined.indexOf(needle);
    return index === -1 ? null : wordAt(index + 1);
  };
  const step = Math.max(1, Math.floor(size / 2));
  let start: number | null = null;
  for (let from = 0; from + size <= passageWords.length && start === null; from += step) {
    const hit = find(from);
    if (hit !== null) start = Math.max(0, hit - from);
  }
  if (start === null) return null;
  let end = Math.min(documentWords.length, start + passageWords.length);
  // Prefer the passage's own last words when they occur after the start.
  const last = passageWords.length - size;
  if (last > 0) {
    const hit = find(last);
    if (hit !== null && hit + size > start) end = Math.min(documentWords.length, hit + size);
  }
  return [start, end];
}

const LEAF_BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'td', 'th', 'li', 'dt', 'dd']);

function textOf(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(textOf).join(' ');
}

function hasBlockChild(node: HastNode): boolean {
  return (node.children ?? []).some(
    (child) => child.type === 'element' && (LEAF_BLOCKS.has(child.tagName ?? '') || hasBlockChild(child)),
  );
}

/** rehype plugin: marks the blocks of the cited passage with `data-cited` (see {@link citedBlocks}). */
export function rehypeCitedBlocks(options: { passage: string | null }) {
  return (tree: HastNode): void => {
    if (!options.passage) return;
    const blocks: HastNode[] = [];
    const collect = (node: HastNode): void => {
      for (const child of node.children ?? []) {
        if (child.type !== 'element') continue;
        if (LEAF_BLOCKS.has(child.tagName ?? '') && !hasBlockChild(child)) blocks.push(child);
        else collect(child);
      }
    };
    collect(tree);
    for (const index of citedBlocks(blocks.map(textOf), options.passage)) {
      const block = blocks[index];
      if (block) block.properties = { ...block.properties, dataCited: 'true' };
    }
  };
}
