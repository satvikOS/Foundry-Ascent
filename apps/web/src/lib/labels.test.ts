import { DOCUMENT_FAILURE_REASONS } from '@foundry/contracts';
import { describe, expect, it } from 'vitest';

import { DOCUMENT_FAILURE_MESSAGES, documentFailureMessage } from './labels';

describe('documentFailureMessage', () => {
  it('has its own line for every reason the ingestion pipeline writes', () => {
    expect(Object.keys(DOCUMENT_FAILURE_MESSAGES).sort()).toEqual([...DOCUMENT_FAILURE_REASONS].sort());
    expect(documentFailureMessage('extractor_unavailable')).toMatch(/can’t be read from this kind of file/);
  });

  it('falls back to a generic line for an unknown or missing reason', () => {
    expect(documentFailureMessage('something_new')).toBe('Processing failed — not searchable.');
    expect(documentFailureMessage(null)).toBe('Processing failed — not searchable.');
  });
});
