import { expect, type Page } from '@playwright/test';

import { expectNoHorizontalScroll, test } from './support/fixtures';

/*
 * The public landing page's device ad (components/landing/device-ad): the app's real components play a synthetic
 * session inside CSS device frames. It loads on its own, asks the API for nothing, plays only while on screen,
 * rests on its final frame under reduced motion, and stays out of the keyboard's way.
 */

test.use({ storageState: { cookies: [], origins: [] } });

const ad = (page: Page) => page.locator('[data-slot="device-ad"]');
const adTime = async (page: Page) => Number(await ad(page).getAttribute('data-t'));

test.describe('landing page device ad', () => {
  test('plays the session from the app’s own components, asks the API nothing, and pauses off screen', async ({
    page,
  }) => {
    const fromAd: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/') && url.pathname !== '/api/v1/health') fromAd.push(url.pathname);
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('someone who remembers');
    await expect(ad(page)).toHaveAttribute('inert', '');
    await expect(ad(page)).toHaveAttribute('aria-hidden', 'true');
    await expect(page.getByRole('img', { name: /^A synthetic example/ })).toBeVisible();
    // It plays: the founder's question is typed into the real composer, then answered.
    await expect.poll(() => adTime(page), { timeout: 10_000 }).toBeGreaterThan(2_500);
    await expect(ad(page).getByText('Should we raise now or finish the paid pilot?').first()).toBeAttached();
    // Scrolled away, it stops.
    await page.locator('#trust').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const paused = await adTime(page);
    await page.waitForTimeout(1_000);
    expect(await adTime(page)).toBe(paused);
    expect(fromAd).toEqual([]);
  });

  test('rests on its final frame under reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(ad(page).getByText(/Saved to Knowledge/)).toBeAttached();
    await expect(ad(page).getByText('Fair. We finish the pilot, then we raise.')).toBeAttached();
    const final = await adTime(page);
    await page.waitForTimeout(800);
    expect(await adTime(page)).toBe(final);
  });

  test('keeps the keyboard on the page: nothing inside the ad takes focus', async ({ page }) => {
    await page.goto('/');
    await expect(ad(page)).toBeAttached();
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab');
      const inAd = await page.evaluate(() =>
        Boolean(document.activeElement?.closest('[data-slot="device-ad"]')),
      );
      expect(inAd, `tab stop ${String(i + 1)} is outside the ad`).toBe(false);
    }
  });

  test('follows a section link from the bar, and nothing scrolls sideways', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('navigation', { name: 'Page sections' })
      .getByRole('link', { name: 'Trust' })
      .click();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Built to be trusted with early ideas' }),
    ).toBeInViewport();
    await expectNoHorizontalScroll(page);
  });
});
