import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';

import { decodePng, type Pixels } from './support/png';
import { FOUNDER_STATE, openVenture, startConversation, test, useTheme } from './support/fixtures';
import { feedLongAnswers } from './support/long-answer';

/*
 * The frosted glass, measured from the pixels the browser draws (owner refinement 2026-11-05: "translucent, not
 * opaque", with contrast kept). For each glass layer (the composer and its chips over the transcript, the docked
 * side panel, a menu, the command palette, the phone's navigation sheet over a conversation) every visible text's
 * own boxes are found, the layer's text is made transparent, the screen is captured, and the text's colour is
 * compared with every pixel of the glass behind it: the real backdrop, blurred, tinted and dimmed by the browser.
 * The lowest ratio of each text must reach 4.5:1 (WCAG 2.2 AA). The ratios are written to the test's output.
 *
 * And translucent, measured the same way: the same frame captured with the transcript shown and then hidden, the
 * change in brightness inside each glass layer is what passes through it. Opaque-looking glass (a second blur over
 * the first, a dimmed backdrop, a dense face) let through a mean of 0-2.4 of 255 over the prose; the layers must
 * now let through a visible share. And one blur per region: a page scrolls under at most three.
 */

interface TextBox {
  text: string;
  /** The text's colour as sRGB bytes and alpha. */
  rgba: [number, number, number, number];
  boxes: { x: number; y: number; width: number; height: number }[];
}

interface Measured {
  layer: string;
  text: string;
  ratio: number;
}

/** The visible texts of `root` (text nodes and an empty field's placeholder), with their colours and line boxes. */
function textBoxes(root: Locator): Promise<TextBox[]> {
  return root.evaluate((element) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('no canvas');
    const bytes = (css: string): [number, number, number, number] => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const out: TextBox[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      const text = node.textContent?.trim() ?? '';
      if (!parent || text === '' || parent.closest('[aria-hidden="true"], .sr-only, svg')) continue;
      const style = getComputedStyle(parent);
      if (style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      // Only what is drawn: each line box cut to the layer and to every scrolling or clipping box above the text
      // (a list scrolled inside the palette, a truncated label). Where a mask fades a row's ends (the chips),
      // the text there fades with it, a cue that the row scrolls: those ends are left out.
      let clip = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
      for (let up: Element | null = parent; up; up = up.parentElement) {
        const css = getComputedStyle(up);
        const clips = up === element || css.overflowX !== 'visible' || css.overflowY !== 'visible';
        const masked = css.maskImage !== 'none' && css.maskImage !== '';
        if (clips || masked) {
          const r = up.getBoundingClientRect();
          const fade = masked ? 32 : 0;
          clip = {
            left: Math.max(clip.left, r.left + fade),
            top: Math.max(clip.top, r.top),
            right: Math.min(clip.right, r.right - fade),
            bottom: Math.min(clip.bottom, r.bottom),
          };
        }
        if (up === element) break;
      }
      const range = document.createRange();
      range.selectNodeContents(node);
      const boxes = [...range.getClientRects()]
        .map((r) => {
          const left = Math.max(r.left, clip.left);
          const top = Math.max(r.top, clip.top);
          return {
            x: left,
            y: top,
            width: Math.min(r.right, clip.right) - left,
            height: Math.min(r.bottom, clip.bottom) - top,
          };
        })
        .filter((r) => r.width > 2 && r.height > 2);
      if (boxes.length > 0) out.push({ text: text.slice(0, 40), rgba: bytes(style.color), boxes });
    }
    for (const field of element.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>(
      'textarea[placeholder], input[placeholder]',
    )) {
      if (field.value !== '' || !field.placeholder) continue;
      const style = getComputedStyle(field);
      const box = field.getBoundingClientRect();
      const top = box.y + parseFloat(style.paddingTop);
      const left = box.x + parseFloat(style.paddingLeft);
      const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const width = Math.min(
        context.measureText(field.placeholder).width,
        box.width - 2 * parseFloat(style.paddingLeft),
      );
      out.push({
        text: `placeholder: ${field.placeholder.slice(0, 30)}`,
        rgba: bytes(getComputedStyle(field, '::placeholder').color),
        boxes: [{ x: left, y: top, width, height: lineHeight }],
      });
    }
    return out;
  });
}

