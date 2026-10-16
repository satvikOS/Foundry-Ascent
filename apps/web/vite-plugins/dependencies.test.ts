import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');

/** Every source file of the app and its build (tests included: a library only tests use is a devDependency). */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(?:ts|tsx|css)$/.test(name) ? [path] : [];
  });
}

/** Whether `text` imports `name` (the package itself, or a file or subpath of it), from code or CSS. */
function imports(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(
    `(?:from\\s+|import\\s*\\(?\\s*|@import\\s+|@plugin\\s+)['"]${escaped}(?:/[^'"]*)?['"]`,
  ).test(text);
}

describe('web dependencies', () => {
  it('ships only libraries the app imports (an unused one still costs every install and audit)', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const texts = [
      ...sources(join(root, 'src')),
      ...sources(join(root, 'vite-plugins')),
      join(root, 'vite.config.ts'),
    ].map((path) => readFileSync(path, 'utf8'));
    const unused = Object.keys(pkg.dependencies).filter((name) => !texts.some((text) => imports(text, name)));
    expect(unused).toEqual([]);
  });

  it('recognises an import from code, a subpath and a stylesheet, and nothing else', () => {
    expect(imports(`import { z } from 'zod';`, 'zod')).toBe(true);
    expect(imports(`import '@fontsource-variable/geist/wght.css';`, '@fontsource-variable/geist')).toBe(true);
    expect(imports(`const m = await import('pdfjs-dist/build/pdf.mjs');`, 'pdfjs-dist')).toBe(true);
    expect(imports(`import '@fontsource-variable/geist-mono/wght.css';`, '@fontsource-variable/geist')).toBe(
      false,
    );
    expect(imports(`// motion used to fade the banners`, 'motion')).toBe(false);
  });
});
