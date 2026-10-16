import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, type Page } from '@playwright/test';

import { composer, FOUNDER_STATE, openVenture, runToken, startConversation, test } from './support/fixtures';

/*
 * The API reads a founder's conversation makes (docs/runbooks/latency.md): New chat, three questions in one
 * conversation, a look at Knowledge and back. Production read `GET /ventures/:id/memory` 93 times in a month
 * for one founder; the reads per route are written to test-results/requests/ and printed. Asserted: a turn
 * reads again only what a turn changes, so the notebook, the documents and the call settings are read once
 * per page that shows them, however many turns there are.
 */

const TURNS = 3;

/** `GET /api/v1/…` paths with ids replaced, so reads of the same route count together. */
function route(url: string): string {
  return new URL(url).pathname
    .replace(/^\/api\/v1/, '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ':id');
}

async function answered(page: Page, exchange: number): Promise<void> {
  const answer = page.getByRole('article', { name: `Exchange ${String(exchange)}` });
  await expect(answer.getByRole('button', { name: 'Copy answer' })).toBeVisible({ timeout: 30_000 });
}

test.describe('API reads of a conversation', () => {
  test.use({ storageState: FOUNDER_STATE });

  test('three turns read again only what a turn changes', async ({ page }, testInfo) => {
    const reads: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'GET' && new URL(request.url()).pathname.startsWith('/api/v1/')) {
        reads.push(route(request.url()));
      }
    });

    await openVenture(page);
    await startConversation(page, `What should we measure first in the pilot? ${runToken()}`);
    await answered(page, 1);
    for (let turn = 2; turn <= TURNS; turn += 1) {
      const box = composer(page);
      await box.fill(`And after that, what comes next? ${String(turn)}`);
      await box.press('Enter');
      await answered(page, turn);
    }
    // Let the refreshes a finished turn starts settle before counting.
    await page.waitForLoadState('networkidle');
    await page
      .getByRole('link', { name: /^Knowledge/ })
      .first()
      .click();
    await expect(page.getByRole('heading', { level: 1, name: /Knowledge/ })).toBeVisible();
    await page.waitForLoadState('networkidle');
    // Back in the app (no reload): what is still fresh is not asked for again.
    await page.goBack();
    await answered(page, TURNS);
    await page.waitForLoadState('networkidle');

    const counts: Record<string, number> = {};
    for (const r of reads) counts[r] = (counts[r] ?? 0) + 1;
    const result = { label: process.env.PERF_LABEL ?? 'run', turns: TURNS, total: reads.length, counts };
    const dir = join(testInfo.project.outputDir, 'requests');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${result.label}.json`), JSON.stringify(result, null, 2));
    process.stdout.write(`api-reads ${JSON.stringify(result)}\n`);

    // Read when a page that shows them opens (New chat, the conversation twice), never again per turn.
    for (const unchanged of [
      '/ventures/:id/notebook',
      '/ventures/:id/documents',
      '/ventures/:id/call-config',
    ]) {
      expect(counts[unchanged] ?? 0, `${unchanged} is not read again after each turn`).toBeLessThan(TURNS);
    }
  });
});