/** Makes `root`'s text (and placeholders) transparent, or restores it. */
async function hideText(root: Locator, hidden: boolean): Promise<void> {
  await root.evaluate((element, hide) => {
    const all = [element, ...element.querySelectorAll<HTMLElement>('*')] as HTMLElement[];
    for (const node of all) {
      if (hide) {
        node.style.setProperty('color', 'transparent', 'important');
        node.style.setProperty('-webkit-text-fill-color', 'transparent', 'important');
        node.style.setProperty('caret-color', 'transparent', 'important');
        if ('placeholder' in node && typeof node.placeholder === 'string' && node.placeholder !== '') {
          node.dataset.glassProbe = node.placeholder;
          node.placeholder = '';
        }
      } else {
        node.style.removeProperty('color');
        node.style.removeProperty('-webkit-text-fill-color');
        node.style.removeProperty('caret-color');
        if (node.dataset.glassProbe !== undefined && 'placeholder' in node) {
          node.placeholder = node.dataset.glassProbe;
          delete node.dataset.glassProbe;
        }
      }
    }
  }, hidden);
  // Two frames: the change is painted before the capture.
  await root
    .page()
    .evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

function luminance(r: number, g: number, b: number): number {
  const c = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}

/** The lowest contrast of `text` over the captured pixels inside its boxes (inset 1 px from their edges). */
function worstRatio(text: TextBox, pixels: Pixels, scale: number): number {
  const [tr, tg, tb, ta] = text.rgba;
  let worst = Infinity;
  for (const box of text.boxes) {
    const x0 = Math.max(0, Math.ceil((box.x + 1) * scale));
    const y0 = Math.max(0, Math.ceil((box.y + 1) * scale));
    const x1 = Math.min(pixels.width, Math.floor((box.x + box.width - 1) * scale));
    const y1 = Math.min(pixels.height, Math.floor((box.y + box.height - 1) * scale));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * pixels.width + x) * 4;
        const br = pixels.data[o] ?? 0;
        const bg = pixels.data[o + 1] ?? 0;
        const bb = pixels.data[o + 2] ?? 0;
        const fg = luminance(tr * ta + br * (1 - ta), tg * ta + bg * (1 - ta), tb * ta + bb * (1 - ta));
        const back = luminance(br, bg, bb);
        const ratio = (Math.max(fg, back) + 0.05) / (Math.min(fg, back) + 0.05);
        if (ratio < worst) worst = ratio;
      }
    }
  }
  return worst;
}

/** Measures every text of the glass layer `root`, over the pixels the browser draws behind it. */
async function measure(page: Page, root: Locator, layer: string): Promise<Measured[]> {
  await expect(root).toBeVisible();
  const texts = await textBoxes(root);
  expect(texts.length, `${layer}: texts found`).toBeGreaterThan(0);
  await hideText(root, true);
  const scale = await page.evaluate(() => window.devicePixelRatio);
  const shot = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  // What was measured (the glass with its text hidden), kept on request: GLASS_SHOTS_DIR=<dir>.
  const keep = process.env.GLASS_SHOTS_DIR;
  if (keep) {
    mkdirSync(keep, { recursive: true });
    const scheme = await page.evaluate(() => document.documentElement.dataset.theme ?? 'auto');
    writeFileSync(join(keep, `${layer.replace(/\W+/g, '-')}-${scheme}.png`), shot);
  }
  const pixels = decodePng(shot);
  await hideText(root, false);
  return texts.map((text) => ({ layer, text: text.text, ratio: worstRatio(text, pixels, scale) }));
}

function report(results: Measured[], testInfo: TestInfo, name: string): void {
  const lines = results
    .slice()
    .sort((a, b) => a.ratio - b.ratio)
    .map((r) => `${r.ratio.toFixed(2)}  ${r.layer}: ${r.text}`);
  void testInfo.attach(name, { body: lines.join('\n'), contentType: 'text/plain' });
  process.stdout.write(`glass-contrast ${name}\n${lines.slice(0, 8).join('\n')}\n`);
  const failing = results
    .filter((r) => r.ratio < 4.5)
    .map((r) => `${r.layer}: ${r.text} ${r.ratio.toFixed(2)}`);
  expect(failing, `${name}: text on glass below 4.5:1`).toEqual([]);
}

