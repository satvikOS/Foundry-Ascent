import { createHash } from 'node:crypto';

import { expect, type Page, type Request } from '@playwright/test';

import { FOUNDER_STATE, openVenture, setFacesEnabled, test } from './support/fixtures';

/*
 * A FULL stock face (docs/architecture/calls.md §4) end to end, silently: the production build and the real API,
 * whose development stand-in face runs in FULL mode (a second API on the same database, E2E_FACE_API_URL; the
 * page's API calls are routed to it). The stand-in is the real FULL adapter over an in-page room that "says"
 * each unit without a sound and announces every command it is sent. The test checks that every unit the face
 * says was admitted by the server first (one `POST /calls/:id/face/say` 204, then one `avatar.speak_text` with
 * the same words), that tampered words are refused (422) and never sent, that no track is published and no
 * microphone asked for, that barge-in interrupts the vendor, that the call never fetches its own audio for a
 * unit the face said, that the tile says "AI avatar", and that a face that drops leaves the call on the presence.
 */

const WRITE_HEADERS = { 'x-requested-with': 'foundry-ascent', 'content-type': 'application/json' };
const SAY = /\/api\/v1\/calls\/[0-9a-f-]{36}\/face\/say$/;

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

test.describe('vEIR calls · a FULL stock face (the vendor’s stock voice speaks admitted text)', () => {
  test.use({ storageState: FOUNDER_STATE });

  test('says only admitted units, refuses tampered words, interrupts on barge-in and falls back quietly', async ({
    page,
    baseURL,
  }) => {
    if (!baseURL) throw new Error('baseURL is required');
    const site = new URL(baseURL);
    test.skip(site.hostname !== 'localhost' && site.hostname !== '127.0.0.1', 'needs the local FULL API');

    await page.addInitScript(() => {
      const w = window as unknown as { __faceCommands: unknown[]; __microphoneAsked: number };
      w.__faceCommands = [];
      w.__microphoneAsked = 0;
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
    // tampered with on its way.
    let tamperNext = false;
    await page.route(
      (url) => url.origin === site.origin && url.pathname.startsWith('/api/'),
      async (route) => {
        const request = route.request();
        const url = request.url().replace(site.origin, FACE_API.origin);
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
      const notice = await page.request.post('/api/v1/calls/notice/acknowledge', { headers: WRITE_HEADERS });
      expect(notice.status(), 'POST /calls/notice/acknowledge').toBe(200);
      await openVenture(page);
      const started = page.waitForResponse(
        (response) => /\/sessions\/[0-9a-f-]{36}\/calls$/.test(response.url()) && response.status() === 201,
      );
      await page
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link', { name: /^Call / })
        .click();
      const screen = page.getByRole('dialog', { name: /^Call with / });
      await screen.getByRole('button', { name: 'Start call' }).click();
      callId = ((await (await started).json()) as { call: { id: string } }).call.id;
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
        await expect
          .poll(
            async () => {
              const said = spoken(await commands(page));
              const admitted = says.filter((s) => s.status === 204).map((s) => s.text);
              if (said.length === 0 || said.length !== admitted.length) return false;
              return interrupt.isHidden();
            },
            { timeout: 30_000 },
          )
          .toBe(true);
        const said = spoken(await commands(page));
        expect(said).toEqual(says.filter((s) => s.status === 204).map((s) => s.text));
        expect(new Set(said).size).toBe(said.length);
        // The call fetched no audio of its own for a unit the face said.
        expect(speech.filter((text) => said.includes(text))).toEqual([]);
      });

      await test.step('tampered words are refused and never sent; barge-in interrupts the vendor', async () => {
        const before = spoken(await commands(page)).length;
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
    }
  });
});
