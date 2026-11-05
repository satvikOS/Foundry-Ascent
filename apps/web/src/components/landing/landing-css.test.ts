import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, 'landing.css'), 'utf8');

describe('landing.css', () => {
  it('uses one small grain tile, hidden when transparency is reduced and in forced colours', () => {
    expect([...css.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1])).toEqual(['/textures/grain-256.png']);
    expect(statSync(join(here, '..', '..', '..', 'public', 'textures', 'grain-256.png')).size).toBeLessThan(
      12_000,
    );
    expect(css).toMatch(/prefers-reduced-transparency: reduce\)\s*\{\s*\.grain::after\s*\{\s*display: none/);
    expect(css).toMatch(/forced-colors: active\)\s*\{[^}]*\.grain::after/);
  });

  it('reveals only without a reduced-motion preference, and never animates the art', () => {
    expect(css).toMatch(/prefers-reduced-motion: no-preference\)\s*\{\s*\.reveal-ready \[data-reveal\]/);
    expect(css).not.toMatch(/\.(?:art|grain)[^{]*\{[^}]*animation/);
  });
});
