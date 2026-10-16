import { expect, test, type APIRequestContext } from '@playwright/test';

import {
  expectNoSeriousA11yViolations,
  issueAccessCodeViaApi,
  OWNER_STATE,
  runToken,
  signIn,
  TENANT,
  useTheme,
} from './support/fixtures';

/*
 * Staff consoles in the shared shell: a program lead assigns a vEIR, an EIR grows their vEIR's common pool
 * (a library note and a published lesson), and an admin turns voice calls off and back on. Each test puts
 * the shared seeded database back the way it found it, even when it fails half-way, so the founder and
 * calls specs are unaffected.
 */

const CORIN = 'Corin Halvorsen';
const EIR_VENTURE = 'EmberLoop';
const SEEDED_VEIR = "Ruth's vEIR";
const WRITE_HEADERS = { 'x-requested-with': 'foundry-ascent', 'content-type': 'application/json' };

async function getItems<T>(request: APIRequestContext, path: string): Promise<T[]> {
  const response = await request.get(`/api/v1${path}`);
  expect(response.status(), `GET ${path}`).toBe(200);
  return ((await response.json()) as { items: T[] }).items;
}

async function settingsCallsEnabled(request: APIRequestContext): Promise<boolean> {
  const response = await request.get('/api/v1/admin/settings');
  expect(response.status(), 'GET /admin/settings').toBe(200);
  const body = (await response.json()) as { callsEnabled?: boolean };
  return body.callsEnabled ?? true;
}

async function enableCalls(request: APIRequestContext): Promise<void> {
  const response = await request.patch('/api/v1/admin/settings', {
    headers: WRITE_HEADERS,
    data: { callsEnabled: true },
  });
  expect(response.status(), 'PATCH /admin/settings').toBe(200);
}

/** Puts the venture back on its seeded vEIR (reviewed by that vEIR's own EIR) through the API. */
async function restoreSeededAssignment(request: APIRequestContext): Promise<void> {
  const ventures = await getItems<{ id: string; name: string; personaName: string | null }>(
    request,
    '/program/ventures',
  );
  const venture = ventures.find((v) => v.name === EIR_VENTURE);
  if (!venture || venture.personaName === SEEDED_VEIR) return;
  const personas = await getItems<{ id: string; name: string; eirProfile: { id: string } | null }>(
    request,
    '/personas',
  );
  const seeded = personas.find((p) => p.name === SEEDED_VEIR);
  if (!seeded) throw new Error(`${SEEDED_VEIR} is missing from the seed`);
  const response = await request.post(`/api/v1/ventures/${venture.id}/assignment`, {
    headers: WRITE_HEADERS,
    data: { personaId: seeded.id, eirProfileId: seeded.eirProfile?.id ?? null },
  });
  expect(response.status(), 'POST /ventures/:id/assignment').toBe(200);
}

