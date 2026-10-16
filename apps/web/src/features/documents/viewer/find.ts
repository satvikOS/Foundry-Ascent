/*
 * Find in document: where a query occurs in a text, and a rehype plugin that wraps each occurrence of the
 * rendered Markdown in <mark data-find-index> (in reading order), so React owns every highlight.
 */

/** At most this many matches are marked (a one-letter query in a long document stays responsive). */
export const MAX_FIND_MATCHES = 1000;

const SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** The query as a regular expression: case-insensitive, any whitespace in it matches any run of whitespace. */
export function findPattern(query: string): RegExp | null {
  const trimmed = query.trim();
  if (trimmed === '') return null;
  const source = trimmed
    .split(/\s+/)
    .map((part) => part.replace(SPECIAL, '\\$&'))
    .join('\\s+');
  return new RegExp(source, 'giu');
}

/** `[start, end)` of every occurrence of `query` in `text`, at most `limit`. */
export function findRanges(text: string, query: string, limit = MAX_FIND_MATCHES): [number, number][] {
  const pattern = findPattern(query);
  if (pattern === null || limit <= 0) return [];
  const ranges: [number, number][] = [];
  for (const match of text.matchAll(pattern)) {
    if (match[0] === '') continue;
    ranges.push([match.index, match.index + match[0].length]);
    if (ranges.length >= limit) break;
  }
  return ranges;
}

export interface TextSegment {
  readonly text: string;
  /** The match's index in the whole document, or null for plain text. */
  readonly match: number | null;
}

/**
 * Splits `text` around the occurrences of `query`, numbering them from `counter.next` (which it advances),
 * so several blocks of one document share one numbering.
 */
export function segmentText(text: string, query: string, counter: { next: number }): TextSegment[] {
  const ranges = findRanges(text, query, MAX_FIND_MATCHES - counter.next);
  if (ranges.length === 0) return [{ text, match: null }];
  const segments: TextSegment[] = [];
  let last = 0;
  for (const [start, end] of ranges) {
    if (start > last) segments.push({ text: text.slice(last, start), match: null });
    segments.push({ text: text.slice(start, end), match: counter.next });
    counter.next += 1;
    last = end;
  }
  if (last < text.length) segments.push({ text: text.slice(last), match: null });
  return segments;
}

/** The parts of a hast tree the plugins touch. */
export interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** rehype plugin: wraps every occurrence of `query` in a text node in <mark data-find-index="n">. */
export function rehypeFindMarks(options: { query: string }) {
  return (tree: HastNode): void => {
    if (findPattern(options.query) === null) return;
    const counter = { next: 0 };
    const visit = (node: HastNode): void => {
      if (!node.children) return;
      const next: HastNode[] = [];
      for (const child of node.children) {
        if (child.type === 'text' && child.value) {
          for (const segment of segmentText(child.value, options.query, counter)) {
            next.push(
              segment.match === null
                ? { type: 'text', value: segment.text }
                : {
                    type: 'element',
                    tagName: 'mark',
                    properties: { dataFindIndex: String(segment.match) },
                    children: [{ type: 'text', value: segment.text }],
                  },
            );
          }
        } else {
          visit(child);
          next.push(child);
        }
      }
      node.children = next;
    };
    visit(tree);
  };
}
