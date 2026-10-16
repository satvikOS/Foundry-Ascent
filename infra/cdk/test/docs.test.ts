import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

/*
 * The documents an owner reads to plan the bill and the stack state what config/production.json deploys:
 * the idle cost follows `aurora.minCapacityAcu`, and the API Lambda's size is `api.memoryMb`.
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

  it('give the $1–3 idle bill only as what `aurora.minCapacityAcu: 0` returns to, while Aurora is kept awake', () => {
    expect(config.aurora.minCapacityAcu).toBeGreaterThan(0);
    const stale = OWNER_DOCS.flatMap((path) =>
      paragraphs(read(path))
        .filter((p) => /\$1[–-]3\b/.test(p) && !p.includes('minCapacityAcu'))
        .map((p) => `${path}: ${p.slice(0, 160)}`),
    );
    expect(stale).toEqual([]);
    expect(
      paragraphs(read(COST_ADR)).some((p) => p.startsWith('> **Update') && p.includes('minCapacityAcu')),
    ).toBe(true);
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
