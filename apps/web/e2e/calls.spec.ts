import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import {
  browserSpeechRequests,
  expectNoHorizontalScroll,
  expectNoSeriousA11yViolations,
  expectReachable,
  FOUNDER_STATE,
  OWNER_STATE,
  openVenture,
  runToken,
  setCallsEnabled,
  signIn,
  startConversation,
  TENANT,
  test,
  useTheme,
  expectNoBareEirName,
} from './support/fixtures';

/*
 * vEIR calls against the real API in mock mode: calls, heartbeats, the end and its summary, interrupts and
 * the call settings are all served by the API. Only what a test environment cannot do is missing, and the
 * API itself says so: there is no Amazon Transcribe grant (the call continues by typing; headless browsers
 * often have no microphone either) and no Amazon Polly (`POST /speech` answers 501), so the production build
 * shows replies as captions and the browser never speaks. Every turn is a real `channel: 'voice'` turn.
 */

const WRITE_HEADERS = { 'x-requested-with': 'foundry-ascent', 'content-type': 'application/json' };

interface SessionTurns {
  session: { ventureId: string };
  turns: {
    id: string;
    response: {
      answer: string;
      spoken?: string | null;
      next_actions: { owner: string; action: string; target_date: string | null }[];
    } | null;
  }[];
}

async function sessionTurns(request: APIRequestContext, sessionId: string): Promise<SessionTurns> {
  const response = await request.get(`/api/v1/sessions/${sessionId}`);
  expect(response.status(), 'GET /sessions/:id').toBe(200);
  return (await response.json()) as SessionTurns;
}

/** Deletes memory the test kept, so the next run (and the next spec) starts from the seeded memory. */
async function deleteMemory(request: APIRequestContext, memoryId: string): Promise<void> {
  const response = await request.patch(`/api/v1/memory/${memoryId}`, {
    headers: WRITE_HEADERS,
    data: { action: 'delete' },
  });
  expect([200, 204], 'PATCH /memory/:id delete').toContain(response.status());
}

/** Calls off for the platform for the duration of `body` (back on afterwards, even when it fails). */
async function withCallsOff(baseURL: string | undefined, body: () => Promise<void>): Promise<void> {
  if (!baseURL) throw new Error('baseURL is not set');
  await setCallsEnabled(baseURL, false);
  try {
    await body();
  } finally {
    await setCallsEnabled(baseURL, true);
  }
}

/**
 * A person's first call explains how voice is handled, until they acknowledge it (stored with them on the
 * server). Tests that are not about the notice acknowledge it for the signed-in person first (idempotent).
 */
async function voiceNoticeSeen(page: Page): Promise<void> {
  const response = await page.request.post('/api/v1/calls/notice/acknowledge', { headers: WRITE_HEADERS });
  expect(response.status(), 'POST /calls/notice/acknowledge').toBe(200);
}

/** The call settings of a venture as the signed-in person sees them. */
async function callNoticeAcknowledgedAt(
  request: APIRequestContext,
  ventureId: string,
): Promise<string | null> {
  const response = await request.get(`/api/v1/ventures/${ventureId}/call-config`);
  expect(response.status(), 'GET /ventures/:id/call-config').toBe(200);
  return ((await response.json()) as { callNoticeAcknowledgedAt: string | null }).callNoticeAcknowledgedAt;
}

/** A page that has seen no click (a link opened later), so a call waits for Start call. */
async function withoutUserActivation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userActivation', {
      configurable: true,
      value: { hasBeenActive: false, isActive: false },
    });
  });
}

function callScreen(page: Page): Locator {
  return page.getByRole('dialog', { name: /^Call with / });
}

/** The reply's sentences as the call speaks them (its short spoken form, else the answer as plain text). */
function spokenSentences(reply: { answer: string; spoken?: string | null }): string[] {
  const plain = (reply.spoken ?? reply.answer)
    .replace(/\[(E\d+(?:\s*[,;]\s*E\d+)*)\]/g, ' ')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
  return (plain.match(/[^.!?]+[.!?]*/g) ?? []).map((sentence) => sentence.trim()).filter(Boolean);
}

