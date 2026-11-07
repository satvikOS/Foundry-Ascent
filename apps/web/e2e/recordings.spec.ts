import { readFile } from 'node:fs/promises';

import { expect, type Locator, type Page } from '@playwright/test';

import {
  expectNoHorizontalScroll,
  expectNoSeriousA11yViolations,
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
 * goes on typed and its replies show as captions. The recording is the shared screen (or, when it is not shared, the
 * composed call view) with the call's sound, uploaded, watched in its viewer with its transcript in step, downloaded
 * (an attachment, under a readable name) and deleted. A headless browser has no screen to share, so the screen the
 * founder shares is a stand-in: getDisplayMedia answers with a canvas "tab" of its own size, or refuses as a founder
 * who declines would. Every media element is muted, so the test browser never makes a sound.
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
  acceptDownloads: true,
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

/** The shared "tab" the stand-in screen shows (its size is what a recording of it plays at). */
const SHARED = { width: 640, height: 360 };

/**
 * The screen the founder shares: getDisplayMedia answers with a canvas of its own (`share`), or refuses as a founder
 * who declines the browser's prompt (`decline`). What it was asked for, and the tracks it gave, are kept to inspect.
 */
async function shareScreen(page: Page, answer: 'share' | 'decline'): Promise<void> {
  await page.addInitScript(
    ({ answer: mode, size }) => {
      const shared = { asked: [] as unknown[], tracks: [] as MediaStreamTrack[] };
      (window as unknown as { __screen: typeof shared }).__screen = shared;
      navigator.mediaDevices.getDisplayMedia = (options) => {
        shared.asked.push(JSON.parse(JSON.stringify(options ?? {})));
        if (mode === 'decline')
          return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
        const canvas = document.createElement('canvas');
        canvas.width = size.width;
        canvas.height = size.height;
        const ctx = canvas.getContext('2d');
        const draw = () => {
          if (!ctx) return;
          ctx.fillStyle = '#10131a';
          ctx.fillRect(0, 0, size.width, size.height);
          ctx.fillStyle = '#ffffff';
          ctx.font = '28px sans-serif';
          ctx.fillText(`The call tab ${String(Date.now() % 100_000)}`, 24, size.height / 2);
        };
        draw();
        window.setInterval(draw, 100);
        const stream = canvas.captureStream(15);
        shared.tracks.push(...stream.getVideoTracks());
        return Promise.resolve(stream);
      };
    },
    { answer, size: SHARED },
  );
}

/** The founder presses Stop sharing in the browser's own bar: the shared track ends. */
async function stopSharing(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const track of (window as unknown as { __screen: { tracks: MediaStreamTrack[] } }).__screen.tracks) {
      track.stop();
      track.dispatchEvent(new Event('ended'));
    }
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
  test('records the shared screen, watches it in its viewer with the transcript in step, downloads it, and deletes it', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await muteMedia(page);
    await shareScreen(page, 'share');
    const violations = await enforceProductionCsp(page);
    await voiceNoticeSeen(page);
    const ventureId = await openVenture(page);
    const sessionId = await startConversation(page, `What should the pilot measure first? ${runToken()}`);
    await expect(page.getByRole('article', { name: 'Exchange 1' })).toBeVisible({ timeout: 30_000 });

    const { screen, reply } = await openCall(page);
    // The first time: what is recorded, where it is kept, how to delete it.
    await screen.getByRole('button', { name: 'Record' }).click();
    const notice = page.getByRole('alertdialog', { name: 'Record this call?' });
    await expect(notice).toContainText('This tab is recorded as you see it, with both voices.');
    await expect(notice).toContainText('Only you can watch it.');
    await expect(notice).toContainText('Deleting the conversation deletes it too');
    await notice.getByRole('button', { name: 'Start recording' }).click();
    const indicator = screen.getByTestId('recording-indicator');
    await expect(indicator).toContainText('REC');
    // The browser was asked for this tab, without its sound (the recording mixes the call's own).
    const asked = await page.evaluate(
      () => (window as unknown as { __screen: { asked: unknown[] } }).__screen.asked,
    );
    expect(asked).toEqual([
      expect.objectContaining({ audio: false, preferCurrentTab: true, surfaceSwitching: 'exclude' }),
    ]);
    // A tab was shared, as asked: nothing to say about it.
    await expect(screen.locator('[data-slot="recording-note"]')).toHaveCount(0);
    const stop = screen.getByRole('button', { name: /Stop recording$/ });
    await expect(stop).toHaveAttribute('aria-pressed', 'true');
    // Its name starts with what it shows (label in name); the whole call screen passes while it records.
    await expect(stop).toHaveAccessibleName(/^\d+:\d\d Stop recording$/);
    await expectNoSeriousA11yViolations(page, 'call while recording');
    // On a phone the header keeps its room for the time left (its warning near the end) while it records.
    const desktop = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(indicator).toBeVisible();
    const fits = await screen
      .locator('[data-slot="call-kind"]')
      .evaluate((line) =>
        [...line.querySelectorAll<HTMLElement>('span.truncate')].every(
          (span) => span.scrollWidth <= span.clientWidth,
        ),
      );
    expect(fits, 'time left is not truncated while recording on a phone').toBe(true);
    await expect(screen.locator('[data-slot="call-kind"]')).toContainText(/min left/);
    if (desktop) await page.setViewportSize(desktop);

    const line = `Footfall at the east wing, ${runToken()}`;
    await say(page, reply, sessionId, line);
    await expect(indicator).toContainText(/0:0[2-9]|0:[1-5]\d/, { timeout: 15_000 });

    const completed = page.waitForResponse(
      (response) =>
        /\/recordings\/[0-9a-f-]{36}\/complete$/.test(response.url()) && response.status() === 200,
    );
    await stop.click();
    await completed;
    // Said in the call screen itself (a toast over the modal screen could not be clicked).
    await expect(screen.getByRole('group', { name: 'Recording saved' })).toBeVisible();
    await expect(indicator).toHaveCount(0);
    // The call goes on after the recording stopped: Record again is offered.
    await expect(screen.getByRole('button', { name: 'Record' })).toBeEnabled();
    await endCall(page);

    const [saved] = await recordingsOf(page, sessionId);
    expect(saved).toMatchObject({ sessionId, status: 'ready', hasCaptions: true });
    const recordingId = saved?.id ?? '';

    // In the conversation, at the end of its transcript: Watch opens its viewer.
    const inConversation = page.getByRole('list', { name: 'Recordings of this conversation' });
    await expect(inConversation.getByRole('listitem')).toHaveCount(1);
    await expect(inConversation.getByRole('listitem')).toContainText('Video');
    await inConversation.getByRole('link', { name: /^Watch the recording from / }).click();
    await expect(page).toHaveURL(new RegExp(`/v/${ventureId}/recordings/${recordingId}$`));
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const player = page.locator('[data-slot="recording-player"]');
    const transcript = player.getByRole('list', { name: 'Transcript' });
    await expect(transcript).toContainText(line, { timeout: 15_000 });
    await expect(transcript).toContainText('Thomas:');
    const video = player.locator('video[data-slot="recording-video"]');
    await expect(video).toHaveAttribute('src', new RegExp(`^${FILES_ORIGIN}/api/v1/_local/recordings/`));
    // The file plays: its length is known (MediaRecorder writes none), and it is the shared screen, at its size.
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => (Number.isFinite(v.duration) ? v.duration : 0)), {
        timeout: 20_000,
      })
      .toBeGreaterThan(1);
    expect(
      await video.evaluate((v: HTMLVideoElement) => `${String(v.videoWidth)}x${String(v.videoHeight)}`),
    ).toBe(`${String(SHARED.width)}x${String(SHARED.height)}`);
    expect(await video.evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
    // A transcript line jumps the recording to it; the line is marked as the one heard, its caption over the picture.
    const said = transcript.getByRole('button', {
      name: new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    });
    await said.click();
    await expect(player.locator('[data-slot="recording-captions"]')).toContainText(line, { timeout: 10_000 });
    await expect(said).toHaveAttribute('aria-current', 'true');
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 10_000 })
      .toBeGreaterThan(0);
    await video.evaluate((v: HTMLVideoElement) => {
      v.pause();
    });
    await expectNoSeriousA11yViolations(page, 'recording viewer');

    // Download: the recording, then its transcript, each an attachment under a readable name.
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download' }).click();
    await page.getByRole('menuitem', { name: /^Recording/ }).click();
    const recordingFile = await download;
    expect(recordingFile.suggestedFilename()).toMatch(/^Thomas call \d{4}-\d\d-\d\d \d\d-\d\d\.webm$/);
    const transcriptDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download' }).click();
    await page.getByRole('menuitem', { name: /^Transcript/ }).click();
    const transcriptFile = await transcriptDownload;
    expect(transcriptFile.suggestedFilename()).toMatch(/^Thomas call .+ transcript\.vtt$/);
    const vtt = await readFile(await transcriptFile.path(), 'utf8');
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain(line);
    // What the browser followed: the recordings store's own answer, an attachment (never through the app's API).
    const signed = (await (
      await page.request.get(`/api/v1/recordings/${recordingId}/download?name=Thomas&timeZone=UTC`)
    ).json()) as { url: string; filename: string };
    expect(signed.url.startsWith(`${FILES_ORIGIN}/api/v1/_local/recordings/`)).toBe(true);
    const file = await page.request.get(signed.url);
    expect(file.status()).toBe(200);
    expect(file.headers()['content-disposition']).toBe(
      `attachment; filename="${signed.filename}"; filename*=UTF-8''${encodeURIComponent(signed.filename)}`,
    );
    expect(file.headers()['content-type']).toBe('video/webm');

    // On a phone the viewer fits: the player, then the transcript, no sideways scroll.
    const wide = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(video).toBeVisible();
    await expect(transcript).toBeVisible();
    await expectNoHorizontalScroll(page);
    if (wide) await page.setViewportSize(wide);

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

  test('a save during the call is shown in the call screen: Try again after a failure, Watch without hanging up', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await muteMedia(page);
    await shareScreen(page, 'share');
    await voiceNoticeSeen(page);
    await openVenture(page);
    const sessionId = await startConversation(page, `Which room is quiet at noon? ${runToken()}`);
    await expect(page.getByRole('article', { name: 'Exchange 1' })).toBeVisible({ timeout: 30_000 });
    const { screen, reply } = await openCall(page);

    /** The button under the pointer at the centre of `control` (what a click there would press). */
    const underPointer = async (control: Locator): Promise<string | null> => {
      const box = await control.boundingBox();
      if (!box) throw new Error('control not laid out');
      return page.evaluate(
        ([x, y]) => {
          const button = document.elementFromPoint(x ?? 0, y ?? 0)?.closest('button');
          return button ? (button.getAttribute('aria-label') ?? button.textContent.trim()) : null;
        },
        [box.x + box.width / 2, box.y + box.height / 2],
      );
    };
    const toasts = page.locator('[data-sonner-toast]');

    // The first save fails (the API is unavailable for a moment).
    const failing = '**/api/v1/calls/*/recordings';
    await page.route(failing, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/problem+json',
        body: JSON.stringify({ title: 'Service unavailable', status: 503, code: 'internal' }),
      }),
    );
    await record(page, screen);
    await say(page, reply, sessionId, `The east reading room, ${runToken()}`);
    await screen.getByRole('button', { name: /Stop recording$/ }).click();
    const failed = screen.getByRole('group', { name: 'The recording wasn’t saved' });
    await expect(failed).toBeVisible({ timeout: 15_000 });
    await expect(toasts).toHaveCount(0);
    // The take is kept: Record waits until it is saved or discarded, and R does not start another either.
    const recordControl = screen.getByRole('button', { name: 'Record' });
    await expect(recordControl).toHaveAttribute('aria-disabled', 'true');
    await expect(recordControl).toHaveAccessibleDescription('Save or discard the last recording first.');
    await page.keyboard.press('r');
    await expect(screen.getByTestId('recording-indicator')).toHaveCount(0);
    // On a phone too, Try again is what is under the pointer, and End is still End.
    const desktop = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    const tryAgain = failed.getByRole('button', { name: 'Try again' });
    expect(await underPointer(tryAgain)).toBe('Try again');
    expect(await underPointer(screen.getByRole('button', { name: 'End call' }))).toBe('End call');
    if (desktop) await page.setViewportSize(desktop);

    // Try again saves that same take.
    await page.unroute(failing);
    const completed = page.waitForResponse(
      (response) =>
        /\/recordings\/[0-9a-f-]{36}\/complete$/.test(response.url()) && response.status() === 200,
    );
    expect(await underPointer(tryAgain)).toBe('Try again');
    await tryAgain.click();
    await completed;
    const saved = screen.getByRole('group', { name: 'Recording saved' });
    await expect(saved).toBeVisible();
    await expect(toasts).toHaveCount(0);
    const [listed] = await recordingsOf(page, sessionId);
    expect(listed?.status).toBe('ready');

    // Watch opens it while the call goes on (minimized): the click lands on Watch, never on End call.
    const watch = saved.getByRole('button', { name: 'Watch' });
    expect(await underPointer(watch)).toBe('Watch');
    await watch.click();
    await expect(page).toHaveURL(new RegExp(`/recordings/${listed?.id ?? ''}$`));
    const bar = page.getByRole('region', { name: /^Call with / });
    await expect(bar.getByRole('button', { name: 'Return to call' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0);
    // The call is still live: the replay waits to be played instead of playing over it.
    const replay = page.locator('[data-slot="recording-player"] video[data-slot="recording-video"]');
    await expect(replay).toHaveAttribute('src', /\/_local\/recordings\//);
    await expect
      .poll(() => replay.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 })
      .toBeGreaterThan(0);
    await page.waitForTimeout(1_500);
    expect(
      await replay.evaluate((v: HTMLVideoElement) => ({ autoplay: v.autoplay, paused: v.paused })),
    ).toEqual({
      autoplay: false,
      paused: true,
    });

    // Recording again, then minimized: the bar says it is still recording and stops it there.
    await bar.getByRole('button', { name: 'Return to call' }).click();
    await expect(screen.getByRole('button', { name: 'End call' })).toBeVisible();
    await screen.getByRole('button', { name: 'Record' }).click();
    await expect(screen.getByTestId('recording-indicator')).toBeVisible();
    await screen.getByRole('button', { name: 'Minimize call' }).click();
    await expect(bar.getByTestId('recording-indicator')).toContainText('REC');
    const savedFromBar = page.waitForResponse(
      (response) =>
        /\/recordings\/[0-9a-f-]{36}\/complete$/.test(response.url()) && response.status() === 200,
    );
    await bar.getByRole('button', { name: 'Stop recording' }).click();
    await savedFromBar;
    await expect(bar.getByTestId('recording-indicator')).toHaveCount(0);
    await expect(toasts.filter({ hasText: 'Recording saved' })).toBeVisible();
    expect(await recordingsOf(page, sessionId)).toHaveLength(2);
    await bar.getByRole('button', { name: 'Return to call' }).click();
    await expect(callScreen(page).getByRole('button', { name: 'End call' })).toBeVisible();
    await endCall(page);
    await page.request.delete(`/api/v1/sessions/${sessionId}`, {
      headers: { ...WRITE_HEADERS, 'idempotency-key': runToken() },
    });
  });

  test('hanging up stops and saves the recording; deleting the conversation deletes it', async ({ page }) => {
    test.setTimeout(90_000);
    await muteMedia(page);
    await shareScreen(page, 'share');
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

  test('stopping the screen share from the browser stops the recording and saves it', async ({ page }) => {
    test.setTimeout(90_000);
    await muteMedia(page);
    await shareScreen(page, 'share');
    await voiceNoticeSeen(page);
    await openVenture(page);
    const sessionId = await startConversation(page, `Who keeps the reading room keys? ${runToken()}`);
    await expect(page.getByRole('article', { name: 'Exchange 1' })).toBeVisible({ timeout: 30_000 });
    const { screen, reply } = await openCall(page);
    await record(page, screen);
    await say(page, reply, sessionId, `The night porter does, ${runToken()}`);
    const completed = page.waitForResponse(
      (response) =>
        /\/recordings\/[0-9a-f-]{36}\/complete$/.test(response.url()) && response.status() === 200,
    );
    await stopSharing(page);
    await completed;
    await expect(screen.getByRole('group', { name: 'Recording saved' })).toBeVisible();
    await expect(screen.getByTestId('recording-indicator')).toHaveCount(0);
    // The call goes on.
    await expect(screen.getByRole('button', { name: 'End call' })).toBeVisible();
    const [saved] = await recordingsOf(page, sessionId);
    expect(saved).toMatchObject({ status: 'ready', hasCaptions: true });
    await endCall(page);
    await page.request.delete(`/api/v1/sessions/${sessionId}`, {
      headers: { ...WRITE_HEADERS, 'idempotency-key': runToken() },
    });
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
  test('a declined screen records the call view, said plainly, as one video through a switch to video', async ({
    page,
    baseURL,
  }) => {
    if (!baseURL) throw new Error('baseURL is required');
    test.setTimeout(90_000);
    await muteMedia(page);
    await shareScreen(page, 'decline');
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
      const note = screen.locator('[data-slot="recording-note"]');
      await expect(note).toHaveText(/The screen wasn’t shared, so the call view is recorded\./);
      await note.getByRole('button', { name: 'OK' }).click();
      await expect(note).toHaveCount(0);
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
      await video.getByRole('button', { name: /Stop recording$/ }).click();
      await completed;
      await endCall(page);
      const [saved] = await recordingsOf(page, sessionId);
      expect(saved?.status).toBe('ready');
      const listed = (await (await page.request.get(`/api/v1/recordings?sessionId=${sessionId}`)).json()) as {
        items: { kind: string; mimeType: string }[];
      };
      expect(listed.items[0]).toMatchObject({ kind: 'video', mimeType: 'video/webm' });
      // Replayed, it is one video track at the composed call view's size.
      await page
        .getByRole('list', { name: 'Recordings of this conversation' })
        .getByRole('link', { name: /^Watch the recording from / })
        .click();
      const replay = page.locator('[data-slot="recording-player"] video[data-slot="recording-video"]');
      await expect
        .poll(
          () => replay.evaluate((v: HTMLVideoElement) => `${String(v.videoWidth)}x${String(v.videoHeight)}`),
          {
            timeout: 20_000,
          },
        )
        .toBe('1280x720');
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
