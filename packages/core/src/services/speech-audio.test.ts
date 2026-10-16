import { describe, expect, it } from 'vitest';

import { observedAudio } from './speech-audio.js';

function source(chunks: string[], options: { failAfter?: number } = {}) {
  let i = 0;
  const state = { cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (options.failAfter !== undefined && i === options.failAfter) {
        controller.error(new Error('polly broke'));
        return;
      }
      const next = chunks[i];
      i += 1;
      if (next === undefined) controller.close();
      else controller.enqueue(new TextEncoder().encode(next));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe('observedAudio', () => {
  it('hands over the same bytes in order, marks the first chunk once and finishes the bookkeeping before it ends', async () => {
    const events: string[] = [];
    const { stream } = source(['ID3', 'frame1', 'frame2']);
    const audio = observedAudio(stream, {
      onFirstChunk: () => events.push('first'),
      beforeClose: async () => {
        await Promise.resolve();
        events.push('bookkeeping');
      },
    });
    expect(await readAll(audio)).toBe('ID3frame1frame2');
    expect(events).toEqual(['first', 'bookkeeping']);
  });

  it('still finishes the bookkeeping when the listener goes away or the source fails', async () => {
    const events: string[] = [];
    const cancelled = source(['a', 'b']);
    const audio = observedAudio(cancelled.stream, {
      beforeClose: () => Promise.resolve(void events.push('kept')),
    });
    const reader = audio.getReader();
    await reader.read();
    await reader.cancel('client gone');
    expect(cancelled.state.cancelled).toBe(true);
    expect(events).toEqual(['kept']);

    const failing = source(['a'], { failAfter: 1 });
    const broken = observedAudio(failing.stream, {
      beforeClose: () => Promise.resolve(void events.push('kept again')),
    });
    await expect(readAll(broken)).rejects.toThrow('polly broke');
    expect(events).toEqual(['kept', 'kept again']);
  });

  it('runs the bookkeeping once even when the end is reached twice', async () => {
    let runs = 0;
    const { stream } = source([]);
    const audio = observedAudio(stream, {
      beforeClose: () => {
        runs += 1;
        return Promise.resolve();
      },
    });
    await readAll(audio);
    await audio.cancel().catch(() => undefined);
    expect(runs).toBe(1);
  });
});
