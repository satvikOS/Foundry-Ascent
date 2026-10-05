// Control characters other than tab/newline/carriage return, plus Unicode bidi overrides and
// zero-width characters that can hide text from human reviewers.
const UNSAFE_CHARS =
  // eslint-disable-next-line no-control-regex -- deliberately matches control characters
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/**
 * Escapes untrusted text for embedding inside the prompt's pseudo-XML data tags, so data can never
 * close a tag such as `</evidence>` or open a fake `<system>` section.
 */
export function escapeData(text: string): string {
  return text.replace(UNSAFE_CHARS, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Single-line, bounded, escaped value for attributes and header fields. */
export function escapeInline(text: string, maxChars: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  const bounded = single.length > maxChars ? `${single.slice(0, maxChars - 1)}…` : single;
  return escapeData(bounded).replace(/"/g, '&quot;');
}

/** Truncates at a word boundary when possible, appending an ellipsis. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut}…`;
}
