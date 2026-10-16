import { expect, test, type Page } from '@playwright/test';

import {
  composer,
  FOUNDER_NAME,
  openVenture,
  ownerAccessCode,
  pageShowsText,
  runToken,
  signIn,
  signOut,
  startConversation,
  takeRevealedCode,
  TENANT,
  VENTURE_NAME,
} from './support/fixtures';

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
 * structured answer, asserting the live progress steps on the way.
 */
async function startAndAwaitAnswer(page: Page, text: string) {
  let conversationId = '';
  await withSlowNetwork(page, async () => {
    conversationId = await startConversation(page, text);
    const current = page.getByRole('article', { name: 'Current exchange' });
    const progress = current.getByRole('list', { name: 'Response progress' });
    await expect(progress).toBeVisible();
    await expect(progress.getByRole('listitem')).toHaveText([
      /^Understanding/,
      /^Retrieving evidence/,
      /^Reasoning/,
      /^Checking grounding & policy/,
    ]);
    await expect(progress.locator('li[data-status="done"]').first()).toBeVisible();
  });
  // Full speed again: the rest of the answer and the venture data it refreshes (memory to bind the
  // suggestions to) arrive normally.
  await expect(page.getByRole('article', { name: 'Current exchange' })).toBeHidden({ timeout: 30_000 });
  const answer = page.getByRole('article', { name: 'Exchange 1' });
  await expect(answer.getByText(text, { exact: true }).first()).toBeVisible();
  await expect(answer.getByRole('list', { name: 'Claims and their sources' })).toBeVisible();
  return { answer, conversationId };
}

