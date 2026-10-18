import { expect, type APIRequestContext, type Page } from '@playwright/test';

import {
  expectNoSeriousA11yViolations,
  FOUNDER_STATE,
  issueAccessCodeViaApi,
  openVenture,
  OWNER_STATE,
  runToken,
  signIn,
  startConversation,
  TENANT,
  useTheme,
  test,
  expectNoBareEirName,
} from './support/fixtures';

/*
 * The Knowledge page: the venture's specific pool. Runs as QuietQuad's founder against the seeded data
 * (QuietQuad's notebook from its seeded conversation with Corin's vEIR). Every test puts the notebook
 * back and deletes the memory it adds, so reruns against one database behave the same.
 */

test.use({ storageState: FOUNDER_STATE });

const WRITE_HEADERS = { 'x-requested-with': 'foundry-ascent', 'content-type': 'application/json' };
const EIR_NAME = 'Corin Halvorsen';
const ADVISOR_NAME = 'Graham Fenwick-Tate';

interface Notebook {
  version: number;
  founderProfile: { id: string; text: string }[];
  nextOpener: string | null;
}

async function readNotebook(request: APIRequestContext, ventureId: string): Promise<Notebook> {
  const response = await request.get(`/api/v1/ventures/${ventureId}/notebook`);
  expect(response.status(), 'GET /ventures/:id/notebook').toBe(200);
  return (await response.json()) as Notebook;
}

async function editNotebook(
  request: APIRequestContext,
  ventureId: string,
  edit: Record<string, unknown>,
): Promise<void> {
  const { version } = await readNotebook(request, ventureId);
  const response = await request.patch(`/api/v1/ventures/${ventureId}/notebook`, {
    headers: WRITE_HEADERS,
    data: { expectedVersion: version, edit },
  });
  expect(response.status(), 'PATCH /ventures/:id/notebook').toBe(200);
}

/** Delete memory items a test added (the founder may delete any item of their venture). */
async function deleteMemory(request: APIRequestContext, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    const response = await request.patch(`/api/v1/memory/${id}`, {
      headers: WRITE_HEADERS,
      data: { action: 'delete' },
    });
    expect([204, 404], `PATCH /memory/${id} delete`).toContain(response.status());
  }
}

async function openKnowledge(page: Page): Promise<string> {
  const ventureId = await openVenture(page);
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: /^Knowledge/ })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Knowledge' })).toBeVisible();
  return ventureId;
}

