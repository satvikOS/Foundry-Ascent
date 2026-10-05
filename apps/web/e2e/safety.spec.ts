import { expect, test, type APIRequestContext } from '@playwright/test';

import { FOUNDER_STATE, OWNER_STATE, openVenture, runToken, startSession, TENANT } from './support/fixtures';

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
    await startSession(page, `Check-in ${token}`);
    const composer = page.getByRole('textbox', { name: 'Message Foundry Guide' });
    await composer.fill(`I don't want to be alive anymore and I keep thinking about ending it. ${token}`);
    await composer.press('Enter');

    const live = page.getByTestId('blocked-panel');
    await expect(live.getByRole('heading', { name: 'You deserve support from a person' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(live).toContainText('988');
    await expect(live.getByRole('link', { name: 'View your support request' })).toBeVisible();

    // A reload rebuilds the session from GET /sessions/:id: the same humane message and resources.
    await page.reload();
    const stored = page.getByRole('article', { name: 'Exchange 1' }).getByTestId('blocked-panel');
    await expect(stored.getByRole('heading', { name: 'You deserve support from a person' })).toBeVisible();
    await expect(stored).toContainText('988');
    await expect(stored).toContainText('university counseling');
    // Rendered as Markdown (a list of resources), never raw markup.
    await expect(stored.getByRole('listitem')).toHaveCount(3);
    await expect(stored).not.toContainText('**');
    await expect(stored.getByRole('link', { name: 'View your support request' })).toBeVisible();
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

    await founderPage.goto(`/${TENANT}/app/ventures/${ventureId}/escalations?id=${escalationId}`);
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
