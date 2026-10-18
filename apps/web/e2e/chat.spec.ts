import { expect, type Page } from '@playwright/test';

import { barTextContrast } from './support/contrast';
import {
  composer,
  expectNoHorizontalScroll,
  FOUNDER_STATE,
  openVenture,
  runToken,
  startConversation,
  test,
  useTheme,
} from './support/fixtures';
import { feedLongAnswers, LONG_FOLLOW_UPS, LONG_PARAGRAPHS } from './support/long-answer';

/*
 * The conversation page around its composer: the latest answer's actions and the follow-up chips above the
 * composer never cover each other, and a chip never wipes what the founder was typing. With a real model's
 * answer (four paragraphs) and its long follow-up questions (LAB-U1), the end of the answer and its actions are
 * kept in view above the composer area as it finishes, the chips stay on one line, and a reader who scrolled up
 * while it streamed is left where they are. The conversation's header stays legible over the prose under it.
 */

/** Room kept between the latest answer's actions and the glass composer area below them. */
const FADE_PX = 32;
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/** Sends a message from the conversation's composer and waits for its answer (exchange `ordinal`). */
async function askNext(page: Page, text: string, ordinal: number): Promise<void> {
  const box = composer(page);
  await box.fill(text);
  await box.press('Enter');
  await expect(
    page
      .getByRole('article', { name: `Exchange ${String(ordinal)}` })
      .getByRole('button', { name: 'Copy answer' }),
  ).toBeVisible({ timeout: 30_000 });
}

/** The long chips are on screen (the answer has finished and the page has settled on it). */
async function expectLongChips(page: Page): Promise<void> {
  const chips = page.getByRole('list', { name: 'Follow-up questions' });
  await expect(chips.getByRole('button')).toHaveCount(LONG_FOLLOW_UPS.length);
  await expect(chips.getByRole('button').first()).toHaveText(LONG_FOLLOW_UPS[0] ?? '');
}

/**
 * The follow-up chips sit on one line whatever their length: one row of chips, no chip wraps onto a second line,
 * the row scrolls sideways inside itself (the page never does), and the last chip can be brought into view.
 */
async function expectChipsOnOneLine(page: Page, where: string): Promise<void> {
  const layout = await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('ul[aria-label="Follow-up questions"]');
    if (!list) return null;
    const buttons = [...list.querySelectorAll('button')];
    return {
      overflowX: getComputedStyle(list).overflowX,
      scrolls: list.scrollWidth > list.clientWidth + 1,
      listHeight: list.getBoundingClientRect().height,
      tops: buttons.map((b) => Math.round(b.getBoundingClientRect().top)),
      lines: buttons.map((b) => {
        const style = getComputedStyle(b);
        const content = b.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
        return content / parseFloat(style.lineHeight);
      }),
      tallest: Math.max(...buttons.map((b) => b.getBoundingClientRect().height)),
    };
  });
  if (!layout) throw new Error(`${where}: no follow-up chips`);
  expect(new Set(layout.tops).size, `${where}: the chips share one row`).toBe(1);
  for (const lines of layout.lines) {
    expect(lines, `${where}: no chip wraps onto a second line`).toBeLessThan(1.5);
  }
  expect(layout.listHeight, `${where}: the chip row is one chip tall`).toBeLessThanOrEqual(
    layout.tallest + 4,
  );
  expect(['auto', 'scroll'], `${where}: the chip row scrolls sideways`).toContain(layout.overflowX);
  expect(layout.scrolls, `${where}: long chips overflow the row (and scroll)`).toBe(true);
  await expectNoHorizontalScroll(page);
  // The last chip is reachable inside the row (Tab brings it into view).
  const last = page.getByRole('list', { name: 'Follow-up questions' }).getByRole('button').last();
  await last.focus();
  const visible = await last.evaluate((button) => {
    const list = button.closest('ul');
    if (!list) return false;
    const b = button.getBoundingClientRect();
    const l = list.getBoundingClientRect();
    return b.left >= l.left - 1 && b.left < l.right;
  });
  expect(visible, `${where}: the last chip scrolls into view when focused`).toBe(true);
  await last.blur();
}

/**
 * The composer area is measured: the page's scroll padding (anything scrolled or focused into view lands above
 * it) is the dock's real height, which grows and shrinks with it.
 */
