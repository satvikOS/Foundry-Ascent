import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, type Locator, type Page } from '@playwright/test';

import {
  expectNoHorizontalScroll,
  expectNoSeriousA11yViolations,
  FOUNDER_STATE,
  openVenture,
  SEEDED_MENTOR_NAME,
  setFacesEnabled,
  test,
  useTheme,
} from './support/fixtures';

/*
 * The face of a call (docs/architecture/calls.md §4) end to end, with the development stand-in behind the real
 * API (EMBODIMENT_PROVIDER=fake on the e2e server: a canvas face, no one's likeness, no vendor). Faces ship off,
 * so the test switches them on as the owner and off again. Everything else is the production build and the real
 * server: the call settings name the face, the call opens waiting for it ("Connecting to Thomas…", no intro, no
 * microphone heard), the avatar session is opened for this live call, the adapter's chunk loads, the canvas face joins,
 * the call tile becomes its video (labelled "AI avatar") and only then does the conversation start, a reply arrives
 * while it shows; when the vendor ends the face's session the call replaces it with a new session of the same call
 * (the server allows it, metered on its own) and the conversation goes on; and when video cannot come back the tile
 * says so and offers the voice call instead of turning into one by itself (owner, round 3).
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

  test('the face comes first, then the conversation; a session the vendor ends is replaced; never a silent downgrade', async ({
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
      // ⌘K → Video call (the side panel's Call offers the same choice).
      await page.keyboard.press('ControlOrMeta+k');
      await page
        .getByRole('dialog')
        .getByRole('option', { name: /^Video call with / })
        .click();
      // The call screen, whichever kind it shows (a video call that loses its face may go on as voice).
      const screen = page.getByRole('dialog', { name: /^(Voice|Video) call with / });
      await expect(page.getByRole('dialog', { name: /^Video call with / })).toBeVisible();
      await expect(screen.locator('[data-slot="call-kind"]')).toContainText('Video call');
      // Hold the avatar session's answer, so the waiting state can be seen and checked.
      let releaseSession: () => void = () => undefined;
      const sessionHeld = new Promise<void>((resolve) => {
        releaseSession = resolve;
      });
      await page.route(
        '**/api/v1/calls/avatar-session',
        async (route) => {
          await sessionHeld;
          await route.continue();
        },
        { times: 1 },
      );
      const speechAsked: string[] = [];
      page.on('request', (request) => {
        if (request.url().endsWith('/api/v1/speech')) speechAsked.push(request.url());
      });
      const startedAt = Date.now();
      await screen.getByRole('button', { name: 'Start call' }).click();
      callId = ((await (await started).json()) as { call: { id: string } }).call.id;

      // The same call tile throughout: a video while the face is live; on a video call, never the sphere.
      const tile = screen.locator('[data-slot="call-tile"][data-face="video"]');
      const video = tile.locator('video');

      await test.step('first the face: "Connecting to Thomas…", and nothing is said or heard meanwhile', async () => {
        const waiting = screen.locator('[data-slot="call-tile"][data-face="video-connecting"]');
        await expect(waiting).toBeVisible();
        await expect(waiting).toContainText(`Connecting to ${SEEDED_MENTOR_NAME}…`);
        await expect(screen.locator('[data-slot="call-stage"]')).toHaveCount(0);
        await expect(screen.getByRole('textbox', { name: /^Reply to / })).toHaveCount(0);
        await page.waitForTimeout(500);
        expect(speechAsked).toEqual([]);
        await shoot(page, 'video-call-connecting');
        releaseSession();
      });

      await test.step('the server opens the face for this live call, and the tile shows it', async () => {
        await expect(tile).toBeVisible();
        test.info().annotations.push({
          type: 'video call: Start call to first frame (stand-in, local)',
          description: `${String(Date.now() - startedAt)} ms`,
        });
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.status).toBe(200);
        expect(sessions[0]?.body).toMatchObject({ provider: 'fake', voicing: 'audio' });
        expect(String(sessions[0]?.body.token)).toMatch(/^fake\./);
        // Frames are flowing from the face, and the tile itself never plays sound.
        await expect.poll(() => videoState(video)).toEqual({ stream: true, muted: true, width: 640 });
        // The persona's name stays on the tile, over the face; the header names it and the kind of call.
        await expect(tile.locator('[data-slot="call-name-tag"]')).toContainText(SEEDED_MENTOR_NAME);
        // Every face says what it is: a lifelike face is never taken for a person.
        await expect(tile.locator('[data-slot="call-ai-avatar-label"]')).toHaveText('AI avatar');
        await expect(screen.locator('[data-slot="call-kind"]')).toContainText('Video call');
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
        await expect(bar.getByRole('img', { name: 'AI avatar' })).toBeVisible();
        await expect(bar).toContainText('Video call');
        await shoot(page, 'video-call-mini-bar');
        await bar.getByRole('button', { name: 'Return to call' }).click();
        await expect(tile).toBeVisible();
        // Still the one face of this call.
        expect(sessions).toHaveLength(1);
      });

      await test.step('the vendor ends the session: a new session of the same call replaces it, and the call goes on', async () => {
        await video.evaluate((element: HTMLVideoElement) => {
          const stream = element.srcObject as MediaStream;
          for (const track of stream.getVideoTracks()) track.dispatchEvent(new Event('ended'));
        });
        // The server is told the first one ended, then opens the next session of this call (0029), and it shows.
        await expect.poll(() => faceEnds.length).toBe(1);
        await expect.poll(() => sessions.length, { timeout: 15_000 }).toBe(2);
        expect(sessions[1]?.status).toBe(200);
        expect(String(sessions[1]?.body.token)).toMatch(/^fake\./);
        await expect(tile).toBeVisible({ timeout: 15_000 });
        await expect(screen.locator('[data-slot="call-stage"]')).toHaveCount(0);
        // Still the same video call, its conversation going on: a reply arrives through the new face.
        await expect(page.getByRole('dialog', { name: /^Video call with / })).toBeVisible();
        const line = screen.getByRole('textbox', { name: /^Reply to / });
        await line.fill('And after that?');
        await line.press('Enter');
        await expect(screen.getByRole('region', { name: 'Captions' })).not.toBeEmpty({ timeout: 30_000 });
        await expect(tile).toBeVisible();
      });

      await test.step('when video cannot come back, the tile says so and offers the voice call, never switching itself', async () => {
        // The server offers no more video for now (faces switched off: as a used-up credit or cap would).
        await setFacesEnabled(baseURL, false);
        await video.evaluate((element: HTMLVideoElement) => {
          const stream = element.srcObject as MediaStream;
          for (const track of stream.getVideoTracks()) track.dispatchEvent(new Event('ended'));
        });
        await expect(tile).toHaveCount(0);
        // No stand-in presence for video: the tile says video is not available right now.
        await expect(screen.locator('[data-slot="call-tile"][data-face="video-unavailable"]')).toBeVisible({
          timeout: 15_000,
        });
        await expect(screen.locator('[data-slot="call-stage"]')).toHaveCount(0);
        const off = screen.locator('[data-slot="call-video-pending"]');
        await expect(off).toContainText('Video isn’t available right now');
        await expect(off).toContainText(`Your conversation with ${SEEDED_MENTOR_NAME} is kept.`);
        // The status line says it too (announced politely).
        await expect(
          screen.getByRole('status').filter({ hasText: 'Video isn’t available right now' }),
        ).toHaveCount(1);
        // Still a video call until the founder says otherwise, and the conversation is there.
        await expect(page.getByRole('dialog', { name: /^Video call with / })).toBeVisible();
        await expect(screen.getByRole('textbox', { name: /^Reply to / })).toBeEditable();
        await shoot(page, 'video-call-unavailable');
        await off.getByRole('button', { name: /^Voice call$/ }).click();
        await expect(page.getByRole('dialog', { name: /^Voice call with / })).toBeVisible();
        await expect(screen.locator('[data-slot="call-kind"]')).toContainText('Voice call');
        await expect(screen.locator('[data-slot="call-tile"][data-face="presence"]')).toBeVisible();
        await expect(screen.getByRole('button', { name: /^End call/ })).toBeVisible();
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
    // Video is offered nowhere it cannot start: in ⌘K it is listed, disabled, with why.
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByRole('dialog').getByRole('option', { name: /^Video call with / })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await page
      .getByRole('dialog')
      .getByRole('option', { name: /^Voice call with / })
      .click();
    const screen = page.getByRole('dialog', { name: /^Voice call with / });
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

  test('voice and video are two calls: the header starts either, a voice call never asks for a face, and switches', async ({
    page,
    baseURL,
  }) => {
    if (!baseURL) throw new Error('baseURL is required');
    const asked: string[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/api/v1/calls/avatar-session')) asked.push(request.url());
    });
    const faceEnds: string[] = [];
    page.on('request', (request) => {
      if (/\/api\/v1\/calls\/[0-9a-f-]{36}\/face\/end$/.test(request.url()))
        faceEnds.push(request.postData() ?? '');
    });
    await setFacesEnabled(baseURL, true);
    let callId: string | null = null;
    try {
      const notice = await page.request.post('/api/v1/calls/notice/acknowledge', { headers: WRITE_HEADERS });
      expect(notice.status(), 'POST /calls/notice/acknowledge').toBe(200);
      await openVenture(page);
      // New chat's corner: Voice call and Video call, both offered.
      const corner = page.getByRole('main').getByRole('group', { name: 'Call' });
      await expect(corner.getByRole('link', { name: /^Voice call with / })).toBeVisible();
      await expect(corner.getByRole('link', { name: /^Video call with / })).toBeVisible();
      const started = page.waitForResponse(
        (response) => /\/sessions\/[0-9a-f-]{36}\/calls$/.test(response.url()) && response.status() === 201,
      );
      await corner.getByRole('link', { name: /^Voice call with / }).click();
      await page.waitForURL(/\/c\/[0-9a-f-]{36}\?call=voice$/);
      callId = ((await (await started).json()) as { call: { id: string } }).call.id;
      const voice = page.getByRole('dialog', { name: /^Voice call with / });
      await expect(voice.locator('[data-slot="call-tile"][data-face="presence"]')).toBeVisible();
      await page.waitForTimeout(1_000);
      expect(asked).toEqual([]);

      await test.step('switched to video, the face is asked for once and shows', async () => {
        await voice.getByRole('button', { name: 'Switch to video' }).click();
        await page.waitForURL(/\?call=video$/);
        const video = page.getByRole('dialog', { name: /^Video call with / });
        await expect(video.locator('[data-slot="call-tile"][data-face="video"]')).toBeVisible({
          timeout: 15_000,
        });
        expect(asked).toHaveLength(1);
      });

      await test.step('switched back to voice, the face ends (told to the server); video can come back', async () => {
        const video = page.getByRole('dialog', { name: /^Video call with / });
        await video.getByRole('button', { name: 'Switch to voice' }).click();
        await page.waitForURL(/\?call=voice$/);
        await expect(voice.locator('[data-slot="call-tile"][data-face="presence"]')).toBeVisible();
        await expect.poll(() => faceEnds.length).toBe(1);
        expect(faceEnds[0]).toContain('switched_to_voice');
        await expect(voice.locator('[data-slot="call-video-pending"]')).toHaveCount(0);
        expect(asked).toHaveLength(1);
        // A new session of the same call (the server allows a face the page dropped to be replaced).
        await voice.getByRole('button', { name: 'Switch to video' }).click();
        await page.waitForURL(/\?call=video$/);
        await expect(
          page
            .getByRole('dialog', { name: /^Video call with / })
            .locator('[data-slot="call-tile"][data-face="video"]'),
        ).toBeVisible({ timeout: 15_000 });
        expect(asked).toHaveLength(2);
        await page
          .getByRole('dialog', { name: /^Video call with / })
          .getByRole('button', { name: 'Switch to voice' })
          .click();
        await page.waitForURL(/\?call=voice$/);
        await expect.poll(() => faceEnds.length).toBe(2);
      });

      await test.step('minimized on another page, the bar names the kind; Return comes back to it', async () => {
        await voice.getByRole('button', { name: 'Minimize call' }).click();
        await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Knowledge' }).click();
        const bar = page.getByRole('region', { name: /^Call with / });
        await expect(bar).toContainText('Voice call');
        await expectNoHorizontalScroll(page);
        await bar.getByRole('button', { name: 'Return to call' }).click();
        await expect(voice).toBeVisible();
        await page.goBack();
        await expect(voice).toHaveCount(0);
        await expect(bar).toBeVisible();
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

test.describe('vEIR calls · the disclosure before a first video call', () => {
  // A person who has read neither call's disclosure in this browser.
  test.use({ storageState: FOUNDER_STATE, callDisclosuresSeen: false });

  test('the first video call says what is synthetic before it starts; turning video on in a voice call asks too', async ({
    page,
    baseURL,
  }) => {
    if (!baseURL) throw new Error('baseURL is required');
    const callIds: string[] = [];
    page.on('response', (response) => {
      if (response.request().method() !== 'POST' || response.status() !== 201) return;
      if (!/\/sessions\/[0-9a-f-]{36}\/calls$/.test(response.url())) return;
      void response
        .json()
        .then((body: { call: { id: string } }) => callIds.push(body.call.id))
        .catch(() => undefined);
    });
    await setFacesEnabled(baseURL, true);
    try {
      const notice = await page.request.post('/api/v1/calls/notice/acknowledge', { headers: WRITE_HEADERS });
      expect(notice.status(), 'POST /calls/notice/acknowledge').toBe(200);
      await openVenture(page);
      const corner = page.getByRole('main').getByRole('group', { name: 'Call' });

      await test.step('the first video call: the facts, then Start call', async () => {
        await corner.getByRole('link', { name: /^Video call with / }).click();
        const disclosure = page.getByRole('alertdialog', {
          name: `Before your video call with ${SEEDED_MENTOR_NAME}`,
        });
        await expect(disclosure).toBeVisible();
        await expect(disclosure).toContainText(`${SEEDED_MENTOR_NAME} is an AI mentor, not a person.`);
        await expect(disclosure).toContainText(
          'On video, the face you see is an AI avatar, and the voice is AI-generated.',
        );
        await expect(disclosure).toContainText('remembered for next time');
        await expect(disclosure).toContainText('Private');
        await expect(disclosure).toContainText('A person from the program');
        await expect(disclosure).toContainText('can’t pass on messages or schedule anything');
        await expect(disclosure).toContainText('legal, medical or financial advice');
        await expectNoSeriousA11yViolations(page, 'the video call disclosure');
        await disclosure.getByRole('button', { name: 'Start call' }).click();
        await expect(disclosure).toHaveCount(0);
        const call = page.getByRole('dialog', { name: /^Video call with / });
        const tile = call.locator('[data-slot="call-tile"][data-face="video"]');
        await expect(tile).toBeVisible({ timeout: 15_000 });
        await expect(tile.locator('[data-slot="call-ai-avatar-label"]')).toHaveText('AI avatar');
        await call.getByRole('button', { name: 'End call' }).click();
        await expect(page.getByRole('region', { name: 'Call ended' })).toBeVisible({ timeout: 20_000 });
      });

      await test.step('a voice call turning video on, before video was ever read: Turn on video asks first', async () => {
        // Neither disclosure read in this browser: the voice call asks first, then turning video on asks too.
        await page.evaluate(() => {
          for (const key of Object.keys(window.localStorage)) {
            if (key.startsWith('fa.call.disclosure.')) window.localStorage.removeItem(key);
          }
        });
        await page.goto(page.url().split('?')[0] ?? '');
        await page
          .getByRole('main')
          .getByRole('group', { name: 'Call' })
          .getByRole('link', { name: /^Voice call with / })
          .click();
        const first = page.getByRole('alertdialog', { name: /^Before your voice call with / });
        await expect(first).toContainText('The voice you hear is AI-generated.');
        await expect(first).not.toContainText('AI avatar');
        await first.getByRole('button', { name: 'Start call' }).click();
        const voice = page.getByRole('dialog', { name: /^Voice call with / });
        await expect(voice.getByRole('textbox', { name: /^Reply to / })).toBeVisible({ timeout: 20_000 });
        await voice.getByRole('button', { name: 'Switch to video' }).click();
        const ask = page.getByRole('alertdialog', {
          name: `Before your video call with ${SEEDED_MENTOR_NAME}`,
        });
        await expect(ask).toContainText('On video, the face you see is an AI avatar');
        await expect(ask.getByRole('button', { name: 'Turn on video' })).toBeVisible();
        // Still a voice call while the founder reads.
        await expect(voice).toBeVisible();
        await ask.getByRole('button', { name: 'Turn on video' }).click();
        const video = page.getByRole('dialog', { name: /^Video call with / });
        await expect(video.locator('[data-slot="call-tile"][data-face="video"]')).toBeVisible({
          timeout: 15_000,
        });
        await video.getByRole('button', { name: 'End call' }).click();
        await expect(page.getByRole('region', { name: 'Call ended' })).toBeVisible({ timeout: 20_000 });
      });
    } finally {
      for (const id of callIds) {
        await page.request.post(`/api/v1/calls/${id}/end`, {
          headers: WRITE_HEADERS,
          data: { reason: 'user' },
        });
      }
      await setFacesEnabled(baseURL, false);
    }
  });
});
