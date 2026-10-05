/**
 * Heading-aware chunking for venture documents (system design §8): ~800 tokens per chunk, 15 % overlap
 * between consecutive chunks of the same section, never crossing a heading boundary (small sections are
 * merged forward so a document of short sections does not produce one chunk per heading).
 */

export interface ChunkOptions {
  /** Target size in estimated tokens (default 800). */
  readonly targetTokens?: number;
  /** Overlap ratio between consecutive chunks of a section (default 0.15). */
  readonly overlapRatio?: number;
  /** Hard cap on chunks (default 2000). */
  readonly maxChunks?: number;
}

export interface TextChunk {
  /** 1-based position in the document. */
  readonly ordinal: number;
  /** Heading path, e.g. "Findings › Pricing" (null before the first heading). */
  readonly heading: string | null;
  readonly content: string;
  readonly tokenCount: number;
}

export interface ChunkResult {
  readonly chunks: TextChunk[];
  /** True when `maxChunks` cut the document short. */
  readonly truncated: boolean;
}

/** Rough token estimate used for budgeting (≈ 4 characters per token). */
export function chunkTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface Section {
  heading: string | null;
  body: string[];
}

/* eslint-disable no-control-regex -- strips control characters from extracted text */
const CONTROL =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
/* eslint-enable no-control-regex */