interface Passed {
  layer: string;
  /** Mean and largest change in brightness (0-255) inside the layer when the transcript beneath is hidden. */
  mean: number;
  max: number;
}

/** What `glass` lets through of the transcript beneath it: captured with the transcript shown, then hidden. */
async function passedThrough(page: Page, glass: Locator, layer: string): Promise<Passed> {
  const box = await glass.boundingBox();
  if (!box) throw new Error(`${layer}: not on screen`);
  // Inside its rounded edge and lit border.
  const clip = { x: box.x + 6, y: box.y + 6, width: box.width - 12, height: box.height - 12 };
  const frame = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  const shown = decodePng(await page.screenshot({ clip, animations: 'disabled', caret: 'hide' }));
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.id = 'glass-probe-hide';
    style.textContent = 'section[aria-label="Transcript"] { opacity: 0 !important; }';
    document.head.append(style);
  });
  await frame();
  const hidden = decodePng(await page.screenshot({ clip, animations: 'disabled', caret: 'hide' }));
  await page.evaluate(() => document.getElementById('glass-probe-hide')?.remove());
  await frame();
  let sum = 0;
  let max = 0;
  const pixels = shown.width * shown.height;
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    const a = ((shown.data[o] ?? 0) + (shown.data[o + 1] ?? 0) + (shown.data[o + 2] ?? 0)) / 3;
    const b = ((hidden.data[o] ?? 0) + (hidden.data[o + 1] ?? 0) + (hidden.data[o + 2] ?? 0)) / 3;
    const change = Math.abs(a - b);
    sum += change;
    if (change > max) max = change;
  }
  return { layer, mean: sum / pixels, max };
}

function reportPassed(results: Passed[], name: string): void {
  process.stdout.write(
    `glass-translucency ${name}\n${results.map((r) => `${r.layer}: mean ${r.mean.toFixed(2)} max ${r.max.toFixed(0)}`).join('\n')}\n`,
  );
}

/** The elements with a backdrop filter (pseudo-elements included), and whether any sits inside another. */
function blurLayers(page: Page): Promise<{ layers: string[]; nested: string[] }> {
  return page.evaluate(() => {
    const blurred = (element: Element, pseudo: string | null) => {
      const style = getComputedStyle(element, pseudo);
      const filter = style.backdropFilter || style.getPropertyValue('-webkit-backdrop-filter');
      return filter !== '' && filter !== 'none';
    };
    const name = (element: Element) =>
      `${element.tagName.toLowerCase()}${element.getAttribute('data-slot') ? `[${element.getAttribute('data-slot')}]` : ''}`;
    const layers: string[] = [];
    const nested: string[] = [];
    for (const element of document.querySelectorAll('*')) {
      if (element.getClientRects().length === 0) continue;
      for (const pseudo of [null, '::before', '::after']) {
        if (!blurred(element, pseudo)) continue;
        layers.push(`${name(element)}${pseudo ?? ''}`);
        // Inside a blurred ancestor, or above its own ::before blur (the composer over the dock's).
        for (let up = pseudo ? null : element.parentElement; up; up = up.parentElement) {
          if (blurred(up, null) || blurred(up, '::before')) nested.push(`${name(element)} in ${name(up)}`);
        }
      }
    }
    return { layers, nested };
  });
}

/** Computed style of the first match. */
function computed(root: Locator, property: 'backgroundColor' | 'backdropFilter'): Promise<string> {
  return root.evaluate((element, name) => {
    const style = getComputedStyle(element);
    return name === 'backdropFilter'
      ? style.backdropFilter || style.getPropertyValue('-webkit-backdrop-filter')
      : style.backgroundColor;
  }, property);
}

/** The alpha of a computed `rgb()`/`rgba()` colour. */
function alpha(css: string): number {
  const match = /rgba?\(([^)]+)\)/.exec(css);
  const parts = match?.[1]?.split(/[\s,/]+/).filter(Boolean) ?? [];
  return parts.length >= 4 ? Number(parts[3]) : 1;
}

/**
 * This browser's speed verdict, given (lib/perf.ts samples frames once and may judge a busy test browser slow,
 * which swaps every glass layer for its solid face): the glass is what is measured here.
 */
