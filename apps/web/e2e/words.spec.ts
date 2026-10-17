import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import {
  composer,
  issueAccessCodeViaApi,
  openVenture,
  OWNER_STATE,
  runToken,
  signIn,
  TENANT,
  test,
} from './support/fixtures';

/*
 * Word budgets for the main founder screens: the words a founder sees on New chat, a conversation, a call,
 * Knowledge and Documents, counted in the browser and held to e2e/word-budget.json. Each budget sits below
 * the count recorded before the wave-6 copy pass, so the cut is recorded and cannot quietly come back.
 *
 * Counted: every rendered word (text and empty-field placeholders) a sighted person can see, shell included.
 * Not counted: words read only by screen readers, the AI disclosure (never cut for brevity), what the vEIR
 * or the founder wrote (the answer, its follow-ups, call captions, the founder's own message, conversation
 * titles), toasts, and dialogs layered over the screen.
 *
 * Measured as Priya (BenchTally's founder), whose venture no other spec writes to, so both runs of the suite
 * see the same screens. The conversation is private and deleted at the end, leaving nothing behind.
 *
 *   E2E_WORDS_RECORD=<file>  write the counts there instead of checking them (to record new budgets)
 */

const WRITE_HEADERS = { 'x-requested-with': 'foundry-ascent', 'content-type': 'application/json' };
const FOUNDER = 'Priya Ramaswamy-Holt';
const here = dirname(fileURLToPath(import.meta.url));

interface Budget {
  /** Words before the wave-6 copy pass (base 90cebac). */
  before: number;
  /** The most this screen may show now. */
  budget: number;
}

const BUDGETS = (
  JSON.parse(readFileSync(join(here, 'word-budget.json'), 'utf8')) as {
    screens: Record<string, Budget>;
  }
).screens;

/** A screen's visible word count, and the words themselves (written when recording). */
interface Counted {
  words: number;
  text: string;
}

const SCREENS = ['New chat', 'Conversation', 'Call', 'Knowledge', 'Documents'] as const;
type Screen = (typeof SCREENS)[number];

