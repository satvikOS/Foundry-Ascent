import { afterEach, describe, expect, it, vi } from 'vitest';

import { followDownload, guardPageUnload } from './page-unload';

/** Dispatches a leave-the-page event and says whether the page asked first. */
function leaving(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('guardPageUnload', () => {
  it('asks before leaving while a take is held, and no longer once released', () => {
    const release = guardPageUnload();
    expect(leaving()).toBe(true);
    release();
    expect(leaving()).toBe(false);
  });

  it('does not ask about a download the app follows itself, and asks again right after', () => {
    vi.useFakeTimers();
    const followed: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      followed.push(this.href);
      // The browser takes following the link for leaving, until the answer says it is an attachment.
      expect(leaving()).toBe(false);
    });
    const release = guardPageUnload();
    followDownload('https://recordings.test/call.webm?sig=1');
    expect(followed).toEqual(['https://recordings.test/call.webm?sig=1']);
    vi.advanceTimersByTime(1_000);
    expect(leaving()).toBe(true);
    release();
  });
});
