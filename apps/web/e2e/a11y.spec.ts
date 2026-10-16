import { expect, test } from '@playwright/test';

import {
  expectNoSeriousA11yViolations,
  FOUNDER_STATE,
  openVenture,
  OWNER_STATE,
  runToken,
  startConversation,
  TENANT,
  useTheme,
} from './support/fixtures';

/**
 * axe-core (WCAG 2.0/2.1/2.2 A and AA rules) on the main surfaces, in both themes: zero serious or
 * critical violations. The journey spec covers behaviour; this spec covers what assistive technology and
 * low-vision users get.
 */
for (const scheme of ['dark', 'light'] as const) {
  test.describe(`accessibility · ${scheme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    });

    test('landing and sign-in', async ({ page }) => {
      await page.goto('/');
      await useTheme(page, scheme);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectNoSeriousA11yViolations(page, `landing (${scheme})`);

      await page.goto('/sign-in');
      await useTheme(page, scheme);
      await expect(page.getByRole('textbox', { name: 'Access code' })).toBeVisible();
      await expectNoSeriousA11yViolations(page, `sign-in (${scheme})`);
    });

    test.describe('founder', () => {
      test.use({ storageState: FOUNDER_STATE });

      test('new chat, a conversation with an answer, knowledge and the account menu', async ({ page }) => {
        const ventureId = await openVenture(page);
        await useTheme(page, scheme);
        await expectNoSeriousA11yViolations(page, `new chat (${scheme})`);

        const token = runToken();
        await startConversation(page, `What should we test next? ${token}`);
        const answer = page.getByRole('article', { name: 'Exchange 1' });
        await expect(answer.getByRole('list', { name: 'Claims and their sources' })).toBeVisible({
          timeout: 30_000,
        });
        await expectNoSeriousA11yViolations(page, `conversation (${scheme})`);

        await page.goto(`/${TENANT}/app/v/${ventureId}/knowledge`);
        await expect(page.getByRole('heading', { level: 1, name: 'Knowledge' })).toBeVisible();
        await expect(page.getByRole('list', { name: 'Memory' })).toBeVisible();
        await expectNoSeriousA11yViolations(page, `knowledge (${scheme})`);

        // The account menu is reachable by keyboard and returns focus when closed.
        const account = page.getByRole('button', { name: /^Account menu for / });
        await account.focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('menuitem', { name: 'Data use & privacy' })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(account).toBeFocused();
      });
    });

    test.describe('platform admin', () => {
      test.use({ storageState: OWNER_STATE });

      test('people & access, reached from the old admin URL', async ({ page }) => {
        await page.goto('/admin/principals');
        await expect(page).toHaveURL(new RegExp(`/${TENANT}/app/admin/principals$`));
        await useTheme(page, scheme);
        await expect(page.getByRole('heading', { level: 1, name: 'People & access' })).toBeVisible();
        await expect(page.getByRole('table')).toBeVisible();
        await expectNoSeriousA11yViolations(page, `admin people & access (${scheme})`);
      });
    });
  });
}
