import { expect, type Page } from '@playwright/test';

import {
  composer,
  expectNoBareEirName,
  FOUNDER_STATE,
  openVenture,
  runToken,
  startConversation,
  TENANT,
  test,
} from './support/fixtures';

test.use({ storageState: FOUNDER_STATE });

/**
 * Upload → presigned PUT (the dev server's local stand-in for S3, through the preview's /api proxy) →
 * `POST /documents/:id/complete` (202 while ingestion runs) → the list polls until the document is ready.
 */
test('a founder uploads a document and it becomes searchable evidence', async ({ page }) => {
  const token = runToken();
  const filename = `customer-notes-${token}.md`;
  const ventureId = await openVenture(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Documents' }).click();
  await expect(page).toHaveURL(new RegExp(`/${TENANT}/app/v/${ventureId}/documents$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
  // The copy names the venture's vEIR, never a hard-coded persona.
  await expect(page.getByText(/^Files Corin['’]s vEIR can cite\. Private to this venture\.$/)).toBeVisible();
  await expectNoBareEirName(page, 'Documents');

  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Upload files' }).click();
  await (
    await chooser
  ).setFiles({
    name: filename,
    mimeType: 'text/markdown',
    buffer: Buffer.from(
      `# Exam-week interviews (${token})\n\n## Findings\n\nSix of eight students checked two buildings before finding a seat.\n`,
    ),
  });

  const row = page
    .getByRole('list', { name: 'Venture documents' })
    .getByRole('listitem')
    .filter({ hasText: filename });
  await expect(row).toContainText('Ready', { timeout: 30_000 });
  await expect(row).toContainText(/\d+ passages?/);

  // A conversation that cites it links the cited passage to this very document, by its source.
  await page.goto(`/${TENANT}/app/v/${ventureId}`);
  await startConversation(page, `Six of eight students checked two buildings: what did ${token} show?`);
  const answer = page.getByRole('article', { name: 'Exchange 1' });
  await answer
    .getByRole('button', { name: /^Evidence E\d+: / })
    .first()
    .click({ timeout: 30_000 });
  const panel = page.getByRole('complementary', { name: 'Context inspector' });
  const passage = panel.getByRole('article', { name: new RegExp(`^${filename.replace(/[.-]/g, '\\$&')}`) });
  await expect(passage).toContainText('Venture document');
  await passage.getByRole('link', { name: 'Open document' }).click();
  await expect(page).toHaveURL(new RegExp(`/${TENANT}/app/v/${ventureId}/documents\\?source=[0-9a-f-]{36}$`));
  await expect(row).toHaveAttribute('aria-current', 'true');

  // The Evidence section of Knowledge lists it as a source the vEIR can cite, cited once.
  await page.goto(`/${TENANT}/app/v/${ventureId}/knowledge?view=evidence`);
  const sources = page.getByRole('list', { name: 'Sources' });
  await expect(sources.getByRole('link', { name: filename })).toBeVisible();
  await expect(sources.getByRole('listitem').filter({ hasText: filename })).toContainText(
    'Cited in 1 answer',
  );

  // Clean up so reruns against the same database stay tidy.
  await sources.getByRole('link', { name: filename }).click();
  await expect(page).toHaveURL(new RegExp(`/${TENANT}/app/v/${ventureId}/documents\\?source=`));
  await expect(row).toHaveAttribute('aria-current', 'true');
  await row.getByRole('button', { name: `Delete ${filename}` }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Delete this document?' });
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await expect(row).toHaveCount(0);
});

const UPLOAD_PUT = '**/api/v1/_local/uploads/**';

async function pickFile(page: Page, name: string, body: string): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Upload files' }).click();
  await (await chooser).setFiles({ name, mimeType: 'text/markdown', buffer: Buffer.from(body) });
}

/**
 * A failed presigned PUT leaves no "Uploading" document behind: it is marked unfinished at once (the list
 * stops waiting for it), and Retry uploads into the same document instead of registering a second one.
 */