async function expectDockMeasured(page: Page, where: string): Promise<void> {
  const measured = await page.evaluate(() => {
    const dock = document.querySelector('[data-slot="composer-dock"]');
    return {
      dock: dock ? Math.ceil(dock.getBoundingClientRect().height) : 0,
      padding: parseFloat(getComputedStyle(document.documentElement).scrollPaddingBottom) || 0,
    };
  });
  expect(measured.dock, `${where}: the composer area is laid out`).toBeGreaterThan(0);
  expect(
    Math.abs(measured.padding - measured.dock),
    `${where}: scroll padding = the dock's height`,
  ).toBeLessThan(2);
}

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
    // The composer area is glass over the transcript; the header, which prose scrolls under, the denser bar glass.
    await expect(page.locator('[data-slot="composer-dock"]')).toHaveClass(/(^|\s)glass(\s|$)/);
    await expect(page.getByRole('main').locator('header').first()).toHaveClass(/(^|\s)glass-bar(\s|$)/);
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

  test('a long real-model answer with long chips ends in view above the composer, and the chips stay on one line (LAB-U1)', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await feedLongAnswers(page);
    await page.setViewportSize(DESKTOP);
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await openVenture(page);
    await startConversation(page, `How should we price the two-library pilot? ${runToken()}`);
    const first = page.getByRole('article', { name: 'Exchange 1' });
    await expect(first.getByRole('button', { name: 'Copy answer' })).toBeVisible({ timeout: 30_000 });
    await expect(first).toContainText(LONG_PARAGRAPHS.at(-1)?.slice(0, 60) ?? '');
    await expectLongChips(page);
    // The answer is taller than the screen: it could not have fit, so the page kept its end in view as it grew.
    const tall = await first.evaluate((article) => article.getBoundingClientRect().height);
    expect(tall, 'the answer is taller than the viewport').toBeGreaterThan(DESKTOP.height);
    await expectActionsClearOfChips(page, 'a long answer as it finished, 1440×900');
    await expectChipsOnOneLine(page, '1440×900');
    await expectDockMeasured(page, '1440×900');

    // On a phone, in both themes: the next long answer ends in view as it finishes too.
    await page.setViewportSize(PHONE);
    for (const [ordinal, scheme] of [
      [2, 'dark'],
      [3, 'light'],
    ] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await useTheme(page, scheme);
      await askNext(page, `And what should the deposit be? ${runToken()}`, ordinal);
      await expectLongChips(page);
      await expectActionsClearOfChips(page, `a long answer as it finished, 390×844 ${scheme}`);
      await expectChipsOnOneLine(page, `390×844 ${scheme}`);
      await expectDockMeasured(page, `390×844 ${scheme}`);
    }
  });

  test('a reader who scrolls up while a long answer streams is left where they are when it finishes', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    // Slow units, so there is time to scroll away while the answer is still coming in.
    await feedLongAnswers(page, { unitDelayMs: 700 });
    await page.setViewportSize(DESKTOP);
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await openVenture(page);
    await startConversation(page, `What would make a library pay for the pilot? ${runToken()}`);
    await expect(
      page.getByRole('article', { name: 'Exchange 1' }).getByRole('button', { name: 'Copy answer' }),
    ).toBeVisible({ timeout: 30_000 });
    await expectLongChips(page);

    const box = composer(page);
    await box.fill(`Should the deposit be refundable? ${runToken()}`);
    await box.press('Enter');
    const live = page.getByRole('article', { name: 'Current exchange' });
    // The second of the extra paragraphs is streaming in: the page follows the answer's end until the reader acts.
    await expect(live).toContainText(LONG_PARAGRAPHS[1]?.slice(0, 60) ?? '', { timeout: 30_000 });
    await page.mouse.move(DESKTOP.width / 2, DESKTOP.height / 3);
    await page.mouse.wheel(0, -500);
    await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 5_000 }).toBeGreaterThan(0);
    // Let the wheel scroll settle, then remember where the reader is.
    await page.waitForTimeout(300);
    const before = await page.evaluate(() => window.scrollY);
    const second = page.getByRole('article', { name: 'Exchange 2' });
    await expect(second.getByRole('button', { name: 'Copy answer' })).toBeVisible({ timeout: 30_000 });
    await expectLongChips(page);
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => window.scrollY);
    expect(Math.abs(after - before), 'the page did not move after the reader scrolled away').toBeLessThan(2);
    // So the end of the answer is still below, out of view, for them to read down to.
    await expect(second.getByRole('button', { name: 'Copy answer' })).not.toBeInViewport();
  });

  test('the conversation header keeps AA contrast over the prose under it, on a phone and a desktop', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await feedLongAnswers(page);
    await page.setViewportSize(PHONE);
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await openVenture(page);
    await startConversation(page, `Is per-branch pricing too complicated? ${runToken()}`);
    const answer = page.getByRole('article', { name: 'Exchange 1' });
    await expect(answer.getByRole('button', { name: 'Copy answer' })).toBeVisible({ timeout: 30_000 });
    const header = page.getByRole('main').locator('header').first();
    for (const size of [PHONE, DESKTOP]) {
      await page.setViewportSize(size);
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
        await useTheme(page, scheme);
        // Prose under the header: the answer's first paragraph scrolled to the header's line.
        await answer
          .locator('p')
          .first()
          .evaluate((p) => {
            const bar = document.querySelector('main header');
            const top = p.getBoundingClientRect().top + window.scrollY;
            window.scrollTo(0, top - (bar ? bar.getBoundingClientRect().height / 2 : 0));
          });
        // What can pass beneath the bar: the page, the prose (its text colour as a solid block: the worst case, as a
        // filled button of the same colour passes unblurred) and the founder's message bubble.
        const under = await page.evaluate(() => {
          const prose = document.querySelector('[data-slot="veir-answer"] p');
          const bubble = [...document.querySelectorAll('article p')].find((p) =>
            p.querySelector('.sr-only')?.textContent.startsWith('Message'),
          );
          return [
            getComputedStyle(document.body).backgroundColor,
            prose ? getComputedStyle(prose).color : '',
            bubble ? getComputedStyle(bubble).backgroundColor : '',
          ];
        });
        expect(under.filter(Boolean), 'the page, the prose and a message bubble were measured').toHaveLength(
          3,
        );
        const measured = await barTextContrast(header, under);
        expect(measured.length, 'the header has text').toBeGreaterThan(0);
        const failing = measured
          .filter((m) => m.ratio < 4.5)
          .map((m) => `"${m.text}" ${m.ratio.toFixed(2)}:1`);
        expect(
          failing,
          `${String(size.width)}×${String(size.height)} ${scheme}: header text below 4.5:1`,
        ).toEqual([]);
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
    // (A little slack for the page's own chrome; the defect made the page as tall as the whole list.)
    expect(layout.page, 'the page is as tall as the conversation, not the panel').toBeLessThanOrEqual(
      Math.max(900, layout.conversation) + 120,
    );
    await expect(page.getByRole('main').locator('header').first()).toBeInViewport();
    // The new exchange is where the reader is (its message was brought to the top of the column).
    await expect(second).toBeInViewport();
    await page.getByRole('button', { name: 'Hide context panel' }).click();
  });
});
