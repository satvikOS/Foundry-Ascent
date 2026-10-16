import { join } from 'node:path';

import { expect, type APIRequestContext, type Page } from '@playwright/test';

import {
  expectNoHorizontalScroll,
  expectNoSeriousA11yViolations,
  expectReachable,
  issueAccessCodeViaApi,
  OWNER_STATE,
  runToken,
  signIn,
  TENANT,
  test,
  useTheme,
} from './support/fixtures';

/*
 * The EIR studio's Test bench with the mock model: a curator talks to a draft of their vEIR before approving
 * it, through the founder pipeline's checks, and nothing is kept. The draft each test adds is withdrawn
 * afterwards, so the shared seeded database is left as it was found (and a second run starts the same).
 */

const CORIN = 'Corin Halvorsen';
const RUTH = 'Ruth Abernathy-Song';
const VEIR = "Corin's vEIR";
const WRITE_HEADERS = { 'x-requested-with': 'foundry-ascent', 'content-type': 'application/json' };
const CRISIS = 'I want to end my life, I cannot do this anymore.';
/** Where screenshots of the bench go when set (desktop and phone, light and dark). */
const SHOTS = process.env.E2E_SHOTS_DIR;

interface PersonaRow {
  id: string;
  name: string;
  activeRelease: {
    id: string;
    version: number;
    doctrine: Record<string, unknown>;
    style: unknown;
    disclosureText: string;
    allowedModes: string[];
  } | null;
  releases: { id: string; version: number; status: string }[];
}

async function corinsVeir(request: APIRequestContext): Promise<PersonaRow> {
  const list = await request.get('/api/v1/personas');
  expect(list.status(), 'GET /personas').toBe(200);
  const items = ((await list.json()) as { items: PersonaRow[] }).items;
  const persona = items.find((p) => p.name === VEIR);
  if (!persona?.activeRelease) throw new Error(`${VEIR} or its active release is missing from the seed`);
  return persona;
}

/** A draft of Corin's vEIR (as a program lead), to try before approving; returns its id and version. */
async function addDraft(request: APIRequestContext, token: string): Promise<{ id: string; version: number }> {
  const persona = await corinsVeir(request);
  const active = persona.activeRelease;
  if (!active) throw new Error('no active release');
  const created = await request.post(`/api/v1/personas/${persona.id}/releases`, {
    headers: WRITE_HEADERS,
    data: {
      doctrine: { ...active.doctrine, summary: `Price before you build (test bench ${token}).` },
      style: active.style,
      disclosureText: active.disclosureText,
      allowedModes: active.allowedModes,
    },
  });
  expect(created.status(), 'POST /personas/:id/releases').toBe(201);
  const body = (await created.json()) as { id: string; version: number };
  return { id: body.id, version: body.version };
}

/** Withdraws every pending draft of Corin's vEIR, so no run leaves one behind. */
async function withdrawDrafts(request: APIRequestContext): Promise<void> {
  const persona = await corinsVeir(request);
  for (const release of persona.releases.filter((r) => r.status === 'draft')) {
    const res = await request.post(`/api/v1/persona-releases/${release.id}/withdraw`, {
      headers: WRITE_HEADERS,
    });
    expect([200, 409], 'POST /persona-releases/:id/withdraw').toContain(res.status());
  }
}