test('a failed upload is marked unfinished, and Retry finishes it in the same document', async ({ page }) => {
  const token = runToken();
  const filename = `retry-notes-${token}.md`;
  const ventureId = await openVenture(page);
  await page.goto(`/${TENANT}/app/v/${ventureId}/documents`);
  await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();

  await page.route(UPLOAD_PUT, (route) => route.abort('failed'));
  await pickFile(
    page,
    filename,
    `# Library visits (${token})\n\nFive of six students left without a seat.\n`,
  );
  const queued = page
    .getByRole('list', { name: 'Upload queue' })
    .getByRole('listitem')
    .filter({ hasText: filename });
  await expect(queued).toContainText('Failed');
  const rows = page
    .getByRole('list', { name: 'Venture documents' })
    .getByRole('listitem')
    .filter({ hasText: filename });
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('The upload didn’t finish. Upload the file again.');
  await expect(page.getByText(/^Processing \d+ files?…$/)).toHaveCount(0);

  await page.unroute(UPLOAD_PUT);
  await queued.getByRole('button', { name: `Retry ${filename}` }).click();
  await expect(rows).toContainText('Ready', { timeout: 30_000 });
  await expect(rows).toHaveCount(1);

  await rows.getByRole('button', { name: `Delete ${filename}` }).click();
  await page
    .getByRole('alertdialog', { name: 'Delete this document?' })
    .getByRole('button', { name: 'Delete' })
    .click();
  await expect(rows).toHaveCount(0);
});

test('a cancelled upload leaves no document behind', async ({ page }) => {
  const token = runToken();
  const filename = `cancelled-notes-${token}.md`;
  const ventureId = await openVenture(page);
  await page.goto(`/${TENANT}/app/v/${ventureId}/documents`);
  await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();

  // The PUT never answers, so the upload is still running when the person cancels it.
  let held = false;
  await page.route(UPLOAD_PUT, () => {
    held = true;
  });
  await pickFile(page, filename, `# Draft (${token})\n\nNot ready to share.\n`);
  await expect.poll(() => held).toBe(true);
  const rows = page
    .getByRole('list', { name: 'Venture documents' })
    .getByRole('listitem')
    .filter({ hasText: filename });
  await expect(rows).toContainText('Uploading');

  const queued = page
    .getByRole('list', { name: 'Upload queue' })
    .getByRole('listitem')
    .filter({ hasText: filename });
  await queued.getByRole('button', { name: `Cancel upload of ${filename}` }).click();
  await expect(queued).toContainText('Cancelled');
  await expect(rows).toHaveCount(0);
  await page.unroute(UPLOAD_PUT);
});

/**
 * Retry on a document whose file never arrived (an upload that failed, seen on a later visit) asks for the
 * file again and uploads it into that document: a fresh upload URL for the same record, not "processing" a
 * file that is not there.
 */
