import { expect, type Page } from '@playwright/test';

import {
  FOUNDER_NAME,
  FOUNDER_STATE,
  openVenture,
  setFaceAccess,
  setFacesEnabled,
  test,
} from './support/fixtures';

/*
 * A LITE stock face the page feeds (docs/architecture/calls.md §4.4) end to end, silently: the production build and
 * the real API, whose development stand-in face is a LITE stock face fed by the browser (a third API on the same
 * database, E2E_LITE_FACE_API_URL; the page's API calls are routed to it). The vendor's speak channel is an in-page
 * stand-in that answers like LiveAvatar's (measured in the sandbox, lab run 42087743218) and announces every command;
 * `/speech` is answered here with silent PCM, as ElevenLabs' `pcm_24000` would stream it (the local API has no voice).
 * Chromium runs with `--disable-audio-output`.
 *
 * Checked: the session hands the page the speak channel and the tile says "AI avatar"; each reply is one utterance
 * (the same id on every chunk, a 200 ms first chunk, ~1 s after, one `agent.speak_end`), made only of units the
 * server admitted as it signed them; the call plays none of them on its own speakers while the face is healthy
 * (never both); barge-in interrupts the vendor and silences the element at once; and when the channel drops, the face
 * ends (`control_lost`), the presence is back and the call plays the next reply itself.
 */

const WRITE_HEADERS = { 'x-requested-with': 'foundry-ascent', 'content-type': 'application/json' };
const TURNS = /\/api\/v1\/sessions\/[0-9a-f-]{36}\/turns$/;

const apiURL = new URL(process.env.E2E_API_URL ?? 'http://localhost:8787');
const LITE_API = new URL(
  process.env.E2E_LITE_FACE_API_URL ??
    `${apiURL.protocol}//${apiURL.hostname}:${String(Number(apiURL.port || '8787') + 2)}`,
);

/** Silent 24 kHz PCM of `ms` (what `/speech` streams for ElevenLabs' `pcm_24000`). */
function silentPcm(ms: number): Buffer {
  return Buffer.alloc(Math.round((ms / 1000) * 24_000) * 2);
}

interface LiteCommand {
  readonly type: string;
  readonly eventId: string | null;
  readonly bytes: number;
}

interface PageRecord {
  readonly commands: LiteCommand[];
  /** Units of each turn as the page received them, with their face admission. */
  readonly turns: { text: string; face: boolean }[][];
  /** Every `AudioBufferSourceNode.start` (the call's own speakers), with when. */
  readonly localStarts: number[];
  /** When the stand-in avatar started and stopped speaking. */
  readonly speaking: { at: number; speaking: boolean }[];
  readonly microphoneAsked: number;
}

function record(page: Page): Promise<PageRecord> {
  return page.evaluate(() => (window as unknown as { __lite: PageRecord }).__lite);
}

/** Starts a call from the founder's venture; returns the call id and the call screen. */
async function startCall(page: Page) {
  const started = page.waitForResponse(
    (response) => /\/sessions\/[0-9a-f-]{36}\/calls$/.test(response.url()) && response.status() === 201,
  );
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: /^Call / })
    .click();
  const screen = page.getByRole('dialog', { name: /^Call with / });
  await screen.getByRole('button', { name: 'Start call' }).click();
  const callId = ((await (await started).json()) as { call: { id: string } }).call.id;
  return { callId, screen };
}

/** The `agent.speak` commands since `from`, grouped by utterance id (in order of first chunk). */
function utterances(commands: readonly LiteCommand[], from = 0): Map<string, LiteCommand[]> {
  const out = new Map<string, LiteCommand[]>();
  for (const c of commands.slice(from)) {
    if (c.type !== 'agent.speak' || c.eventId === null) continue;
    out.set(c.eventId, [...(out.get(c.eventId) ?? []), c]);
  }
  return out;
}