test.describe('program lead', () => {
  test.use({ storageState: OWNER_STATE });
  test.afterEach(async ({ page }) => {
    await restoreSeededAssignment(page.request);
  });

  test('assigns a vEIR to a venture and sees who coaches what', async ({ page }) => {
    await page.goto(`/${TENANT}/app/program`);
    const nav = page.getByRole('navigation', { name: 'Main' });
    await nav.getByRole('link', { name: 'vEIRs & assignments' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'vEIRs & assignments' })).toBeVisible();

    const row = page.getByRole('row', { name: new RegExp(EIR_VENTURE) });
    await expect(row).toContainText(SEEDED_VEIR);

    const assign = async (veir: string) => {
      await row.getByRole('button', { name: `Change the vEIR of ${EIR_VENTURE}` }).click();
      const dialog = page.getByRole('dialog', { name: `vEIR for ${EIR_VENTURE}` });
      await dialog.getByRole('combobox', { name: 'vEIR' }).click();
      await page.getByRole('option', { name: veir }).click();
      await dialog.getByRole('button', { name: 'Assign' }).click();
      await expect(dialog).toBeHidden();
    };

    await assign("Corin's vEIR");
    await expect(row).toContainText("Corin's vEIR");
    await expect(row).toContainText(CORIN);
    // The filter chips count who coaches what.
    await expect(page.getByRole('button', { name: /^Corin's vEIR\s*3$/ })).toBeVisible();

    // Back to the seeded assignment.
    await assign(SEEDED_VEIR);
    await expect(row).toContainText('Ruth Abernathy-Song');
  });
});

test.describe('EIR', () => {
  test('adds a note to their vEIR’s library and publishes a lesson', async ({ browser }) => {
    const token = runToken();
    const owner = await browser.newContext({ storageState: OWNER_STATE });
    const corinCode = await issueAccessCodeViaApi(owner.request, CORIN);
    await owner.close();

    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page, corinCode);
    // An EIR without ventures lands in the EIR studio.
    await expect(page.getByRole('heading', { level: 1, name: 'Personas' })).toBeVisible();
    await page.getByRole('link', { name: "Corin's vEIR" }).click();
    await expect(page.getByRole('heading', { level: 1, name: "Corin's vEIR" })).toBeVisible();

    await test.step('a library note', async () => {
      await page.getByRole('tab', { name: 'Knowledge library' }).click();
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Note' }).click();
      const form = page.getByRole('form', { name: 'New note' });
      await form.getByRole('textbox', { name: /^Title/ }).fill(`Ask what it cost ${token}`);
      await form
        .getByRole('textbox', { name: /^Text/ })
        .fill('When a founder reports a problem, ask what it cost the customer the last time it happened.');
      await form.getByRole('button', { name: 'Add to library' }).click();
      await expect(form).toBeHidden();
      const list = page.getByRole('list', { name: 'Library sources' });
      await expect(list.getByText(`Ask what it cost ${token}`)).toBeVisible();
    });

    const lessonTitle = `Count commitments, not compliments ${token}`;
    await test.step('a lesson drafted, found in Lessons to review, then published', async () => {
      await page.getByRole('tab', { name: 'Lessons', exact: true }).click();
      await page.getByRole('button', { name: 'New lesson' }).click();
      const form = page.getByRole('form', { name: 'New lesson' });
      const fields: [RegExp, string][] = [
        [/^Title/, lessonTitle],
        [/^Context/, 'Early discovery with friendly interviewees.'],
        [/^Signal/, 'The founder counts compliments as demand.'],
        [/^What helps/, 'Ask for a commitment that costs the customer something.'],
        [/^Outcome/, 'The team learns which signals hold up.'],
        [/^Limits/, 'Less useful once paid pilots exist.'],
      ];
      for (const [name, value] of fields) await form.getByRole('textbox', { name }).fill(value);
      await form.getByRole('button', { name: 'Save draft' }).click();
      await expect(form).toBeHidden();

      await page
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link', { name: 'Lessons to review' })
        .click();
      await expect(page.getByRole('heading', { level: 1, name: 'Lessons to review' })).toBeVisible();
      await page.getByRole('link', { name: lessonTitle }).click();

      const sheet = page.getByRole('dialog', { name: lessonTitle });
      await expect(sheet).toBeVisible();
      await sheet.getByRole('button', { name: 'Publish' }).click();
      await expect(sheet).toBeHidden();
      await page.getByRole('button', { name: /^Published/ }).click();
      await expect(page.getByRole('list', { name: 'Lessons' }).getByText(lessonTitle)).toBeVisible();
    });

    // Corin curates only his own vEIR.
    await page.goto(`/${TENANT}/app/eir/personas`);
    await page.getByRole('link', { name: "Ruth's vEIR" }).click();
    await page.getByRole('tab', { name: 'Knowledge library' }).click();
    await expect(page.getByRole('list', { name: 'Library sources' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Suspend', exact: true })).toHaveCount(0);
    await context.close();
  });
});

test.describe('platform admin', () => {
  test.use({ storageState: OWNER_STATE });
  test.afterEach(async ({ page }) => {
    await enableCalls(page.request);
  });

  test('turns voice calls off and back on', async ({ page }) => {
    await page.goto(`/${TENANT}/app/admin/settings`);
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    const calls = page.getByRole('switch', { name: 'Voice calls' });
    await expect(calls).toBeChecked();

    await calls.click();
    const confirm = page.getByRole('alertdialog', { name: 'Turn off voice calls?' });
    await confirm.getByRole('button', { name: 'Turn off calls' }).click();
    await expect(calls).not.toBeChecked();
    expect(await settingsCallsEnabled(page.request)).toBe(false);

    await calls.click();
    await expect(calls).toBeChecked();
    expect(await settingsCallsEnabled(page.request)).toBe(true);
  });
});

for (const scheme of ['dark', 'light'] as const) {
  test.describe(`staff consoles · ${scheme} theme`, () => {
    test.use({ storageState: OWNER_STATE });
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    });

    test('persona sections, lessons, assignments and the admin pages meet WCAG 2.2 AA', async ({ page }) => {
      await page.goto(`/${TENANT}/app/eir/personas`);
      await useTheme(page, scheme);
      await page.getByRole('link', { name: "Corin's vEIR" }).click();
      await expect(page.getByRole('heading', { level: 1, name: "Corin's vEIR" })).toBeVisible();
      await expectNoSeriousA11yViolations(page, `persona overview (${scheme})`);
      for (const tab of ['Knowledge library', 'Lessons', 'Consent', 'Voice & face'] as const) {
        await page.getByRole('tab', { name: tab }).click();
        await expect(page.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
        await expectNoSeriousA11yViolations(page, `persona ${tab} (${scheme})`);
      }

      await page.goto(`/${TENANT}/app/eir/lessons`);
      await expect(page.getByRole('heading', { level: 1, name: 'Lessons to review' })).toBeVisible();
      await expectNoSeriousA11yViolations(page, `lessons to review (${scheme})`);

      await page.goto(`/${TENANT}/app/program/assignments`);
      await expect(page.getByRole('table')).toBeVisible();
      await expectNoSeriousA11yViolations(page, `assignments (${scheme})`);

      await page.goto(`/${TENANT}/app/admin/settings`);
      await expect(page.getByRole('switch', { name: 'Voice calls' })).toBeVisible();
      await expectNoSeriousA11yViolations(page, `admin settings (${scheme})`);

      await page.goto(`/${TENANT}/app/admin/usage`);
      await expect(page.getByRole('heading', { level: 1, name: 'Usage' })).toBeVisible();
      await expectNoSeriousA11yViolations(page, `admin usage (${scheme})`);

      await page.goto(`/${TENANT}/app/admin/audit`);
      await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeVisible();
      await expect(page.getByRole('table')).toBeVisible();
      await expectNoSeriousA11yViolations(page, `admin audit (${scheme})`);
    });

    test('the EIR inbox and calibration reviews meet WCAG 2.2 AA', async ({ browser }) => {
      const owner = await browser.newContext({ storageState: OWNER_STATE });
      const corinCode = await issueAccessCodeViaApi(owner.request, CORIN);
      await owner.close();
      // Signed out: contexts made here otherwise inherit the owner's storage state from this describe.
      const context = await browser.newContext({
        storageState: { cookies: [], origins: [] },
        colorScheme: scheme,
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      await signIn(page, corinCode);
      await useTheme(page, scheme);

      // Their filters are toggle-button groups (FilterChips), never tabs without panels; with nothing
      // routed or sampled yet, a page shows its empty state alone.
      await page.goto(`/${TENANT}/app/eir/inbox`);
      await expect(page.getByRole('heading', { level: 1, name: 'Escalation inbox' })).toBeVisible();
      await expect(
        page.getByRole('group', { name: 'Filter escalations' }).or(page.getByText('Nothing routed to you')),
      ).toBeVisible();
      await expect(page.getByRole('tab')).toHaveCount(0);
      await expectNoSeriousA11yViolations(page, `EIR inbox (${scheme})`);

      await page.goto(`/${TENANT}/app/eir/reviews`);
      await expect(page.getByRole('heading', { level: 1, name: 'Calibration reviews' })).toBeVisible();
      await expect(
        page.getByRole('group', { name: 'Filter samples' }).or(page.getByText('No samples to review')),
      ).toBeVisible();
      await expect(page.getByRole('tab')).toHaveCount(0);
      await expectNoSeriousA11yViolations(page, `calibration reviews (${scheme})`);
      await context.close();
    });
  });
}
