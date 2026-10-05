import { expect, test } from '@playwright/test';

import {
  expectNoSeriousA11yViolations,
  FOUNDER_STATE,
  openVenture,
  OWNER_STATE,
  runToken,
  startSession,
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

      test('venture overview, session with an answer, and memory', async ({ page }) => {
        const ventureId = await openVenture(page);
        await useTheme(page, scheme);
        await expectNoSeriousA11yViolations(page, `overview (${scheme})`);

        const token = runToken();
        await startSession(page, `Accessibility check ${token}`);
        await page
          .getByRole('textbox', { name: 'Message Foundry Guide' })
          .fill(`What should we test next? ${token}`);
        await page.getByRole('button', { name: 'Send message' }).click();
        const answer = page.getByRole('article', { name: 'Exchange 1' });
        await expect(answer.getByRole('list', { name: 'Claims and their sources' })).toBeVisible({
          timeout: 30_000,
        });
        await expectNoSeriousA11yViolations(page, `session (${scheme})`);

        await page.goto(`/${TENANT}/app/ventures/${ventureId}/memory`);
        await expect(page.getByRole('heading', { level: 1, name: 'Memory' })).toBeVisible();
        await expect(page.getByRole('list', { name: 'Memory' })).toBeVisible();
        await expectNoSeriousA11yViolations(page, `memory (${scheme})`);
      });
    });

    test.describe('platform admin', () => {
      test.use({ storageState: OWNER_STATE });

      test('admin principals', async ({ page }) => {
        await page.goto('/admin/principals');
        await useTheme(page, scheme);
        await expect(page.getByRole('heading', { level: 1, name: 'Principals' })).toBeVisible();
        await expect(page.getByRole('table')).toBeVisible();
        await expectNoSeriousA11yViolations(page, `admin principals (${scheme})`);
      });
    });
  });
}
