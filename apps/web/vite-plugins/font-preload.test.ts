import { describe, expect, it } from 'vitest';

import { emittedFont, fontPreloadTag, PRELOADED_FONT } from './font-preload';

describe('font preload', () => {
  const outputs = [
    { type: 'chunk' as const, fileName: 'assets/index-abc.js' },
    {
      type: 'asset' as const,
      fileName: 'assets/inter-latin-ext-wght-normal-x.woff2',
      originalFileNames: ['node_modules/@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2'],
    },
    {
      type: 'asset' as const,
      fileName: 'assets/inter-latin-wght-normal-Dx4k.woff2',
      originalFileNames: ['node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2'],
    },
    {
      type: 'asset' as const,
      fileName: 'assets/geist-latin-wght-normal-y.woff2',
      originalFileNames: ['node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2'],
    },
  ];

  it('preloads the platform face’s Latin file, and only that one', () => {
    expect(PRELOADED_FONT).toBe('inter-latin-wght-normal.woff2');
    expect(emittedFont(outputs)).toBe('assets/inter-latin-wght-normal-Dx4k.woff2');
  });

  it('finds nothing when the face was not emitted (the build then fails)', () => {
    expect(emittedFont(outputs.filter((o) => !o.fileName.includes('inter-latin-wght')))).toBeUndefined();
  });

  it('writes a CORS-mode woff2 preload into the head', () => {
    expect(fontPreloadTag('/assets/inter.woff2')).toEqual({
      tag: 'link',
      attrs: { rel: 'preload', href: '/assets/inter.woff2', as: 'font', type: 'font/woff2', crossorigin: '' },
      injectTo: 'head',
    });
  });
});
