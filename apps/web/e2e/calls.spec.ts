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

interface LearnedMemory {
  id: string;
  title: string;
  content: string;
  origin: string;
  status: string;
  keptAutomatically?: boolean;
  sourceRefs: { kind: string; id: string }[];
}

/**
 * What the vEIR kept by itself from one conversation, as the venture's memory lists it (turn by turn as it answers,
 * or when the conversation is distilled at the end): any model, any wording.
 */
async function memoryLearnedFrom(
  request: APIRequestContext,
  ventureId: string,
  sessionId: string,
): Promise<LearnedMemory[]> {
  const response = await request.get(`/api/v1/ventures/${ventureId}/memory?status=confirmed&limit=100`);
  expect(response.status(), 'GET /ventures/:id/memory').toBe(200);
  const { items } = (await response.json()) as { items: LearnedMemory[] };
  return items.filter(
    (m) =>
      m.keptAutomatically === true && m.sourceRefs.some((r) => r.kind === 'session' && r.id === sessionId),
  );
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

/**
 * ⌘K → "Voice call with …": the keyboard entry to a call (the side panel's "Call …" offers the same choice). It
 * opens a new conversation's call on its start screen, where Remember or Private is chosen.
 */
async function startCallFromPalette(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k');
  await page
    .getByRole('dialog')
    .getByRole('option', { name: /^Voice call with / })
    .click();
}

function callScreen(page: Page): Locator {
  return page.getByRole('dialog', { name: /^(Voice|Video) call with / });
}

/** The conversation header's Voice call button. */
function voiceCallButton(page: Page): Locator {
  return page.getByRole('main').getByRole('link', { name: /^Voice call with / });
}

/** The review of a call that ended, closing its conversation's transcript (the call screen has closed). */
function callReview(page: Page): Locator {
  return page.getByRole('region', { name: 'Call ended' });
}

/**
 * Ends the call from its screen: one press of End silences it and offers Undo for a few seconds, then it ends and
 * the screen closes onto the conversation, where its review is. Returns the review.
 */
async function endFromScreen(page: Page): Promise<Locator> {
  await callScreen(page).getByRole('button', { name: 'End call' }).click();
  await expect(callScreen(page).getByRole('group', { name: 'Call ended' })).toBeVisible();
  const review = callReview(page);
  await expect(review).toBeVisible({ timeout: 20_000 });
  await expect(callScreen(page)).toHaveCount(0);
  return review;
}

/** Remember or Private, in the start screen's call settings (opened from the memory line under the status). */
async function memoryChoice(page: Page): Promise<Locator> {
  await callScreen(page)
    .getByRole('button', { name: /: change memory for this call$/ })
    .click();
  return page
    .getByRole('dialog', { name: 'Call settings' })
    .getByRole('group', { name: 'Memory for this call' });
}

/** A call ended from the mini bar while on its conversation: the bar gives way to the review, dismissed here. */
async function dismissReviewAfterBarEnd(page: Page, bar: Locator): Promise<void> {
  await bar.getByRole('button', { name: 'End call' }).click();
  const review = callReview(page);
  await expect(review).toBeVisible({ timeout: 20_000 });
  await expect(bar).toHaveCount(0);
  await review.getByRole('button', { name: 'Dismiss call review' }).click();
  await expect(review).toHaveCount(0);
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
 * The calls a test starts (`POST /sessions/:id/calls` as the page sends them), and the ids of those the API
 * opened, so the test can end them whatever happens (`endCalls`) and the next test can call.
 */
function trackCalls(page: Page): { starts: () => number; ids: string[] } {
  let starts = 0;
  const ids: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/sessions\/[0-9a-f-]{36}\/calls$/.test(request.url())) starts += 1;
  });
  page.on('response', (response) => {
    if (response.request().method() !== 'POST' || response.status() !== 201) return;
    if (!/\/sessions\/[0-9a-f-]{36}\/calls$/.test(response.url())) return;
    void response
      .json()
      .then((body: { call: { id: string } }) => ids.push(body.call.id))
      .catch(() => undefined);
  });
  return { starts: () => starts, ids };
}

/** Ends calls through the API (idempotent: an ended call answers as before). */
async function endCalls(page: Page, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    const response = await page.request.post(`/api/v1/calls/${id}/end`, {
      headers: WRITE_HEADERS,
      data: { reason: 'user' },
    });
    expect(response.status(), 'POST /calls/:id/end').toBe(200);
  }
}