test('Retry on an unfinished document asks for the file and finishes it in the same document', async ({
  page,
}) => {
  const token = runToken();
  const filename = `unfinished-notes-${token}.md`;
  const body = `# Seat counts (${token})\n\nThree of five reading rooms were full by noon.\n`;
  const ventureId = await openVenture(page);
  await page.goto(`/${TENANT}/app/v/${ventureId}/documents`);
  await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();

  await page.route(UPLOAD_PUT, (route) => route.abort('failed'));
  await pickFile(page, filename, body);
  const rows = page
    .getByRole('list', { name: 'Venture documents' })
    .getByRole('listitem')
    .filter({ hasText: filename });
  await expect(rows).toContainText('The upload didn’t finish. Upload the file again.');
  await page.unroute(UPLOAD_PUT);

  // A later visit: the upload list is gone, the document is still unfinished.
  await page.reload();
  await expect(page.getByRole('list', { name: 'Upload queue' })).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('The upload didn’t finish. Upload the file again.');

  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') writes.push(new URL(request.url()).pathname);
  });
  const chooser = page.waitForEvent('filechooser');
  await rows.getByRole('button', { name: 'Retry' }).click();
  await (await chooser).setFiles({ name: filename, mimeType: 'text/markdown', buffer: Buffer.from(body) });
  await expect(rows).toContainText('Ready', { timeout: 30_000 });
  await expect(rows).toHaveCount(1);
  // A fresh upload URL for the same document, then processing; no second document.
  expect(writes.filter((p) => p.endsWith('/upload'))).toHaveLength(1);
  expect(writes.filter((p) => p.endsWith('/complete'))).toHaveLength(1);
  expect(writes.filter((p) => p.endsWith(`/ventures/${ventureId}/documents`))).toHaveLength(0);

  await rows.getByRole('button', { name: `Delete ${filename}` }).click();
  await page
    .getByRole('alertdialog', { name: 'Delete this document?' })
    .getByRole('button', { name: 'Delete' })
    .click();
  await expect(rows).toHaveCount(0);
});

/** Asks a question from New chat and waits for the answer; returns the conversation id. */
async function conversationWithAnswer(page: Page, question: string): Promise<string> {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'New chat' }).click();
  await expect(composer(page)).toBeVisible();
  const id = await startConversation(page, question);
  await expect(
    page.getByRole('article', { name: 'Exchange 1' }).getByRole('button', { name: 'Copy answer' }),
  ).toBeVisible({ timeout: 30_000 });
  return id;
}

/**
 * A file attached in one conversation keeps uploading while the founder opens another conversation and
 * Documents (switching conversations used to cancel it), shows in its own conversation's composer on return,
 * and lands in the venture's Documents.
 */
test('a file attached in a conversation keeps uploading while another is open, and lands in Documents', async ({
  page,
}) => {
  const token = runToken();
  const filename = `pilot-terms-${token}.md`;
  await openVenture(page);
  const first = await conversationWithAnswer(page, `What should the pilot terms cover? ${token}`);
  const second = await conversationWithAnswer(page, `Who signs off on a library pilot? ${token}`);

  // The upload's PUT waits until the test lets it through.
  let held = false;
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(UPLOAD_PUT, async (route) => {
    held = true;
    await released;
    await route.continue();
  });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add documents' }).click();
  await (
    await chooser
  ).setFiles({
    name: filename,
    mimeType: 'text/markdown',
    buffer: Buffer.from(`# Pilot terms (${token})\n\nThe library pays after four weeks of use.\n`),
  });
  const tray = page.getByRole('list', { name: 'Documents being added' });
  await expect(tray).toContainText(filename);
  await expect.poll(() => held).toBe(true);

  // Another conversation: its composer has nothing of this upload.
  const recents = page.getByRole('navigation', { name: 'Recent conversations' });
  await recents.locator(`a[href$="/c/${first}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/c/${first}`));
  await expect(composer(page)).toBeVisible();
  await expect(tray).toHaveCount(0);

  // Back in the conversation it was attached to, it is still uploading there.
  await recents.locator(`a[href$="/c/${second}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/c/${second}`));
  await expect(tray).toContainText(filename);

  // Documents shows it too, and it finishes there.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Documents' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Upload queue' }).getByRole('listitem').filter({ hasText: filename }),
  ).toBeVisible();
  release();
  const rows = page
    .getByRole('list', { name: 'Venture documents' })
    .getByRole('listitem')
    .filter({ hasText: filename });
  await expect(rows).toContainText('Ready', { timeout: 30_000 });
  await expect(rows).toHaveCount(1);
  await page.unroute(UPLOAD_PUT);

  await rows.getByRole('button', { name: `Delete ${filename}` }).click();
  await page
    .getByRole('alertdialog', { name: 'Delete this document?' })
    .getByRole('button', { name: 'Delete' })
    .click();
  await expect(rows).toHaveCount(0);
});
