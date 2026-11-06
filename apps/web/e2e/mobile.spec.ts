import { expect } from '@playwright/test';

import {
  composer,
  expectVeirBadgeInView,
  expectNoHorizontalScroll,
  expectReachable,
  FOUNDER_STATE,
  openVenture,
  runToken,
  test,
} from './support/fixtures';

/** Phone-width smoke (390 × 844): nothing scrolls sideways and the primary controls are reachable. */
test.describe('mobile 390×844', () => {
  test('landing', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectReachable(page, page.getByRole('main').getByRole('link', { name: 'Sign in' }).first());
    await expectReachable(page, page.getByRole('main').getByRole('link', { name: 'See a session' }));
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
      for (const name of ['Knowledge', 'Documents', 'Human help', 'Venture']) {
        await expectReachable(page, sheet.getByRole('link', { name: new RegExp(`^${name}`) }));
      }
      // One entry per action: calls start from the composer and ⌘K, not from the navigation.
      await expect(sheet.getByRole('link', { name: /^Call / })).toHaveCount(0);
      // The sheet floats: inset from the screen's edges, with curved corners, over a dimming scrim.
      const box = await sheet.boundingBox();
      expect(box?.x).toBeGreaterThanOrEqual(8);
      expect(box?.y).toBeGreaterThanOrEqual(8);
      expect(await sheet.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe('24px');
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
      // The venture's context and the memory choice are a sheet from the phone bar, never squeezing the page.
      const show = page.getByRole('button', { name: 'Show context panel' });
      await expectReachable(page, show);
      await show.click();
      const context = page.getByRole('dialog', { name: 'Context' });
      await expectReachable(page, context.getByRole('radio', { name: 'Remember this conversation' }));
      await expectReachable(page, context.getByRole('radio', { name: 'Private, a one-off' }));
      const sheetBox = await context.boundingBox();
      expect(sheetBox?.y).toBeGreaterThanOrEqual(8);
      await page.keyboard.press('Escape');
      await expect(context).toBeHidden();
      await expectNoHorizontalScroll(page);

      // A question only the venture's own records answer (the seeded seat-map experiment): the answer cites them.
      await box.fill(`How many repeat visitors did our hand-counted seat map get? ${token}`);
      await expectReachable(page, page.getByRole('button', { name: 'Send message' }));
      await page.getByRole('button', { name: 'Send message' }).click();
      await page.waitForURL(/\/c\/[0-9a-f-]{36}/);
      const answer = page.getByRole('article', { name: 'Exchange 1' });
      await expect(answer.getByRole('button', { name: /^Sources & reasoning/ })).toBeVisible({
        timeout: 30_000,
      });
      await expectNoHorizontalScroll(page);
      await expectReachable(page, composer(page));
      await expectVeirBadgeInView(page);
      // One bar on a phone: the conversation's header carries the menu, its title, and three icons (voice call,
      // video call, More); New chat and the context panel are in More, so the title keeps its room.
      const bar = page.locator('header').filter({ has: page.getByRole('heading', { level: 1 }) });
      await expect(page.locator('header:visible')).toHaveCount(1);
      await expectReachable(page, bar.getByRole('button', { name: 'Open navigation' }));
      // The mentor's name alone under the title: no vEIR badge.
      await expect(bar.locator('[data-slot="veir-name"]').filter({ visible: true })).toHaveText('Thomas');
      await expect(bar.locator('[data-slot="veir-badge"]')).toHaveCount(0);
      await expectReachable(page, bar.getByRole('link', { name: /^Voice call with / }));
      await expect(bar.getByRole('group', { name: 'Call' }).getByLabel(/^Video call with /)).toBeVisible();
      await expectReachable(page, page.getByRole('button', { name: 'Conversation options' }));
      await expect(
        bar.locator('[data-slot="header-actions"]').locator('a:visible, button:visible'),
      ).toHaveCount(3);
      await expect(bar.getByRole('link', { name: 'New chat' })).toHaveCount(0);

      // A citation opens the sources as a sheet.
      const chip = answer.getByRole('button', { name: /^Source 1: / }).first();
      await expectReachable(page, chip);
      await chip.click();
      const panel = page.getByRole('dialog', { name: 'Context' });
      await expect(panel.getByRole('tab', { name: 'Sources' })).toHaveAttribute('aria-selected', 'true');
      await expectReachable(page, panel.getByRole('tab', { name: 'Overview' }));
      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();

      // The panel also opens from More (with New chat), and the header opens the navigation sheet.
      await bar.getByRole('button', { name: 'Conversation options' }).click();
      const more = page.getByRole('menu');
      await expectReachable(page, more.getByRole('menuitem', { name: 'New chat' }));
      await more.getByRole('menuitem', { name: 'Show context panel' }).click();
      await expect(panel.getByRole('tab', { name: 'Sources' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();
      await page.getByRole('button', { name: 'Open navigation' }).click();
      await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible();
    });
  });
});
