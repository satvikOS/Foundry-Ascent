import { createHash } from 'node:crypto';

import { expect, type Page, type Request } from '@playwright/test';

import {
  FOUNDER_NAME,
  FOUNDER_STATE,
  OWNER_STATE,
  TENANT,
  openVenture,
  setFaceAccess,
  setFacesEnabled,
  test,
} from './support/fixtures';

/*
 * A FULL stock face (docs/architecture/calls.md §4) end to end, silently: the production build and the real API,
 * whose development stand-in face runs in FULL mode (a second API on the same database, E2E_FACE_API_URL; the
 * page's API calls are routed to it). The stand-in is the real FULL adapter over an in-page room that "says"
 * each unit without a sound and announces every command it is sent. The test checks that every unit the face
 * says was admitted by the server first, then sent once as `avatar.speak_text` with the same words: a reply's
 * units are admitted as the server signs them (`turn.speech` `face: true`, face pre-approval), so the page sends
 * them without asking; any other unit (the intro, or units that reach the page without the flag) is asked for
 * first (one `POST /calls/:id/face/say` 204). It also checks that tampered words are refused (422) and never sent,
 * that no track is published and no microphone asked for, that barge-in interrupts the vendor, that the call
 * never fetches its own audio for a unit the face said, that the tile says "AI avatar", and that a face that drops
 * leaves the call on the presence. The face's video and voice play together in one unmuted element (the browser
 * keeps the lips in step with the voice): the tile shows that element, no other element plays the voice, the call's
 * Web Audio only measures it (an analyser), and minimizing the call keeps it playing out of sight.
 *
 * Like production, the FULL API shows the face to platform admins only and to the people a platform admin gave
 * Video face (Admin › People & access): the seeded founder gets no face until the owner turns hers on there.
 */

const WRITE_HEADERS = { 'x-requested-with': 'foundry-ascent', 'content-type': 'application/json' };
const SAY = /\/api\/v1\/calls\/[0-9a-f-]{36}\/face\/say$/;
const TURNS = /\/api\/v1\/sessions\/[0-9a-f-]{36}\/turns$/;

interface StreamedUnit {
  readonly text: string;
  readonly face: boolean;
}

/**
 * The `turn.speech` units each turn's stream delivered to the page, with their face pre-approval, in order (read in
 * the page from a copy of the stream: Playwright cannot read an event stream's body).
 */
function streamedUnits(page: Page): Promise<StreamedUnit[][]> {
  return page.evaluate(() => (window as unknown as { __turnUnits?: StreamedUnit[][] }).__turnUnits ?? []);
}

const apiURL = new URL(process.env.E2E_API_URL ?? 'http://localhost:8787');
const FACE_API = new URL(
  process.env.E2E_FACE_API_URL ??
    `${apiURL.protocol}//${apiURL.hostname}:${String(Number(apiURL.port || '8787') + 1)}`,
);

interface Command {
  readonly topic: string;
  readonly eventType: string;
  readonly text: string | null;
}

/** What the stand-in's room was sent, in order (its page events, collected from the first script on). */
function commands(page: Page): Promise<Command[]> {
  return page.evaluate(() => (window as unknown as { __faceCommands?: Command[] }).__faceCommands ?? []);
}

/** Every `createMediaStreamSource` of the page: the audio tracks it reads and the nodes it was connected to. */
interface StreamTap {
  readonly tracks: string[];
  readonly targets: string[];
}

function streamTaps(page: Page): Promise<StreamTap[]> {
  return page.evaluate(() => (window as unknown as { __streamTaps?: StreamTap[] }).__streamTaps ?? []);
}

/** The tile's face element: its tracks, and whether it sounds. */
function faceElement(page: Page) {
  return page
    .getByRole('dialog', { name: /^Call with / })
    .locator('[data-slot="call-tile"][data-face="video"] video')
    .evaluate((element: HTMLVideoElement) => {
      const stream = element.srcObject instanceof MediaStream ? element.srcObject : null;
      return {
        audio: stream?.getAudioTracks().map((t) => t.id) ?? [],
        video: stream?.getVideoTracks().length ?? 0,
        muted: element.muted,
        volume: element.volume,
        paused: element.paused,
      };
    });
}

