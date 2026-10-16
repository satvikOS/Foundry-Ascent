import { describe, expect, it } from 'vitest';

import { findRanges, rehypeFindMarks, segmentText, type HastNode } from './find';
import { citedBlocks, comparableWords, locateWords, rehypeCitedBlocks } from './passage-match';
import { citedRuns, findInPages } from './pdf-text';
import { validateDocumentViewerSearch, viewerSearchFor, viewerTarget } from './viewer-search';

const DOC = '6a1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d';
const PASSAGE = '7b2c3d4e-5f6a-4b8c-9d0e-1f2a3b4c5d6e';

describe('find', () => {
  it('finds every occurrence regardless of case, and any whitespace between words', () => {
    expect(findRanges('Quiet seats. QUIET\nseats, quiet  seats', 'quiet seats')).toEqual([
      [0, 11],
      [13, 24],
      [26, 38],
    ]);
    expect(findRanges('a+b (c)', 'b (c')).toEqual([[2, 6]]);
    expect(findRanges('anything', '   ')).toEqual([]);
  });

  it('numbers matches across blocks of one document', () => {
    const counter = { next: 0 };
    expect(segmentText('one seat, two seats', 'seat', counter)).toEqual([
      { text: 'one ', match: null },
      { text: 'seat', match: 0 },
      { text: ', two ', match: null },
      { text: 'seat', match: 1 },
      { text: 's', match: null },
    ]);
    expect(segmentText('no match here', 'seat', counter)).toEqual([{ text: 'no match here', match: null }]);
    expect(segmentText('Seat', 'seat', counter)).toEqual([{ text: 'Seat', match: 2 }]);
  });

  it('wraps matches of the rendered Markdown in numbered marks', () => {
    const tree: HastNode = {
      type: 'root',
      children: [
        { type: 'element', tagName: 'p', children: [{ type: 'text', value: 'Seats fill by noon.' }] },
        {
          type: 'element',
          tagName: 'p',
          children: [
            { type: 'element', tagName: 'strong', children: [{ type: 'text', value: 'Seats' }] },
            { type: 'text', value: ' again' },
          ],
        },
      ],
    };
    rehypeFindMarks({ query: 'seats' })(tree);
    const marks: HastNode[] = [];
    const walk = (node: HastNode): void => {
      if (node.tagName === 'mark') marks.push(node);
      node.children?.forEach(walk);
    };
    walk(tree);
    expect(marks.map((m) => m.properties?.dataFindIndex)).toEqual(['0', '1']);
  });
});

describe('cited passage', () => {
  const blocks = [
    'Library study',
    'Students arrive at eight and the east wing fills first.',
    'By noon every seat on the third floor is taken, so students leave.',
    'Findings',
    'Something unrelated about the cafeteria menu and opening hours.',
  ];

  it('marks the run of blocks the passage covers, Markdown and punctuation aside', () => {
    const passage =
      'Students arrive at **eight** and the east wing fills first.\n\nBy noon every seat on the third floor is taken, so students leave.';
    expect(citedBlocks(blocks, passage)).toEqual([1, 2]);
  });

  it('marks a paragraph the passage starts or ends inside', () => {
    const passage =
      'east wing fills first. By noon every seat on the third floor is taken, so students leave.';
    expect(citedBlocks(blocks, passage)).toEqual([1, 2]);
  });

  it('marks nothing when the passage is not there, or only a heading word matches', () => {
    expect(citedBlocks(blocks, 'A passage about parking permits and bike racks near campus.')).toEqual([]);
    expect(citedBlocks(blocks, 'Findings about parking permits near the library')).toEqual([]);
  });

  it('marks the blocks of a rendered Markdown tree', () => {
    const tree: HastNode = {
      type: 'root',
      children: blocks.map((text) => ({
        type: 'element',
        tagName: 'p',
        children: [{ type: 'text', value: text }],
      })),
    };
    rehypeCitedBlocks({ passage: blocks[2] ?? '' })(tree);
    expect(tree.children?.map((b) => b.properties?.dataCited ?? null)).toEqual([
      null,
      null,
      'true',
      null,
      null,
    ]);
  });

  it('locates the passage words in a document word stream from anchors', () => {
    const document = comparableWords('Intro text. ' + blocks.join(' ') + ' The end.');
    const passage = comparableWords(blocks[2] ?? '');
    const found = locateWords(document, passage);
    expect(found).not.toBeNull();
    const [start, end] = found ?? [0, 0];
    expect(document.slice(start, end)).toEqual(passage);
    // A small extraction difference in the middle still finds it.
    const changed = [...passage.slice(0, 7), 'xx', ...passage.slice(8)];
    expect(locateWords(document, changed)).toEqual(found);
    expect(locateWords(document, comparableWords('nothing like it anywhere here at all'))).toBeNull();
  });

  it('maps a passage to PDF text runs across pages', () => {
    const pages = [
      { items: ['Seat study', 'Students arrive at eight and'], eol: [true, true] },
      { items: ['the east wing fills first.', 'Unrelated footer'], eol: [true, false] },
    ];
    const cited = citedRuns(pages, 'Students arrive at eight and the east wing fills first.');
    expect([...cited.entries()].map(([page, items]) => [page, [...items]])).toEqual([
      [0, [1]],
      [1, [0]],
    ]);
  });

  it('finds text in PDF runs, a match crossing runs included', () => {
    const pages = [{ items: ['Quiet ', 'seats fill', ' fast'], eol: [false, false, true] }, undefined];
    expect(findInPages(pages, 'quiet seats')).toEqual([
      {
        page: 0,
        parts: [
          { item: 0, from: 0, to: 6 },
          { item: 1, from: 0, to: 5 },
        ],
      },
    ]);
  });
});

describe('viewer search params', () => {
  it('opens a document or a source, with the cited passage, and drops anything malformed', () => {
    expect(validateDocumentViewerSearch({ doc: DOC.toUpperCase(), passage: PASSAGE })).toEqual({
      doc: DOC,
      src: undefined,
      passage: PASSAGE,
    });
    expect(viewerTarget(validateDocumentViewerSearch({ src: DOC, passage: PASSAGE }))).toEqual({
      kind: 'source',
      sourceId: DOC,
      passageId: PASSAGE,
    });
    expect(validateDocumentViewerSearch({ doc: 'nope', passage: PASSAGE })).toEqual({
      doc: undefined,
      src: undefined,
      passage: undefined,
    });
    expect(viewerTarget(validateDocumentViewerSearch({}))).toBeNull();
  });

  it('keeps the page’s own params when opening and closing', () => {
    const opened = viewerSearchFor({ view: 'evidence' }, { documentId: DOC, passageId: PASSAGE });
    expect(opened).toEqual({ view: 'evidence', doc: DOC, src: undefined, passage: PASSAGE });
    expect(viewerSearchFor(opened, null)).toEqual({
      view: 'evidence',
      doc: undefined,
      src: undefined,
      passage: undefined,
    });
  });
});
