import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  PASSAGES_PER_PART,
  PassagesReader,
  SEGMENT_CHARS,
  segmentOfPassage,
  splitIntoSegments,
  TextReader,
} from './text-reader';

const paragraph = (i: number) =>
  `Paragraph ${String(i)} says where a quiet seat was found on the third floor, in room ${String(i)}.`;
/** A long Markdown document: sections of paragraphs, a fenced block with blank lines in the middle. */
function longMarkdown(paragraphs: number): string {
  const lines: string[] = [];
  for (let i = 0; i < paragraphs; i += 1) {
    if (i % 50 === 0) lines.push(`## Section ${String(i / 50)}`, '');
    lines.push(paragraph(i), '');
    if (i === 400) lines.push('```', 'code line one', '', 'code line two', '```', '');
  }
  return lines.join('\n');
}

describe('splitIntoSegments', () => {
  it('keeps a short text whole', () => {
    expect(splitIntoSegments('# Notes\n\nShort.', 'markdown')).toEqual(['# Notes\n\nShort.']);
  });

  it('splits a long text into parts of about the segment size, losing nothing and never inside a fence', () => {
    const text = longMarkdown(2000);
    expect(text.length).toBeGreaterThan(SEGMENT_CHARS * 2);
    const parts = splitIntoSegments(text, 'markdown');
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.join('\n')).toBe(text);
    for (const part of parts.slice(0, -1)) expect(part.length).toBeLessThan(SEGMENT_CHARS * 1.2);
    for (const part of parts) expect((part.match(/```/g) ?? []).length % 2).toBe(0);
  });

  it('finds the part a passage starts in', () => {
    const parts = splitIntoSegments(longMarkdown(2000), 'markdown');
    const last = parts.length - 1;
    expect(segmentOfPassage(parts, paragraph(1990))).toBe(last);
    expect(segmentOfPassage(parts, 'Nothing like this is in the document at all, anywhere.')).toBe(-1);
  });
});

describe('long documents', () => {
  it('render part by part, all of them while find is open, and the part of a cited passage at once', () => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = () => undefined;
        disconnect = () => undefined;
      },
    );
    const text = longMarkdown(2000);
    const report = vi.fn();
    const { container, rerender } = render(
      <TextReader text={text} format="markdown" query="" citedText={null} onReport={report} />,
    );
    expect(screen.getByText(paragraph(0))).toBeInTheDocument();
    expect(screen.queryByText(paragraph(1990))).toBeNull();
    expect(container.querySelector('[data-more]')).not.toBeNull();

    rerender(
      <TextReader text={text} format="markdown" query="" citedText={paragraph(1990)} onReport={report} />,
    );
    expect(container.querySelector('[data-cited]')).toHaveTextContent(paragraph(1990));

    rerender(
      <TextReader text={text} format="markdown" query="Paragraph 1999 " citedText={null} onReport={report} />,
    );
    expect(container.querySelectorAll('mark[data-find-index]')).toHaveLength(1);
    expect(container.querySelector('[data-more]')).toBeNull();
    expect(report).toHaveBeenLastCalledWith({ matches: 1, cited: false });
  });

  it('show a long source passage by passage', () => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = () => undefined;
        disconnect = () => undefined;
      },
    );
    const passages = Array.from({ length: PASSAGES_PER_PART * 3 }, (_, i) => ({
      id: `p${String(i)}`,
      heading: null,
      text: paragraph(i),
    }));
    const { container } = render(
      <PassagesReader
        passages={passages}
        query=""
        citedPassageId={`p${String(PASSAGES_PER_PART * 2 + 5)}`}
        onReport={vi.fn()}
      />,
    );
    // The first parts up to the cited passage's are shown; the last one waits.
    expect(container.querySelectorAll('[data-passage-id]')).toHaveLength(PASSAGES_PER_PART * 3);
    expect(container.querySelector('[data-cited]')).toHaveTextContent(paragraph(PASSAGES_PER_PART * 2 + 5));
    expect(container.querySelector('[data-more]')).toBeNull();
  });
});
