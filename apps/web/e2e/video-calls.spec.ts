import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, type Locator, type Page } from '@playwright/test';

import {
  expectNoHorizontalScroll,
  expectNoSeriousA11yViolations,
  FOUNDER_STATE,
  openVenture,
  setFacesEnabled,
  test,
  useTheme,
} from './support/fixtures';

/*
 * The face of a call (docs/architecture/calls.md §4) end to end, with the development stand-in behind the real
 * API (EMBODIMENT_PROVIDER=fake on the e2e server: a canvas face, no one's likeness, no vendor). Faces ship off,
 * so the test switches them on as the owner and off again. Everything else is the production build and the real
 * server: the call settings name the face, the avatar session is opened for this live call only (once), the
 * adapter's chunk loads, the canvas face joins, the call tile becomes its video, a reply arrives while it shows,
 * and when the face drops the call carries on with the presence and the server is told to end it.
 *
 * E2E_SHOTS_DIR=<dir> also saves the tile with the face and with the presence, at desktop and phone width, in
 * light and dark.
 */

const WRITE_HEADERS = { 'x-requested-with': 'foundry-ascent', 'content-type': 'application/json' };
const SHOTS = process.env.E2E_SHOTS_DIR ?? '';
const DEVICES = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

async function shoot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await useTheme(page, scheme);
    for (const device of DEVICES) {
      await page.setViewportSize({ width: device.width, height: device.height });
      // Let the layout settle at the new size (the tile is sized from the viewport).
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(SHOTS, `${name}-${device.name}-${scheme}.png`) });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

/** The face's video: its stream, whether it is muted, and the size of the frames it receives. */
async function videoState(video: Locator) {
  return video.evaluate((element: HTMLVideoElement) => ({
    stream: element.srcObject instanceof MediaStream,
    muted: element.muted,
    width: element.videoWidth,
  }));
}

test.describe('vEIR calls · a video face', () => {
  test.use({ storageState: FOUNDER_STATE });

  test('the face becomes the call tile’s video, and the call goes on with the presence when it drops', async ({
    page,
    baseURL,
  }) => {
    if (!baseURL) throw new Error('baseURL is required');
    const sessions: { status: number; body: Record<string, unknown> }[] = [];
    page.on('response', (response) => {
      if (!response.url().endsWith('/api/v1/calls/avatar-session')) return;
      void response
        .json()
        .then((body: Record<string, unknown>) => sessions.push({ status: response.status(), body }))
        .catch(() => undefined);
    });
    const faceEnds: string[] = [];
    page.on('request', (request) => {
      if (/\/api\/v1\/calls\/[0-9a-f-]{36}\/face\/end$/.test(request.url())) faceEnds.push(request.url());
    });

    await setFacesEnabled(baseURL, true);
    let callId: string | null = null;
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

      // The same call tile throughout: a video while the face is live, the presence otherwise.
      const tile = screen.locator('[data-slot="call-tile"][data-face="video"]');
      const video = tile.locator('video');

      await test.step('the server opens the face for this live call, and the tile shows it', async () => {
        await expect(tile).toBeVisible();
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.status).toBe(200);
        expect(sessions[0]?.body).toMatchObject({ provider: 'fake', voicing: 'audio' });
        expect(String(sessions[0]?.body.token)).toMatch(/^fake\./);
        // Frames are flowing from the face, and the tile itself never plays sound.
        await expect.poll(() => videoState(video)).toEqual({ stream: true, muted: true, width: 640 });
        // The name tag (the call's heading) stays on the tile, over the face.
        await expect(tile.locator('[data-slot="call-name-tag"]')).toContainText('vEIR');
        await expect(tile.locator('[data-slot="call-you-tile"]')).toBeVisible();
        await expectNoSeriousA11yViolations(page, 'video call');
        await expectNoHorizontalScroll(page);
        await shoot(page, 'video-call-tile');
      });

      await test.step('typing still works and the reply arrives while the face is shown', async () => {
        const line = screen.getByRole('textbox', { name: /^Reply to / });
        await line.fill('What should I test first?');
        await line.press('Enter');
        await expect(screen.getByRole('region', { name: 'Captions' })).not.toBeEmpty({ timeout: 30_000 });
        await expect(tile).toBeVisible();
      });

      await test.step('minimized, the call keeps its face and shows it in the bar', async () => {
        await screen.getByRole('button', { name: 'Minimize call' }).click();
        const bar = page.getByRole('region', { name: /^Call with / });
        await expect(bar.locator('[data-slot="call-face-thumbnail"] video')).toBeVisible();
        await shoot(page, 'video-call-mini-bar');
        await bar.getByRole('button', { name: 'Return to call' }).click();
        await expect(tile).toBeVisible();
        // Still the one face of this call.
        expect(sessions).toHaveLength(1);
      });

      await test.step('the face drops: the presence is back, quietly, and the call goes on', async () => {
        await video.evaluate((element: HTMLVideoElement) => {
          const stream = element.srcObject as MediaStream;
          for (const track of stream.getVideoTracks()) track.dispatchEvent(new Event('ended'));
        });
        await expect(tile).toHaveCount(0);
        await expect(screen.locator('[data-slot="call-tile"][data-face="presence"]')).toBeVisible();
        await expect(screen.locator('[data-slot="call-stage"]')).toBeVisible();
        await expect(screen.locator('[data-slot="call-name-tag"]')).toContainText('vEIR');
        await expect(screen.getByRole('textbox', { name: /^Reply to / })).toBeEditable();
        await expect(screen.getByRole('button', { name: /^End call/ })).toBeVisible();
        // The server is told, so the vendor session stops billing; no second session is opened.
        await expect.poll(() => faceEnds.length).toBe(1);
        expect(sessions).toHaveLength(1);
        await shoot(page, 'video-call-dropped');
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

  test('with faces off (the default), the call tile is exactly the presence and no face is asked for', async ({
    page,
  }) => {
    const asked: string[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/api/v1/calls/avatar-session')) asked.push(request.url());
    });
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
    const callId = ((await (await started).json()) as { call: { id: string } }).call.id;
    try {
      await expect(screen.locator('[data-slot="call-tile"][data-face="presence"]')).toBeVisible();
      await page.waitForTimeout(1_000);
      expect(asked).toEqual([]);
      await expect(screen.locator('[data-slot="call-video"]')).toHaveCount(0);
    } finally {
      const ended = await page.request.post(`/api/v1/calls/${callId}/end`, {
        headers: WRITE_HEADERS,
        data: { reason: 'user' },
      });
      expect(ended.status(), 'POST /calls/:id/end').toBe(200);
    }
  });
});
