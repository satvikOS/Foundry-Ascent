import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

/*
 * The documents an owner reads to plan the bill and the stack state what config/production.json deploys:
 * Aurora pauses when idle (`aurora.minCapacityAcu: 0`, the owner's choice over about $44 a month to keep it
 * awake), and the API Lambda's size is `api.memoryMb`.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const OWNER_DOCS = [
  'README.md',
  'infra/cdk/README.md',
  'docs/architecture/system-design.md',
  'docs/runbooks/cost-controls.md',
  'docs/runbooks/owner-actions.md',
  'docs/runbooks/legacy-aws-cleanup.md',
] as const;
/** Also read for what they say about Aurora's pausing (the latency runbook records what was tried). */
const AURORA_DOCS = [...OWNER_DOCS, 'docs/runbooks/latency.md'] as const;
/** A claim that the database is kept awake (not "cannot keep Aurora awake"). */
const KEPT_AWAKE = /\bkept awake\b|\bkeeps (?:Aurora|the (?:cluster|database)) awake\b|\bstays awake\b/i;
/** A decision record keeps its original context, and says below it what changed since. */
const COST_ADR = 'docs/architecture/adr/0015-cost-guardrails.md';

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

/** Paragraphs (blank-line separated; a table row or a quoted line counts on its own). */
function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .flatMap((block) => (/^\s*[|>]/m.test(block) ? block.split('\n') : [block]))
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p !== '');
}

describe('owner-facing docs match the production config', () => {
  const config = loadConfig();

  it('give the $1–3 idle bill while Aurora pauses, and $44 only as what `minCapacityAcu: 0.5` would cost', () => {
    expect(config.aurora.minCapacityAcu).toBe(0);
    const docs = AURORA_DOCS.map((path) => ({ path, paragraphs: paragraphs(read(path)) }));
    const where = (path: string, p: string): string => `${path}: ${p.slice(0, 160)}`;
    // The idle bill is $1–3 plus usage, stated where an owner plans the bill.
    for (const path of ['README.md', 'docs/runbooks/cost-controls.md', 'docs/runbooks/owner-actions.md']) {
      expect(read(path), path).toMatch(/\$1[–-]3\b/);
    }
    // No doc says the database is kept awake.
    const awake = docs.flatMap(({ path, paragraphs: ps }) =>
      ps.filter((p) => KEPT_AWAKE.test(p) && !p.includes('minCapacityAcu')).map((p) => where(path, p)),
    );
    expect(awake).toEqual([]);
    expect(
      docs.flatMap(({ path, paragraphs: ps }) =>
        ps.filter((p) => /\$45[–-]47/.test(p)).map((p) => where(path, p)),
      ),
    ).toEqual([]);
    // "About $44 a month" appears only as the price of `minCapacityAcu: 0.5`.
    const fortyFour = docs.flatMap(({ path, paragraphs: ps }) =>
      ps
        .filter((p) => /(?:\$|USD )44\b/.test(p) && !/minCapacityAcu:? 0\.5|minCapacityAcu` to 0\.5/.test(p))
        .map((p) => where(path, p)),
    );
    expect(fortyFour).toEqual([]);
    // The decision record keeps its history and says, in a quoted update, that the owner reverted to pausing.
    const update = read(COST_ADR)
      .split(/\n\s*\n/)
      .find((block) => block.startsWith('> **Update (2026-10-17)'));
    expect(update?.replace(/\s*\n>\s*/g, ' ')).toContain('aurora.minCapacityAcu: 0');
    expect(read(COST_ADR)).toContain('> **Update (2026-10-16)');
  });

  it('state the API Lambda size that is deployed', () => {
    const mb = config.api.memoryMb;
    const stated = OWNER_DOCS.flatMap((path) =>
      [...read(path).matchAll(/(?:API Lambda|FoundryAscent-Api)[^\n]{0,80}?(\d[\d,]*) MB/g)].map((m) => ({
        path,
        mb: Number((m[1] ?? '').replace(/,/g, '')),
      })),
    );
    expect(stated.length).toBeGreaterThanOrEqual(2);
    expect(stated.filter((s) => s.mb !== mb)).toEqual([]);
    // The cost table's Lambda row names the API's size.
    const row = read('docs/runbooks/cost-controls.md')
      .split('\n')
      .find((line) => line.startsWith('| Lambda ('));
    expect(row).toContain(`API ${mb.toLocaleString('en-US')} MB`);
  });
});
