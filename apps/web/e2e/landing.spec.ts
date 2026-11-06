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
    // The phone's timeline draws each turn in its speaker's token colour (resolved under reduced motion too).
    const drawn = await ad(page)
      .locator('.fa-timeline')
      .evaluate((timeline) => {
        const canvas = timeline.querySelector('canvas');
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return null;
        const ratio = canvas.width / canvas.clientWidth;
        const probe = document.createElement('span');
        probe.style.transitionProperty = 'none';
        timeline.append(probe);
        const results = [...timeline.querySelectorAll<HTMLElement>('[data-turn]')].map((turn) => {
          const x = Math.round((parseFloat(turn.style.left) + parseFloat(turn.style.width) / 2) * ratio);
          const [r, g, b] = ctx.getImageData(x, Math.round(2 * ratio), 1, 1).data;
          probe.style.color = `var(--tl-${turn.dataset.speaker ?? ''})`;
          return {
            pixel: `rgb(${String(r)}, ${String(g)}, ${String(b)})`,
            token: getComputedStyle(probe).color,
          };
        });
        probe.remove();
        return results;
      });
    expect(drawn?.length).toBeGreaterThanOrEqual(2);
    for (const { pixel, token } of drawn ?? []) expect(pixel).toBe(token);
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

  test('keeps the devices and their screens in forced colours, as outlines in system colours', async ({
    page,
  }) => {
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(ad(page).getByText('Fair. We finish the pilot, then we raise.')).toBeAttached();
    for (const frame of ['.ad-laptop__lid', '.ad-phone']) {
      const box = page.locator(`[data-slot="device-ad"] ${frame}`).first();
      await expect(box).toBeVisible();
      const border = await box.evaluate((element) => {
        const style = getComputedStyle(element);
        return { width: style.borderTopWidth, style: style.borderTopStyle };
      });
      expect(border, `${frame} has a visible outline`).toEqual({ width: '1px', style: 'solid' });
    }
    // The product UI is still there: the answer's text renders inside the laptop's screen.
    await expect(page.locator('[data-slot="device-ad"] .ad-screen').first()).toBeVisible();
  });

  test('says what Thomas is under the hero, and how the EIR made him, without claiming each answer', async ({
    page,
  }) => {
    await page.goto('/');
    const note = page.getByRole('main').getByRole('note', { name: 'AI disclosure' });
    await expect(note).toContainText('Thomas is an AI mentor, not a person.');
    await note.getByRole('button', { name: 'More of the AI disclosure' }).press('Enter');
    await expect(note).toContainText('released after their review');
    await expect(note).not.toContainText(/wrote or approved|never speaks for/);
    await expect(page.getByRole('main')).not.toContainText('vEIR');
  });

  test('lays a still colour streak across the ground, and drops it in forced colours', async ({ page }) => {
    await page.goto('/');
    const streaks = page.locator('[data-slot="streak"]');
    await page.locator('#for-students').scrollIntoViewIfNeeded();
    await expect(streaks).toHaveCount(2);
    for (const streak of await streaks.all()) {
      await expect(streak).toHaveAttribute('aria-hidden', 'true');
      const band = streak.locator('.l-streak');
      expect(await band.evaluate((node) => getComputedStyle(node).animationName)).toBe('none');
    }
    await expectNoHorizontalScroll(page);
    await page.emulateMedia({ forcedColors: 'active' });
    for (const streak of await streaks.all()) {
      expect(await streak.evaluate((node) => getComputedStyle(node).display)).toBe('none');
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

  test('keeps its own type: Newsreader and Geist, the phone menu included, and leaves Inter to the platform', async ({
    page,
  }) => {
    const fonts: { file: string; at: number }[] = [];
    const start = Date.now();
    page.on('request', (request) => {
      const file = new URL(request.url()).pathname.split('/').pop() ?? '';
      if (file.endsWith('.woff2')) fonts.push({ file, at: Date.now() - start });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('someone who remembers');
    await page.waitForLoadState('networkidle');
    // The platform's face is not preloaded here (it competed with Newsreader, which the hero waits for), and its
    // italic never loads (the device ad's pictures of the platform draw Inter from its upright file only).
    expect(await page.locator('link[rel="preload"][as="font"]').count()).toBe(0);
    const first = (name: string) => fonts.find((font) => font.file.startsWith(name))?.at ?? Infinity;
    expect(first('newsreader-latin-wght-normal')).toBeLessThan(Infinity);
    expect(first('inter-latin-wght-normal'), 'Inter only after the hero’s face').toBeGreaterThanOrEqual(
      first('newsreader-latin-wght-normal'),
    );
    expect(fonts.filter((font) => font.file.startsWith('inter-latin-wght-italic'))).toEqual([]);
    expect(
      await page.getByRole('heading', { level: 1 }).evaluate((h) => getComputedStyle(h).fontFamily),
    ).toMatch(/^"Newsreader Variable"/);
    // The phone menu is portalled out of the page's scope, and keeps its type.
    await page.getByRole('button', { name: 'Open menu' }).click();
    const link = page
      .getByRole('dialog')
      .getByRole('navigation', { name: 'Page sections' })
      .getByRole('link')
      .first();
    await expect(link).toBeVisible();
    expect(await link.evaluate((a) => getComputedStyle(a).fontFamily)).toMatch(/^"Geist Variable"/);
  });
});
