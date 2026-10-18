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
  // Who can see the files is on the page; what they are for is behind the info button, which names the
  // venture's vEIR, never a hard-coded persona.
  await expect(page.getByText('Private to this venture.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'About Documents' })).toHaveAccessibleDescription(
    /^Files Corin(?:['’]s| ·) vEIR can cite\.$/,
  );
  await expectNoBareEirName(page, 'Documents');

  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Upload files' }).click();
  await (
    await chooser
  ).setFiles({
    name: filename,
    mimeType: 'text/markdown',
    buffer: Buffer.from(
      `# Exam-week interviews (${token})\n\n## Findings\n\nSix of eight students checked two buildings before finding a seat.\n\n` +
        `- The east wing fills first.\n- Two of eight gave up and studied at home.\n`,
    ),
  });

  const row = page
    .getByRole('list', { name: 'Venture documents' })
    .getByRole('listitem')
    .filter({ hasText: filename });
  // Ready is said to screen readers only (a row shows a state only when it is not); the citation below shows
  // the file is searchable.
  await expect(row).toContainText('Ready', { timeout: 30_000 });

  // A conversation that cites it opens the cited passage in the document viewer, over the conversation.
  await page.goto(`/${TENANT}/app/v/${ventureId}`);
  const conversation = await startConversation(
    page,
    `Six of eight students checked two buildings: what did ${token} show?`,
  );
  const answer = page.getByRole('article', { name: 'Exchange 1' });
  await answer
    .getByRole('button', { name: /^Source \d+: / })
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
  // One band: its rule lines up across the passage's paragraph and list items, inside the column, at the
  // default and the largest text size.
  await expect(
    viewer.locator('li[data-cited]').filter({ hasText: 'The east wing fills first.' }),
  ).toHaveCount(1);
  await expectCitedBandAligned(viewer);
  const larger = viewer
    .getByRole('group', { name: 'Text size' })
    .getByRole('button', { name: 'Larger text' });
  while (await larger.isEnabled()) await larger.click();
  await expectCitedBandAligned(viewer);
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
 * The cited passage's band (each cited block's ::before): its rule on one line for every block, none
 * outside the reading area, and one continuous band with no gap and no doubly tinted overlap between
 * consecutive cited blocks.
 */
async function expectCitedBandAligned(viewer: Locator): Promise<void> {
  const bands = await viewer.locator('[data-cited]').evaluateAll((elements) =>
    elements.map((element) => {
      const band = getComputedStyle(element, '::before');
      const box = element.getBoundingClientRect();
      return {
        left: box.left + Number.parseFloat(band.left),
        top: box.top + Number.parseFloat(band.top),
        bottom: box.bottom - Number.parseFloat(band.bottom),
      };
    }),
  );
  const rules = bands.map((band) => band.left);
  expect(rules.length).toBeGreaterThan(1);
  expect(rules.every(Number.isFinite)).toBe(true);
  expect(Math.max(...rules) - Math.min(...rules)).toBeLessThan(1);
  const area = await viewer.locator('[data-viewer-scroll]').evaluate((el) => el.getBoundingClientRect().left);
  expect(Math.min(...rules)).toBeGreaterThanOrEqual(area);
  for (let i = 1; i < bands.length; i += 1) {
    expect(Math.abs((bands[i]?.top ?? 0) - (bands[i - 1]?.bottom ?? 0))).toBeLessThan(1);
  }
}

/**
 * The WCAG contrast of an element's text against what is behind it at its worst: the element's own
 * background and its ancestors' (the viewer's glass bars), laid over `under` (a white or a black PDF page
 * scrolled beneath the bar, or the panel). Colours are composited by the browser itself on a canvas.
 */
async function worstContrast(element: Locator, under: readonly string[]): Promise<number> {
  return element.evaluate((el, unders) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('no canvas');
    const layers: string[] = [];
    for (let node: Element | null = el; node; node = node.parentElement) {
      const background = getComputedStyle(node).backgroundColor;
      layers.unshift(background);
      if (node.matches('.glass-strong, .viewer-panel')) break;
    }
    const paint = (colours: readonly string[]): number[] => {
      context.clearRect(0, 0, 1, 1);
      for (const colour of colours) {
        context.fillStyle = colour;
        context.fillRect(0, 0, 1, 1);
      }
      return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    };
    const luminance = (rgb: number[]): number => {
      const [r = 0, g = 0, b = 0] = rgb.map((v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const text = getComputedStyle(el).color;
    return Math.min(
      ...unders.map((base) => {
        const back = luminance(paint([base, ...layers]));
        const fore = luminance(paint([base, ...layers, text]));
        const [hi, lo] = back > fore ? [back, fore] : [fore, back];
        return (hi + 0.05) / (lo + 0.05);
      }),
    );
  }, under);
}

/**
 * A PDF made the way scanners make them: page 1 is a black-and-white image only (CCITT Group 4, the usual
 * compression of a scanned page, decoded by pdf.js's JavaScript JBIG2/CCITT decoder), page 2 has Japanese
 * text in a predefined CMap (UniJIS-UCS2-H, read through pdf.js's CMap files) and a line of Latin text.
 */
function scanPdf(token: string): Buffer {
  // 240 × 120, a filled block under three ruled lines, encoded with libtiff's Group 4 encoder.
  const g4 = Buffer.from(
    'JqGSDJ///IaF6Y/kNC9MfyGhemP5DQvTH//INEiT////////////////////////////////////////H/////////gAgAg=',
    'base64',
  );
  const page2 = [
    'BT /F2 28 Tf 72 700 Td <65E5672C8A9E> Tj ET',
    `BT /F1 14 Tf 72 650 Td (Scanned survey ${token}) Tj ET`,
  ].join('\n');
  const objects: (string | Buffer)[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>',
    '<< /Length 33 >>\nstream\nq 480 0 0 240 66 480 cm /Im1 Do Q\nendstream',
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width 240 /Height 120 /ColorSpace /DeviceGray /BitsPerComponent 1 ` +
          `/Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns 240 /Rows 120 /BlackIs1 true >> /Length ${String(g4.length)} >>\nstream\n`,
        'latin1',
      ),
      g4,
      Buffer.from('\nendstream', 'latin1'),
    ]),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R /Resources << /Font << /F1 10 0 R /F2 8 0 R >> >> >>',
    `<< /Length ${String(Buffer.byteLength(page2, 'latin1'))} >>\nstream\n${page2}\nendstream`,
    '<< /Type /Font /Subtype /Type0 /BaseFont /KozMinPr6N-Regular /Encoding /UniJIS-UCS2-H /DescendantFonts [9 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /KozMinPr6N-Regular /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> ' +
      '/FontDescriptor << /Type /FontDescriptor /FontName /KozMinPr6N-Regular /Flags 4 /FontBBox [0 -120 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 740 /StemV 80 >> /DW 1000 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  let length = parts[0]?.length ?? 0;
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(length);
    const body = typeof object === 'string' ? Buffer.from(object, 'latin1') : object;
    const chunk = Buffer.concat([
      Buffer.from(`${String(i + 1)} 0 obj\n`, 'latin1'),
      body,
      Buffer.from('\nendobj\n'),
    ]);
    parts.push(chunk);
    length += chunk.length;
  });
  const xref =
    `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n` +
    offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(length)}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

/** How much of a page's drawing is dark (a page whose image failed to decode is all white). */
async function darkShare(pageElement: Locator): Promise<number> {
  return pageElement.locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext('2d');
    if (!context || canvas.width === 0) return 0;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if ((data[i] ?? 255) < 96) dark += 1;
    return dark / (data.length / 4);
  });
}

/** The API's origin: in this suite the local stand-in for S3 serves presigned GETs from it (cross-origin). */
const OBJECTS_ORIGIN = new URL(process.env.E2E_API_URL ?? 'http://localhost:8787').origin;

/**
 * The SPA's production Content-Security-Policy (infra/cdk/src/constructs/edge.ts), sent with every page this
 * test opens, and every violation the page reports, so the viewer is proven to work under it (pdf.js's
 * worker, no eval, the file fetched through its presigned URL, styles). As in production, connect-src names
 * exactly one other origin, where the presigned GETs point (the documents bucket there, the API here).
 */
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${OBJECTS_ORIGIN}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

async function enforceProductionCsp(page: Page): Promise<() => Promise<string[]>> {
  // A page the test fulfils itself has no network address of its own, which Chromium treats as public, and
  // the presigned GETs here go to the API on this machine (local network access). In production a public
  // page reads a public bucket, which needs no such permission.
  await page.context().grantPermissions(['local-network-access']);
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
    (url) =>
      url.pathname.startsWith(`/${TENANT}/app`) || /^\/assets\/pdf\.worker[\w.-]*\.mjs$/.test(url.pathname),
    async (route) => {
      // Pages, and pdf.js's worker (a worker runs under its own script's policy, as CloudFront sends it).
      const worker = new URL(route.request().url()).pathname.startsWith('/assets/');
      if (!worker && route.request().resourceType() !== 'document') return route.continue();
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
   * A Markdown file, a PDF and a scanned PDF uploaded, then read in the viewer from Documents: rendered
   * prose, find, text size, PDF pages with find, download, the scan's image and its Japanese text, and
   * Escape back to the row that opened it; then straight from a link in dark and light, its text legible on
   * the glass bars. The files are read cross-origin through their presigned GETs, under the production CSP.
   * (One test for the files: uploads count against a daily quota.)
   */
  test('reads a Markdown file and a PDF from Documents, with find, pages and download', async ({ page }) => {
    const token = runToken();
    const notes = `reading-notes-${token}.md`;
    const survey = `seat-survey-${token}.pdf`;
    const scan = `scanned-survey-${token}.pdf`;
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
      { name: scan, mimeType: 'application/pdf', buffer: scanPdf(token) },
    ]);
    const list = page.getByRole('list', { name: 'Venture documents' });
    const notesRow = list.getByRole('listitem').filter({ hasText: notes });
    const surveyRow = list.getByRole('listitem').filter({ hasText: survey });
    const scanRow = list.getByRole('listitem').filter({ hasText: scan });
    await expect(notesRow).toContainText('Ready', { timeout: 30_000 });
    await expect(surveyRow).toContainText('Ready', { timeout: 30_000 });
    // A scan may index (its Latin line) or not (no readable text): either way it is read in the viewer.
    await expect(scanRow).toContainText(/Ready|text/, { timeout: 30_000 });

    // Markdown: opened from its row, read as prose; the file comes cross-origin through its presigned GET.
    const fileRead = page.waitForResponse((r) =>
      r.url().startsWith(`${OBJECTS_ORIGIN}/api/v1/_local/objects/`),
    );
    await notesRow.getByRole('link', { name: notes }).click();
    const read = await fileRead;
    expect(read.status()).toBe(200);
    expect(read.headers()['access-control-allow-origin']).toBe(new URL(page.url()).origin);
    expect(new URL(page.url()).origin).not.toBe(OBJECTS_ORIGIN);
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
    const zoomIn = pdf.getByRole('group', { name: 'Zoom' }).getByRole('button', { name: 'Zoom in' });
    await zoomIn.click();
    await expect(pdf.getByRole('group', { name: 'Zoom' })).toContainText('125%');
    await expect(pdf.getByRole('link', { name: 'Open in a new tab' })).toHaveAttribute(
      'href',
      /\/_local\/objects\//,
    );
    const download = page.waitForEvent('download');
    await pdf.getByRole('button', { name: 'Download' }).click();
    expect((await download).suggestedFilename()).toBe(survey);
    await expectNoSeriousA11yViolations(page, 'document viewer (PDF)');
    // The widest page at the largest zoom: its canvas stays within the pixel limit, and is drawn.
    await pdf.getByRole('button', { name: 'Wide page' }).click();
    while (await zoomIn.isEnabled()) await zoomIn.click();
    await expect(pdf.getByRole('group', { name: 'Zoom' })).toContainText('400%');
    const second = pdf.locator('[data-page-index="1"]');
    await second.scrollIntoViewIfNeeded();
    await expect
      .poll(() => second.locator('canvas').evaluate((c: HTMLCanvasElement) => c.width * c.height), {
        timeout: 15_000,
      })
      .toBeGreaterThan(4_000_000);
    expect(
      await second.locator('canvas').evaluate((c: HTMLCanvasElement) => c.width * c.height),
    ).toBeLessThanOrEqual(2 ** 24);
    await pdf.getByRole('button', { name: 'Wide page' }).click();
    await pdf.getByRole('button', { name: 'Close' }).click();
    await expect(pdf).toHaveCount(0);

    // A scan: its page image is drawn (not a blank page) and its Japanese text is found.
    await scanRow.getByRole('link', { name: scan }).click();
    const scanned = page.getByRole('dialog', { name: scan });
    const scanPage = scanned.locator('[data-page-index="0"][data-rendered]');
    await expect(scanPage).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => darkShare(scanPage), { timeout: 10_000 }).toBeGreaterThan(0.03);
    await scanned.getByRole('button', { name: 'Find in document' }).click();
    await scanned.getByRole('searchbox', { name: 'Find in document' }).fill('日本語');
    await expect(scanned.getByText('1 of 1')).toBeVisible({ timeout: 15_000 });
    await expect(scanned.locator('[data-page-index="1"] mark[data-find-index]')).toHaveText('日本語');
    await scanned.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(scanned).toHaveCount(0);
    // Everything above ran under the production CSP. The only report allowed is zod's own `Function('')`
    // probe (it catches the refusal and parses without compiling), recognised by the probe's code in the
    // chunk that reported it, whatever the bundler named that chunk. Any other report (pdf.js, a new
    // dependency, eval anywhere else) fails.
    const reported = await violations();
    const unexpected: string[] = [];
    for (const violation of reported) {
      const source = /^script-src eval (\/assets\/[\w.-]+\.js)$/.exec(violation)?.[1];
      const code = source === undefined ? '' : await (await page.request.get(source)).text();
      const zodProbe = code.includes('jitless') && /Function\((?:``|""|'')\)/.test(code);
      if (!zodProbe) unexpected.push(violation);
    }
    expect(unexpected).toEqual([]);

    // A link opens straight into the viewer, in dark and light; Close then leaves the page without it.
    // Text on the glass bars (and the match in focus) stays at AA contrast over a white or black page
    // scrolled under them, which axe cannot measure through translucency.
    const href = await notesRow.getByRole('link', { name: notes }).getAttribute('href');
    const surveyHref = await surveyRow.getByRole('link', { name: survey }).getAttribute('href');
    expect(href).toMatch(/\?doc=[0-9a-f-]{36}$/);
    for (const scheme of ['dark', 'light'] as const) {
      await page.goto(href ?? '');
      await useTheme(page, scheme);
      const linked = page.getByRole('dialog', { name: notes });
      await expect(linked.getByRole('heading', { name: `Reading room notes (${token})` })).toBeVisible();
      await expectNoSeriousA11yViolations(page, `document viewer opened from a link (${scheme})`);
      // One glass hairline, the same on all four sides, and no ring drawn around the text the viewer focused
      // for itself (a 2px inset ring under the glass bars showed as a bright edge on three sides in dark).
      // Keyboard focus coming back to the text turns the whole edge to the focus colour, evenly.
      const edge = () =>
        linked.evaluate((el) => {
          const style = getComputedStyle(el);
          const text = el.querySelector('[data-viewer-scroll]');
          return {
            widths: [
              ...new Set([
                style.borderTopWidth,
                style.borderRightWidth,
                style.borderBottomWidth,
                style.borderLeftWidth,
              ]),
            ],
            colors: [
              ...new Set([
                style.borderTopColor,
                style.borderRightColor,
                style.borderBottomColor,
                style.borderLeftColor,
              ]),
            ],
            ring: text ? getComputedStyle(text).boxShadow : null,
            textFocused: document.activeElement === text,
          };
        });
      const quiet = await edge();
      expect(quiet).toMatchObject({ widths: ['1px'], ring: 'none', textFocused: true });
      expect(quiet.colors).toHaveLength(1);
      expect(
        Number(/rgba\(\d+, \d+, \d+, ([\d.]+)\)/.exec(quiet.colors[0] ?? '')?.[1] ?? 1),
      ).toBeLessThanOrEqual(0.12);
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      const focused = await edge();
      expect(focused).toMatchObject({ widths: ['1px'], ring: 'none', textFocused: true });
      expect(focused.colors).toEqual([scheme === 'dark' ? 'rgb(255, 255, 255)' : 'rgb(17, 17, 16)']);
      await page.keyboard.press('ControlOrMeta+f');
      await linked.getByRole('searchbox', { name: 'Find in document' }).fill('quiet seat');
      await expect(linked.getByText('1 of 2')).toBeVisible();
      const panel = await linked.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(await worstContrast(linked.locator('mark[data-active]'), [panel])).toBeGreaterThanOrEqual(4.5);
      expect(await worstContrast(linked.getByText('1 of 2'), ['#fff', '#000'])).toBeGreaterThanOrEqual(4.5);
      expect(await worstContrast(linked.getByText(/^Markdown · /), ['#fff', '#000'])).toBeGreaterThanOrEqual(
        4.5,
      );
      await linked.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/${TENANT}/app/v/${ventureId}/documents$`));

      await page.goto(surveyHref ?? '');
      const linkedPdf = page.getByRole('dialog', { name: survey });
      await expect(linkedPdf.locator('[data-page-index="0"][data-rendered]')).toBeVisible({
        timeout: 15_000,
      });
      const pages = linkedPdf.getByRole('group', { name: 'Pages' });
      await expect(pages).toContainText('1 / 2');
      for (const label of [
        pages.getByText('/ 2'),
        linkedPdf.getByRole('group', { name: 'Zoom' }).getByText('100%'),
      ]) {
        expect(await worstContrast(label, ['#fff', '#000'])).toBeGreaterThanOrEqual(4.5);
      }
      await linkedPdf.getByRole('button', { name: 'Close' }).click();
      await expect(linkedPdf).toHaveCount(0);
    }

    await deleteDocument(page, notesRow, notes);
    await deleteDocument(page, surveyRow, survey);
    await deleteDocument(page, scanRow, scan);
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    /** Every upload counts against the founder's daily quota (20), and the suite runs twice a day. */
    test('fills the screen, keeps its controls in a bottom toolbar, and zooms a PDF with a pinch', async ({
      page,
    }) => {
      const token = runToken();
      const survey = `phone-survey-with-a-long-file-name-${token}.pdf`;
      const ventureId = await openVenture(page);
      await page.goto(`/${TENANT}/app/v/${ventureId}/documents`);
      await uploadFiles(page, [
        {
          name: survey,
          mimeType: 'application/pdf',
          buffer: textPdf([[`Phone survey ${token}`, 'Seats by the window go first.']]),
        },
      ]);
      const row = page
        .getByRole('list', { name: 'Venture documents' })
        .getByRole('listitem')
        .filter({ hasText: survey });
      await expect(row).toContainText('Ready', { timeout: 30_000 });
      // The upload list of a long file name stays inside a phone's width.
      await expectNoHorizontalScroll(page);
      await row.getByRole('link', { name: survey }).click();
      const viewer = page.getByRole('dialog', { name: survey });
      const firstPage = viewer.locator('[data-page-index="0"][data-rendered]');
      await expect(firstPage).toBeVisible({ timeout: 15_000 });
      expect(await viewer.boundingBox()).toMatchObject({ x: 0, y: 0, width: 390, height: 844 });
      const toolbar = viewer.getByRole('toolbar', { name: 'Document controls' });
      await expect(toolbar.getByRole('button', { name: 'Find in document' })).toBeVisible();
      await expect(toolbar.getByRole('group', { name: 'Pages' })).toContainText('1 / 1');
      await expect(toolbar.getByRole('button', { name: 'Download' })).toBeVisible();
      await expectNoHorizontalScroll(page);

      const zoom = toolbar.getByRole('group', { name: 'Zoom' });
      await expect(zoom).toContainText('100%');
      const box = await firstPage.boundingBox();
      if (!box) throw new Error('the page has no box');
      // Two fingers spread apart over the page (touch input through the DevTools protocol).
      const cdp = await page.context().newCDPSession(page);
      const [x, y] = [box.x + box.width / 2, box.y + Math.min(box.height / 2, 200)];
      const fingers = (spread: number) => [
        { x: x - spread, y, id: 1 },
        { x: x + spread, y, id: 2 },
      ];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers(30) });
      for (let spread = 40; spread <= 90; spread += 10) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: fingers(spread) });
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect(zoom).not.toContainText('100%');
      expect(Number((await zoom.textContent())?.match(/(\d+)%/)?.[1])).toBeGreaterThan(150);
      // Zoomed pages scroll sideways inside the viewer, never the page.
      await expectNoHorizontalScroll(page);
      await viewer.getByRole('button', { name: 'Close' }).click();
      await expect(viewer).toHaveCount(0);

      // Opened from a citation (the Sources sheet), the PDF's toolbar has one more control and still fits
      // a phone's width (360 and 390 px): nothing scrolls sideways, Download is whole on screen.
      await page.goto(`/${TENANT}/app/v/${ventureId}`);
      await startConversation(page, `Seats by the window go first: what did phone survey ${token} find?`);
      await page
        .getByRole('article', { name: 'Exchange 1' })
        .getByRole('button', { name: /^Source \d+: / })
        .first()
        .click({ timeout: 30_000 });
      const sources = page.getByRole('dialog', { name: 'Context' });
      await sources
        .getByRole('article', { name: new RegExp(`^${survey.replace(/[.-]/g, '\\$&')}`) })
        .getByRole('link', { name: 'Open document' })
        .click();
      const cited = page.getByRole('dialog', { name: survey });
      await expect(cited.locator('[data-page-index="0"][data-rendered]')).toBeVisible({ timeout: 15_000 });
      const controls = cited.getByRole('toolbar', { name: 'Document controls' });
      await expect(controls.getByRole('button', { name: 'Jump to cited passage' })).toBeVisible();
      await expect(cited.getByRole('link', { name: 'Open in a new tab' })).toHaveCount(0);
      for (const width of [390, 360]) {
        await page.setViewportSize({ width, height: 800 });
        const fit = await controls.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
        expect(fit.scroll).toBeLessThanOrEqual(fit.client);
        const download = await controls.getByRole('button', { name: 'Download' }).boundingBox();
        expect(download).not.toBeNull();
        expect((download?.x ?? 0) + (download?.width ?? 0)).toBeLessThanOrEqual(width);
        await expectNoHorizontalScroll(page);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await cited.getByRole('button', { name: 'Close' }).click();
      await expect(cited).toHaveCount(0);

      await page.goto(`/${TENANT}/app/v/${ventureId}/documents`);
      await deleteDocument(page, row, survey);
    });
  });

  /**
   * A citation of the program's own handbook opens the handbook's text in the viewer, at the passage.
   */
  test('opens program guidance a citation came from, at the passage', async ({ page }) => {
    await openVenture(page);
    await startConversation(
      page,
      'What should an experiment card state? I need a success threshold set in advance and a time box.',
    );
    const answer = page.getByRole('article', { name: 'Exchange 1' });
    await answer
      .getByRole('button', { name: /^Source \d+: / })
      .first()
      .click({ timeout: 30_000 });
    const panel = page.getByRole('complementary', { name: 'Context inspector' });
    const guidance = panel
      .getByRole('article')
      .filter({ hasText: 'Program guidance' })
      .filter({ hasText: 'Experiment card' });
    await expect(guidance.first()).toBeVisible();
    await guidance.first().getByRole('link', { name: 'Read source' }).click();
    const viewer = page.getByRole('dialog', {
      name: 'Foundry venture-building method (synthetic program handbook)',
    });
    await expect(viewer).toBeVisible();
    await expect(viewer.getByText(/^Program guidance · Updated /)).toBeVisible();
    await expect(
      viewer.locator('[data-cited]').filter({ hasText: 'Every experiment card states' }),
    ).toBeVisible();
    // Program text cannot be downloaded: it is not one of the venture's files.
    await expect(viewer.getByRole('link', { name: 'Download' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
  });
});
