import { describe, expect, it } from 'vitest';

import {
  EMPTY_NOTEBOOK,
  MAX_SUMMARY_SOURCES,
  decodeNotebookContent,
  withDistilledSources,
  withPersonSources,
  type NotebookContent,
} from './notebooks.js';

const A = '6f1c6d0e-1a2b-5c3d-8e4f-0123456789aa';
const B = '6f1c6d0e-1a2b-5c3d-8e4f-0123456789bb';

const entry = {
  id: 'fp-1',
  text: 'Likes numbers',
  sourceSessionId: A,
  createdAt: '2026-10-01T10:00:00.000Z',
};

describe('decodeNotebookContent', () => {
  it('reads a document that matches the contract as intact', () => {
    const doc = { ...EMPTY_NOTEBOOK, summary: 'S', founderProfile: [entry], summarySources: [A] };
    expect(decodeNotebookContent(doc)).toEqual({ content: doc, intact: true });
  });

  it('keeps the readable lines of one that does not, and says so (never an empty notebook)', () => {
    const broken = { ...entry, id: 'fp-2', sourceSessionId: 'from-a-spreadsheet' };
    const decoded = decodeNotebookContent({
      summary: 'S',
      founderProfile: [entry, broken],
      commitments: 'not a list',
      nextOpener: 42,
    });
    expect(decoded.intact).toBe(false);
    expect(decoded.content).toEqual({ ...EMPTY_NOTEBOOK, summary: 'S', founderProfile: [entry] });
    expect(decodeNotebookContent('[1, 2]')).toEqual({ content: EMPTY_NOTEBOOK, intact: false });
  });
});

describe('withDistilledSources', () => {
  const base: NotebookContent = { ...EMPTY_NOTEBOOK, summary: 'From A', nextOpener: 'About A?' };

  it('records the conversation a new summary and opener were drawn from', () => {
    const next = withDistilledSources(EMPTY_NOTEBOOK, base, A);
    expect(next).toMatchObject({ summarySources: [A], nextOpenerSource: A });
  });

  it('keeps sources of unchanged text and adds the new conversation to a rewritten summary', () => {
    const first = withDistilledSources(null, base, A);
    // The caller's own source fields are ignored: the repository owns them.
    const same = withDistilledSources(first, { ...first, summarySources: [B], nextOpenerSource: B }, B);
    expect(same).toMatchObject({ summarySources: [A], nextOpenerSource: A });
    const rewritten = withDistilledSources(first, { ...first, summary: 'From A and B' }, B);
    expect(rewritten).toMatchObject({ summarySources: [A, B], nextOpenerSource: A });
    const reopened = withDistilledSources(first, { ...first, nextOpener: 'About B?' }, B);
    expect(reopened.nextOpenerSource).toBe(B);
  });

  it('keeps unknown origins unknown and caps the source list', () => {
    const unknown = withDistilledSources(base, { ...base, summary: 'Rewritten' }, B);
    expect(unknown.summarySources).toBeUndefined();
    const noSource = withDistilledSources(
      withDistilledSources(null, base, A),
      { ...base, summary: 'X' },
      null,
    );
    expect(noSource.summarySources).toBeUndefined();
    const many = Array.from(
      { length: MAX_SUMMARY_SOURCES },
      (_, i) => `6f1c6d0e-1a2b-5c3d-8e4f-${String(i).padStart(12, '0')}`,
    );
    const capped = withDistilledSources({ ...base, summarySources: many }, { ...base, summary: 'Y' }, B);
    expect(capped.summarySources).toHaveLength(MAX_SUMMARY_SOURCES);
    expect(capped.summarySources?.at(-1)).toBe(B);
    expect(capped.summarySources?.[0]).toBe(many[1]);
  });

  it('records rewritten text without a conversation as of unknown origin, never as written by a person', () => {
    // `[]` and null mean "a person wrote it": a rewrite must not inherit that.
    const personWritten: NotebookContent = { ...base, summarySources: [], nextOpenerSource: null };
    const rewritten = withDistilledSources(
      personWritten,
      { ...personWritten, summary: 'Rewritten', nextOpener: 'New opener?' },
      null,
    );
    expect(rewritten).not.toHaveProperty('summarySources');
    expect(rewritten).not.toHaveProperty('nextOpenerSource');
    const drawn = withDistilledSources(
      personWritten,
      { ...personWritten, summary: 'Rewritten', nextOpener: 'New opener?' },
      B,
    );
    expect(drawn).toMatchObject({ summarySources: [B], nextOpenerSource: B });
    // Unchanged person-written text stays a person's.
    const untouched = withDistilledSources(personWritten, { ...personWritten, lastAdvice: [entry] }, B);
    expect(untouched).toMatchObject({ summarySources: [], nextOpenerSource: null });
  });

  it('drops the opener source with the opener', () => {
    const cleared = withDistilledSources(
      withDistilledSources(null, base, A),
      { ...base, nextOpener: null },
      B,
    );
    expect(cleared.nextOpener).toBeNull();
    expect(cleared.nextOpenerSource).toBeUndefined();
  });
});

describe('withPersonSources', () => {
  const drawn: NotebookContent = {
    ...EMPTY_NOTEBOOK,
    summary: 'From A',
    nextOpener: 'About A?',
    summarySources: [A],
    nextOpenerSource: A,
  };

  it('records text a person writes where there was none as drawn from no conversation', () => {
    const written = withPersonSources(EMPTY_NOTEBOOK, {
      ...EMPTY_NOTEBOOK,
      summary: 'Mine',
      nextOpener: 'Ask me',
    });
    expect(written).toMatchObject({ summarySources: [], nextOpenerSource: null });
    expect(withPersonSources(null, { ...EMPTY_NOTEBOOK, summary: 'Mine' })).toMatchObject({
      summarySources: [],
    });
  });

  it('keeps where unchanged or corrected text was drawn from, unknown included', () => {
    expect(withPersonSources(drawn, { ...drawn, lastAdvice: [entry] })).toMatchObject({
      summarySources: [A],
      nextOpenerSource: A,
    });
    expect(
      withPersonSources(drawn, { ...drawn, summary: 'Corrected', nextOpener: 'Reworded?' }),
    ).toMatchObject({ summarySources: [A], nextOpenerSource: A });
    const unknown: NotebookContent = { ...EMPTY_NOTEBOOK, summary: 'From somewhere', nextOpener: 'Hm?' };
    const corrected = withPersonSources(unknown, {
      ...unknown,
      summary: 'Corrected',
      nextOpener: 'Hm, really?',
    });
    expect(corrected).not.toHaveProperty('summarySources');
    expect(corrected).not.toHaveProperty('nextOpenerSource');
  });

  it('ignores the caller’s source fields and drops them with the text', () => {
    // A caller cannot launder drawn text as a person's by sending `[]`.
    expect(withPersonSources(drawn, { ...drawn, summarySources: [], nextOpenerSource: null })).toMatchObject({
      summarySources: [A],
      nextOpenerSource: A,
    });
    const cleared = withPersonSources(drawn, { ...drawn, summary: '', nextOpener: null });
    expect(cleared).not.toHaveProperty('summarySources');
    expect(cleared).not.toHaveProperty('nextOpenerSource');
  });
});
