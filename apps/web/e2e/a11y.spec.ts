import { expect, type Locator } from '@playwright/test';

import {
  expectNoSeriousA11yViolations,
  FOUNDER_STATE,
  openVenture,
  OWNER_STATE,
  runToken,
  startConversation,
  TENANT,
  useTheme,
  test,
} from './support/fixtures';

/**
 * How far a radio's visible pill stands out from what is behind it (WCAG contrast ratio): the cue that says which
 * option is on must reach 3:1 (1.4.11 Non-text Contrast). Colours are read as the browser paints them (a canvas
 * converts any CSS colour) and composited from the page down, so translucent surfaces count as they look.
 */
async function pillContrast(radio: Locator): Promise<number> {
  return radio.evaluate((input) => {
    const pill = input.closest('label');
    if (!pill) throw new Error('the radio has no pill');
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('no canvas');
    const rgba = (css: string): [number, number, number, number] => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = '#000';
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = (top: [number, number, number, number], under: [number, number, number]) =>
      [0, 1, 2].map((i) => (top[i] ?? 0) * top[3] + (under[i] ?? 0) * (1 - top[3])) as [
        number,
        number,
        number,
      ];
    const chain: Element[] = [];
    for (let node: Element | null = pill; node; node = node.parentElement) chain.unshift(node);
    let behind: [number, number, number] = [255, 255, 255];
    for (const node of chain.slice(0, -1))
      behind = over(rgba(getComputedStyle(node).backgroundColor), behind);
    const fill = over(rgba(getComputedStyle(pill).backgroundColor), behind);
    const luminance = (c: [number, number, number]) => {
      const [r, g, b] = c.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [hi, lo] = [luminance(fill), luminance(behind)].sort((a, b) => b - a) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  });
}

/**
 * axe-core (WCAG 2.0/2.1/2.2 A and AA rules) on the main surfaces, in both themes: zero serious or
 * critical violations. The journey spec covers behaviour; this spec covers what assistive technology and
 * low-vision users get.
 */
for (const scheme of ['dark', 'light'] as const) {
  test.describe(`accessibility · ${scheme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    });

    test('landing and sign-in', async ({ page }) => {
      await page.goto('/');
      await useTheme(page, scheme);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectNoSeriousA11yViolations(page, `landing (${scheme})`);

      await page.goto('/sign-in');
      await useTheme(page, scheme);
      await expect(page.getByRole('textbox', { name: 'Access code' })).toBeVisible();
      await expectNoSeriousA11yViolations(page, `sign-in (${scheme})`);
    });

    test.describe('founder', () => {
      test.use({ storageState: FOUNDER_STATE });

      test('new chat, a conversation and its panel, its summary, knowledge and the account menu', async ({
        page,
      }) => {
        test.setTimeout(90_000);
        const ventureId = await openVenture(page);
        await useTheme(page, scheme);
        await expectNoSeriousA11yViolations(page, `new chat (${scheme})`);

        // Remember or Private: the chosen option stands out by 3:1 or more, the other not at all.
        const memory = page.getByRole('group', { name: 'Memory for this conversation' });
        const remember = memory.getByRole('radio', { name: 'Remember this conversation' });
        const once = memory.getByRole('radio', { name: 'Private, a one-off' });
        await expect(remember).toBeChecked();
        // Polled: the pills ease between states.
        const settled = { timeout: 2_000 };
        await expect.poll(() => pillContrast(remember), settled).toBeGreaterThanOrEqual(3);
        await expect.poll(() => pillContrast(once), settled).toBeLessThan(1.1);
        await once.check();
        await expect.poll(() => pillContrast(once), settled).toBeGreaterThanOrEqual(3);
        await expect.poll(() => pillContrast(remember), settled).toBeLessThan(1.1);
        await remember.check();
        await expect(remember).toBeChecked();

        const token = runToken();
        // A question only the venture's own records answer, so the answer has sources to inspect.
        await startConversation(page, `What did our hand-counted seat map show about repeat use? ${token}`);
        const answer = page.getByRole('article', { name: 'Exchange 1' });
        await expect(answer.getByRole('button', { name: /^Sources & reasoning/ })).toBeVisible({
          timeout: 30_000,
        });
        await answer.getByRole('button', { name: /^Sources & reasoning/ }).click();
        await expect(answer.getByRole('list', { name: 'Claims and their sources' })).toBeVisible();
        await expectNoSeriousA11yViolations(page, `conversation (${scheme})`);

        await answer
          .getByRole('button', { name: /^Source 1: / })
          .first()
          .click();
        const panel = page.getByRole('complementary', { name: 'Context inspector' });
        await expect(panel.getByRole('tab', { name: 'Sources' })).toHaveAttribute('aria-selected', 'true');
        await expectNoSeriousA11yViolations(page, `sources panel (${scheme})`);
        await panel.getByRole('tab', { name: 'Notebook' }).click();
        await expectNoSeriousA11yViolations(page, `notebook panel (${scheme})`);
        await expect(panel.getByRole('tab', { name: /^To review/ })).toHaveCount(0);
        await page.getByRole('button', { name: 'Hide context panel' }).click();

        await page.getByRole('button', { name: 'Conversation options' }).click();
        await page.getByRole('menuitem', { name: 'End and summarise' }).click();
        await page
          .getByRole('alertdialog', { name: 'End this conversation?' })
          .getByRole('button', { name: 'End conversation' })
          .click();
        await expect(page.getByRole('region', { name: 'Summary' })).toBeVisible();
        await expectNoSeriousA11yViolations(page, `ended conversation (${scheme})`);

        await page.goto(`/${TENANT}/app/v/${ventureId}/knowledge`);
        await expect(page.getByRole('heading', { level: 1, name: 'Knowledge' })).toBeVisible();
        await expectNoSeriousA11yViolations(page, `knowledge (${scheme})`);

        // The account menu is reachable by keyboard and returns focus when closed.
        const account = page.getByRole('button', { name: /^Account menu for / });
        await account.focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('menuitem', { name: 'Data use & privacy' })).toBeVisible();
        await expect(page.getByText('Synthetic data only')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(account).toBeFocused();
      });
    });

    test.describe('platform admin', () => {
      test.use({ storageState: OWNER_STATE });

      test('people & access, reached from the old admin URL', async ({ page }) => {
        await page.goto('/admin/principals');
        await expect(page).toHaveURL(new RegExp(`/${TENANT}/app/admin/principals$`));
        await useTheme(page, scheme);
        await expect(page.getByRole('heading', { level: 1, name: 'People & access' })).toBeVisible();
        await expect(page.getByRole('table')).toBeVisible();
        await expectNoSeriousA11yViolations(page, `admin people & access (${scheme})`);
      });
    });
  });
}
