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
  '--surface-1',
  '--surface-2',
  '--surface-3',
  '--surface-overlay',
  '--card',
  '--popover',
  '--muted',
  '--secondary',
  '--accent',
  '--sidebar',
] as const;

/** Translucent layers (`.glass`, `.glass-bar`, `.glass-strong`): measured composited over every solid surface. */
const GLASS_LAYERS = ['--glass-bg', '--glass-bg-bar', '--glass-bg-strong'] as const;

/** A surface as it renders: solids as declared, glass composited over each solid it can float over. */
function surfaces(scheme: Scheme): { name: string; color: Rgba }[] {
  const solids = SOLID_SURFACES.map((name) => ({ name, color: resolve(name, scheme) }));
  for (const solid of solids) {
    expect(solid.color.a, `${solid.name} (${scheme}) must be opaque`).toBe(1);
  }
  const bases = [...solids, ...grounds(scheme).slice(1)];
  const glass = GLASS_LAYERS.flatMap((layer) =>
    bases.map((solid) => ({
      name: `${layer} over ${solid.name}`,
      color: over(resolve(layer, scheme), solid.color),
    })),
  );
  return [...bases, ...glass];
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

/**
 * Text colours drawn on the bars that text scrolls under: the neutral text tokens, and the status colours the
 * mini call bar writes on its glass ("· 2 min left", "Microphone disconnected", "Sound is off" in --warning).
 */
const BAR_TEXT = [...TEXT_TOKENS, ...STATUS_TEXT] as const;

/** The source files that draw a sticky bar on the bars' glass, and the colour tokens their `text-*` classes name. */
function barSources(): { where: string; textTokens: string[] }[] {
  const root = join(here, '..');
  const found: { where: string; textTokens: string[] }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith('.tsx') && !entry.endsWith('.test.tsx')) {
        const source = readFileSync(path, 'utf8');
        if (!/['"`\s]glass-bar['"`\s]/.test(source)) continue;
        const named = [...source.matchAll(/\btext-([a-z][\w-]*)/g)]
          .map((match) => `--${match[1] ?? ''}`)
          .filter((token) => tokens.has(token));
        found.push({ where: path.slice(root.length + 1), textTokens: [...new Set(named)].sort() });
      }
    }
  };
  walk(root);
  return found;
}

/** Component boundaries and focus (WCAG 1.4.11 non-text contrast, 3:1), on the surfaces they sit on. */
const NON_TEXT = [
  // Fields, checkboxes, radios and switches sit on the page, on cards and in dialogs and menus.
  { token: '--input', on: ['--background', '--card', '--popover'] },
  // Focus can land anywhere, including a hovered or selected row.
  { token: '--ring', on: SOLID_SURFACES },
] as const;

/**
 * Selection in a master list (SelectableRow): the selected row is filled with `--accent` and marked by a
 * bar in `--selected-cue`; hover is `--accent` at 50 % and never draws the bar. The bar is what tells the
 * two apart, so it must reach 3:1 (WCAG 1.4.11) on the selected fill, on the hover tint and on every page
 * surface a list sits on.
 */
const SELECTION_SURFACES = ['--background', '--card', '--popover'] as const;

/*
 * Glass, as it renders (globals.css `.glass`, `.glass-strong`, `.glass-float`). A thin face over what lies beneath,
 * blurred: `backdrop-filter: blur(24px)` is a Gaussian with a 24 px standard deviation, so nothing narrower than
 * the blur keeps its full colour beneath the glass. The widest content that passes under app glass and is not a
 * surface (surfaces are measured whole) is a filled control, at most 36 px tall: at its centre the blur keeps
 * erf(18 / (24·√2)) ≈ 0.55 of its colour, and a line of text far less (its ink is a fraction of its line box). So the
 * worst backdrop is any content colour at 55 % over any surface. Where the blur is missing (no support, reduced
 * transparency, a slow device) every glass layer is solid instead, measured with the solid surfaces.
 */
const BLUR_SIGMA_PX = 24;
const WIDEST_CONTENT_PX = 36;
/** erf, Abramowitz and Stegun 7.1.26 (|error| < 1.5e-7). */
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return Math.sign(x) * y;
}
/** The share of a filled control's colour left at its centre beneath the blur. */
const BLURRED_COVERAGE = erf(WIDEST_CONTENT_PX / 2 / (BLUR_SIGMA_PX * Math.SQRT2));

