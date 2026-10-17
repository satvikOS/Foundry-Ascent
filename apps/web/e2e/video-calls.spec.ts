import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, type Locator, type Page } from '@playwright/test';

import {
  expectNoHorizontalScroll,
  expectNoSeriousA11yViolations,
  FOUNDER_STATE,
  openVenture,
  test,
  useTheme,
} from './support/fixtures';

/*
 * The face of a call (docs/architecture/calls.md §4) with the development stand-in. No vendor runs here, so
 * the test does what the local API does with EMBODIMENT_PROVIDER=fake: the call settings name the stand-in,
 * and the avatar session (answered by the real API first, with its checks and its audit) carries a `fake.`
 * token. Everything after that is the production build: the adapter's chunk loads, the canvas face connects,
 * the call becomes a video tile, and when the face drops the call carries on with the presence.
 *
 * E2E_SHOTS_DIR=<dir> also saves the tile (and the presence it falls back to) at desktop and phone width, in
 * light and dark.
 */

const WRITE_HEADERS = { 'x-requested-with': 'foundry-ascent', 'content-type': 'application/json' };
const SHOTS = process.env.E2E_SHOTS_DIR ?? '';
const DEVICES = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

interface MintRequest {
  ventureId: string;
  callId?: string;
}

/** Serves the stand-in face to this page: the call settings name it, and its session gets a `fake.` token. */
async function standInFace(page: Page): Promise<MintRequest[]> {
  const minted: MintRequest[] = [];
  await page.route('**/api/v1/ventures/*/call-config', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, provider: 'fake' } });
  });
  await page.route('**/api/v1/calls/avatar-session', async (route) => {
    minted.push(route.request().postDataJSON() as MintRequest);
    const response = await route.fetch();
    expect(response.status(), 'POST /calls/avatar-session (the real API answers first)').toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({
      response,
      json: {
        ...body,
        provider: 'fake',
        token: `fake.e2e-${String(minted.length)}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        voicing: 'audio',
      },
    });
  });
  return minted;
}

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

/** The vEIR's name above the call state (the dialog's own title is another, hidden heading). */
function nameHeading(screen: Locator): Locator {
  return screen.locator('h2[tabindex="-1"]');
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

  test('the face becomes a video tile, and the call goes on with the presence when the face drops', async ({
    page,
  }) => {
    const minted = await standInFace(page);
    const notice = await page.request.post('/api/v1/calls/notice/acknowledge', { headers: WRITE_HEADERS });
    expect(notice.status(), 'POST /calls/notice/acknowledge').toBe(200);
    const ventureId = await openVenture(page);

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
      const tile = screen.locator('[data-slot="call-video-tile"]');
      const video = tile.locator('video');

      await test.step('the session is minted for this live call, and the tile shows the face', async () => {
        await expect(tile).toBeVisible();
        expect(minted).toEqual([{ ventureId, callId }]);
        // Frames are flowing from the face, and the tile itself never plays sound.
        await expect.poll(() => videoState(video)).toEqual({ stream: true, muted: true, width: 640 });
        await expect(tile.locator('figcaption')).toContainText('vEIR');
        await expect(tile.locator('[data-slot="call-you-tile"]')).toBeVisible();
        // The name is on the tile; the heading stays for screen readers (and focus).
        await expect(nameHeading(screen)).toHaveClass(/sr-only/);
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

      await test.step('the face drops: the presence is back, quietly, and the call goes on', async () => {
        await video.evaluate((element: HTMLVideoElement) => {
          const stream = element.srcObject as MediaStream;
          for (const track of stream.getVideoTracks()) track.dispatchEvent(new Event('ended'));
        });
        await expect(tile).toHaveCount(0);
        await expect(screen.locator('[data-slot="call-stage"]')).toBeVisible();
        await expect(nameHeading(screen)).not.toHaveClass(/sr-only/);
        await expect(screen.getByRole('textbox', { name: /^Reply to / })).toBeEditable();
        await expect(screen.getByRole('button', { name: /^End call/ })).toBeVisible();
        // No second session: the face is given up for this call.
        expect(minted).toHaveLength(1);
        await shoot(page, 'video-call-dropped');
      });
    } finally {
      const ended = await page.request.post(`/api/v1/calls/${callId}/end`, {
        headers: WRITE_HEADERS,
        data: { reason: 'user' },
      });
      expect(ended.status(), 'POST /calls/:id/end').toBe(200);
    }
  });
});