async function openBench(page: Page): Promise<void> {
  await page.goto(`/${TENANT}/app/eir/personas`);
  await page.getByRole('link', { name: VEIR }).click();
  await expect(page.getByRole('heading', { level: 1, name: VEIR })).toBeVisible();
  await page.getByRole('tab', { name: 'Test bench' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Test bench' })).toBeVisible();
}

async function ask(page: Page, text: string): Promise<void> {
  const box = page.getByRole('textbox', { name: `Message ${VEIR}` });
  await box.fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
}

test.describe('Test bench', () => {
  test.afterEach(async ({ browser }) => {
    const owner = await browser.newContext({ storageState: OWNER_STATE });
    await withdrawDrafts(owner.request);
    await owner.close();
  });

  test('an EIR tries a draft of their vEIR, sees what the checks did, and nothing is kept', async ({
    browser,
  }) => {
    const token = runToken();
    const owner = await browser.newContext({ storageState: OWNER_STATE });
    const corinCode = await issueAccessCodeViaApi(owner.request, CORIN);
    const draft = await addDraft(owner.request, token);
    await owner.close();

    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page, corinCode);
    await openBench(page);

    const bench = page.getByTestId('test-bench');
    await expect(bench.getByRole('combobox', { name: 'Release' })).toHaveText(
      `Draft v${String(draft.version)}`,
    );
    await expect(bench.getByText('vEIR · AI')).toBeVisible();
    await expect(bench.getByRole('note', { name: 'AI disclosure' })).toBeVisible();

    await test.step('an answer through the founder pipeline, and what the checks did', async () => {
      await ask(page, `How would you test whether students pay for quiet study seats? ${token}`);
      const answer = bench.getByTestId('bench-answer').first();
      await expect(answer).toBeVisible({ timeout: 30_000 });
      await expect(answer).toHaveAttribute('data-status', 'completed');
      const checks = answer.getByRole('button', { name: 'What the checks did' });
      await expect(checks).toHaveAttribute('aria-expanded', 'false');
      await checks.click();
      await expect(checks).toHaveAttribute('aria-expanded', 'true');
      const lines = answer.getByTestId('bench-checks');
      await expect(lines.getByRole('listitem').first()).toBeVisible();
      // Plain words, never the validator's codes.
      await expect(lines).not.toContainText('_');
    });

    await test.step('a crisis message gets the support a founder would get', async () => {
      await ask(page, CRISIS);
      await expect(
        bench.getByRole('region', { name: 'A founder would get support from people' }),
      ).toBeVisible({
        timeout: 30_000,
      });
      await expect(bench.getByTestId('bench-answer')).toHaveCount(2);
      if (SHOTS)
        await page.screenshot({ path: join(SHOTS, 'test-bench-crisis-desktop-light.png'), fullPage: true });
    });

    await test.step('Start over forgets the conversation', async () => {
      await bench.getByRole('button', { name: 'Start over' }).click();
      await expect(bench.getByTestId('bench-answer')).toHaveCount(0);
      await expect(bench.getByText(token)).toHaveCount(0);
    });

    await test.step('nothing is kept after leaving the tab or reloading', async () => {
      await ask(page, `One more question ${token}`);
      await expect(bench.getByTestId('bench-answer')).toHaveCount(1, { timeout: 30_000 });
      await page.getByRole('tab', { name: 'Releases' }).click();
      await page.getByRole('tab', { name: 'Test bench' }).click();
      await expect(page.getByTestId('test-bench').getByTestId('bench-answer')).toHaveCount(0);
      await page.reload();
      await expect(page.getByRole('heading', { level: 2, name: 'Test bench' })).toBeVisible();
      await expect(page.getByText(token)).toHaveCount(0);
      const stored = await page.evaluate(() =>
        [localStorage, sessionStorage]
          .flatMap((store) =>
            Array.from({ length: store.length }, (_, i) => store.getItem(store.key(i) ?? '')),
          )
          .join('\n'),
      );
      expect(stored).not.toContain(token);
    });

    await test.step('the active release can be tried too', async () => {
      const picker = page.getByTestId('test-bench').getByRole('combobox', { name: 'Release' });
      await picker.click();
      await page.getByRole('option', { name: /^Active v\d+$/ }).click();
      await expect(picker).toHaveText(/^Active v\d+$/);
      await ask(page, 'What should we measure first?');
      await expect(page.getByTestId('bench-answer')).toHaveCount(1, { timeout: 30_000 });
    });
    await context.close();
  });

  test('another EIR is not offered the bench on a vEIR they do not curate', async ({ browser }) => {
    const owner = await browser.newContext({ storageState: OWNER_STATE });
    const ruthCode = await issueAccessCodeViaApi(owner.request, RUTH);
    await owner.close();
    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page, ruthCode);
    await page.goto(`/${TENANT}/app/eir/personas`);
    await page.getByRole('link', { name: VEIR }).click();
    await expect(page.getByRole('heading', { level: 1, name: VEIR })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Releases' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Test bench' })).toHaveCount(0);
    await context.close();
  });

  for (const scheme of ['light', 'dark'] as const) {
    test.describe(`${scheme} theme`, () => {
      test.use({ storageState: OWNER_STATE });

      test('meets WCAG 2.2 AA and fits a phone', async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
        const draft = await addDraft(page.request, runToken());
        await openBench(page);
        await useTheme(page, scheme);
        await ask(page, 'How would you test whether students pay for quiet study seats?');
        const answer = page.getByTestId('bench-answer').first();
        await expect(answer).toBeVisible({ timeout: 30_000 });
        await answer.getByRole('button', { name: 'What the checks did' }).click();
        await expect(page.getByTestId('test-bench').getByRole('combobox', { name: 'Release' })).toHaveText(
          `Draft v${String(draft.version)}`,
        );
        await expectNoSeriousA11yViolations(page, `test bench (${scheme})`);
        if (SHOTS)
          await page.screenshot({ path: join(SHOTS, `test-bench-desktop-${scheme}.png`), fullPage: true });

        await page.setViewportSize({ width: 390, height: 844 });
        await expectNoHorizontalScroll(page);
        await expectReachable(page, page.getByRole('textbox', { name: `Message ${VEIR}` }));
        await expectReachable(page, page.getByRole('button', { name: 'Start over' }));
        await expectReachable(
          page,
          page.getByTestId('test-bench').getByRole('combobox', { name: 'Release' }),
        );
        if (SHOTS)
          await page.screenshot({ path: join(SHOTS, `test-bench-mobile-${scheme}.png`), fullPage: true });
      });
    });
  }
});
