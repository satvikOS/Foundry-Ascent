import { ExtractionFailedError } from '@foundry/core';
import { describe, expect, it } from 'vitest';

import { minimalDocx, minimalPdf, zip } from '../testing/fixtures.js';
import { DocumentTextExtractor, htmlToMarkdownText } from './text-extractor.js';

const extractor = new DocumentTextExtractor();
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('DocumentTextExtractor', () => {
  it('decodes text and markdown as UTF-8 (BOM and NUL removed, CRLF normalised)', async () => {
    const bytes = new TextEncoder().encode('﻿# Plan\r\nCafé — naïve\u0000 text');
    const { text } = await extractor.extract(bytes, 'text/markdown');
    expect(text).toBe('# Plan\nCafé — naïve text');
    expect((await extractor.extract(new TextEncoder().encode('plain'), 'text/plain')).text).toBe('plain');
  });

  it('extracts PDF text page by page with unpdf', async () => {
    const pdf = minimalPdf([
      ['Synthetic interview notes', 'Students want quiet seats (exam weeks).'],
      ['Second page: pricing hypotheses'],
    ]);
    const { text } = await extractor.extract(pdf, 'application/pdf');
    expect(text).toContain('Synthetic interview notes');
    expect(text).toContain('Students want quiet seats (exam weeks).');
    expect(text).toContain('Second page: pricing hypotheses');
    expect(text.indexOf('Synthetic')).toBeLessThan(text.indexOf('Second page'));
  });

  it('enforces the PDF page limit and rejects non-PDF bytes', async () => {
    const small = new DocumentTextExtractor({ maxPages: 1 });
    await expect(small.extract(minimalPdf([['a'], ['b']]), 'application/pdf')).rejects.toBeInstanceOf(
      ExtractionFailedError,
    );
    await expect(
      extractor.extract(new TextEncoder().encode('%CORRUPT not a pdf'), 'application/pdf'),
    ).rejects.toBeInstanceOf(ExtractionFailedError);
    await expect(
      extractor.extract(new TextEncoder().encode('%PDF-1.4\nthis is not really a pdf'), 'application/pdf'),
    ).rejects.toBeInstanceOf(ExtractionFailedError);
  });

  it('extracts DOCX with Markdown headings (mammoth)', async () => {
    const docx = minimalDocx([
      { text: 'Pilot plan', style: 'Heading1' },
      { text: 'We will test seat booking in two libraries & one café.' },
      { text: 'Risks', style: 'Heading2' },
      { text: 'Wi-Fi coverage <unknown>.' },
    ]);
    const { text } = await extractor.extract(docx, DOCX);
    expect(text).toBe(
      '# Pilot plan\n\nWe will test seat booking in two libraries & one café.\n\n## Risks\n\nWi-Fi coverage <unknown>.',
    );
  });

  it('rejects corrupt DOCX packages and oversized inputs', async () => {
    await expect(extractor.extract(new TextEncoder().encode('not a zip'), DOCX)).rejects.toBeInstanceOf(
      ExtractionFailedError,
    );
    await expect(
      extractor.extract(zip({ 'hello.txt': 'no word document here' }), DOCX),
    ).rejects.toBeInstanceOf(ExtractionFailedError);
    const tiny = new DocumentTextExtractor({ maxBytes: 4 });
    await expect(tiny.extract(new TextEncoder().encode('12345'), 'text/plain')).rejects.toBeInstanceOf(
      ExtractionFailedError,
    );
  });

  it('truncates very long text', async () => {
    const short = new DocumentTextExtractor({ maxChars: 10 });
    expect((await short.extract(new TextEncoder().encode('x'.repeat(50)), 'text/plain')).text).toHaveLength(
      10,
    );
  });
});

describe('htmlToMarkdownText', () => {
  it('maps headings, lists, tables and entities', () => {
    const html =
      '<h1>Title <em>one</em></h1><p>Intro &amp; more&#39;s</p><ul><li>First</li><li>Second</li></ul>' +
      '<table><tr><td>A</td><td>B</td></tr></table><h3></h3><p>End&nbsp;line<br/>next</p>';
    expect(htmlToMarkdownText(html)).toBe(
      "# Title one\n\nIntro & more's\n\n- First\n- Second\n\nA | B |\n\nEnd line\nnext",
    );
  });
});
