import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, type Page } from '@playwright/test';

import { FOUNDER_STATE, TENANT, test } from './support/fixtures';

/*
 * Page speed of the signed-in app (docs/runbooks/latency.md): a cold load of the founder's New chat over a
 * throttled connection (time to first byte, first paint, the app shell, the composer, largest paint, layout
 * shift, when the interface fonts start loading) and the main route transitions with the cache warm. The
 * timings are written to test-results/web-perf/ and printed, never asserted: they depend on the machine.
 * What is asserted does not: the signed-in page does not shift as it loads. The landing page is measured the
 * same way, signed out.
 */

/** A modest real-world connection: 40 ms round trips, 20 Mbit/s down, 5 Mbit/s up. */
const NETWORK = { offline: false, latency: 40, downloadThroughput: 2_500_000, uploadThroughput: 625_000 };

/**
 * The two devices measured: a laptop (no CPU slowdown) and a mid-range phone (the CPU four times slower,
 * which is where script size shows: every byte of the first load, the entry and its static imports, is parsed
 * before the app can paint).
 */
const DEVICES = [
  { name: 'laptop', cpuSlowdown: 1 },
  { name: 'phone-cpu', cpuSlowdown: 4 },
] as const;

interface PaintMetrics {
  readonly cls: number;
  readonly lcp: number | null;
  /** The elements that shifted (tag and classes) and by how much. */
  readonly shifted: readonly string[];
}

/** Collects layout shifts and the largest paint from the first byte on (buffered observers). */
async function observePaints(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const perf = { cls: 0, lcp: null as number | null, shifted: [] as string[] };
    (window as unknown as { __perf: typeof perf }).__perf = perf;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & {
        value: number;
        hadRecentInput: boolean;
        sources?: { node?: Node | null }[];
      })[]) {
        if (entry.hadRecentInput) continue;
        perf.cls += entry.value;
        // What moved (element and its first classes, no text), to find the cause of a shift.
        for (const source of entry.sources ?? []) {
          const node = source.node;
          if (node instanceof Element) {
            perf.shifted.push(
              `${node.tagName.toLowerCase()}.${[...node.classList].slice(0, 3).join('.')} +${entry.value.toFixed(3)}`,
            );
          }
        }
      }
    }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((list) => {
      const last = list.getEntries().at(-1);
      if (last) perf.lcp = last.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  });
}

/** What to wait for: the app shell, the composer, or a page that rendered its content. */
type Probe =
  | { readonly kind: 'shell' }
  | { readonly kind: 'composer' }
  /** The landing page: its heading and the way to sign in. */
  | { readonly kind: 'landing' }
  /** A page with its title, a heading in the main region and no skeleton left. */
  | { readonly kind: 'page'; readonly title: string };

/** `performance.now()` in the page at the first animation frame where `probe` holds. */
async function when(page: Page, probe: Probe): Promise<number> {
  const handle = await page.waitForFunction(
    (p: Probe) => {
      let ready: boolean;
      if (p.kind === 'shell') ready = document.querySelector('[aria-label^="Account menu for"]') !== null;
      else if (p.kind === 'composer') {
        // The message box: a text field whose accessible name starts with "Message" (its label).
        ready = [...document.querySelectorAll('textarea')].some((el) =>
          [el.getAttribute('aria-label'), el.labels[0]?.textContent].some((name) =>
            (name ?? '').trim().startsWith('Message'),
          ),
        );
      } else if (p.kind === 'landing') {
        ready =
          document.querySelector('h1') !== null && document.querySelector('a[href="/sign-in"]') !== null;
      } else {
        ready =
          document.title.startsWith(p.title) &&
          document.querySelector('main h1') !== null &&
          document.querySelector('main [data-slot="skeleton"]') === null;
      }
      return ready ? performance.now() : null;
    },
    probe,
    { polling: 'raf', timeout: 30_000 },
  );
  const at = await handle.jsonValue();
  if (typeof at !== 'number') throw new Error('the probe resolved without a time');
  return at;
}

