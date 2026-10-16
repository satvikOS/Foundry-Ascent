import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import {
  expectNoHorizontalScroll,
  expectNoSeriousA11yViolations,
  expectReachable,
  FOUNDER_STATE,
  openVenture,
  runToken,
  startConversation,
  useTheme,
} from './support/fixtures';

/*
 * vEIR calls in mock mode: no speech-to-text grant, so the call continues by typing, and no server voice
 * (`POST /speech` answers 501), so the browser reads the validated reply. Every turn goes through the real
 * API with `channel: 'voice'`.
 *
 * CALLS-BACKEND-STUB: the calls endpoints (POST /sessions/:id/calls, /calls/:id/heartbeat, /calls/:id/end)
 * and /speech are answered by `stubCallsBackend` below, in the shapes of packages/contracts/src/calls.ts and
 * the way the development server answers them, because the calls backend (S3) is built in parallel. Drop
 * `stubCallsBackend` (and this comment) once the API serves them; the assertions stay as they are.
 */

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

interface StubOptions {
  /** How POST /sessions/:id/calls answers: a live call, or the kill switch's refusal. */
  start?: 'live' | 'ai_disabled';
  /** How long POST /sessions/:id/calls takes to answer. */
  startDelayMs?: number;
  /** The status of the n-th POST /speech (0-based); 501 (no server voice in mock mode) otherwise. */
  speechStatus?: (n: number) => number;
}

// CALLS-BACKEND-STUB (see the file comment).
async function stubCallsBackend(page: Page, options: StubOptions = {}): Promise<void> {
  const callId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c01';
  let speechRequests = 0;
  const intro = 'Hi Maya, good to hear from you. What should we work on?';
  let currentSession = '';
  const startedAt = new Date().toISOString();
  const callView = (sessionId: string, ventureId: string, ended: boolean) => ({
    id: callId,
    sessionId,
    ventureId,
    personaId: '00000000-0000-4000-8000-000000000001',
    status: ended ? 'ended' : 'live',
    provider: 'builtin',
    inputMode: 'typed',
    startedAt,
    endedAt: ended ? new Date().toISOString() : null,
    endReason: ended ? 'user' : null,
    maxSeconds: 1200,
    durationSeconds: ended ? 42 : null,
  });

  await page.route(/\/api\/v1\/sessions\/[0-9a-f-]{36}\/calls$/, async (route) => {
    const sessionId = /sessions\/([0-9a-f-]{36})\/calls$/.exec(route.request().url())?.[1] ?? '';
    if (options.startDelayMs) await new Promise((resolve) => setTimeout(resolve, options.startDelayMs));
    if (options.start === 'ai_disabled') {
      await route.fulfill({
        status: 503,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'urn:foundry-ascent:problem:ai_disabled',
          title: 'AI coaching paused',
          status: 503,
          code: 'ai_disabled',
          detail: 'Calls are paused by the program. You can keep chatting.',
          requestId: 'e2e',
        }),
      });
      return;
    }
    currentSession = sessionId;
    const { session } = await sessionTurns(page.request, sessionId);
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        call: callView(sessionId, session.ventureId, false),
        sttGrant: null,
        intro: { text: intro, sig: 'c2lnbmVkLWludHJvLWZvci1lMmU' },
      }),
    });
  });
  await page.route(/\/api\/v1\/calls\/[0-9a-f-]{36}\/heartbeat$/, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ remainingSeconds: 1100, action: 'continue', reason: null }),
    }),
  );
  await page.route(/\/api\/v1\/calls\/[0-9a-f-]{36}\/end$/, async (route) => {
    const sessionId = currentSession;
    const { session, turns } = await sessionTurns(page.request, sessionId);
    const turnIds = new Set(turns.map((t) => t.id));
    const memory = (await (
      await page.request.get(`/api/v1/ventures/${session.ventureId}/memory?status=proposed&limit=100`)
    ).json()) as { items: { id: string; sourceRefs: { kind: string; id: string }[] }[] };
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        call: callView(sessionId, session.ventureId, true),
        summary: {
          turnCount: turns.length,
          durationSeconds: 42,
          memoryProposalIds: memory.items
            .filter((m) => m.sourceRefs.some((ref) => turnIds.has(ref.id)))
            .map((m) => m.id),
          nextActions: turns.flatMap((t) => t.response?.next_actions ?? []),
          escalationIds: [],
        },
      }),
    });
  });
  await page.route(/\/api\/v1\/speech$/, (route) => {
    const status = options.speechStatus?.(speechRequests) ?? 501;
    speechRequests += 1;
    const code = status === 501 ? 'speech_unavailable' : 'model_unavailable';
    return route.fulfill({
      status,
      contentType: 'application/problem+json',
      body: JSON.stringify({ type: 'about:blank', title: 'Speech', status, code, requestId: 'e2e' }),
    });
  });
}

