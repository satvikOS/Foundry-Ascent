import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { chromium, defineConfig, type PlaywrightTestConfig } from '@playwright/test';

/**
 * End-to-end suite (CI job `e2e` in .github/workflows/ci.yml). Playwright starts the whole local stack
 * itself — CI starts nothing:
 *
 *   1. the API dev server (apps/api `src/dev-server.ts`) on :8787 with `DATABASE_URL`, `DB_DRIVER=pg` and
 *      `MODEL_PROVIDER=mock` (deterministic, offline) taken from the environment;
 *   2. `vite preview` of the production build on :4173, which proxies `/api` to :8787 (build first:
 *      `pnpm --filter @foundry/web build`).
 *
 * Environment:
 *   E2E_BASE_URL           SPA origin (default http://localhost:4173)
 *   E2E_API_URL            API origin the preview proxies to (default http://localhost:8787)
 *   E2E_OWNER_ACCESS_CODE  owner access code printed by `pnpm db:reset` (required; never logged)
 *   DATABASE_URL           the database `pnpm db:reset` created (passed through to the API)
 *
 * Reports go to `playwright-report/` (HTML) and `test-results/` (failure screenshots), both gitignored and
 * uploaded by CI on failure. Traces are recorded only outside CI: they would contain the (throwaway)
 * access codes typed during the journey.
 */

const CI = Boolean(process.env.CI);
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:4173';
const apiURL = new URL(process.env.E2E_API_URL ?? 'http://localhost:8787');
const site = new URL(baseURL);
const localStack = site.hostname === 'localhost' || site.hostname === '127.0.0.1';

/**
 * CI installs the Chromium build that matches this Playwright release (`playwright install chromium`).
 * Locally, a sandbox may only have an older build under PLAYWRIGHT_BROWSERS_PATH (e.g. /opt/pw-browsers):
 * use the newest one found there instead of failing with "Executable doesn't exist".
 */
function localChromium(): string | undefined {
  if (existsSync(chromium.executablePath())) return undefined;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  if (!existsSync(root)) return undefined;
  const builds = readdirSync(root)
    .map((name) => /^chromium-(\d+)$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  for (const [name] of builds) {
    for (const binary of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app']) {
      const candidate = join(root, name, binary);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const executablePath = localChromium();

const webServer: PlaywrightTestConfig['webServer'] = localStack
  ? [
      {
        name: 'api',
        command: 'pnpm --filter @foundry/api exec tsx src/dev-server.ts',
        // The public health route never queries the database, so readiness polling cannot wake or
        // keep Aurora awake (and locally answers as soon as the server listens).
        url: `${apiURL.origin}/api/v1/health`,
        reuseExistingServer: !CI,
        timeout: 120_000,
        stdout: 'ignore',
        stderr: 'pipe',
        gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
        env: {
          APP_ENV: 'development',
          DB_DRIVER: process.env.DB_DRIVER ?? 'pg',
          MODEL_PROVIDER: process.env.MODEL_PROVIDER ?? 'mock',
          LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
          PORT: apiURL.port || '8787',
          // Local presigned uploads go through the preview's /api proxy (same origin as the SPA).
          SITE_ORIGIN: process.env.SITE_ORIGIN ?? site.origin,
          // Every run sends a handful of turns as the same founder; keep reruns against one database
          // (and Playwright retries) clear of the 20-per-10-minutes per-person turn limit.
          CORE_TURN_RATE_LIMIT: process.env.CORE_TURN_RATE_LIMIT ?? '200',
        },
      },
      {
        name: 'web',
        command: `pnpm exec vite preview --port ${site.port || '4173'} --strictPort`,
        url: baseURL,
        reuseExistingServer: !CI,
        timeout: 60_000,
        stdout: 'ignore',
        stderr: 'pipe',
      },
    ]
  : undefined;

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  // One worker: the journey and the checks share one seeded database and one founder.
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: CI
    ? [['github'], ['list'], ['html', { outputFolder: './playwright-report', open: 'never' }]]
    : [['list'], ['html', { outputFolder: './playwright-report', open: 'never' }]],
  use: {
    baseURL,
    trace: CI ? 'off' : 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    locale: 'en-US',
    timezoneId: 'UTC',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts$/ },
    {
      name: 'desktop',
      testMatch: /(journey|documents|safety|a11y)\.spec\.ts$/,
      dependencies: ['setup'],
      use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile',
      testMatch: /mobile\.spec\.ts$/,
      dependencies: ['setup'],
      use: {
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer,
});
