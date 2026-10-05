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
  await page.goto(`/${TENANT}/app/ventures/${ventureId}/documents`);
  await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();

  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose files' }).click();
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
    .getByRole('table', { name: 'Venture documents' })
    .getByRole('row', { name: new RegExp(token) });
  await expect(row).toContainText('Ready', { timeout: 30_000 });
  await expect(row.getByRole('cell').nth(2)).not.toHaveText('—');

  // Clean up so reruns against the same database stay tidy.
  await row.getByRole('button', { name: `Delete ${filename}` }).click();
  const confirm = page.getByRole('alertdialog');
  await confirm.getByRole('button', { name: /^Delete/ }).click();
  await expect(row).toHaveCount(0);
});