/** The first call in a browser explains how voice is handled; tests that are not about it skip it. */
async function voiceNoticeSeen(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem('fa.call.voice-notice', '1');
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

/**
 * Replaces the browser's speech synthesis with a silent one that keeps the engine's contract (`onstart`, then
 * `onend` after a short reading time). Headless Chromium's `--mute-audio` does not reach the operating system's
 * speech service, so without this the runner's speakers read every reply aloud.
 */
async function silenceBrowserVoice(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const pending = new Set<number>();
    const silent = {
      speaking: false,
      pending: false,
      paused: false,
      onvoiceschanged: null,
      getVoices: () => [],
      speak(utterance: SpeechSynthesisUtterance) {
        const words = utterance.text.split(/\s+/).filter(Boolean).length;
        utterance.onstart?.call(utterance, new Event('start') as SpeechSynthesisEvent);
        const timer = window.setTimeout(
          () => {
            pending.delete(timer);
            utterance.onend?.call(utterance, new Event('end') as SpeechSynthesisEvent);
          },
          Math.min(3000, 200 + 60 * words),
        );
        pending.add(timer);
      },
      cancel() {
        for (const timer of pending) window.clearTimeout(timer);
        pending.clear();
      },
      pause: () => undefined,
      resume: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    };
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: silent });
  });
}

