import { CoachMode } from '@foundry/contracts';

/**
 * The reply inside a streamed answer, read before the sentence gate sees it (phase A, `generate.ts`).
 *
 * Phase A asks for the reply as plain text, but the turn's rules above that request describe the whole
 * structured response, and the model sometimes writes it that way. In production the first turn of a call
 * without a replayed opener opened like structured output in both such calls (the conversation had no reply of
 * the vEIR's yet to follow), and the gate sent those turns down the whole-reply path: one structured call, the
 * call silent until it ended (9.5 s instead of about 4.4 s to the first words). Another reply went on past
 * its last sentence with the bare mode name and the claims, which the founder saw.
 *
 * So the stream is read here first:
 *  - prose passes through unchanged, until a line where the response's other fields begin (a bare lower-case
 *    mode name such as `coach`, or a field label such as `claims:`): the reply ends there (`isDone()`);
 *  - structured output (JSON, a code fence, an `<answer>` tag, `Answer:` / `Mode:` labels) yields the reply
 *    field's text as it streams (a JSON string decoded, a labelled block up to the next label), and the reply
 *    is done once that field ends;
 *  - structured output without a reply field yields nothing (`missing` once the stream ended): the caller
 *    writes the reply whole, as before.
 *
 * Everything handed on is still checked by the sentence gate and by the final validation.
 */

/** How the reply was written. */
export type ReplyShape = 'prose' | 'json' | 'labelled';

