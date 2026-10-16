import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { displayFacesReady, LANDING_DISPLAY_FACES, LANDING_FONT_WAIT_MS } from './display-faces';

/** A FontFaceSet whose loads finish when `finish` is called (or fail with `fail`). */
function fakeFonts() {
  let finish: () => void = () => undefined;
  let fail: () => void = () => undefined;
  const done = new Promise<FontFace[]>((resolve, reject) => {
    finish = () => {
      resolve([]);
    };
    fail = () => {
      reject(new Error('network'));
    };
  });
  const load = vi.fn((_font: string, _text?: string) => done);
  return { fonts: { load } as unknown as Pick<FontFaceSet, 'load'>, load, finish, fail };
}

async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  return done;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the landing page waits for its display faces', () => {
  it('loads the hero’s roman and italic Newsreader, and renders as soon as both are in', async () => {
    const { fonts, load, finish } = fakeFonts();
    const ready = displayFacesReady('/', fonts);
    expect(load.mock.calls.map(([face]) => face)).toEqual([...LANDING_DISPLAY_FACES]);
    expect(LANDING_DISPLAY_FACES.some((face) => face.startsWith('italic'))).toBe(true);
    expect(await settled(ready)).toBe(false);
    finish();
    expect(await settled(ready)).toBe(true);
  });

  it('never waits longer than the cap, and a failed load just renders', async () => {
    const slow = fakeFonts();
    const capped = displayFacesReady('/', slow.fonts);
    await vi.advanceTimersByTimeAsync(LANDING_FONT_WAIT_MS - 1);
    expect(await settled(capped)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(capped)).toBe(true);

    const broken = fakeFonts();
    const failed = displayFacesReady('/', broken.fonts);
    broken.fail();
    expect(await settled(failed)).toBe(true);
  });

  it('keeps every other page, and browsers without the Font Loading API, waiting for nothing', async () => {
    const { fonts, load } = fakeFonts();
    expect(await settled(displayFacesReady('/sign-in', fonts))).toBe(true);
    expect(await settled(displayFacesReady('/ain/app', fonts))).toBe(true);
    expect(load).not.toHaveBeenCalled();
    expect(await settled(displayFacesReady('/', undefined))).toBe(true);
  });
});
