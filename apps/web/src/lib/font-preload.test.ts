import { describe, expect, it } from 'vitest';

import { PLATFORM_FONT_URL, preloadPlatformFont, preloadsPlatformFont } from './font-preload';

describe('platform font preload', () => {
  it('preloads Inter on every page but the landing page', () => {
    expect(preloadsPlatformFont('/')).toBe(false);
    expect(preloadsPlatformFont('')).toBe(false);
    expect(preloadsPlatformFont('/sign-in')).toBe(true);
    expect(preloadsPlatformFont('/ain/app')).toBe(true);
  });

  it('writes one CORS-mode woff2 preload of Inter’s Latin file', () => {
    expect(PLATFORM_FONT_URL).toMatch(/inter-latin-wght-normal.*\.woff2$/);
    document.head.querySelectorAll('link[rel="preload"]').forEach((link) => {
      link.remove();
    });
    preloadPlatformFont('/ain/app');
    const links = [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="preload"]')];
    expect(links).toHaveLength(1);
    const [link] = links;
    expect(link?.as).toBe('font');
    expect(link?.type).toBe('font/woff2');
    expect(link?.crossOrigin).toBe('anonymous');
    expect(link?.getAttribute('href')).toBe(PLATFORM_FONT_URL);
  });

  it('adds nothing on the landing page', () => {
    document.head.querySelectorAll('link[rel="preload"]').forEach((link) => {
      link.remove();
    });
    preloadPlatformFont('/');
    expect(document.head.querySelectorAll('link[rel="preload"]')).toHaveLength(0);
  });
});
