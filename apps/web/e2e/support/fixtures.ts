import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import AxeBuilder from '@axe-core/playwright';
import {
  test as base,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';

/*
 * Shared helpers for the end-to-end suite. Everything here runs against the seeded synthetic data
 * (packages/db seed): tenant `ain`, venture QuietQuad and its founder Maya Okafor-Lindqvist, who has no
 * access code until an admin issues one.
 */

export const TENANT = process.env.HOME_TENANT_SLUG ?? 'ain';
export const FOUNDER_NAME = 'Maya Okafor-Lindqvist';
export const VENTURE_NAME = 'QuietQuad';

const here = dirname(fileURLToPath(import.meta.url));
/**
 * Signed-in browser state (session cookies + UI prefs), written by auth.setup.ts. Kept under
 * node_modules/.cache: never committed, never formatted or linted, and not part of the CI report upload.
 */
export const AUTH_DIR = join(here, '..', '..', 'node_modules', '.cache', 'foundry-e2e-auth');
export const OWNER_STATE = join(AUTH_DIR, 'owner.json');
export const FOUNDER_STATE = join(AUTH_DIR, 'founder.json');

export function ensureAuthDir(): void {
  mkdirSync(AUTH_DIR, { recursive: true });
}

/** The owner code from `pnpm db:reset` (CI masks it). Never logged or attached to reports. */
export function ownerAccessCode(): string {
  const code = process.env.E2E_OWNER_ACCESS_CODE?.trim();
  if (!code) {
    throw new Error(
      'E2E_OWNER_ACCESS_CODE is not set. Run `pnpm db:reset` against a scratch database and export the ' +
        'owner access code it prints (the CI e2e job does this automatically).',
    );
  }
  return code;
}

const ACCESS_CODE = /^FA-[0-9A-HJKMNP-TV-Z]{5}(?:-[0-9A-HJKMNP-TV-Z]{5}){3}$/;

/** A short unique marker so reruns against the same database never match an earlier run's data. */
export function runToken(): string {
  return `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Type a secret into a form field without it appearing in reports: `locator.fill()` records the value in
 * the step title ("Fill \"FA-…\""), which ends up in the HTML report CI uploads. This sets the value with
 * the native setter and fires the same `input` event typing would, so React's onChange runs normally.
 */
export async function fillSecret(field: Locator, value: string): Promise<void> {
  await field.focus();
  await field.evaluate((element, secret) => {
    if (!(element instanceof HTMLInputElement)) throw new Error('Expected an <input>');
    // The prototype's setter (with the input as receiver) updates the value the way typing does, so
    // React's change tracking sees the edit.
    Reflect.set(HTMLInputElement.prototype, 'value', secret, element);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

/** Whether a secret is anywhere in the page text (checked in the page so it never reaches a report). */
export async function pageShowsText(page: Page, text: string): Promise<boolean> {
  return page.evaluate((needle) => document.body.innerText.includes(needle), text);
}

/** The one-time welcome that introduces a founder's or teammate's mentor ("Meet Thomas"). */
export function veirWelcome(page: Page): Locator {
  return page.getByRole('dialog', { name: /^Meet / });
}

/**
 * Sign in through the real form and wait for the signed-in shell. A founder or teammate who has not met their
 * coach yet lands under its one-time welcome (a vEIR's or the program's guide's): `welcome: 'keep'` waits for it
 * and leaves it open for a test about it; by default it is acknowledged through the API and the page reloaded, so
 * no welcome can open late over an unrelated test (the venture loading after a short wait would put it there).
 */
export async function signIn(
  page: Page,
  accessCode: string,
  options: { welcome?: 'continue' | 'keep' } = {},
): Promise<void> {
  await page.goto('/sign-in');
  const field = page.getByRole('textbox', { name: 'Access code' });
  await fillSecret(field, accessCode);
  // The form normalises input (drops the FA- prefix, groups by five): 23 characters for a full code.
  expect((await field.inputValue()).length, 'the access code was accepted by the field').toBe(23);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'));
  const me = (await (await page.request.get('/api/v1/me')).json()) as {
    memberships: { role: string }[];
    veirWelcomeAcknowledgedAt?: string | null;
  };
  const writer = me.memberships.some((m) => m.role === 'founder' || m.role === 'team');
  if (writer && me.veirWelcomeAcknowledgedAt === null) {
    // They land in their venture, where the welcome opens over New chat.
    await page.waitForURL(/\/app\/v\/[0-9a-f-]{36}/);
    if (options.welcome === 'keep') {
      await expect(veirWelcome(page)).toBeVisible({ timeout: 20_000 });
      return;
    }
    const acknowledged = await page.request.post('/api/v1/me/veir-welcome/acknowledge', {
      headers: { 'x-requested-with': 'foundry-ascent', 'idempotency-key': runToken() },
    });
    expect(acknowledged.status(), 'POST /me/veir-welcome/acknowledge').toBe(200);
    await page.reload();
  }
  await expect(page.getByRole('button', { name: /^Account menu for / })).toBeVisible();
  await expect(veirWelcome(page)).toHaveCount(0);
}

export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Account menu for / }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: /^Account menu for / })).toHaveCount(0);
}

/** Read a one-time access code from the reveal dialog, confirm it was stored and close the dialog. */
export async function takeRevealedCode(page: Page, recipient: string): Promise<string> {
  const reveal = page.getByRole('alertdialog', { name: `Access code for ${recipient}` });
  await expect(reveal).toBeVisible();
  const code =
    (await reveal.getByRole('status', { name: 'One-time access code' }).textContent())?.trim() ?? '';
  expect(ACCESS_CODE.test(code), 'the reveal dialog shows a well-formed access code').toBe(true);
  await expect(reveal.getByRole('button', { name: 'Done' })).toBeDisabled();
  await reveal.getByRole('checkbox', { name: /stored this code/ }).check();
  await reveal.getByRole('button', { name: 'Done' }).click();
  await expect(reveal).toBeHidden();
  return code;
}

interface PrincipalRow {
  principal: { id: string; displayName: string };
}

function isPrincipalList(value: unknown): value is { items: PrincipalRow[] } {
  return typeof value === 'object' && value !== null && Array.isArray((value as { items?: unknown }).items);
}

const WRITE_HEADERS = { 'x-requested-with': 'foundry-ascent', 'content-type': 'application/json' };

/**
 * Issue an access code for a seeded principal through the admin API (used by the setup project; the
 * journey does the same through the UI). `request` must carry an admin session.
 */
export async function issueAccessCodeViaApi(
  request: APIRequestContext,
  displayName: string,
): Promise<string> {
  const list = await request.get('/api/v1/admin/principals');
  expect(list.status(), 'GET /admin/principals').toBe(200);
  const body: unknown = await list.json();
  if (!isPrincipalList(body)) throw new Error('Unexpected /admin/principals response');
  const row = body.items.find((item) => item.principal.displayName === displayName);
  if (!row) throw new Error(`Seeded principal "${displayName}" not found`);
  const issued = await request.post(`/api/v1/admin/principals/${row.principal.id}/access-codes`, {
    headers: WRITE_HEADERS,
    data: { label: 'e2e setup', expiresInDays: 1 },
  });
  expect(issued.status(), 'POST /admin/principals/:id/access-codes').toBe(201);
  const issuedBody: unknown = await issued.json();
  const code =
    typeof issuedBody === 'object' && issuedBody !== null
      ? (issuedBody as { accessCode?: unknown }).accessCode
      : undefined;
  if (typeof code !== 'string' || !ACCESS_CODE.test(code)) throw new Error('No access code in the response');
  return code;
}

/**
 * Open the app as the founder: `/<tenant>/app` lands in their venture's New chat (the vEIR's greeting
 * and the composer). The greeting is the vEIR's opener ("Welcome back, Maya" over the line the conversation
 * opens with) when there is something to pick up, else the time of day. Returns the venture id.
 */
export async function openVenture(page: Page): Promise<string> {
  await page.goto(`/${TENANT}/app`);
  await page.waitForURL(/\/app\/v\/[0-9a-f-]{36}(?:\?.*)?$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByTestId('greeting-line')).toBeVisible();
  await expect(composer(page)).toBeVisible();
  const id = /\/app\/v\/([0-9a-f-]{36})/.exec(page.url())?.[1];
  if (!id) throw new Error('No venture id in the URL');
  return id;
}

/** The message box of New chat or a conversation ("Message <vEIR name>"). */
export function composer(page: Page): Locator {
  return page.getByRole('textbox', { name: /^Message / });
}

/**
 * From New chat: type the first message and send it. The conversation is created on send (no dialog)
 * and opens at its own URL, where that first message is answered. Returns the conversation id.
 */
export async function startConversation(page: Page, firstMessage: string): Promise<string> {
  const box = composer(page);
  await box.fill(firstMessage);
  await box.press('Enter');
  await page.waitForURL(/\/c\/[0-9a-f-]{36}/);
  const id = /\/c\/([0-9a-f-]{36})/.exec(page.url())?.[1];
  if (!id) throw new Error('No conversation id in the URL');
  return id;
}

/**
 * The mentor's disclosure (the presence policy, owner 2026-11-05): no "vEIR" badge beside its name and no
 * disclaimer line under the composer; what it is (an AI mentor, its AI face and voice, memory, people, limits) is one
 * click away in the context panel's About dialog. On a phone or tablet the panel is a sheet opened from its toggle
 * (on a phone, in a conversation, from the header's More menu).
 */
export async function expectVeirBadgeInView(page: Page): Promise<void> {
  await expect(page.getByRole('note', { name: 'AI disclosure' })).toHaveCount(0);
  await expect(page.locator('[data-slot="veir-badge"]')).toHaveCount(0);
  const show = page.getByRole('button', { name: 'Show context panel' }).filter({ visible: true }).first();
  const panel = page
    .locator('[data-slot="context-panel"], [data-slot="context-sheet"]')
    .filter({ visible: true })
    .first();
  // The panel is open beside the content, or its toggle shows (closed, or a sheet on a smaller screen); in a
  // conversation on a phone the toggle is in the header's More menu.
  const more = page.getByRole('button', { name: 'Conversation options' }).filter({ visible: true }).first();
  await expect(panel.or(show).or(more).first()).toBeVisible();
  if (await show.isVisible()) await show.click();
  else if (!(await panel.isVisible())) {
    await more.click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'Show context panel' }).click();
  }
  await expect(panel).toBeVisible();
  // In a conversation the panel has tabs: About is on its Overview.
  const overview = panel.getByRole('tab', { name: 'Overview' });
  if ((await overview.count()) > 0) await overview.click();
  const about = panel.locator('[data-slot="about-veir"]');
  await about.scrollIntoViewIfNeeded();
  await expect(about).toBeVisible();
  await about.click();
  const dialog = page.getByRole('dialog', { name: /^About / });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(/AI mentor/);
  await expect(dialog).toContainText('AI avatar');
  await expect(dialog).toContainText(/A person from the program/);
  // Escape closes it once focus has moved into it and it has finished opening (the dialog opens over the sheet on a
  // phone; an Escape inside its first ~50 ms, faster than a person, sometimes reached the sheet beneath instead).
  await expect(dialog.locator(':focus')).toHaveCount(1);
  await dialog.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  // A sheet (phones and tablets) closes again; a desktop panel stays open, as the person left it.
  const sheet = page.getByRole('dialog', { name: 'Context' });
  if ((await sheet.count()) > 0) {
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  }
}

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** Run axe (WCAG 2.2 AA) on the current page and fail on any serious or critical violation. */
export async function expectNoSeriousA11yViolations(page: Page, label: string): Promise<void> {
  // Let entrance transitions settle so colour contrast is measured on final colours.
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const blocking = results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      rule: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.slice(0, 5).map((node) => node.target.join(' ')),
    }));
  expect(blocking, `${label}: serious/critical WCAG 2.2 AA violations`).toEqual([]);
}

/**
 * The page must not scroll sideways (the classic mobile layout bug), and no text may be cut off at the
 * right edge by an `overflow: hidden` ancestor (which hides the scroll but still clips content). Text
 * inside a deliberately scrollable strip (e.g. the section tabs, `overflow-x: auto`) is fine.
 */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const viewport = doc.clientWidth;
    const inScroller = (element: Element): boolean => {
      for (let node = element.parentElement; node; node = node.parentElement) {
        const { overflowX } = getComputedStyle(node);
        if (overflowX === 'auto' || overflowX === 'scroll') return true;
      }
      return false;
    };
    const clipped: string[] = [];
    for (const element of document.querySelectorAll('body *')) {
      if (element.children.length > 0 || !element.textContent.trim()) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || rect.right <= viewport + 1) continue;
      if (inScroller(element)) continue;
      clipped.push(`${element.tagName.toLowerCase()} "${element.textContent.trim().slice(0, 40)}"`);
    }
    return {
      scrollWidth: Math.max(doc.scrollWidth, document.body.scrollWidth),
      clientWidth: viewport,
      clipped: clipped.slice(0, 5),
    };
  });
  expect(overflow.scrollWidth, 'document width vs viewport width').toBeLessThanOrEqual(overflow.clientWidth);
  expect(overflow.clipped, 'text running past the right edge of the viewport').toEqual([]);
}

/** The control is visible and lies horizontally inside the viewport (reachable without sideways scroll). */
export async function expectReachable(page: Page, control: ReturnType<Page['getByRole']>): Promise<void> {
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeVisible();
  const box = await control.boundingBox();
  const viewport = page.viewportSize();
  expect(box, 'control has a layout box').not.toBeNull();
  if (box && viewport) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 0.5);
    expect(box.height, 'touch target height').toBeGreaterThanOrEqual(24);
  }
}

/** Apply a colour scheme and wait until the app's resolved theme follows it. */
export async function useTheme(page: Page, scheme: 'dark' | 'light'): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
}

/**
 * Replaces the browser's speech synthesis with a silent one that keeps its contract (`onstart`, then `onend`
 * after a short reading time) and counts what it was asked to say (`window.__speechRequests`). Production
 * builds never pass the browser's synthesis to a call (calls show captions instead), but a test browser
 * must never read anything aloud: headless Chromium's speech goes to the operating system's speech service,
 * which `--disable-audio-output` (playwright.config.ts) does not reach.
 */
export async function silenceBrowserVoice(target: Page | BrowserContext): Promise<void> {
  await target.addInitScript(() => {
    const pending = new Set<number>();
    const counted = window as unknown as { __speechRequests: number };
    counted.__speechRequests = 0;
    const silent = {
      speaking: false,
      pending: false,
      paused: false,
      onvoiceschanged: null,
      getVoices: () => [],
      speak(utterance: SpeechSynthesisUtterance) {
        counted.__speechRequests += 1;
        const words = utterance.text.split(/\s+/).filter(Boolean).length;
        utterance.onstart?.call(utterance, new Event('start') as SpeechSynthesisEvent);
        const timer = window.setTimeout(
          () => {
            pending.delete(timer);
            utterance.onend?.call(utterance, new Event('end') as SpeechSynthesisEvent);
          },
          Math.min(3000, 200 + 60 * words),
        );
        pending.add(timer);
      },
      cancel() {
        for (const timer of pending) window.clearTimeout(timer);
        pending.clear();
      },
      pause: () => undefined,
      resume: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    };
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: silent });
  });
}

/** How many times this page asked the browser to speak (0 in production builds: calls show captions). */
export function browserSpeechRequests(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __speechRequests?: number }).__speechRequests ?? 0);
}

/**
 * The person of this browser context has read the call's disclosure for both kinds (call-disclosure.tsx: shown
 * before their first voice and first video call, remembered per person in the browser). Signed in already (a
 * stored session); a context without one is left as it is.
 */
export async function markCallDisclosuresSeen(context: BrowserContext): Promise<void> {
  const response = await context.request.get('/api/v1/me').catch(() => null);
  if (!response?.ok()) return;
  const id = ((await response.json()) as { principal?: { id?: string } }).principal?.id;
  if (!id) return;
  await context.addInitScript((principalId: string) => {
    for (const kind of ['voice', 'video']) {
      const key = `fa.call.disclosure.v1.${kind}.${principalId}`;
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, 'e2e');
    }
  }, id);
}

/**
 * The suite's `test`: every browser context it creates, the default one and any a test opens itself
 * (`browser.newContext()`, a second tab), has the silent speech synthesis above, so no spec can make the
 * runner's speakers talk. In the default context the signed-in person has read the call's disclosure already
 * (`callDisclosuresSeen`, on unless a test is about the disclosure); contexts a test opens itself start without.
 */
export const test = base.extend<{ callDisclosuresSeen: boolean }>({
  callDisclosuresSeen: [true, { option: true }],
  context: async ({ context, callDisclosuresSeen }, use) => {
    await silenceBrowserVoice(context);
    if (callDisclosuresSeen) await markCallDisclosuresSeen(context);
    await use(context);
  },
  browser: [
    async ({ browser }, use) => {
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (options) => {
        const context = await newContext(options);
        await silenceBrowserVoice(context);
        return context;
      };
      await use(browser);
    },
    { scope: 'worker' },
  ],
});

/** Turns voice calls on or off for the platform as the owner (`PATCH /admin/settings`, audited). */
export async function setCallsEnabled(baseURL: string, enabled: boolean): Promise<void> {
  const owner = await playwrightRequest.newContext({ baseURL, storageState: OWNER_STATE });
  try {
    const response = await owner.patch('/api/v1/admin/settings', {
      headers: WRITE_HEADERS,
      data: { callsEnabled: enabled },
    });
    expect(response.status(), 'PATCH /admin/settings').toBe(200);
  } finally {
    await owner.dispose();
  }
}

/**
 * Turns the vEIR's video faces on or off for the platform as the owner (`PATCH /admin/settings`). The e2e API
 * runs the development stand-in face (EMBODIMENT_PROVIDER=fake), which draws no one; faces ship off.
 */
export async function setFacesEnabled(baseURL: string, enabled: boolean): Promise<void> {
  const owner = await playwrightRequest.newContext({ baseURL, storageState: OWNER_STATE });
  try {
    const response = await owner.patch('/api/v1/admin/settings', {
      headers: WRITE_HEADERS,
      data: { facesEnabled: enabled },
    });
    expect(response.status(), 'PATCH /admin/settings').toBe(200);
  } finally {
    await owner.dispose();
  }
}

/**
 * Turns a seeded person's video face on or off as the owner (`PATCH /admin/principals/:id`, audited): where the
 * face vendor shows the face to platform admins only, that person sees it too.
 */
export async function setFaceAccess(baseURL: string, displayName: string, enabled: boolean): Promise<void> {
  const owner = await playwrightRequest.newContext({ baseURL, storageState: OWNER_STATE });
  try {
    const list = await owner.get('/api/v1/admin/principals');
    expect(list.status(), 'GET /admin/principals').toBe(200);
    const body: unknown = await list.json();
    if (!isPrincipalList(body)) throw new Error('Unexpected /admin/principals response');
    const row = body.items.find((item) => item.principal.displayName === displayName);
    if (!row) throw new Error(`Seeded principal "${displayName}" not found`);
    const response = await owner.patch(`/api/v1/admin/principals/${row.principal.id}`, {
      headers: WRITE_HEADERS,
      data: { faceAccess: enabled },
    });
    expect(response.status(), 'PATCH /admin/principals/:id').toBe(200);
  } finally {
    await owner.dispose();
  }
}

/**
 * The seeded EIR whose persona coaches QuietQuad (the founder's venture): a person, shown by their full name
 * ("Corin Halvorsen") or, beside the mentor's own name, introduced by their role.
 */
export const SEEDED_EIR_FIRST_NAME = 'Corin';

/**
 * The mentor that coaches QuietQuad, as production has it (ADR-0021): the e2e database applies the owner release
 * production names (`SEED_OWNER_RELEASES`, from infra/cdk/config/production.json), which renames the persona built
 * with Corin's consent to "Thomas" and presents it as a mentor.
 */
export const SEEDED_MENTOR_NAME = 'Thomas';

/** The twin that coaches EmberLoop (Ruth's vEIR, ADR-0020): it keeps its AI marker in its name. */
export const SEEDED_TWIN_EIR_FIRST_NAME = 'Ruth';

/** Text and accessible labels on the page that match `pattern` (visible text only), less the AI disclosure notes. */
async function labelsMatching(page: Page, pattern: { source: string; flags: string }, skip: string) {
  return page.evaluate(
    ({ source, flags, skip }) => {
      const matches = new RegExp(source, flags);
      const hits: string[] = [];
      const skipped = (element: Element) => element.closest(skip) !== null;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        const text = node.textContent ?? '';
        if (!parent || !matches.test(text) || skipped(parent)) continue;
        // Only what is rendered: hidden and print-only text is not shown.
        if (!parent.checkVisibility()) continue;
        hits.push(text.trim().slice(0, 120));
      }
      for (const element of document.querySelectorAll('[aria-label], [title], [placeholder]')) {
        if (skipped(element)) continue;
        for (const attribute of ['aria-label', 'title', 'placeholder']) {
          const value = element.getAttribute(attribute);
          if (value && matches.test(value)) hits.push(`${attribute}="${value.slice(0, 120)}"`);
        }
      }
      return hits;
    },
    { ...pattern, skip },
  );
}

const DISCLOSURE_NOTE = '[role="note"][aria-label="AI disclosure"]';

/**
 * Naming invariant for a mentor (ADR-0021, owner 2026-11-05): the mentor is shown by its display name alone
 * ("Thomas"), never "<name>'s vEIR", "<name> · vEIR" or a "vEIR" badge beside the name; and the AI is never called
 * by the EIR's bare first name ("Corin" alone only ever means the person, and appears only where About and the
 * welcome introduce them by role). Checks the page's visible text and its accessible labels (aria-label, title,
 * placeholder), leaving out the AI disclosure notes.
 */
export async function expectPlainMentorName(
  page: Page,
  where: string,
  /** Content that carries the words on purpose (e.g. a library source's own title about the EIR). */
  allow: readonly RegExp[] = [],
): Promise<void> {
  const labelled = await labelsMatching(
    page,
    { source: String.raw`(?:['’]s\s+vEIR\b|·\s*vEIR\b|^\s*vEIR\s*$)`, flags: '' },
    DISCLOSURE_NOTE,
  );
  const bare = await labelsMatching(
    page,
    {
      source: String.raw`\b${SEEDED_EIR_FIRST_NAME}\b(?! Halvorsen)(?!, your entrepreneur-in-residence)`,
      flags: '',
    },
    DISCLOSURE_NOTE,
  );
  const found = [...labelled, ...bare].filter((hit) => !allow.some((pattern) => pattern.test(hit)));
  expect(found, `the mentor is named plainly, never with a vEIR label or as the EIR, on ${where}`).toEqual(
    [],
  );
}

/**
 * Naming invariant for a twin (the presence policy, ADR-0020): the AI is "Ruth · vEIR" or "Ruth's vEIR"; a bare
 * "Ruth" anywhere else only ever means the person ("Ruth Abernathy-Song"). Leaves out the AI disclosure notes and
 * the welcome and About text, whose sentences name the EIR on purpose ("built with Ruth's consent").
 */
export async function expectTwinNamed(
  page: Page,
  where: string,
  firstName = SEEDED_TWIN_EIR_FIRST_NAME,
): Promise<void> {
  const found = await labelsMatching(
    page,
    { source: String.raw`\b${firstName}\b(?!['’]s vEIR)(?! · vEIR)(?! Abernathy)(?!’s consent)`, flags: '' },
    `${DISCLOSURE_NOTE}, [data-slot="veir-welcome"], [data-slot="veir-about"]`,
  );
  expect(found, `the twin is never called by the EIR's bare name on ${where}`).toEqual([]);
}