/** Visible words inside `root`, minus the excluded regions and exact strings (see the header). */
async function visibleWords(root: Locator, skipText: readonly string[] = []): Promise<Counted> {
  return root.evaluate((element, skip) => {
    const EXCLUDED = [
      '[role="note"][aria-label="AI disclosure"]',
      '[data-slot="markdown"]',
      '[aria-label="Follow-up questions"]',
      '[aria-label="Captions"]',
      '[aria-label="Recent conversations"]',
      '[data-sonner-toaster]',
    ].join(', ');
    const layered = (node: Element) => {
      const dialog = node.closest('[role="dialog"], [role="alertdialog"]');
      return dialog !== null && dialog !== element && !dialog.contains(element);
    };
    const shown = (node: Element) => {
      if (!node.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
      const box = node.getBoundingClientRect();
      // Screen-reader-only text is clipped to a 1px box; a skip link waits above the page until focused.
      return (
        box.width > 1 && box.height > 1 && box.bottom + window.scrollY > 0 && box.right + window.scrollX > 0
      );
    };
    const count = (text: string) => text.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
    let words = 0;
    const seen: string[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      const text = node.textContent ?? '';
      if (!parent || !text.trim() || skip.includes(text.trim())) continue;
      if (parent.closest(EXCLUDED) || layered(parent) || !shown(parent)) continue;
      words += count(text);
      seen.push(text.trim());
    }
    for (const field of element.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      'input[placeholder], textarea[placeholder]',
    )) {
      if (field.value || field.closest(EXCLUDED) || layered(field) || !shown(field)) continue;
      words += count(field.placeholder);
      seen.push(`[${field.placeholder}]`);
    }
    return { words, text: seen.join(' | ') };
  }, skipText);
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/** Deletes conversations this spec left behind (a failed earlier run), so every run starts the same. */
async function deleteLeftovers(request: APIRequestContext, ventureId: string): Promise<void> {
  const list = await request.get(`/api/v1/ventures/${ventureId}/sessions`);
  expect(list.status(), 'GET /ventures/:id/sessions').toBe(200);
  const items = ((await list.json()) as { items: { id: string; privacy: string }[] }).items;
  // Only this spec opens private conversations in this venture.
  for (const item of items.filter((session) => session.privacy === 'ephemeral')) {
    await deleteSession(request, item.id);
  }
}

async function deleteSession(request: APIRequestContext, id: string): Promise<void> {
  const response = await request.delete(`/api/v1/sessions/${id}`, {
    headers: { ...WRITE_HEADERS, 'idempotency-key': runToken() },
  });
  expect([204, 404], 'DELETE /sessions/:id').toContain(response.status());
}

test.describe('word budgets', () => {
  test('the main founder screens stay within their word budgets', async ({ page, browser }) => {
    test.setTimeout(120_000);
    const owner = await browser.newContext({ storageState: OWNER_STATE });
    const code = await issueAccessCodeViaApi(owner.request, FOUNDER);
    await owner.close();
    await signIn(page, code);
    const ventureId = await openVenture(page);
    // The call notice (a first call's one-time explanation) is not part of the call screen measured here.
    const notice = await page.request.post('/api/v1/calls/notice/acknowledge', { headers: WRITE_HEADERS });
    expect(notice.status(), 'POST /calls/notice/acknowledge').toBe(200);
    await deleteLeftovers(page.request, ventureId);

    const counts = {} as Record<Screen, Counted>;
    const body = page.locator('body');

    await test.step('New chat', async () => {
      await openVenture(page);
      await settle(page);
      counts['New chat'] = await visibleWords(body);
    });

    await test.step('Knowledge', async () => {
      await page.goto(`/${TENANT}/app/v/${ventureId}/knowledge`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await settle(page);
      counts.Knowledge = await visibleWords(body);
    });

    await test.step('Documents', async () => {
      await page.goto(`/${TENANT}/app/v/${ventureId}/documents`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await settle(page);
      counts.Documents = await visibleWords(body);
    });

    const message = `What should our paid pilot prove first? ${runToken()}`;
    let sessionId = '';
    try {
      await test.step('Conversation (private, one answered exchange)', async () => {
        await openVenture(page);
        await page.getByRole('radio', { name: 'Private, a one-off' }).check();
        const box = composer(page);
        await box.fill(message);
        await box.press('Enter');
        await page.waitForURL(/\/c\/[0-9a-f-]{36}/);
        sessionId = /\/c\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
        await expect(
          page.getByRole('article', { name: 'Exchange 1' }).getByRole('button', { name: 'Copy answer' }),
        ).toBeVisible({ timeout: 30_000 });
        await settle(page);
        counts.Conversation = await visibleWords(body, [message]);
      });

      await test.step('Call (typed, as in a browser without a microphone)', async () => {
        await page
          .getByRole('main')
          .getByRole('link', { name: /^Call / })
          .first()
          .click();
        const screen = page.getByRole('dialog', { name: /^Call with / });
        await expect(screen.getByRole('textbox', { name: /^Reply to / })).toBeVisible();
        await settle(page);
        counts.Call = await visibleWords(screen);
        await screen.getByRole('button', { name: 'End call' }).click();
        await screen.getByRole('button', { name: 'Back to conversation' }).click();
        await expect(screen).toBeHidden();
      });
    } finally {
      if (sessionId) await deleteSession(page.request, sessionId);
    }

    const record = process.env.E2E_WORDS_RECORD;
    if (record) {
      writeFileSync(record, `${JSON.stringify(counts, null, 2)}\n`);
      return;
    }
    for (const screen of SCREENS) {
      const budget = BUDGETS[screen];
      expect(budget, `${screen} has a recorded budget`).toBeDefined();
      if (!budget) continue;
      expect(budget.budget, `${screen}: the budget records a cut`).toBeLessThan(budget.before);
      expect
        .soft(counts[screen].words, `${screen}: visible words (budget ${budget.budget})`)
        .toBeLessThanOrEqual(budget.budget);
    }
  });
});
