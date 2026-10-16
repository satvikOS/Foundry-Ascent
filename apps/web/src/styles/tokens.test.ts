import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/*
 * The colour tokens in globals.css, checked from the CSS itself: every text token meets WCAG 2.2 AA
 * (4.5:1) on every surface it can sit on, in both themes, including the glass layers composited over
 * those surfaces; component boundaries and the focus ring meet 3:1; dark mode is true OLED black.
 * Change a token and this test recomputes the ratios, so a quiet regression cannot ship.
 */

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, 'globals.css'), 'utf8');

type Scheme = 'light' | 'dark';
interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** `--name: value;` declarations of the first `:root { … }` block (the token block). */
function rootDeclarations(source: string): Map<string, string> {
  const start = source.indexOf(':root {');
  if (start < 0) throw new Error('No :root block in globals.css');
  const end = source.indexOf('\n}', start);
  const body = source
    .slice(start + ':root {'.length, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ');
  const tokens = new Map<string, string>();
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    tokens.set(match[1] ?? '', (match[2] ?? '').trim());
  }
  return tokens;
}

const tokens = rootDeclarations(css);

/** Splits `a, b` at the top level (not inside parentheses). */
function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current.trim());
  return parts;
}

function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const digits = hex[1] ?? '';
    const full =
      digits.length === 3
        ? digits
            .split('')
            .map((d) => d + d)
            .join('')
        : digits;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
      a: 1,
    };
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,]\s*([\d.]+%?))?\s*\)$/i.exec(value);
  if (rgb) {
    const alpha = rgb[4];
    return {
      r: Number(rgb[1]),
      g: Number(rgb[2]),
      b: Number(rgb[3]),
      a: alpha === undefined ? 1 : alpha.endsWith('%') ? Number(alpha.slice(0, -1)) / 100 : Number(alpha),
    };
  }
  throw new Error(`Unsupported colour value: ${value}`);
}

/** The colour a token resolves to in one scheme (follows var() and light-dark()). */
function resolve(name: string, scheme: Scheme, seen: readonly string[] = []): Rgba {
  if (seen.includes(name)) throw new Error(`Cycle resolving ${[...seen, name].join(' → ')}`);
  const raw = tokens.get(name);
  if (raw === undefined) throw new Error(`Token ${name} is not declared in :root`);
  return resolveValue(raw, scheme, [...seen, name]);
}

function resolveValue(raw: string, scheme: Scheme, seen: readonly string[]): Rgba {
  const value = raw.trim();
  const lightDark = /^light-dark\((.*)\)$/s.exec(value);
  if (lightDark) {
    const [light, dark] = splitTopLevel(lightDark[1] ?? '');
    if (light === undefined || dark === undefined) throw new Error(`Bad light-dark(): ${value}`);
    return resolveValue(scheme === 'light' ? light : dark, scheme, seen);
  }
  const reference = /^var\((--[\w-]+)\)$/.exec(value);
  if (reference) return resolve(reference[1] ?? '', scheme, seen);
  return parseColor(value);
}

