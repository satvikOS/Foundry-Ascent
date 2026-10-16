import { findRanges, MAX_FIND_MATCHES } from './find';
import { comparableWords, locateWords } from './passage-match';

/*
 * A PDF page's text as pdf.js lays it out: one text run per item (the text layer draws one span per item,
 * in the same order). Find and the cited passage work on these runs and come back as item ranges.
 */

export interface PageRuns {
  /** Text of each run, in the order the text layer draws them. */
  readonly items: readonly string[];
  /** Whether a line break follows the run. */
  readonly eol: readonly boolean[];
}

export interface PageIndex {
  /** The page's text: runs joined, a line break after each that ends a line. */
  readonly text: string;
  /** Where each run starts in `text`. */
  readonly starts: readonly number[];
}

export function indexPage(page: PageRuns): PageIndex {
  const starts: number[] = [];
  let text = '';
  page.items.forEach((item, i) => {
    starts.push(text.length);
    text += item;
    if (page.eol[i]) text += '\n';
  });
  return { text, starts };
}

/** One find match on a page: the part of each run it covers (`from`/`to` within the run's text). */
export interface PageMatch {
  readonly page: number;
  readonly parts: readonly { readonly item: number; readonly from: number; readonly to: number }[];
}

function partsOf(index: PageIndex, items: readonly string[], start: number, end: number): PageMatch['parts'] {
  const parts: { item: number; from: number; to: number }[] = [];
  index.starts.forEach((itemStart, item) => {
    const length = items[item]?.length ?? 0;
    const from = Math.max(start, itemStart);
    const to = Math.min(end, itemStart + length);
    if (to > from) parts.push({ item, from: from - itemStart, to: to - itemStart });
  });
  return parts;
}

/** Every occurrence of `query` in the document, page by page, in reading order (at most the find limit). */
export function findInPages(pages: readonly (PageRuns | undefined)[], query: string): PageMatch[] {
  const matches: PageMatch[] = [];
  pages.forEach((page, pageIndex) => {
    if (!page || matches.length >= MAX_FIND_MATCHES) return;
    const index = indexPage(page);
    for (const [start, end] of findRanges(index.text, query, MAX_FIND_MATCHES - matches.length)) {
      const parts = partsOf(index, page.items, start, end);
      if (parts.length > 0) matches.push({ page: pageIndex, parts });
    }
  });
  return matches;
}

/**
 * The runs that show a cited passage, by page (`page index → run indices`), found word by word across the
 * whole document (a passage can cross pages); empty when it is not found.
 */
export function citedRuns(
  pages: readonly (PageRuns | undefined)[],
  passage: string,
): Map<number, Set<number>> {
  const words: string[] = [];
  const refs: { page: number; item: number }[] = [];
  pages.forEach((page, pageIndex) => {
    page?.items.forEach((item, itemIndex) => {
      for (const word of comparableWords(item)) {
        words.push(word);
        refs.push({ page: pageIndex, item: itemIndex });
      }
    });
  });
  const cited = new Map<number, Set<number>>();
  const found = locateWords(words, comparableWords(passage));
  if (found === null) return cited;
  for (const ref of refs.slice(found[0], found[1])) {
    const set = cited.get(ref.page) ?? new Set<number>();
    set.add(ref.item);
    cited.set(ref.page, set);
  }
  return cited;
}
