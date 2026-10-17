import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type * as WakeModule from './wake';
import type { WakeEnvironment } from './wake';

/*
 * The page-open wake (lib/api/wake.ts, called from main.tsx): one request per page load, sent without
 * waiting for it, so a paused database resumes while the person reads or signs in.
 */

const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

async function freshModule(): Promise<typeof WakeModule> {
  vi.resetModules();
  return import('./wake');
}

function environment(
  fetch: WakeEnvironment['fetch'],
  userAgent = CHROME,
  webdriver = false,
): WakeEnvironment {
  return { fetch, navigator: { userAgent, webdriver } };
}

describe('wakeDatabase', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('sends one content-free POST /api/v1/wake per page load and does not wait for it', async () => {
    const { wakeDatabase } = await freshModule();
    // A database that never answers: the call must still return at once.
    const fetch = vi.fn<WakeEnvironment['fetch']>(() => new Promise<Response>(() => undefined));

    // Nothing to await: it returns void, and returns at once although the request never ends.
    expectTypeOf(wakeDatabase).returns.toBeVoid();
    wakeDatabase(environment(fetch));
    wakeDatabase(environment(fetch));
    wakeDatabase(environment(fetch));

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('/api/v1/wake');
    expect(init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'omit', cache: 'no-store' });
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toEqual({
      'x-requested-with': 'foundry-ascent',
      'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
  });

  it('never throws or leaves a rejection unhandled when the request fails', async () => {
    const { wakeDatabase } = await freshModule();
    const unhandled: unknown[] = [];
    let calls = 0;
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      // A plain function: a vi.fn would itself attach handlers to the promise it returns.
      const rejected: WakeEnvironment['fetch'] = () => {
        calls += 1;
        return Promise.reject(new TypeError('offline'));
      };
      expect(() => {
        wakeDatabase(environment(rejected));
      }).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(calls).toBe(1);
    expect(unhandled).toEqual([]);

    const again = await freshModule();
    const throwing = vi.fn<WakeEnvironment['fetch']>(() => {
      throw new TypeError('blocked');
    });
    expect(() => {
      again.wakeDatabase(environment(throwing));
    }).not.toThrow();
  });

  it('is not sent by automated browsers (the end-to-end suite) or self-declared crawlers', async () => {
    for (const env of [
      { userAgent: CHROME, webdriver: true },
      {
        userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        webdriver: false,
      },
      { userAgent: 'Mozilla/5.0 HeadlessChrome/141.0', webdriver: false },
    ]) {
      const { wakeDatabase } = await freshModule();
      const fetch = vi.fn<WakeEnvironment['fetch']>(() =>
        Promise.resolve(new Response(null, { status: 204 })),
      );
      wakeDatabase(environment(fetch, env.userAgent, env.webdriver));
      expect(fetch, env.userAgent).not.toHaveBeenCalled();
    }
  });

  it('is fired from the entry point on load, before the first render, and not awaited', () => {
    const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'main.tsx'), 'utf8');
    const call = main.indexOf('\nwakeDatabase();\n');
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(main.indexOf('createRoot('));
    expect(main).not.toMatch(/await\s+wakeDatabase|wakeDatabase\(\)\s*\.then/);
    expect(main.match(/wakeDatabase\(/g)).toHaveLength(1);
  });
});
