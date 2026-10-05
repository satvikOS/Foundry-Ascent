import { MAX_DOCUMENT_BYTES } from '@foundry/contracts';
import { type ExtractedText, ExtractionFailedError, type TextExtractor } from '@foundry/core';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';

type DocumentContentType = Parameters<TextExtractor['extract']>[1];

export interface DocumentTextExtractorOptions {
  /** Input size cap (10 MB, the upload limit). */
  readonly maxBytes?: number;
  /** PDFs with more pages are rejected (500). */
  readonly maxPages?: number;
  /** Extracted text is truncated beyond this many characters (2 M ≈ the chunker's 2 000-chunk cap). */
  readonly maxChars?: number;
  /** Wall-clock budget per document (60 s); a hostile file must not pin the worker. */
  readonly timeoutMs?: number;
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04 (DOCX is a zip package)

function startsWith(data: Uint8Array, magic: readonly number[], searchWithin = 0): boolean {
  for (let start = 0; start <= searchWithin && start + magic.length <= data.byteLength; start += 1) {
    if (magic.every((byte, i) => data[start + i] === byte)) return true;
  }
  return false;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

/**
 * Converts mammoth's semantic HTML to Markdown-ish text so the heading-aware chunker sees `#` headings:
 * headings → `#`…`######` lines, list items → `- `, table cells → ` | `, paragraphs → blank lines,
 * everything else → plain text.
 */
export function htmlToMarkdownText(html: string): string {
  const text = html
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
      const heading = decodeEntities(stripTags(inner)).replace(/\s+/g, ' ').trim();
      return heading === '' ? '\n\n' : `\n\n${'#'.repeat(Number(level))} ${heading}\n\n`;
    })
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(?:td|th)>/gi, ' | ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|tr|ul|ol|table|blockquote|div)>/gi, '\n\n');
  return decodeEntities(stripTags(text))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanText(text: string, maxChars: number): string {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const normalized = withoutBom.replaceAll(String.fromCharCode(0), '').replace(/\r\n?/g, '\n');
  return normalized.length > maxChars ? normalized.slice(0, maxChars) : normalized;
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new ExtractionFailedError('extraction timed out'));
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Text extraction for uploaded documents (core `TextExtractor` port): unpdf for PDF (text per page,
 * pages joined by blank lines), mammoth for DOCX (semantic HTML → Markdown headings, raw text as
 * fallback), UTF-8 for text/markdown. Corrupt, encrypted, oversized or over-long inputs throw
 * {@link ExtractionFailedError} (permanent; the document is marked failed).
 */
export class DocumentTextExtractor implements TextExtractor {
  readonly #maxBytes: number;
  readonly #maxPages: number;
  readonly #maxChars: number;
  readonly #timeoutMs: number;

  constructor(options: DocumentTextExtractorOptions = {}) {
    this.#maxBytes = options.maxBytes ?? MAX_DOCUMENT_BYTES;
    this.#maxPages = options.maxPages ?? 500;
    this.#maxChars = options.maxChars ?? 2_000_000;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
  }

  async extract(data: Uint8Array, contentType: DocumentContentType): Promise<ExtractedText> {
    if (data.byteLength > this.#maxBytes) throw new ExtractionFailedError('document exceeds the size limit');
    const text = await withTimeout(this.#extract(data, contentType), this.#timeoutMs);
    return { text: cleanText(text, this.#maxChars) };
  }

  async #extract(data: Uint8Array, contentType: DocumentContentType): Promise<string> {
    switch (contentType) {
      case 'text/plain':
      case 'text/markdown':
        return new TextDecoder('utf-8', { fatal: false }).decode(data);
      case 'application/pdf':
        return this.#pdf(data);
      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        return this.#docx(data);
    }
  }

  async #pdf(data: Uint8Array): Promise<string> {
    // Some generators prepend bytes before the header; PDF readers accept it within the first 1 KB.
    if (!startsWith(data, PDF_MAGIC, 1024)) throw new ExtractionFailedError('not a PDF file');
    let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
    try {
      // pdf.js may transfer (detach) the buffer it is given: hand it a copy. verbosity 0: errors only,
      // so parser warnings never reach the function logs.
      pdf = await getDocumentProxy(new Uint8Array(data), { verbosity: 0 });
    } catch (err) {
      throw new ExtractionFailedError('unreadable or encrypted PDF', { cause: err });
    }
    try {
      if (pdf.numPages > this.#maxPages) throw new ExtractionFailedError('PDF exceeds the page limit');
      const { text } = await extractText(pdf, { mergePages: false });
      return text
        .map((page) => page.trim())
        .filter((page) => page !== '')
        .join('\n\n');
    } catch (err) {
      if (err instanceof ExtractionFailedError) throw err;
      throw new ExtractionFailedError('PDF text extraction failed', { cause: err });
    } finally {
      await pdf.loadingTask.destroy().catch(() => undefined);
    }
  }

  async #docx(data: Uint8Array): Promise<string> {
    if (!startsWith(data, ZIP_MAGIC)) throw new ExtractionFailedError('not a DOCX file');
    const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    try {
      const html = await mammoth.convertToHtml(
        { buffer },
        {
          externalFileAccess: false,
          // Images carry no text; skip their base64 encoding entirely.
          convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: '' })),
        },
      );
      return htmlToMarkdownText(html.value);
    } catch {
      try {
        const raw = await mammoth.extractRawText({ buffer });
        return raw.value;
      } catch (err) {
        throw new ExtractionFailedError('unreadable DOCX file', { cause: err });
      }
    }
  }
}
