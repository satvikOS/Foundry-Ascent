import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, type Locator, type Page } from '@playwright/test';

import {
  composer,
  expectNoHorizontalScroll,
  FOUNDER_NAME,
  FOUNDER_STATE,
  openVenture,
  OWNER_STATE,
  setFaceAccess,
  setFacesEnabled,
  startConversation,
  TENANT,
  test,
  useTheme,
} from './support/fixtures';

/*
 * Every main screen at the sizes people use (owner, 2026-11-05: "phones, iPads, laptops, monitors, screens of
 * multiple resolutions"): phones, iPads both ways, laptops, desktop monitors and an ultrawide. At each size the
 * page never scrolls sideways, nothing runs past the right edge, the text column keeps a readable measure on wide
 * screens, touch sizes give primary controls at least 44 px, and on a phone the composer stays in view while
 * typing (the on-screen keyboard modelled as the visual viewport shrinking).
 *
 * The check runs a representative set in the suite (`responsive` in the desktop project's list). With
 * E2E_RESPONSIVE_DIR=<dir> it walks every size in light and dark and saves <screen>-<size>-<scheme>.png there
 * for design review (E2E_RESPONSIVE_SIZES=360x740,1440x900 narrows it).
 */

const DIR = process.env.E2E_RESPONSIVE_DIR ?? '';
const WRITE_HEADERS = { 'x-requested-with': 'foundry-ascent', 'content-type': 'application/json' };

interface Size {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** A touch screen (phones and iPads): coarse pointer, no hover. */
  readonly touch: boolean;
  readonly mobile: boolean;
}

const ALL_SIZES: readonly Size[] = [
  { name: '360x740', width: 360, height: 740, touch: true, mobile: true },
  { name: '390x844', width: 390, height: 844, touch: true, mobile: true },
  { name: '430x932', width: 430, height: 932, touch: true, mobile: true },
  { name: '768x1024', width: 768, height: 1024, touch: true, mobile: false },
  { name: '834x1194', width: 834, height: 1194, touch: true, mobile: false },
  { name: '1024x768', width: 1024, height: 768, touch: true, mobile: false },
  { name: '1366x1024', width: 1366, height: 1024, touch: true, mobile: false },
  { name: '1280x800', width: 1280, height: 800, touch: false, mobile: false },
  { name: '1440x900', width: 1440, height: 900, touch: false, mobile: false },
  { name: '1920x1080', width: 1920, height: 1080, touch: false, mobile: false },
  { name: '2560x1440', width: 2560, height: 1440, touch: false, mobile: false },
  { name: '3440x1440', width: 3440, height: 1440, touch: false, mobile: false },
];

/** The suite's representative set: the smallest phone, an iPad each way, a laptop and the ultrawide. */
const CHECKED = new Set(['360x740', '768x1024', '1024x768', '1440x900', '3440x1440']);

function sizes(): readonly Size[] {
  const only = (process.env.E2E_RESPONSIVE_SIZES ?? '')
    .split(',')
    .map((size) => size.trim())
    .filter(Boolean);
  if (only.length > 0) return ALL_SIZES.filter((size) => only.includes(size.name));
  return DIR ? ALL_SIZES : ALL_SIZES.filter((size) => CHECKED.has(size.name));
}

const SCHEMES = DIR ? (['dark', 'light'] as const) : (['dark'] as const);

/** A tab that has seen no click: a call opened by its URL waits on its start screen instead of starting at once. */
async function noUserActivation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userActivation', {
      configurable: true,
      value: { hasBeenActive: false, isActive: false },
    });
  });
}

/**
 * Safari's on-screen keyboard, emulated: a visual viewport the page can shrink (`window.__keyboard(height)`) while
 * the layout viewport keeps its size, firing `resize` as the browser does. Chromium's own visual viewport cannot be
 * shrunk without resizing the layout viewport too, which is not what a phone's keyboard does.
 */
