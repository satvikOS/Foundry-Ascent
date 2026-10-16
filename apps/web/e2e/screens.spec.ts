import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, type Page } from '@playwright/test';

import {
  fillSecret,
  FOUNDER_STATE,
  issueAccessCodeViaApi,
  openVenture,
  OWNER_STATE,
  startConversation,
  TENANT,
  test,
  useTheme,
} from './support/fixtures';

/*
 * Screenshots of the main surfaces for design review (not a check: nothing here asserts on pixels).
 * Runs only as the `screens` project, which exists only when E2E_SCREENS_DIR is set:
 *
 *   E2E_SCREENS_DIR=<dir> E2E_SCREENS_PHASE=before|after playwright test --project=screens
 *
 * Files are named <surface>-<phase>-<desktop|mobile>-<light|dark>.png.
 */

const DIR = process.env.E2E_SCREENS_DIR ?? '';
const WRITE_HEADERS = { 'x-requested-with': 'foundry-ascent', 'content-type': 'application/json' };
/** The seeded EIR of QuietQuad: requests for "their EIR" are routed to him, and he reviews its samples. */
const CORIN = 'Corin Halvorsen';
const PHASE = process.env.E2E_SCREENS_PHASE ?? 'shot';

const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 } },
  mobile: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
} as const;

/** Sign in through the form on any viewport (on phones the account menu sits in the navigation sheet). */
async function signInWith(page: Page, code: string): Promise<void> {
  await page.goto('/sign-in');
  await fillSecret(page.getByRole('textbox', { name: 'Access code' }), code);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'));
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

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
            ['knowledge-notebook', 'knowledge?view=notebook'],
            ['knowledge-conversations', 'knowledge?view=conversations'],
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
          test.setTimeout(180_000);
          for (const [surface, path] of [
            ['studio', 'eir/personas'],
            ['studio-eirs', 'eir/eirs'],
            ['studio-lessons', 'eir/lessons'],
            ['program', 'program/portfolio'],
            ['program-ventures', 'program/ventures'],
            ['program-assignments', 'program/assignments'],
            ['program-resources', 'program/resources'],
            ['program-escalations', 'program/escalations'],
            ['admin', 'admin/principals'],
            ['admin-usage', 'admin/usage'],
            ['admin-settings', 'admin/settings'],
            ['admin-audit', 'admin/audit'],
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
          await page.goto(`/${TENANT}/app/admin/principals`);
          await page.getByRole('button', { name: 'Add principal' }).click();
          await expect(page.getByRole('dialog')).toBeVisible();
          await shoot(page, 'admin-dialog', device, scheme);
        });
      });

      test.describe('EIR', () => {
        test('inbox and calibration reviews, with work in them', async ({ page, browser }) => {
          test.setTimeout(180_000);
          // As the founder: two requests for their EIR, shared (so they are routed to Corin), and a
          // high-risk question (always sampled for Corin's calibration review).
          const founder = await browser.newContext({ storageState: FOUNDER_STATE });
          const founderPage = await founder.newPage();
          const ventureId = await openVenture(founderPage);
          for (const [category, priority, founderQuestion] of [
            ['ip_licensing', 'P1', 'Should we file a provisional patent before demo day?'],
            ['expert_judgment', 'P2', 'Is our pilot price too low for a library?'],
          ] as const) {
            const created = await founderPage.request.post(`/api/v1/ventures/${ventureId}/escalations`, {
              headers: WRITE_HEADERS,
              data: { category, priority, requestedRole: 'eir', founderQuestion },
            });
            expect(created.status(), 'POST /ventures/:id/escalations').toBe(201);
            const { id } = (await created.json()) as { id: string };
            const shared = await founderPage.request.patch(`/api/v1/escalations/${id}`, {
              headers: WRITE_HEADERS,
              data: { action: 'approve_sharing' },
            });
            expect(shared.status(), 'PATCH /escalations/:id approve_sharing').toBe(200);
          }
          await startConversation(founderPage, 'We need to file a provisional patent before demo day.');
          await expect(
            founderPage
              .getByRole('article', { name: 'Exchange 1' })
              .getByRole('button', { name: 'Copy answer' }),
          ).toBeVisible({ timeout: 30_000 });
          await founder.close();

          const owner = await browser.newContext({ storageState: OWNER_STATE });
          const code = await issueAccessCodeViaApi(owner.request, CORIN);
          await owner.close();
          await signInWith(page, code);
          await useTheme(page, scheme);

          for (const [surface, path, list] of [
            ['studio-inbox', 'eir/inbox', 'Open escalations'],
            ['studio-reviews', 'eir/reviews', 'Samples to review'],
          ] as const) {
            await page.goto(`/${TENANT}/app/${path}`);
            const rows = page.getByRole('navigation', { name: list }).getByRole('button');
            await expect(rows.first()).toHaveAttribute('aria-current', 'true');
            // Hover a second row, so the shot shows hover beside the selected row.
            if (device === 'desktop' && (await rows.count()) > 1) await rows.nth(1).hover();
            await shoot(page, surface, device, scheme);
          }
        });
      });
    });
  }
}
