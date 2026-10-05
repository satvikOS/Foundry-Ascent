import { describe, expect, it } from 'vitest';

import { chunkText, chunkTokens, normalizeExtractedText } from './chunker.js';

const sentence = (i: number): string =>
  `Sentence ${i} describes how students look for quiet seats during the exam period.`;
const paragraph = (from: number, count: number): string =>
  Array.from({ length: count }, (_, i) => sentence(from + i)).join(' ');

describe('chunkText', () => {
  it('produces ~800-token chunks with ~15% overlap inside a section', () => {
    const text = `# Findings\n\n${Array.from({ length: 30 }, (_, i) => paragraph(i * 10, 10)).join('\n\n')}`;
    const { chunks, truncated } = chunkText(text);
    expect(truncated).toBe(false);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.heading).toBe('Findings');
      expect(c.tokenCount).toBeLessThanOrEqual(800 * 1.2);
      expect(c.tokenCount).toBe(chunkTokens(c.content));
    }
    for (const c of chunks.slice(0, -1)) expect(c.tokenCount).toBeGreaterThan(500);
    // Consecutive chunks share their boundary text (overlap ≤ 15 % of the target, > 0).
    for (let i = 1; i < chunks.length; i += 1) {
      const first = (chunks[i]?.content ?? '').split('\n\n')[0] ?? '';
      expect(chunks[i - 1]?.content.endsWith(first)).toBe(true);
      expect(chunkTokens(first)).toBeGreaterThan(40);
      expect(chunkTokens(first)).toBeLessThanOrEqual(120);
    }
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i + 1));
  });

  it('never crosses heading boundaries for large sections and keeps the heading path', () => {
    const text = [
      '# Report',
      '',
      '## Interviews',
      '',
      paragraph(0, 40),
      '',
      '## Pricing',
      '',
      paragraph(100, 40),
    ].join('\n');
    const { chunks } = chunkText(text);
    const headings = [...new Set(chunks.map((c) => c.heading))];
    expect(headings).toEqual(['Report › Interviews', 'Report › Pricing']);
    for (const c of chunks) {
      if (c.heading === 'Report › Interviews') expect(c.content).not.toContain('Sentence 100 ');
    }
  });

  it('merges tiny sections, recognises setext and ALL-CAPS headings', () => {
    const text = [
      'Title',
      '=====',
      '',
      'Short intro.',
      '',
      'METHODS',
      '',
      'We counted doors.',
      '',
      'Results',
      '-------',
      '',
      paragraph(0, 50),
    ].join('\n');
    const { chunks } = chunkText(text);
    expect(chunks[0]?.content).toContain('Short intro.');
    expect(chunks[0]?.content).toContain('METHODS');
    expect(chunks.some((c) => c.heading?.endsWith('Results'))).toBe(true);
  });

  it('splits oversized sentences and unbroken tokens, and honours maxChunks', () => {
    const long = `${'word '.repeat(5_000)}\n\n${'x'.repeat(20_000)}`;
    const { chunks } = chunkText(long);
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(800 * 1.2);
    const capped = chunkText(long, { maxChunks: 2 });
    expect(capped.chunks).toHaveLength(2);
    expect(capped.truncated).toBe(true);
  });

  it('is deterministic and handles empty input', () => {
    const text = `# A\n\n${paragraph(0, 100)}`;
    expect(chunkText(text)).toEqual(chunkText(text));
    expect(chunkText('  \n\n ')).toEqual({ chunks: [], truncated: false });
  });

  it('normalises newlines, control and invisible characters', () => {
    const zeroWidth = String.fromCharCode(0x200b);
    expect(normalizeExtractedText(`a\r\nb\u0007c${zeroWidth}d\n\n\n\ne   `)).toBe('a\nbcd\n\ne');
  });
});
