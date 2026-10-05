import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import AxeBuilder from '@axe-core/playwright';
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

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

/** Sign in through the real form and wait for the signed-in shell. */
export async function signIn(page: Page, accessCode: string): Promise<void> {
  await page.goto('/sign-in');
  const field = page.getByRole('textbox', { name: 'Access code' });
  await fillSecret(field, accessCode);
  // The form normalises input (drops the FA- prefix, groups by five): 23 characters for a full code.
  expect((await field.inputValue()).length, 'the access code was accepted by the field').toBe(23);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'));
  await expect(page.getByRole('button', { name: /^Account menu for / })).toBeVisible();
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

/** Open the seeded venture's overview from the ventures list; returns its id. */
export async function openVenture(page: Page): Promise<string> {
  await page.goto(`/${TENANT}/app/ventures`);
  await page
    .getByRole('main')
    .getByRole('link', { name: new RegExp(`^${VENTURE_NAME}\\b`) })
    .first()
    .click();
  await page.waitForURL(/\/ventures\/[0-9a-f-]{36}\/overview$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Since your last session' })).toBeVisible();
  const id = /\/ventures\/([0-9a-f-]{36})\//.exec(page.url())?.[1];
  if (!id) throw new Error('No venture id in the URL');
  return id;
}

/** Start a session from the overview's "Start a session" dialog and wait for the session page. */
export async function startSession(page: Page, goal: string): Promise<void> {
  await page.getByRole('button', { name: 'Start a session', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Start a session' });
  await expect(dialog.getByRole('radio', { name: /^Diagnose/ })).toBeChecked();
  await dialog.getByRole('textbox', { name: 'Goal (optional)' }).fill(goal);
  await dialog.getByRole('button', { name: 'Start session' }).click();
  await page.waitForURL(/\/coach\/[0-9a-f-]{36}/);
  await expect(page.getByRole('heading', { level: 1, name: goal })).toBeVisible();
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