async function emulateOverlayKeyboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), {
      width: window.innerWidth,
      height: window.innerHeight,
      offsetTop: 0,
      offsetLeft: 0,
      pageTop: 0,
      pageLeft: 0,
      scale: 1,
      onresize: null,
      onscroll: null,
      onscrollend: null,
    });
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => viewport });
    (window as unknown as { __keyboard: (height: number) => void }).__keyboard = (height) => {
      viewport.height = height;
      viewport.dispatchEvent(new Event('resize'));
    };
  });
}

/** A call left open elsewhere (an earlier run) is moved here, so this one starts from its start screen. */
async function takeOverCall(call: Locator): Promise<void> {
  const start = call.getByRole('button', { name: 'Start call' });
  const move = call.getByRole('button', { name: 'Move here, ending the other call' });
  await expect(start.or(move).first()).toBeVisible({ timeout: 15_000 });
  // The start screen can show before the call settings say another call is open.
  await call.page().waitForTimeout(800);
  if (await move.isVisible()) await move.click();
}

/**
 * The call's buttons a person taps, less the timeline's segments: each is as wide as the turn it stands for, and
 * what it does (jump to that turn) the transcript does too.
 */
function callControls(call: Locator): Locator {
  return call.locator('button:not([aria-label="Conversation timeline"] *)');
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  // Entrance transitions (panels, dialogs) finish before a shot or a measurement.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => null)),
    ).then(() => undefined),
  );
}

/** Check the screen at this size and, when asked, save it in each scheme. */
async function screen(page: Page, size: Size, name: string, options: { fullPage?: boolean } = {}) {
  await settle(page);
  await expectNoHorizontalScroll(page);
  if (!DIR) return;
  mkdirSync(DIR, { recursive: true });
  for (const scheme of SCHEMES) {
    await useTheme(page, scheme);
    await settle(page);
    await page.screenshot({
      path: join(DIR, `${name}-${size.name}-${scheme}.png`),
      fullPage: options.fullPage ?? false,
    });
  }
  await useTheme(page, 'dark');
}

/**
 * The right panel (when shown) fits the screen below whatever sits above the page (the mini call bar, a status
 * banner), 12 px in from the bottom like the left panel, and a page shorter than the screen does not scroll.
 */
async function expectPanelsFit(page: Page, options: { pageFits?: boolean } = {}): Promise<void> {
  const measure = () =>
    page.evaluate(() => {
      const panel = document.querySelector('[data-slot="context-panel"]')?.getBoundingClientRect() ?? null;
      const side = document.querySelector('[data-slot="side-panel"]')?.getBoundingClientRect() ?? null;
      return {
        inner: window.innerHeight,
        scroll: document.documentElement.scrollHeight,
        panelBottom: panel ? Math.round(panel.bottom) : null,
        sideBottom: side ? Math.round(side.bottom) : null,
      };
    });
  // The banners' height reaches the panel through a ResizeObserver: measured once the layout has caught up.
  await expect
    .poll(
      async () => {
        const fit = await measure();
        return fit.panelBottom !== null && fit.panelBottom <= fit.inner - 12;
      },
      { message: 'the right panel is shown and ends 12 px above the bottom' },
    )
    .toBe(true);
  const fit = await measure();
  if (fit.sideBottom !== null) expect(fit.panelBottom).toBe(fit.sideBottom);
  if (options.pageFits) expect(fit.scroll, 'the page does not scroll by the banner').toBe(fit.inner);
}

