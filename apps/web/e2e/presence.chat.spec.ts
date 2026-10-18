import { expect, type Browser, type Page } from '@playwright/test';

import {
  composer,
  expectNoBareEirName,
  expectNoSeriousA11yViolations,
  expectVeirBadgeInView,
  FOUNDER_STATE,
  openVenture,
  OWNER_STATE,
  runToken,
  signIn,
  startConversation,
  TENANT,
  test,
  veirWelcome,
} from './support/fixtures';

/*
 * The vEIR's presence (wave 6): the founder meets "Corin · vEIR", Corin's digital twin, like a person on a video
 * call. What a vEIR is is said once, in a welcome stored with the person, and the vEIR badge keeps it a tap away;
 * no disclaimer line sits under the composer, and the vEIR never volunteers "I'm an AI". Asked sincerely, it
 * answers honestly in one warm line and carries on.
 */

const WRITE_HEADERS = { 'x-requested-with': 'foundry-ascent', 'content-type': 'application/json' };

/** A new teammate on QuietQuad (Corin's vEIR, first-person consent) who has never met it. */
async function newTeammate(browser: Browser): Promise<{ accessCode: string; ventureId: string }> {
  const owner = await browser.newContext({ storageState: OWNER_STATE });
  try {
    const ventures = await owner.request.get('/api/v1/program/ventures');
    expect(ventures.status(), 'GET /program/ventures').toBe(200);
    const quietquad = ((await ventures.json()) as { items: { id: string; name: string }[] }).items.find(
      (v) => v.name === 'QuietQuad',
    );
    if (!quietquad) throw new Error('QuietQuad is missing from the seed');
    const invited = await owner.request.post(`/api/v1/ventures/${quietquad.id}/team/invitations`, {
      headers: { ...WRITE_HEADERS, 'idempotency-key': runToken() },
      data: { displayName: `Welcome Tester ${runToken()}`, role: 'team', expiresInDays: 1 },
    });
    expect(invited.status(), 'POST /ventures/:id/team/invitations').toBe(201);
    return {
      accessCode: ((await invited.json()) as { accessCode: string }).accessCode,
      ventureId: quietquad.id,
    };
  } finally {
    await owner.close();
  }
}

async function welcomeAcknowledgedAt(page: Page): Promise<string | null | undefined> {
  const response = await page.request.get('/api/v1/me');
  expect(response.status(), 'GET /me').toBe(200);
  return ((await response.json()) as { veirWelcomeAcknowledgedAt?: string | null }).veirWelcomeAcknowledgedAt;
}

/** The text of the answer of exchange `n`, once it is complete. */
async function answerText(page: Page, n: number): Promise<string> {
  const exchange = page.getByRole('article', { name: `Exchange ${String(n)}` });
  await expect(exchange.getByRole('button', { name: 'Copy answer' })).toBeVisible({ timeout: 30_000 });
  return (await exchange.locator('[data-slot="markdown"]').first().innerText()).trim();
}

