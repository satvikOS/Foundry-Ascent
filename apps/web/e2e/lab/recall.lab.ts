import { expect } from '@playwright/test';

import { FOUNDER_STATE, test } from '../support/fixtures';
import {
  acknowledgeNotices,
  appWithinBudget,
  converse,
  errorName,
  privateDir,
  callScreen,
  hangUp,
  readScenarios,
  replyOf,
  startCall,
  trackSpeech,
  waitForQuiet,
  writePrivate,
  type Captured,
} from './lab-support';

/*
 * Recall suite of the conversation lab (ops/lab/scenarios/recall.json, graded by ops/lab conversation_lab/
 * recall.py). The owner's scenario first: a call (typed), hang up, a second call minutes later, "do you remember
 * what we talked about last time?"; then chat→call and call→chat. Each scenario's conversations and replies are
 * written to the private folder; this spec asserts nothing about the replies (the grader does), only that the
 * scenario ran.
 */

interface RecallScenario {
  id: string;
  title: string;
  first: { channel: 'call' | 'chat'; lines: string[] };
  second: { channel: 'call' | 'chat'; lines: string[] };
  gapSeconds: number;
}

const { scenarios } = readScenarios('recall.json') as { scenarios: RecallScenario[] };
/** Overrides every scenario's pause between its two conversations (quick local runs); unset in the lab. */
const gapOverride = Number(process.env.LAB_RECALL_GAP_SECONDS ?? 'NaN');

test.describe('conversation lab: recall', () => {
  test.use({ storageState: FOUNDER_STATE });

  /*
   * RG-01: the founder types as soon as the call opens, while the greeting is still playing (LAB-R1: the line used
   * to wait until the greeting ended, 11-14 s). Records when the call opened, when the line was sent and when the
   * turn went out, and whether the greeting stopped for it.
   */
  test('RG-01', async ({ page, baseURL }) => {
    test.setTimeout(3 * 60_000);
    if (!baseURL || !(await appWithinBudget(baseURL, 0.05))) {
      writePrivate('recall/RG-01.json', { id: 'RG-01', error: 'budget' });
      test.skip(true, 'budget reached');
      return;
    }
    await trackSpeech(page);
    await acknowledgeNotices(page);
    const record: Record<string, unknown> = { id: 'RG-01', error: null };
    let callStartedAt: number | null = null;
    const turnPosts: number[] = [];
    page.on('response', (response) => {
      if (/\/sessions\/[0-9a-f-]{36}\/calls$/.test(response.url()) && response.status() === 201) {
        callStartedAt ??= Date.now();
      }
    });
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/sessions\/[0-9a-f-]{36}\/turns$/.test(request.url())) {
        turnPosts.push(Date.now());
      }
    });
    try {
      const call = await startCall(page);
      // Type while the greeting is being spoken: wait (at most 8 s) for its audio to start.
      await expect
        .poll(
          () =>
            page.evaluate(
              () => ((window as unknown as { __labSpeech?: { playing: number } }).__labSpeech?.playing ?? 0) > 0,
            ),
          { timeout: 8_000, intervals: [50, 100] },
        )
        .toBe(true)
        .catch(() => undefined);
      const reply = callScreen(page).getByRole('textbox', { name: /^Reply to / });
      await reply.fill('Quick one before you go on: should the pilot start in the east library?');
      // Whether the greeting was still being spoken when the founder sent the line.
      record.greetingPlaying = await page.evaluate(
        () => ((window as unknown as { __labSpeech?: { playing: number } }).__labSpeech?.playing ?? 0) > 0,
      );
      const typedAt = Date.now();
      await reply.press('Enter');
      await expect.poll(() => turnPosts.length, { timeout: 60_000, intervals: [50, 100] }).toBeGreaterThan(0);
      Object.assign(record, {
        callStartedAt,
        typedAt,
        turnPostedAt: turnPosts[0],
        sessionId: call.sessionId,
      });
      // The greeting gave way: half a second after the line, before any reply can play, nothing is playing.
      await page.waitForTimeout(500);
      record.greetingStopped = await page.evaluate(
        () => ((window as unknown as { __labSpeech?: { playing: number } }).__labSpeech?.playing ?? 0) === 0,
      );
      record.reply = await replyOf(page, call.sessionId, 1, true);
      await waitForQuiet(page);
      await hangUp(page);
    } catch (error) {
      record.error = errorName(error);
      await page
        .screenshot({ path: `${privateDir()}/recall/RG-01-failure.png`, fullPage: true })
        .catch(() => undefined);
      throw error;
    } finally {
      writePrivate('recall/RG-01.json', record);
    }
  });

  for (const scenario of scenarios) {
    test(scenario.id, async ({ page, baseURL }, testInfo) => {
      const gap = Number.isFinite(gapOverride) ? gapOverride : scenario.gapSeconds;
      test.setTimeout((gap + 600) * 1000);
      if (!baseURL || !(await appWithinBudget(baseURL, 0.15))) {
        writePrivate(`recall/${scenario.id}.json`, { id: scenario.id, error: 'budget' });
        test.skip(true, 'budget reached');
        return;
      }
      await trackSpeech(page);
      await acknowledgeNotices(page);
      const record: {
        id: string;
        gapSeconds: number;
        first?: Captured;
        second?: Captured;
        turnSeconds: number[];
        error: string | null;
      } = { id: scenario.id, gapSeconds: gap, turnSeconds: [], error: null };
      try {
        record.first = await converse(page, scenario.first.channel, scenario.first.lines);
        await page.goto('/');
        await page.waitForTimeout(gap * 1000);
        record.second = await converse(page, scenario.second.channel, scenario.second.lines);
        record.turnSeconds = [...record.first.turnSeconds, ...record.second.turnSeconds];
      } catch (error) {
        record.error = errorName(error);
        await page
          .screenshot({ path: `${privateDir()}/recall/${scenario.id}-failure.png`, fullPage: true })
          .catch(() => undefined);
        throw error;
      } finally {
        writePrivate(`recall/${scenario.id}.json`, record);
        testInfo.annotations.push({ type: 'lab', description: scenario.id });
      }
    });
  }
});
