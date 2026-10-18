/**
 * Reasoning a model writes into its visible text instead of keeping it apart. Amazon Nova thinks inside
 * `<thinking>…</thinking>` when it reasons in the open (the tag Amazon documents for Nova's chain of thought);
 * other reasoning models use `<think>` or `<reasoning>`. None of it is ever part of an answer, and on a call it
 * would be spoken (production, LAB-M1: "Okay, let's see. The founder says… First, I need to figure out the mode").
 *
 * {@link ReasoningFilter} drops every such block from a stream as it arrives, holding back only as much text as
 * could still be the start of a tag; a block that never closes drops the rest of the stream. Reasoning the model
 * writes without tags is not recognisable here: the sentence gate and the final validator cut it
 * (validators/meta-narration.ts).
 */

const OPEN_TAG = /^<(thinking|think|reasoning)(?:\s[^<>]{0,200})?>/i;
/** The longest opening tag a partial `<…` could still grow into (attributes included). */
const MAX_OPEN_TAG_CHARS = 220;
const TAG_NAMES = ['thinking', 'think', 'reasoning'] as const;

/** Whether `text` (starting with `<`) could still become a reasoning tag once more text arrives. */
function couldOpen(text: string): boolean {
  if (text.length > MAX_OPEN_TAG_CHARS || text.includes('>')) return false;
  const name = /^<([a-z]*)/i.exec(text)?.[1]?.toLowerCase() ?? '';
  const rest = text.slice(1 + name.length);
  if (rest !== '' && !/^\s/.test(rest)) return false;
  return TAG_NAMES.some((tag) => (rest === '' ? tag.startsWith(name) : tag === name));
}

export class ReasoningFilter {
  #pending = '';
  /** The closing tag of the block being dropped, or null outside one. */
  #close: string | null = null;
  #dropped = 0;
  #ended = false;
  /** A block just ended: the whitespace after it (which may arrive in later chunks) is dropped with it. */
  #afterBlock = false;

  /** Characters of reasoning dropped so far (for metering and notes; never the text itself). */
  get dropped(): number {
    return this.#dropped;
  }

  /** Adds a chunk of the stream; returns the visible text it completes (possibly ''). */
  push(chunk: string): string {
    if (this.#ended) throw new Error('ReasoningFilter.push after end');
    this.#pending += chunk;
    return this.#run();
  }

  /** The stream ended: returns what is left of the visible text (an unfinished block is dropped). */
  end(): string {
    if (this.#ended) return '';
    this.#ended = true;
    return this.#run();
  }

  #run(): string {
    let out = '';
    for (;;) {
      if (this.#close !== null) {
        const at = this.#pending.toLowerCase().indexOf(this.#close);
        if (at < 0) {
          // Keep back what could be the start of the closing tag.
          const keep = this.#ended ? 0 : this.#close.length - 1;
          const cut = Math.max(0, this.#pending.length - keep);
          this.#dropped += cut;
          this.#pending = this.#pending.slice(cut);
          if (this.#ended) {
            this.#dropped += this.#pending.length;
            this.#pending = '';
          }
          return out;
        }
        this.#dropped += at + this.#close.length;
        this.#pending = this.#pending.slice(at + this.#close.length);
        this.#close = null;
        this.#afterBlock = true;
        continue;
      }
      if (this.#afterBlock) {
        const rest = this.#pending.replace(/^\s+/, '');
        this.#dropped += this.#pending.length - rest.length;
        this.#pending = rest;
        if (rest === '') return out;
        this.#afterBlock = false;
      }
      const lt = this.#pending.indexOf('<');
      if (lt < 0) {
        out += this.#pending;
        this.#pending = '';
        return out;
      }
      out += this.#pending.slice(0, lt);
      this.#pending = this.#pending.slice(lt);
      const open = OPEN_TAG.exec(this.#pending);
      if (open) {
        this.#dropped += open[0].length;
        this.#close = `</${(open[1] ?? 'thinking').toLowerCase()}>`;
        this.#pending = this.#pending.slice(open[0].length);
        continue;
      }
      if (!this.#ended && couldOpen(this.#pending)) return out;
      // Not a reasoning tag (a "<" in prose, another tag the Markdown subset deals with): hand it on.
      out += '<';
      this.#pending = this.#pending.slice(1);
    }
  }
}

/** `text` without its reasoning blocks (see {@link ReasoningFilter}). */
export function stripReasoning(text: string): string {
  const filter = new ReasoningFilter();
  return filter.push(text) + filter.end();
}
