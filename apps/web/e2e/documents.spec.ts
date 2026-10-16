import { expect, type Locator, type Page } from '@playwright/test';

import {
  composer,
  expectNoBareEirName,
  expectNoHorizontalScroll,
  expectNoSeriousA11yViolations,
  FOUNDER_STATE,
  openVenture,
  runToken,
  startConversation,
  TENANT,
  test,
  useTheme,
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

  // A conversation that cites it opens the cited passage in the document viewer, over the conversation.
  await page.goto(`/${TENANT}/app/v/${ventureId}`);
  const conversation = await startConversation(
    page,
    `Six of eight students checked two buildings: what did ${token} show?`,
  );
  const answer = page.getByRole('article', { name: 'Exchange 1' });
  await answer
    .getByRole('button', { name: /^Evidence E\d+: / })
    .first()
    .click({ timeout: 30_000 });
  const panel = page.getByRole('complementary', { name: 'Context inspector' });
  const passage = panel.getByRole('article', { name: new RegExp(`^${filename.replace(/[.-]/g, '\\$&')}`) });
  await expect(passage).toContainText('Venture document');
  await passage.getByRole('link', { name: 'Open document' }).click();
  await expect(page).toHaveURL(
    new RegExp(`/${TENANT}/app/v/${ventureId}/c/${conversation}\\?src=[0-9a-f-]{36}&passage=[0-9a-f-]{36}$`),
  );
  const viewer = page.getByRole('dialog', { name: filename });
  await expect(viewer).toBeVisible();
  // The cited passage is marked in the document's own layout, and the viewer can go back to it.
  await expect(viewer.locator('[data-cited]').first()).toContainText(
    'Six of eight students checked two buildings before finding a seat.',
  );
  await expect(viewer.getByRole('heading', { name: `Exam-week interviews (${token})` })).toBeVisible();
  await viewer.getByRole('button', { name: 'Jump to cited passage' }).click();
  // Back closes it and returns to the conversation.
  await page.goBack();
  await expect(viewer).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/${TENANT}/app/v/${ventureId}/c/${conversation}$`));

  // The Evidence section of Knowledge lists it as a source the vEIR can cite, cited once, and opens it.
  await page.goto(`/${TENANT}/app/v/${ventureId}/knowledge?view=evidence`);
  const sources = page.getByRole('list', { name: 'Sources' });
  await expect(sources.getByRole('link', { name: filename })).toBeVisible();
  await expect(sources.getByRole('listitem').filter({ hasText: filename })).toContainText(
    'Cited in 1 answer',
  );
  await sources.getByRole('link', { name: filename }).click();
  await expect(page.getByRole('dialog', { name: filename })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(sources.getByRole('link', { name: filename })).toBeFocused();

  // Clean up so reruns against the same database stay tidy.
  await page.goto(`/${TENANT}/app/v/${ventureId}/documents`);
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

/**
 * A small PDF with real text (Helvetica, not embedded), one page per entry of `pages`: what the API's
 * extractor indexes and what pdf.js draws and finds in the viewer.
 */
function textPdf(pages: readonly (readonly string[])[]): Buffer {
  const escape = (text: string) => text.replace(/[\\()]/g, '\\$&');
  const objects: string[] = ['<< /Type /Catalog /Pages 2 0 R >>'];
  const kids = pages.map((_, i) => `${String(3 + i * 2)} 0 R`).join(' ');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${String(pages.length)} >>`);
  const font = 3 + pages.length * 2;
  pages.forEach((lines, i) => {
    const content = [
      'BT',
      '/F1 14 Tf',
      '72 720 Td',
      '20 TL',
      ...lines.map((l) => `(${escape(l)}) Tj T*`),
      'ET',
    ].join('\n');
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${String(4 + i * 2)} 0 R /Resources << /Font << /F1 ${String(font)} 0 R >> >> >>`,
    );
    objects.push(
      `<< /Length ${String(Buffer.byteLength(content, 'latin1'))} >>\nstream\n${content}\nendstream`,
    );
  });
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${String(i + 1)} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

async function uploadFiles(
  page: Page,
  files: { name: string; mimeType: string; buffer: Buffer }[],
): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Upload files' }).click();
  await (await chooser).setFiles(files);
}

async function deleteDocument(page: Page, row: Locator, filename: string): Promise<void> {
  await row.getByRole('button', { name: `Delete ${filename}` }).click();
  await page
    .getByRole('alertdialog', { name: 'Delete this document?' })
    .getByRole('button', { name: 'Delete' })
    .click();
  await expect(row).toHaveCount(0);
}

/**
 * The SPA's production Content-Security-Policy (infra/cdk/src/constructs/edge.ts), sent with every page this
 * test opens, and every violation the page reports, so the viewer is proven to work under it (pdf.js's
 * worker, no eval, the file fetched through its presigned URL, styles).
 */
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

async function enforceProductionCsp(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __cspViolations: string[] }).__cspViolations = seen;
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push(
        `${event.effectiveDirective} ${event.blockedURI} ${new URL(event.sourceFile, location.href).pathname}`,
      );
    });
  });
  await page.route(
    (url) => url.pathname.startsWith(`/${TENANT}/app`),
    async (route) => {
      if (route.request().resourceType() !== 'document') return route.continue();
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: { ...response.headers(), 'content-security-policy': PRODUCTION_CSP },
      });
    },
  );
  return () => page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);
}

test.describe('document viewer', () => {
  /**
   * A Markdown file and a PDF uploaded, then read in the viewer from Documents: rendered prose, find,
   * text size, PDF pages with find, download, and Escape back to the row that opened it.
   */
  test('reads a Markdown file and a PDF from Documents, with find, pages and download', async ({ page }) => {
    const token = runToken();
    const notes = `reading-notes-${token}.md`;
    const survey = `seat-survey-${token}.pdf`;
    const ventureId = await openVenture(page);
    const violations = await enforceProductionCsp(page);
    await page.goto(`/${TENANT}/app/v/${ventureId}/documents`);
    await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
    await uploadFiles(page, [
      {
        name: notes,
        mimeType: 'text/markdown',
        buffer: Buffer.from(
          `# Reading room notes (${token})\n\nStudents want a quiet seat near a socket.\n\n` +
            `- The east wing fills first.\n- A quiet seat is gone by ten.\n\nNobody asked for a booking app.\n`,
        ),
      },
      {
        name: survey,
        mimeType: 'application/pdf',
        buffer: textPdf([
          [
            `Seat survey ${token}`,
            'The quiet floor is full by noon.',
            'Students leave when no seat is free.',
          ],
          ['Page two of the survey', 'A quiet corner opened in the annex.'],
        ]),
      },
    ]);
    const list = page.getByRole('list', { name: 'Venture documents' });
    const notesRow = list.getByRole('listitem').filter({ hasText: notes });
    const surveyRow = list.getByRole('listitem').filter({ hasText: survey });
    await expect(notesRow).toContainText('Ready', { timeout: 30_000 });
    await expect(surveyRow).toContainText('Ready', { timeout: 30_000 });

    // Markdown: opened from its row, read as prose.
    await notesRow.getByRole('link', { name: notes }).click();
    await expect(page).toHaveURL(new RegExp(`/documents\\?doc=[0-9a-f-]{36}$`));
    const viewer = page.getByRole('dialog', { name: notes });
    await expect(viewer).toBeVisible();
    await expect(viewer.getByText(/^Markdown · \d+ B · /)).toBeVisible();
    await expect(viewer.getByRole('heading', { name: `Reading room notes (${token})` })).toBeVisible();
    await expect(
      viewer.getByRole('listitem').filter({ hasText: 'The east wing fills first.' }),
    ).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'document viewer (Markdown)');

    // Find: Ctrl+F, every match counted and marked, Enter steps, Escape closes find first.
    await page.keyboard.press('ControlOrMeta+f');
    const find = viewer.getByRole('searchbox', { name: 'Find in document' });
    await expect(find).toBeFocused();
    await find.fill('quiet seat');
    await expect(viewer.getByText('1 of 2')).toBeVisible();
    await expect(viewer.locator('mark[data-find-index]')).toHaveCount(2);
    await find.press('Enter');
    await expect(viewer.getByText('2 of 2')).toBeVisible();
    await expect(viewer.locator('mark[data-active]')).toHaveText('quiet seat');
    await page.keyboard.press('Escape');
    await expect(find).toHaveCount(0);
    await expect(viewer).toBeVisible();

    // Text size: larger, remembered for the next document.
    const size = viewer.getByRole('group', { name: 'Text size' });
    await size.getByRole('button', { name: 'Larger text' }).click();
    await expect(size).toContainText('112%');
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
    await expect(notesRow.getByRole('link', { name: notes })).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`/${TENANT}/app/v/${ventureId}/documents$`));

    // PDF: drawn with pdf.js, two pages, its text found and marked, saved under its own name.
    await surveyRow.getByRole('link', { name: survey }).click();
    const pdf = page.getByRole('dialog', { name: survey });
    await expect(pdf.getByRole('group', { name: 'Page 1 of 2' })).toBeVisible();
    await expect(pdf.locator('[data-page-index="0"][data-rendered]')).toBeVisible({ timeout: 15_000 });
    const pages = pdf.getByRole('group', { name: 'Pages' });
    await expect(pages).toContainText('1 / 2');
    await pdf.getByRole('button', { name: 'Find in document' }).click();
    await pdf.getByRole('searchbox', { name: 'Find in document' }).fill('quiet');
    await expect(pdf.getByText('1 of 2')).toBeVisible();
    await expect(pdf.locator('[data-page-index="0"] mark[data-find-index]')).toHaveCount(1);
    await pdf.getByRole('searchbox', { name: 'Find in document' }).press('Enter');
    await expect(pdf.getByText('2 of 2')).toBeVisible();
    await pdf.getByRole('button', { name: 'Close find' }).click();
    await pages.getByRole('button', { name: 'Next page' }).click();
    await expect(pages).toContainText('2 / 2');
    await pdf.getByRole('group', { name: 'Zoom' }).getByRole('button', { name: 'Zoom in' }).click();
    await expect(pdf.getByRole('group', { name: 'Zoom' })).toContainText('125%');
    await expect(pdf.getByRole('link', { name: 'Open in a new tab' })).toHaveAttribute(
      'href',
      /\/_local\/objects\//,
    );
    const download = page.waitForEvent('download');
    await pdf.getByRole('link', { name: 'Download' }).click();
    expect((await download).suggestedFilename()).toBe(survey);
    await expectNoSeriousA11yViolations(page, 'document viewer (PDF)');
    await pdf.getByRole('button', { name: 'Close' }).click();
    await expect(pdf).toHaveCount(0);
    // Everything above ran under the production CSP. The one report is not the viewer's: zod's
    // `new Function` probe (which zod catches) in the API client's chunk, on every page of the app.
    const reported = await violations();
    expect(reported.filter((v) => !/^script-src eval \/assets\/client-[\w-]+\.js$/.test(v))).toEqual([]);

    await deleteDocument(page, notesRow, notes);
    await deleteDocument(page, surveyRow, survey);
  });

  test('opens straight from a link, in dark and light', async ({ page }) => {
    const token = runToken();
    const notes = `linked-notes-${token}.md`;
    const ventureId = await openVenture(page);
    await page.goto(`/${TENANT}/app/v/${ventureId}/documents`);
    await uploadFiles(page, [
      {
        name: notes,
        mimeType: 'text/markdown',
        buffer: Buffer.from(`# Linked notes (${token})\n\nOpen me.\n`),
      },
    ]);
    const row = page
      .getByRole('list', { name: 'Venture documents' })
      .getByRole('listitem')
      .filter({ hasText: notes });
    await expect(row).toContainText('Ready', { timeout: 30_000 });
    const href = await row.getByRole('link', { name: notes }).getAttribute('href');
    expect(href).toMatch(/\?doc=[0-9a-f-]{36}$/);
    for (const scheme of ['dark', 'light'] as const) {
      await page.goto(href ?? '');
      await useTheme(page, scheme);
      const viewer = page.getByRole('dialog', { name: notes });
      await expect(viewer.getByRole('heading', { name: `Linked notes (${token})` })).toBeVisible();
      await expectNoSeriousA11yViolations(page, `document viewer opened from a link (${scheme})`);
      // Opened from a link: Close leaves the same page without the viewer.
      await viewer.getByRole('button', { name: 'Close' }).click();
      await expect(page).toHaveURL(new RegExp(`/${TENANT}/app/v/${ventureId}/documents$`));
    }
    await deleteDocument(page, row, notes);
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test('fills the screen with the controls in a bottom toolbar and no sideways scroll', async ({
      page,
    }) => {
      const token = runToken();
      const notes = `phone-notes-${token}.md`;
      const ventureId = await openVenture(page);
      await page.goto(`/${TENANT}/app/v/${ventureId}/documents`);
      await uploadFiles(page, [
        {
          name: notes,
          mimeType: 'text/markdown',
          buffer: Buffer.from(
            `# Phone notes (${token})\n\n${'A long line of notes about seats. '.repeat(30)}\n`,
          ),
        },
      ]);
      const row = page
        .getByRole('list', { name: 'Venture documents' })
        .getByRole('listitem')
        .filter({ hasText: notes });
      await expect(row).toContainText('Ready', { timeout: 30_000 });
      // The upload list of a long file name stays inside a phone's width.
      await expectNoHorizontalScroll(page);
      await row.getByRole('link', { name: notes }).click();
      const viewer = page.getByRole('dialog', { name: notes });
      await expect(viewer.getByRole('heading', { name: `Phone notes (${token})` })).toBeVisible();
      const box = await viewer.boundingBox();
      expect(box).toMatchObject({ x: 0, y: 0, width: 390, height: 844 });
      const toolbar = viewer.getByRole('toolbar', { name: 'Document controls' });
      await expect(toolbar.getByRole('button', { name: 'Find in document' })).toBeVisible();
      await expect(toolbar.getByRole('link', { name: 'Download' })).toBeVisible();
      await expectNoHorizontalScroll(page);
      await viewer.getByRole('button', { name: 'Close' }).click();
      await expect(viewer).toHaveCount(0);
      await deleteDocument(page, row, notes);
    });
  });
});
