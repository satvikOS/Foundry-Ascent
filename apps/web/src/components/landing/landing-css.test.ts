import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, 'landing.css'), 'utf8');

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * channel(r ?? 0) + 0.7152 * channel(g ?? 0) + 0.0722 * channel(b ?? 0);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}
/** A token's light and dark values from `--name: light-dark(#light, #dark)`. */
function pair(name: string): { light: string; dark: string } {
  const match = new RegExp(`${name}:\\s*light-dark\\((#[0-9a-f]{6}),\\s*(#[0-9a-f]{6})\\)`, 'i').exec(css);
  if (!match?.[1] || !match[2]) throw new Error(`${name} is not a light-dark() pair of hex colours`);
  return { light: match[1], dark: match[2] };
}

describe('landing.css', () => {
  it('draws timeline bars at 3:1 or more on their speaker’s segment, in both themes', () => {
    for (const speaker of ['veir', 'student']) {
      const bar = pair(`--tl-bar-${speaker}`);
      const segment = pair(`--tl-${speaker}`);
      expect(contrast(bar.light, segment.light), `${speaker} light`).toBeGreaterThanOrEqual(3);
      expect(contrast(bar.dark, segment.dark), `${speaker} dark`).toBeGreaterThanOrEqual(3);
    }
  });

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