/** How many media elements on the page play the audio track `id` unmuted. */
function playersOf(page: Page, id: string): Promise<number> {
  return page.evaluate(
    (trackId) =>
      [...document.querySelectorAll<HTMLMediaElement>('audio, video')].filter(
        (element) =>
          element.srcObject instanceof MediaStream &&
          element.srcObject.getAudioTracks().some((t) => t.id === trackId) &&
          !element.muted,
      ).length,
    id,
  );
}

/** How often the page asked for a microphone. */
function microphoneAsked(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __microphoneAsked: number }).__microphoneAsked);
}

function spoken(list: readonly Command[]): string[] {
  return list.filter((c) => c.eventType === 'avatar.speak_text').map((c) => c.text ?? '');
}

function bodyText(request: Request): string {
  try {
    const text = (JSON.parse(request.postData() ?? '{}') as { text?: unknown }).text;
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

/** Sends every API call of the page to the FULL-mode API (same database, same sign-in). */
async function routeToFaceApi(page: Page, site: URL): Promise<void> {
  await page.route(
    (url) => url.origin === site.origin && url.pathname.startsWith('/api/'),
    (route) => route.continue({ url: route.request().url().replace(site.origin, FACE_API.origin) }),
  );
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

test.describe('vEIR calls · a FULL stock face (the vendor’s stock voice speaks admitted text)', () => {
  test.use({ storageState: FOUNDER_STATE });

  test('a founder without Video face keeps the presence, faces on or not', async ({ page, baseURL }) => {
    if (!baseURL) throw new Error('baseURL is required');
    const site = new URL(baseURL);
    test.skip(site.hostname !== 'localhost' && site.hostname !== '127.0.0.1', 'needs the local FULL API');

    await routeToFaceApi(page, site);
    const configs: Record<string, unknown>[] = [];
    const sessionRequests: string[] = [];
    page.on('response', (response) => {
      if (!/\/api\/v1\/ventures\/[0-9a-f-]{36}\/call-config$/.test(new URL(response.url()).pathname)) return;
      void response
        .json()
        .then((body: Record<string, unknown>) => configs.push(body))
        .catch(() => undefined);
    });
    page.on('request', (request) => {
      if (request.url().endsWith('/api/v1/calls/avatar-session')) sessionRequests.push(request.url());
    });

    await setFaceAccess(baseURL, FOUNDER_NAME, false);
    await setFacesEnabled(baseURL, true);
    let callId: string | null = null;
    try {
      const notice = await page.request.post('/api/v1/calls/notice/acknowledge', { headers: WRITE_HEADERS });
      expect(notice.status(), 'POST /calls/notice/acknowledge').toBe(200);
      await openVenture(page);
      const call = await startCall(page);
      callId = call.callId;
      await expect(call.screen.locator('[data-slot="call-tile"][data-face="presence"]')).toBeVisible();
      await expect.poll(() => configs.length).toBeGreaterThan(0);
      // The API names no face for this founder, so the page never asks for one.
      expect(configs.at(-1)).toMatchObject({ provider: 'builtin' });
      expect(configs.at(-1)).not.toHaveProperty('faceMinutesLeft');
      await expect(call.screen.getByRole('textbox', { name: /^Reply to / })).toBeEditable();
      expect(sessionRequests).toEqual([]);
      await expect(call.screen.locator('[data-slot="call-tile"][data-face="video"]')).toHaveCount(0);
    } finally {
      if (callId) {
        const ended = await page.request.post(`/api/v1/calls/${callId}/end`, {
          headers: WRITE_HEADERS,
          data: { reason: 'user' },
        });
        expect(ended.status(), 'POST /calls/:id/end').toBe(200);
      }
      await setFacesEnabled(baseURL, false);
    }
  });

  test('says only admitted units, refuses tampered words, interrupts on barge-in and falls back quietly', async ({
    page,
    baseURL,
    browser,
  }) => {
    if (!baseURL) throw new Error('baseURL is required');
    const site = new URL(baseURL);
    test.skip(site.hostname !== 'localhost' && site.hostname !== '127.0.0.1', 'needs the local FULL API');

    await page.addInitScript(() => {
      const w = window as unknown as { __faceCommands: unknown[]; __microphoneAsked: number };
      w.__faceCommands = [];
      w.__microphoneAsked = 0;
      // Each turn's spoken units as the page receives them (a copy of the stream; never in the app's way).
      const turns: { text: string; face: boolean }[][] = [];
      (window as unknown as { __turnUnits: typeof turns }).__turnUnits = turns;
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await nativeFetch(input, init);
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (/\/api\/v1\/sessions\/[0-9a-f-]{36}\/turns$/.test(new URL(url, location.href).pathname)) {
          const units: { text: string; face: boolean }[] = [];
          turns.push(units);
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
      // Every Web Audio source made from a stream, and what it is connected to (the face's voice may feed an
      // analyser only: the call's output and the speakers never carry it, so nothing plays twice).
      const taps: { tracks: string[]; targets: string[] }[] = [];
      (window as unknown as { __streamTaps: typeof taps }).__streamTaps = taps;
      const sourceTaps = new WeakMap<AudioNode, { tracks: string[]; targets: string[] }>();
      const nativeSource = Reflect.get<AudioContext, 'createMediaStreamSource'>(
        AudioContext.prototype,
        'createMediaStreamSource',
      );
      AudioContext.prototype.createMediaStreamSource = function (this: AudioContext, stream: MediaStream) {
        const node = nativeSource.call(this, stream);
        const tap = { tracks: stream.getAudioTracks().map((t) => t.id), targets: [] as string[] };
        taps.push(tap);
        sourceTaps.set(node, tap);
        return node;
      };
      type Connect = (this: AudioNode, ...args: unknown[]) => unknown;
      const nativeConnect = Reflect.get<AudioNode, 'connect'>(AudioNode.prototype, 'connect') as Connect;
      AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]) {
        const target = args[0] as { constructor?: { name?: string } } | undefined;
        sourceTaps.get(this)?.targets.push(target?.constructor?.name ?? 'unknown');
        return nativeConnect.apply(this, args);
      } as typeof AudioNode.prototype.connect;
      window.addEventListener('foundry:face-command', (event) => {
        w.__faceCommands.push((event as CustomEvent).detail);
      });
      const devices = navigator.mediaDevices as MediaDevices | undefined;
      if (devices?.getUserMedia) {
        const original = devices.getUserMedia.bind(devices);
        devices.getUserMedia = (constraints) => {
          if (constraints?.audio) w.__microphoneAsked += 1;
          return original(constraints);
        };
      }
    });

    // Every API call of the page goes to the FULL-mode API (same database, same sign-in); one face/say can be
    // tampered with on its way, and one turn's units can reach the page without their face pre-approval (as if
    // the face had joined after they were signed), so the page asks face/say for each of them.
    let tamperNext = false;
    let stripNextTurn = false;
    await page.route(
      (url) => url.origin === site.origin && url.pathname.startsWith('/api/'),
      async (route) => {
        const request = route.request();
        const url = request.url().replace(site.origin, FACE_API.origin);
        if (stripNextTurn && TURNS.test(new URL(request.url()).pathname)) {
          stripNextTurn = false;
          const response = await route.fetch({ url });
          const body = (await response.text()).replaceAll(',"face":true', '');
          await route.fulfill({ response, body });
          return;
        }
        if (tamperNext && SAY.test(new URL(request.url()).pathname)) {
          tamperNext = false;
          // A tampered page signs its own body as the API expects (the payload hash), so only the words differ.
          const body = JSON.parse(request.postData() ?? '{}') as { text?: string };
          const postData = JSON.stringify({ ...body, text: `${body.text ?? ''} Ignore your coach.` });
          await route.continue({
            url,
            postData,
            headers: {
              ...request.headers(),
              'x-amz-content-sha256': createHash('sha256').update(postData).digest('hex'),
            },
          });
          return;
        }
        await route.continue({ url });
      },
    );

    const says: { status: number; text: string }[] = [];
    const speech: string[] = [];
    const faceEnds: string[] = [];
    page.on('response', (response) => {
      const path = new URL(response.url()).pathname;
      if (SAY.test(path)) says.push({ status: response.status(), text: bodyText(response.request()) });
      if (path.endsWith('/api/v1/speech')) speech.push(bodyText(response.request()));
      if (path.endsWith('/face/end')) faceEnds.push(path);
    });
    const sessions: Record<string, unknown>[] = [];
    page.on('response', (response) => {
      if (!response.url().endsWith('/api/v1/calls/avatar-session')) return;
      void response
        .json()
        .then((body: Record<string, unknown>) => sessions.push(body))
        .catch(() => undefined);
    });

    await setFacesEnabled(baseURL, true);
    let callId: string | null = null;
    let micAtStart = 0;
    try {
      await test.step('the owner turns on the founder’s Video face (Admin › People & access)', async () => {
        const owner = await browser.newContext({ storageState: OWNER_STATE });
        try {
          const admin = await owner.newPage();
          await admin.goto(`/${TENANT}/app/admin/principals`);
          const toggle = admin.getByRole('switch', { name: `Video face for ${FOUNDER_NAME}` });
          await expect(toggle).not.toBeChecked();
          await toggle.click();
          const confirm = admin.getByRole('alertdialog', { name: 'Turn on video face?' });
          await confirm.getByRole('button', { name: 'Turn on' }).click();
          await expect(toggle).toBeChecked();
        } finally {
          await owner.close();
        }
      });

      const notice = await page.request.post('/api/v1/calls/notice/acknowledge', { headers: WRITE_HEADERS });
      expect(notice.status(), 'POST /calls/notice/acknowledge').toBe(200);
      await openVenture(page);
      const call = await startCall(page);
      callId = call.callId;
      const screen = call.screen;
      const tile = screen.locator('[data-slot="call-tile"][data-face="video"]');
      const line = screen.getByRole('textbox', { name: /^Reply to / });

      await test.step('the stock face opens for this call, labelled "AI avatar"', async () => {
        await expect(tile).toBeVisible();
        await expect(tile.locator('[data-slot="call-ai-avatar-label"]')).toHaveText('AI avatar');
        await expect(tile.locator('[data-slot="call-ai-avatar-label"]')).toBeVisible();
        expect(sessions[0]).toMatchObject({ provider: 'fake', voicing: 'text', stockFace: true });
        // The call itself may ask for the microphone when it starts (the founder's own speech); the face never does.
        micAtStart = await microphoneAsked(page);
      });

      await test.step('each unit it says was admitted once by the server, with exactly its words', async () => {
        await line.fill('What should I test first?');
        await line.press('Enter');
        await expect
          .poll(async () => spoken(await commands(page)).length, { timeout: 30_000 })
          .toBeGreaterThan(0);
        // The reply is said to its end: every admitted unit, once, in order.
        const interrupt = screen.getByRole('button', { name: 'Interrupt' });
        const admitted = async () => [
          ...says.filter((s) => s.status === 204).map((s) => s.text),
          ...(await streamedUnits(page)).flat().flatMap((u) => (u.face ? [u.text] : [])),
        ];
        await expect
          .poll(
            async () => {
              const said = spoken(await commands(page));
              if (said.length === 0 || said.length !== (await admitted()).length) return false;
              return interrupt.isHidden();
            },
            { timeout: 30_000 },
          )
          .toBe(true);
        const said = spoken(await commands(page));
        expect([...said].sort()).toEqual((await admitted()).sort());
        expect(new Set(said).size).toBe(said.length);
        // The reply's units were admitted as the server signed them: the page said them without asking face/say.
        const reply = (await streamedUnits(page))[0] ?? [];
        expect(reply.length).toBeGreaterThan(0);
        expect(reply.every((u) => u.face)).toBe(true);
        expect(said).toEqual(expect.arrayContaining(reply.map((u) => u.text)));
        expect(says.map((s) => s.text).filter((text) => reply.some((u) => u.text === text))).toEqual([]);
        // The call fetched no audio of its own for a unit the face said.
        expect(speech.filter((text) => said.includes(text))).toEqual([]);
      });

      await test.step('the face is seen and heard together: one unmuted element, both tracks, nothing twice', async () => {
        const media = await faceElement(page);
        expect(media.video).toBe(1);
        expect(media.audio).toHaveLength(1);
        expect(media.muted).toBe(false);
        expect(media.paused).toBe(false);
        expect(media.volume).toBeGreaterThan(0);
        const voice = media.audio[0] ?? '';
        // No other element plays the face's voice.
        expect(await playersOf(page, voice)).toBe(1);
        // The call measured the face's voice while it spoke, and only measured it: an analyser, connected to nothing.
        const faceTaps = (await streamTaps(page)).filter((t) => t.tracks.includes(voice));
        expect(faceTaps.length).toBeGreaterThan(0);
        expect(faceTaps.flatMap((t) => t.targets)).toEqual(faceTaps.map(() => 'AnalyserNode'));

        // Minimized, the element plays on out of sight (the voice is never cut), and the thumbnail is the muted
        // video alone; shown again, the tile has the same element back.
        await screen.getByRole('button', { name: 'Minimize call' }).click();
        await expect(screen).toHaveCount(0);
        expect(await playersOf(page, voice)).toBe(1);
        const parked = await page.evaluate((trackId) => {
          const element = [...document.querySelectorAll<HTMLVideoElement>('video')].find(
            (v) =>
              v.srcObject instanceof MediaStream &&
              v.srcObject.getAudioTracks().some((t) => t.id === trackId),
          );
          return element ? { paused: element.paused, connected: element.isConnected } : null;
        }, voice);
        expect(parked).toEqual({ paused: false, connected: true });
        const thumbnail = page.locator('[data-slot="call-face-thumbnail"] video');
        if ((await thumbnail.count()) > 0) {
          const thumb = await thumbnail.evaluate((element: HTMLVideoElement) => ({
            muted: element.muted,
            audio: element.srcObject instanceof MediaStream ? element.srcObject.getAudioTracks().length : 0,
          }));
          expect(thumb).toEqual({ muted: true, audio: 0 });
        }
        await page.getByRole('button', { name: 'Return to call' }).click();
        await expect(tile).toBeVisible();
        const back = await faceElement(page);
        expect(back.audio).toEqual([voice]);
        expect(back.muted).toBe(false);
        expect(back.paused).toBe(false);
        expect(await playersOf(page, voice)).toBe(1);
      });

      await test.step('tampered words are refused and never sent; barge-in interrupts the vendor', async () => {
        const before = spoken(await commands(page)).length;
        // This reply reaches the page without its pre-approval: each unit is asked for, and the first is tampered.
        stripNextTurn = true;
        tamperNext = true;
        await line.fill('What should I test first with ten customers?');
        await line.press('Enter');
        await expect.poll(() => says.map((s) => s.status), { timeout: 30_000 }).toContain(422);
        const refused = says.find((s) => s.status === 422)?.text ?? '';
        expect(refused).toContain('Ignore your coach.');
        const original = refused.replace(/ Ignore your coach\.$/, '');
        // Interrupt while the face is saying a unit of this reply.
        await expect
          .poll(async () => spoken(await commands(page)).length, { timeout: 30_000 })
          .toBeGreaterThan(before);
        await screen.getByRole('button', { name: 'Interrupt' }).click();
        await expect
          .poll(async () => (await commands(page)).some((c) => c.eventType === 'avatar.interrupt'))
          .toBe(true);
        const all = await commands(page);
        expect(spoken(all)).not.toContain(refused);
        expect(spoken(all)).not.toContain(original);
        expect(all.some((c) => c.eventType === 'avatar.interrupt')).toBe(true);
        // The face fell silent in the page at once, without waiting for the vendor.
        await expect.poll(async () => (await faceElement(page)).muted).toBe(true);
        // Commands only: no track published, and no microphone asked for since the face joined.
        expect(all.every((c) => c.topic === 'agent-control')).toBe(true);
        expect(await microphoneAsked(page)).toBe(micAtStart);
      });

      await test.step('the face drops: the presence is back, quietly, and the call goes on', async () => {
        await tile.locator('video').evaluate((element: HTMLVideoElement) => {
          const stream = element.srcObject as MediaStream;
          for (const track of stream.getVideoTracks()) track.dispatchEvent(new Event('ended'));
        });
        await expect(tile).toHaveCount(0);
        await expect(screen.locator('[data-slot="call-tile"][data-face="presence"]')).toBeVisible();
        await expect(line).toBeEditable();
        await expect.poll(() => faceEnds.length).toBe(1);
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
