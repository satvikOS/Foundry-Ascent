import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page } from '@playwright/test';

import { FOUNDER_STATE, openVenture, test, useTheme } from './support/fixtures';

/*
 * The OLED dark theme and where glass is used, as the browser renders them: a true-black canvas and
 * sidebar; floating layers (menus, the command palette) blurred glass; dialogs solid over a scrim; the
 * phone bar glass; no full-screen blur on phones. axe checks the contrast of text on the glass layers in
 * both themes (their structure is covered by a11y.spec.ts; Radix's modal focus handling is out of scope).
 */

const BLACK = 'rgb(0, 0, 0)';

function style(locator: Locator, property: 'backgroundColor' | 'backdropFilter'): Promise<string> {
  return locator.evaluate((element, name) => {
    const computed = getComputedStyle(element);
    // WebKit-prefixed in some builds; either carries the filter.
    if (name === 'backdropFilter') {
      return computed.backdropFilter || computed.getPropertyValue('-webkit-backdrop-filter');
    }
    return computed[name];
  }, property);
}

/** axe's colour-contrast rule (WCAG 2 AA) on what is on screen now. */
async function expectReadable(page: Page, label: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const results = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
  const failing = results.violations.flatMap((violation) =>
    violation.nodes.slice(0, 5).map((node) => `${node.target.join(' ')}: ${node.failureSummary ?? ''}`),
  );
  expect(failing, `${label}: text below WCAG AA contrast`).toEqual([]);
}

async function overlay(page: Page): Promise<Locator> {
  const scrim = page.locator('[data-slot$="-overlay"]').last();
  await expect(scrim).toBeVisible();
  return scrim;
}

test.describe('OLED dark and glass', () => {
  test.use({ storageState: FOUNDER_STATE });

  test('true black canvas and sidebar; glass menus and palette; solid dialogs', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await openVenture(page);
    await useTheme(page, 'dark');

    expect(await style(page.locator('body'), 'backgroundColor')).toBe(BLACK);
    expect(await style(page.getByRole('complementary', { name: 'Sidebar' }), 'backgroundColor')).toBe(BLACK);
    const themeColor = await page
      .locator('meta[name="theme-color"][media="(prefers-color-scheme: dark)"]')
      .getAttribute('content');
    expect(themeColor?.toLowerCase()).toBe('#000000');

    // A menu floats as glass, and its text passes axe on it.
    await page.getByRole('button', { name: /^Account menu for / }).click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    expect(await style(menu, 'backdropFilter')).toContain('blur(');
    await expectReadable(page, 'account menu (dark)');
    await page.keyboard.press('Escape');

    // The command palette is a glass panel over a scrim that only dims.
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.locator('[data-slot="dialog-content"][data-surface="glass"]');
    await expect(palette).toBeVisible();
    expect(await style(palette, 'backdropFilter')).toContain('blur(');
    expect(await style(await overlay(page), 'backdropFilter')).toBe('none');
    await expectReadable(page, 'command palette (dark)');
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();

    // A dialog is solid (it holds body text) over a blurred scrim.
    await page.keyboard.press('?');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();
    expect(await style(dialog, 'backdropFilter')).toBe('none');
    expect(await style(dialog, 'backgroundColor')).toBe('rgb(20, 20, 20)');
    expect(await style(await overlay(page), 'backdropFilter')).toContain('blur(');
    await expectReadable(page, 'shortcuts dialog (dark)');
  });

  test('light theme keeps its palette, and its glass passes axe', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await openVenture(page);
    await useTheme(page, 'light');
    expect(await style(page.locator('body'), 'backgroundColor')).toBe('rgb(250, 250, 249)');
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.locator('[data-slot="dialog-content"][data-surface="glass"]')).toBeVisible();
    await expectReadable(page, 'command palette (light)');
  });

  test.describe('phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test('the phone bar is glass, and modals do not blur the whole screen', async ({ page }) => {
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
      await openVenture(page);
      await useTheme(page, 'dark');
      const bar = page.locator('header[data-phone-bar]');
      await expect(bar).toBeVisible();
      expect(await style(bar, 'backdropFilter')).toContain('blur(');
      await page.getByRole('button', { name: 'Open navigation' }).click();
      await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible();
      expect(await style(await overlay(page), 'backdropFilter')).toBe('none');
    });
  });
});