/** `brightness()` in the glass's backdrop filter: 1 in light, `:root.dark`'s value in dark (globals.css). */
function backdropBrightness(scheme: Scheme): number {
  if (scheme === 'light') return Number(tokens.get('--glass-brightness'));
  const dark = /:root\.dark \{[^}]*--glass-brightness: ([\d.]+);/.exec(css)?.[1];
  const os =
    /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\.light\) \{\s*--glass-brightness: ([\d.]+);/.exec(
      css,
    )?.[1];
  expect(os, 'the OS dark theme dims the backdrop as the forced one does').toBe(dark);
  return Number(dark);
}

/** What the glass shows of a backdrop: blurred (above), then dimmed by `brightness()` (per sRGB channel). */
function dimmed(color: Rgba, scheme: Scheme): Rgba {
  const k = backdropBrightness(scheme);
  return { r: color.r * k, g: color.g * k, b: color.b * k, a: color.a };
}

/** Everything that can pass beneath glass: surfaces, text, status colours and filled controls. */
const CONTENTS = [
  ...SOLID_SURFACES,
  ...TEXT_TOKENS,
  ...STATUS_TEXT,
  ...FILLED_PAIRS.map(([, fill]) => fill),
] as const;

/** The breathing ground's colour fields (behind a conversation window), each at its strongest. */
const BREATH_FIELDS = ['--breath-1', '--breath-2', '--breath-3'] as const;

/**
 * The ground: the canvas, and the canvas under the atmosphere's two tints and the breathing ground's three fields,
 * each at its strongest.
 */
function grounds(scheme: Scheme): { name: string; color: Rgba }[] {
  const canvas = resolve('--background', scheme);
  return [
    { name: '--background', color: canvas },
    ...['--atmosphere-1', '--atmosphere-2', ...BREATH_FIELDS].map((tint) => ({
      name: `${tint} over --background`,
      color: over(resolve(tint, scheme), canvas),
    })),
  ];
}

/** What a glass face sits on once blurred: each content colour at BLURRED_COVERAGE over each surface or ground. */
function blurredBackdrops(scheme: Scheme): { name: string; color: Rgba }[] {
  const bases = [
    ...SOLID_SURFACES.map((name) => ({ name, color: resolve(name, scheme) })),
    ...grounds(scheme),
  ];
  return CONTENTS.flatMap((content) => {
    const color = resolve(content, scheme);
    return bases.map((base) => ({
      name: `${content} (blurred) over ${base.name}`,
      color: over({ ...color, a: BLURRED_COVERAGE }, base.color),
    }));
  });
}

/** Text on glass: the neutral tokens, with secondary text at its on-glass value (`.glass*` sets it). */
const GLASS_TEXT = ['--foreground', '--popover-foreground', '--card-foreground', '--glass-muted'] as const;
/**
 * Row fills on glass: tints, so the glass still shows through them. `--glass-row` is a menu's or the palette's
 * highlighted row (`--accent` on glass) and the panel's hover; `--glass-row-selected` is only the side panel's
 * current page (`--sidebar-accent`), so it is measured on the panel's faces alone.
 */
const GLASS_ROW_FILLS = ['--glass-row', '--glass-row-selected'] as const;
const LAYER_ROW_FILLS = ['--glass-row'] as const;

/** A glass face over every blurred backdrop, bare and under each row fill it can carry. */
function glassFaces(
  face: string,
  scheme: Scheme,
  scrim?: string,
  rowFills: readonly string[] = LAYER_ROW_FILLS,
): { name: string; color: Rgba }[] {
  const glass = resolve(face, scheme);
  return blurredBackdrops(scheme).flatMap((backdrop) => {
    const beneath = dimmed(scrim ? over(resolve(scrim, scheme), backdrop.color) : backdrop.color, scheme);
    const bare = over(glass, beneath);
    const label = `${face}${scrim ? ` over ${scrim}` : ''} over ${backdrop.name}`;
    return [
      { name: label, color: bare },
      ...rowFills.map((fill) => ({
        name: `${fill} on ${label}`,
        color: over(resolve(fill, scheme), bare),
      })),
    ];
  });
}

