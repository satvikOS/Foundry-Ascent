import { expect, test } from '@playwright/test';

import {
  composer,
  expectNoHorizontalScroll,
  expectReachable,
  FOUNDER_STATE,
  openVenture,
  runToken,
} from './support/fixtures';

/** Phone-width smoke (390 × 844): nothing scrolls sideways and the primary controls are reachable. */
test.describe('mobile 390×844', () => {
  test('landing', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectReachable(page, page.getByRole('main').getByRole('link', { name: 'Sign in' }).first());
    await expectReachable(page, page.getByRole('link', { name: 'How it works' }));
  });

  test('sign-in', async ({ page }) => {
    await page.goto('/sign-in');
    const input = page.getByRole('textbox', { name: 'Access code' });
    await expectReachable(page, input);
    await expectReachable(page, page.getByRole('button', { name: 'Sign in', exact: true }));
    await input.fill('FA-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ');
    await expect(input).toHaveValue('ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ');
    await expectNoHorizontalScroll(page);
  });

  test.describe('founder', () => {
    test.use({ storageState: FOUNDER_STATE });

    test('navigation sheet', async ({ page }) => {
      await openVenture(page);
      await expectNoHorizontalScroll(page);
      await expectReachable(page, page.getByRole('link', { name: 'New chat' }));
      await page.getByRole('button', { name: 'Open navigation' }).click();
      const sheet = page.getByRole('dialog', { name: 'Navigation' });
      for (const name of ['Knowledge', 'Documents', 'Human help', 'Team']) {
        await expectReachable(page, sheet.getByRole('link', { name: new RegExp(`^${name}`) }));
      }
      await expectReachable(page, sheet.getByRole('link', { name: /^Call / }));
      await expectReachable(page, sheet.getByRole('button', { name: /^Account menu for / }));
      await sheet.getByRole('link', { name: /^Knowledge/ }).click();
      await expect(sheet).toBeHidden();
      await expect(page.getByRole('heading', { level: 1, name: 'Knowledge' })).toBeVisible();
      await expectNoHorizontalScroll(page);
    });

    test('new chat and conversation', async ({ page }) => {
      await openVenture(page);
      const token = runToken();
      const box = composer(page);
      await expectReachable(page, box);
      await expectReachable(page, page.getByRole('combobox', { name: 'Mode for the next message' }));
      await expectReachable(page, page.getByRole('button', { name: 'Add documents' }));
      await expectReachable(page, page.getByRole('button', { name: 'Temporary' }));

      await box.fill(`What is our riskiest assumption? ${token}`);
      await expectReachable(page, page.getByRole('button', { name: 'Send message' }));
      await page.getByRole('button', { name: 'Send message' }).click();
      await page.waitForURL(/\/c\/[0-9a-f-]{36}/);
      const answer = page.getByRole('article', { name: 'Exchange 1' });
      await expect(answer.getByRole('button', { name: /^Sources & reasoning/ })).toBeVisible({
        timeout: 30_000,
      });
      await expectNoHorizontalScroll(page);
      await expectReachable(page, composer(page));
      await expect(page.getByRole('note', { name: 'AI disclosure' })).toBeInViewport();
      await expectReachable(page, page.getByRole('button', { name: 'Conversation options' }));

      // A citation opens the sources as a sheet.
      const chip = answer.getByRole('button', { name: /^Evidence E1: / }).first();
      await expectReachable(page, chip);
      await chip.click();
      const panel = page.getByRole('dialog', { name: 'Context' });
      await expect(panel.getByRole('tab', { name: 'Sources' })).toHaveAttribute('aria-selected', 'true');
      await expectReachable(page, panel.getByRole('tab', { name: 'Human help' }));
      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();
    });
  });
});