/** Controls narrower or shorter than 44 px among these (touch sizes only). */
async function smallTargets(scope: Locator): Promise<string[]> {
  return scope.evaluateAll((elements) =>
    elements
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        // The hit area is the element's box, grown by an ::after hit slop when it has one.
        const after = getComputedStyle(element, '::after');
        const slop =
          after.content !== 'none' && after.position === 'absolute'
            ? Math.max(0, -parseFloat(after.top) || 0) + Math.max(0, -parseFloat(after.bottom) || 0)
            : 0;
        const slopX =
          after.content !== 'none' && after.position === 'absolute'
            ? Math.max(0, -parseFloat(after.left) || 0) + Math.max(0, -parseFloat(after.right) || 0)
            : 0;
        return {
          label: element.getAttribute('aria-label') ?? element.textContent.trim().slice(0, 30),
          width: rect.width + slopX,
          height: rect.height + slop,
        };
      })
      .filter((target) => target.width < 43.5 || target.height < 43.5)
      .map((target) => `${target.label} ${Math.round(target.width)}x${Math.round(target.height)}`),
  );
}

/** The text column's widest paragraph: never a stretched line on a wide screen (about 80 characters at most). */
async function widestProse(page: Page, selector: string): Promise<number> {
  return page
    .locator(selector)
    .evaluateAll((elements) =>
      Math.max(0, ...elements.map((element) => element.getBoundingClientRect().width)),
    );
}

