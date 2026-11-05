import { join } from 'node:path';

import { expect, test } from '@playwright/test';
import type * as LiveKit from 'livekit-client';

import { faceLabInit, type FaceLab } from './lab/face-lab-page';
import { pageScript } from './lab/page-script';

/*
 * The conversation lab's face-suite page instruments (e2e/lab/face-lab-page.ts), checked under Playwright's own
 * transform, which is what the lab sends into its pages. Lab run 42112455038: the instruments' WebSocket tap had a
 * `#private` field, which Playwright's Babel compiles into a helper call defined outside the function; in the page
 * every `new WebSocket()` then threw ReferenceError, LiveKit's signalling never connected (it waits out its own
 * signal timeout rather than failing), and the LITE face gave up at its 8 s join timeout before the arm measured
 * anything. No vendor, no app: a blank page and a refused local port.
 */

const LIVEKIT_UMD = join(process.cwd(), 'node_modules', 'livekit-client', 'dist', 'livekit-client.umd.js');
/** A local port nothing listens on (discard): a socket to it is refused at once. */
const REFUSED = 'ws://127.0.0.1:9';

test.describe('lab page instruments (face suite)', () => {
  test('a page script whose compiled source calls a helper from outside it is refused before it reaches a page', () => {
    function withPrivateField(): void {
      class Counter {
        #count = 0;
        bump(): number {
          this.#count += 1;
          return this.#count;
        }
      }
      new Counter().bump();
    }
    // The control: the very construct that broke the tap is caught...
    expect(() => pageScript(withPrivateField)).toThrow(/cannot run in a page/);
    // ...and the face suite's instruments compile to source that runs on its own.
    expect(pageScript(faceLabInit)).toBe(faceLabInit);
  });

  test('under the face instruments a WebSocket constructs, and LiveKit signalling fails fast instead of hanging', async ({
    page,
  }) => {
    await page.addInitScript(pageScript(faceLabInit));
    await page.goto('about:blank');
    await page.addScriptTag({ path: LIVEKIT_UMD });
    const seen = await page.evaluate(async (refused) => {
      const lab = (window as unknown as { __faceLab: FaceLab }).__faceLab;
      let constructed: string;
      try {
        const socket = new WebSocket(`${refused}/lab/interactive-avatar/session/lab`);
        constructed = socket instanceof WebSocket ? 'ok' : 'not a WebSocket';
        await new Promise<void>((resolve) => {
          socket.addEventListener('close', () => {
            resolve();
          });
          setTimeout(resolve, 5000);
        });
      } catch (err) {
        constructed = err instanceof Error ? err.name : 'error';
      }
      const LK = (window as unknown as { LivekitClient: typeof LiveKit }).LivekitClient;
      const room = new LK.Room({ adaptiveStream: false, dynacast: false });
      const begun = performance.now();
      let joined = false;
      try {
        await room.connect(refused, 'lab-instruments', { autoSubscribe: false });
        joined = true;
      } catch {
        /* refused, as it must be */
      }
      const signalMs = Math.round(performance.now() - begun);
      await room.disconnect();
      return {
        constructed,
        attempts: lab.lite.attempts,
        opened: lab.lite.opened,
        closeCodes: lab.lite.closeCodes,
        joined,
        signalMs,
      };
    }, REFUSED);
    expect(seen.constructed).toBe('ok');
    // The tap followed the speak-channel-shaped socket (never keeping its URL): attempted, never opened, closed.
    expect(seen).toMatchObject({ attempts: 1, opened: 0, joined: false });
    expect(seen.closeCodes).toHaveLength(1);
    // LiveKit gives up a refused signal connection at once; under the broken tap it waited out its 15 s timeout.
    expect(seen.signalMs).toBeLessThan(5_000);
  });
});
