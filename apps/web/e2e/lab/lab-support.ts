import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, request as playwrightRequest, type Locator, type Page } from '@playwright/test';

import { OWNER_STATE, composer, openVenture, startConversation } from '../support/fixtures';

/*
 * Helpers of the conversation lab's browser suites. They drive the real UI as the founder (typed calls and
 * chats), read what the vEIR said back through the API (the stored, validated reply), and write every captured
 * text to the private folder only (LAB_OUT_PRIVATE), which the lab seals. Nothing here logs content.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = join(here, '..', '..', '..', '..');
export const WRITE_HEADERS = { 'x-requested-with': 'foundry-ascent', 'content-type': 'application/json' };

/** Where captured content goes (sealed by the lab); locally a gitignored cache folder. */
export function privateDir(): string {
  return process.env.LAB_OUT_PRIVATE ?? join(here, '..', '..', 'node_modules', '.cache', 'foundry-lab');
}

export function writePrivate(relativePath: string, value: unknown): void {
  const file = join(privateDir(), relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 });
}

/** A scenario file of ops/lab/scenarios (parsed JSON; the caller states its shape). */
export function readScenarios(name: string): unknown {
  return JSON.parse(readFileSync(join(REPO, 'ops', 'lab', 'scenarios', name), 'utf8')) as unknown;
}

/** Error names only: a message can quote page text. */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'error';
}

/**
 * Whether the app may still spend: what it metered since the lab started (Admin → Usage, the app's own ledger) is
 * below its share of the budget minus `reserve`. Without a lab budget (local runs), always.
 */
export async function appWithinBudget(baseURL: string, reserve: number): Promise<boolean> {
  const budget = Number(process.env.LAB_APP_BUDGET_USD ?? 'NaN');
  if (!Number.isFinite(budget)) return true;
  const baseline = Number(process.env.LAB_APP_BASELINE_USD ?? '0');
  const owner = await playwrightRequest.newContext({ baseURL, storageState: OWNER_STATE });
  try {
    const response = await owner.get('/api/v1/admin/usage');
    if (response.status() !== 200) return false;
    const { todayUsd } = (await response.json()) as { todayUsd: number };
    return todayUsd - baseline + reserve < budget;
  } finally {
    await owner.dispose();
  }
}

/** First-visit notices (the first-call voice notice; a vEIR welcome) acknowledged for the signed-in person. */
export async function acknowledgeNotices(page: Page): Promise<void> {
  const notice = await page.request.post('/api/v1/calls/notice/acknowledge', { headers: WRITE_HEADERS });
  expect([200, 404], 'POST /calls/notice/acknowledge').toContain(notice.status());
}

