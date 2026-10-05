import { describe, expect, it } from 'vitest';

import { isSafeLinkTarget, sanitizeMarkdown, sanitizePlainText } from './markdown.js';

describe('isSafeLinkTarget', () => {
  it.each([
    ['https://example.org/path?q=1', true],
    ['mailto:help@example.org', true],
    ['http://example.org', false],
    ['javascript:alert(1)', false],
    ['JaVaScRiPt:alert(1)', false],
    ['java\nscript:alert(1)', false],
    ['jav&#x61;script:alert(1)', false],
    ['&#106;avascript:alert(1)', false],
    ['javascript&colon;alert(1)', false],
    ['data:text/html;base64,PHNjcmlwdD4=', false],
    ['vbscript:msgbox', false],
    ['/relative/path', false],
    ['#anchor', false],
    ['https:', false],
    ['  https://example.org  ', true],
  ])('%s → %s', (url, safe) => {
    expect(isSafeLinkTarget(url)).toBe(safe);
  });
});

describe('sanitizeMarkdown', () => {
  it('keeps ordinary Markdown intact', () => {
    const md =
      '## Plan\n\n- **Test** pricing with 5 clinics\n- Compare `A < B` and 3 > 2\n\n[Guide](https://example.org/guide) [E1]';
    expect(sanitizeMarkdown(md)).toEqual({
      text: md,
      htmlRemoved: 0,
      unsafeLinksRemoved: 0,
      imagesRemoved: 0,
    });
  });

  it('removes script/style blocks with their content', () => {
    const out = sanitizeMarkdown(
      'Before<script type="text/javascript">steal()</script> after <style>body{}</style>end',
    );
    expect(out.text).toBe('Before after end');
    expect(out.htmlRemoved).toBe(2);
  });

  it('removes an unclosed script block to the end', () => {
    expect(sanitizeMarkdown('Safe text <script>evil()').text).toBe('Safe text');
  });

  it('strips tags, comments and declarations', () => {
    const out = sanitizeMarkdown(
      '<div onclick="x()">Hi</div> <!-- hidden --> <!DOCTYPE html><img src=x onerror=alert(1)>there',
    );
    expect(out.text).toBe('Hi  there');
    expect(out.htmlRemoved).toBeGreaterThanOrEqual(4);
  });

  it('replaces images with alt text', () => {
    const out = sanitizeMarkdown('Look ![a chart](https://evil.example/track.png) and ![ref][img]');
    expect(out.text).toBe('Look a chart and ref');
    expect(out.imagesRemoved).toBe(2);
  });

  it('replaces unsafe inline links with their label and keeps https links', () => {
    const out = sanitizeMarkdown(
      '[ok](https://a.example) [bad](javascript:alert(1)) [rel](/x) [t](https://b.example "title")',
    );
    expect(out.text).toBe('[ok](https://a.example) bad rel [t](https://b.example "title")');
    expect(out.unsafeLinksRemoved).toBe(2);
  });

  it('handles autolinks', () => {
    const out = sanitizeMarkdown('Visit <https://example.org> not <javascript:alert(1)>');
    expect(out.text).toBe('Visit https://example.org not');
    expect(out.unsafeLinksRemoved).toBe(1);
  });

  it('drops unsafe reference definitions', () => {
    const out = sanitizeMarkdown('See [x][1].\n\n[1]: javascript:alert(1)\n[2]: https://ok.example');
    expect(out.text).toBe('See [x][1].\n\n[2]: https://ok.example');
    expect(out.unsafeLinksRemoved).toBe(1);
  });

  it('neutralises bare script schemes and leftover tag openers', () => {
    const out = sanitizeMarkdown('Type javascript:alert(1) or <scr');
    expect(out.text).not.toMatch(/javascript\s*:/i);
    expect(out.text).not.toContain('<s');
  });

  it('removes control and bidi characters', () => {
    const rlo = String.fromCharCode(0x202e);
    const nul = String.fromCharCode(0);
    expect(sanitizeMarkdown(`a${rlo}b${nul}c`).text).toBe('abc');
  });
});

describe('sanitizePlainText', () => {
  it('strips tags and collapses spaces', () => {
    expect(sanitizePlainText('  <b>Bold</b>   text  ')).toEqual({ text: 'Bold text', changed: true });
    expect(sanitizePlainText('plain')).toEqual({ text: 'plain', changed: false });
  });
});
