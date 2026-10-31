import { join } from 'node:path';

import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';

/**
 * The conversation lab's browser suites (docs/runbooks/conversation-lab.md), separate from the founder journey
 * (apps/web/playwright.config.ts): `*.lab.ts` here never match the main suite's projects.
 *
 *   recall  (recall.lab.ts)  calls and chats through the UI, typed, as the seeded founder; a second conversation
 *                            minutes later asks what the first was about.
 *   voice   (voice.lab.ts)   a true voice call: Chromium's fake microphone plays the founder's synthesized lines
 *                            (LAB_FAKE_MIC_WAV, LAB_VOICE_MANIFEST), the app streams them to Amazon Transcribe.
 *   face    (face.lab.ts)    the HeyGen LiveAvatar FULL stock face against the vendor's free sandbox: raw sandbox
 *                            rooms through the dev server's lab probe (LAB_FACE_PROBE_TOKEN), then calls with the
 *                            face (an admin of a synthetic venture), an injected `speak_text`, and Polly alone.
 *                            No fake microphone: the call is typed and the face must never ask for one.
 *
 * In the lab (ops/lab, .github/workflows/ops-conversation-lab.yml) the app is already running with the real models
 * and both servers are reused; locally (the e2e script, mock model) Playwright starts them like the main suite.
 * Outputs (what each scenario captured) go to LAB_OUT_PRIVATE, which the lab seals; nothing is printed but test
 * titles (e2e/lab/public-reporter.ts).
 *
 * Silent by construction: `--disable-audio-output` (a fake output device) and the suite's silent speech synthesis
 * (support/fixtures.ts `test`), as in the main suite.
 */

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:4173';
const apiURL = new URL(process.env.E2E_API_URL ?? 'http://localhost:8787');
const site = new URL(baseURL);
const localStack = site.hostname === 'localhost' || site.hostname === '127.0.0.1';
const privateDir = process.env.LAB_OUT_PRIVATE;
const fakeMic = process.env.LAB_FAKE_MIC_WAV;

/** Chromium flags of the voice project: a fake microphone that plays the founder's first line once. */
const voiceArgs = fakeMic
  ? [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${fakeMic}%noloop`,
      '--autoplay-policy=no-user-gesture-required',
    ]
  : [];

const webServer: PlaywrightTestConfig['webServer'] = localStack
  ? [
      {
        name: 'api',
        command: 'pnpm --filter @foundry/api exec tsx src/dev-server.ts',
        url: `${apiURL.origin}/api/v1/health`,
        reuseExistingServer: true,
        timeout: 120_000,
        stdout: 'ignore',
        stderr: 'ignore',
        gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
        env: {
          APP_ENV: 'development',
          DB_DRIVER: process.env.DB_DRIVER ?? 'pg',
          MODEL_PROVIDER: process.env.MODEL_PROVIDER ?? 'mock',
          LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
          PORT: apiURL.port || '8787',
          SITE_ORIGIN: process.env.SITE_ORIGIN ?? site.origin,
          LOCAL_DOWNLOAD_ORIGIN: apiURL.origin,
          CORE_TURN_RATE_LIMIT: process.env.CORE_TURN_RATE_LIMIT ?? '1000',
        },
      },
      {
        name: 'web',
        command: `pnpm exec vite preview --port ${site.port || '4173'} --strictPort`,
        url: baseURL,
        reuseExistingServer: true,
        timeout: 60_000,
        stdout: 'ignore',
        stderr: 'ignore',
        env: { API_PROXY_TARGET: apiURL.origin },
      },
    ]
  : undefined;

export default defineConfig({
  testDir: '.',
  outputDir: privateDir
    ? join(privateDir, 'test-results')
    : join(import.meta.dirname, '..', '..', 'test-results', 'lab'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Recall waits minutes between conversations on purpose (the owner's "a second call minutes later").
  timeout: 30 * 60_000,
  expect: { timeout: 90_000 },
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'off',
    screenshot: 'only-on-failure',
    video: 'off',
    locale: 'en-US',
    timezoneId: 'UTC',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    browserName: 'chromium',
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    { name: 'setup', testDir: '..', testMatch: /auth\.setup\.ts$/ },
    {
      name: 'recall',
      testMatch: /recall\.lab\.ts$/,
      dependencies: ['setup'],
      use: { launchOptions: { args: ['--disable-audio-output'] } },
    },
    {
      name: 'face',
      testMatch: /face\.lab\.ts$/,
      dependencies: ['setup'],
      // Autoplay without a gesture: the suite's own level meter on the avatar's audio (an AudioContext) must run.
      use: {
        launchOptions: { args: ['--disable-audio-output', '--autoplay-policy=no-user-gesture-required'] },
      },
    },
    {
      name: 'voice',
      testMatch: /voice\.lab\.ts$/,
      dependencies: ['setup'],
      use: { launchOptions: { args: ['--disable-audio-output', ...voiceArgs] } },
    },
  ],
  webServer,
});
