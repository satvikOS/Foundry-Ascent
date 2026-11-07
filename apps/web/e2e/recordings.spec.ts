import { expect, type Locator, type Page } from '@playwright/test';

import {
  expectNoHorizontalScroll,
  FOUNDER_STATE,
  openVenture,
  runToken,
  setFacesEnabled,
  startConversation,
  TENANT,
  test,
  useTheme,
} from './support/fixtures';

/*
 * Call recordings (ADR-0023) against the real API in mock mode, with the development stand-in for the recordings
 * bucket (presigned PUTs and GETs at the API's own origin: cross-origin under the production CSP, as the bucket is).
 * The browser has a fake microphone (Chromium's fake media device); there is no Amazon Transcribe here, so the call
 * goes on typed and its replies show as captions. The recording is the call itself (MediaRecorder on the call's
 * presence and its sound), uploaded, replayed with its captions in step, and deleted. Every media element is muted,
 * so the test browser never makes a sound.
 */

const WRITE_HEADERS = { 'x-requested-with': 'foundry-ascent', 'content-type': 'application/json' };
const FILES_ORIGIN = new URL(process.env.E2E_API_URL ?? 'http://localhost:8787').origin;

/**
 * The SPA's production Content-Security-Policy (infra/cdk/src/constructs/edge.ts) with the recordings bucket's origin
 * (the API here) in `connect-src` (uploads, captions) and `media-src` (the player), and nothing else from outside.
 */
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  `media-src 'self' blob: ${FILES_ORIGIN}`,
  "font-src 'self' data:",
  `connect-src 'self' ${FILES_ORIGIN}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

test.use({
  storageState: FOUNDER_STATE,
  permissions: ['microphone', 'local-network-access'],
  launchOptions: {
    args: ['--disable-audio-output', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
});

/** Every media element on the page plays muted (a replay must never reach the speakers). */
async function muteMedia(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const mute = () => {
      for (const media of document.querySelectorAll('video, audio')) (media as HTMLMediaElement).muted = true;
    };
    new MutationObserver(mute).observe(document, { childList: true, subtree: true });
    // Before any media plays (capture phase), whatever started it.
    document.addEventListener(
      'play',
      (event) => {
        if (event.target instanceof HTMLMediaElement) event.target.muted = true;
      },
      true,
    );
  });
}

/** Pages are served with the production CSP; every violation they report is collected. */
async function enforceProductionCsp(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __cspViolations: string[] }).__cspViolations = seen;
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push(
        `${event.effectiveDirective} ${event.blockedURI} ${new URL(event.sourceFile || '/', location.href).pathname}`,
      );
    });
  });
  await page.route(
    (url) => url.pathname.startsWith(`/${TENANT}/app`),
    async (route) => {
      if (route.request().resourceType() !== 'document') return route.continue();
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: { ...response.headers(), 'content-security-policy': PRODUCTION_CSP },
      });
    },
  );
  return () => page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);
}

async function voiceNoticeSeen(page: Page): Promise<void> {
  const response = await page.request.post('/api/v1/calls/notice/acknowledge', { headers: WRITE_HEADERS });
  expect(response.status(), 'POST /calls/notice/acknowledge').toBe(200);
}

function callScreen(page: Page): Locator {
  return page.getByRole('dialog', { name: /^(Voice|Video) call with / });
}

/** Opens a voice call in the conversation on screen and waits for its typed line. */
async function openCall(page: Page): Promise<{ screen: Locator; reply: Locator }> {
  await page
    .getByRole('main')
    .getByRole('link', { name: /^Voice call with / })
    .first()
    .click();
  const screen = callScreen(page);
  const reply = screen.getByRole('textbox', { name: /^Reply to / });
  await expect(reply).toBeFocused({ timeout: 20_000 });
  return { screen, reply };
}

/** Types a line to the vEIR and waits until its reply is stored and shows as captions. */
async function say(page: Page, reply: Locator, sessionId: string, text: string): Promise<void> {
  const before = await answeredTurns(page, sessionId);
  await reply.fill(text);
  await reply.press('Enter');
  await expect.poll(() => answeredTurns(page, sessionId), { timeout: 30_000 }).toBeGreaterThan(before);
  await expect
    .poll(
      async () =>
        ((await callScreen(page).getByRole('region', { name: 'Captions' }).textContent()) ?? '').trim(),
      {
        timeout: 15_000,
      },
    )
    .not.toBe('');
}

/** How many turns of the conversation have a reply. */
async function answeredTurns(page: Page, sessionId: string): Promise<number> {
  const response = await page.request.get(`/api/v1/sessions/${sessionId}`);
  expect(response.status(), 'GET /sessions/:id').toBe(200);
  const { turns } = (await response.json()) as { turns: { response: unknown }[] };
  return turns.filter((turn) => turn.response !== null && turn.response !== undefined).length;
}

/** Ends the call from its screen (End, then its short Undo window) and dismisses the review. */
async function endCall(page: Page): Promise<void> {
  await callScreen(page).getByRole('button', { name: 'End call' }).click();
  const review = page.getByRole('region', { name: 'Call ended' });
  await expect(review).toBeVisible({ timeout: 20_000 });
  await review.getByRole('button', { name: 'Dismiss call review' }).click();
}

/** Starts a recording from the call screen (its notice first: each test's browser is new). */
async function record(page: Page, screen: Locator): Promise<void> {
  await screen.getByRole('button', { name: 'Record' }).click();
  await page
    .getByRole('alertdialog', { name: 'Record this call?' })
    .getByRole('button', { name: 'Start recording' })
    .click();
  await expect(screen.getByTestId('recording-indicator')).toBeVisible();
}

interface ListedRecording {
  id: string;
  sessionId: string;
  status: string;
  hasCaptions: boolean;
}

async function recordingsOf(page: Page, sessionId: string): Promise<ListedRecording[]> {
  const response = await page.request.get(`/api/v1/recordings?sessionId=${sessionId}`);
  expect(response.status(), 'GET /recordings').toBe(200);
  return ((await response.json()) as { items: ListedRecording[] }).items;
}

test.describe('call recordings', () => {
  test('records a call, stops, replays it with its captions in step, and deletes it', async ({ page }) => {
    test.setTimeout(120_000);
    await muteMedia(page);
    const violations = await enforceProductionCsp(page);
    await voiceNoticeSeen(page);
    const ventureId = await openVenture(page);
    const sessionId = await startConversation(page, `What should the pilot measure first? ${runToken()}`);
    await expect(page.getByRole('article', { name: 'Exchange 1' })).toBeVisible({ timeout: 30_000 });

    const { screen, reply } = await openCall(page);
    // The first time: what is recorded, where it is kept, how to delete it.
    await screen.getByRole('button', { name: 'Record' }).click();
    const notice = page.getByRole('alertdialog', { name: 'Record this call?' });
    await expect(notice).toContainText('Both voices and the captions are recorded');
    await expect(notice).toContainText('Only you can watch it.');
    await expect(notice).toContainText('Deleting the conversation deletes it too');
    await notice.getByRole('button', { name: 'Start recording' }).click();
    const indicator = screen.getByTestId('recording-indicator');
    await expect(indicator).toContainText('REC');
    const stop = screen.getByRole('button', { name: /^Stop recording, / });
    await expect(stop).toHaveAttribute('aria-pressed', 'true');

    const line = `Footfall at the east wing, ${runToken()}`;
    await say(page, reply, sessionId, line);
    await expect(indicator).toContainText(/0:0[2-9]|0:[1-5]\d/, { timeout: 15_000 });

    const completed = page.waitForResponse(
      (response) =>
        /\/recordings\/[0-9a-f-]{36}\/complete$/.test(response.url()) && response.status() === 200,
    );
    await stop.click();
    await completed;
    await expect(page.getByText('Recording saved')).toBeVisible();
    await expect(indicator).toHaveCount(0);
    // The call goes on after the recording stopped: Record again is offered.
    await expect(screen.getByRole('button', { name: 'Record' })).toBeEnabled();
    await endCall(page);

    const [saved] = await recordingsOf(page, sessionId);
    expect(saved).toMatchObject({ sessionId, status: 'ready', hasCaptions: true });
    const recordingId = saved?.id ?? '';

    // In the conversation, at the end of its transcript.
    const inConversation = page.getByRole('list', { name: 'Recordings of this conversation' });
    await expect(inConversation.getByRole('listitem')).toHaveCount(1);
    await inConversation.getByRole('button', { name: /^Play the recording from / }).click();
    const player = page.locator('[data-slot="recording-player"]');
    const transcript = player.getByRole('list', { name: 'Transcript' });
    await expect(transcript).toContainText(line, { timeout: 15_000 });
    await expect(transcript).toContainText('Thomas:');
    const video = player.locator('video[data-slot="recording-video"]');
    await expect(video).toHaveAttribute('src', new RegExp(`^${FILES_ORIGIN}/api/v1/_local/recordings/`));
    // The file plays: its length is known (MediaRecorder writes none), and time moves.
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => (Number.isFinite(v.duration) ? v.duration : 0)), {
        timeout: 20_000,
      })
      .toBeGreaterThan(1);
    expect(await video.evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
    // A transcript line jumps the recording to it, and its caption shows over the picture in step.
    await transcript
      .getByRole('button', { name: new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
      .click();
    await expect(player.locator('[data-slot="recording-captions"]')).toContainText(line, { timeout: 10_000 });
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 10_000 })
      .toBeGreaterThan(0);

    // Under Recordings, from the side panel; deleted there.
    await page.getByRole('link', { name: 'Recordings' }).first().click();
    await expect(page).toHaveURL(new RegExp(`/v/${ventureId}/recordings`));
    await expect(page.getByRole('heading', { level: 1, name: 'Recordings' })).toBeVisible();
    const row = page.locator(`[data-recording-id="${recordingId}"]`);
    await expect(row).toBeVisible();
    await expectNoHorizontalScroll(page);
    await useTheme(page, 'dark');
    await expect(row).toBeVisible();
    await useTheme(page, 'light');
    await row.getByRole('button', { name: /^Delete the recording from / }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Delete this recording?' });
    await confirm.getByRole('button', { name: 'Delete recording' }).click();
    await expect(row).toHaveCount(0);
    await expect(page.getByText('No recordings yet')).toBeVisible();
    expect(await recordingsOf(page, sessionId)).toEqual([]);
    const gone = await page.request.get(`/api/v1/recordings/${recordingId}/playback`);
    expect(gone.status(), 'GET /recordings/:id/playback after delete').toBe(404);

    // Everything above ran under the production CSP. The only report allowed is zod's own `Function('')` probe (it
    // catches the refusal and parses without compiling), recognised by its code in the chunk that reported it.
    const unexpected: string[] = [];
    for (const violation of await violations()) {
      const source = /^script-src eval (\/assets\/[\w.-]+\.js)$/.exec(violation)?.[1];
      const code = source === undefined ? '' : await (await page.request.get(source)).text();
      if (!(code.includes('jitless') && /Function\((?:``|""|'')\)/.test(code))) unexpected.push(violation);
    }
    expect(unexpected).toEqual([]);
  });

  test('hanging up stops and saves the recording; deleting the conversation deletes it', async ({ page }) => {
    test.setTimeout(90_000);
    await muteMedia(page);
    await voiceNoticeSeen(page);
    await openVenture(page);
    const sessionId = await startConversation(page, `Who books the reading room? ${runToken()}`);
    await expect(page.getByRole('article', { name: 'Exchange 1' })).toBeVisible({ timeout: 30_000 });
    const { screen, reply } = await openCall(page);
    await record(page, screen);
    await say(page, reply, sessionId, `The librarian books it, ${runToken()}`);
    const completed = page.waitForResponse(
      (response) =>
        /\/recordings\/[0-9a-f-]{36}\/complete$/.test(response.url()) && response.status() === 200,
    );
    await endCall(page);
    await completed;
    const [saved] = await recordingsOf(page, sessionId);
    expect(saved?.status).toBe('ready');

    const removed = await page.request.delete(`/api/v1/sessions/${sessionId}`, {
      headers: { ...WRITE_HEADERS, 'idempotency-key': runToken() },
    });
    expect(removed.status(), 'DELETE /sessions/:id').toBe(204);
    expect(await recordingsOf(page, sessionId)).toEqual([]);
    const gone = await page.request.get(`/api/v1/recordings/${saved?.id ?? ''}/playback`);
    expect(gone.status(), 'the deleted conversation’s recording').toBe(404);
  });

  test('a private call cannot be recorded: the control says why and nothing is sent', async ({ page }) => {
    await voiceNoticeSeen(page);
    let registered = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/calls\/[0-9a-f-]{36}\/recordings$/.test(request.url()))
        registered += 1;
    });
    await openVenture(page);
    await page.getByRole('radio', { name: 'Private, a one-off' }).click();
    const { screen } = await openCall(page);
    await expect(screen.getByTestId('private-indicator')).toHaveText('Private');
    const control = screen.getByRole('button', { name: 'Record' });
    await expect(control).toHaveAttribute('aria-disabled', 'true');
    await expect(control).toHaveAccessibleDescription('Private calls aren’t recorded.');
    // Pressed anyway (it stays focusable, so its reason is read): nothing happens.
    await control.click({ force: true });
    await expect(page.getByRole('alertdialog', { name: 'Record this call?' })).toHaveCount(0);
    await expect(screen.getByTestId('recording-indicator')).toHaveCount(0);
    await endCall(page);
    expect(registered).toBe(0);
    const sessionId = /\/c\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
    const response = await page.request.delete(`/api/v1/sessions/${sessionId}`, {
      headers: { ...WRITE_HEADERS, 'idempotency-key': runToken() },
    });
    expect([204, 404]).toContain(response.status());
  });
  test('one recording through a switch to video: the AI avatar is in it, as one video', async ({
    page,
    baseURL,
  }) => {
    if (!baseURL) throw new Error('baseURL is required');
    test.setTimeout(90_000);
    await muteMedia(page);
    await voiceNoticeSeen(page);
    // Faces ship off: on for this test (the development stand-in face, a canvas, no one's likeness).
    await setFacesEnabled(baseURL, true);
    let sessionId = '';
    try {
      await openVenture(page);
      sessionId = await startConversation(page, `Where do students sit first? ${runToken()}`);
      await expect(page.getByRole('article', { name: 'Exchange 1' })).toBeVisible({ timeout: 30_000 });
      const { screen } = await openCall(page);
      await record(page, screen);
      await screen.getByRole('button', { name: 'Switch to video' }).click();
      await page.waitForURL(/\?call=video$/);
      const video = callScreen(page);
      await expect(video.locator('[data-slot="call-tile"][data-face="video"]')).toBeVisible({
        timeout: 15_000,
      });
      // Still the same recording, still running.
      const indicator = video.getByTestId('recording-indicator');
      await expect(indicator).toBeVisible();
      await expect(indicator).toContainText(/0:0[3-9]|0:[1-5]\d/, { timeout: 15_000 });
      const completed = page.waitForResponse(
        (response) =>
          /\/recordings\/[0-9a-f-]{36}\/complete$/.test(response.url()) && response.status() === 200,
      );
      await video.getByRole('button', { name: /^Stop recording, / }).click();
      await completed;
      await endCall(page);
      const [saved] = await recordingsOf(page, sessionId);
      expect(saved?.status).toBe('ready');
      const listed = (await (await page.request.get(`/api/v1/recordings?sessionId=${sessionId}`)).json()) as {
        items: { kind: string; mimeType: string }[];
      };
      expect(listed.items[0]).toMatchObject({ kind: 'video', mimeType: 'video/webm' });
      // Replayed, it is one video track at the recording's size.
      await page
        .getByRole('list', { name: 'Recordings of this conversation' })
        .getByRole('button', { name: /^Play the recording from / })
        .click();
      const replay = page.locator('[data-slot="recording-player"] video[data-slot="recording-video"]');
      await expect
        .poll(
          () => replay.evaluate((v: HTMLVideoElement) => `${String(v.videoWidth)}x${String(v.videoHeight)}`),
          {
            timeout: 20_000,
          },
        )
        .toBe('960x540');
    } finally {
      await setFacesEnabled(baseURL, false);
      if (sessionId) {
        await page.request.delete(`/api/v1/sessions/${sessionId}`, {
          headers: { ...WRITE_HEADERS, 'idempotency-key': runToken() },
        });
      }
    }
  });
});