/** Normalises extracted text: newlines, control/invisible characters, trailing spaces, blank-line runs. */
export function normalizeExtractedText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(CONTROL, '')
    .replace(/[ \u00A0]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const MD_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const SETEXT = /^(=+|-+)\s*$/;
const ALL_CAPS_HEADING = /^[A-Z][A-Z0-9 &/,'()-]{2,79}$/;

function splitSections(text: string): Section[] {
  const lines = text.split('\n');
  const sections: Section[] = [{ heading: null, body: [] }];
  const path: string[] = [];
  const startSection = (level: number, title: string): void => {
    path.length = Math.min(path.length, level - 1);
    path[level - 1] = title.replace(/\s+/g, ' ').trim().slice(0, 160);
    sections.push({ heading: path.filter((p) => p !== '').join(' › '), body: [] });
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const md = MD_HEADING.exec(line);
    if (md) {
      startSection(md[1]?.length ?? 1, md[2] ?? '');
      continue;
    }
    const next = lines[i + 1];
    const prev = i === 0 ? '' : (lines[i - 1] ?? '');
    if (
      next !== undefined &&
      SETEXT.test(next) &&
      line.trim() !== '' &&
      line.length <= 120 &&
      prev.trim() === ''
    ) {
      startSection(next.startsWith('=') ? 1 : 2, line);
      i += 1;
      continue;
    }
    const trimmed = line.trim();
    if (
      ALL_CAPS_HEADING.test(trimmed) &&
      /[A-Z]{3}/.test(trimmed) &&
      prev.trim() === '' &&
      (next === undefined || next.trim() === '')
    ) {
      startSection(Math.max(1, path.length === 0 ? 1 : path.length), trimmed);
      continue;
    }
    sections[sections.length - 1]?.body.push(line);
  }
  return sections
    .map((s) => ({ heading: s.heading, body: s.body.join('\n').trim() ? [s.body.join('\n').trim()] : [] }))
    .filter((s) => s.body.length > 0 || s.heading !== null);
}

/** Splits text into units no larger than `maxTokens`: paragraphs, then sentences, then word runs. */
function units(body: string, maxTokens: number): string[] {
  const out: string[] = [];
  for (const paragraph of body.split(/\n{2,}/)) {
    const para = paragraph.trim();
    if (para === '') continue;
    if (chunkTokens(para) <= maxTokens) {
      out.push(para);
      continue;
    }
    const sentences = para.match(/[^.!?\n]+(?:[.!?]+|\n|$)/g) ?? [para];
    for (const raw of sentences) {
      const sentence = raw.trim();
      if (sentence === '') continue;
      if (chunkTokens(sentence) <= maxTokens) {
        out.push(sentence);
        continue;
      }
      const words = sentence.split(/\s+/);
      let current: string[] = [];
      for (const word of words) {
        const candidate = [...current, word].join(' ');
        if (current.length > 0 && chunkTokens(candidate) > maxTokens) {
          out.push(current.join(' '));
          current = [];
        }
        // A single "word" longer than the budget (base64, URLs) is cut hard.
        if (chunkTokens(word) > maxTokens) {
          for (let i = 0; i < word.length; i += maxTokens * 4) out.push(word.slice(i, i + maxTokens * 4));
          continue;
        }
        current.push(word);
      }
      if (current.length > 0) out.push(current.join(' '));
    }
  }
  return out;
}

/** Trailing sentences of `text` within `maxTokens` (or its last words when one sentence is too long). */
function tailText(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  const sentences = text.match(/[^.!?\n]+(?:[.!?]+|\n|$)/g) ?? [text];
  const kept: string[] = [];
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    const sentence = (sentences[i] ?? '').trim();
    if (sentence === '') continue;
    if (chunkTokens([sentence, ...kept].join(' ')) > maxTokens) break;
    kept.unshift(sentence);
  }
  if (kept.length > 0) return kept.join(' ');
  const tail = text.slice(-maxTokens * 4);
  const space = tail.indexOf(' ');
  return (space > 0 && space < tail.length - 1 ? tail.slice(space + 1) : tail).trim();
}

/** Chunks normalised text. Deterministic: the same input always yields the same chunks. */
export function chunkText(text: string, options: ChunkOptions = {}): ChunkResult {
  const target = options.targetTokens ?? 800;
  const overlapTokens = Math.floor(target * (options.overlapRatio ?? 0.15));
  const maxChunks = options.maxChunks ?? 2_000;
  const normalized = normalizeExtractedText(text);
  if (normalized === '') return { chunks: [], truncated: false };

  // Small sections merge with small neighbours (never into a section that would overflow the target);
  // a merged section keeps the heading of its larger part and carries every heading line in its text.
  const merged: { heading: string | null; text: string }[] = [];
  const headingLine = (heading: string | null): string =>
    heading ? (heading.split(' › ').at(-1) ?? heading) : '';
  let pending: { heading: string | null; text: string; merged: boolean } | null = null;
  for (const section of splitSections(normalized)) {
    const body = section.body[0] ?? '';
    if (body === '') continue; // heading-only: its title lives on in the children's heading path
    if (pending !== null && chunkTokens(pending.text) + chunkTokens(body) <= target) {
      const pendingText: string = pending.merged
        ? pending.text
        : [headingLine(pending.heading), pending.text].filter(Boolean).join('\n\n');
      pending = {
        heading: chunkTokens(body) > chunkTokens(pending.text) ? section.heading : pending.heading,
        text: [pendingText, headingLine(section.heading), body].filter(Boolean).join('\n\n'),
        merged: true,
      };
    } else {
      if (pending !== null) merged.push(pending);
      pending = { heading: section.heading, text: body, merged: false };
    }
    if (chunkTokens(pending.text) >= target * 0.25) {
      merged.push(pending);
      pending = null;
    }
  }
  if (pending !== null) merged.push(pending);

  const chunks: TextChunk[] = [];
  let truncated = false;
  outer: for (const section of merged) {
    const sectionUnits = units(section.text, target);
    let current: string[] = [];
    let currentTokens = 0;
    const flush = (): boolean => {
      if (current.length === 0) return true;
      if (chunks.length >= maxChunks) {
        truncated = true;
        return false;
      }
      const content = current.join('\n\n');
      chunks.push({
        ordinal: chunks.length + 1,
        heading: section.heading,
        content,
        tokenCount: chunkTokens(content),
      });
      // Overlap: carry trailing units (≤ overlapTokens) into the next chunk of this section; when the last
      // unit alone is larger than the budget, carry its trailing sentences instead.
      const carry: string[] = [];
      let carryTokens = 0;
      for (let i = current.length - 1; i >= 0; i -= 1) {
        const unit = current[i] ?? '';
        const t = chunkTokens(unit);
        if (carryTokens + t > overlapTokens) {
          if (carry.length === 0) {
            const tail = tailText(unit, overlapTokens);
            if (tail !== '') {
              carry.unshift(tail);
              carryTokens += chunkTokens(tail);
            }
          }
          break;
        }
        carry.unshift(unit);
        carryTokens += t;
      }
      current = carry;
      currentTokens = carryTokens;
      return true;
    };
    let added = 0;
    for (const unit of sectionUnits) {
      const t = chunkTokens(unit);
      if (currentTokens + t > target && added > 0) {
        if (!flush()) break outer;
        added = 0;
      }
      current.push(unit);
      currentTokens += t;
      added += 1;
    }
    if (added > 0 && !flush()) break;
  }
  return { chunks, truncated };
}