test.describe('vEIR calls · a LITE stock face the page feeds (the ElevenLabs voice, lip-synced)', () => {
  test.use({ storageState: FOUNDER_STATE });

  test('says each reply as one utterance of admitted units, never twice, and falls back quietly', async ({
    page,
    baseURL,
  }) => {
    if (!baseURL) throw new Error('baseURL is required');
    const site = new URL(baseURL);
    test.skip(site.hostname !== 'localhost' && site.hostname !== '127.0.0.1', 'needs the local LITE API');

    await page.addInitScript(() => {
      const lite = {
        commands: [] as LiteCommand[],
        turns: [] as { text: string; face: boolean }[][],
        localStarts: [] as number[],
        speaking: [] as { at: number; speaking: boolean }[],
        microphoneAsked: 0,
      };
      (window as unknown as { __lite: typeof lite }).__lite = lite;
      window.addEventListener('foundry:face-lite', (event) => {
        lite.commands.push((event as CustomEvent<LiteCommand>).detail);
      });
      window.addEventListener('foundry:face-lite-speaking', (event) => {
        lite.speaking.push({ at: performance.now(), speaking: (event as CustomEvent<boolean>).detail });
      });
      // The call's own speakers: every buffer source it starts.
      const nativeStart = Reflect.get<AudioBufferSourceNode, 'start'>(
        AudioBufferSourceNode.prototype,
        'start',
      );
      AudioBufferSourceNode.prototype.start = function (
        this: AudioBufferSourceNode,
        when?: number,
        offset?: number,
        duration?: number,
      ) {
        lite.localStarts.push(performance.now());
        nativeStart.call(this, when, offset, duration);
      };
      // Each turn's units and their face admission, from a copy of the stream.
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await nativeFetch(input, init);
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (/\/api\/v1\/sessions\/[0-9a-f-]{36}\/turns$/.test(new URL(url, location.href).pathname)) {
          const units: { text: string; face: boolean }[] = [];
          lite.turns.push(units);
          const reader = response.clone().body?.getReader();
          const read = async (): Promise<void> => {
            if (!reader) return;
            const decoder = new TextDecoder();
            let buffered = '';
            for (;;) {
              const { done, value } = await reader.read();
              if (done) return;
              buffered += decoder.decode(value, { stream: true });
              const frames = buffered.split('\n\n');
              buffered = frames.pop() ?? '';
              for (const frame of frames) {
                const data = frame
                  .split('\n')
                  .filter((line) => line.startsWith('data:'))
                  .map((line) => line.slice(5).trim())
                  .join('');
                try {
                  const event = JSON.parse(data) as { event?: unknown; text?: unknown; face?: unknown };
                  if (event.event === 'turn.speech' && typeof event.text === 'string') {
                    units.push({ text: event.text, face: event.face === true });
                  }
                } catch {
                  /* not a JSON frame */
                }
              }
            }
          };
          read().catch(() => undefined);
        }
        return response;
      };
      const devices = navigator.mediaDevices as MediaDevices | undefined;
      if (devices?.getUserMedia) {
        const original = devices.getUserMedia.bind(devices);
        devices.getUserMedia = (constraints) => {
          if (constraints?.audio) lite.microphoneAsked += 1;
          return original(constraints);
        };
      }
    });

    // Every API call goes to the LITE API (same database, same sign-in); `/speech` streams silent PCM, as the
    // ElevenLabs voice streams `pcm_24000` (the local API has no voice of its own).
    const speech: number[] = [];
    await page.route(
      (url) => url.origin === site.origin && url.pathname.startsWith('/api/'),
      async (route) => {
        const request = route.request();
        if (new URL(request.url()).pathname === '/api/v1/speech') {
          speech.push(Date.now());
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'audio/pcm', 'x-speech-sample-rate': '24000' },
            body: silentPcm(1_500),
          });
          return;
        }
        await route.continue({ url: request.url().replace(site.origin, LITE_API.origin) });
      },
    );
    const sessions: Record<string, unknown>[] = [];
    const faceEnds: { status: number; body: string }[] = [];
    let interrupts = 0;
    page.on('response', (response) => {
      const path = new URL(response.url()).pathname;
      if (path.endsWith('/api/v1/calls/avatar-session')) {
        void response
          .json()
          .then((body: Record<string, unknown>) => sessions.push(body))
          .catch(() => undefined);
      }
      if (path.endsWith('/face/interrupt')) interrupts += 1;
      if (path.endsWith('/face/end')) {
        faceEnds.push({ status: response.status(), body: response.request().postData() ?? '{}' });
      }
    });

    await setFaceAccess(baseURL, FOUNDER_NAME, true);
    await setFacesEnabled(baseURL, true);
    let callId: string | null = null;
    try {
      const notice = await page.request.post('/api/v1/calls/notice/acknowledge', { headers: WRITE_HEADERS });
      expect(notice.status(), 'POST /calls/notice/acknowledge').toBe(200);
      await openVenture(page);
      const call = await startCall(page);
      callId = call.callId;
      const screen = call.screen;
      const tile = screen.locator('[data-slot="call-tile"][data-face="video"]');
      const line = screen.getByRole('textbox', { name: /^Reply to / });
      const interrupt = screen.getByRole('button', { name: 'Interrupt' });
      let liveAt = 0;

      await test.step('the stock face opens with its speak channel, labelled "AI avatar"', async () => {
        await expect(tile).toBeVisible({ timeout: 20_000 });
        await expect(tile.locator('[data-slot="call-ai-avatar-label"]')).toHaveText('AI avatar');
        expect(sessions[0]).toMatchObject({ provider: 'fake', voicing: 'audio', stockFace: true });
        expect(String(sessions[0]?.controlUrl)).toMatch(/^wss:\/\/lite\.stand-in\.invalid\//);
        // The intro may have played on the speakers before the face joined; nothing after this may.
        await expect(interrupt).toBeHidden({ timeout: 20_000 });
        liveAt = await page.evaluate(() => performance.now());
      });

      await test.step('a reply is one utterance of admitted units, and the speakers play none of it', async () => {
        const from = (await record(page)).commands.length;
        const replied = page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' && TURNS.test(new URL(response.url()).pathname),
        );
        await line.fill('What should I test first?');
        await line.press('Enter');
        await (await replied).finished();
        await expect
          .poll(
            async () => (await record(page)).commands.slice(from).some((c) => c.type === 'agent.speak_end'),
            {
              timeout: 30_000,
            },
          )
          .toBe(true);
        await expect(interrupt).toBeHidden({ timeout: 30_000 });
        const now = await record(page);
        const reply = now.turns.at(-1) ?? [];
        expect(reply.length).toBeGreaterThan(0);
        // Every unit of the reply was admitted by the server as it signed it.
        expect(reply.every((u) => u.face)).toBe(true);
        const said = utterances(now.commands, from);
        expect([...said.keys()]).toHaveLength(1);
        const [chunks = []] = [...said.values()];
        expect(chunks[0]?.bytes).toBe(9_600);
        expect(chunks.every((c) => c.bytes > 0 && c.bytes <= 48_000)).toBe(true);
        // 1.5 s of PCM per unit, all of it forwarded.
        expect(chunks.reduce((n, c) => n + c.bytes, 0)).toBe(reply.length * 72_000);
        expect(now.commands.slice(from).filter((c) => c.type === 'agent.speak_end')).toHaveLength(1);
        // Never both: the call's own speakers played nothing since the face went live.
        expect(now.localStarts.filter((at) => at > liveAt)).toEqual([]);
        expect(now.microphoneAsked).toBeLessThanOrEqual(1);
      });

      await test.step('barge-in interrupts the vendor and silences the face at once', async () => {
        const from = (await record(page)).commands.length;
        await line.fill('And how many interviews is enough?');
        await line.press('Enter');
        await expect
          .poll(async () => (await record(page)).commands.slice(from).some((c) => c.type === 'agent.speak'), {
            timeout: 30_000,
          })
          .toBe(true);
        await interrupt.click();
        await expect
          .poll(async () =>
            (await record(page)).commands.slice(from).some((c) => c.type === 'agent.interrupt'),
          )
          .toBe(true);
        const muted = await tile
          .locator('video')
          .evaluate((element: HTMLVideoElement) => element.muted || element.volume === 0);
        expect(muted).toBe(true);
        await expect.poll(() => interrupts).toBeGreaterThan(0);
        const now = await record(page);
        expect(now.localStarts.filter((at) => at > liveAt)).toEqual([]);
      });

      await test.step('the speak channel drops: the face ends, the presence is back and the call speaks itself', async () => {
        await page.evaluate(() => window.dispatchEvent(new Event('foundry:face-lite-drop')));
        await expect(tile).toHaveCount(0);
        await expect(screen.locator('[data-slot="call-tile"][data-face="character"]')).toBeVisible();
        await expect.poll(() => faceEnds.length).toBe(1);
        expect(faceEnds[0]?.status).toBe(204);
        expect(JSON.parse(faceEnds[0]?.body ?? '{}')).toEqual({ reason: 'control_lost' });
        const before = (await record(page)).localStarts.length;
        await expect(line).toBeEditable();
        await line.fill('Thanks, what next?');
        await line.press('Enter');
        await expect
          .poll(async () => (await record(page)).localStarts.length, { timeout: 30_000 })
          .toBeGreaterThan(before);
      });
    } finally {
      if (callId) {
        const ended = await page.request.post(`/api/v1/calls/${callId}/end`, {
          headers: WRITE_HEADERS,
          data: { reason: 'user' },
        });
        expect(ended.status(), 'POST /calls/:id/end').toBe(200);
      }
      await setFacesEnabled(baseURL, false);
      await setFaceAccess(baseURL, FOUNDER_NAME, false);
    }
  });
});
