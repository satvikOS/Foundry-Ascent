import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, type Page } from '@playwright/test';

import {
  composer,
  expectNoHorizontalScroll,
  expectNoSeriousA11yViolations,
  expectReachable,
  FOUNDER_STATE,
  issueAccessCodeViaApi,
  openVenture,
  OWNER_STATE,
  signIn,
  startConversation,
  TENANT,
  test,
  useTheme,
} from './support/fixtures';
import { makeOfferedGuidance, makeOfferedStep } from '../src/features/path/testing';
import { mockPath, scriptTurns } from './support/path-mock';

/*
 * The founder path as a founder sees it: the step's card from the moment it is known (before the words) through done,
 * the path page on a phone, an iPad and a desktop, the intake, the one-page plan on paper, and the same step beside a
 * call. The path and the turns are mocked (support/path-mock.ts); everything else is the real local app.
 *
 *   E2E_PATH_DIR=<dir>  also save screenshots there for design review
 */

const STEP = 'Hear five lab managers describe the last time they ran out of a reagent';
const NEXT = 'Write down the three costs they named';

const DIR = process.env.E2E_PATH_DIR ?? '';
async function shot(page: Page, name: string): Promise<void> {
  if (!DIR) return;
  mkdirSync(DIR, { recursive: true });
  await page.screenshot({ path: join(DIR, `${name}.png`) });
}

function card(page: Page, title = STEP) {
  return page.locator('[data-slot="step-card"][data-state="open"]').filter({ hasText: title });
}