/*
 * The floating side panel (`.glass-float`). Three faces: docked on desktop, its glass over the ground (the canvas
 * and its atmosphere; nothing else passes beneath it); solid (`--sidebar`: no blur, reduced transparency, a slow
 * device); and over the content below 1024 px, the denser face over a soft scrim over the blurred content.
 */
const PANEL_TEXT = ['--sidebar-foreground', '--glass-muted'] as const;

function panelRows(scheme: Scheme): { name: string; color: Rgba }[] {
  const docked = resolve('--glass-float-bg', scheme);
  const dockedFaces = grounds(scheme).flatMap((ground) => {
    const bare = over(docked, dimmed(ground.color, scheme));
    const label = `docked (--glass-float-bg over ${ground.name})`;
    return [
      { name: label, color: bare },
      ...GLASS_ROW_FILLS.map((fill) => ({
        name: `${fill} on ${label}`,
        color: over(resolve(fill, scheme), bare),
      })),
    ];
  });
  const solid = resolve('--sidebar', scheme);
  const solidFaces = [
    { name: 'solid (--sidebar)', color: solid },
    ...['--sidebar-hover', '--sidebar-accent'].map((fill) => ({
      name: `${fill} on solid (--sidebar)`,
      color: over(resolve(fill, scheme), solid),
    })),
  ];
  return [
    ...dockedFaces,
    ...solidFaces,
    ...glassFaces('--glass-float-bg-over', scheme, '--scrim-soft', GLASS_ROW_FILLS),
  ];
}

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
      '--selected-cue',
      ...PANEL_TEXT,
      ...GLASS_TEXT,
      ...GLASS_ROW_FILLS,
      '--glass-float-bg',
      '--glass-float-bg-over',
      '--glass-float-border',
      '--glass-brightness',
      '--scrim-soft',
      '--scrim-faint',
      '--surface-control',
      '--control-glass',
      '--control-glass-hover',
      '--atmosphere-1',
      '--atmosphere-2',
      ...BREATH_FIELDS,
      '--window-face',
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

      it('text in the conversation window keeps 4.5:1 over the breathing ground at its strongest', () => {
        // The window's face has no blur (what lies behind it is already soft): prose sits on the face composited
        // over the canvas and each colour field at its centre.
        const face = resolve('--window-face', scheme);
        expect(face.a, 'the window is translucent').toBeLessThan(0.75);
        const pairs = [...TEXT_TOKENS, ...STATUS_TEXT].flatMap((text) =>
          grounds(scheme).map((ground) => {
            const bg = over(face, ground.color);
            return {
              label: `${text} on --window-face over ${ground.name} (${hex(bg)})`,
              fg: resolve(text, scheme),
              bg,
            };
          }),
        );
        expect(pairs.length).toBeGreaterThan(60);
        expect(failures(pairs, 4.5)).toEqual([]);
      });

      it('the breathing fields are faint: the ground stays the canvas', () => {
        const canvas = resolve('--background', scheme);
        for (const tint of BREATH_FIELDS) {
          const peak = over(resolve(tint, scheme), canvas);
          expect(contrast(peak, canvas), `${tint} at its strongest`).toBeLessThan(1.2);
          if (scheme === 'dark') expect(luminance(peak), `${tint} at its strongest`).toBeLessThan(0.01);
        }
      });

      it('text on the bars that text scrolls under keeps 4.5:1 over the worst content passing beneath', () => {
        // A sticky header over a conversation (03-conversation-mobile-light.png): a line of prose or a filled
        // button passes under the bar as a solid block of its colour at its centre, so no credit is given for the
        // blur. Every surface, every text colour and every fill is a possible backdrop.
        const bar = resolve('--glass-bg-bar', scheme);
        const contents = [
          ...SOLID_SURFACES,
          ...TEXT_TOKENS,
          ...STATUS_TEXT,
          ...FILLED_PAIRS.map(([, fill]) => fill),
        ].map((name) => ({ name, color: resolve(name, scheme) }));
        const pairs = BAR_TEXT.flatMap((text) =>
          contents.map((content) => {
            const bg = over(bar, content.color);
            return {
              label: `${text} on --glass-bg-bar over ${content.name} (${hex(bg)})`,
              fg: resolve(text, scheme),
              bg,
            };
          }),
        );
        expect(pairs.length).toBeGreaterThan(350);
        expect(failures(pairs, 4.5)).toEqual([]);
        // The page's lighter glass would not hold there: that is why the bars have their own.
        const thin = resolve('--glass-bg', scheme);
        const worst = Math.min(
          ...contents.map((content) =>
            contrast(
              over(resolve('--muted-foreground', scheme), over(thin, content.color)),
              over(thin, content.color),
            ),
          ),
        );
        expect(worst).toBeLessThan(4.5);
      });

      it('popovers over the call screen are solid: their text holds 4.5:1 over the captions beneath', () => {
        // The call settings open over the sphere and the 22 px captions (call-settings-*-mobile-*.png). A caption
        // line passes beneath as a solid block of --foreground, so no credit is given for the blur.
        expect(css).toMatch(
          /:root:has\(\[data-slot='call-screen'\]\) \[data-slot='popover-content'\] \{\s*background-color: var\(--popover\);\s*-webkit-backdrop-filter: none;\s*backdrop-filter: none;/,
        );
        const face = resolve('--popover', scheme);
        const pairs = TEXT_TOKENS.map((text) => ({
          label: `${text} on the solid call popover (--popover)`,
          fg: resolve(text, scheme),
          bg: face,
        }));
        expect(failures(pairs, 4.5)).toEqual([]);
        // The ordinary popover glass would not hold over a caption in dark: that is why the call's are solid.
        if (scheme === 'dark') {
          const glass = over(resolve('--glass-bg-strong', scheme), resolve('--foreground', scheme));
          expect(contrast(resolve('--muted-foreground', scheme), glass)).toBeLessThan(4.5);
        }
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

      it('the selected-row cue reaches 3:1 on the selected fill, the hover tint and the page', () => {
        const cue = resolve('--selected-cue', scheme);
        const accent = resolve('--accent', scheme);
        const pairs = SELECTION_SURFACES.flatMap((surface) => {
          const base = resolve(surface, scheme);
          return [
            { label: `--selected-cue on ${surface}`, fg: cue, bg: base },
            {
              label: `--selected-cue on --accent (selected) over ${surface}`,
              fg: cue,
              bg: over(accent, base),
            },
            {
              label: `--selected-cue beside --accent/50 (hover) over ${surface}`,
              fg: cue,
              bg: over({ ...accent, a: 0.5 }, base),
            },
          ];
        });
        expect(pairs).toHaveLength(SELECTION_SURFACES.length * 3);
        expect(failures(pairs, 3)).toEqual([]);
        // The row component draws exactly what is measured here.
        const row = readFileSync(join(here, '..', 'components', 'ui', 'selectable-row.tsx'), 'utf8');
        expect(row).toContain("'bg-accent before:bg-selected-cue'");
        expect(row).toContain('hover:bg-accent/50');
      });

      it('the floating panel keeps its text at 4.5:1 on every face, row fills included', () => {
        const pairs = PANEL_TEXT.flatMap((text) =>
          panelRows(scheme).map((row) => ({
            label: `${text} on ${row.name} (${hex(row.color)})`,
            fg: resolve(text, scheme),
            bg: row.color,
          })),
        );
        expect(pairs.length).toBeGreaterThan(1000);
        expect(failures(pairs, 4.5)).toEqual([]);
        // The solid face keeps the ordinary secondary text.
        expect(
          contrast(resolve('--sidebar-muted', scheme), resolve('--sidebar', scheme)),
        ).toBeGreaterThanOrEqual(4.5);
        // With no blur, the translucent face would not hold over a line of text: that is why it turns solid then.
        if (scheme === 'dark') {
          const bare = over(resolve('--glass-float-bg-over', scheme), resolve('--foreground', scheme));
          expect(contrast(resolve('--glass-muted', scheme), bare)).toBeLessThan(4.5);
        }
      });

      it('text on the composer, menus, popovers, the palette and toasts keeps 4.5:1 over the worst blurred content', () => {
        expect(BLURRED_COVERAGE).toBeGreaterThan(0.54);
        expect(BLURRED_COVERAGE).toBeLessThan(0.56);
        for (const face of ['--glass-bg', '--glass-bg-strong']) {
          const pairs = GLASS_TEXT.flatMap((text) =>
            glassFaces(face, scheme).map((row) => ({
              label: `${text} on ${row.name} (${hex(row.color)})`,
              fg: resolve(text, scheme),
              bg: row.color,
            })),
          );
          expect(pairs.length).toBeGreaterThan(1000);
          expect(failures(pairs, 4.5)).toEqual([]);
        }
        // The ordinary secondary text would not hold there: that is why glass carries its own.
        const worst = Math.min(
          ...glassFaces('--glass-bg', scheme).map((row) =>
            contrast(over(resolve('--muted-foreground', scheme), row.color), row.color),
          ),
        );
        expect(worst).toBeLessThan(4.5);
        // And glass sets it: secondary text and row fills inside take their on-glass values.
        expect(css).toMatch(
          /\.glass,\s*\.glass-strong,\s*\.glass-float \{\s*--muted-foreground: var\(--glass-muted\);\s*--subtle-foreground: var\(--glass-muted\);\s*--sidebar-muted: var\(--glass-muted\);\s*--accent: var\(--glass-row\);\s*--sidebar-hover: var\(--glass-row\);\s*--sidebar-accent: var\(--glass-row-selected\);/,
        );
      });

      it('the glass is genuinely translucent (owner, 2026-11-05) and blurs 20–28 px', () => {
        const range = scheme === 'dark' ? [0.42, 0.6] : [0.55, 0.65];
        for (const face of ['--glass-bg', '--glass-bg-strong', '--glass-float-bg', '--glass-float-bg-over']) {
          const { a } = resolve(face, scheme);
          expect(a, `${face} (${scheme})`).toBeGreaterThanOrEqual(range[0] ?? 0);
          expect(a, `${face} (${scheme})`).toBeLessThanOrEqual(range[1] ?? 1);
        }
        // A touch of dimming in dark at most: a heavier dim (0.8) made the glass read as an opaque panel.
        expect(backdropBrightness(scheme)).toBeGreaterThanOrEqual(scheme === 'dark' ? 0.9 : 1);
        expect(backdropBrightness(scheme)).toBeLessThanOrEqual(1);
        for (const blur of ['--glass-blur']) {
          const px = Number.parseFloat(tokens.get(blur) ?? '');
          expect(px, blur).toBeGreaterThanOrEqual(20);
          expect(px, blur).toBeLessThanOrEqual(28);
          expect(px, `${blur}: the contrast model assumes this blur`).toBeGreaterThanOrEqual(BLUR_SIGMA_PX);
        }
      });

      it('the selected row’s cue and the focus ring reach 3:1 on every panel face', () => {
        const pairs = panelRows(scheme).flatMap((row) => [
          { label: `--selected-cue on ${row.name}`, fg: resolve('--selected-cue', scheme), bg: row.color },
          { label: `--sidebar-ring on ${row.name}`, fg: resolve('--sidebar-ring', scheme), bg: row.color },
        ]);
        expect(failures(pairs, 3)).toEqual([]);
        // The rows and the overlay draw exactly what is measured here.
        const shell = readFileSync(join(here, '..', 'components', 'shell', 'app-shell.tsx'), 'utf8');
        expect(shell).toContain('[--glass-float-face:var(--glass-float-bg-over)]');
        expect(shell).toContain('bg-(--scrim-soft)');
        const rows = readFileSync(join(here, '..', 'components', 'shell', 'sidebar-styles.ts'), 'utf8');
        expect(rows).toContain('hover:bg-sidebar-hover');
        expect(rows).toContain(
          'data-[status=active]:bg-sidebar-accent data-[status=active]:before:opacity-100',
        );
        expect(rows).toContain('before:bg-selected-cue');
      });

      it('round call controls hold their icon at 3:1, and the timeline bars at 3:1 on their segments', () => {
        // Frosted over the ground (the canvas and its atmosphere), and solid where glass is off.
        const canvas = resolve('--background', scheme);
        for (const ground of grounds(scheme)) {
          for (const tint of ['--control-glass', '--control-glass-hover']) {
            const face = over(resolve(tint, scheme), dimmed(ground.color, scheme));
            expect(
              contrast(resolve('--fa-text', scheme), face),
              `icon on ${tint} over ${ground.name}`,
            ).toBeGreaterThanOrEqual(3);
            expect(contrast(face, canvas), `${tint} stands off the canvas`).toBeGreaterThanOrEqual(1.1);
          }
        }
        const control = resolve('--surface-control', scheme);
        const pairs = [
          ...['--background', '--fa-text'].map(() => ({
            label: '--fa-text icon on --surface-control',
            fg: resolve('--fa-text', scheme),
            bg: control,
          })),
          {
            label: '--surface-control on the canvas is visible',
            fg: control,
            bg: resolve('--background', scheme),
          },
          {
            label: '--tl-bar-veir on --tl-veir',
            fg: resolve('--tl-bar-veir', scheme),
            bg: resolve('--tl-veir', scheme),
          },
          {
            label: '--tl-bar-student on --tl-student',
            fg: resolve('--tl-bar-student', scheme),
            bg: resolve('--tl-student', scheme),
          },
        ];
        expect(failures(pairs.slice(0, 2), 3)).toEqual([]);
        expect(failures(pairs.slice(3), 3)).toEqual([]);
        // The control is a lit step off the canvas, not a hole in it.
        expect(contrast(control, resolve('--background', scheme))).toBeGreaterThanOrEqual(1.1);
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
    it('the canvas is true black, and the floating panel a near-black float on it', () => {
      const canvas = resolve('--background', 'dark');
      expect(hex(canvas)).toBe('#000000');
      expect(hex(resolve('--primary-foreground', 'dark'))).toBe('#000000');
      for (const face of [resolve('--sidebar', 'dark'), over(resolve('--glass-float-bg', 'dark'), canvas)]) {
        expect(luminance(face)).toBeLessThan(0.01);
        expect(contrast(face, canvas)).toBeGreaterThanOrEqual(1.05);
      }
    });

    it('the grounds step up from the canvas: surface 1, 2, 3', () => {
      for (const scheme of SCHEMES) {
        const steps = ['--background', '--surface-1', '--surface-2', '--surface-3'].map((name) =>
          luminance(resolve(name, scheme)),
        );
        // Dark lifts each step; light's canvas is the off-white under white cards, then wells darken.
        if (scheme === 'dark') expect(steps).toEqual([...steps].sort((a, b) => a - b));
        else expect(steps.slice(1)).toEqual([...steps.slice(1)].sort((a, b) => b - a));
      }
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
      // Hover and selected fills stay visible on the black canvas and sidebar (lit, not crushed). The fill
      // is only a secondary cue: the selected-row bar carries selection (checked above in both themes).
      expect(contrast(resolve('--accent', 'dark'), canvas)).toBeGreaterThanOrEqual(1.2);
      const panel = over(resolve('--glass-float-bg', 'dark'), canvas);
      expect(contrast(over(resolve('--glass-row-selected', 'dark'), panel), panel)).toBeGreaterThanOrEqual(
        1.2,
      );
      expect(contrast(over(resolve('--glass-row', 'dark'), panel), panel)).toBeGreaterThanOrEqual(1.1);
    });

    it('one blur per region: the dock frosts the transcript once, and a layer over the panel is solid', () => {
      // The composer and its chips are tints over the dock's blur, never a second blur over it.
      expect(css).toMatch(
        /\.composer-dock \.glass \{\s*-webkit-backdrop-filter: none;\s*backdrop-filter: none;/,
      );
      expect(/\.composer-dock::before \{([^}]*)\}/.exec(css)?.[1]).toContain(
        'backdrop-filter: blur(var(--glass-blur))',
      );
      // A menu, popover or tooltip opened from the side panel (`.over-glass`) is the solid popover face.
      expect(css).toMatch(
        /\.glass-strong\.over-glass \{\s*background-color: var\(--popover\);\s*-webkit-backdrop-filter: none;\s*backdrop-filter: none;/,
      );
    });

    it('the atmosphere behind the glass is faint: OLED black stays dominant', () => {
      const canvas = resolve('--background', 'dark');
      for (const tint of ['--atmosphere-1', '--atmosphere-2']) {
        const peak = over(resolve(tint, 'dark'), canvas);
        expect(luminance(peak), `${tint} at its strongest`).toBeLessThan(0.01);
        expect(contrast(peak, canvas), `${tint} at its strongest`).toBeLessThan(1.2);
      }
      // Static: painted once, fixed behind everything, never animated.
      const ground = /\.app-ground::before \{([^}]*)\}/.exec(css)?.[1] ?? '';
      expect(ground).toContain('position: fixed');
      expect(ground).not.toMatch(/animation|transition/);
    });

    it('the breathing ground is cheap: a fixed canvas behind the window, whose pane has no blur of its own', () => {
      const ground = /\.breathing-ground \{([^}]*)\}/.exec(css)?.[1] ?? '';
      expect(ground).toContain('position: fixed');
      expect(ground).toContain('pointer-events: none');
      const frame = /\.conv-window-frame \{\s*display: block;([^}]*)\}/.exec(css)?.[1] ?? '';
      expect(frame).toContain('position: sticky');
      expect(frame).not.toMatch(/backdrop-filter|animation|transition/);
      // Gone on a slow device, in forced colours and in print.
      expect(css).toMatch(/:root\[data-perf='low'\] \.breathing-ground \{\s*display: none;/);
    });

    it('the window caps never depend on the breathing ground: plain caps match the static ground and stay', () => {
      const squash = (text: string | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();
      // The plain caps paint the ground the page shows without the breathing ground: its colour and its atmosphere.
      const atmosphere = squash(/\.app-ground::before \{[^}]*background:([^;]*);/.exec(css)?.[1]);
      const caps = squash(/\.window-caps \{[^}]*background:([^;]*);/.exec(css)?.[1]);
      expect(atmosphere).not.toBe('');
      expect(caps).toBe(`${atmosphere}, var(--background)`);
      // The breathing ground's moving copy lies over them, never under.
      const zOf = (rule: string) => Number(new RegExp(`\\.${rule} \\{[^}]*z-index: (\\d+);`).exec(css)?.[1]);
      expect(zOf('breathing-caps')).toBeGreaterThan(zOf('window-caps'));
      // Hidden only on a phone (no gaps there): never on a slow device, in forced colours or under a status banner.
      const hidden = [...css.matchAll(/([^{}]*(?:window-caps|ground-caps)[^{}]*)\{\s*display: none;/g)].map(
        (m) => squash(m[1]),
      );
      expect(hidden).toEqual(['.ground-caps']);
      expect(css).toMatch(/@media \(width < 48rem\) \{\s*\.ground-caps \{\s*display: none;/);
    });

    it('borders are low-alpha white hairlines', () => {
      for (const name of [
        '--fa-border',
        '--border-strong',
        '--sidebar-border',
        '--glass-border',
        '--glass-float-border',
      ]) {
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

  it('every sticky bar at the top of a page is on the bars’ glass, never the thinner page glass', () => {
    const root = join(here, '..');
    const bars: string[] = [];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (entry.endsWith('.tsx') && !entry.endsWith('.test.tsx')) {
          const source = readFileSync(path, 'utf8');
          for (const match of source.matchAll(/(['"`])([^'"`]*\bsticky\b[^'"`]*)\1/g)) {
            const classes = match[2] ?? '';
            if (!/(?:^|\s)top-/.test(classes)) continue;
            const where = path.slice(root.length + 1);
            if (/(?:^|\s)glass-bar(?:\s|$)/.test(classes)) bars.push(where);
            else if (/(?:^|\s)glass(?:-strong)?(?:\s|$)/.test(classes)) offenders.push(where);
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
    // The conversation header, the phone bar and the mini call bar (the landing page's bar is fixed, not sticky:
    // it takes the same glass once the page scrolls, components/landing/landing-nav.tsx).
    expect(bars.sort()).toEqual([
      'components/shell/app-shell.tsx',
      'features/calls/mini-call-bar-view.tsx',
      'features/chat/conversation-header.tsx',
    ]);
  });

  it('every text colour a bar’s source names is one the bar contrast check measures', () => {
    const sources = barSources();
    // The conversation header, the phone bar, the mini call bar and the landing page's header.
    expect(sources.map((s) => s.where).sort()).toEqual([
      'components/landing/landing-nav.tsx',
      'components/shell/app-shell.tsx',
      'features/calls/mini-call-bar-view.tsx',
      'features/chat/conversation-header.tsx',
    ]);
    const measured = new Set<string>(BAR_TEXT);
    const unmeasured = sources.flatMap(({ where, textTokens }) =>
      textTokens.filter((token) => !measured.has(token)).map((token) => `${where}: ${token}`),
    );
    // Decoration, not text (WCAG 1.4.3 exempts it): the header's aria-hidden "/" between the name and the title.
    const decorative = ['features/chat/conversation-header.tsx: --border-strong'];
    expect(unmeasured).toEqual(decorative);
    // The mini call bar's warnings are among them.
    expect(sources.find((s) => s.where.endsWith('mini-call-bar-view.tsx'))?.textTokens).toContain(
      '--warning',
    );
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