async function transition(page: Page, hrefSuffix: string, title: string): Promise<number | null> {
  const started = await page.evaluate((suffix) => {
    const link = [...document.querySelectorAll('a[href]')].find((a) =>
      (a.getAttribute('href') ?? '').replace(/[?#].*$/, '').endsWith(suffix),
    );
    if (!(link instanceof HTMLAnchorElement)) return null;
    const at = performance.now();
    link.click();
    return at;
  }, hrefSuffix);
  if (started === null) return null;
  return (await when(page, { kind: 'page', title })) - started;
}

test.describe('page speed', () => {
  test.use({ storageState: FOUNDER_STATE });

  for (const device of DEVICES) {
    test(`cold load of New chat, its fonts, and the main route transitions (${device.name})`, async ({
      page,
    }, testInfo) => {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', NETWORK);
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: device.cpuSlowdown });
      await observePaints(page);

      await page.goto(`/${TENANT}/app`);
      const shellAt = await when(page, { kind: 'shell' });
      const composerAt = await when(page, { kind: 'composer' });
      await page.waitForTimeout(500);
      const load = await page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
        const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null;
        const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
        const font = (name: string) => {
          const entry = resources.find((r) => r.name.includes(name));
          return entry ? { startMs: entry.startTime, endMs: entry.responseEnd } : null;
        };
        const scripts = resources.filter((r) => r.initiatorType === 'script' || r.name.endsWith('.js'));
        const entry = scripts.find((r) => /\/assets\/index-[^/]+\.js$/.test(r.name));
        return {
          ttfbMs: nav ? nav.responseStart - nav.startTime : null,
          domContentLoadedMs: nav ? nav.domContentLoadedEventEnd - nav.startTime : null,
          fcpMs: fcp,
          entryScriptBytes: entry?.encodedBodySize ?? null,
          scriptsBeforeComposer: scripts.length,
          // The waterfall up to the composer: what was fetched, when it started and when it ended.
          waterfall: resources.map((r) => ({
            path: new URL(r.name).pathname,
            startMs: Math.round(r.startTime),
            endMs: Math.round(r.responseEnd),
          })),
          sansFont: font('geist-latin-wght-normal'),
          serifFont: font('newsreader-latin-wght-normal'),
          preloadedFonts: [...document.querySelectorAll('link[rel="preload"][as="font"]')].map(
            (link) => link.getAttribute('href') ?? '',
          ),
          paints: (window as unknown as { __perf: PaintMetrics }).__perf,
        };
      });

      // Route transitions with the cache warm, as a founder clicks around.
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });
      const venturePath = new URL(page.url()).pathname;
      const transitions = {
        knowledgeMs: await transition(page, '/knowledge', 'Knowledge'),
        documentsMs: await transition(page, '/documents', 'Documents'),
        knowledgeAgainMs: await transition(page, '/knowledge', 'Knowledge'),
        newChatMs: await transition(page, venturePath, ''),
      };

      const result = {
        label: `${process.env.PERF_LABEL ?? 'run'}-${device.name}`,
        device,
        network: NETWORK,
        ...load,
        shellMs: shellAt,
        composerMs: composerAt,
        transitions,
      };
      const dir = join(testInfo.project.outputDir, 'web-perf');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${result.label}.json`), JSON.stringify(result, null, 2));
      process.stdout.write(`web-perf ${JSON.stringify({ ...result, waterfall: undefined })}\n`);

      // Machine-independent: the page does not jump while it loads.
      expect(load.paints.cls, 'cumulative layout shift of the cold load').toBeLessThan(0.1);
      expect(load.ttfbMs).not.toBeNull();
      expect(composerAt).toBeGreaterThanOrEqual(shellAt);
    });
  }
});

test.describe('page speed, signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('cold load of the landing page', async ({ page }, testInfo) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', NETWORK);
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await observePaints(page);
    await page.goto('/');
    const landingAt = await when(page, { kind: 'landing' });
    await page.waitForTimeout(500);
    const load = await page.evaluate(() => ({
      fcpMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
      paints: (window as unknown as { __perf: PaintMetrics }).__perf,
    }));
    const result = { label: `${process.env.PERF_LABEL ?? 'run'}-landing`, ...load, landingMs: landingAt };
    const dir = join(testInfo.project.outputDir, 'web-perf');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${result.label}.json`), JSON.stringify(result, null, 2));
    process.stdout.write(`web-perf-landing ${JSON.stringify(result)}\n`);
    // Reported, not asserted: the landing page (its own stream's page) shifts as its display face swaps in.
    expect(landingAt).toBeGreaterThan(0);
  });
});