test.describe('the founder path', () => {
  test.use({ storageState: FOUNDER_STATE });

  test('New chat names the step and its date, and starts from the path', async ({ page }) => {
    await mockPath(page);
    await openVenture(page);
    const now = page.getByTestId('greeting-step');
    await expect(now).toContainText(`Now: ${STEP}`);
    await expect(now).toContainText(/By \w{3}/);
    const starts = page.getByRole('list', { name: 'Start with' });
    await expect(starts.getByRole('button')).toHaveText([`Continue: ${STEP}`, 'I finished it', 'I’m stuck']);
    await expectNoHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page, 'New chat with a path');
    await shot(page, 'new-chat');
    await starts.getByRole('button', { name: 'I’m stuck' }).click();
    await expect(composer(page)).toHaveValue(`I’m stuck on “${STEP}”: `);
    await expect(composer(page)).toBeFocused();
    // The sidebar opens the path.
    await page.getByRole('link', { name: 'Your path' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Your path' })).toBeVisible();
  });

  test('the step shows before the words, never moves them, and is done in the chat', async ({ page }) => {
    const mock = await mockPath(page);
    await scriptTurns(page);
    await openVenture(page);
    await startConversation(page, 'What should I do next?');

    const live = page.getByRole('article', { name: 'Current exchange' });
    await test.step('the card is there while there is not one word yet', async () => {
      await expect(live.locator('[data-slot="step-card"]')).toBeVisible();
      await expect(live.locator('[data-slot="markdown"]')).toHaveCount(0);
      await expect(live.getByRole('button', { name: 'Done' })).toBeDisabled();
    });

    await test.step('the words come in above it and stay where they are when the reply is stored', async () => {
      const prose = live.locator('[data-slot="markdown"]');
      await expect(prose).toContainText('Talk to five lab managers first');
      const offset = (article: string) =>
        page.evaluate((name) => {
          const host = [...document.querySelectorAll('article')].find(
            (element) => element.getAttribute('aria-label') === name,
          );
          const words = host?.querySelector('[data-slot="markdown"]');
          return host && words
            ? Math.round(words.getBoundingClientRect().top - host.getBoundingClientRect().top)
            : null;
        }, article);
      const before = await offset('Current exchange');
      await expect(page.getByRole('article', { name: 'Exchange 1' })).toBeVisible();
      expect(await offset('Exchange 1')).toBe(before);
    });

    const exchange = page.getByRole('article', { name: 'Exchange 1' });
    const step = exchange.locator('[data-slot="step-card"]');
    await expect(step).toContainText('Done when: Five people described the last time it happened');
    await expect(exchange.getByRole('region', { name: 'Suggested next steps' })).toHaveCount(0);
    // The answer is read before its step, however tall the step is: its first words stay under the header.
    const words = exchange.locator('[data-slot="markdown"]').first();
    for (const size of [page.viewportSize() ?? { width: 1440, height: 900 }, { width: 1280, height: 640 }]) {
      await page.setViewportSize(size);
      await expect.poll(async () => (await words.boundingBox())?.y ?? 0).toBeGreaterThan(60);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await expectNoSeriousA11yViolations(page, 'a reply with its step');
    await shot(page, 'conversation');

    await test.step('its template opens whole', async () => {
      await step.getByRole('button', { name: /^Open template/ }).click();
      const template = page.getByRole('dialog', { name: 'Interview invitation' });
      await expect(template).toContainText('I am studying how labs track reagents');
      await page.keyboard.press('Escape');
      await expect(template).toBeHidden();
    });

    await test.step('its source names the chapter and opens its page; a citation shows its passage', async () => {
      const source = step.getByRole('link', { name: /^The Mom Test, Chapter 3/ });
      await expect(source).toHaveAttribute('href', 'https://www.momtestbook.com/');
      await expect(source).toHaveAttribute('target', '_blank');
      await exchange.getByRole('button', { name: /^Source 1: / }).hover();
      const preview = page.getByRole('dialog', { name: 'Source 1' });
      await expect(preview).toContainText('Ask about specifics in the past');
      await shot(page, 'citation');
      await page.keyboard.press('Escape');
      await expect(preview).toBeHidden();
    });

    await test.step('a tick is kept', async () => {
      await step.getByRole('checkbox', { name: /Write to ten of them today/ }).check();
      await expect.poll(() => mock.path().now?.items[1]?.done).toBe(true);
    });

    await test.step('why this', async () => {
      await step.getByRole('button', { name: 'Why this' }).click();
      await expect(step).toContainText('Five real stories. Five people described the last time it happened.');
    });

    await test.step('not yet: a week more', async () => {
      await step.getByRole('button', { name: 'Not yet' }).click();
      await step.getByRole('button', { name: '1 week' }).click();
      await expect.poll(() => mock.updates().at(-1)?.action).toBe('reschedule');
      await expect(step.getByRole('button', { name: 'Not yet' })).toBeVisible();
    });

    await test.step('an older reply’s card is one line; only the latest is whole', async () => {
      const box = composer(page);
      await box.fill('And after that?');
      await box.press('Enter');
      const second = page.getByRole('article', { name: 'Exchange 2' });
      await expect(second.getByRole('button', { name: 'Done' })).toBeEnabled({ timeout: 15_000 });
      await expect(step).toHaveAttribute('data-state', 'closed');
      await expect(step.getByRole('button')).toHaveCount(1);
    });

    await test.step('done takes one line of evidence, and the path moves on', async () => {
      const latest = page.getByRole('article', { name: 'Exchange 2' }).locator('[data-slot="step-card"]');
      await latest.getByRole('button', { name: 'Done' }).click();
      const line = latest.getByRole('textbox', { name: 'What happened, in one line' });
      await expect(line).toBeFocused();
      await expect(latest.getByRole('button', { name: 'Save' })).toBeDisabled();
      await line.fill('Five calls; all ran out in October.');
      await line.press('Enter');
      await expect(latest).toContainText('Five calls; all ran out in October.');
      await expect(latest).toContainText(`Now: ${NEXT}`);
      expect(mock.updates().at(-1)).toEqual({
        action: 'complete',
        evidence: 'Five calls; all ran out in October.',
      });
      // The older card says so too.
      await expect(step).toContainText('Done');
      await latest.getByRole('link', { name: /^Now: / }).click();
    });

    await test.step('on the path page it is done, with the founder’s words', async () => {
      await expect(page.getByRole('heading', { level: 1, name: 'Your path' })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Now' })).toContainText(NEXT);
      const done = page.getByRole('region', { name: 'Done' });
      await done.getByRole('button', { name: new RegExp(STEP) }).click();
      await expect(done).toContainText('Five calls; all ran out in October.');
    });
  });

  test('a step offered as the answer is added in one press; the path’s own stays named under it', async ({
    page,
  }) => {
    const offered = makeOfferedStep();
    const mock = await mockPath(page, {}, [offered]);
    await scriptTurns(page, { pauseMs: 150, guidance: makeOfferedGuidance() });
    const ventureId = await openVenture(page);
    await startConversation(page, 'What should I charge a lab?');
    const step = page.getByRole('article', { name: 'Exchange 1' }).locator('[data-slot="step-card"]');
    const actions = step.getByRole('group', { name: 'This step' });
    await expect(step).toContainText(offered.title, { timeout: 15_000 });
    await expect(actions.getByRole('button').first()).toHaveText('Add to my path');
    const open = step.locator('[data-slot="step-path"]');
    await expect(open).toContainText(`Still open on your path: ${STEP}, by `);
    await expectNoHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page, 'an offered step');
    await shot(page, 'offered');

    await test.step('a sub-step can be ticked before it is on the path', async () => {
      await step.getByRole('checkbox', { name: /Write the price/ }).check();
      await expect(step.getByRole('checkbox', { name: /Write the price/ })).toBeChecked();
    });
    await actions.getByRole('button', { name: 'Add to my path' }).click();
    await expect(actions.getByRole('button', { name: 'Add to my path' })).toHaveCount(0);
    await expect(actions.getByRole('button').first()).toHaveText('Done');
    expect(mock.updates().map((update) => update.action)).toEqual(['tick', 'add']);
    expect(mock.path().next[0]?.title).toBe(offered.title);
    expect(mock.path().now?.title).toBe(STEP);

    // The line leads to the path, where both are.
    await open.getByRole('link', { name: STEP }).click();
    await expect(page).toHaveURL(new RegExp(`/v/${ventureId}/path$`));
    await expect(page.getByRole('region', { name: 'Now' })).toContainText(STEP);
    await expect(page.getByRole('main')).toContainText(offered.title);
  });

  test('a changed plan is kept with its reason', async ({ page }) => {
    const mock = await mockPath(page);
    await page.goto(`/${TENANT}/app`);
    const ventureId = await openVenture(page);
    await page.goto(`/${TENANT}/app/v/${ventureId}/path`);
    await card(page).getByRole('button', { name: 'Changed plan' }).click();
    const reason = card(page).getByRole('textbox', { name: 'What changed' });
    await reason.fill('We sell to schools now');
    await reason.press('Enter');
    await expect(page.getByRole('region', { name: 'Now' })).toContainText(NEXT);
    expect(mock.updates()).toEqual([{ action: 'skip', reason: 'We sell to schools now' }]);
  });

  for (const size of [
    { name: 'phone', width: 390, height: 844 },
    { name: 'ipad', width: 834, height: 1194 },
    { name: 'desktop', width: 1440, height: 900 },
  ]) {
    test(`the path page on a ${size.name}`, async ({ page }) => {
      await page.setViewportSize(size);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await mockPath(page);
      const ventureId = await openVenture(page);
      await page.goto(`/${TENANT}/app/v/${ventureId}/path`);
      await expect(page.getByRole('heading', { level: 1, name: 'Your path' })).toBeVisible();
      const rail = page.getByRole('list', { name: 'Stages' });
      await expect(rail.getByRole('listitem').filter({ has: page.getByRole('heading') })).toHaveCount(7);
      await expect(rail.getByRole('button', { name: /current: Discovery$/ })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      await expect(page.getByRole('list', { name: 'What Discovery asks for' })).toContainText('Claimed');
      await expect(page.getByRole('list', { name: 'Your story' }).getByRole('listitem')).toHaveCount(3);
      for (const name of ['Print', 'Copy text', 'Done', 'Not yet', 'Changed plan'])
        await expectReachable(page, page.getByRole('button', { name, exact: true }).first());
      await expectNoHorizontalScroll(page);
      for (const scheme of ['dark', 'light'] as const) {
        await useTheme(page, scheme);
        await expectNoSeriousA11yViolations(page, `path page, ${size.name} (${scheme})`);
        await page.evaluate(() => {
          window.scrollTo(0, 0);
        });
        await shot(page, `path-${size.name}-${scheme}`);
      }
    });
  }

  test('the plan prints on one page, with the disclosure and none of the app around it', async ({ page }) => {
    await mockPath(page);
    const ventureId = await openVenture(page);
    await page.goto(`/${TENANT}/app/v/${ventureId}/path`);
    await expect(page.getByRole('heading', { level: 1, name: 'Your path' })).toBeVisible();
    const sheet = page.locator('[data-slot="plan-sheet"]');
    await expect(sheet).toBeHidden();
    await page.emulateMedia({ media: 'print' });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('Stage 2 of 7: Discovery');
    await expect(sheet).toContainText(STEP);
    await expect(sheet).toContainText('From students to lab managers');
    await expect(sheet.getByRole('note', { name: 'AI disclosure' })).toBeVisible();
    await expect(page.locator('[data-slot="page-container"]')).toBeHidden();
    await expect(page.locator('[data-slot="side-panel"]')).toBeHidden();
    if (DIR) {
      mkdirSync(DIR, { recursive: true });
      await page.pdf({ format: 'A4', path: join(DIR, 'plan.pdf') });
      await shot(page, 'plan-print');
    }
    const pdf = await page.pdf({ format: 'A4' });
    const pages = pdf.toString('latin1').match(/\/Type\s*\/Page\b(?!s)/g)?.length ?? 0;
    expect(pages, 'pages of the printed plan').toBe(1);
  });

  test('copies the plan as text', async ({ page, context, baseURL }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL ?? '' });
    await mockPath(page);
    const ventureId = await openVenture(page);
    await page.goto(`/${TENANT}/app/v/${ventureId}/path`);
    await page.getByRole('button', { name: 'Copy text' }).click();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toContain('Stage 2 of 7: Discovery');
    expect(text).toContain(`Done when: Five people described the last time it happened, with dates.`);
  });

  test('the intake is asked once in the conversation, never in the way of typing', async ({ page }) => {
    const mock = await mockPath(page, { intake: null });
    await scriptTurns(page, { pauseMs: 150 });
    const ventureId = await openVenture(page);
    await startConversation(page, 'I have an idea. Can you help me get organised?');
    const intake = page.getByRole('region', { name: 'About you' });
    await expect(intake).toBeVisible({ timeout: 15_000 });
    // Typing goes on as ever, and the card keeps off it.
    await composer(page).fill('Still typing');
    await expect(composer(page)).toBeFocused();
    await intake.getByRole('button', { name: 'Start' }).click();
    await expect(intake.locator('[data-slot="intake-form"] label')).toHaveCount(5);
    await expect(composer(page)).toHaveValue('Still typing');
    await expectNoSeriousA11yViolations(page, 'the intake');
    await shot(page, 'intake');
    await intake.getByRole('textbox', { name: 'Your idea, in a sentence' }).fill('Reagent tracking for labs');
    await intake.getByRole('button', { name: 'First time' }).click();
    await intake.getByRole('textbox', { name: 'Next deadline' }).fill('Pitch night');
    await intake.getByRole('button', { name: 'Save' }).click();
    // Half a deadline is asked about, not guessed.
    await expect(intake).toContainText('Add both what and when.');
    await intake.getByLabel('Deadline date').fill('2099-12-10');
    await intake.getByRole('button', { name: 'Save' }).click();
    await expect(intake).toHaveCount(0);
    expect(mock.path().intake).toMatchObject({
      idea: 'Reagent tracking for labs',
      experience: 'first_time',
      deadline: { what: 'Pitch night', on: '2099-12-10' },
    });
    await page.goto(`/${TENANT}/app/v/${ventureId}/path`);
    await expect(page.getByRole('region', { name: 'About you' })).toContainText('Reagent tracking for labs');
  });

  test('a skipped intake is not asked again', async ({ page }) => {
    await mockPath(page, { intake: null });
    await scriptTurns(page, { pauseMs: 150 });
    await openVenture(page);
    await startConversation(page, 'Hello');
    const intake = page.getByRole('region', { name: 'About you' });
    await intake.getByRole('button', { name: 'Skip' }).click({ timeout: 15_000 });
    await expect(intake).toHaveCount(0);
    await openVenture(page);
    await startConversation(page, 'Hello again');
    await expect(page.getByRole('article', { name: 'Exchange 1' })).toBeVisible({ timeout: 15_000 });
    await expect(intake).toHaveCount(0);
  });
});

test.describe('during a call', () => {
  test.use({ storageState: FOUNDER_STATE });

  test('the step shows beside the call, and its review shows the same one', async ({ page }) => {
    test.setTimeout(90_000);
    // Typed, as in a browser without a microphone.
    await page.addInitScript(() => {
      const devices = navigator.mediaDevices as MediaDevices | undefined;
      if (!devices) return;
      Object.defineProperty(devices, 'getUserMedia', {
        configurable: true,
        value: () => Promise.reject(new DOMException('Requested device not found', 'NotFoundError')),
      });
    });
    await mockPath(page);
    await scriptTurns(page, { pauseMs: 150 });
    await openVenture(page);
    await startConversation(page, 'Hello');
    await expect(page.getByRole('article', { name: 'Exchange 1' })).toBeVisible({ timeout: 15_000 });
    const notice = await page.request.post('/api/v1/calls/notice/acknowledge', {
      headers: { 'x-requested-with': 'foundry-ascent', 'content-type': 'application/json' },
    });
    expect(notice.status(), 'POST /calls/notice/acknowledge').toBe(200);
    await page
      .getByRole('main')
      .getByRole('link', { name: /^Voice call with / })
      .first()
      .click();
    const screen = page.getByRole('dialog', { name: /^Voice call with / });
    const move = screen.getByRole('button', { name: 'Move here, ending the other call' });
    const reply = screen.getByRole('textbox', { name: /^Reply to / });
    await expect(reply.or(move).first()).toBeVisible({ timeout: 20_000 });
    if (await move.isVisible()) await move.click();
    await expect(reply).toBeVisible({ timeout: 20_000 });
    await reply.fill('What should I do next?');
    await reply.press('Enter');
    const step = screen.locator('[data-slot="call-step"]');
    await expect(step).toContainText(STEP, { timeout: 15_000 });
    await shot(page, 'call');
    // Escape in the step's form closes the form, not the call.
    await step.getByRole('button', { name: 'Changed plan' }).click();
    await step.getByRole('textbox').press('Escape');
    await expect(step.getByRole('textbox')).toHaveCount(0);
    await expect(screen).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'a call with its step');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(step.getByRole('button', { name: /^Next step/ })).toHaveAttribute('aria-expanded', 'false');
    // The call screen itself (the page behind it is still settling into the new width).
    expect(await screen.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await shot(page, 'call-phone');
    await page.setViewportSize({ width: 1440, height: 900 });
    await screen.getByRole('button', { name: 'End call' }).click();
    const review = page.getByRole('region', { name: 'Call ended' });
    await expect(review).toBeVisible({ timeout: 20_000 });
    await expect(review.locator('[data-slot="step-card"]')).toContainText(STEP);
    await shot(page, 'call-review');
    await review.getByRole('button', { name: 'Dismiss call review' }).click();
  });
});

test('an assigned EIR reads the path and can change nothing', async ({ page, browser }) => {
  const owner = await browser.newContext({ storageState: OWNER_STATE });
  const code = await issueAccessCodeViaApi(owner.request, 'Corin Halvorsen');
  const ventures = (await (await owner.request.get('/api/v1/program/ventures')).json()) as {
    items: { id: string; name: string }[];
  };
  await owner.close();
  const ventureId = ventures.items.find((venture) => venture.name === 'QuietQuad')?.id ?? '';
  await mockPath(page);
  await signIn(page, code);
  await page.goto(`/${TENANT}/app/v/${ventureId}/path`);
  await expect(page.getByRole('heading', { level: 1, name: 'QuietQuad’s path' })).toBeVisible();
  const main = page.getByRole('main');
  for (const name of ['Done', 'Not yet', 'Changed plan', 'Edit'])
    await expect(main.getByRole('button', { name, exact: true })).toHaveCount(0);
  await expect(main.getByRole('checkbox').first()).toBeDisabled();
  await expect(main.getByRole('button', { name: 'Print' })).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'the path, read-only');
});
