import { describe, expect, it } from 'vitest';

import { ReplyExtractor } from './reply-extract.js';

/** The stream cut into chunks of `size` characters (0: one chunk). */
function chunked(text: string, size: number): string[] {
  if (size === 0) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

interface Read {
  readonly text: string;
  readonly handed: string[];
  readonly shape: string | null;
  readonly done: boolean;
  readonly missing: boolean;
  /** Chunks pushed before the extractor said `done` (the caller stops the model there). */
  readonly pushedBeforeDone: number;
}

function read(stream: string, size: number): Read {
  const x = new ReplyExtractor();
  const handed: string[] = [];
  let pushed = 0;
  for (const chunk of chunked(stream, size)) {
    if (x.isDone()) break;
    pushed += 1;
    handed.push(x.push(chunk));
  }
  handed.push(x.end());
  return {
    text: x.text,
    handed: handed.filter((h) => h !== ''),
    shape: x.shape,
    done: x.isDone(),
    missing: x.missing,
    pushedBeforeDone: pushed,
  };
}

/** Every chunking gives the same reply. */
function readAll(stream: string): Read {
  const reads = [0, 1, 2, 3, 7, 16].map((size) => read(stream, size));
  for (const r of reads) {
    expect(r.text).toBe(reads[0]?.text);
    expect([r.shape, r.done, r.missing]).toEqual([reads[0]?.shape, reads[0]?.done, reads[0]?.missing]);
    expect(r.handed.join('')).toBe(r.text);
  }
  const [first] = reads;
  if (first === undefined) throw new Error('no reads');
  return first;
}

describe('ReplyExtractor', () => {
  it('passes prose through unchanged, as it arrives', () => {
    const prose =
      'Three interviews is a solid start.\n\n## Challenge\n\n**Challenge:** the counts.\n\nNext actions:\n- Call the library. Which one first?';
    expect(readAll(prose)).toMatchObject({ text: prose, shape: 'prose', done: false, missing: false });
    // The first sentence is handed on before the stream ends.
    const x = new ReplyExtractor();
    expect(x.push('Three interviews is a solid start. ')).toBe('Three interviews is a solid start. ');
    // Short prose is handed on when the stream ends.
    expect(readAll('Hi Sam!')).toMatchObject({ text: 'Hi Sam!', shape: 'prose' });
  });

  it('ends prose where the response’s other fields begin (production: the mode name, then the claims)', () => {
    const reply = 'Three interviews is a solid start. Which library first?\n\n';
    for (const rest of [
      'coach\nThe founder has a memory item about the advisor.\nThe venture has no pilot data.',
      'claims:\n- The founder has a memory item.',
      '**mode**: coach\n',
      '"claims": [{"text": "x"}]',
      'next_actions: none',
    ]) {
      const r = readAll(reply + rest);
      expect(r).toMatchObject({ text: reply, shape: 'prose', done: true });
    }
    // The extractor says `done` as soon as it can tell, so the caller stops the model before the rest.
    const leak = `${reply}coach\n${'The founder has a memory item. '.repeat(20)}`;
    expect(read(leak, 4).pushedBeforeDone).toBeLessThan(chunked(leak, 4).length / 2);
  });

  it('streams the answer field of a reply written as JSON and is done when the field ends', () => {
    const json =
      '{"mode": "coach", "answer": "Three interviews is a start.\\nWhich \\"library\\" first? Caf\\u00e9 \\ud83d\\ude00 a\\\\b", "claims": [{"text": "x", "kind": "fact", "evidence_ids": []}]}';
    expect(readAll(json)).toMatchObject({
      text: 'Three interviews is a start.\nWhich "library" first? Café 😀 a\\b',
      shape: 'json',
      done: true,
    });
    expect(readAll('```json\n{"answer": "Start with the door counts."}\n```')).toMatchObject({
      text: 'Start with the door counts.',
      shape: 'json',
      done: true,
    });
    // The reply is handed on while the field is still being written.
    const x = new ReplyExtractor();
    expect(x.push('{"mode": "coach", "answer": "Start with the door')).toBe('Start with the door');
    expect(x.isDone()).toBe(false);
    // Cut off mid-field (the token limit): what arrived is the reply.
    expect(readAll('{"answer": "Start with the door counts. Then')).toMatchObject({
      text: 'Start with the door counts. Then',
      done: false,
      missing: false,
    });
  });

  it('reads a labelled reply up to the next label, and prose after a mode line', () => {
    expect(
      readAll('mode: coach\nanswer: Three interviews is a start.\nWhich library first?\nclaims:\n- x'),
    ).toMatchObject({
      text: 'Three interviews is a start.\nWhich library first?\n',
      shape: 'labelled',
      done: true,
    });
    expect(
      readAll('**Mode:** coach\n**Answer:** Start with the door counts.\n**Claims:** none'),
    ).toMatchObject({ text: 'Start with the door counts.\n', done: true });
    expect(readAll('Answer: Start with the door counts. Then call the library.')).toMatchObject({
      text: 'Start with the door counts. Then call the library.',
      shape: 'labelled',
      done: false,
    });
    expect(readAll('"answer": "Start with the door counts. Then call the library."')).toMatchObject({
      text: 'Start with the door counts. Then call the library.',
      done: true,
    });
    expect(readAll('Mode: coach\n\nThree interviews is a solid start. Which library first?')).toMatchObject({
      text: 'Three interviews is a solid start. Which library first?',
      shape: 'labelled',
    });
    expect(readAll('<answer>Start with the door counts.</answer>\n<claims>x</claims>')).toMatchObject({
      text: 'Start with the door counts.',
      done: true,
    });
  });

  it('finds no reply in structured output without a reply field', () => {
    expect(readAll('{"mode": "coach", "claims": []}')).toMatchObject({
      text: '',
      shape: 'json',
      missing: true,
    });
    expect(readAll('mode: coach\nclaims:\n- x')).toMatchObject({ text: '', missing: true });
  });

  it('refuses a chunk after the end', () => {
    const x = new ReplyExtractor();
    x.end();
    expect(() => x.push('more')).toThrow(/after end/);
  });
});