/** Characters of the opening needed to tell prose from structured output (as the sentence gate reads it). */
const OPENING_CHARS = 20;
/** An opening like structured output: a code fence, JSON, a tag, a field label. */
const STRUCTURED_OPENING =
  /^(?:```|\{|\[\s*[{[]|<\/?(?:answer|reply|response)\b|[*_]{0,2}"?(?:answer|spoken|reply|response|mode|claims|next_actions)"?[*_]{0,2}\s*:)/i;
const JSON_OPENING = /^(?:```|\{|\[)/;
const TAG_OPENING = /^<(answer|reply|response)\b[^>]*>/i;
/** The JSON key whose string value is the reply, up to the string's opening quote. */
const JSON_REPLY_KEY = /"(?:answer|reply|response|spoken)"\s*:\s*"/i;
/** A field label at the start of a line (`answer:`, `**Mode:**`, `"claims":`): the name and the whole label. */
const LABEL = /^[ \t]*[*_]{0,2}"?([A-Za-z_]+)"?[*_]{0,2}[ \t]*:[*_]{0,2}[ \t]*/;
const REPLY_LABELS: ReadonlySet<string> = new Set(['answer', 'reply', 'response', 'spoken']);
const FIELD_LABELS: ReadonlySet<string> = new Set([
  ...REPLY_LABELS,
  'mode',
  'claims',
  'next_actions',
  'uncertainty',
  'challenge',
  'escalation',
  'memory_candidates',
  'follow_up_questions',
  'rehearsal',
  'evidence_ids',
]);
/**
 * In prose, a line where the response's other fields begin: a field name as the schema writes it (lower case,
 * underscores) followed by a colon, or a bare lower-case mode name. Prose capitalises a line's first word and
 * names no field this way, so a reply's own lines ("Next actions:", "## Challenge") never match.
 */
const PROSE_FIELD_LINE =
  /^[ \t]*[*_]{0,2}"?(?:mode|claims|next_actions|uncertainty|escalation|memory_candidates|follow_up_questions|rehearsal|evidence_ids)"?[*_]{0,2}[ \t]*:/;
const PROSE_MODE_LINE = new RegExp(`^[ \\t]*(?:${CoachMode.options.join('|')})[ \\t]*[:.]?[ \\t]*$`);
/** Characters of a new line needed to tell whether it starts the response's other fields. */
const LINE_LOOKAHEAD = 24;

const JSON_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

type State =
  'opening' | 'prose' | 'json-seek' | 'json-string' | 'labelled-seek' | 'label-value' | 'labelled' | 'done';

export class ReplyExtractor {
  #state: State = 'opening';
  #shape: ReplyShape | null = null;
  /** Received and not yet handed on. */
  #pending = '';
  #text = '';
  #ended = false;
  /** Prose or a labelled block: `#pending` starts a line not yet known to belong to the reply. */
  #lineStart = false;
  /** Labelled seek: the last label was `mode` (one value), so a following unlabelled line is the reply. */
  #afterMode = false;
  /** The tag that closes an `<answer>` reply. */
  #closeTag: string | null = null;

  /** How the reply was written (null until the opening is known). */
  get shape(): ReplyShape | null {
    return this.#shape;
  }

  /** The reply handed on so far. */
  get text(): string {
    return this.#text;
  }

  /** The reply ended before the stream did: what follows is the response's other fields, not for the founder. */
  isDone(): boolean {
    return this.#state === 'done';
  }

  /** The stream ended as structured output with no reply in it. */
  get missing(): boolean {
    return this.#ended && this.#shape !== null && this.#shape !== 'prose' && this.#text.trim() === '';
  }

  /** Adds a chunk of the stream; returns the reply text it completes (possibly ''). */
  push(chunk: string): string {
    if (this.#ended) throw new Error('ReplyExtractor.push after end');
    if (this.#state === 'done') return '';
    this.#pending += chunk;
    return this.#hand(this.#run());
  }

  /** The stream ended: returns what is left of the reply. */
  end(): string {
    if (this.#ended) return '';
    this.#ended = true;
    if (this.#state === 'done') return '';
    return this.#hand(this.#run());
  }

  #hand(out: string): string {
    this.#text += out;
    return out;
  }

  #run(): string {
    let out = '';
    for (;;) {
      const before = `${this.#state}|${String(this.#pending.length)}`;
      switch (this.#state) {
        case 'opening':
          this.#opening();
          break;
        case 'prose':
          out += this.#lines(false);
          break;
        case 'json-seek':
          this.#seekJson();
          break;
        case 'json-string':
          out += this.#jsonString();
          break;
        case 'labelled-seek':
          this.#seekLabel();
          break;
        case 'label-value':
          this.#labelValue();
          break;
        case 'labelled':
          out += this.#closeTag === null ? this.#lines(true) : this.#tagged();
          break;
        case 'done':
          this.#pending = '';
          return out;
      }
      // Nothing more can be decided until more text arrives (or the stream ended).
      if (`${this.#state}|${String(this.#pending.length)}` === before) return out;
    }
  }

  #opening(): void {
    const opening = this.#pending.trimStart();
    if (STRUCTURED_OPENING.test(opening)) {
      // A tag is read whole (`<answer>`) before it is known what it opens.
      if (opening.startsWith('<') && !opening.includes('>') && !this.#ended) return;
      this.#pending = opening;
      const tag = TAG_OPENING.exec(opening);
      if (JSON_OPENING.test(opening)) {
        this.#shape = 'json';
        this.#state = 'json-seek';
      } else if (tag) {
        this.#shape = 'labelled';
        this.#closeTag = `</${(tag[1] ?? 'answer').toLowerCase()}>`;
        this.#pending = opening.slice(tag[0].length).trimStart();
        this.#state = 'labelled';
      } else {
        this.#shape = 'labelled';
        this.#state = 'labelled-seek';
      }
    } else if (opening.length >= OPENING_CHARS || this.#ended) {
      this.#shape = 'prose';
      this.#state = 'prose';
    }
  }

  /**
   * Hands on whole lines of the reply. A line is held at its start until it is known not to begin the other
   * fields (in prose: a field name or a bare mode name; in a labelled block: any field label).
   */
  #lines(labelled: boolean): string {
    let out = '';
    for (;;) {
      if (this.#lineStart) {
        const newline = this.#pending.indexOf('\n');
        const line = newline < 0 ? this.#pending : this.#pending.slice(0, newline);
        if (newline < 0 && line.length < LINE_LOOKAHEAD && !this.#ended) return out;
        const ends = labelled
          ? FIELD_LABELS.has((LABEL.exec(line)?.[1] ?? '').toLowerCase())
          : PROSE_FIELD_LINE.test(line) || PROSE_MODE_LINE.test(line);
        if (ends) {
          this.#state = 'done';
          return out;
        }
        this.#lineStart = false;
      }
      const newline = this.#pending.indexOf('\n');
      if (newline < 0) {
        out += this.#pending;
        this.#pending = '';
        return out;
      }
      out += this.#pending.slice(0, newline + 1);
      this.#pending = this.#pending.slice(newline + 1);
      this.#lineStart = true;
    }
  }

  /** An `<answer>` reply: everything up to its closing tag. */
  #tagged(): string {
    const close = this.#closeTag ?? '';
    const at = this.#pending.toLowerCase().indexOf(close);
    if (at >= 0) {
      const out = this.#pending.slice(0, at);
      this.#state = 'done';
      return out;
    }
    // Keep back what could be the start of the closing tag.
    const keep = this.#ended ? 0 : close.length - 1;
    const cut = Math.max(0, this.#pending.length - keep);
    const out = this.#pending.slice(0, cut);
    this.#pending = this.#pending.slice(cut);
    return out;
  }

  #seekJson(): void {
    const key = JSON_REPLY_KEY.exec(this.#pending);
    if (key === null) return;
    this.#pending = this.#pending.slice(key.index + key[0].length);
    this.#state = 'json-string';
  }

  /** The reply's JSON string, decoded as it arrives; the closing quote ends the reply. */
  #jsonString(): string {
    let out = '';
    let i = 0;
    const s = this.#pending;
    while (i < s.length) {
      const ch = s.charAt(i);
      if (ch === '"') {
        this.#state = 'done';
        return out;
      }
      if (ch !== '\\') {
        out += ch;
        i += 1;
        continue;
      }
      if (i + 1 >= s.length) break; // the escape is not complete yet
      const esc = s.charAt(i + 1);
      if (esc !== 'u') {
        out += JSON_ESCAPES[esc] ?? esc;
        i += 2;
        continue;
      }
      if (i + 6 > s.length) break;
      const code = Number.parseInt(s.slice(i + 2, i + 6), 16);
      if (Number.isNaN(code)) {
        i += 6;
        continue;
      }
      if (code >= 0xd800 && code <= 0xdbff) {
        // A surrogate pair is two escapes: wait for the second half.
        if (i + 12 > s.length) break;
        const low = s.slice(i + 6, i + 8) === '\\u' ? Number.parseInt(s.slice(i + 8, i + 12), 16) : NaN;
        if (low >= 0xdc00 && low <= 0xdfff) {
          out += String.fromCharCode(code, low);
          i += 12;
          continue;
        }
        i += 6;
        continue;
      }
      out += String.fromCharCode(code);
      i += 6;
    }
    this.#pending = s.slice(i);
    if (this.#ended) this.#pending = '';
    return out;
  }

  /** The reply label's value: a quoted string (`"answer": "…"`) is decoded like JSON, anything else read as text. */
  #labelValue(): void {
    const value = this.#pending.replace(/^[ \t]+/, '');
    if (value === '' && !this.#ended) return;
    if (value.startsWith('"')) {
      this.#pending = value.slice(1);
      this.#state = 'json-string';
    } else {
      this.#pending = value;
      this.#state = 'labelled';
    }
  }

  /**
   * Labels before the reply: a reply label starts it (the rest of its line is reply text); other fields' lines
   * are skipped, except that an unlabelled line right after `mode:` is the reply written without a label.
   */
  #seekLabel(): void {
    for (;;) {
      const newline = this.#pending.indexOf('\n');
      const line = newline < 0 ? this.#pending : this.#pending.slice(0, newline);
      const label = LABEL.exec(line);
      const name = (label?.[1] ?? '').toLowerCase();
      if (label && REPLY_LABELS.has(name)) {
        // The label may still be growing (`**Answer:` then `**`): wait for the first character after it.
        if (label[0].length === line.length && newline < 0 && !this.#ended) return;
        this.#pending = this.#pending.slice(label[0].length);
        this.#state = 'label-value';
        return;
      }
      if (newline < 0 && !this.#ended) return; // the line is not complete yet
      if (label && FIELD_LABELS.has(name)) {
        this.#afterMode = name === 'mode';
      } else if (this.#afterMode && line.trim() !== '') {
        this.#state = 'labelled';
        this.#lineStart = true;
        return;
      }
      if (newline < 0) {
        this.#pending = '';
        return;
      }
      this.#pending = this.#pending.slice(newline + 1);
    }
  }
}
