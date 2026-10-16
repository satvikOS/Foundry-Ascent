import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, type Page } from '@playwright/test';

import { FOUNDER_STATE, openVenture, OWNER_STATE, TENANT, test, useTheme } from './support/fixtures';

/*
 * Screenshots of the main surfaces for design review (not a check: nothing here asserts on pixels).
 * Runs only as the `screens` project, which exists only when E2E_SCREENS_DIR is set:
 *
 *   E2E_SCREENS_DIR=<dir> E2E_SCREENS_PHASE=before|after playwright test --project=screens
 *
 * Files are named <surface>-<phase>-<desktop|mobile>-<light|dark>.png.
 */

const DIR = process.env.E2E_SCREENS_DIR ?? '';
const PHASE = process.env.E2E_SCREENS_PHASE ?? 'shot';

const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 } },
  mobile: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
} as const;

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

async function shoot(page: Page, surface: string, device: string, scheme: string): Promise<void> {
  await settle(page);
  mkdirSync(DIR, { recursive: true });
  await page.screenshot({ path: join(DIR, `${surface}-${PHASE}-${device}-${scheme}.png`) });
}

for (const [device, options] of Object.entries(VIEWPORTS)) {
  for (const scheme of ['dark', 'light'] as const) {
    test.describe(`${device} · ${scheme}`, () => {
      test.use(options);
      test.beforeEach(async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      });

      test('public pages', async ({ page }) => {
        await page.goto('/');
        await useTheme(page, scheme);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await shoot(page, 'landing', device, scheme);
        await page.goto('/sign-in');
        await useTheme(page, scheme);
        await expect(page.getByRole('textbox', { name: 'Access code' })).toBeVisible();
        await shoot(page, 'sign-in', device, scheme);
      });

      test.describe('founder', () => {
        test.use({ storageState: FOUNDER_STATE });

        test('venture pages', async ({ page }) => {
          const ventureId = await openVenture(page);
          await useTheme(page, scheme);
          await shoot(page, 'venture-home', device, scheme);
          if (device === 'mobile') {
            await page.getByRole('button', { name: 'Open navigation' }).click();
            await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible();
            await shoot(page, 'shell-nav', device, scheme);
            await page.keyboard.press('Escape');
          } else {
            await page.keyboard.press('ControlOrMeta+k');
            await expect(page.getByRole('dialog').first()).toBeVisible();
            await shoot(page, 'shell-palette', device, scheme);
            await page.keyboard.press('Escape');
            await page.getByRole('button', { name: /^Account menu for / }).click();
            await expect(page.getByRole('menu')).toBeVisible();
            await shoot(page, 'shell-menu', device, scheme);
            await page.keyboard.press('Escape');
          }
          for (const [surface, path] of [
            ['knowledge', 'knowledge'],
            ['team', 'team'],
            ['help', 'help'],
            ['venture-settings', 'settings'],
          ] as const) {
            await page.goto(`/${TENANT}/app/v/${ventureId}/${path}`);
            await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
            await shoot(page, surface, device, scheme);
          }
        });
      });

      test.describe('staff', () => {
        test.use({ storageState: OWNER_STATE });

        test('studio, program and admin', async ({ page }) => {
          test.setTimeout(120_000);
          for (const [surface, path] of [
            ['studio', 'eir/personas'],
            ['studio-eirs', 'eir/eirs'],
            ['program', 'program/portfolio'],
            ['program-ventures', 'program/ventures'],
            ['admin', 'admin/principals'],
            ['admin-usage', 'admin/usage'],
            ['admin-settings', 'admin/settings'],
          ] as const) {
            await page.goto(`/${TENANT}/app/${path}`);
            if (surface === 'studio') await useTheme(page, scheme);
            await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
            await shoot(page, surface, device, scheme);
          }
          await page.goto(`/${TENANT}/app/eir/personas`);
          await page
            .getByRole('main')
            .getByRole('link', { name: /['’]s vEIR$/ })
            .first()
            .click();
          await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
          await shoot(page, 'studio-persona', device, scheme);
        });
      });
    });
  }
}