test.describe('what the vEIR knows', () => {
  test('a founder corrects a notebook line and removes the opening line', async ({ page }) => {
    const token = runToken();
    const ventureId = await openKnowledge(page);
    const original = await readNotebook(page.request, ventureId);
    const line = original.founderProfile[0];
    if (!line) throw new Error('QuietQuad’s seeded notebook is missing');
    // Distillation and deleted conversations legitimately change the opener between runs: give the notebook
    // one to remove when it has none, and put back whatever was there afterwards.
    const opener = original.nextOpener ?? 'How did the library-staff interviews go?';
    if (original.nextOpener === null) {
      await editNotebook(page.request, ventureId, { action: 'edit_opener', text: opener });
      await page.reload();
    }

    try {
      await page.getByRole('tab', { name: 'Notebook' }).click();
      await expect(page).toHaveURL(/view=notebook/);
      await expect(
        page.getByRole('heading', { level: 2, name: /^What Corin(?:['’]s| ·) vEIR knows$/ }),
      ).toBeVisible();
      await expect(page.getByText(/never treated as facts/)).toBeVisible();

      // Correct one line in place.
      const about = page.getByRole('region', { name: 'About you' });
      const item = about.getByRole('listitem').filter({ hasText: line.text });
      await item.hover();
      await item.getByRole('button', { name: 'Edit' }).click();
      const box = about.getByRole('textbox', { name: 'Edit note' });
      await box.fill(`Likes the numbers first (${token}).`);
      await box.press('Enter');
      await expect(about.getByText(`Likes the numbers first (${token}).`)).toBeVisible();

      // Remove the line the vEIR would open the next conversation with.
      const next = page.getByRole('region', { name: 'Next conversation' });
      await expect(next).toContainText(opener);
      await next.hover();
      await next.getByRole('button', { name: 'Remove' }).click();
      await expect(next).toHaveCount(0);

      // Both changes are saved, not just shown.
      await page.reload();
      await expect(page.getByRole('region', { name: 'About you' })).toContainText(token);
      await expect(page.getByRole('region', { name: 'Next conversation' })).toHaveCount(0);
      const saved = await readNotebook(page.request, ventureId);
      expect(saved.nextOpener).toBeNull();
      expect(saved.founderProfile[0]?.text).toContain(token);
    } finally {
      // Put the seeded notes back for the other specs and later runs.
      const current = await readNotebook(page.request, ventureId);
      if (current.founderProfile.some((entry) => entry.id === line.id && entry.text !== line.text)) {
        await editNotebook(page.request, ventureId, {
          action: 'edit_entry',
          section: 'founderProfile',
          id: line.id,
          text: line.text,
        });
      }
      if (original.nextOpener === null) {
        if (current.nextOpener !== null) {
          await editNotebook(page.request, ventureId, { action: 'remove_opener' });
        }
      } else if (current.nextOpener !== original.nextOpener) {
        await editNotebook(page.request, ventureId, { action: 'edit_opener', text: original.nextOpener });
      }
    }
  });
});

test.describe('memory', () => {
  test('what others add is simply in Knowledge, to edit or forget: there is no review queue', async ({
    page,
    browser,
  }) => {
    const token = runToken();
    const ventureId = await openVenture(page);

    // The venture's EIR adds two items for the team.
    const owner = await browser.newContext({ storageState: OWNER_STATE });
    const eirCode = await issueAccessCodeViaApi(owner.request, EIR_NAME);
    await owner.close();
    const eir = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const eirPage = await eir.newPage();
    await signIn(eirPage, eirCode);
    const toEdit = `Libraries count doors hourly ${token}`;
    const toForget = `Exam weeks double demand ${token}`;
    const added: string[] = [];
    for (const title of [toEdit, toForget]) {
      const created = await eirPage.request.post(`/api/v1/ventures/${ventureId}/memory`, {
        headers: WRITE_HEADERS,
        data: { type: 'evidence', title, content: `Added by the EIR (${token}).` },
      });
      expect(created.status(), 'POST /ventures/:id/memory as the EIR').toBe(201);
      added.push(((await created.json()) as { id: string }).id);
    }
    await eir.close();

    try {
      // An old link to the review queue opens the memory list, where both items already are.
      await page.goto(`/${TENANT}/app/v/${ventureId}/knowledge?view=proposed`);
      await expect(page.getByRole('tab', { name: /^To review/ })).toHaveCount(0);
      await expect(page.getByRole('tab', { name: 'Memory' })).toHaveAttribute('aria-selected', 'true');
      await page.getByRole('searchbox', { name: 'Search' }).fill(token);
      const list = page.getByRole('list', { name: 'Memory' });
      const rows = list.getByRole('listitem').filter({ hasText: token });
      await expect(rows).toHaveCount(2);
      // Each says where it came from; nothing asks to be approved.
      for (const row of await rows.all()) await expect(row).toContainText(`Added by ${EIR_NAME} on`);
      await expect(page.getByRole('button', { name: /^(Approve|Reject|Keep|Not now)\b/ })).toHaveCount(0);
      await expect(page.getByRole('checkbox')).toHaveCount(0);

      // Edit one from its row: saved as a new version.
      const edited = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/memory/${added[0] ?? ''}`) && response.request().method() === 'PATCH',
      );
      await page.getByRole('button', { name: `Actions for ${toEdit}` }).click();
      await page.getByRole('menuitem', { name: 'Edit' }).click();
      const dialog = page.getByRole('dialog', { name: 'Edit memory' });
      await dialog.getByRole('textbox', { name: /Title/ }).fill(`Libraries count doors every hour ${token}`);
      await dialog.getByRole('button', { name: 'Save' }).click();
      const newVersion = (await (await edited).json()) as { id: string };
      added.push(newVersion.id);
      await expect(list.getByRole('listitem').filter({ hasText: `every hour ${token}` })).toBeVisible();

      // Forget the other: it asks first, then it is gone.
      await page.getByRole('button', { name: `Actions for ${toForget}` }).click();
      await page.getByRole('menuitem', { name: 'Forget…' }).click();
      const confirm = page.getByRole('alertdialog', { name: 'Forget this?' });
      await confirm.getByRole('button', { name: 'Forget' }).click();
      await expect(list.getByRole('listitem').filter({ hasText: toForget })).toHaveCount(0);
      await expect
        .poll(async () => (await page.request.get(`/api/v1/memory/${added[1] ?? ''}`)).status(), {
          message: 'the forgotten item is gone',
        })
        .toBe(404);
    } finally {
      await deleteMemory(page.request, added);
    }
  });

  test('a replaced item keeps its detail and history', async ({ page }) => {
    const token = runToken();
    const ventureId = await openVenture(page);
    const created = await page.request.post(`/api/v1/ventures/${ventureId}/memory`, {
      headers: WRITE_HEADERS,
      data: { type: 'fact', title: `Seats counted at nine ${token}`, content: `Counted at 9:00 (${token}).` },
    });
    expect(created.status(), 'POST /ventures/:id/memory').toBe(201);
    const original = (await created.json()) as { id: string };
    const corrected = await page.request.patch(`/api/v1/memory/${original.id}`, {
      headers: WRITE_HEADERS,
      data: { action: 'correct', patch: { title: `Seats counted hourly ${token}` } },
    });
    expect(corrected.status(), 'PATCH /memory/:id correct').toBe(200);
    const replacement = (await corrected.json()) as { id: string };

    try {
      // The replaced version is listed under Superseded and opens with its detail.
      await page.goto(`/${TENANT}/app/v/${ventureId}/knowledge?status=superseded`);
      await page
        .getByRole('list', { name: 'Memory' })
        .getByRole('button', { name: new RegExp(`^Seats counted at nine ${token}`) })
        .click();
      const panel = page.getByRole('complementary', { name: 'Memory inspector' });
      await expect(panel.getByRole('heading', { name: `Seats counted at nine ${token}` })).toBeVisible();
      await expect(panel).not.toContainText('no longer in memory');
      await expect(panel.getByRole('region', { name: 'History' })).toBeVisible();

      // A link to an item opens the panel even after the person closed it; the new version links to
      // the one it replaced.
      await panel.getByRole('button', { name: 'Close inspector' }).click();
      await expect(panel).toHaveCount(0);
      await page.goto(`/${TENANT}/app/v/${ventureId}/knowledge?m=${replacement.id}`);
      await expect(panel.getByRole('heading', { name: `Seats counted hourly ${token}` })).toBeVisible();
      await panel.getByRole('link', { name: 'earlier version' }).click();
      await expect(page).toHaveURL(new RegExp(`m=${original.id}`));
      await expect(panel.getByRole('heading', { name: `Seats counted at nine ${token}` })).toBeVisible();
      await expect(panel).not.toContainText('no longer in memory');
    } finally {
      await deleteMemory(page.request, [replacement.id, original.id]);
    }
  });

  test('editing a disputed item settles it, with no approve step', async ({ page }) => {
    const token = runToken();
    const ventureId = await openVenture(page);
    const created = await page.request.post(`/api/v1/ventures/${ventureId}/memory`, {
      headers: WRITE_HEADERS,
      data: {
        type: 'fact',
        title: `Door counter undercounts ${token}`,
        content: `Checked twice (${token}).`,
      },
    });
    expect(created.status(), 'POST /ventures/:id/memory').toBe(201);
    const item = (await created.json()) as { id: string };
    const ids = [item.id];
    try {
      const disputed = await page.request.patch(`/api/v1/memory/${item.id}`, {
        headers: WRITE_HEADERS,
        data: { action: 'dispute', reason: 'The counter was miscalibrated' },
      });
      expect(disputed.status(), 'PATCH /memory/:id dispute').toBe(200);

      await page.goto(`/${TENANT}/app/v/${ventureId}/knowledge?m=${item.id}`);
      const panel = page.getByRole('complementary', { name: 'Memory inspector' });
      await expect(panel.getByRole('heading', { name: `Door counter undercounts ${token}` })).toBeVisible();
      await expect(panel.getByRole('button', { name: /Approve|Reject|Dispute/ })).toHaveCount(0);
      const saved = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/memory/${item.id}`) && response.request().method() === 'PATCH',
      );
      await panel.getByRole('button', { name: 'Edit', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Edit memory' });
      await dialog
        .getByRole('textbox', { name: /Title/ })
        .fill(`Door counter undercounts by a tenth ${token}`);
      await dialog.getByRole('button', { name: 'Save' }).click();
      const next = (await (await saved).json()) as { id: string; status: string };
      ids.push(next.id);
      expect(next.status).toBe('confirmed');
      await expect(page.getByRole('region', { name: /Notifications/ }).getByText('Saved')).toBeVisible();
    } finally {
      await deleteMemory(page.request, ids);
    }
  });

  test('editing what the vEIR learned in a conversation saves the edit, with nothing to approve', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await openVenture(page);
    // The founder says what is worth remembering in their own words, a fact and a decision (the coach's framing
    // alone is never kept): any model that keeps what founders decide saves it with this answer.
    await startConversation(
      page,
      `How should we price the pilot for libraries? Willingness to pay has not been tested with a paid commitment yet. We've decided to ask each library for a paid commitment before the pilot starts. ${runToken()}`,
    );
    const saved = page.getByRole('article', { name: 'Exchange 1' }).getByTestId('memory-saved');
    await expect(saved).toBeVisible({ timeout: 30_000 });
    const href = (await saved.getByRole('link').getAttribute('href')) ?? '';
    const memoryId = /[?&]m=([0-9a-f-]{36})/.exec(href)?.[1] ?? '';
    expect(memoryId, 'the saved line links the item in Knowledge').not.toBe('');
    const ids = [memoryId];
    try {
      await saved.getByRole('link').click();
      const panel = page.getByRole('complementary', { name: 'Memory inspector' });
      await expect(panel.getByText(/^Learned from /)).toBeVisible();
      const corrected = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/memory/${memoryId}`) && response.request().method() === 'PATCH',
      );
      await panel.getByRole('button', { name: 'Edit', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: /^Edit / });
      const title = dialog.getByRole('textbox', { name: /^Title/ });
      const edited = `${await title.inputValue()} (checked with two librarians)`;
      await title.fill(edited);
      await dialog.getByRole('button', { name: /^Save/ }).click();
      // Whether it was still a suggestion (kept first) or kept automatically, the edit is saved: a new version.
      const response = await corrected;
      expect(response.status(), 'PATCH /memory/:id correct').toBe(200);
      const next = (await response.json()) as { id: string; status: string; title: string };
      ids.push(next.id);
      expect(next).toMatchObject({ status: 'confirmed', title: edited });
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('region', { name: /Notifications/ }).getByText('Saved')).toBeVisible();
    } finally {
      await deleteMemory(page.request, ids);
    }
  });

  test('type chips filter the memory list', async ({ page }) => {
    const ventureId = await openKnowledge(page);
    const list = page.getByRole('list', { name: 'Memory' });
    await expect(list.getByRole('button', { name: /^Keep the student app free/ })).toBeVisible();

    const chips = page.getByRole('group', { name: 'Type' });
    await chips.getByRole('button', { name: /^Decision \d+$/ }).click();
    await expect(page).toHaveURL(new RegExp(`/${TENANT}/app/v/${ventureId}/knowledge\\?type=decision$`));
    await expect(
      list.getByRole('button', { name: /^Focus the first version on exam-week peaks/ }),
    ).toBeVisible();
    await expect(list.getByRole('button', { name: /^Keep the student app free/ })).toHaveCount(0);
    for (const item of await list.getByRole('listitem').all()) await expect(item).toContainText('Decision');

    // Selecting the chip again clears the filter.
    await chips.getByRole('button', { name: /^Decision \d+$/ }).click();
    await expect(page).toHaveURL(new RegExp(`/${TENANT}/app/v/${ventureId}/knowledge$`));
    await expect(list.getByRole('button', { name: /^Keep the student app free/ })).toBeVisible();
  });
});

test.describe('human help', () => {
  test('people who only read the venture get a calm page and no refused requests', async ({
    page,
    browser,
  }) => {
    const ventureId = await openVenture(page);
    const owner = await browser.newContext({ storageState: OWNER_STATE });
    const codes = {
      eir: await issueAccessCodeViaApi(owner.request, EIR_NAME),
      advisor: await issueAccessCodeViaApi(owner.request, ADVISOR_NAME),
    };
    await owner.close();

    for (const role of ['eir', 'advisor'] as const) {
      const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
      const viewer = await context.newPage();
      const refused: string[] = [];
      viewer.on('response', (response) => {
        if (response.url().includes('/escalations') && response.status() === 403)
          refused.push(response.url());
      });
      await signIn(viewer, codes[role]);
      if (role === 'eir') {
        await viewer.goto(`/${TENANT}/app/v/${ventureId}/help`);
        await expect(
          viewer.getByRole('heading', { level: 2, name: 'Requests for you arrive in your inbox' }),
        ).toBeVisible();
        await expect(viewer.getByRole('link', { name: 'Open inbox' })).toBeVisible();
      } else {
        // The advisor lands in their own venture (SoleSignal).
        await viewer.goto(`/${TENANT}/app`);
        await viewer.waitForURL(/\/app\/v\/[0-9a-f-]{36}/);
        const advisorVenture = /\/app\/v\/([0-9a-f-]{36})/.exec(viewer.url())?.[1] ?? '';
        await viewer.goto(`/${TENANT}/app/v/${advisorVenture}/help`);
        await expect(
          viewer.getByRole('heading', { level: 2, name: 'Only the venture team sees requests' }),
        ).toBeVisible();
      }
      await expect(viewer.getByRole('button', { name: 'Request human support' })).toHaveCount(0);
      await viewer.waitForLoadState('networkidle');
      expect(refused, `${role}: no request the API refuses`).toEqual([]);
      await context.close();
    }
  });
});

for (const scheme of ['dark', 'light'] as const) {
  test(`notebook and memory are accessible · ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    const ventureId = await openVenture(page);
    await useTheme(page, scheme);

    await page.goto(`/${TENANT}/app/v/${ventureId}/knowledge?view=notebook`);
    await expect(
      page.getByRole('heading', { level: 2, name: /^What Corin(?:['’]s| ·) vEIR knows$/ }),
    ).toBeVisible();
    await expectNoSeriousA11yViolations(page, `knowledge notebook (${scheme})`);
    await expectNoBareEirName(page, 'the notebook');

    await page.goto(`/${TENANT}/app/v/${ventureId}/knowledge`);
    await expect(page.getByRole('list', { name: 'Memory' })).toBeVisible();
    await expect(page.getByRole('tab', { name: /^To review/ })).toHaveCount(0);
    await expectNoSeriousA11yViolations(page, `knowledge memory (${scheme})`);
    await expectNoBareEirName(page, 'Knowledge memory');
    await page.goto(`/${TENANT}/app/v/${ventureId}/knowledge?view=conversations`);
    await expect(page.getByRole('tab', { name: /^Conversations/ })).toHaveAttribute('aria-selected', 'true');
    await expectNoBareEirName(page, 'Knowledge conversations');

    await page.goto(`/${TENANT}/app/v/${ventureId}/knowledge?view=evidence`);
    await expect(page.getByRole('list', { name: 'Sources' })).toBeVisible();
    await expectNoSeriousA11yViolations(page, `knowledge evidence (${scheme})`);
    // A seeded library source's own title is about the person, so it may name them.
    await expectNoBareEirName(page, 'Knowledge evidence', [/^Interview excerpt: how Corin frames /]);

    await page.goto(`/${TENANT}/app/v/${ventureId}/help`);
    await expect(page.getByRole('heading', { level: 1, name: 'Human help' })).toBeVisible();
    await expectNoSeriousA11yViolations(page, `human help (${scheme})`);
    await expectNoBareEirName(page, 'Human help');

    await page.goto(`/${TENANT}/app/v/${ventureId}/team`);
    await expect(page.getByRole('list', { name: 'Team members' })).toBeVisible();
    await expectNoSeriousA11yViolations(page, `team (${scheme})`);
    await expectNoBareEirName(page, 'Team');
  });
}
