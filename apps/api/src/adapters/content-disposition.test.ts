import { describe, expect, it } from 'vitest';

import { contentDisposition, servedContentType } from './content-disposition.js';

describe('contentDisposition', () => {
  it('names the file in ASCII and exactly in UTF-8', () => {
    expect(contentDisposition('attachment', 'Pitch deck.pdf')).toBe(
      `attachment; filename="Pitch deck.pdf"; filename*=UTF-8''Pitch%20deck.pdf`,
    );
    expect(contentDisposition('inline', 'Café plan.md')).toBe(
      `inline; filename="Cafe plan.md"; filename*=UTF-8''Caf%C3%A9%20plan.md`,
    );
  });

  it('never lets a file name break out of the header value', () => {
    const header = contentDisposition('attachment', 'a"; filename=evil.html\r\nX-Injected: 1\\.md');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.split('"').length - 1).toBe(2);
    expect(header).toContain(`filename*=UTF-8''a%22%3B%20filename%3Devil.html%0D%0AX-Injected%3A%201%5C.md`);
  });

  it('falls back to a name when there is none', () => {
    expect(contentDisposition('inline', '   ')).toBe(
      `inline; filename="document"; filename*=UTF-8''document`,
    );
  });
});

describe('servedContentType', () => {
  it('serves text as UTF-8 and other types as stored', () => {
    expect(servedContentType('text/plain')).toBe('text/plain; charset=utf-8');
    expect(servedContentType('text/markdown')).toBe('text/markdown; charset=utf-8');
    expect(servedContentType('application/pdf')).toBe('application/pdf');
  });
});
