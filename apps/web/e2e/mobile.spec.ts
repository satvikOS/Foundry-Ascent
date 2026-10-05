import { expect, test } from '@playwright/test';

import {
  expectNoHorizontalScroll,
  expectReachable,
  FOUNDER_STATE,
  openVenture,
  runToken,
  startSession,
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

    test('session page', async ({ page }) => {
      await openVenture(page);
      await expectNoHorizontalScroll(page);
      const token = runToken();
      await startSession(page, `Phone check ${token}`);
      await expectNoHorizontalScroll(page);

      const composer = page.getByRole('textbox', { name: 'Message Foundry Guide' });
      await expectReachable(page, composer);
      await expectReachable(page, page.getByRole('combobox', { name: 'Mode for the next message' }));
      await expectReachable(page, page.getByRole('button', { name: 'End session' }));

      await composer.fill(`What is our riskiest assumption? ${token}`);
      await expectReachable(page, page.getByRole('button', { name: 'Send message' }));
      await page.getByRole('button', { name: 'Send message' }).click();
      const answer = page.getByRole('article', { name: 'Exchange 1' });
      await expect(answer.getByRole('list', { name: 'Claims and their sources' })).toBeVisible({
        timeout: 30_000,
      });
      await expectNoHorizontalScroll(page);
      await expectReachable(page, answer.getByRole('button', { name: /^Evidence E1: / }).first());
    });
  });
});
