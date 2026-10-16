import { describe, expect, it } from 'vitest';

import * as main from './index.js';
import { DocumentFileQuery, DocumentFileResponse, SourceTextQuery, SourceTextResponse } from './viewer.js';

describe('document viewer contracts', () => {
  it('stay out of the main entry (the web app’s first screen imports it; the viewer loads later)', () => {
    for (const name of [
      'DocumentFileQuery',
      'DocumentFileResponse',
      'SourceTextQuery',
      'SourceTextResponse',
    ]) {
      expect(Object.keys(main)).not.toContain(name);
    }
  });

  it('asks for the file to show unless a download is asked for, and nothing else', () => {
    expect(DocumentFileQuery.parse({})).toEqual({ disposition: 'inline' });
    expect(DocumentFileQuery.parse({ disposition: 'attachment' })).toEqual({ disposition: 'attachment' });
    expect(DocumentFileQuery.safeParse({ disposition: 'preview' }).success).toBe(false);
  });

  it('carries one URL and its expiry', () => {
    const file = { url: 'https://docs.example/a', expiresAt: '2026-10-16T12:00:00.000Z' };
    expect(DocumentFileResponse.parse(file)).toEqual(file);
    expect(DocumentFileResponse.safeParse({ url: 'not a url', expiresAt: file.expiresAt }).success).toBe(
      false,
    );
  });

  it('reads one passage only by its id', () => {
    expect(SourceTextQuery.safeParse({ passage: 'x' }).success).toBe(false);
    expect(
      SourceTextResponse.safeParse({
        source: {
          id: '11111111-1111-4111-8111-111111111111',
          scope: 'program',
          kind: 'note',
          title: 'Handbook',
          documentId: null,
          freshnessAt: '2026-10-16T12:00:00.000Z',
        },
        body: '## Interviews',
        passages: [],
        truncated: false,
      }).success,
    ).toBe(true);
  });
});
