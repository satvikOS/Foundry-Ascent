import { expect, type APIRequestContext } from '@playwright/test';

import {
  FOUNDER_STATE,
  OWNER_STATE,
  openVenture,
  runToken,
  startConversation,
  TENANT,
  test,
} from './support/fixtures';

const WRITE_HEADERS = { 'x-requested-with': 'foundry-ascent', 'content-type': 'application/json' };

interface EscalationLike {
  id: string;
  status: string;
  assignee: { displayName: string } | null;
  packet: { founderQuestion: string } | null;
}

function isEscalationList(value: unknown): value is { items: EscalationLike[] } {
  return typeof value === 'object' && value !== null && Array.isArray((value as { items?: unknown }).items);
}

async function ventureEscalations(request: APIRequestContext, ventureId: string): Promise<EscalationLike[]> {
  const res = await request.get(`/api/v1/ventures/${ventureId}/escalations`);
  expect(res.status(), 'GET /ventures/:id/escalations').toBe(200);
  const body: unknown = await res.json();
  if (!isEscalationList(body)) throw new Error('Unexpected escalation list');
  return body.items;
}

test.describe('crisis support survives a reload', () => {
  test.use({ storageState: FOUNDER_STATE });

  test('a crisis-blocked turn shows the human-support message live and after reloading', async ({ page }) => {
    const token = runToken();
    await openVenture(page);
    // The first message of a new chat: the conversation is created, opened and the message answered.
    const id = await startConversation(
      page,
      `I don't want to be alive anymore and I keep thinking about ending it. ${token}`,
    );

    const live = page.getByTestId('blocked-panel');
    await expect(live.getByRole('heading', { name: 'You deserve support from a person' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(live).toContainText('988');
    await expect(live.getByRole('link', { name: 'View your request for support' })).toBeVisible();

    // A reload rebuilds the session from GET /sessions/:id: the same humane message and resources.
    await page.reload();
    const stored = page.getByRole('article', { name: 'Exchange 1' }).getByTestId('blocked-panel');
    await expect(stored.getByRole('heading', { name: 'You deserve support from a person' })).toBeVisible();
    await expect(stored).toContainText('988');
    await expect(stored).toContainText('university counseling');
    // Rendered as Markdown (a list of resources), never raw markup.
    await expect(stored.getByRole('listitem')).toHaveCount(3);
    await expect(stored).not.toContainText('**');
    await expect(stored.getByRole('link', { name: 'View your request for support' })).toBeVisible();

    // A crisis message never becomes the conversation's name: not stored, not in the header, not in the
    // recents (which every page shows).
    const detail = await page.request.get(`/api/v1/sessions/${id}`);
    expect(detail.status(), 'GET /sessions/:id').toBe(200);
    expect(((await detail.json()) as { session: { title: string | null } }).session.title).toBeNull();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Conversation · /);
    const row = page.getByRole('navigation', { name: 'Recent conversations' }).locator(`a[href$="/c/${id}"]`);
    await expect(row).toHaveText(/^Conversation · /);
    await expect(row).not.toContainText('alive');
  });
});

test.describe('private chats', () => {
  test.use({ storageState: FOUNDER_STATE });

  test('Remember is the default; a private chat keeps no title, nothing remembered, and ends with nothing kept', async ({
    page,
  }) => {
    const token = runToken();
    await openVenture(page);
    const remember = page.getByRole('radio', { name: 'Remember this conversation' });
    const isPrivate = page.getByRole('radio', { name: 'Private, a one-off' });
    await expect(remember).toBeChecked();
    await expect(page.getByRole('button', { name: 'Add documents' })).toBeVisible();
    // Keyboard: arrow keys move between the two choices.
    await remember.focus();
    await page.keyboard.press('ArrowRight');
    await expect(isPrivate).toBeChecked();
    // A private chat reads nothing: greeted by the time of day, never with what the vEIR would pick up.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      /^Good (?:morning|afternoon|evening), Maya$/,
    );
    await expect(page.getByTestId('greeting-line')).toHaveText('What’s on your mind?');
    await expect(page.getByRole('group', { name: 'Memory for this conversation' })).toContainText(
      'Not remembered. Erased when it ends.',
    );
    // Attached files would go into the venture's Documents, which last: a private chat offers none.
    await expect(page.getByRole('button', { name: 'Add documents' })).toHaveCount(0);
    const created = page.waitForRequest(
      (request) => request.method() === 'POST' && /\/ventures\/[0-9a-f-]{36}\/sessions$/.test(request.url()),
    );
    const id = await startConversation(page, `Sketch a quick pricing test for libraries. ${token}`);
    expect((await created).postDataJSON()).toMatchObject({ privacy: 'ephemeral' });

    const answer = page.getByRole('article', { name: 'Exchange 1' });
    await expect(answer.getByRole('button', { name: /^Sources & reasoning/ })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId('private-indicator')).toHaveText('Private');
    await expect(answer.getByTestId('memory-saved')).toHaveCount(0);
    await expect(answer.getByRole('button', { name: /^(Keep|Not now)/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add documents' })).toHaveCount(0);
    // Listed as a private chat, named by when it started rather than by what was said.
    const row = page.getByRole('navigation', { name: 'Recent conversations' }).locator(`a[href$="/c/${id}"]`);
    await expect(row).toContainText('Private chat ·');
    await expect(row).not.toContainText(token);

    await page.getByRole('button', { name: 'Conversation options' }).click();
    await expect(page.getByRole('menuitem', { name: 'Rename' })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'End and summarise' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'End this conversation?' });
    await expect(confirm).toContainText('It’s private, so nothing is kept.');
    await confirm.getByRole('button', { name: 'End conversation' }).click();
    await expect(page.getByRole('heading', { name: 'Private chat ended' })).toBeVisible();
    await expect(page.getByText('Nothing from it was kept.')).toBeVisible();
    // Its content is erased, so it leaves the recents.
    await expect(row).toHaveCount(0);

    // A fresh New chat starts at Remember again.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'New chat' }).click();
    await expect(page.getByRole('radio', { name: 'Remember this conversation' })).toBeChecked();
  });
});

test.describe('routing an escalation from the people directory', () => {
  test('consent puts a request in the routing queue; a program lead routes it to an EIR', async ({
    browser,
  }) => {
    const token = runToken();
    const question = `Can we sign the library data agreement as drafted? ${token}`;

    // Founder: create a specialist request and approve sharing (no EIR fits: it waits for assignment).
    const founder = await browser.newContext({ storageState: FOUNDER_STATE });
    const founderPage = await founder.newPage();
    const ventureId = await openVenture(founderPage);
    const created = await founderPage.request.post(`/api/v1/ventures/${ventureId}/escalations`, {
      headers: WRITE_HEADERS,
      data: { category: 'legal', priority: 'P0', requestedRole: 'specialist', founderQuestion: question },
    });
    expect(created.status(), 'POST /ventures/:id/escalations').toBe(201);
    const escalationId = ((await created.json()) as { id: string }).id;
    const shared = await founderPage.request.patch(`/api/v1/escalations/${escalationId}`, {
      headers: WRITE_HEADERS,
      data: { action: 'approve_sharing' },
    });
    expect(shared.status(), 'PATCH /escalations/:id approve_sharing').toBe(200);
    expect(((await shared.json()) as { status: string }).status).toBe('awaiting_assignment');

    await founderPage.goto(`/${TENANT}/app/v/${ventureId}/help?id=${escalationId}`);
    const detail = founderPage.getByRole('region', { name: 'Legal' });
    await expect(detail.getByRole('definition').first()).toHaveText('Waiting for assignment');

    // Program lead (the owner): the queue offers Route, and the dialog lists people from the directory.
    const lead = await browser.newContext({ storageState: OWNER_STATE });
    const leadPage = await lead.newPage();
    await leadPage.goto(`/${TENANT}/app/program/escalations`);
    await expect(leadPage.getByRole('heading', { level: 1, name: 'Escalation queue' })).toBeVisible();
    // Unassigned P0 requests sort oldest first; this run's is the newest one.
    await leadPage.getByRole('button', { name: 'Route P0 escalation for QuietQuad' }).last().click();
    const dialog = leadPage.getByRole('dialog', { name: 'Route escalation' });
    await expect(dialog.getByText('Waiting for assignment')).toBeVisible();
    await dialog.getByRole('combobox', { name: 'Assignee' }).click();
    const options = leadPage.getByRole('option');
    await expect(options.first()).toBeVisible();
    // Only EIRs and program leads are offered; no founder of any venture.
    for (const text of await options.allTextContents()) expect(text).toMatch(/EIR|Program lead/);
    const eir = options.filter({ hasText: 'EIR' }).first();
    const eirName = ((await eir.textContent()) ?? '').split(' — ')[0]?.trim() ?? '';
    await eir.click();
    await dialog.getByRole('button', { name: 'Route', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(leadPage.getByText(`Routed to ${eirName}`)).toBeVisible();

    // The founder sees it routed to that person.
    const after = (await ventureEscalations(founderPage.request, ventureId)).find(
      (e) => e.id === escalationId,
    );
    expect(after).toMatchObject({ status: 'routed', assignee: { displayName: eirName } });
    await founder.close();
    await lead.close();
  });
});
