import { expect, test, type Page } from '@playwright/test';

import {
  FOUNDER_NAME,
  openVenture,
  ownerAccessCode,
  pageShowsText,
  runToken,
  signIn,
  signOut,
  startSession,
  takeRevealedCode,
  TENANT,
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

/** Send a message and wait for the structured answer; asserts the live progress steps on the way. */
async function sendAndAwaitAnswer(page: Page, text: string, exchange: number) {
  const composer = page.getByRole('textbox', { name: 'Message Foundry Guide' });
  await composer.fill(text);
  await withSlowNetwork(page, async () => {
    await composer.press('Enter');
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
    await expect(current).toBeHidden({ timeout: 30_000 });
  });
  const answer = page.getByRole('article', { name: `Exchange ${String(exchange)}` });
  await expect(answer.getByText(text, { exact: true }).first()).toBeVisible();
  await expect(answer.getByRole('list', { name: 'Claims and their sources' })).toBeVisible();
  return answer;
}

test.describe('founder journey', () => {
  test('admin issues a code, the founder coaches, curates memory and escalates', async ({ page }) => {
    const token = runToken();
    let founderCode = '';

    await test.step('landing → sign in as the owner', async () => {
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toContainText('venture coach');
      await expect(page.getByRole('note', { name: 'AI disclosure' })).toBeVisible();
      await page.getByRole('main').getByRole('link', { name: 'Sign in' }).first().click();
      await expect(page).toHaveURL(/\/sign-in$/);
      await signIn(page, ownerAccessCode());
      await expect(page).toHaveURL(new RegExp(`/${TENANT}/app$`));
    });

    await test.step('admin issues an access code for a seeded founder', async () => {
      await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Admin' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Principals' })).toBeVisible();
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

    await test.step('sign out, then sign in as the founder', async () => {
      await signOut(page);
      await signIn(page, founderCode);
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Maya');
    });

    let ventureId = '';
    await test.step('venture overview', async () => {
      ventureId = await openVenture(page);
      await expect(page.getByRole('region', { name: 'Current goal' })).toBeVisible();
    });

    const question = `Which assumption should we test first? ${token}`;
    await test.step('start a diagnose session and get a structured, cited answer', async () => {
      await startSession(page, `Find the riskiest assumption ${token}`);
      await expect(page.getByRole('note', { name: 'AI disclosure' })).toBeVisible();
      const answer = await sendAndAwaitAnswer(page, question, 1);
      await expect(answer.getByText(/^Mock diagnose response/)).toBeVisible();
      await expect(
        answer.getByRole('list', { name: 'Claims and their sources' }).getByText('Fact'),
      ).toBeVisible();
      await expect(answer.getByRole('button', { name: /^Evidence E1: / }).first()).toBeVisible();
    });

    await test.step('open the evidence inspector from a citation chip', async () => {
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
      await item.getByRole('button', { name: 'Approve' }).click();
      await expect(item.getByText('Confirmed')).toBeVisible();
    });

    await test.step('end the session and read the recap', async () => {
      await page.getByRole('button', { name: 'End session' }).click();
      const confirm = page.getByRole('alertdialog', { name: 'End this session?' });
      await confirm.getByRole('button', { name: 'End session' }).click();
      await expect(page).toHaveURL(/view=recap/);
      await expect(page.getByRole('tab', { name: 'Recap' })).toHaveAttribute('aria-selected', 'true');
      for (const section of ['Diagnosis', 'Evidence', 'Challenge', 'Next actions', 'Escalation']) {
        await expect(page.getByRole('region', { name: new RegExp(`^\\d ${section}$`) })).toBeVisible();
      }
    });

    await test.step('the memory page shows the approved item', async () => {
      await page.goto(`/${TENANT}/app/ventures/${ventureId}/memory`);
      await expect(page.getByRole('heading', { level: 1, name: 'Memory' })).toBeVisible();
      await page.getByRole('searchbox', { name: 'Search' }).fill(token);
      const item = page
        .getByRole('list', { name: 'Memory' })
        .getByRole('button', { name: new RegExp(token) });
      await expect(item).toHaveCount(1);
      await expect(item).toContainText('Confirmed');
    });

    await test.step('a high-risk question is escalated and the founder approves sharing', async () => {
      await page.goto(`/${TENANT}/app/ventures/${ventureId}/overview`);
      await startSession(page, `Patent timing ${token}`);
      const prompt = `We need to file a provisional patent before demo day. ${token}`;
      const answer = await sendAndAwaitAnswer(page, prompt, 1);
      const handoff = answer.getByRole('region', { name: 'A person should weigh in on this' });
      await expect(handoff).toContainText('IP & licensing');
      await handoff.getByRole('button', { name: 'View handoff' }).click();

      await expect(page).toHaveURL(/\/escalations\?id=[0-9a-f-]{36}/);
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
