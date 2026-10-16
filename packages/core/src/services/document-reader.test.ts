import { describe, expect, it } from 'vitest';

import { chunkText } from '../ingestion/chunker.js';
import { fileIsStored, readablePassages, withoutOverlap } from './document-reader.js';

const sentence = (i: number): string =>
  `Sentence ${String(i).padStart(3, '0')} notes where students found a quiet seat during finals.`;

/** Chunks of `text` as the database stores them (ids are their ordinals). */
function stored(text: string, targetTokens = 120) {
  return chunkText(text, { targetTokens }).chunks.map((chunk) => ({
    id: `chunk-${chunk.ordinal}`,
    ordinal: chunk.ordinal,
    heading: chunk.heading,
    content: chunk.content,
  }));
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('withoutOverlap', () => {
  it('drops the paragraphs a passage repeats from the one before it', () => {
    const previous = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
    expect(withoutOverlap(previous, 'Second paragraph.\n\nThird paragraph.\n\nFourth paragraph.')).toBe(
      'Fourth paragraph.',
    );
    expect(withoutOverlap(previous, 'Third paragraph.\n\nFourth paragraph.')).toBe('Fourth paragraph.');
  });

  it('matches the repeat whatever the whitespace (a carried sentence tail is re-joined with spaces)', () => {
    const previous = 'A long paragraph begins here.\nIt ends with two sentences. The last one.';
    expect(withoutOverlap(previous, 'It ends with two sentences. The last one.\n\nNew text.')).toBe(
      'New text.',
    );
  });

  it('keeps a passage that repeats nothing, and never cuts in the middle of a word', () => {
    expect(withoutOverlap('Alpha.\n\nBeta.', 'Gamma.\n\nDelta.')).toBe('Gamma.\n\nDelta.');
    expect(withoutOverlap('The cat sat.', 'at sat.\n\nNext.')).toBe('at sat.\n\nNext.');
    expect(withoutOverlap('', 'Only text.')).toBe('Only text.');
  });

  it('never returns an empty passage', () => {
    expect(withoutOverlap('One.\n\nTwo.', 'Two.\n\n')).toBe('Two.\n\n');
  });
});

describe('readablePassages', () => {
  it('reads a chunked document back with every sentence exactly once', () => {
    const findings = Array.from({ length: 12 }, (_, p) =>
      Array.from({ length: 4 }, (_, s) => sentence(p * 4 + s)).join(' '),
    ).join('\n\n');
    const text = `# Library study\n\n## Findings\n\n${findings}\n\n## Next steps\n\n${sentence(900)}`;
    const chunks = stored(text);
    // The chunker repeats text between consecutive passages of a section.
    const raw = chunks.map((c) => c.content).join('\n\n');
    expect(occurrences(raw, sentence(4))).toBeGreaterThan(0);
    expect(Array.from({ length: 48 }, (_, i) => occurrences(raw, sentence(i))).some((n) => n > 1)).toBe(true);

    const passages = readablePassages(chunks, null);
    expect(passages.map((p) => p.id)).toEqual(chunks.map((c) => c.id));
    const joined = passages.map((p) => p.text).join('\n\n');
    for (let i = 0; i < 48; i += 1) expect(occurrences(joined, sentence(i))).toBe(1);
    expect(occurrences(joined, sentence(900))).toBe(1);
  });

  it('removes the repeat of a single passage given the passage before it', () => {
    const findings = Array.from({ length: 10 }, (_, p) =>
      Array.from({ length: 4 }, (_, s) => sentence(p * 4 + s)).join(' '),
    ).join('\n\n');
    const chunks = stored(`# Findings\n\n${findings}`);
    expect(chunks.length).toBeGreaterThan(2);
    const [previous, cited] = [chunks[1], chunks[2]];
    if (!previous || !cited) throw new Error('expected chunks');
    const [only] = readablePassages([cited], previous);
    if (!only) throw new Error('expected the passage');
    expect(only.id).toBe(cited.id);
    expect(only.text.length).toBeLessThan(cited.content.length);
    expect(cited.content.endsWith(only.text)).toBe(true);
  });

  it('keeps passages of different sections, and passages that do not follow each other, whole', () => {
    const a = { id: 'a', ordinal: 1, heading: 'One', content: 'Shared line.\n\nOnly in one.' };
    const b = { id: 'b', ordinal: 2, heading: 'Two', content: 'Only in one.\n\nOnly in two.' };
    const c = { id: 'c', ordinal: 4, heading: 'Two', content: 'Only in two.\n\nOnly in four.' };
    expect(readablePassages([a, b, c], null).map((p) => p.text)).toEqual([a.content, b.content, c.content]);
  });
});

describe('fileIsStored', () => {
  it('is true once the file arrived, false while uploading or when it never arrived', () => {
    expect(fileIsStored({ status: 'ready', failureReason: null })).toBe(true);
    expect(fileIsStored({ status: 'processing', failureReason: null })).toBe(true);
    expect(fileIsStored({ status: 'failed', failureReason: 'extract_failed' })).toBe(true);
    expect(fileIsStored({ status: 'pending_upload', failureReason: null })).toBe(false);
    expect(fileIsStored({ status: 'failed', failureReason: 'upload_incomplete' })).toBe(false);
    expect(fileIsStored({ status: 'failed', failureReason: 'object_missing' })).toBe(false);
    expect(fileIsStored({ status: 'deleted', failureReason: null })).toBe(false);
  });
});
