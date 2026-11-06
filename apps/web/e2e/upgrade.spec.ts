import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import {
  FOUNDER_STATE,
  openVenture,
  startConversation,
  TENANT,
  test,
  useTheme,
  runToken,
} from './support/fixtures';

const headers = { 'x-requested-with': 'foundry-ascent' };
const root = resolve(process.env.UPGRADE_VISUALS_DIR ?? '../../docs/upgrade/evidence/after');
mkdirSync(root, { recursive: true });

for (const [device, width, height] of [
  ['desktop', 1440, 900],
  ['tablet', 768, 1024],
  ['mobile', 390, 844],
] as const) {
  for (const theme of ['dark', 'light'] as const) {
    test.describe(`${device}, ${theme}: upgraded student journey`, () => {
      test.use({ storageState: FOUNDER_STATE, viewport: { width, height } });
      test('context, student profile, reflection, automatic memory, and free avatar share one venture', async ({
        page,
      }) => {
        test.setTimeout(120_000);
        const ventureId = await openVenture(page);
        await useTheme(page, theme);
        // The venture's context is the right panel: beside New chat on a wide screen, a sheet from its toggle
        // otherwise. Nothing in it waits for approval: memory is kept automatically.
        const show = page.getByRole('button', { name: 'Show context panel' }).filter({ visible: true });
        if ((await show.count()) > 0) await show.first().click();
        const context = page.locator('[data-slot="venture-context"]').filter({ visible: true });
        const focus = context.getByRole('link', { name: /^(?:Edit|Set one)$/ });
        await expect(focus).toBeVisible();
        await expect(context).not.toContainText(/approve|awaiting/i);
        await page.screenshot({ path: `${root}/context-${device}-${theme}.png`, fullPage: true });
        await focus.click();
        await expect(page.getByRole('heading', { level: 1, name: 'Venture' })).toBeVisible();
        // The student's own development lives under Knowledge → You, apart from the venture's profile.
        await page.goto(`/${TENANT}/app/v/${ventureId}/knowledge?view=you`);
        await expect(page.getByRole('heading', { level: 2, name: 'Coaching profile' })).toBeVisible();
        await page
          .getByLabel('Relevant experience', { exact: true })
          .fill('Synthetic researcher; first commercialization project');
        await page
          .getByLabel('What you want to learn', { exact: true })
          .fill(`Evidence before scaling ${runToken()}`);
        await page
          .getByLabel('Time, budget, or access constraints', { exact: true })
          .fill('Two hours on Friday, no paid advertising');
        await page
          .getByLabel('Concepts you already understand', { exact: true })
          .fill('Discovery interviews, contribution margin');
        await page.getByRole('button', { name: 'Approve profile', exact: true }).click();
        await expect(
          page.getByRole('status').filter({ hasText: 'Coaching profile approved.' }),
        ).toBeVisible();
        const approved = (await (
          await page.request.get(`/api/v1/ventures/${ventureId}/student-profile`)
        ).json()) as { profile: { masteredConcepts: string[] } };
        expect(approved.profile.masteredConcepts).toEqual(['Discovery interviews', 'contribution margin']);
        await expect(page.getByRole('heading', { level: 2, name: 'Learning log' })).toBeVisible();
        const decision = `Pilot before building ${runToken()}`;
        await page.getByLabel('Decision you faced', { exact: true }).fill(decision);
        await page
          .getByLabel('Evidence you used', { exact: true })
          .fill('One repeat use and no paid commitment');
        await page
          .getByLabel('What changed your thinking', { exact: true })
          .fill('Interest alone does not establish willingness to pay');
        await page.getByRole('button', { name: 'Record reflection', exact: true }).click();
        await expect(
          page.getByRole('list', { name: 'Your learning reflections' }).getByText(decision, { exact: true }),
        ).toBeVisible();
        const download = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Export learning', exact: true }).click();
        const exported = await download;
        expect(exported.suggestedFilename()).toBe('foundry-learning.json');
        const downloaded = await exported.path();
        if (!downloaded) throw new Error('Learning export did not complete');
        const content = JSON.parse(readFileSync(downloaded, 'utf8')) as {
          profile: { masteredConcepts: string[] };
          learningLog: { decision: string }[];
        };
        expect(content.profile.masteredConcepts).toEqual(['Discovery interviews', 'contribution margin']);
        expect(content.learningLog.some((r) => r.decision === decision)).toBe(true);
        await page.screenshot({ path: `${root}/learning-${device}-${theme}.png`, fullPage: true });
        expect(
          (
            await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()
          ).violations.map((v) => v.id),
        ).toEqual([]);
        await page.goto(`/${TENANT}/app/v/${ventureId}`);
        const sessionId = await startConversation(
          page,
          `We've decided to run a paid pilot called ${runToken()} before building further.`,
        );
        await expect(
          page.getByRole('article', { name: 'Exchange 1' }).getByRole('button', { name: 'Copy answer' }),
        ).toBeVisible({ timeout: 30_000 });
        // Memory is automatic: what the turn taught is kept at once, with no approval step.
        const memory = (await (
          await page.request.get(`/api/v1/ventures/${ventureId}/memory?status=confirmed&limit=100`)
        ).json()) as {
          items: { id: string; origin: string; keptAutomatically?: boolean; sourceRefs: { id: string }[] }[];
        };
        const kept = memory.items.find(
          (m) => m.origin === 'ai' && m.sourceRefs.some((ref) => ref.id === sessionId),
        );
        expect(kept, 'The actual turn kept a memory by itself').toBeTruthy();
        if (!kept) throw new Error('No kept memory');
        expect(kept.keptAutomatically).toBe(true);
        const pending = (await (
          await page.request.get(`/api/v1/ventures/${ventureId}/memory?status=proposed&limit=100`)
        ).json()) as { items: { origin: string; sourceRefs: { id: string }[] }[] };
        expect(
          pending.items.filter((m) => m.origin === 'ai' && m.sourceRefs.some((ref) => ref.id === sessionId)),
        ).toEqual([]);
        await page.goto(`/${TENANT}/app/v/${ventureId}/knowledge?m=${kept.id}`);
        // The student can correct or forget it; nothing asks them to approve it.
        await expect(page.getByRole('button', { name: 'Forget', exact: true }).first()).toBeVisible();
        await expect(page.getByRole('button', { name: /Approve|Reject/ })).toHaveCount(0);
        await page.screenshot({ path: `${root}/memory-kept-${device}-${theme}.png`, fullPage: true });
        expect(
          (
            await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()
          ).violations.map((v) => v.id),
        ).toEqual([]);
        await page.request.post('/api/v1/calls/notice/acknowledge', { headers });
        await page.goto(`/${TENANT}/app/v/${ventureId}/c/${sessionId}?call=voice`);
        const call = page.getByRole('dialog', { name: /^(Voice|Video) call with / });
        await expect(call.getByRole('textbox', { name: /^Reply to / })).toBeVisible();
        // The sphere is the default presence; the character is chosen in the call settings, labelled AI avatar.
        await expect(call.locator('[data-face="presence"] .fa-sphere')).toBeVisible();
        await call.getByRole('button', { name: 'Call settings', exact: true }).click();
        const settings = page.getByRole('dialog', { name: 'Call settings' });
        await expect(settings.getByRole('button', { name: 'Sphere', exact: true })).toHaveAttribute(
          'aria-pressed',
          'true',
        );
        await settings.getByRole('button', { name: 'AI avatar', exact: true }).click();
        await expect(call.locator('[data-face="character"] svg')).toBeVisible();
        await expect(call.locator('[data-slot="ai-avatar-label"]')).toHaveText('AI avatar');
        await expect(settings.getByRole('button', { name: 'AI avatar', exact: true })).toHaveAttribute(
          'aria-pressed',
          'true',
        );
        await page.screenshot({ path: `${root}/avatar-${device}-${theme}.png`, fullPage: false });
        // Trusted pointer input → React's pressed state → next paint, measured entirely in the browser.
        await page.evaluate(() => {
          const timing = { samples: [] as number[] };
          (window as unknown as { __foundryFeedback: typeof timing }).__foundryFeedback = timing;
          document.addEventListener(
            'pointerdown',
            (event) => {
              const button = (event.target as Element).closest('button[aria-pressed]');
              if (!button || button.getAttribute('aria-pressed') === 'true') return;
              const start = performance.now();
              const observer = new MutationObserver(() => {
                if (button.getAttribute('aria-pressed') !== 'true') return;
                observer.disconnect();
                requestAnimationFrame(() => timing.samples.push(performance.now() - start));
              });
              observer.observe(button, { attributes: true, attributeFilter: ['aria-pressed'] });
            },
            { capture: true },
          );
        });
        for (let i = 0; i < 10; i++) {
          await settings.getByRole('button', { name: 'Sphere', exact: true }).click();
          await expect(call.locator('[data-face="presence"]')).toBeVisible();
          await settings.getByRole('button', { name: 'AI avatar', exact: true }).click();
          await expect(call.locator('[data-face="character"]')).toBeVisible();
        }
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (window as unknown as { __foundryFeedback: { samples: number[] } }).__foundryFeedback.samples
                  .length,
            ),
          )
          .toBe(20);
        const samples = await page.evaluate(
          () => (window as unknown as { __foundryFeedback: { samples: number[] } }).__foundryFeedback.samples,
        );
        writeFileSync(
          `${root}/feedback-${device}-${theme}.json`,
          JSON.stringify(
            {
              samples,
              measurement:
                'trusted pointerdown to aria-pressed update and next animation frame; local lab, not field INP',
            },
            null,
            2,
          ),
        );
        await settings.getByRole('button', { name: 'Sphere', exact: true }).focus();
        await page.keyboard.press('Enter');
        await expect(settings.getByRole('button', { name: 'Sphere', exact: true })).toHaveAttribute(
          'aria-pressed',
          'true',
        );
        await settings.getByRole('button', { name: 'AI avatar', exact: true }).click();
        await page.keyboard.press('Escape');
        await expect(settings).toHaveCount(0);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await expect(call.locator('.fa-character')).toHaveAttribute('data-motion', 'reduced');
        expect(
          await call
            .locator('.fa-character__head')
            .evaluate((element) => getComputedStyle(element).animationName),
        ).toBe('none');
        const violations = (
          await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()
        ).violations;
        expect(violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) }))).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await call.getByRole('button', { name: 'End call', exact: true }).click();
        // After End's short Undo window the screen closes onto the conversation and its call review.
        const review = page.getByRole('region', { name: 'Call ended' });
        await expect(review).toBeVisible({ timeout: 20_000 });
        await expect(page.getByRole('dialog', { name: /^(Voice|Video) call with / })).toHaveCount(0);
        await review.getByRole('button', { name: 'Dismiss call review' }).click();
        await expect(review).toHaveCount(0);
      });
    });
  }
}
