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

/** The light and dark rgb(r g b / a) of a `--name: light-dark(rgb(...), rgb(...))` token in landing.css. */
function token(name: string): { light: number[]; dark: number[] } {
  const match = new RegExp(
    `${name}:\\s*light-dark\\(rgb\\(([\\d.]+) ([\\d.]+) ([\\d.]+) / ([\\d.]+)\\),\\s*rgb\\(([\\d.]+) ([\\d.]+) ([\\d.]+) / ([\\d.]+)\\)\\)`,
  ).exec(css);
  if (!match) throw new Error(`${name} is not declared as light-dark(rgb(), rgb())`);
  const values = match.slice(1).map(Number);
  return { light: values.slice(0, 4), dark: values.slice(4) };
}

const luminance = ([r, g, b]: number[]) => {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r ?? 0) + 0.7152 * channel(g ?? 0) + 0.0722 * channel(b ?? 0);
};

const contrast = (a: number[], b: number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

describe('landing.css streaks', () => {
  const STREAK = ['--streak-body', '--streak-head', '--streak-tail', '--streak-glint'];
  // The canvas and the secondary text over it (globals.css): the faintest text a streak may sit behind.
  const THEMES = {
    light: { canvas: [250, 250, 249], text: [0x5c, 0x5c, 0x58] },
    dark: { canvas: [0, 0, 0], text: [0xa6, 0xa6, 0xa3] },
  } as const;

  it('keeps secondary text at 4.5:1 even where every layer of a streak peaks at once', () => {
    for (const theme of ['light', 'dark'] as const) {
      let ground: number[] = [...THEMES[theme].canvas];
      for (const name of STREAK) {
        const [r = 0, g = 0, b = 0, a = 0] = token(name)[theme];
        const layer = [r, g, b];
        ground = ground.map((value, i) => value * (1 - a) + (layer[i] ?? 0) * a);
      }
      expect(contrast(ground, [...THEMES[theme].text]), theme).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('never animates, and leaves forced colours and print plain', () => {
    expect(css).not.toMatch(/\.l-streak[^{]*\{[^}]*(?:animation|transition)/);
    expect(css).toMatch(/forced-colors: active\)\s*\{[^}]*\.l-streak-field\s*\{\s*display: none/);
    expect(css).toMatch(/@media print\s*\{\s*\.l-streak-field\s*\{\s*display: none/);
  });
});
