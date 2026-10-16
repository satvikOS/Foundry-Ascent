import { expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';

import {
  composer,
  expectDisclosureInView,
  FOUNDER_NAME,
  FOUNDER_STATE,
  issueAccessCodeViaApi,
  openVenture,
  OWNER_STATE,
  ownerAccessCode,
  pageShowsText,
  runToken,
  signIn,
  signOut,
  startConversation,
  takeRevealedCode,
  TENANT,
  VENTURE_NAME,
  test,
  expectNoBareEirName,
} from './support/fixtures';

const WRITE_HEADERS = { 'x-requested-with': 'foundry-ascent', 'content-type': 'application/json' };

/**
 * Slow the response download (Chromium DevTools network emulation) while a turn streams, so the progress
 * steps stay on screen long enough to assert deterministically. The mock model answers in milliseconds.
 */
async function withSlowNetwork<T>(page: Page, run: () => Promise<T>): Promise<T> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 150,
    downloadThroughput: 1_500,
    uploadThroughput: 1_000_000,
  });
  try {
    return await run();
  } finally {
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await cdp.detach();
  }
}

/**
 * From New chat: send the first message (which creates the conversation and opens it) and wait for the
 * answer, asserting the live progress steps on the way.
 */
async function startAndAwaitAnswer(page: Page, text: string) {
  let conversationId = '';
  await withSlowNetwork(page, async () => {
    conversationId = await startConversation(page, text);
    const current = page.getByRole('article', { name: 'Current exchange' });
    const progress = current.getByRole('list', { name: 'Response progress' });
    await expect(progress).toBeAttached();
    await expect(progress.getByRole('listitem')).toHaveText([
      /^Understanding/,
      /^Retrieving evidence/,
      /^Reasoning/,
      /^Checking grounding & policy/,
    ]);
    await expect(progress.locator('li[data-status="done"]').first()).toBeAttached();
  });
  // Full speed again: the rest of the answer and the venture data it refreshes (memory to bind the
  // suggestions to) arrive normally.
  await expect(page.getByRole('article', { name: 'Current exchange' })).toBeHidden({ timeout: 30_000 });
  const answer = page.getByRole('article', { name: 'Exchange 1' });
  await expect(answer.getByText(text, { exact: true }).first()).toBeVisible();
  await expect(answer.getByRole('button', { name: /^Sources & reasoning/ })).toBeVisible();
  return { answer, conversationId };
}

async function ventureGoal(request: APIRequestContext, ventureId: string): Promise<string | null> {
  const res = await request.get(`/api/v1/ventures/${ventureId}`);
  expect(res.status(), 'GET /ventures/:id').toBe(200);
  return ((await res.json()) as { currentGoal: string | null }).currentGoal;
}

async function escalationStatus(request: APIRequestContext, ventureId: string, id: string): Promise<string> {
  const res = await request.get(`/api/v1/ventures/${ventureId}/escalations`);
  expect(res.status(), 'GET /ventures/:id/escalations').toBe(200);
  const items = ((await res.json()) as { items: { id: string; status: string }[] }).items;
  return items.find((item) => item.id === id)?.status ?? 'missing';
}