test.describe('meeting the vEIR', () => {
  test('the first visit shows the welcome once: stored with the person, in any browser', async ({
    browser,
  }) => {
    const { accessCode, ventureId } = await newTeammate(browser);
    const first = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await first.newPage();
    await signIn(page, accessCode, { welcome: 'keep' });
    await page.waitForURL(new RegExp(`/v/${ventureId}$`));
    expect(await welcomeAcknowledgedAt(page)).toBeNull();

    await test.step('one calm screen: its face, two short sentences, one button', async () => {
      const welcome = veirWelcome(page);
      await expect(welcome).toBeVisible();
      await expect(welcome.getByRole('heading', { name: 'Meet Corin’s vEIR' })).toBeVisible();
      await expect(welcome).toContainText(
        'Corin’s digital twin: an AI built with Corin’s consent from how Corin coaches.',
      );
      await expect(welcome).toContainText('Corin sees what you work on here.');
      await expect(welcome.getByRole('button')).toHaveText(['Continue']);
      await expect(welcome).not.toContainText(/not a person|No human wrote/);
      await expectNoSeriousA11yViolations(page, 'the vEIR welcome');
    });

    await test.step('Continue stores it with the person and leaves New chat with no disclaimer line', async () => {
      const stored = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/v1/me/veir-welcome/acknowledge') && response.status() === 200,
      );
      await veirWelcome(page).getByRole('button', { name: 'Continue' }).click();
      await stored;
      await expect(veirWelcome(page)).toBeHidden();
      await expect(composer(page)).toBeVisible();
      expect(await welcomeAcknowledgedAt(page)).not.toBeNull();
      await expectVeirBadgeInView(page);
      await expectNoBareEirName(page, 'New chat after the welcome');
    });

    await test.step('not again: after a reload, nor in another browser of the same person', async () => {
      await page.reload();
      await expect(composer(page)).toBeVisible();
      await expect(veirWelcome(page)).toHaveCount(0);
      const { cookies } = await first.storageState();
      await first.close();
      const second = await browser.newContext({ storageState: { cookies, origins: [] } });
      const tab = await second.newPage();
      await tab.goto(`/${TENANT}/app/v/${ventureId}`);
      await expect(composer(tab)).toBeVisible();
      await expect(veirWelcome(tab)).toHaveCount(0);
      await second.close();
    });
  });

  test('a call before the welcome says it on its start screen, and Start call stores it', async ({
    browser,
  }) => {
    const { accessCode, ventureId } = await newTeammate(browser);
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    const calls: string[] = [];
    page.on('response', (response) => {
      if (response.request().method() !== 'POST' || response.status() !== 201) return;
      if (!/\/sessions\/[0-9a-f-]{36}\/calls$/.test(response.url())) return;
      void response
        .json()
        .then((body: { call: { id: string } }) => calls.push(body.call.id))
        .catch(() => undefined);
    });
    try {
      await signIn(page, accessCode, { welcome: 'keep' });
      await page.goto(`/${TENANT}/app/v/${ventureId}?call=1`);
      const screen = page.getByRole('dialog', { name: /^Call with / });
      await expect(screen).toBeVisible();
      // The welcome is not stacked over the call: its start screen says it, beside how voice is handled.
      await expect(veirWelcome(page)).toHaveCount(0);
      await expect(screen.getByTestId('veir-welcome-inline')).toContainText(
        'Corin’s digital twin: an AI built with Corin’s consent from how Corin coaches.',
      );
      await expect(screen.getByTestId('voice-notice')).toContainText('Amazon Transcribe');
      await expect(screen.locator('[data-slot="call-name-tag"]')).toHaveText('CorinvEIR');
      const stored = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/v1/me/veir-welcome/acknowledge') && response.status() === 200,
      );
      await screen.getByRole('button', { name: 'Start call' }).click();
      await stored;
      // A first meeting: the vEIR introduces itself once, as Corin's digital twin.
      await expect(screen.getByRole('region', { name: 'Captions' })).toContainText(
        "I'm Corin's vEIR, Corin's digital twin.",
      );
      await expect(screen.getByRole('textbox', { name: /^Reply to / })).toBeVisible({ timeout: 20_000 });
      await screen.getByRole('button', { name: 'End call' }).click();
      await expect(screen.getByRole('heading', { name: 'Call ended' })).toBeVisible({ timeout: 20_000 });
      expect(await welcomeAcknowledgedAt(page)).not.toBeNull();
    } finally {
      for (const id of calls) {
        await page.request.post(`/api/v1/calls/${id}/end`, {
          headers: WRITE_HEADERS,
          data: { reason: 'user' },
        });
      }
      await context.close();
    }
  });
});