test.describe('vEIR calls', () => {
  test.use({ storageState: FOUNDER_STATE });

  test('call from the sidebar: typed fallback, reply in captions, mini bar, summary', async ({ page }) => {
    await voiceNoticeSeen(page);
    const ventureId = await openVenture(page);
    const token = runToken();
    let sessionId = '';
    let callId = '';
    const speech: string[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/api/v1/speech')) speech.push(request.url());
    });

    await test.step('Call starts at once, in a new conversation', async () => {
      const started = page.waitForResponse(
        (response) => /\/sessions\/[0-9a-f-]{36}\/calls$/.test(response.url()) && response.status() === 201,
      );
      await page
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link', { name: /^Call / })
        .click();
      const screen = callScreen(page);
      await expect(screen).toBeVisible();
      await page.waitForURL(/\/c\/[0-9a-f-]{36}\?call=1$/);
      sessionId = /\/c\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
      const body = (await (await started).json()) as { call: { id: string }; intro: { text: string } | null };
      callId = body.call.id;
      await expect(screen.getByRole('note', { name: 'AI disclosure' })).toHaveCount(1);
      await expect(screen.getByRole('note', { name: 'AI disclosure' })).toContainText('not a person');
      // The intro is the vEIR's first line. There is no server voice here (501), so it is on screen only,
      // and the call says so once.
      if (body.intro) {
        await expect(screen.getByRole('region', { name: 'Captions' })).toContainText(body.intro.text);
        await expect(screen.getByText('Spoken replies are unavailable right now.')).toBeVisible();
      }
    });

    await test.step('no voice input here: the call continues by typing, and says why', async () => {
      const screen = callScreen(page);
      // No speech-to-text grant in mock mode (and headless browsers often have no microphone either).
      await expect(
        screen.getByText(/, so type instead\.$|Allow it in the browser’s site settings/),
      ).toBeVisible();
      await expect(screen.getByRole('textbox', { name: /^Reply to / })).toBeFocused();
      await expect(screen.getByRole('button', { name: 'Mute' })).toHaveCount(0);
      await expectNoSeriousA11yViolations(page, 'call screen');
      await expectNoBareEirName(page, 'the call screen');
    });

    await test.step('a typed line is a voice turn; the validated reply is shown as it is spoken', async () => {
      const screen = callScreen(page);
      const turnRequest = page.waitForRequest(
        (request) => request.url().endsWith(`/sessions/${sessionId}/turns`) && request.method() === 'POST',
      );
      await screen
        .getByRole('textbox', { name: /^Reply to / })
        .fill(`Should we pilot with one library? ${token}`);
      await screen.getByRole('textbox', { name: /^Reply to / }).press('Enter');
      const sent = (await turnRequest).postDataJSON() as { channel: string; callId: string; text: string };
      expect(sent).toMatchObject({ channel: 'voice', callId });
      expect(sent.text).toContain(token);

      // The turn is stored at once and answered moments later.
      await expect
        .poll(async () => (await sessionTurns(page.request, sessionId)).turns[0]?.response ?? null, {
          timeout: 30_000,
        })
        .not.toBeNull();
      const { turns } = await sessionTurns(page.request, sessionId);
      expect(turns).toHaveLength(1);
      const reply = turns[0]?.response;
      expect(reply, 'the turn has a validated reply').toBeTruthy();
      // Captions follow the sentence being read; whichever it is, it is one of the reply's sentences.
      const sentences = reply ? spokenSentences(reply) : [];
      const captions = screen.getByRole('region', { name: 'Captions' });
      await expect
        .poll(
          async () => {
            const shown = (await captions.textContent()) ?? '';
            return sentences.some((sentence) => shown.includes(sentence));
          },
          { timeout: 30_000 },
        )
        .toBe(true);
      // The server said once that it has no voice here (501); a production build then shows every reply on
      // screen, asks for no more speech, and never lets the browser read it aloud.
      expect(speech).toHaveLength(1);
      await expect(screen.getByText('Spoken replies are unavailable right now.')).toBeVisible();
      expect(await browserSpeechRequests(page)).toBe(0);
    });

    await test.step('minimized, the call continues in the mini bar over the conversation', async () => {
      await callScreen(page).getByRole('button', { name: 'Minimize call' }).click();
      await expect(callScreen(page)).toBeHidden();
      await expect(page).toHaveURL(new RegExp(`/c/${sessionId}$`));
      const bar = page.getByRole('region', { name: /^Call with / });
      await expect(bar).toBeVisible();
      // The vEIR's AI marker travels with its name.
      await expect(bar).toContainText(/AI/);
      await expectNoBareEirName(page, 'the mini call bar over the conversation');
      await expect(page.getByRole('main').getByText(token).first()).toBeVisible();
      await bar.getByRole('button', { name: 'Return to call' }).click();
      await expect(callScreen(page)).toBeVisible();
    });

    await test.step('ending shows the summary; Keep needs the founder', async () => {
      const ended = page.waitForRequest(
        (request) => request.url().endsWith(`/calls/${callId}/end`) && request.method() === 'POST',
      );
      await callScreen(page).getByRole('button', { name: 'End call' }).click();
      const screen = callScreen(page);
      await expect(screen.getByRole('heading', { name: 'Call ended' })).toBeFocused();
      expect((await ended).postDataJSON()).toMatchObject({ reason: 'user' });
      await expect(screen.getByRole('note', { name: 'AI disclosure' })).toHaveCount(1);
      await expectNoBareEirName(page, 'the after-call summary');
      // The call's turn proposed what to remember; nothing is kept until the founder says so, through the
      // app's one review path.
      const keep = screen.getByRole('button', { name: /^Keep: / }).first();
      await expect(keep).toBeVisible();
      const approved = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/ventures/${ventureId}/memory/batch`) &&
          response.request().method() === 'POST',
      );
      await keep.click();
      const review = await approved;
      const sent = review.request().postDataJSON() as { ids: string[]; action: string };
      expect(sent).toMatchObject({ action: 'approve' });
      expect(sent.ids).toHaveLength(1);
      await expect(screen.getByText('Kept').first()).toBeVisible();
      // Leave the venture's memory as it was.
      for (const id of sent.ids) await deleteMemory(page.request, id);
      await screen.getByRole('button', { name: 'Back to conversation' }).click();
      await expect(callScreen(page)).toBeHidden();
      await expect(page).toHaveURL(new RegExp(`/c/${sessionId}$`));
      await expect(page.getByRole('region', { name: /^Call with / })).toHaveCount(0);
    });
  });

  test('the first call says how voice is handled, once per person and in any browser', async ({
    browser,
  }) => {
    // Someone who has never called: a new teammate on EmberLoop (Ruth's vEIR, voice consented).
    const owner = await browser.newContext({ storageState: OWNER_STATE });
    const ventures = await owner.request.get('/api/v1/program/ventures');
    expect(ventures.status(), 'GET /program/ventures').toBe(200);
    const emberloop = ((await ventures.json()) as { items: { id: string; name: string }[] }).items.find(
      (v) => v.name === 'EmberLoop',
    );
    if (!emberloop) throw new Error('EmberLoop is missing from the seed');
    const invited = await owner.request.post(`/api/v1/ventures/${emberloop.id}/team/invitations`, {
      headers: { ...WRITE_HEADERS, 'idempotency-key': runToken() },
      data: { displayName: `Notice Tester ${runToken()}`, role: 'team', expiresInDays: 1 },
    });
    expect(invited.status(), 'POST /ventures/:id/team/invitations').toBe(201);
    const accessCode = ((await invited.json()) as { accessCode: string }).accessCode;
    await owner.close();

    const first = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await first.newPage();
    await signIn(page, accessCode);
    await page.waitForURL(new RegExp(`/v/${emberloop.id}$`));
    expect(await callNoticeAcknowledgedAt(page.request, emberloop.id)).toBeNull();

    await test.step('before the first call: AI, voice through Amazon Transcribe and not kept, text kept', async () => {
      await page
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link', { name: /^Call / })
        .click();
      const screen = callScreen(page);
      const notice = screen.getByTestId('voice-notice');
      await expect(notice).toContainText('Amazon Transcribe');
      await expect(notice).toContainText('No audio is kept');
      await expect(notice).toContainText('saved here like chat');
      await expect(screen.getByRole('note', { name: 'AI disclosure' })).toContainText('not a person');
      // The notice holds the call until the person starts it.
      await expect(screen.getByRole('button', { name: 'Start call' })).toBeVisible();
      await expectNoSeriousA11yViolations(page, 'call pre-join with the voice notice');
    });

    await test.step('Start call stores it with the person on the server', async () => {
      const screen = callScreen(page);
      const acknowledged = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/v1/calls/notice/acknowledge') && response.status() === 200,
      );
      await screen.getByRole('button', { name: 'Start call' }).click();
      await acknowledged;
      await expect(screen.getByRole('textbox', { name: /^Reply to / })).toBeVisible({ timeout: 20_000 });
      await screen.getByRole('button', { name: 'End call' }).click();
      await expect(screen.getByRole('heading', { name: 'Call ended' })).toBeVisible({ timeout: 20_000 });
      expect(await callNoticeAcknowledgedAt(page.request, emberloop.id)).not.toBeNull();
    });

    await test.step('another browser (nothing stored in it) does not show it again', async () => {
      // The same signed-in person, with none of the first browser's local storage.
      const { cookies } = await first.storageState();
      await first.close();
      const second = await browser.newContext({ storageState: { cookies, origins: [] } });
      const tab = await second.newPage();
      await withoutUserActivation(tab);
      await tab.goto(`/${TENANT}/app/v/${emberloop.id}?call=1`);
      const screen = callScreen(tab);
      await expect(screen.getByRole('button', { name: 'Start call' })).toBeVisible();
      await expect(screen.getByRole('status').filter({ hasText: /min left today/ })).toBeVisible();
      await expect(screen.getByTestId('voice-notice')).toHaveCount(0);
      expect(
        await tab.evaluate(() =>
          Object.keys(window.localStorage).some((k) => k.startsWith('fa.call.notice.')),
        ),
      ).toBe(true);
      await screen.getByRole('button', { name: 'Not now' }).click();
      await second.close();
    });
  });

  test('a call opened in a fresh tab waits for Start call, then calls in that conversation', async ({
    page,
  }) => {
    await openVenture(page);
    const sessionId = await startConversation(page, `Where should the pilot start? ${runToken()}`);
    await expect(page.getByRole('article', { name: 'Exchange 1' })).toBeVisible({ timeout: 30_000 });

    // A tab that has seen no click may not play sound, so the call waits for Start call. Playwright marks
    // its pages as already activated, so a never-clicked tab is emulated.
    const tab = await page.context().newPage();
    await withoutUserActivation(tab);
    await voiceNoticeSeen(tab);
    await tab.goto(`${page.url().split('?')[0] ?? ''}?call=1`);
    const screen = callScreen(tab);
    const start = screen.getByRole('button', { name: 'Start call' });
    await expect(start).toBeVisible();
    await expect(start).toBeFocused();
    await expect(screen.getByTestId('voice-notice')).toHaveCount(0);
    const started = tab.waitForRequest(
      (request) => request.url().endsWith(`/sessions/${sessionId}/calls`) && request.method() === 'POST',
    );
    await start.click();
    await started;
    await expect(screen.getByRole('textbox', { name: /^Reply to / })).toBeFocused();
    await expect(tab).toHaveURL(new RegExp(`/c/${sessionId}\\?call=1$`));
    await screen.getByRole('button', { name: 'End call' }).click();
    await expect(screen.getByRole('heading', { name: 'Call ended' })).toBeVisible();
    await tab.close();
  });

  test('a call live in another conversation moves here only when the founder says so', async ({ page }) => {
    await voiceNoticeSeen(page);
    // A conversation to call in, from a second tab of the same browser.
    const tab = await page.context().newPage();
    await openVenture(tab);
    const sessionId = await startConversation(tab, `Who signs off on a pilot? ${runToken()}`);
    await expect(tab.getByRole('article', { name: 'Exchange 1' })).toBeVisible({ timeout: 30_000 });

    // A call from New chat in the first tab.
    await openVenture(page);
    await page
      .getByRole('main')
      .getByRole('link', { name: /^Call / })
      .click();
    await expect(callScreen(page).getByRole('textbox', { name: /^Reply to / })).toBeFocused();

    // Calling in the other conversation: one call at a time, so the founder is asked first.
    const refused = tab.waitForResponse(
      (response) => response.url().endsWith(`/sessions/${sessionId}/calls`) && response.status() === 409,
    );
    // As a link opened later (a tab that has seen no click), so the call waits for Start call.
    await withoutUserActivation(tab);
    await tab.goto(`${tab.url().split('?')[0] ?? ''}?call=1`);
    const screen = callScreen(tab);
    await screen.getByRole('button', { name: 'Start call' }).click();
    await refused;
    await expect(screen.getByRole('heading', { name: 'You’re already in a call' })).toBeVisible();
    await expect(screen.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    const moved = tab.waitForRequest(
      (request) => request.url().endsWith(`/sessions/${sessionId}/calls`) && request.method() === 'POST',
    );
    await screen.getByRole('button', { name: 'Move the call here' }).click();
    expect((await moved).postDataJSON()).toMatchObject({ replace: true });
    await expect(screen.getByRole('textbox', { name: /^Reply to / })).toBeFocused();
    await screen.getByRole('button', { name: 'End call' }).click();
    await expect(screen.getByRole('heading', { name: 'Call ended' })).toBeVisible();
    await tab.close();
  });

  test('a refused call explains why and leaves no empty conversation behind', async ({ page, baseURL }) => {
    await voiceNoticeSeen(page);
    const ventureId = await openVenture(page);
    const call = page.getByRole('main').getByRole('link', { name: /^Call / });
    await expect(call).toBeVisible();
    // Calls are switched off after the page loaded its call settings, so the Call link is still there and the
    // API refuses the call itself.
    await withCallsOff(baseURL, async () => {
      const created = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/ventures/${ventureId}/sessions`) &&
          response.request().method() === 'POST',
      );
      await call.click();
      const sessionId = ((await (await created).json()) as { id: string }).id;
      const screen = callScreen(page);
      await expect(screen.getByRole('heading', { name: 'Can’t call right now' })).toBeVisible();
      await expect(screen.getByText('Calls are paused by the program. You can keep chatting.')).toBeVisible();
      // Trying again would be refused the same way, so it is not offered.
      await expect(screen.getByRole('button', { name: 'Try again' })).toHaveCount(0);
      // The conversation created for the call is gone from the venture's conversations (Recents).
      await expect
        .poll(
          async () => {
            const list = (await (
              await page.request.get(`/api/v1/ventures/${ventureId}/sessions`)
            ).json()) as {
              items: { id: string }[];
            };
            return list.items.some((item) => item.id === sessionId);
          },
          { timeout: 10_000 },
        )
        .toBe(false);
      await screen.getByRole('button', { name: 'Back to chat' }).click();
      await expect(screen).toBeHidden();
      await expect(page).toHaveURL(new RegExp(`/v/${ventureId}$`));
    });
  });

  test('a call refused after it was minimized says why and leaves no empty conversation', async ({
    page,
    baseURL,
  }) => {
    await voiceNoticeSeen(page);
    // The only interception: the API's refusal is held back two seconds on its way to the page, so the call
    // can be minimized while it connects (the local API answers too fast for that). The API still answers.
    await page.route(/\/api\/v1\/sessions\/[0-9a-f-]{36}\/calls$/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await route.continue();
    });
    const ventureId = await openVenture(page);
    const call = page.getByRole('main').getByRole('link', { name: /^Call / });
    await expect(call).toBeVisible();
    await withCallsOff(baseURL, async () => {
      const created = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/ventures/${ventureId}/sessions`) &&
          response.request().method() === 'POST',
      );
      await call.click();
      const sessionId = ((await (await created).json()) as { id: string }).id;
      await callScreen(page).getByRole('button', { name: 'Minimize call' }).click();
      // Minimized while connecting: the page is the call's conversation, with the mini bar.
      await expect(page).toHaveURL(new RegExp(`/c/${sessionId}$`));
      await expect(page.getByRole('region', { name: /^Call with / })).toBeVisible();
      // The refusal: a toast says why, and the page returns to New chat without the conversation.
      await expect(page.getByText('Calls are paused by the program. You can keep chatting.')).toBeVisible({
        timeout: 10_000,
      });
      await expect(page).toHaveURL(new RegExp(`/v/${ventureId}$`));
      await expect(page.getByRole('region', { name: /^Call with / })).toHaveCount(0);
      await expect(callScreen(page)).toHaveCount(0);
      await expect
        .poll(
          async () => {
            const list = (await (
              await page.request.get(`/api/v1/ventures/${ventureId}/sessions`)
            ).json()) as {
              items: { id: string }[];
            };
            return list.items.some((item) => item.id === sessionId);
          },
          { timeout: 10_000 },
        )
        .toBe(false);
    });
  });

  test('with calls switched off, no Call entry shows and an old call link says calls are paused', async ({
    page,
    baseURL,
  }) => {
    await voiceNoticeSeen(page);
    await withCallsOff(baseURL, async () => {
      const ventureId = await openVenture(page);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      // Sidebar, New chat's composer and ⌘K offer no call.
      await expect(
        page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Call / }),
      ).toHaveCount(0);
      await expect(page.getByRole('main').getByRole('link', { name: /^Call / })).toHaveCount(0);
      await page.keyboard.press('ControlOrMeta+k');
      const palette = page.getByRole('dialog');
      await expect(palette.getByRole('option').first()).toBeVisible();
      await expect(palette.getByRole('option', { name: /^Call / })).toHaveCount(0);
      await page.keyboard.press('Escape');
      // A saved `?call=1` link explains instead of creating a conversation.
      let created = 0;
      page.on('request', (request) => {
        if (request.url().endsWith(`/ventures/${ventureId}/sessions`) && request.method() === 'POST')
          created += 1;
      });
      await page.goto(`${new URL(page.url()).pathname}?call=1`);
      const screen = callScreen(page);
      await expect(screen.getByRole('heading', { name: 'Calls are paused' })).toBeVisible();
      await expect(screen.getByRole('button', { name: 'Start call' })).toHaveCount(0);
      expect(created).toBe(0);
    });
  });

  test('the call screen is keyboard and screen-reader friendly in both themes', async ({ page }) => {
    await voiceNoticeSeen(page);
    await openVenture(page);
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await useTheme(page, scheme);
      await page
        .getByRole('main')
        .getByRole('link', { name: /^Call / })
        .click();
      const screen = callScreen(page);
      await expect(screen.getByRole('textbox', { name: /^Reply to / })).toBeFocused();
      await expect(screen.getByRole('status').first()).toBeVisible();
      await expectNoSeriousA11yViolations(page, `call screen (${scheme})`);

      // Every control is reachable by Tab; captions toggle with its shortcut.
      const captions = screen.getByRole('button', { name: 'Captions' });
      await expect(captions).toHaveAttribute('aria-pressed', 'true');
      for (let presses = 0; presses < 4; presses++) {
        if (await captions.evaluate((element) => element === document.activeElement)) break;
        await page.keyboard.press('Tab');
      }
      await expect(captions).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(captions).toHaveAttribute('aria-pressed', 'false');
      await page.keyboard.press('Enter');

      await screen.getByRole('button', { name: 'Switch to chat' }).click();
      await expect(screen).toBeHidden();
      await expect(page.getByRole('region', { name: /^Call with / })).toHaveCount(0);
      await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'New chat' }).click();
    }
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test('New chat → call: no sideways scroll, controls within reach', async ({ page }) => {
      await voiceNoticeSeen(page);
      await openVenture(page);
      await page
        .getByRole('main')
        .getByRole('link', { name: /^Call / })
        .click();
      const screen = callScreen(page);
      await expect(screen.getByRole('textbox', { name: /^Reply to / })).toBeVisible();
      await expectNoHorizontalScroll(page);
      for (const name of ['Captions', 'Switch to chat', 'End call']) {
        await expectReachable(page, screen.getByRole('button', { name }));
      }
      await screen.getByRole('button', { name: 'End call' }).click();
      await expect(screen.getByRole('heading', { name: 'Call ended' })).toBeVisible();
      await expectNoHorizontalScroll(page);
      await screen.getByRole('button', { name: 'Back to conversation' }).click();
      await expect(screen).toBeHidden();
    });
  });
});