async function keepGlassOn(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // The hints are read before any stored verdict: pin them, so the runner's own core count never decides.
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    window.localStorage.setItem('fa.perf', JSON.stringify({ v: 'ok', at: Date.now() }));
  });
}

test.describe('frosted glass', () => {
  test.use({ storageState: FOUNDER_STATE });

  for (const scheme of ['dark', 'light'] as const) {
    test(`text on the glass holds 4.5:1 over what the browser draws behind it (${scheme})`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(120_000);
      await keepGlassOn(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await feedLongAnswers(page, { unitDelayMs: 5 });
      await openVenture(page);
      await useTheme(page, scheme);
      await startConversation(page, 'How should we price the two-library pilot?');
      await expect(
        page.getByRole('article', { name: 'Exchange 1' }).getByRole('button', { name: 'Copy answer' }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('list', { name: 'Follow-up questions' })).toBeVisible();
      await page.mouse.move(720, 450);

      // Translucent, with one blur: the docked panel has its own; the composer and its chips are tints over the
      // dock's (a blur of their own over it left nothing showing through).
      const composerCard = page.locator('[data-slot="composer"]');
      const panel = page.locator('[data-slot="side-panel"]');
      const dock = page.locator('[data-slot="composer-dock"]');
      expect(
        alpha(await computed(panel, 'backgroundColor')),
        'side panel is translucent',
      ).toBeLessThanOrEqual(0.6);
      expect(await computed(panel, 'backdropFilter'), 'side panel is frosted').toContain('blur(24px)');
      expect(
        alpha(await computed(composerCard, 'backgroundColor')),
        'composer is translucent',
      ).toBeLessThanOrEqual(0.6);
      expect(await computed(composerCard, 'backdropFilter'), 'composer: no second blur').toBe('none');
      expect(
        await dock.evaluate((element) => getComputedStyle(element, '::before').backdropFilter),
        'the dock frosts the transcript once',
      ).toContain('blur(24px)');
      // Never glass on glass, and few blurs while the transcript scrolls: the panel, the header, the dock.
      const { layers, nested } = await blurLayers(page);
      expect(nested, 'no blur over another').toEqual([]);
      expect(layers.length, `blurred layers: ${layers.join(', ')}`).toBeLessThanOrEqual(3);

      const settled = (layer: Locator) =>
        layer.evaluate((element) =>
          Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)),
        );
      // The answer's prose under the composer and its chips: scrolled up from the end.
      await page.evaluate(() => {
        window.scrollTo(0, document.documentElement.scrollHeight);
        window.scrollBy(0, -520);
      });
      const results: Measured[] = [];
      const passed: Passed[] = [];
      passed.push(await passedThrough(page, composerCard, 'composer'));
      results.push(...(await measure(page, dock, 'composer and chips')));
      results.push(...(await measure(page, panel, 'side panel')));

      // A menu over the transcript (the conversation's), with the answer's prose beneath it.
      await page.evaluate(() => {
        window.scrollTo(0, 300);
      });
      await page.getByRole('button', { name: 'Conversation options' }).click();
      const menu = page.getByRole('menu');
      await settled(menu);
      expect(alpha(await computed(menu, 'backgroundColor')), 'the menu is translucent').toBeLessThanOrEqual(
        0.6,
      );
      passed.push(await passedThrough(page, menu, 'conversation menu'));
      results.push(...(await measure(page, menu, 'conversation menu')));
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();

      // A menu opened from the side panel may lie over the panel's glass: it is solid.
      await page.getByRole('button', { name: /^Account menu for / }).click();
      await settled(menu);
      expect(alpha(await computed(menu, 'backgroundColor')), 'the account menu is solid').toBe(1);
      expect(await computed(menu, 'backdropFilter')).toBe('none');
      results.push(...(await measure(page, menu, 'account menu')));
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();

      await page.keyboard.press('ControlOrMeta+k');
      const palette = page.locator('[data-slot="dialog-content"][data-surface="glass"]');
      await expect(palette).toBeVisible();
      await settled(palette);
      passed.push(await passedThrough(page, palette, 'command palette'));
      results.push(...(await measure(page, palette, 'command palette')));
      await page.keyboard.press('Escape');

      report(results, testInfo, `glass-${scheme}-desktop`);
      reportPassed(passed, `glass-${scheme}-desktop`);
      // What passes through is visible: the prose's haze, not a flat face. Over prose the opaque-looking glass let
      // through a mean of 0-2.4 of 255 (at most 4-9); this glass lets through 5-9 (at most 12-15). A 24 px blur
      // turns a line of 16 px text into a haze of its ink, about a tenth of its line box, so that is the most a
      // face dense enough for 4.5:1 over a blurred filled control (tokens.test.ts) can show of prose.
      for (const layer of passed) {
        expect(layer.mean, `${layer.layer}: mean change over the prose`).toBeGreaterThanOrEqual(4);
        expect(layer.max, `${layer.layer}: largest change over the prose`).toBeGreaterThanOrEqual(10);
      }
    });

    test(`the phone's navigation sheet holds 4.5:1 over the conversation beneath it (${scheme})`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(120_000);
      await keepGlassOn(page);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await feedLongAnswers(page, { unitDelayMs: 5 });
      await openVenture(page);
      await useTheme(page, scheme);
      await startConversation(page, 'What should we measure in the pilot?');
      await expect(
        page.getByRole('article', { name: 'Exchange 1' }).getByRole('button', { name: 'Copy answer' }),
      ).toBeVisible({ timeout: 30_000 });
      // The composer over the answer's prose, on a phone too.
      await page.evaluate(() => {
        window.scrollTo(0, document.documentElement.scrollHeight);
        window.scrollBy(0, -520);
      });
      const composer = await passedThrough(page, page.locator('[data-slot="composer"]'), 'composer');
      reportPassed([composer], `glass-${scheme}-phone`);
      expect(composer.mean, 'phone composer: mean change over the prose').toBeGreaterThanOrEqual(4);
      expect(composer.max, 'phone composer: largest change over the prose').toBeGreaterThanOrEqual(10);
      await page.evaluate(() => {
        window.scrollTo(0, 0);
      });
      await page.getByRole('button', { name: 'Open navigation' }).click();
      const sheet = page.locator('[data-slot="panel-sheet"]');
      await expect(sheet).toBeVisible();
      await sheet.evaluate((element) =>
        Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)),
      );
      expect(alpha(await computed(sheet, 'backgroundColor')), 'the sheet is translucent').toBeLessThanOrEqual(
        0.65,
      );
      report(await measure(page, sheet, 'navigation sheet'), testInfo, `glass-${scheme}-phone`);
    });
  }

  test('the glass turns solid where transparency is reduced, on a slow device, and in forced colours', async ({
    page,
  }) => {
    await keepGlassOn(page);
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await openVenture(page);
    await useTheme(page, 'dark');
    const composerCard = page.locator('[data-slot="composer"]');
    const panel = page.locator('[data-slot="side-panel"]');
    expect(alpha(await computed(composerCard, 'backgroundColor'))).toBeLessThan(1);

    // A slow device (lib/perf.ts sets this at boot).
    await page.evaluate(() => {
      document.documentElement.dataset.perf = 'low';
    });
    for (const layer of [composerCard, panel]) {
      // (The composer's colours ease over 150 ms.)
      await expect.poll(async () => alpha(await computed(layer, 'backgroundColor'))).toBe(1);
      expect(await computed(layer, 'backdropFilter')).toBe('none');
    }
    await page.evaluate(() => {
      delete document.documentElement.dataset.perf;
    });
    await expect.poll(async () => alpha(await computed(composerCard, 'backgroundColor'))).toBeLessThan(1);

    // Reduced transparency.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
    });
    for (const layer of [composerCard, panel]) {
      // (The composer's colours ease over 150 ms.)
      await expect.poll(async () => alpha(await computed(layer, 'backgroundColor'))).toBe(1);
      expect(await computed(layer, 'backdropFilter')).toBe('none');
    }
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });

    // Forced colours: system colours, no blur.
    await page.emulateMedia({ forcedColors: 'active' });
    for (const layer of [composerCard, panel]) {
      expect(await computed(layer, 'backdropFilter')).toBe('none');
      await expect.poll(async () => alpha(await computed(layer, 'backgroundColor'))).toBe(1);
    }
  });
});
