import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/errors';

import { uploadErrorMessage } from './use-upload-queue';

describe('uploadErrorMessage', () => {
  it('shows the daily upload quota explanation from the server', () => {
    const error = new ApiError({
      status: 429,
      code: 'rate_limited',
      title: 'Too Many Requests',
      detail: 'You can upload up to 20 documents per day. Try again after midnight UTC.',
      retryAfter: 3600,
    });
    expect(uploadErrorMessage(error)).toBe(
      'You can upload up to 20 documents per day. Try again after midnight UTC.',
    );
  });

  it('falls back to the generic message for other errors', () => {
    const error = new ApiError({ status: 413, code: 'upload_too_large', title: 'Payload Too Large' });
    expect(uploadErrorMessage(error)).toBe('That file is too large. The limit is 10 MB.');
    expect(uploadErrorMessage(new Error('boom'))).toBe('Something went wrong. Please try again.');
  });
});
