import { expect, type Page } from '@playwright/test';

import {
  composer,
  FOUNDER_STATE,
  openVenture,
  runToken,
  startConversation,
  test,
  useTheme,
} from './support/fixtures';

/*
 * The conversation page around its composer: the latest answer's actions and the follow-up chips above the
 * composer never cover each other, and a chip never wipes what the founder was typing.
 */

/** The composer's fade reaches this far above it (`before:-top-8` in conversation-page.tsx). */
const FADE_PX = 32;

/** Asks one question from New chat and waits for its answer, with its actions and follow-up chips. */
async function askFirstQuestion(page: Page): Promise<void> {
  await openVenture(page);
  await startConversation(page, `What would make a library pay for the pilot? ${runToken()}`);
  const answer = page.getByRole('article', { name: 'Exchange 1' });
  await expect(answer.getByRole('button', { name: 'Copy answer' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('list', { name: 'Follow-up questions' })).toBeVisible();
}

/** The latest answer's action row (copy, thumbs) lies wholly above the chips and the composer's fade. */
async function expectActionsClearOfChips(page: Page, where: string): Promise<void> {
  const box = await page.evaluate(() => {
    const copy = [...document.querySelectorAll('button[aria-label="Copy answer"]')].at(-1);
    const row = copy?.parentElement?.getBoundingClientRect();
    const chips = document.querySelector('ul[aria-label="Follow-up questions"]');
    const dock = chips?.closest('[data-print="hide"]')?.getBoundingClientRect();
    return row && chips && dock
      ? {
          rowTop: row.top,
          rowBottom: row.bottom,
          chipsTop: chips.getBoundingClientRect().top,
          dockTop: dock.top,
        }
      : null;
  });
  if (!box) throw new Error(`${where}: no action row or chips`);
  expect(box.rowTop, `${where}: the action row is on screen`).toBeGreaterThanOrEqual(0);
  expect(box.rowBottom, `${where}: the action row ends above the chips`).toBeLessThanOrEqual(box.chipsTop);
  expect(box.rowBottom, `${where}: the action row ends above the composer's fade`).toBeLessThanOrEqual(
    box.dockTop - FADE_PX,
  );
}

test.describe('conversation composer', () => {
  test.use({ storageState: FOUNDER_STATE });

  test('the latest answer’s actions stay clear of the follow-up chips, at both sizes and in both themes', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await askFirstQuestion(page);
    // The first answer fit until it finished: the page keeps its end in view, actions and chips together.
    await expectActionsClearOfChips(page, 'the first answer as it finished, 1440×900');

    for (const size of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(size);
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
        await useTheme(page, scheme);
        await page.evaluate(() => {
          window.scrollTo(0, document.documentElement.scrollHeight);
        });
        await expectActionsClearOfChips(
          page,
          `scrolled to the end, ${String(size.width)}×${String(size.height)} ${scheme}`,
        );
      }
    }
  });

  test('a follow-up chip sends its question and leaves an unsent draft where it was', async ({ page }) => {
    await askFirstQuestion(page);
    const box = composer(page);
    await box.fill('My unsent draft about the deposit');
    const chip = page.getByRole('list', { name: 'Follow-up questions' }).getByRole('button').first();
    const question = (await chip.textContent())?.trim() ?? '';
    await chip.click();
    await expect(page.getByRole('article', { name: 'Exchange 2' })).toContainText(question, {
      timeout: 30_000,
    });
    await expect(box).toHaveValue('My unsent draft about the deposit');
  });
});
