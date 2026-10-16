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

/** Room kept between the latest answer's actions and the glass composer area below them. */
const FADE_PX = 32;

/** Asks one question from New chat and waits for its answer, with its actions and follow-up chips. */
async function askFirstQuestion(page: Page): Promise<void> {
  await openVenture(page);
  await startConversation(page, `What would make a library pay for the pilot? ${runToken()}`);
  const answer = page.getByRole('article', { name: 'Exchange 1' });
  await expect(answer.getByRole('button', { name: 'Copy answer' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('list', { name: 'Follow-up questions' })).toBeVisible();
}

/** The latest answer's action row (copy, thumbs) lies wholly above the chips and the composer area. */
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
  expect(box.rowBottom, `${where}: the action row ends clear of the composer area`).toBeLessThanOrEqual(
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
    // The composer area and the header are the shared glass surface over the transcript.
    await expect(page.locator('[data-slot="composer-dock"]')).toHaveClass(/(^|\s)glass(\s|$)/);
    await expect(page.getByRole('main').locator('header').first()).toHaveClass(/(^|\s)glass(\s|$)/);
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

  test('with the context panel open, the conversation stays in view and the page does not grow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await askFirstQuestion(page);
    // A long Sources list in the open panel must scroll inside the panel, not stretch the page.
    await page.getByRole('button', { name: 'Show context panel' }).click();
    const panel = page.getByRole('complementary', { name: 'Context inspector' });
    await expect(panel.getByRole('tab', { name: 'Sources' })).toHaveAttribute('aria-selected', 'true');
    const box = composer(page);
    await box.fill(`And what should the deposit be? ${runToken()}`);
    await box.press('Enter');
    const second = page.getByRole('article', { name: 'Exchange 2' });
    await expect(second.getByRole('button', { name: 'Copy answer' })).toBeVisible({ timeout: 30_000 });
    const layout = await page.evaluate(() => {
      const content = document.querySelector('main [class*="@container/conv"]');
      return {
        page: document.documentElement.scrollHeight,
        conversation: content ? content.getBoundingClientRect().height : 0,
      };
    });
    expect(layout.page, 'the page is as tall as the conversation, not the panel').toBeLessThanOrEqual(
      Math.max(900, layout.conversation) + 2,
    );
    await expect(page.getByRole('main').locator('header').first()).toBeInViewport();
    // The new exchange is where the reader is (its message was brought to the top of the column).
    await expect(second).toBeInViewport();
    await page.getByRole('button', { name: 'Hide context panel' }).click();
  });
});
