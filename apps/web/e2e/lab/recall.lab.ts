import { FOUNDER_STATE, test } from '../support/fixtures';
import {
  acknowledgeNotices,
  appWithinBudget,
  converse,
  errorName,
  privateDir,
  readScenarios,
  trackSpeech,
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