test.describe('vEIR calls', () => {
  test.use({ storageState: FOUNDER_STATE });

  test.beforeEach(async ({ page }) => {
    await silenceBrowserVoice(page);
  });

  test('call from the sidebar: typed fallback, spoken reply, mini bar, summary', async ({ page }) => {
    // The intro's voice fails once (a busy synthesiser); later sentences ask for the voice again.
    await stubCallsBackend(page, { speechStatus: (n) => (n === 0 ? 503 : 501) });
    await openVenture(page);
    const token = runToken();
    let sessionId = '';
    let callId = '';
    const speech: string[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/api/v1/speech')) speech.push(request.url());
    });

    await test.step('the first call says how voice is handled, then starts in a new conversation', async () => {
      await page
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link', { name: /^Call / })
        .click();
      const screen = callScreen(page);
      await expect(screen).toBeVisible();
      await expect(screen.getByTestId('voice-notice')).toContainText('Amazon Transcribe');
      await expect(screen.getByTestId('voice-notice')).toContainText('No audio is kept');
      await expectNoSeriousA11yViolations(page, 'call pre-join');
      const started = page.waitForResponse(
        (response) => /\/sessions\/[0-9a-f-]{36}\/calls$/.test(response.url()) && response.status() === 201,
      );
      await screen.getByRole('button', { name: 'Start call' }).click();
      await page.waitForURL(/\/c\/[0-9a-f-]{36}\?call=1$/);
      sessionId = /\/c\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
      const body = (await (await started).json()) as { call: { id: string }; intro: { text: string } | null };
      callId = body.call.id;
      await expect(screen.getByRole('note', { name: 'AI disclosure' })).toHaveCount(1);
      await expect(screen.getByRole('note', { name: 'AI disclosure' })).toContainText('not a person');
      // The intro is the vEIR's first line. Its voice failed, so it is on screen only, and the call says so.
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
      if (reply?.spoken) {
        // One failed sentence did not silence the call: the reply asked for its voice again.
        await expect.poll(() => speech.length, { timeout: 15_000 }).toBeGreaterThan(1);
        await expect(screen.getByText('Spoken replies are unavailable right now.')).toBeHidden();
      }
    });

    await test.step('minimized, the call continues in the mini bar over the conversation', async () => {
      await callScreen(page).getByRole('button', { name: 'Minimize call' }).click();
      await expect(callScreen(page)).toBeHidden();
      await expect(page).toHaveURL(new RegExp(`/c/${sessionId}$`));
      const bar = page.getByRole('region', { name: /^Call with / });
      await expect(bar).toBeVisible();
      // The vEIR's AI marker travels with its name.
      await expect(bar).toContainText(/AI/);
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
      // The call's turn proposed what to remember; nothing is kept until the founder says so.
      const keep = screen.getByRole('button', { name: /^Keep: / }).first();
      await expect(keep).toBeVisible();
      const approved = page.waitForRequest(
        (request) => /\/memory\/[0-9a-f-]{36}$/.test(request.url()) && request.method() === 'PATCH',
      );
      await keep.click();
      expect((await approved).postDataJSON()).toEqual({ action: 'approve' });
      await expect(screen.getByText('Kept').first()).toBeVisible();
      await screen.getByRole('button', { name: 'Back to conversation' }).click();
      await expect(callScreen(page)).toBeHidden();
      await expect(page).toHaveURL(new RegExp(`/c/${sessionId}$`));
      await expect(page.getByRole('region', { name: /^Call with / })).toHaveCount(0);
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
    await tab.addInitScript(() => {
      Object.defineProperty(navigator, 'userActivation', {
        configurable: true,
        value: { hasBeenActive: false, isActive: false },
      });
    });
    await silenceBrowserVoice(tab);
    await voiceNoticeSeen(tab);
    await stubCallsBackend(tab);
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

  test('a refused call explains why and leaves no empty conversation behind', async ({ page }) => {
    await voiceNoticeSeen(page);
    // CALLS-BACKEND-STUB: once the API serves calls, refuse for real instead (the owner turns calls off with
    // PATCH /admin/settings {callsEnabled: false} before, and back on after).
    await stubCallsBackend(page, { start: 'ai_disabled' });
    const ventureId = await openVenture(page);
    const created = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/ventures/${ventureId}/sessions`) && response.request().method() === 'POST',
    );
    await page
      .getByRole('main')
      .getByRole('link', { name: /^Call / })
      .click();
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
          const list = (await (await page.request.get(`/api/v1/ventures/${ventureId}/sessions`)).json()) as {
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

  test('a call refused after it was minimized says why and leaves no empty conversation', async ({
    page,
  }) => {
    await voiceNoticeSeen(page);
    // CALLS-BACKEND-STUB: the refusal arrives late, so the call can be minimized while it connects.
    await stubCallsBackend(page, { start: 'ai_disabled', startDelayMs: 2_000 });
    const ventureId = await openVenture(page);
    const created = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/ventures/${ventureId}/sessions`) && response.request().method() === 'POST',
    );
    await page
      .getByRole('main')
      .getByRole('link', { name: /^Call / })
      .click();
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
          const list = (await (await page.request.get(`/api/v1/ventures/${ventureId}/sessions`)).json()) as {
            items: { id: string }[];
          };
          return list.items.some((item) => item.id === sessionId);
        },
        { timeout: 10_000 },
      )
      .toBe(false);
  });

  test('the call screen is keyboard and screen-reader friendly in both themes', async ({ page }) => {
    await voiceNoticeSeen(page);
    await stubCallsBackend(page);
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
      await stubCallsBackend(page);
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