test.describe('founder journey', () => {
  test('admin issues a code, the founder talks to the vEIR, curates memory and escalates', async ({
    page,
  }) => {
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
      await expect(nav.getByRole('link', { name: 'People & access' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      await page.getByRole('button', { name: `Issue access code to ${FOUNDER_NAME}` }).click();
      const dialog = page.getByRole('dialog', { name: 'Issue access code' });
      await dialog.getByRole('textbox', { name: 'Label' }).fill(`journey ${token}`);
      await dialog.getByRole('button', { name: 'Issue code' }).click();
      founderCode = await takeRevealedCode(page, FOUNDER_NAME);
      // The plaintext code is gone from the page once the dialog closes.
      expect(await pageShowsText(page, founderCode), 'code still on the page').toBe(false);
      const row = page.getByRole('row', { name: new RegExp(FOUNDER_NAME) });
      await expect(row).toContainText(`journey ${token}`);
    });

    await test.step('sign out, then sign in as the founder, who lands in New chat', async () => {
      await signOut(page);
      await signIn(page, founderCode);
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Maya');
    });

    let ventureId = '';
    await test.step('New chat: the vEIR greets the founder with starting points', async () => {
      ventureId = await openVenture(page);
      const nav = page.getByRole('navigation', { name: 'Main' });
      await expect(nav.getByRole('button', { name: new RegExp(`Current: ${VENTURE_NAME}$`) })).toBeVisible();
      await expect(nav.getByRole('link', { name: 'New chat' })).toHaveAttribute('aria-current', 'page');
      await expect(
        page.getByRole('list', { name: 'Suggestions' }).getByRole('listitem').first(),
      ).toBeVisible();
      await expect(page.getByRole('note', { name: 'AI disclosure' })).toHaveCount(1);
    });

    const question = `Which assumption should we test first? ${token}`;
    await test.step('the first message starts the conversation and gets a structured, cited answer', async () => {
      const { answer, conversationId } = await startAndAwaitAnswer(page, question);
      await expect(page.getByRole('note', { name: 'AI disclosure' })).toHaveCount(1);
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Which assumption should we test');
      await expect(
        answer.getByRole('list', { name: 'Claims and their sources' }).getByText('Fact'),
      ).toBeVisible();
      await expect(answer.getByRole('button', { name: /^Evidence E1: / }).first()).toBeVisible();
      // The conversation is listed (and current) in the sidebar's recents.
      await expect(
        page.getByRole('navigation', { name: 'Main' }).locator(`a[href$="/c/${conversationId}"]`),
      ).toHaveAttribute('aria-current', 'page');
    });

    await test.step('open the sources panel from a citation chip', async () => {
      const answer = page.getByRole('article', { name: 'Exchange 1' });
      const chip = answer.getByRole('button', { name: /^Evidence E1: / }).first();
      const label = (await chip.getAttribute('aria-label')) ?? '';
      const title = label.replace(/^Evidence E1: /, '');
      await chip.click();
      const inspector = page.getByRole('complementary', { name: 'Session inspector' });
      await expect(inspector.getByRole('tab', { name: 'Evidence' })).toHaveAttribute('aria-selected', 'true');
      const source = inspector.getByRole('article', { name: title, exact: true }).first();
      await expect(source).toBeVisible();
      await expect(source).toBeFocused();
    });

    await test.step('approve the proposed memory', async () => {
      const suggestions = page
        .getByRole('article', { name: 'Exchange 1' })
        .getByRole('list', { name: 'Memory suggestions' });
      const item = suggestions.getByRole('listitem').filter({ hasText: token });
      // The suggestion becomes approvable once the refreshed venture memory includes it.
      const approve = item.getByRole('button', { name: 'Approve' });
      await expect(approve).toBeVisible({ timeout: 30_000 });
      await approve.click();
      await expect(item.getByText('Confirmed')).toBeVisible();
    });

    await test.step('end the conversation and read the recap', async () => {
      await page.getByRole('button', { name: 'End session' }).click();
      const confirm = page.getByRole('alertdialog', { name: 'End this session?' });
      await confirm.getByRole('button', { name: 'End session' }).click();
      await expect(page).toHaveURL(/view=recap/);
      await expect(page.getByRole('tab', { name: 'Recap' })).toHaveAttribute('aria-selected', 'true');
      for (const section of ['Diagnosis', 'Evidence', 'Challenge', 'Next actions', 'Escalation']) {
        await expect(page.getByRole('region', { name: new RegExp(`^\\d ${section}$`) })).toBeVisible();
      }
      await expect(page.getByRole('note', { name: 'AI disclosure' })).toHaveCount(1);
    });

    await test.step('Knowledge shows the approved item (also reached from an old memory link)', async () => {
      await page
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link', { name: /^Knowledge/ })
        .click();
      await expect(page.getByRole('heading', { level: 1, name: 'Knowledge' })).toBeVisible();
      await page.getByRole('searchbox', { name: 'Search' }).fill(token);
      const item = page
        .getByRole('list', { name: 'Memory' })
        .getByRole('button', { name: new RegExp(token) });
      await expect(item).toHaveCount(1);
      await expect(item).toContainText('Confirmed');

      await page.goto(`/${TENANT}/app/ventures/${ventureId}/memory?q=${token}`);
      await expect(page).toHaveURL(new RegExp(`/${TENANT}/app/v/${ventureId}/knowledge\\?q=${token}$`));
      await expect(
        page.getByRole('list', { name: 'Memory' }).getByRole('button', { name: new RegExp(token) }),
      ).toHaveCount(1);
    });

    await test.step('a high-risk question is escalated and the founder approves sharing', async () => {
      await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'New chat' }).click();
      await expect(composer(page)).toBeVisible();
      const prompt = `We need to file a provisional patent before demo day. ${token}`;
      const { answer } = await startAndAwaitAnswer(page, prompt);
      const handoff = answer.getByRole('region', { name: 'A person should weigh in on this' });
      await expect(handoff).toContainText('IP & licensing');
      await handoff.getByRole('button', { name: 'View handoff' }).click();

      await expect(page).toHaveURL(/\/help\?id=[0-9a-f-]{36}/);
      const detail = page.getByRole('region', { name: 'IP & licensing' });
      await expect(detail.getByRole('definition').first()).toHaveText('Draft');
      await expect(page.getByRole('region', { name: 'Packet' })).toContainText(prompt);
      const consent = page.getByRole('region', { name: 'Consent' });
      await consent.getByRole('button', { name: 'Approve sharing' }).click();
      // Specialist requests wait in the program team's routing queue once the founder consents.
      await expect(detail.getByRole('definition').first()).toHaveText('Waiting for assignment');
      await expect(consent).toHaveCount(0);
      await expect(page.getByRole('list', { name: 'Status timeline' })).toContainText('Your consent (done)');
    });
  });
});
