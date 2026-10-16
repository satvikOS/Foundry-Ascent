import { join } from 'node:path';

import { expect, type APIRequestContext, type Page } from '@playwright/test';

import {
  FOUNDER_STATE,
  composer,
  openVenture,
  runToken,
  startConversation,
  test,
  useTheme,
} from './support/fixtures';

/*
 * The owner's failure, end to end: after one conversation, the next one must know what it was about. The
 * vEIR's first words in the second conversation call back to the first, and "do you remember what we talked
 * about last time?" is answered from it, specifically. Both conversations are deleted afterwards (which erases
 * everything derived from them), so reruns against one database start from the same place.
 */

const WRITE_HEADERS = { 'x-requested-with': 'foundry-ascent', 'content-type': 'application/json' };
/** Where screenshots of the second conversation go when set (desktop and phone, light and dark). */
const SHOTS = process.env.E2E_SHOTS_DIR;

interface SessionDetail {
  session: { id: string; opener: string | null; digest: { summary: string } | null };
  turns: { ordinal: number; status: string; response: { answer: string } | null }[];
}

async function sessionDetail(request: APIRequestContext, id: string): Promise<SessionDetail> {
  const response = await request.get(`/api/v1/sessions/${id}`);
  expect(response.status(), 'GET /sessions/:id').toBe(200);
  return (await response.json()) as SessionDetail;
}

/** Sends a message in the open conversation and waits for exchange `n` to finish. */
async function say(page: Page, text: string, n: number): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press('Enter');
  await expect(
    page.getByRole('article', { name: `Exchange ${String(n)}` }).getByRole('button', { name: 'Copy answer' }),
  ).toBeVisible({ timeout: 30_000 });
}

/** The answer of exchange `n` as stored (the authoritative, validated text). */
async function answerOf(request: APIRequestContext, sessionId: string, n: number): Promise<string> {
  const detail = await sessionDetail(request, sessionId);
  const turn = detail.turns.find((t) => t.ordinal === n);
  expect(turn?.status, `turn ${String(n)}`).toBe('completed');
  return turn?.response?.answer ?? '';
}

test.describe('continuity across conversations', () => {
  test.use({ storageState: FOUNDER_STATE });

  test('the next conversation opens from the last one and remembers it when asked', async ({ page }) => {
    test.setTimeout(150_000);
    const created: string[] = [];
    try {
      await test.step('a first conversation about pricing, with a plan', async () => {
        await openVenture(page);
        const id = await startConversation(
          page,
          `How should we price per library? We have two libraries interested. ${runToken()}`,
        );
        created.push(id);
        await expect(
          page.getByRole('article', { name: 'Exchange 1' }).getByRole('button', { name: 'Copy answer' }),
        ).toBeVisible({ timeout: 30_000 });
        await say(
          page,
          "Facilities holds the budget, I think. I'll call facilities about the library budget tomorrow.",
          2,
        );
        // The founder ends it; what it was about is summarised for the next conversation.
        const ended = await page.request.post(`/api/v1/sessions/${id}/end`, { headers: WRITE_HEADERS });
        expect(ended.status(), 'POST /sessions/:id/end').toBe(200);
        await expect
          .poll(async () => (await sessionDetail(page.request, id)).session.digest !== null, {
            timeout: 30_000,
          })
          .toBe(true);
      });

      await test.step('the second conversation opens from where the first left off', async () => {
        await openVenture(page);
        const id = await startConversation(page, 'Hi!');
        created.push(id);
        const opened = page.getByRole('region', { name: /opened the conversation$/ });
        await expect(opened).toContainText(/facilities|library budget|pric/i);
        await expect(
          page.getByRole('article', { name: 'Exchange 1' }).getByRole('button', { name: 'Copy answer' }),
        ).toBeVisible({ timeout: 30_000 });
        const hello = await answerOf(page.request, id, 1);
        // A hello back that varies per conversation, then where we were.
        expect(hello).toMatch(/^(?:Hi|Hey|Hello) Maya[.,]/);
        expect(hello).toMatch(/we were on pricing/i);
        // The reply to the hello does not ask the opener's question again.
        expect(hello).not.toContain('?');
      });

      await test.step('"do you remember what we talked about last time?" is answered from the first', async () => {
        const id = created[1] ?? '';
        await say(page, 'Do you remember what we talked about last time?', 2);
        const recall = page.getByRole('article', { name: 'Exchange 2' });
        await expect(recall).toContainText(/we were on pricing/i);
        await expect(recall).toContainText(/call facilities about the library budget/i);
        const answer = await answerOf(page.request, id, 2);
        // "earlier today", "a moment ago": however the last conversation's time is told.
        expect(answer).toMatch(/^(?:Yes|I do|Sure)\. When we (?:talked|spoke) [^,]+, we were on pricing\./);
        // A memory question is social: nothing to cite, plan or remember.
        await expect(recall.getByRole('region', { name: 'Suggested next steps' })).toHaveCount(0);
      });

      if (SHOTS) {
        await test.step('screenshots of the remembered conversation', async () => {
          for (const [label, size] of [
            ['desktop', { width: 1440, height: 900 }],
            ['mobile', { width: 390, height: 844 }],
          ] as const) {
            await page.setViewportSize(size);
            for (const scheme of ['light', 'dark'] as const) {
              await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
              await useTheme(page, scheme);
              await page.getByRole('article', { name: 'Exchange 2' }).scrollIntoViewIfNeeded();
              await page.screenshot({ path: join(SHOTS, `continuity-${label}-${scheme}.png`) });
            }
          }
        });
      }
    } finally {
      for (const id of created) {
        const removed = await page.request.delete(`/api/v1/sessions/${id}`, { headers: WRITE_HEADERS });
        expect([204, 404], 'DELETE /sessions/:id').toContain(removed.status());
      }
    }
  });
});
