import { API_PREFIX, CSRF_HEADER, CSRF_HEADER_VALUE } from '@foundry/contracts';

import { CONTENT_SHA256_HEADER } from './client';
import { EMPTY_SHA256 } from './sha256';

/**
 * Starts waking a paused database the moment a page opens (main.tsx): Aurora pauses after 30 idle minutes and
 * takes about 15–20 s to resume, so the resume runs while the person reads the landing page or signs in, not
 * when they send their first message. `POST /api/v1/wake` answers 204 at once with no content and sends at
 * most one `SELECT 1` (apps/api/src/routes/wake.ts).
 *
 * At most once per page load; fire and forget: it returns nothing to await, never throws, and its failure is
 * ignored (the app's own requests wait out a resume anyway). `keepalive` lets it finish if the person
 * navigates away at once. Skipped for automated browsers (`navigator.webdriver`, the end-to-end suite) and
 * self-declared crawlers, whose visits would only buy the database 30 idle minutes.
 */
const AUTOMATED_AGENT = /bot\b|crawl|spider|slurp|headless|lighthouse/i;

let fired = false;

export interface WakeEnvironment {
  readonly fetch: typeof fetch;
  readonly navigator: Pick<Navigator, 'userAgent' | 'webdriver'> | undefined;
}

function browser(): WakeEnvironment {
  return {
    fetch: (...args) => globalThis.fetch(...args),
    navigator: typeof navigator === 'undefined' ? undefined : navigator,
  };
}

export function wakeDatabase(env: WakeEnvironment = browser()): void {
  if (fired) return;
  fired = true;
  if (env.navigator?.webdriver === true || AUTOMATED_AGENT.test(env.navigator?.userAgent ?? '')) return;
  try {
    env
      .fetch(`${API_PREFIX}/wake`, {
        method: 'POST',
        keepalive: true,
        credentials: 'omit',
        cache: 'no-store',
        // Every write carries the CSRF header, and CloudFront's origin access control needs the body's hash.
        headers: { [CSRF_HEADER]: CSRF_HEADER_VALUE, [CONTENT_SHA256_HEADER]: EMPTY_SHA256 },
      })
      .catch(() => undefined);
  } catch {
    // A fetch that throws at once must not stop the page from rendering.
  }
}
