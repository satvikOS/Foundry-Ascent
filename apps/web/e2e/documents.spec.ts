import { expect, test } from '@playwright/test';

import { FOUNDER_STATE, openVenture, runToken, TENANT } from './support/fixtures';

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

  // The Evidence section of Knowledge lists it as a source the vEIR can cite.
  await page.goto(`/${TENANT}/app/v/${ventureId}/knowledge?view=evidence`);
  const sources = page.getByRole('list', { name: 'Sources' });
  await expect(sources.getByRole('link', { name: filename })).toBeVisible();

  // Clean up so reruns against the same database stay tidy.
  await sources.getByRole('link', { name: filename }).click();
  await expect(page).toHaveURL(new RegExp(`/${TENANT}/app/v/${ventureId}/documents$`));
  await row.getByRole('button', { name: `Delete ${filename}` }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Delete this document?' });
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await expect(row).toHaveCount(0);
});
