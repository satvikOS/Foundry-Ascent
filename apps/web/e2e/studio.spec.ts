import { expect, type APIRequestContext } from '@playwright/test';

import {
  expectNoSeriousA11yViolations,
  issueAccessCodeViaApi,
  OWNER_STATE,
  runToken,
  signIn,
  takeRevealedCode,
  TENANT,
  useTheme,
  test,
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

  test('opens a venture’s Team without being a member: its name, only pages it can open, Invite', async ({
    page,
  }) => {
    const refused: string[] = [];
    page.on('response', (response) => {
      if (response.url().includes('/api/v1/') && response.status() >= 400) {
        refused.push(`${String(response.status())} ${new URL(response.url()).pathname}`);
      }
    });
    await page.goto(`/${TENANT}/app/program/ventures`);
    const row = page.getByRole('row', { name: /QuietQuad/ });
    await row.getByRole('button', { name: /^Actions for / }).click();
    await page.getByRole('menuitem', { name: 'Team' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Team' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'About Team' })).toHaveAccessibleDescription(
      'People on QuietQuad and what each can see.',
    );
    await expect(page.getByRole('list', { name: 'Team members' })).toContainText('Maya Okafor-Lindqvist');

    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(
      nav.getByRole('button', { name: 'Switch venture or workspace. Current: QuietQuad' }),
    ).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Team', exact: true })).toBeVisible();
    // The venture's other pages would refuse a non-member: none is linked.
    for (const name of ['Knowledge', 'Documents', 'Human help', 'New chat']) {
      await expect(nav.getByRole('link', { name, exact: true })).toHaveCount(0);
    }

    // Invite opens for this venture (closed again without inviting anyone).
    await page.getByRole('button', { name: 'Invite', exact: true }).click();
    const invite = page.getByRole('dialog', { name: 'Invite to QuietQuad' });
    await expect(invite).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(invite).toBeHidden();
    expect(refused, 'requests the page made that the API refused').toEqual([]);
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

/** A name part of letters only, new on every run (a vEIR's name derives from the EIR's first name). */
function lettersToken(): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const stamp = Date.now()
    .toString(36)
    .replace(/\d/g, (digit) => letters.charAt(Number(digit)));
  const random = Array.from({ length: 3 }, () => letters.charAt(Math.floor(Math.random() * 26))).join('');
  return `${stamp}${random}`;
}

test.describe('EIR registry', () => {
  test('a program lead adds an EIR; the EIR records consent; their vEIR is built and released', async ({
    browser,
  }) => {
    const first = `Noor${lettersToken()}`;
    const full = `${first} Haddad`;
    const veir = `${first}'s vEIR`;
    const owner = await browser.newContext({ storageState: OWNER_STATE });
    const page = await owner.newPage();

    let code = '';
    await test.step('the person is invited with the EIR role (People & access)', async () => {
      await page.goto(`/${TENANT}/app/admin/principals`);
      await page.getByRole('button', { name: 'Add principal' }).click();
      const add = page.getByRole('dialog', { name: 'Add a principal' });
      await add.getByRole('textbox', { name: /^Name/ }).fill(full);
      await add.getByRole('checkbox', { name: 'EIR' }).check();
      await add.getByRole('button', { name: 'Add principal' }).click();
      await page.getByRole('button', { name: 'Issue access code' }).click();
      const issue = page.getByRole('dialog', { name: 'Issue access code' });
      await issue.getByRole('textbox', { name: 'Label' }).fill('EIR invitation');
      await issue.getByRole('button', { name: 'Issue code' }).click();
      code = await takeRevealedCode(page, full);
    });

    const row = page.getByRole('table', { name: 'EIRs' }).getByRole('row', { name: new RegExp(full) });
    await test.step('Add EIR links them, with no consent implied', async () => {
      await page.goto(`/${TENANT}/app/eir/personas`);
      await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'EIRs' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'EIRs' })).toBeVisible();
      await page.getByRole('button', { name: 'Add EIR' }).click();
      const form = page.getByRole('form', { name: 'Add EIR' });
      await form.getByRole('combobox', { name: /^Person/ }).click();
      await page.getByRole('option', { name: full }).click();
      await expect(form.getByRole('textbox', { name: /^Name/ })).toHaveValue(full);
      await form.getByRole('textbox', { name: /^Title/ }).fill('Former VP Sales, Gridline');
      await form.getByRole('textbox', { name: /^Areas of expertise/ }).fill('Pricing, B2B sales');
      await form
        .getByRole('textbox', { name: /^Bio/ })
        .fill('Built the sales team at a grid-storage company from zero to forty people.');
      await form.getByRole('button', { name: 'Add EIR' }).click();
      await expect(form).toBeHidden();
      await expect(row).toContainText('Former VP Sales, Gridline');
      await expect(row).toContainText('b2b sales');
      await expect(row).toContainText('No vEIR yet');
      await expect(row).toContainText('Consent needed before a vEIR can be released');
    });

    await test.step('New vEIR starts from them and waits for their consent', async () => {
      await row.getByRole('link', { name: `New vEIR for ${full}` }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'New vEIR' })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue(veir);
      await page.getByRole('button', { name: 'Continue' }).click();
      const editor = page.getByRole('form', { name: 'Doctrine & style' });
      const fields: [RegExp, string][] = [
        [/^Summary/, 'Pricing and sales discipline for early B2B ventures.'],
        [/^Evidence standard/, 'A paid commitment beats a compliment.'],
        [/^Red lines/, 'No legal or investment advice.'],
        [/^Escalation topics/, 'Contracts and term sheets'],
        [/^Feedback structure/, 'What works, what to test next, one question.'],
      ];
      for (const [name, value] of fields) await editor.getByRole('textbox', { name }).fill(value);
      await editor.getByRole('button', { name: 'Create vEIR' }).click();
      await expect(page.getByRole('heading', { level: 1, name: veir })).toBeVisible();
      // It opens on its Consent tab: consent is the EIR's own act.
      await expect(page.getByText(`Only ${full} can record it.`)).toBeVisible();
      await page.goto(`/${TENANT}/app/eir/eirs`);
      await expect(row.getByRole('link', { name: veir })).toBeVisible();
      await expect(row).toContainText('Consent needed before a vEIR can be released');
    });

    await test.step('the EIR signs in, records consent and releases v1', async () => {
      const context = await browser.newContext();
      const eir = await context.newPage();
      await signIn(eir, code);
      await expect(eir.getByRole('heading', { level: 1, name: 'Personas' })).toBeVisible();
      await eir.getByRole('link', { name: veir }).click();
      await eir.getByRole('tab', { name: 'Consent' }).click();
      await eir.getByRole('button', { name: 'Record consent' }).click();
      const consent = eir.getByRole('dialog', { name: `Record ${full}’s consent` });
      await consent.getByRole('button', { name: 'Record consent' }).click();
      await expect(consent).toBeHidden();
      await expect(eir.getByText(`${full}’s consent is in force.`)).toBeVisible();
      await eir.getByRole('tab', { name: 'Releases' }).click();
      await eir.getByRole('button', { name: 'Approve…' }).click();
      await eir
        .getByRole('alertdialog', { name: `Approve v1 of ${veir}?` })
        .getByRole('button', { name: 'Approve release' })
        .click();
      await expect(eir.getByText('v1 is now active')).toBeVisible();
      await context.close();
    });

    await test.step('the EIR list shows the consent on file', async () => {
      await page.reload();
      await expect(row.getByRole('link', { name: veir })).toBeVisible();
      await expect(row).toContainText('Consent on file');
    });
    await owner.close();
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

  test('limits side by side line up on one row, even when a label or helper wraps', async ({ page }) => {
    const rows = [
      ['Platform cap per day', 'Cap per person per day'],
      ['Longest call (minutes)', 'Call minutes per person per day'],
      ['Documents per day', 'Upload volume per day (MB)'],
      ['Max turns per session', 'Grounding threshold (%)', 'Portfolio minimum group size (k)'],
    ];
    // Wide, and narrow enough that more helpers wrap while the fields still sit side by side.
    for (const width of [1440, 900]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/${TENANT}/app/admin/settings`);
      const form = page.getByRole('form', { name: 'Limits and thresholds' });
      await expect(form).toBeVisible();
      for (const names of rows) {
        const inputs: { x: number; y: number }[] = [];
        const labels: number[] = [];
        for (const name of names) {
          const input = await form.getByRole('spinbutton', { name, exact: true }).boundingBox();
          const label = await form.getByText(name, { exact: true }).boundingBox();
          if (!input || !label) throw new Error(`${name} has no layout box`);
          inputs.push(input);
          labels.push(label.y);
        }
        const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
        expect(
          new Set(inputs.map((box) => Math.round(box.x))).size,
          `${names.join(' | ')} side by side`,
        ).toBe(names.length);
        expect(
          spread(inputs.map((box) => box.y)),
          `inputs of ${names.join(' | ')} at ${String(width)}px`,
        ).toBeLessThan(1);
        expect(spread(labels), `labels of ${names.join(' | ')} at ${String(width)}px`).toBeLessThan(1);
      }
    }
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

      await page.goto(`/${TENANT}/app/eir/eirs`);
      await expect(page.getByRole('table', { name: 'EIRs' })).toBeVisible();
      await expectNoSeriousA11yViolations(page, `EIRs (${scheme})`);
      await page.getByRole('button', { name: 'Add EIR' }).click();
      await expect(page.getByRole('form', { name: 'Add EIR' })).toBeVisible();
      await expectNoSeriousA11yViolations(page, `Add EIR (${scheme})`);
      await page.keyboard.press('Escape');

      await page.goto(`/${TENANT}/app/program/assignments`);
      await expect(page.getByRole('table')).toBeVisible();
      await expectNoSeriousA11yViolations(page, `assignments (${scheme})`);

      await page.goto(`/${TENANT}/app/admin/settings`);
      await expect(page.getByRole('switch', { name: 'Voice calls' })).toBeVisible();
      await expectNoSeriousA11yViolations(page, `admin settings (${scheme})`);

      await page.goto(`/${TENANT}/app/admin/usage`);
      await expect(page.getByRole('heading', { level: 1, name: 'Usage' })).toBeVisible();
      // Conversations and memory: counts only (GET /admin/insights).
      const insights = page.getByRole('region', { name: 'Conversations and memory' });
      await expect(insights.getByRole('table', { name: 'What each venture’s vEIR remembers' })).toBeVisible();
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
