import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page } from '@playwright/test';

import { FOUNDER_STATE, openVenture, OWNER_STATE, TENANT, test, useTheme } from './support/fixtures';

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

type Rgba = [number, number, number, number];

/**
 * A colour as the browser renders it: any computed CSS colour (rgb, oklab, color-mix…) drawn on a 1×1
 * canvas and read back as sRGB bytes, with its alpha.
 */
function rendered(locator: Locator, property: 'backgroundColor', pseudo?: '::before'): Promise<Rgba> {
  return locator.evaluate(
    (element, [name, pseudoElement]) => {
      const css = getComputedStyle(element, pseudoElement ?? null)[name];
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('No 2D canvas');
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255] as Rgba;
    },
    [property, pseudo] as const,
  );
}

/** Source-over: a (possibly translucent) colour on an opaque one. */
function over([r, g, b, a]: Rgba, [br, bg, bb]: Rgba): Rgba {
  const mix = (top: number, bottom: number) => top * a + bottom * (1 - a);
  return [mix(r, br), mix(g, bg), mix(b, bb), 1];
}

/** WCAG 2 contrast ratio of two opaque colours. */
function contrast(x: Rgba, y: Rgba): number {
  const luminance = ([r, g, b]: Rgba) => {
    const channel = (value: number) => {
      const c = value / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const WRITE_HEADERS = { 'x-requested-with': 'foundry-ascent', 'content-type': 'application/json' };

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

test.describe('selection reads in both themes', () => {
  test.use({ storageState: FOUNDER_STATE });

  for (const scheme of ['light', 'dark'] as const) {
    test(`the open help request and the pressed filter stand out from hover (${scheme})`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      const ventureId = await openVenture(page);
      // Two requests, so there is a row besides the selected one (drafts: nothing is shared or routed).
      for (const question of ['Who should review the pilot contract?', 'Can someone check our pricing?']) {
        const created = await page.request.post(`/api/v1/ventures/${ventureId}/escalations`, {
          headers: WRITE_HEADERS,
          data: { category: 'other', priority: 'P3', requestedRole: 'eir', founderQuestion: question },
        });
        expect(created.status(), 'POST /ventures/:id/escalations').toBe(201);
      }
      await page.goto(`/${TENANT}/app/v/${ventureId}/help`);
      await useTheme(page, scheme);
      const canvas = await rendered(page.locator('body'), 'backgroundColor');

      const list = page.getByRole('list', { name: 'Help requests' });
      const selected = list.locator('[aria-current="true"]');
      await expect(selected).toHaveCount(1);
      const other = list.getByRole('button').and(list.locator(':not([aria-current])')).first();
      await other.hover();

      // The selected row's bar, against its own fill and the page: ≥ 3:1 (WCAG 1.4.11).
      const bar = await rendered(selected, 'backgroundColor', '::before');
      const barWidth = await selected.evaluate((el) => parseFloat(getComputedStyle(el, '::before').width));
      expect(barWidth, 'the selected row carries a bar').toBeGreaterThanOrEqual(2);
      const selectedFill = over(await rendered(selected, 'backgroundColor'), canvas);
      expect(contrast(over(bar, selectedFill), selectedFill)).toBeGreaterThanOrEqual(3);
      expect(contrast(over(bar, canvas), canvas)).toBeGreaterThanOrEqual(3);
      // A hovered row is only tinted: it never draws the bar.
      expect((await rendered(other, 'backgroundColor', '::before'))[3], 'no bar on hover').toBe(0);

      // The pressed filter option against a hovered one: ≥ 3:1, so hover never looks pressed.
      const filter = page.getByRole('group', { name: 'Show requests' });
      const pressed = filter.getByRole('button', { pressed: true });
      const unpressed = filter.getByRole('button', { pressed: false }).first();
      await unpressed.hover();
      const pressedFill = over(await rendered(pressed, 'backgroundColor'), canvas);
      const hoveredFill = over(await rendered(unpressed, 'backgroundColor'), canvas);
      expect(contrast(pressedFill, hoveredFill)).toBeGreaterThanOrEqual(3);
    });
  }
});

test.describe('tables keep focus rings whole', () => {
  test.use({ storageState: OWNER_STATE });

  test('no control on a table edge has its focus ring clipped by the table’s scroll box', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    let checked = 0;
    for (const path of [
      'admin/principals',
      'admin/audit',
      'program/ventures',
      'program/escalations',
      'program/resources',
      'program/assignments',
      'eir/eirs',
      'eir/personas',
    ]) {
      await page.goto(`/${TENANT}/app/${path}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      const container = page.locator('[data-slot="table-container"]').first();
      // Some queues are empty on a fresh database: nothing to check there.
      if ((await container.count()) === 0) continue;
      // A keyboard interaction first, so programmatic focus shows the ring as Tab would.
      await page.keyboard.press('Shift');
      const clipped = await container.evaluate((box) => {
        const problems: string[] = [];
        let count = 0;
        const clip = box.getBoundingClientRect();
        if (box.scrollWidth > box.clientWidth + 1)
          return { count, problems: ['the table overflows at 1440px'] };
        const controls = box.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        for (const control of controls) {
          const rect = control.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          control.focus();
          if (!control.matches(':focus-visible')) {
            problems.push(`${control.outerHTML.slice(0, 80)}: no visible focus`);
            continue;
          }
          const style = getComputedStyle(control);
          const reach =
            style.outlineStyle === 'none'
              ? 0
              : parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
          const ring = {
            left: rect.left - reach,
            right: rect.right + reach,
            top: rect.top - reach,
            bottom: rect.bottom + reach,
          };
          count += 1;
          if (
            ring.left < clip.left - 0.5 ||
            ring.right > clip.right + 0.5 ||
            ring.top < clip.top - 0.5 ||
            ring.bottom > clip.bottom + 0.5
          ) {
            const name = control.getAttribute('aria-label') ?? control.textContent.trim().slice(0, 40);
            problems.push(
              `${name}: ring ${ring.left.toFixed(1)}–${ring.right.toFixed(1)} × ${ring.top.toFixed(1)}–${ring.bottom.toFixed(1)}, clip ${clip.left.toFixed(1)}–${clip.right.toFixed(1)} × ${clip.top.toFixed(1)}–${clip.bottom.toFixed(1)}`,
            );
          }
          control.blur();
        }
        return { count, problems };
      });
      expect(clipped.problems, `${path}: focus rings cut off by the table container`).toEqual([]);
      checked += clipped.count;
    }
    expect(checked, 'controls checked across the tables').toBeGreaterThan(10);
  });
});

test.describe('public pages', () => {
  test('the sign-in brand panel is true black in OLED dark', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.goto('/sign-in');
    await useTheme(page, 'dark');
    const panel = page.getByRole('complementary', { name: 'About Foundry Ascent' });
    await expect(panel).toBeVisible();
    expect(await style(panel, 'backgroundColor')).toBe(BLACK);
    expect(await style(page.locator('body'), 'backgroundColor')).toBe(BLACK);
  });
});
