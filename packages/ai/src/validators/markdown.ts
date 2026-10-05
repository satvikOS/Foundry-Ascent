/**
 * Markdown/plain-text sanitisation for model output. The web client must still render Markdown with
 * raw HTML disabled; this is defence in depth so stored responses are safe in any renderer
 * (exports, emails, EIR consoles).
 */

export interface SanitizeReport {
  text: string;
  /** Raw HTML tags, comments and script/style blocks removed. */
  htmlRemoved: number;
  /** Links whose target was not `https:` or `mailto:` (replaced by their text). */
  unsafeLinksRemoved: number;
  /** Images replaced by their alt text. */
  imagesRemoved: number;
}

// Control characters except tab/newline, plus bidi overrides and zero-width characters.
const UNSAFE_CHARS =
  // eslint-disable-next-line no-control-regex -- deliberately matches control characters
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  colon: ':',
  tab: '\t',
  newline: '\n',
  sol: '/',
  lpar: '(',
  rpar: ')',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  period: '.',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Whether a link target is allowed: absolute `https://` URLs and `mailto:` only. Entities,
 * percent-encoding tricks, whitespace and control characters are removed before the scheme check,
 * so `jav&#x61;script:` or `java\nscript:` are rejected.
 */
export function isSafeLinkTarget(url: string): boolean {
  let candidate = decodeEntities(url.trim());
  try {
    candidate = decodeURIComponent(candidate);
  } catch {
    // keep the raw candidate
  }
  // eslint-disable-next-line no-control-regex
  const compact = candidate.replace(/[\u0000- \u007F-\u009F]/g, '').toLowerCase();
  if (compact.startsWith('mailto:')) return /^mailto:[^@\s]+@[^@\s]+$/.test(compact);
  if (!compact.startsWith('https://')) return false;
  try {
    const parsed = new URL(candidate.trim());
    return parsed.protocol === 'https:' && parsed.hostname !== '';
  } catch {
    return false;
  }
}

const BLOCK_ELEMENTS =
  /<\s*(script|style|iframe|object|embed|svg|math|template|noscript|textarea|xmp|title)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const UNCLOSED_BLOCK = /<\s*(?:script|style|iframe|object|embed|svg|math|template|noscript)\b[\s\S]*$/gi;
const COMMENTS = /<!--[\s\S]*?(?:-->|$)/g;
const DECLARATIONS = /<[!?][^>]*>/g;
const AUTOLINK = /<((?:[a-z][a-z0-9+.-]{1,31}):[^\s<>]*)>/gi;
const TAG = /<\s*\/?\s*[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?\s*>/gi;
const IMAGE = /!\[([^\]\n]{0,500})\]\((?:[^()\n]|\([^()\n]*\))*\)/g;
const IMAGE_REF = /!\[([^\]\n]{0,500})\]\[[^\]\n]*\]/g;
const LINK =
  /\[([^\]\n]{0,1000})\]\(\s*<?((?:[^()\s<>]|\([^()\s]*\))*)>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)/g;
const REF_DEFINITION =
  /^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*<?(\S+?)>?(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*$/gm;
const BARE_SCRIPT_SCHEME = /\b(?:javascript|vbscript|livescript)\s*:/gi;

/** Removes raw HTML, images and unsafe links from model-authored Markdown. */
export function sanitizeMarkdown(input: string): SanitizeReport {
  let htmlRemoved = 0;
  let unsafeLinksRemoved = 0;
  let imagesRemoved = 0;
  let text = input.replace(/\r\n?/g, '\n').replace(UNSAFE_CHARS, '');

  text = text.replace(BLOCK_ELEMENTS, () => {
    htmlRemoved += 1;
    return '';
  });
  text = text.replace(UNCLOSED_BLOCK, () => {
    htmlRemoved += 1;
    return '';
  });
  text = text.replace(COMMENTS, () => {
    htmlRemoved += 1;
    return '';
  });
  text = text.replace(DECLARATIONS, () => {
    htmlRemoved += 1;
    return '';
  });
  text = text.replace(AUTOLINK, (_whole, target: string) => {
    if (isSafeLinkTarget(target)) return target;
    unsafeLinksRemoved += 1;
    return '';
  });
  text = text.replace(TAG, () => {
    htmlRemoved += 1;
    return '';
  });
  text = text.replace(IMAGE, (_whole, alt: string) => {
    imagesRemoved += 1;
    return alt;
  });
  text = text.replace(IMAGE_REF, (_whole, alt: string) => {
    imagesRemoved += 1;
    return alt;
  });
  text = text.replace(LINK, (whole, label: string, target: string) => {
    if (isSafeLinkTarget(target)) return whole;
    unsafeLinksRemoved += 1;
    return label;
  });
  text = text.replace(REF_DEFINITION, (whole, target: string) => {
    if (isSafeLinkTarget(target)) return whole;
    unsafeLinksRemoved += 1;
    return '';
  });
  text = text.replace(BARE_SCRIPT_SCHEME, () => {
    unsafeLinksRemoved += 1;
    return '';
  });
  // Any `<` that still opens something tag-like is neutralised; comparisons such as `a < b` stay.
  text = text.replace(/<(?=[a-z!/?])/gi, '‹');

  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), htmlRemoved, unsafeLinksRemoved, imagesRemoved };
}

/** Plain-text fields (claims, actions, questions…): control characters and HTML tags removed. */
export function sanitizePlainText(input: string): { text: string; changed: boolean } {
  let text = input.replace(/\r\n?/g, '\n').replace(UNSAFE_CHARS, '');
  text = text.replace(BLOCK_ELEMENTS, '').replace(COMMENTS, '').replace(DECLARATIONS, '').replace(TAG, '');
  text = text
    .replace(/<(?=[a-z!/?])/gi, '‹')
    .replace(/[ \t]+/g, ' ')
    .trim();
  return { text, changed: text !== input.trim() };
}