for (const size of sizes()) {
  test.describe(`responsive · ${size.name}`, () => {
    test.use({
      viewport: { width: size.width, height: size.height },
      hasTouch: size.touch,
      isMobile: size.mobile,
      deviceScaleFactor: 1,
    });
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    });

    test('public pages', async ({ page }) => {
      await page.goto('/');
      await useTheme(page, 'dark');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await screen(page, size, 'landing');
      if (DIR) {
        // The whole page once (its sections, the device ad and the footer), lazy parts loaded.
        await page.evaluate(async () => {
          for (let y = 0; y < document.documentElement.scrollHeight; y += window.innerHeight / 2) {
            window.scrollTo(0, y);
            await new Promise((resolve) => setTimeout(resolve, 60));
          }
          window.scrollTo(0, 0);
        });
        await screen(page, size, 'landing-full', { fullPage: true });
      }
      const menu = page.getByRole('button', { name: 'Open menu' });
      if (await menu.isVisible()) {
        await menu.click();
        await expect(
          page.getByRole('dialog').getByRole('navigation', { name: 'Page sections' }),
        ).toBeVisible();
        await screen(page, size, 'landing-menu');
        await page.keyboard.press('Escape');
      }
      await page.goto('/sign-in');
      await expect(page.getByRole('textbox', { name: 'Access code' })).toBeVisible();
      await screen(page, size, 'sign-in');
    });

    test.describe('founder', () => {
      test.use({ storageState: FOUNDER_STATE });

      test('New chat, a conversation with both panels, and the venture pages', async ({ page }) => {
        test.setTimeout(180_000);
        if (size.mobile) await emulateOverlayKeyboard(page);
        const ventureId = await openVenture(page);
        await screen(page, size, 'new-chat');
        if (size.width >= 1280) {
          // With a status banner over the page, the right panel still fits the screen (12 px in from its bottom)
          // and the page does not scroll by the banner's height.
          await page.context().setOffline(true);
          await expect(page.locator('[data-slot="status-banners"]')).toContainText('You’re offline.');
          await settle(page);
          await expectPanelsFit(page, { pageFits: true });
          await screen(page, size, 'new-chat-banner');
          await page.context().setOffline(false);
          await expect(page.locator('[data-slot="status-banners"]')).not.toContainText('You’re offline.');
        }
        if (size.touch) {
          const main = page.getByRole('main');
          expect(await smallTargets(main.getByRole('button', { name: /^Send/ }))).toEqual([]);
        }

        // The navigation: a sheet on phones, the rail or the floating panel elsewhere.
        const openNav = page.getByRole('button', { name: 'Open navigation' });
        if (await openNav.isVisible()) {
          await openNav.click();
          const nav = page.getByRole('dialog', { name: 'Navigation' });
          await expect(nav).toBeVisible();
          if (size.touch) expect(await smallTargets(nav.getByRole('link'))).toEqual([]);
          await screen(page, size, 'nav');
          await page.keyboard.press('Escape');
          await expect(nav).toBeHidden();
        }

        await startConversation(page, 'What should our two-library pilot prove first?');
        const answer = page.getByRole('article', { name: 'Exchange 1' });
        await expect(answer.getByRole('button', { name: 'Copy answer' })).toBeVisible({ timeout: 30_000 });
        const box = composer(page);
        await expect(box).toBeVisible();
        // Both panels where the screen has room for them: the conversation keeps a readable measure.
        if (size.width >= 1280) {
          await expect(page.locator('[data-slot="context-panel"]')).toBeVisible();
          expect(await widestProse(page, 'main article p')).toBeLessThanOrEqual(760);
        }
        await screen(page, size, 'conversation');
        if (size.touch) {
          expect(
            await smallTargets(
              page.locator('[data-slot="call-buttons"] a, [data-slot="call-buttons"] button'),
            ),
          ).toEqual([]);
        }

        // The context panel as a sheet on smaller screens.
        const show = page
          .getByRole('button', { name: 'Show context panel' })
          .filter({ visible: true })
          .first();
        if ((await show.count()) > 0 && (await show.isVisible())) {
          await show.click();
          const sheet = page
            .locator('[data-slot="context-sheet"], [data-slot="context-panel"]')
            .filter({ visible: true })
            .first();
          await expect(sheet).toBeVisible();
          await screen(page, size, 'conversation-context');
          await page.keyboard.press('Escape');
        }

        if (size.mobile) {
          // The on-screen keyboard as Safari lays it over the page: only the visual viewport shrinks (the layout
          // viewport keeps its height), and use-keyboard-inset.ts docks the composer above it.
          const visible = Math.round(size.height * 0.55);
          await box.click();
          await page.evaluate((height) => {
            (window as unknown as { __keyboard: (h: number) => void }).__keyboard(height);
          }, visible);
          await box.fill('A first line');
          await expect
            .poll(() =>
              page.evaluate(() =>
                getComputedStyle(document.documentElement).getPropertyValue('--keyboard-inset').trim(),
              ),
            )
            .toBe(`${String(size.height - visible)}px`);
          expect(await page.evaluate(() => window.innerHeight), 'the layout viewport keeps its height').toBe(
            size.height,
          );
          await settle(page);
          const rect = await box.boundingBox();
          expect(rect, 'composer box').not.toBeNull();
          if (rect) expect(rect.y + rect.height).toBeLessThanOrEqual(visible + 0.5);
          await screen(page, size, 'conversation-keyboard');
          await box.fill('');
          await page.evaluate((height) => {
            (window as unknown as { __keyboard: (h: number) => void }).__keyboard(height);
          }, size.height);
          await expect
            .poll(() =>
              page.evaluate(() =>
                getComputedStyle(document.documentElement).getPropertyValue('--keyboard-inset').trim(),
              ),
            )
            .toBe('0px');
        }

        for (const [name, path] of [
          ['knowledge', 'knowledge'],
          ['documents', 'documents'],
          ['help', 'help'],
          ['venture', 'settings'],
        ] as const) {
          await page.goto(`/${TENANT}/app/v/${ventureId}/${path}`);
          await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
          await screen(page, size, name);
        }
      });

      test('voice call: before, live, settings and the review after', async ({ page }) => {
        test.setTimeout(150_000);
        const notice = await page.request.post('/api/v1/calls/notice/acknowledge', {
          headers: WRITE_HEADERS,
        });
        expect(notice.status(), 'POST /calls/notice/acknowledge').toBe(200);
        // No synthesis on this server: the vEIR's lines play a short silent clip, so the call moves on.
        await page.route('**/api/v1/speech', (route) =>
          route.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav() }),
        );
        await noUserActivation(page);
        await openVenture(page);
        await startConversation(page, 'Which library should we pilot with first?');
        await expect(
          page.getByRole('article', { name: 'Exchange 1' }).getByRole('button', { name: 'Copy answer' }),
        ).toBeVisible({ timeout: 30_000 });
        await page.goto(`${page.url()}?call=voice`);
        const call = page.getByRole('dialog', { name: /^Voice call with / });
        const start = call.getByRole('button', { name: 'Start call' });
        await takeOverCall(call);
        await expect(start).toBeVisible();
        await screen(page, size, 'voice-call-before');
        if (size.touch) expect(await smallTargets(call.getByRole('button'))).toEqual([]);
        await start.click();
        // Still open elsewhere (an earlier run): move it here.
        const move = call.getByRole('button', { name: 'Move here, ending the other call' });
        await page.waitForTimeout(800);
        if (await move.isVisible()) await move.click();
        const end = call.getByRole('button', { name: 'End call' });
        try {
          const reply = call.getByRole('textbox', { name: /^Reply to / });
          await expect(reply.or(call.getByRole('button', { name: /^(Mute|Unmute)/ })).first()).toBeVisible({
            timeout: 20_000,
          });
          await screen(page, size, 'voice-call-live');
          if (size.touch) expect(await smallTargets(callControls(call))).toEqual([]);
          if (size.width >= 1280) {
            // Minimized over the conversation, with a status banner too: the right panel still fits the screen.
            await call.getByRole('button', { name: 'Minimize call' }).click();
            const bar = page.getByRole('region', { name: /^Call with / });
            await expect(bar).toBeVisible();
            await page.context().setOffline(true);
            await expect(page.locator('[data-slot="status-banners"]')).toContainText('You’re offline.');
            await settle(page);
            await expectPanelsFit(page);
            await screen(page, size, 'voice-call-minimized-banner');
            await page.context().setOffline(false);
            await expect(page.locator('[data-slot="status-banners"]')).not.toContainText('You’re offline.');
            await bar.getByRole('button', { name: 'Return to call' }).click();
            await expect(call).toBeVisible();
          }
          await call.getByRole('button', { name: 'Call settings' }).click();
          const settings = page.getByRole('dialog', { name: 'Call settings' });
          await expect(settings).toBeVisible();
          await screen(page, size, 'voice-call-settings');
          if (size.touch) expect(await smallTargets(settings.getByRole('button'))).toEqual([]);
          await page.keyboard.press('Escape');
          await expect(settings).toBeHidden();
        } finally {
          // Never leave the call open for the next test (it ends once its few seconds of Undo have passed).
          const minimized = page.getByRole('region', { name: /^Call with / });
          if (await minimized.isVisible())
            await minimized.getByRole('button', { name: 'Return to call' }).click();
          if (await end.isVisible()) {
            await end.click();
            await expect(page.getByRole('region', { name: 'Call ended' })).toBeVisible({ timeout: 20_000 });
          }
        }
        const review = page.getByRole('region', { name: 'Call ended' });
        await expect(review).toBeVisible({ timeout: 20_000 });
        await review.scrollIntoViewIfNeeded();
        await screen(page, size, 'call-review');
      });

      test('the disclosure before a first call', async ({ page }) => {
        await openVenture(page);
        await page.evaluate(() => {
          for (const key of Object.keys(window.localStorage)) {
            if (key.startsWith('fa.call.disclosure.')) window.localStorage.removeItem(key);
          }
        });
        await page
          .locator('[data-slot="new-chat-corner"]')
          .getByRole('link', { name: /^Voice call with / })
          .click();
        const disclosure = page.locator('[data-slot="call-disclosure"]');
        await expect(disclosure).toBeVisible();
        await screen(page, size, 'call-disclosure');
        if (size.touch) expect(await smallTargets(disclosure.getByRole('button'))).toEqual([]);
        await disclosure.getByRole('button', { name: 'Cancel' }).click();
      });
    });

    test.describe('owner', () => {
      test.use({ storageState: OWNER_STATE });

      test('admin', async ({ page }) => {
        for (const [name, path] of [
          ['admin', 'admin/principals'],
          ['admin-settings', 'admin/settings'],
          ['studio', 'eir/personas'],
          ['program', 'program/portfolio'],
        ] as const) {
          await page.goto(`/${TENANT}/app/${path}`);
          await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
          await screen(page, size, name);
        }
      });
    });
  });
}

