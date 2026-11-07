import { afterEach, describe, expect, it, vi } from 'vitest';

import { saveDownload } from './save-download';

afterEach(() => {
  vi.useRealTimers();
});

describe('saveDownload', () => {
  it('loads the file in a hidden frame that may only download, and removes the frame later', () => {
    vi.useFakeTimers();
    saveDownload('https://recordings.test/call.mp4?sig=1');
    const frame = document.querySelector('iframe');
    expect(frame?.src).toBe('https://recordings.test/call.mp4?sig=1');
    expect(frame?.hidden).toBe(true);
    expect(frame?.getAttribute('sandbox')).toBe('allow-downloads');
    vi.advanceTimersByTime(59_999);
    expect(document.querySelector('iframe')).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(document.querySelector('iframe')).toBeNull();
  });
});