/** A welcome dialog or sheet, if one shows, is acknowledged the way a person would. */
export async function dismissWelcome(page: Page): Promise<void> {
  const dialog = page
    .getByRole('dialog')
    .filter({ hasText: /vEIR/ })
    .filter({ hasNotText: /^Call with / });
  if ((await dialog.count()) === 0) return;
  const button = dialog
    .getByRole('button', { name: /^(Got it|Continue|OK|I understand|Start|Let's go)/i })
    .first();
  if ((await button.count()) > 0) await button.click();
}

interface TurnRow {
  ordinal: number;
  status: string;
  founderText?: string;
  response: { answer: string; spoken?: string | null } | null;
}

export interface SessionTurns {
  session: { id: string; opener?: string | null };
  turns: TurnRow[];
}

export async function sessionTurns(page: Page, sessionId: string): Promise<SessionTurns> {
  const response = await page.request.get(`/api/v1/sessions/${sessionId}`);
  expect(response.status(), 'GET /sessions/:id').toBe(200);
  return (await response.json()) as SessionTurns;
}

/**
 * Waits for exchange `n` (1-based) to settle and returns what the founder read (chat: the answer) or heard (call:
 * the spoken reply, else the answer). A blocked or failed turn returns ''.
 */
export async function replyOf(page: Page, sessionId: string, n: number, call: boolean): Promise<string> {
  let row: TurnRow | undefined;
  await expect
    .poll(
      async () => {
        row = (await sessionTurns(page, sessionId)).turns.find((t) => t.ordinal === n);
        return row?.status ?? 'missing';
      },
      { timeout: 120_000, intervals: [250] },
    )
    .toMatch(/^(completed|blocked|failed)$/);
  const response = row?.response;
  if (!response) return '';
  return call ? (response.spoken ?? response.answer) : response.answer;
}

/** Seconds from sending a line to its reply being stored (polled every 250 ms, so within a quarter second). */
export function turnTimer(): { started: () => void; seconds: () => number } {
  let sentAt = 0;
  return {
    started: () => {
      sentAt = Date.now();
    },
    seconds: () => (Date.now() - sentAt) / 1000,
  };
}

export function callScreen(page: Page): Locator {
  return page.getByRole('dialog', { name: /^Call with / });
}

/** From New chat: the sidebar's Call, Remember (preselected), Start call. Returns the conversation and intro. */
export async function startCall(
  page: Page,
): Promise<{ sessionId: string; intro: string | null; inputMode: string }> {
  await openVenture(page);
  await dismissWelcome(page);
  const started = page.waitForResponse(
    (response) => /\/sessions\/[0-9a-f-]{36}\/calls$/.test(response.url()) && response.status() === 201,
    { timeout: 60_000 },
  );
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: /^Call / })
    .click();
  const screen = callScreen(page);
  const remember = screen.getByRole('radio', { name: /^Remember/ });
  if ((await remember.count()) > 0) await expect(remember).toBeChecked();
  await screen.getByRole('button', { name: 'Start call' }).click();
  await page.waitForURL(/\/c\/[0-9a-f-]{36}\?call=1$/);
  const sessionId = /\/c\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
  const body = (await (await started).json()) as {
    call: { inputMode: string };
    intro: { text: string } | null;
  };
  return { sessionId, intro: body.intro?.text ?? null, inputMode: body.call.inputMode };
}

/** Types a line on a typed call. */
export async function typeOnCall(page: Page, text: string): Promise<void> {
  const reply = callScreen(page).getByRole('textbox', { name: /^Reply to / });
  await reply.fill(text);
  await reply.press('Enter');
}

export async function hangUp(page: Page): Promise<void> {
  const screen = callScreen(page);
  await screen.getByRole('button', { name: 'End call' }).click();
  await expect(screen.getByRole('heading', { name: 'Call ended' })).toBeVisible();
  await screen.getByRole('button', { name: 'Back to conversation' }).click();
  await expect(screen).toBeHidden();
}

export interface Captured {
  sessionId: string;
  channel: 'call' | 'chat';
  /** The call's spoken greeting, or the chat's opening line, when there was one. */
  opening: string | null;
  lines: string[];
  replies: string[];
  turnSeconds: number[];
}

/** One conversation through the UI: a typed call (hung up at the end) or a chat. */
export async function converse(
  page: Page,
  channel: 'call' | 'chat',
  lines: readonly string[],
): Promise<Captured> {
  const out: Captured = {
    sessionId: '',
    channel,
    opening: null,
    lines: [...lines],
    replies: [],
    turnSeconds: [],
  };
  if (channel === 'call') {
    const call = await startCall(page);
    out.sessionId = call.sessionId;
    out.opening = call.intro;
    try {
      for (const [index, line] of lines.entries()) {
        const timer = turnTimer();
        timer.started();
        await typeOnCall(page, line);
        out.replies.push(await replyOf(page, out.sessionId, index + 1, true));
        out.turnSeconds.push(timer.seconds());
      }
    } finally {
      await hangUp(page);
    }
    return out;
  }
  await openVenture(page);
  await dismissWelcome(page);
  for (const [index, line] of lines.entries()) {
    const timer = turnTimer();
    timer.started();
    if (index === 0) {
      out.sessionId = await startConversation(page, line);
      out.opening = (await sessionTurns(page, out.sessionId)).session.opener ?? null;
    } else {
      await composer(page).fill(line);
      await composer(page).press('Enter');
    }
    out.replies.push(await replyOf(page, out.sessionId, index + 1, false));
    out.turnSeconds.push(timer.seconds());
  }
  return out;
}
