import { describe, expect, it } from 'vitest';

import { guardPageUnload } from './page-unload';

/** Dispatches a leave-the-page event and says whether the page asked first. */
function leaving(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('guardPageUnload', () => {
  it('asks before leaving while a take is held, and no longer once released', () => {
    const release = guardPageUnload();
    expect(leaving()).toBe(true);
    release();
    expect(leaving()).toBe(false);
  });
});