/** Source-over compositing of a (possibly translucent) colour onto an opaque one. */
function over(top: Rgba, bottom: Rgba): Rgba {
  if (bottom.a !== 1) throw new Error('Backdrops must be opaque');
  const mix = (t: number, b: number) => t * top.a + b * (1 - top.a);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

function luminance({ r, g, b }: Rgba): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const hex = ({ r, g, b }: Rgba) =>
  `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;

const SCHEMES: readonly Scheme[] = ['light', 'dark'];

/** Opaque surfaces text can sit on directly. */
const SOLID_SURFACES = [
  '--background',
  '--card',
  '--popover',
  '--muted',
  '--secondary',
  '--accent',
  '--sidebar',
  '--sidebar-accent',
] as const;

/** Translucent layers (`.glass`, `.glass-strong`): measured composited over every solid surface. */
const GLASS_LAYERS = ['--glass-bg', '--glass-bg-strong'] as const;

/** A surface as it renders: solids as declared, glass composited over each solid it can float over. */
function surfaces(scheme: Scheme): { name: string; color: Rgba }[] {
  const solids = SOLID_SURFACES.map((name) => ({ name, color: resolve(name, scheme) }));
  for (const solid of solids) {
    expect(solid.color.a, `${solid.name} (${scheme}) must be opaque`).toBe(1);
  }
  const glass = GLASS_LAYERS.flatMap((layer) =>
    solids.map((solid) => ({
      name: `${layer} over ${solid.name}`,
      color: over(resolve(layer, scheme), solid.color),
    })),
  );
  return [...solids, ...glass];
}

/** Neutral text tokens: each must be readable on every surface above. */
const TEXT_TOKENS = [
  '--foreground',
  '--card-foreground',
  '--popover-foreground',
  '--muted-foreground',
  '--subtle-foreground',
  '--secondary-foreground',
  '--accent-foreground',
  '--sidebar-foreground',
  '--sidebar-muted',
  '--sidebar-accent-foreground',
] as const;

/** Filled controls: text token on its own fill. */
const FILLED_PAIRS = [
  ['--primary-foreground', '--primary'],
  ['--sidebar-primary-foreground', '--sidebar-primary'],
  ['--destructive-foreground', '--destructive-strong'],
  ['--success-foreground', '--success'],
  ['--warning-foreground', '--warning'],
  ['--info-foreground', '--info'],
] as const;

/** Status colours used as text (badges, inline errors), on page surfaces and their own tints. */
const STATUS_TEXT = ['--destructive', '--success', '--warning', '--info'] as const;
const STATUS_BACKDROPS = ['--background', '--card', '--popover'] as const;

/** Component boundaries and focus (WCAG 1.4.11 non-text contrast, 3:1), on the surfaces they sit on. */
const NON_TEXT = [
  // Fields, checkboxes, radios and switches sit on the page, on cards and in dialogs and menus.
  { token: '--input', on: ['--background', '--card', '--popover'] },
  // Focus can land anywhere, including a hovered or selected row.
  { token: '--ring', on: SOLID_SURFACES },
] as const;

function failures(
  pairs: { label: string; fg: Rgba; bg: Rgba }[],
  minimum: number,
): { pair: string; ratio: string }[] {
  return pairs
    .map(({ label, fg, bg }) => ({ label, ratio: contrast(over(fg, bg), bg) }))
    .filter(({ ratio }) => ratio < minimum)
    .map(({ label, ratio }) => ({ pair: label, ratio: ratio.toFixed(2) }));
}

describe('colour tokens (globals.css)', () => {
  it('parses every token the checks name', () => {
    for (const name of [
      ...SOLID_SURFACES,
      ...GLASS_LAYERS,
      ...TEXT_TOKENS,
      ...NON_TEXT.map((n) => n.token),
    ]) {
      expect(tokens.has(name), name).toBe(true);
    }
  });

  for (const scheme of SCHEMES) {
    describe(`${scheme} theme`, () => {
      it('every text token reaches 4.5:1 on every surface, glass included', () => {
        const pairs = TEXT_TOKENS.flatMap((text) =>
          surfaces(scheme).map((surface) => ({
            label: `${text} on ${surface.name} (${hex(surface.color)})`,
            fg: resolve(text, scheme),
            bg: surface.color,
          })),
        );
        expect(pairs.length).toBeGreaterThan(200);
        expect(failures(pairs, 4.5)).toEqual([]);
      });

      it('text on filled controls reaches 4.5:1', () => {
        const pairs = FILLED_PAIRS.map(([text, fill]) => ({
          label: `${text} on ${fill}`,
          fg: resolve(text, scheme),
          bg: resolve(fill, scheme),
        }));
        expect(failures(pairs, 4.5)).toEqual([]);
      });

      it('status text reaches 4.5:1 on page surfaces and on its own 10–15 % tints', () => {
        const pairs = STATUS_TEXT.flatMap((status) => {
          const color = resolve(status, scheme);
          return STATUS_BACKDROPS.flatMap((backdrop) => {
            const base = resolve(backdrop, scheme);
            return [0, 0.1, 0.15].map((tint) => ({
              label: `${status} on ${backdrop}${tint ? ` + ${tint * 100}% tint` : ''}`,
              fg: color,
              bg: tint ? over({ ...color, a: tint }, base) : base,
            }));
          });
        });
        expect(failures(pairs, 4.5)).toEqual([]);
      });

      it('field boundaries and the focus ring reach 3:1 on the surfaces they sit on', () => {
        const pairs = NON_TEXT.flatMap(({ token, on }) =>
          on.map((surface) => ({
            label: `${token} on ${surface}`,
            fg: resolve(token, scheme),
            bg: resolve(surface, scheme),
          })),
        );
        expect(failures(pairs, 3)).toEqual([]);
      });
    });
  }

  describe('OLED dark', () => {
    it('the canvas and the sidebar are true black', () => {
      expect(hex(resolve('--background', 'dark'))).toBe('#000000');
      expect(hex(resolve('--sidebar', 'dark'))).toBe('#000000');
      expect(hex(resolve('--primary-foreground', 'dark'))).toBe('#000000');
    });

    it('raised surfaces are near-black steps that stay distinguishable from the canvas', () => {
      const canvas = resolve('--background', 'dark');
      const steps = ['--card', '--muted', '--popover', '--secondary', '--accent'].map((name) => ({
        name,
        color: resolve(name, 'dark'),
      }));
      for (const { name, color } of steps) {
        const ratio = contrast(color, canvas);
        // Lit, not crushed to black on an OLED panel; still near-black.
        expect(ratio, `${name} vs canvas`).toBeGreaterThanOrEqual(1.05);
        expect(luminance(color), `${name} stays near-black`).toBeLessThan(0.02);
      }
      // Hover and selection must read on the black canvas and sidebar.
      expect(contrast(resolve('--accent', 'dark'), canvas)).toBeGreaterThanOrEqual(1.2);
      expect(
        contrast(resolve('--sidebar-accent', 'dark'), resolve('--sidebar', 'dark')),
      ).toBeGreaterThanOrEqual(1.2);
    });

    it('borders are low-alpha white hairlines', () => {
      for (const name of ['--fa-border', '--border-strong', '--sidebar-border', '--glass-border']) {
        const color = resolve(name, 'dark');
        expect(color, name).toMatchObject({ r: 255, g: 255, b: 255 });
        expect(color.a, name).toBeGreaterThan(0);
        expect(color.a, name).toBeLessThanOrEqual(0.2);
      }
    });

    it('the browser chrome colour matches the canvas in both themes', () => {
      const html = readFileSync(join(here, '..', '..', 'index.html'), 'utf8');
      const theme = readFileSync(join(here, '..', 'lib', 'theme.ts'), 'utf8');
      for (const scheme of SCHEMES) {
        const canvas = hex(resolve('--background', scheme));
        const meta = new RegExp(
          `<meta name="theme-color" content="(#[0-9a-f]{6})" media="\\(prefers-color-scheme: ${scheme}\\)"`,
          'i',
        ).exec(html);
        expect(meta?.[1]?.toLowerCase(), `index.html theme-color (${scheme})`).toBe(canvas);
        const runtime = new RegExp(`${scheme}: '(#[0-9a-f]{6})'`, 'i').exec(theme);
        expect(runtime?.[1]?.toLowerCase(), `theme.ts THEME_COLORS.${scheme}`).toBe(canvas);
      }
    });
  });

  it('no component fades a text token with an opacity modifier (that would bypass these checks)', () => {
    const root = join(here, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry) && !entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx')) {
          const source = readFileSync(path, 'utf8');
          for (const match of source.matchAll(
            /\btext-(?:foreground|[\w-]*-foreground|sidebar-muted)\/(?:\d+|\[[^\]]+\])/g,
          )) {
            offenders.push(`${path.slice(root.length + 1)}: ${match[0]}`);
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