test.describe('founder journey', () => {
  test('a founder talks to their vEIR, which keeps what it learns, follows citations and ends with a summary', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const token = runToken();
    let founderCode = '';

    await test.step('landing → sign in as the owner, who lands in their workspace', async () => {
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toContainText('venture coach');
      await expect(page.getByRole('note', { name: 'AI disclosure' })).toBeVisible();
      await page.getByRole('main').getByRole('link', { name: 'Sign in' }).first().click();
      await expect(page).toHaveURL(/\/sign-in$/);
      await signIn(page, ownerAccessCode());
      // The owner (platform admin + program lead, no venture) opens the Program workspace.
      await expect(page).toHaveURL(new RegExp(`/${TENANT}/app/program/portfolio$`));
      await expect(page.getByRole('heading', { level: 1, name: 'Portfolio' })).toBeVisible();
    });

    await test.step('admin issues an access code for a seeded founder', async () => {
      const nav = page.getByRole('navigation', { name: 'Main' });
      await nav.getByRole('button', { name: /^Switch venture or workspace/ }).click();
      await page.getByRole('menuitem', { name: 'Admin' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'People & access' })).toBeVisible();
      await page.getByRole('button', { name: `Issue access code to ${FOUNDER_NAME}` }).click();
      const dialog = page.getByRole('dialog', { name: 'Issue access code' });
      await dialog.getByRole('textbox', { name: 'Label' }).fill(`journey ${token}`);
      await dialog.getByRole('button', { name: 'Issue code' }).click();
      founderCode = await takeRevealedCode(page, FOUNDER_NAME);
      // The plaintext code is gone from the page once the dialog closes.
      expect(await pageShowsText(page, founderCode), 'code still on the page').toBe(false);
    });

    await test.step('sign out, then sign in as the founder, who lands in New chat', async () => {
      await signOut(page);
      await signIn(page, founderCode);
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Maya');
    });

    let ventureId = '';
    await test.step('New chat: the vEIR greets the founder with starting points and one disclosure', async () => {
      ventureId = await openVenture(page);
      const nav = page.getByRole('navigation', { name: 'Main' });
      await expect(nav.getByRole('button', { name: new RegExp(`Current: ${VENTURE_NAME}$`) })).toBeVisible();
      await expect(nav.getByRole('link', { name: 'New chat' })).toHaveAttribute('aria-current', 'page');
      await expect(nav.getByRole('link', { name: /^Call / })).toBeVisible();
      await expect(
        page.getByRole('list', { name: 'Suggestions' }).getByRole('listitem').first(),
      ).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Mode for the next message' })).toHaveText(/Auto/);
      await expect(page.getByRole('note', { name: 'AI disclosure' })).toHaveCount(1);
      await expectNoBareEirName(page, 'New chat');
    });

    // The founder says what is worth remembering in their own words (the coach's framing alone is never kept).
    const question = `Which assumption should we test first? Our riskiest assumption still needs a cheap test. ${token}`;
    let conversationId = '';
    await test.step('the first message starts the conversation, named after it, with a cited answer', async () => {
      const result = await startAndAwaitAnswer(page, question);
      conversationId = result.conversationId;
      await expectDisclosureInView(page);
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Which assumption should we test');
      await expect(result.answer.getByRole('button', { name: /^Evidence E1: / }).first()).toBeVisible();
      // The conversation is listed (and current) in the sidebar's recents, under its own title.
      const row = page
        .getByRole('navigation', { name: 'Recent conversations' })
        .locator(`a[href$="/c/${conversationId}"]`);
      await expect(row).toHaveAttribute('aria-current', 'page');
      await expect(row).toContainText('Which assumption should we test');
      await expectNoBareEirName(page, 'a conversation with an answer');
    });

    await test.step('a citation opens the Sources panel on that source; reasoning expands in place', async () => {
      const answer = page.getByRole('article', { name: 'Exchange 1' });
      const chip = answer.getByRole('button', { name: /^Evidence E1: / }).first();
      const title = ((await chip.getAttribute('aria-label')) ?? '').replace(/^Evidence E1: /, '');
      await chip.click();
      const panel = page.getByRole('complementary', { name: 'Context inspector' });
      await expect(panel.getByRole('tab', { name: 'Sources' })).toHaveAttribute('aria-selected', 'true');
      const source = panel.getByRole('article', { name: title, exact: true }).first();
      await expect(source).toBeVisible();
      await expect(source).toBeFocused();
      await panel.getByRole('tab', { name: 'Notebook' }).click();
      await expect(panel.getByRole('heading', { name: /^What .+ knows$/ })).toBeVisible();
      await page.getByRole('button', { name: 'Hide context panel' }).click();
      await expect(panel).toBeHidden();

      await answer.getByRole('button', { name: /^Sources & reasoning/ }).click();
      await expect(
        answer.getByRole('list', { name: 'Claims and their sources' }).getByText('Fact'),
      ).toBeVisible();
    });

    await test.step('what the vEIR learns is kept by itself, with no Keep to press', async () => {
      const suggestion = page
        .getByRole('article', { name: 'Exchange 1' })
        .getByRole('list', { name: 'Memory suggestions' })
        .getByRole('listitem')
        .first();
      // Once the refreshed venture memory includes it, the row shows it as kept: nobody had to approve it.
      await expect(suggestion.getByText('Kept')).toBeVisible({ timeout: 30_000 });
      await expect(suggestion.getByRole('button', { name: /^Keep: / })).toHaveCount(0);
      // Leave the venture's memory as the next run finds it: forget what this conversation taught.
      const sessionId = /\/c\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
      const listed = await page.request.get(
        `/api/v1/ventures/${ventureId}/memory?status=confirmed&limit=100`,
      );
      expect(listed.status()).toBe(200);
      const { items } = (await listed.json()) as {
        items: { id: string; keptAutomatically?: boolean; sourceRefs: { kind: string; id: string }[] }[];
      };
      const learned = items.filter(
        (m) =>
          m.keptAutomatically === true &&
          m.sourceRefs.some((r) => r.kind === 'session' && r.id === sessionId),
      );
      expect(learned.length).toBeGreaterThan(0);
      for (const { id } of learned) {
        const removed = await page.request.patch(`/api/v1/memory/${id}`, {
          headers: { 'x-requested-with': 'foundry-ascent', 'content-type': 'application/json' },
          data: { action: 'delete' },
        });
        expect([200, 204]).toContain(removed.status());
      }
    });

    await test.step('a follow-up from the conversation composer stays in Auto (no mode is sent)', async () => {
      await expect(page.getByRole('combobox', { name: 'Mode for the next message' })).toHaveText(/Auto/);
      const box = composer(page);
      await box.fill(`How many interviews before we decide? ${token}`);
      const sent = page.waitForRequest(
        (request) =>
          request.method() === 'POST' && request.url().endsWith(`/sessions/${conversationId}/turns`),
      );
      await box.press('Enter');
      const body = (await sent).postDataJSON() as Record<string, unknown>;
      expect(body.text).toBe(`How many interviews before we decide? ${token}`);
      expect(body).not.toHaveProperty('mode');
      const second = page.getByRole('article', { name: 'Exchange 2' });
      await expect(second.getByRole('button', { name: /^Sources & reasoning/ })).toBeVisible({
        timeout: 30_000,
      });
      // Follow-up questions of the latest answer sit above the composer.
      await expect(
        page.getByRole('list', { name: 'Follow-up questions' }).getByRole('listitem').first(),
      ).toBeVisible();
    });

    await test.step('rename the conversation from its menu', async () => {
      await page.getByRole('button', { name: 'Conversation options' }).click();
      await page.getByRole('menuitem', { name: 'Rename' }).click();
      const dialog = page.getByRole('dialog', { name: 'Rename conversation' });
      await dialog.getByRole('textbox', { name: 'Title' }).fill(`Interview plan ${token}`);
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Interview plan ${token}`);
      await expect(
        page
          .getByRole('navigation', { name: 'Recent conversations' })
          .locator(`a[href$="/c/${conversationId}"]`),
      ).toContainText(`Interview plan ${token}`);
    });

    await test.step('end the conversation and read its summary, with the disclosure still in view', async () => {
      await page.getByRole('button', { name: 'Conversation options' }).click();
      await page.getByRole('menuitem', { name: 'End and summarise' }).click();
      const confirm = page.getByRole('alertdialog', { name: 'End this conversation?' });
      await confirm.getByRole('button', { name: 'End conversation' }).click();
      await expect(page).toHaveURL(/view=digest/);
      const summary = page.getByRole('region', { name: 'Summary' });
      await expect(summary).toBeVisible();
      await expect(summary.getByRole('heading', { name: 'Diagnosis' })).toBeVisible();
      await expect(summary.getByRole('heading', { name: 'Next steps' })).toBeVisible();
      await expectDisclosureInView(page);
      await expect(composer(page)).toHaveCount(0);
      // The summary holds the next steps now: the answers above no longer offer them a second time.
      await expect(page.getByRole('region', { name: 'Suggested next steps' })).toHaveCount(0);
      await expectNoBareEirName(page, 'an ended conversation and its summary');
    });

    await test.step('an old memory link lands on Knowledge with its search', async () => {
      await page.goto(`/${TENANT}/app/ventures/${ventureId}/memory?q=${token}`);
      await expect(page).toHaveURL(new RegExp(`/${TENANT}/app/v/${ventureId}/knowledge\\?q=${token}$`));
      await expect(page.getByRole('heading', { level: 1, name: 'Knowledge' })).toBeVisible();
    });

    await test.step('the venture settings save a new current goal', async () => {
      const original = await ventureGoal(page.request, ventureId);
      await page.goto(`/${TENANT}/app/v/${ventureId}/settings`);
      await expect(page.getByRole('heading', { level: 1, name: 'Venture settings' })).toBeVisible();
      await page.getByRole('button', { name: /^(Edit|Set goal)$/ }).click();
      await page.getByRole('textbox', { name: 'Current goal' }).fill(`Test exam-week demand ${token}`);
      await page.getByRole('button', { name: 'Save goal' }).click();
      await expect.poll(() => ventureGoal(page.request, ventureId)).toBe(`Test exam-week demand ${token}`);
      // Put the seeded goal back so later runs see the venture as seeded.
      const restored = await page.request.patch(`/api/v1/ventures/${ventureId}`, {
        headers: WRITE_HEADERS,
        data: { currentGoal: original },
      });
      expect(restored.status(), 'PATCH /ventures/:id').toBe(200);
    });

    await test.step('a high-risk question is handed to a person and the founder approves sharing', async () => {
      await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'New chat' }).click();
      await expect(composer(page)).toBeVisible();
      const prompt = `We need to file a provisional patent before demo day. ${token}`;
      const { answer, conversationId: handoffConversation } = await startAndAwaitAnswer(page, prompt);
      const handoff = answer.getByRole('region', { name: 'A person should weigh in on this' });
      await expect(handoff).toContainText('IP & licensing');
      await handoff.getByRole('button', { name: 'View handoff' }).click();
      await expect(page).toHaveURL(/\/help\?id=[0-9a-f-]{36}/);
      const escalationId = /[?&]id=([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
      await page.getByRole('button', { name: 'Approve sharing' }).click();
      // Specialist requests wait in the program team's routing queue once the founder consents.
      await expect
        .poll(() => escalationStatus(page.request, ventureId, escalationId))
        .toBe('awaiting_assignment');

      // The conversation can be deleted from its row in the sidebar.
      const recents = page.getByRole('navigation', { name: 'Recent conversations' });
      const row = recents
        .getByRole('listitem')
        .filter({ has: page.locator(`a[href$="/c/${handoffConversation}"]`) });
      await row.hover();
      await row.getByRole('button', { name: /^Options for / }).click();
      await page.getByRole('menuitem', { name: 'Delete' }).click();
      await page
        .getByRole('alertdialog', { name: 'Delete this conversation?' })
        .getByRole('button', { name: 'Delete' })
        .click();
      await expect(recents.locator(`a[href$="/c/${handoffConversation}"]`)).toHaveCount(0);
    });
  });
});

/** QuietQuad's id and a new conversation of its founder's, made through the API as the founder. */
async function founderConversation(browser: Browser): Promise<{ ventureId: string; sessionId: string }> {
  const founder = await browser.newContext({ storageState: FOUNDER_STATE });
  const me = await founder.request.get('/api/v1/me');
  expect(me.status(), 'GET /me').toBe(200);
  const memberships = ((await me.json()) as { memberships: { ventureId: string; ventureName: string }[] })
    .memberships;
  const ventureId = memberships.find((m) => m.ventureName === VENTURE_NAME)?.ventureId ?? '';
  const created = await founder.request.post(`/api/v1/ventures/${ventureId}/sessions`, {
    headers: WRITE_HEADERS,
    data: {},
  });
  expect(created.status(), 'POST /ventures/:id/sessions').toBe(201);
  const sessionId = ((await created.json()) as { id: string }).id;
  await founder.close();
  return { ventureId, sessionId };
}

/** Records API calls a read-only role must never make or be refused. */
function watchReadOnly(page: Page) {
  const refused: string[] = [];
  const conversationReads: string[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/api/v1/') && (response.status() === 403 || response.status() === 404)) {
      refused.push(`${response.status()} ${new URL(response.url()).pathname}`);
    }
  });
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (/\/api\/v1\/(sessions|ventures\/[^/]+\/(sessions|notebook|escalations))/.test(path)) {
      conversationReads.push(path);
    }
  });
  return { refused, conversationReads };
}

test.describe('read-only roles', () => {
  test('an advisor opens their venture without requesting what only founders and team may read', async ({
    browser,
  }) => {
    const owner = await browser.newContext({ storageState: OWNER_STATE });
    const advisorCode = await issueAccessCodeViaApi(owner.request, 'Graham Fenwick-Tate');
    await owner.close();

    const context = await browser.newContext();
    const page = await context.newPage();
    const { refused, conversationReads } = watchReadOnly(page);

    await signIn(page, advisorCode);
    await page.goto(`/${TENANT}/app`);
    await page.waitForURL(/\/app\/v\/[0-9a-f-]{36}$/);
    await expect(
      page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening), Graham$/ }),
    ).toBeVisible();
    await expect(page.getByText(/are private to the founders and team/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Knowledge' }).first()).toBeVisible();
    await expect(composer(page)).toHaveCount(0);
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'New chat' })).toHaveCount(0);
    await expect(nav.getByRole('navigation', { name: 'Recent conversations' })).toHaveCount(0);

    // ⌘K lists pages and ventures, never conversations, for a read-only role.
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');

    await page.waitForLoadState('networkidle');
    expect(conversationReads, 'conversation endpoints requested by a read-only role').toEqual([]);
    expect(refused, 'refused API calls').toEqual([]);
    await context.close();
  });

  test('the assigned EIR opens the venture and a conversation link, and reads neither conversation', async ({
    browser,
  }) => {
    const owner = await browser.newContext({ storageState: OWNER_STATE });
    const eirCode = await issueAccessCodeViaApi(owner.request, 'Corin Halvorsen');
    await owner.close();
    const { ventureId, sessionId } = await founderConversation(browser);

    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page, eirCode);
    const watched = watchReadOnly(page);

    await page.goto(`/${TENANT}/app/v/${ventureId}`);
    await expect(
      page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening), Corin$/ }),
    ).toBeVisible();
    await expect(page.getByText(/are private to the founders and team/)).toBeVisible();
    await expect(composer(page)).toHaveCount(0);

    // A link to one of the founder's conversations says plainly that it is private.
    await page.goto(`/${TENANT}/app/v/${ventureId}/c/${sessionId}`);
    await expect(
      page.getByRole('heading', { name: 'Conversations are private to the venture team' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open Knowledge' })).toBeVisible();
    await expect(composer(page)).toHaveCount(0);

    await page.waitForLoadState('networkidle');
    expect(watched.conversationReads, 'conversation endpoints requested by the assigned EIR').toEqual([]);
    expect(watched.refused, 'refused API calls').toEqual([]);
    await context.close();
  });
});