// A video call with the development stand-in face (faces ship off: switched on for this and off again), on a phone
// (touch, mobile viewport) in the suite; with E2E_RESPONSIVE_DIR it is also shot at every size. e2e/video-calls.spec.ts
// checks the face itself.
const PHONE = ALL_SIZES.find((size) => size.name === '390x844') ?? ALL_SIZES[0];
test.describe('responsive · video call', () => {
  test.use({
    storageState: FOUNDER_STATE,
    viewport: { width: PHONE?.width ?? 390, height: PHONE?.height ?? 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 1,
  });

  test('before and live, on a phone (and at every size for review)', async ({ page, baseURL }) => {
    test.setTimeout(300_000);
    if (!baseURL || !PHONE) throw new Error('baseURL is required');
    await setFacesEnabled(baseURL, true);
    await setFaceAccess(baseURL, FOUNDER_NAME, true);
    try {
      const notice = await page.request.post('/api/v1/calls/notice/acknowledge', { headers: WRITE_HEADERS });
      expect(notice.status(), 'POST /calls/notice/acknowledge').toBe(200);
      await page.route('**/api/v1/speech', (route) =>
        route.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav() }),
      );
      await noUserActivation(page);
      await openVenture(page);
      await startConversation(page, 'Can we talk through the pilot price?');
      await expect(
        page.getByRole('article', { name: 'Exchange 1' }).getByRole('button', { name: 'Copy answer' }),
      ).toBeVisible({ timeout: 30_000 });
      const url = page.url();
      await page.goto(`${url}?call=video`);
      const call = page.getByRole('dialog', { name: /^Video call with / });
      await takeOverCall(call);
      await expect(call.getByRole('button', { name: 'Start call' })).toBeVisible();
      await screen(page, PHONE, 'video-call-before');
      expect(await smallTargets(call.getByRole('button'))).toEqual([]);
      for (const size of DIR ? sizes().filter((s) => s !== PHONE) : []) {
        await page.setViewportSize({ width: size.width, height: size.height });
        await screen(page, size, 'video-call-before');
      }
      await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
      await call.getByRole('button', { name: 'Start call' }).click();
      const tile = call.locator('[data-slot="call-tile"][data-face="video"]');
      await expect(tile).toBeVisible({ timeout: 30_000 });
      // The face fits the phone, labelled for what it is, and every control is a full touch target.
      await expect(tile.locator('[data-slot="call-ai-avatar-label"]')).toHaveText('AI avatar');
      const box = await tile.locator('[data-slot="call-face"]').boundingBox();
      expect(box, 'the face').not.toBeNull();
      if (box) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width + 0.5);
      }
      await screen(page, PHONE, 'video-call-live');
      expect(await smallTargets(callControls(call))).toEqual([]);
      for (const size of DIR ? sizes().filter((s) => s !== PHONE) : []) {
        await page.setViewportSize({ width: size.width, height: size.height });
        await page.waitForTimeout(250);
        await screen(page, size, 'video-call-live');
      }
      await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
      await call.getByRole('button', { name: 'End call' }).click();
      await expect(page.getByRole('region', { name: 'Call ended' })).toBeVisible({ timeout: 20_000 });
    } finally {
      await setFaceAccess(baseURL, FOUNDER_NAME, false);
      await setFacesEnabled(baseURL, false);
    }
  });
});

/** Half a second of silence as 16-bit mono WAV (the vEIR's line "plays", silently, and the call moves on). */
function silentWav(seconds = 0.5, rate = 24_000): Buffer {
  const samples = Math.round(seconds * rate);
  const data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + samples * 2, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(samples * 2, 40);
  return data;
}
