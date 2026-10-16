import { type DocumentContentType } from '@foundry/contracts';
import { type z } from 'zod';

/**
 * `Content-Disposition` for a stored document (RFC 6266 / RFC 8187): a plain ASCII `filename` for old
 * clients and the exact name as UTF-8 in `filename*`. Quotes, backslashes, control and non-ASCII characters
 * never reach the plain form, so a file name cannot break out of the header value.
 */
export function contentDisposition(disposition: 'inline' | 'attachment', filename: string): string {
  const name = filename.normalize('NFC').trim() || 'document';
  const ascii =
    name
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .replace(/[^\x20-\x7E]+/g, '_')
      .replace(/["\\]/g, '_')
      .slice(0, 150) || 'document';
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** The type a stored document is served as: text is always UTF-8 (the extractor reads it as UTF-8 too). */
export function servedContentType(contentType: z.infer<typeof DocumentContentType>): string {
  return contentType.startsWith('text/') ? `${contentType}; charset=utf-8` : contentType;
}
