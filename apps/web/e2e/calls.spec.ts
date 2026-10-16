import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import {
  expectNoHorizontalScroll,
  expectNoSeriousA11yViolations,
  expectReachable,
  FOUNDER_STATE,
  openVenture,
  runToken,
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

// CALLS-BACKEND-STUB (see the file comment).
async function stubCallsBackend(page: Page): Promise<void> {
  const callId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c01';
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
  await page.route(/\/api\/v1\/speech$/, (route) =>
    route.fulfill({
      status: 501,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'about:blank',
        title: 'Speech unavailable',
        status: 501,
        code: 'speech_unavailable',
        requestId: 'e2e',
      }),
    }),
  );
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
    await stubCallsBackend(page);
    await openVenture(page);
    const token = runToken();
    let sessionId = '';
    let callId = '';

    await test.step('the sidebar Call button opens the call screen in a new conversation', async () => {
      const started = page.waitForResponse(
        (response) => /\/sessions\/[0-9a-f-]{36}\/calls$/.test(response.url()) && response.status() === 201,
      );
      await page
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link', { name: /^Call / })
        .click();
      await expect(callScreen(page)).toBeVisible();
      await page.waitForURL(/\/c\/[0-9a-f-]{36}\?call=1$/);
      sessionId = /\/c\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
      const body = (await (await started).json()) as { call: { id: string }; intro: { text: string } | null };
      callId = body.call.id;
      const screen = callScreen(page);
      await expect(screen.getByRole('note', { name: 'AI disclosure' })).toHaveCount(1);
      await expect(screen.getByRole('note', { name: 'AI disclosure' })).toContainText('not a person');
      // The intro is the vEIR's first line (the browser reads it: there is no server voice in mock mode).
      if (body.intro) {
        await expect(screen.getByRole('region', { name: 'Captions' })).toContainText(body.intro.text);
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

      await expect
        .poll(async () => (await sessionTurns(page.request, sessionId)).turns.length, { timeout: 30_000 })
        .toBe(1);
      const { turns } = await sessionTurns(page.request, sessionId);
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
    });

    await test.step('minimized, the call continues in the mini bar over the conversation', async () => {
      await callScreen(page).getByRole('button', { name: 'Minimize call' }).click();
      await expect(callScreen(page)).toBeHidden();
      await expect(page).toHaveURL(new RegExp(`/c/${sessionId}$`));
      const bar = page.getByRole('region', { name: /^Call with / });
      await expect(bar).toBeVisible();
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
      const keep = screen.getByRole('button', { name: /^Keep: / }).first();
      if (await keep.count()) {
        await keep.click();
        await expect(screen.getByText('Kept').first()).toBeVisible();
      }
      await screen.getByRole('button', { name: 'Back to conversation' }).click();
      await expect(callScreen(page)).toBeHidden();
      await expect(page).toHaveURL(new RegExp(`/c/${sessionId}$`));
      await expect(page.getByRole('region', { name: /^Call with / })).toHaveCount(0);
    });
  });

  test('the call screen is keyboard and screen-reader friendly in both themes', async ({ page }) => {
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