/** A conversation with one answered exchange, and a typed call in it, minimized to the mini bar. */
async function minimizedCall(page: Page): Promise<{ sessionId: string; bar: Locator }> {
  await voiceNoticeSeen(page);
  await openVenture(page);
  const sessionId = await startConversation(page, `Which library hosts the pilot? ${runToken()}`);
  await expect(page.getByRole('article', { name: 'Exchange 1' })).toBeVisible({ timeout: 30_000 });
  await voiceCallButton(page).first().click();
  const screen = callScreen(page);
  await expect(screen.getByRole('textbox', { name: /^Reply to / })).toBeFocused();
  await screen.getByRole('button', { name: 'Minimize call' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${sessionId}$`));
  const bar = page.getByRole('region', { name: /^Call with / });
  await expect(bar).toBeVisible();
  return { sessionId, bar };
}

/**
 * Keeps the page's AudioContexts reachable (`window.__callAudio`), so a test can suspend the call's sound the
 * way an interruption does (a phone call on iOS, another app taking the audio).
 */
async function trackCallAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const contexts: AudioContext[] = [];
    (window as unknown as { __callAudio: AudioContext[] }).__callAudio = contexts;
    const Original = window.AudioContext;
    window.AudioContext = class extends Original {
      constructor(options?: AudioContextOptions) {
        super(options);
        contexts.push(this);
      }
    };
  });
}

/** Suspends every AudioContext of the page, as an interruption does. */
async function interruptCallAudio(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const contexts = (window as unknown as { __callAudio?: AudioContext[] }).__callAudio ?? [];
    await Promise.all(contexts.map((context) => context.suspend()));
  });
}

/**
 * The mini bar and the conversation's sticky header never cover each other, scrolled or not: the header sits
 * below the bar, and each one's controls are the element under the pointer at their centre.
 */
async function expectBarAndHeaderApart(page: Page, bar: Locator): Promise<void> {
  const header = page.getByRole('main').locator('header').first();
  const controls = [
    bar.getByRole('button', { name: 'End call' }),
    bar.getByRole('button', { name: /Return to call/ }),
    header.getByRole('button', { name: 'Conversation options' }),
  ];
  // A conversation long enough to scroll whatever the viewport (its header is sticky within it): the overlap
  // shows once the page has scrolled.
  await header.evaluate((element) => {
    const spacer = document.createElement('div');
    spacer.style.height = '3000px';
    spacer.dataset.testSpacer = '';
    element.parentElement?.append(spacer);
  });
  for (const scrollY of [0, 1200]) {
    await page.evaluate((y) => {
      window.scrollTo(0, y);
    }, scrollY);
    await page.waitForFunction((y) => Math.abs(window.scrollY - y) < 2, scrollY);
    const barBox = await bar.boundingBox();
    const headerBox = await header.boundingBox();
    expect(barBox, 'the mini bar is laid out').not.toBeNull();
    expect(headerBox, 'the conversation header is laid out').not.toBeNull();
    if (!barBox || !headerBox) return;
    expect(
      barBox.y,
      `the mini bar is at the top of the view (scrolled ${String(scrollY)})`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      headerBox.y,
      `the header sits below the mini bar (scrolled ${String(scrollY)})`,
    ).toBeGreaterThanOrEqual(barBox.y + barBox.height - 1);
    for (const control of controls) {
      const onTop = await control.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return hit !== null && (hit === element || element.contains(hit));
      });
      const name = (await control.getAttribute('aria-label')) ?? 'a control';
      expect(onTop, `${name} is not covered (scrolled ${String(scrollY)})`).toBe(true);
    }
  }
  await page.evaluate(() => {
    document.querySelector('[data-test-spacer]')?.remove();
    window.scrollTo(0, 0);
  });
}

test.describe('vEIR calls', () => {
  test.use({ storageState: FOUNDER_STATE });

  test('call from ⌘K: typed fallback, reply in captions, mini bar, summary', async ({ page }) => {
    await voiceNoticeSeen(page);
    await openVenture(page);
    const token = runToken();
    let sessionId = '';
    let callId = '';
    const speech: string[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/api/v1/speech')) speech.push(request.url());
    });

    await test.step('from ⌘K: Remember or Private first, then Start call, in a new conversation', async () => {
      let created = 0;
      page.on('request', (request) => {
        if (request.method() === 'POST' && /\/ventures\/[0-9a-f-]{36}\/sessions$/.test(request.url()))
          created += 1;
      });
      const started = page.waitForResponse(
        (response) => /\/sessions\/[0-9a-f-]{36}\/calls$/.test(response.url()) && response.status() === 201,
      );
      await startCallFromPalette(page);
      const screen = callScreen(page);
      await expect(screen).toBeVisible();
      // Away from New chat's choice, the call waits on its start screen (the sphere idle, Start call in the
      // microphone's place): Remember is chosen, Private a click away in the call settings.
      const start = screen.getByRole('button', { name: 'Start call' });
      await expect(start).toBeEnabled();
      await expect(start).toBeFocused();
      await expect(screen.getByRole('button', { name: /: change memory for this call$/ })).toContainText(
        'Remembered',
      );
      const memory = await memoryChoice(page);
      await expect(memory.getByRole('radio', { name: 'Remember this call' })).toBeChecked();
      await expect(memory.getByRole('radio', { name: 'Private, a one-off' })).not.toBeChecked();
      await page.keyboard.press('Escape');
      await expect(memory).toHaveCount(0);
      expect(created, 'nothing is created before Start call').toBe(0);
      await start.click();
      await page.waitForURL(/\/c\/[0-9a-f-]{36}\?call=voice$/);
      sessionId = /\/c\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
      const body = (await (await started).json()) as { call: { id: string }; intro: { text: string } | null };
      callId = body.call.id;
      // A clear header: the persona's name as it is named, the kind of call and its time; no disclaimer line
      // (the disclosure came before the first call, and stays in the call settings).
      await expect(screen.getByRole('note', { name: 'AI disclosure' })).toHaveCount(0);
      await expect(screen.locator('[data-slot="call-heading"]')).toHaveText("Corin's vEIR");
      await expect(screen.locator('[data-slot="call-kind"]')).toContainText(/Voice call\s*·\s*\d+:\d\d/);
      // The intro is the vEIR's first line. There is no server voice here (501), so it is on screen only,
      // and the call says so once.
      if (body.intro) {
        await expect(screen.getByRole('region', { name: 'Captions' })).toContainText(body.intro.text);
        await expect(screen.getByText('Voice replies are unavailable.')).toBeVisible();
      }
    });

    await test.step('no voice input here: the call continues by typing, and says why', async () => {
      const screen = callScreen(page);
      // No speech-to-text grant in mock mode (and headless browsers often have no microphone either).
      await expect(screen.getByText(/Type instead\.$|Allow it in site settings/)).toBeVisible();
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
        // The founder states facts and a decision in their own words (what only the coach says is never kept).
        .fill(
          `Should we pilot with one library? The pilot needs a written success threshold and stop condition. We've decided ours is forty students a day. ${token}`,
        );
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
      await expect(screen.getByText('Voice replies are unavailable.')).toBeVisible();
      expect(await browserSpeechRequests(page)).toBe(0);
    });

    await test.step('minimized, the call continues in the mini bar over the conversation', async () => {
      await callScreen(page).getByRole('button', { name: 'Minimize call' }).click();
      await expect(callScreen(page)).toBeHidden();
      await expect(page).toHaveURL(new RegExp(`/c/${sessionId}$`));
      const bar = page.getByRole('region', { name: /^Call with / });
      await expect(bar).toBeVisible();
      // The bar names the persona as it is named, and the kind of call.
      await expect(bar).toContainText("Corin's vEIR");
      await expect(bar).toContainText('Voice call');
      await expectNoBareEirName(page, 'the mini call bar over the conversation');
      await expect(page.getByRole('main').getByText(token).first()).toBeVisible();
      await bar.getByRole('button', { name: 'Return to call' }).click();
      await expect(callScreen(page)).toBeVisible();
    });

    await test.step('ending shows the summary; what the call learned is kept with no click', async () => {
      const ended = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/calls/${callId}/end`) && response.request().method() === 'POST',
      );
      // Ended on its screen: back in the conversation, whose review takes focus.
      const screen = await endFromScreen(page);
      await expect(screen.getByRole('heading', { name: 'Call ended' })).toBeFocused();
      const response = await ended;
      expect(response.request().postDataJSON()).toMatchObject({ reason: 'user' });
      await expect(screen.getByRole('note', { name: 'AI disclosure' })).toHaveCount(0);
      await expectNoBareEirName(page, 'the after-call summary');
      // What the call learned goes to memory by itself, never as a proposal waiting for anyone.
      const { summary } = (await response.json()) as {
        summary: { memoryProposalIds: string[]; memoryKeptIds?: string[] };
      };
      expect(summary.memoryProposalIds).toEqual([]);
      // The summary says so quietly: one "Remembered" line, and a "Saved to Knowledge" line exactly when the
      // call's turns kept something; nothing to keep or decline.
      await expect(screen.getByTestId('call-remembered')).toContainText('Remembered for next time.');
      if ((summary.memoryKeptIds ?? []).length > 0) {
        await expect(screen.getByTestId('memory-saved')).toContainText('Saved to Knowledge:');
      } else {
        await expect(screen.getByTestId('memory-saved')).toHaveCount(0);
      }
      await expect(screen.getByRole('button', { name: /^(Keep|Not now)/ })).toHaveCount(0);
      await expect(screen.getByText(/would like to remember/)).toHaveCount(0);
      // The decision the founder asked to keep is in the venture's memory, kept by the vEIR itself and learned
      // from this call: by the end of the call's turn or once the ended call is distilled, in any wording that
      // names it.
      const ventureId = (await sessionTurns(page.request, sessionId)).session.ventureId;
      await expect
        .poll(
          async () =>
            (await memoryLearnedFrom(page.request, ventureId, sessionId)).some((m) =>
              /pilot|librar|forty|40|students/i.test(`${m.title} ${m.content}`),
            ),
          { timeout: 60_000, intervals: [1_000] },
        )
        .toBe(true);
      const learned = await memoryLearnedFrom(page.request, ventureId, sessionId);
      for (const id of summary.memoryKeptIds ?? []) {
        expect(
          learned.map((m) => m.id),
          'what the summary says it saved is in memory',
        ).toContain(id);
      }
      for (const m of learned) expect(m).toMatchObject({ origin: 'ai', status: 'confirmed' });
      // Leave the venture's memory as it was.
      for (const { id } of learned) await deleteMemory(page.request, id);
      await expect(callScreen(page)).toBeHidden();
      await expect(page).toHaveURL(new RegExp(`/c/${sessionId}$`));
      await expect(page.getByRole('region', { name: /^Call with / })).toHaveCount(0);
      await screen.getByRole('button', { name: 'Dismiss call review' }).click();
      await expect(screen).toHaveCount(0);
    });
  });

  test('a private call from New chat: chosen before it starts, marked while it lasts, keeps nothing', async ({
    page,
  }) => {
    const calls = trackCalls(page);
    try {
      await voiceNoticeSeen(page);
      const ventureId = await openVenture(page);
      await page.getByRole('radio', { name: 'Private, a one-off' }).click();
      const created = page.waitForRequest(
        (request) => request.method() === 'POST' && request.url().endsWith(`/ventures/${ventureId}/sessions`),
      );
      await page
        .getByRole('main')
        .getByRole('link', { name: /^Voice call with / })
        .click();
      expect((await created).postDataJSON()).toMatchObject({ privacy: 'ephemeral' });
      const screen = callScreen(page);
      const reply = screen.getByRole('textbox', { name: /^Reply to / });
      await expect(reply).toBeFocused({ timeout: 20_000 });
      await expect(screen.getByTestId('private-indicator')).toHaveText('Private');
      await page.waitForURL(/\/c\/[0-9a-f-]{36}\?call=voice$/);
      const sessionId = /\/c\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
      const answered = page.waitForResponse(
        (response) =>
          /\/sessions\/[0-9a-f-]{36}\/turns$/.test(response.url()) && response.request().method() === 'POST',
      );
      // Something that a remembered call would keep: the founder's own goal, in their own words.
      await reply.fill(`Just between us: my goal is per-library pricing by the pilot. ${runToken()}`);
      await reply.press('Enter');
      await answered;
      await expect
        .poll(async () => (await sessionTurns(page.request, sessionId)).turns[0]?.response ?? null, {
          timeout: 30_000,
        })
        .not.toBeNull();
      const endResponse = page.waitForResponse(
        (response) =>
          /\/calls\/[0-9a-f-]{36}\/end$/.test(response.url()) && response.request().method() === 'POST',
      );
      const review = await endFromScreen(page);
      const { summary } = (await (await endResponse).json()) as {
        summary: { memoryProposalIds: string[]; memoryKeptIds?: string[] };
      };
      expect(summary.memoryProposalIds, 'a private call proposes nothing').toEqual([]);
      expect(summary.memoryKeptIds ?? [], 'a private call keeps nothing').toEqual([]);
      await expect(review.getByTestId('call-private')).toHaveText('Private: nothing is remembered.');
      await expect(review.getByTestId('memory-saved')).toHaveCount(0);
      await expect(review.getByTestId('call-remembered')).toHaveCount(0);
      // Nothing in the venture's memory names it, and no summary of it is written.
      const memory = await page.request.get(`/api/v1/ventures/${ventureId}/memory?limit=100`);
      expect(memory.status(), 'GET /ventures/:id/memory').toBe(200);
      const { items } = (await memory.json()) as { items: { sourceRefs: { kind: string; id: string }[] }[] };
      expect(items.filter((m) => m.sourceRefs.some((r) => r.id === sessionId))).toEqual([]);
      const detail = (await (await page.request.get(`/api/v1/sessions/${sessionId}`)).json()) as {
        session: { digest: unknown };
      };
      expect(detail.session.digest ?? null).toBeNull();
      await expect(
        page.getByRole('main').locator('header').getByText('Private', { exact: true }),
      ).toBeVisible();
    } finally {
      await endCalls(page, calls.ids);
    }
  });

  test('a second call minutes later picks up the first, remembers it when asked, and so does the next chat', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await voiceNoticeSeen(page);
    const token = runToken();
    const calls = trackCalls(page);
    const created: string[] = [];
    /**
     * Calls from ⌘K in a new conversation (Remember is preselected on the start screen); returns the
     * conversation and what the call said first.
     */
    const callFromPalette = async (): Promise<{ sessionId: string; intro: string }> => {
      await openVenture(page);
      const started = page.waitForResponse(
        (response) => /\/sessions\/[0-9a-f-]{36}\/calls$/.test(response.url()) && response.status() === 201,
      );
      await startCallFromPalette(page);
      const screen = callScreen(page);
      await expect(screen.getByRole('button', { name: /: change memory for this call$/ })).toContainText(
        'Remembered',
      );
      await screen.getByRole('button', { name: 'Start call' }).click();
      await page.waitForURL(/\/c\/[0-9a-f-]{36}\?call=voice$/);
      const sessionId = /\/c\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
      created.push(sessionId);
      const body = (await (await started).json()) as { intro: { text: string } | null };
      const intro = body.intro?.text ?? '';
      await expect(screen.getByRole('region', { name: 'Captions' })).toContainText(intro);
      return { sessionId, intro };
    };
    /** Types a line on the call and returns the stored reply to it (turn `n`, 1-based). */
    const sayOnCall = async (
      sessionId: string,
      text: string,
      n: number,
    ): Promise<{ answer: string; spoken?: string | null }> => {
      const reply = callScreen(page).getByRole('textbox', { name: /^Reply to / });
      await reply.fill(text);
      await reply.press('Enter');
      await expect
        .poll(async () => (await sessionTurns(page.request, sessionId)).turns[n - 1]?.response ?? null, {
          timeout: 30_000,
        })
        .not.toBeNull();
      const response = (await sessionTurns(page.request, sessionId)).turns[n - 1]?.response;
      if (!response) throw new Error(`turn ${String(n)} has no reply`);
      return response;
    };
    const hangUp = async (): Promise<void> => {
      const review = await endFromScreen(page);
      await review.getByRole('button', { name: 'Dismiss call review' }).click();
      await expect(review).toHaveCount(0);
    };
    try {
      let first = '';
      await test.step('a first call: the founder talks about pricing, then hangs up', async () => {
        const { sessionId } = await callFromPalette();
        first = sessionId;
        await sayOnCall(first, `We are weighing per-library pricing for the pilot. ${token}`, 1);
        await hangUp();
      });

      await test.step('a second call opens by picking up the first, not with the same greeting', async () => {
        const { sessionId, intro } = await callFromPalette();
        expect(sessionId).not.toBe(first);
        // Met before: one sentence that greets her and picks the first call up (no self-introduction, no "an AI
        // coach"), at most 90 characters.
        expect(intro).toMatch(/^Hi Maya, /);
        expect(intro.length).toBeLessThanOrEqual(90);
        expect(intro).not.toContain('what would you like to work on?');
        // It names what the first call was about (pricing), in a sentence that reads right: never a clause spliced
        // in as the topic ("how did where we left off yesterday go?", "shall we pick up They'll…").
        expect(intro).toMatch(/pric/i);
        expect(intro).not.toMatch(
          /\b(?:how did|with|pick up|carry on with|land on) (?:where|what|when|how|who|they|we|it|email|call)\b/i,
        );
        await expectNoBareEirName(page, 'the second call');
      });

      await test.step('"do you remember what we talked about last time?" is answered from the first call', async () => {
        const second = created[1] ?? '';
        const recall = await sayOnCall(second, 'Do you remember what we talked about last time?', 1);
        // Specific (it names what the first call was about, in any wording), spoken as speech, and it hands the
        // turn back with a question.
        const spoken = recall.spoken ?? recall.answer;
        expect(spoken).toMatch(/pric/i);
        expect(spoken.trim()).toMatch(/\?$/);
        // No report artefacts in what is said or in the call's transcript.
        for (const text of [spoken, recall.answer]) {
          expect(text).not.toMatch(/\[E\d|Limited evidence|caveat/i);
        }
        await expect(callScreen(page).getByRole('region', { name: 'Captions' })).toContainText(/pric/i);
        await hangUp();
      });

      await test.step('the next chat opens by picking up the calls too', async () => {
        await openVenture(page);
        const sessionId = await startConversation(page, `One more thing about the pilot. ${token}`);
        created.push(sessionId);
        const detail = (await (await page.request.get(`/api/v1/sessions/${sessionId}`)).json()) as {
          session: { opener: string | null };
        };
        const opener = detail.session.opener ?? '';
        expect(opener).toMatch(
          /last time|when we last spoke|we talked about|you said|you asked|welcome back|good to have you back|good to talk again|nice to hear from you again/i,
        );
        await expect(page.getByRole('main').getByText(opener.slice(0, 40)).first()).toBeVisible();
      });
    } finally {
      await endCalls(page, calls.ids);
      // Deleting the conversations erases what they taught, so the next run starts from the seeded memory.
      for (const id of created) {
        const removed = await page.request.delete(`/api/v1/sessions/${id}`, { headers: WRITE_HEADERS });
        expect([204, 404], 'DELETE /sessions/:id').toContain(removed.status());
      }
    }
  });

  test('the first call of each kind shows the disclosure, once per person in this browser', async ({
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

    await test.step('before the first voice call: the facts, calmly, before anything starts', async () => {
      await startCallFromPalette(page);
      const disclosure = page.getByRole('alertdialog', { name: /^Before your voice call with / });
      await expect(disclosure).toBeVisible();
      await expect(disclosure).toContainText('is an AI mentor, not a person');
      await expect(disclosure).toContainText('The voice you hear is AI-generated');
      await expect(disclosure).toContainText('Amazon Transcribe');
      await expect(disclosure).toContainText('No audio is kept');
      await expect(disclosure).toContainText('remembered for next time');
      await expect(disclosure).toContainText('Private');
      await expect(disclosure).toContainText('A person from the program');
      await expect(disclosure).toContainText('legal, medical or financial advice');
      await expectNoSeriousA11yViolations(page, 'the call disclosure');
      // From ⌘K the call starts a new conversation: the disclosure leads to its Remember or Private first.
      await disclosure.getByRole('button', { name: 'Continue' }).click();
      await expect(disclosure).toHaveCount(0);
      await expect(callScreen(page).getByRole('button', { name: 'Start call' })).toBeVisible();
    });

    await test.step('Start call stores the voice notice with the person on the server', async () => {
      const screen = callScreen(page);
      const acknowledged = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/v1/calls/notice/acknowledge') && response.status() === 200,
      );
      await screen.getByRole('button', { name: 'Start call' }).click();
      await acknowledged;
      await expect(screen.getByRole('textbox', { name: /^Reply to / })).toBeVisible({ timeout: 20_000 });
      await endFromScreen(page);
      expect(await callNoticeAcknowledgedAt(page.request, emberloop.id)).not.toBeNull();
    });

    await test.step('the next voice call in this browser does not show it again; settings keep it', async () => {
      await startCallFromPalette(page);
      const screen = callScreen(page);
      await expect(screen.getByRole('button', { name: 'Start call' })).toBeVisible();
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      await screen.getByRole('button', { name: 'Call settings' }).click();
      await page.getByRole('button', { name: 'About calls' }).click();
      const about = page.getByRole('alertdialog', { name: /^About calls with / });
      await expect(about).toContainText('On video, the face you see is an AI avatar');
      await about.getByRole('button', { name: 'Close' }).click();
      await expect(about).toHaveCount(0);
      await screen.getByRole('button', { name: 'Close' }).click();
      await expect(screen).toHaveCount(0);
      await first.close();
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
    await tab.goto(`${page.url().split('?')[0] ?? ''}?call=voice`);
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
    await expect(tab).toHaveURL(new RegExp(`/c/${sessionId}\\?call=voice$`));
    await endFromScreen(tab);
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
      .getByRole('link', { name: /^Voice call with / })
      .click();
    await expect(callScreen(page).getByRole('textbox', { name: /^Reply to / })).toBeFocused();

    // Calling in the other conversation: one call at a time, so the founder is asked first.
    const refused = tab.waitForResponse(
      (response) => response.url().endsWith(`/sessions/${sessionId}/calls`) && response.status() === 409,
    );
    // As a link opened later (a tab that has seen no click), so the call waits for Start call.
    await withoutUserActivation(tab);
    await tab.goto(`${tab.url().split('?')[0] ?? ''}?call=voice`);
    const screen = callScreen(tab);
    await screen.getByRole('button', { name: 'Start call' }).click();
    await refused;
    await expect(screen.getByRole('heading', { name: 'You’re already in a call' })).toBeVisible();
    await expect(screen.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    const moved = tab.waitForRequest(
      (request) => request.url().endsWith(`/sessions/${sessionId}/calls`) && request.method() === 'POST',
    );
    await screen.getByRole('button', { name: 'Move here, ending the other call' }).click();
    expect((await moved).postDataJSON()).toMatchObject({ replace: true });
    await expect(screen.getByRole('textbox', { name: /^Reply to / })).toBeFocused();
    await endFromScreen(tab);
    await tab.close();
  });

  test('a refused call explains why and leaves no empty conversation behind', async ({ page, baseURL }) => {
    await voiceNoticeSeen(page);
    const ventureId = await openVenture(page);
    const call = voiceCallButton(page);
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
    const call = voiceCallButton(page);
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
      // The side panel's Call, New chat's call buttons and ⌘K offer no call.
      await expect(page.getByTestId('sidebar-call')).toHaveCount(0);
      await expect(page.getByRole('main').getByRole('group', { name: 'Call' })).toHaveCount(0);
      await page.keyboard.press('ControlOrMeta+k');
      const palette = page.getByRole('dialog');
      await expect(palette.getByRole('option').first()).toBeVisible();
      await expect(palette.getByRole('option', { name: / call with / })).toHaveCount(0);
      await page.keyboard.press('Escape');
      // A saved `?call=voice` link explains instead of creating a conversation.
      let created = 0;
      page.on('request', (request) => {
        if (request.url().endsWith(`/ventures/${ventureId}/sessions`) && request.method() === 'POST')
          created += 1;
      });
      await page.goto(`${new URL(page.url()).pathname}?call=voice`);
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
        .getByRole('link', { name: /^Voice call with / })
        .click();
      const screen = callScreen(page);
      await expect(screen.getByRole('textbox', { name: /^Reply to / })).toBeFocused();
      await expect(screen.getByRole('status').first()).toBeVisible();
      await expectNoSeriousA11yViolations(page, `call screen (${scheme})`);

      // The call settings open from the keyboard; captions toggle there (and with their shortcut).
      const trigger = screen.getByRole('button', { name: 'Call settings' });
      await trigger.focus();
      await page.keyboard.press('Enter');
      const settings = page.getByRole('dialog', { name: 'Call settings' });
      const captions = settings.getByRole('button', { name: /^Captions/ });
      await expect(captions).toHaveAttribute('aria-pressed', 'true');
      for (let presses = 0; presses < 6; presses++) {
        if (await captions.evaluate((element) => element === document.activeElement)) break;
        await page.keyboard.press('Tab');
      }
      await expect(captions).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(captions).toHaveAttribute('aria-pressed', 'false');
      await page.keyboard.press('Enter');
      await expect(captions).toHaveAttribute('aria-pressed', 'true');
      await expectNoSeriousA11yViolations(page, `call settings (${scheme})`);

      // The rarer controls live in the settings too, reachable by keyboard.
      await settings.getByRole('button', { name: 'Switch to chat' }).click();
      await expect(screen).toBeHidden();
      await expect(page.getByRole('region', { name: /^Call with / })).toHaveCount(0);
      await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'New chat' }).click();
    }
  });

  test('Back or Forward to a call’s URL never starts a call; only a click does', async ({ page }) => {
    const calls = trackCalls(page);
    try {
      const { sessionId, bar } = await minimizedCall(page);
      expect(calls.starts()).toBe(1);
      // Ended from the mini bar (its review takes the bar's place) and dismissed; then the founder goes elsewhere.
      await dismissReviewAfterBarEnd(page, bar);
      await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'New chat' }).click();
      await expect(page).not.toHaveURL(/\/c\//);

      // Back to the conversation, and Back again to the call's URL: the call screen waits for Start call.
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`/c/${sessionId}$`));
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`/c/${sessionId}\\?call=voice$`));
      const start = callScreen(page).getByRole('button', { name: 'Start call' });
      await expect(start).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(calls.starts(), 'no call started by Back').toBe(1);
      await page.goForward();
      await expect(page).toHaveURL(new RegExp(`/c/${sessionId}$`));
      await page.goBack();
      await expect(start).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(calls.starts(), 'no call started by Forward and Back').toBe(1);

      // The founder's click starts it. Ending it replaces the call's entry: Back does not reopen it.
      await start.click();
      await expect.poll(calls.starts).toBe(2);
      const review = await endFromScreen(page);
      await expect(review.getByRole('heading', { name: 'Call ended' })).toBeFocused();
      await expect(page).toHaveURL(new RegExp(`/c/${sessionId}$`));
      await page.goBack();
      await expect(page).not.toHaveURL(/call=/);
      await expect(callScreen(page)).toHaveCount(0);
      await page.waitForLoadState('networkidle');
      expect(calls.starts()).toBe(2);
    } finally {
      await endCalls(page, calls.ids);
    }
  });

  test('the mini bar and the conversation header never cover each other', async ({ page }) => {
    const calls = trackCalls(page);
    try {
      const { bar } = await minimizedCall(page);
      await expectBarAndHeaderApart(page, bar);
      await dismissReviewAfterBarEnd(page, bar);
    } finally {
      await endCalls(page, calls.ids);
    }
  });

  test('a minimized call whose sound was interrupted offers Turn on sound in the mini bar', async ({
    page,
  }) => {
    const calls = trackCalls(page);
    try {
      await trackCallAudio(page);
      const { bar } = await minimizedCall(page);
      await expect(bar.getByRole('button', { name: 'Turn on sound' })).toHaveCount(0);
      await interruptCallAudio(page);
      const turnOn = bar.getByRole('button', { name: 'Turn on sound' });
      await expect(turnOn).toBeVisible();
      await expect(bar).toContainText('Sound is off');
      await expect(bar.getByRole('status')).toHaveText('Sound is off.');
      // The bar names the persona and the kind of call.
      await expect(bar).toContainText("Corin's vEIR");
      await expect(bar).toContainText('Voice call');
      await turnOn.click();
      await expect(turnOn).toHaveCount(0);
      await expect(bar).not.toContainText('Sound is off');
      await dismissReviewAfterBarEnd(page, bar);
    } finally {
      await endCalls(page, calls.ids);
    }
  });

  test('a minimized call that ends out of view says so, and why', async ({ page, baseURL }) => {
    const calls = trackCalls(page);
    try {
      const { bar } = await minimizedCall(page);
      const status = bar.getByRole('status');
      await expect(status).toHaveText('');
      // The program pauses calls: the next heartbeat (every 15 s) ends the call while the founder reads. In its
      // own conversation the review says so (and why), in place of the bar.
      await withCallsOff(baseURL, async () => {
        const review = callReview(page);
        await expect(review).toBeVisible({ timeout: 25_000 });
        await expect(review.getByRole('status').first()).toHaveText('Calls were paused by the program.');
        await expect(review.getByRole('heading', { name: 'Call ended' })).not.toBeFocused();
        await expect(bar).toHaveCount(0);
      });
      // Anywhere else, the bar says it ended and why, and offers the review.
      await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'New chat' }).click();
      await expect(bar).toContainText('Call ended');
      await expect(status).toHaveText('Call ended. Calls were paused by the program.');
      await expectNoBareEirName(page, 'the mini call bar after the call ended');
      await bar.getByRole('button', { name: 'Review the call' }).click();
      await expect(callReview(page)).toBeVisible();
      await expect(bar).toHaveCount(0);
      await callReview(page).getByRole('button', { name: 'Dismiss call review' }).click();
      await expect(callReview(page)).toHaveCount(0);
    } finally {
      await endCalls(page, calls.ids);
    }
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test('New chat → call: no sideways scroll, controls within reach', async ({ page }) => {
      await voiceNoticeSeen(page);
      await openVenture(page);
      await page
        .getByRole('main')
        .getByRole('link', { name: /^Voice call with / })
        .click();
      const screen = callScreen(page);
      await expect(screen.getByRole('textbox', { name: /^Reply to / })).toBeVisible();
      await expectNoHorizontalScroll(page);
      for (const name of ['Call settings', 'End call']) {
        await expectReachable(page, screen.getByRole('button', { name }));
      }
      const review = await endFromScreen(page);
      await expectNoHorizontalScroll(page);
      await review.getByRole('button', { name: 'Dismiss call review' }).click();
      await expect(review).toHaveCount(0);
    });

    test('the mini bar and the conversation header never cover each other', async ({ page }) => {
      const calls = trackCalls(page);
      try {
        const { bar } = await minimizedCall(page);
        await expectBarAndHeaderApart(page, bar);
        await expectNoHorizontalScroll(page);
        await dismissReviewAfterBarEnd(page, bar);
      } finally {
        await endCalls(page, calls.ids);
      }
    });

    test('Turn on sound fits in the mini bar beside its controls and the AI marker', async ({ page }) => {
      const calls = trackCalls(page);
      try {
        await trackCallAudio(page);
        const { bar } = await minimizedCall(page);
        await interruptCallAudio(page);
        const turnOn = bar.getByRole('button', { name: 'Turn on sound' });
        await expect(turnOn).toBeVisible();
        await expect(bar).toContainText("Corin's vEIR");
        await expectNoHorizontalScroll(page);
        for (const name of ['Turn on sound', 'Return to call', 'End call']) {
          await expectReachable(page, bar.getByRole('button', { name }));
        }
        await turnOn.click();
        await expect(turnOn).toHaveCount(0);
        await dismissReviewAfterBarEnd(page, bar);
      } finally {
        await endCalls(page, calls.ids);
      }
    });
  });
});