test.describe('talking with the vEIR', () => {
  test.use({ storageState: FOUNDER_STATE });

  test('no disclaimer line; honest in one warm line when asked; never "I’m an AI, I don’t have a life"', async ({
    page,
  }) => {
    const created: string[] = [];
    try {
      await openVenture(page);
      await expect(page.getByRole('note', { name: 'AI disclosure' })).toHaveCount(0);

      await test.step('"Are you real?" gets the honest one-liner, then the conversation goes on', async () => {
        created.push(await startConversation(page, 'Are you real?'));
        const answer = await answerText(page, 1);
        expect(answer).toMatch(
          /^I'm Corin's digital twin, built from how Corin coaches, and Corin sees what we work on\. /,
        );
        expect(answer).not.toMatch(/I'm an AI|not a person|To be clear|Approval decisions/);
        await expect(page.getByRole('note', { name: 'AI disclosure' })).toHaveCount(0);
      });

      await test.step('"Do you have a life?" gets a light line, not a lecture about being an AI', async () => {
        await composer(page).fill('Ha, do you even have a life?');
        await composer(page).press('Enter');
        const answer = await answerText(page, 2);
        expect(answer).toMatch(/^Ha, my favourite topic right now is your venture\. /);
        expect(answer).not.toMatch(/an AI|have a life|don't have|not a person/i);
      });

      await test.step('the header names it like a call tile, and its badge explains it', async () => {
        const header = page.locator('header').filter({ has: page.getByRole('heading', { level: 1 }) });
        await expect(header.locator('[data-slot="veir-name"]').filter({ visible: true })).toHaveText(
          'CorinvEIR',
        );
        await expectVeirBadgeInView(page);
        // The twin's own line names Corin, the person, on purpose ("built from how Corin coaches").
        await expectNoBareEirName(page, 'a conversation about what the vEIR is', [
          /^I'm Corin's digital twin, built from how Corin coaches/,
        ]);
      });

      await test.step('the call tile shows "Corin · vEIR", with no chip clutter or disclaimer line', async () => {
        const calls: string[] = [];
        page.on('response', (response) => {
          if (response.request().method() !== 'POST' || response.status() !== 201) return;
          if (!/\/sessions\/[0-9a-f-]{36}\/calls$/.test(response.url())) return;
          void response
            .json()
            .then((body: { call: { id: string }; intro: { text: string } | null }) =>
              calls.push(body.call.id),
            )
            .catch(() => undefined);
        });
        await page.request.post('/api/v1/calls/notice/acknowledge', { headers: WRITE_HEADERS });
        const intro = page.waitForResponse(
          (response) => /\/sessions\/[0-9a-f-]{36}\/calls$/.test(response.url()) && response.status() === 201,
        );
        await page.goto(`${page.url().split('?')[0] ?? ''}?call=1`);
        const screen = page.getByRole('dialog', { name: /^Call with / });
        await expect(screen).toBeVisible();
        // The page was clicked before (the conversation above), so the call may start at once; else it waits for
        // Start call. Either way it must reach the live call: every check below runs on both paths.
        const start = screen.getByRole('button', { name: 'Start call' });
        const reply = screen.getByRole('textbox', { name: /^Reply to / });
        await expect(start.or(reply)).toBeVisible({ timeout: 20_000 });
        if (await start.isVisible()) await start.click();
        await expect(reply).toBeVisible({ timeout: 20_000 });
        const tag = screen.locator('[data-slot="call-name-tag"]');
        await expect(tag).toHaveText('CorinvEIR');
        await expect(tag.locator('xpath=ancestor::*[@data-slot="call-tile"]')).toHaveCount(1);
        await expect(screen).not.toContainText('Live voice');
        await expect(screen.getByRole('note', { name: 'AI disclosure' })).toHaveCount(0);
        // Maya has met Corin's vEIR before: it greets her, it does not introduce itself or say "an AI coach".
        const body = (await (await intro).json()) as { intro: { text: string } | null };
        expect(body.intro, 'the call greets Maya').not.toBeNull();
        expect(body.intro?.text).toMatch(/^Hi Maya, /);
        expect(body.intro?.text).not.toMatch(/an AI coach|digital twin/);
        await expectNoBareEirName(page, 'the call tile', [
          /^I'm Corin's digital twin, built from how Corin coaches/,
        ]);
        await screen.getByRole('button', { name: 'End call' }).click();
        await expect(screen.getByRole('heading', { name: 'Call ended' })).toBeVisible({ timeout: 20_000 });
        for (const id of calls) {
          await page.request.post(`/api/v1/calls/${id}/end`, {
            headers: WRITE_HEADERS,
            data: { reason: 'user' },
          });
        }
      });
    } finally {
      for (const id of created) {
        await page.request.delete(`/api/v1/sessions/${id}`, { headers: WRITE_HEADERS });
      }
    }
  });
});
