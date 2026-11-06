import { describe, expect, it, vi } from 'vitest';

import type { SpeechFetchResult } from './playback';
import { decodeBase64, pcmWav, TurnAudioFeed } from './turn-audio';
import { wavPayload } from './playback';

const TURN = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c02';
const unit = (seq: number) => ({ turnId: TURN, seq, text: 'Hi.', sig: 'sig' });
const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const frame = (
  seq: number,
  extra: { pcm?: number[]; sampleRate?: number; end?: 'done' | 'failed' | 'paused' },
) => ({
  event: 'turn.audio' as const,
  turnId: TURN,
  seq,
  ...(extra.pcm === undefined ? {} : { pcm: b64(extra.pcm) }),
  ...(extra.sampleRate === undefined ? {} : { sampleRate: extra.sampleRate }),
  ...(extra.end === undefined ? {} : { end: extra.end }),
});

async function readAll(body: ReadableStream<Uint8Array>): Promise<number[]> {
  const out: number[] = [];
  const reader = body.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) return out;
    out.push(...next.value);
  }
}

const never = () => Promise.reject(new Error('POST /speech was asked'));

describe('TurnAudioFeed', () => {
  it('hands over a unit’s PCM as a stream, the bytes before and after the ask, in order', async () => {
    const feed = new TurnAudioFeed();
    feed.expect(TURN, 0);
    feed.frame(frame(0, { pcm: [1, 2], sampleRate: 16_000 }));
    const taken = feed.take(unit(0), new AbortController().signal, { stream: true }, never);
    expect(taken).not.toBeNull();
    const result = (await taken) as Extract<SpeechFetchResult, { kind: 'stream' }>;
    expect(result.kind).toBe('stream');
    expect(result.sampleRate).toBe(16_000);
    feed.frame(frame(0, { pcm: [3] }));
    feed.frame(frame(0, { pcm: [4, 5] }));
    feed.frame(frame(0, { end: 'done' }));
    expect(await readAll(result.body)).toEqual([1, 2, 3, 4, 5]);
    // Taken once: asked again, it is not the feed's any more.
    expect(feed.take(unit(0), new AbortController().signal, { stream: true }, never)).toBeNull();
  });

  it('waits for a unit’s first audio when asked before it came', async () => {
    const feed = new TurnAudioFeed();
    feed.expect(TURN, 1);
    const taken = feed.take(unit(1), new AbortController().signal, { stream: true }, never);
    feed.frame(frame(1, { pcm: [9, 9], sampleRate: 24_000 }));
    feed.frame(frame(1, { end: 'done' }));
    const result = (await taken) as Extract<SpeechFetchResult, { kind: 'stream' }>;
    expect(await readAll(result.body)).toEqual([9, 9]);
  });

  it('is not the feed’s for a unit never announced with audio', () => {
    const feed = new TurnAudioFeed();
    expect(feed.take(unit(0), new AbortController().signal, { stream: true }, never)).toBeNull();
    expect(
      feed.take({ turnId: null, seq: 0, text: 'Intro.', sig: 's' }, new AbortController().signal, {}, never),
    ).toBeNull();
  });

  it('asks POST /speech for a unit the server could not voice, or whose stream closed first; pauses on a budget', async () => {
    const feed = new TurnAudioFeed();
    const fallback = vi.fn(() => Promise.resolve<SpeechFetchResult>({ kind: 'failed' }));
    feed.expect(TURN, 0);
    feed.expect(TURN, 1);
    feed.expect(TURN, 2);
    feed.frame(frame(0, { end: 'failed' }));
    feed.frame(frame(1, { end: 'paused' }));
    const signal = new AbortController().signal;
    await feed.take(unit(0), signal, { stream: true }, fallback);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(await feed.take(unit(1), signal, { stream: true }, fallback)).toEqual({ kind: 'paused' });
    const open = feed.take(unit(2), signal, { stream: true }, fallback);
    feed.closeTurn(TURN);
    await open;
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it('gives a player that decodes whole units the unit as a WAV', async () => {
    const feed = new TurnAudioFeed();
    feed.expect(TURN, 0);
    feed.frame(frame(0, { pcm: [1, 0, 2, 0], sampleRate: 24_000 }));
    feed.frame(frame(0, { end: 'done' }));
    const result = await feed.take(unit(0), new AbortController().signal, undefined, never);
    expect(result?.kind).toBe('audio');
    const data = (result as Extract<SpeechFetchResult, { kind: 'audio' }>).data;
    expect([...(wavPayload(data) ?? [])]).toEqual([1, 0, 2, 0]);
    expect(new DataView(data).getUint32(24, true)).toBe(24_000);
  });

  it('stops a unit when its ask is aborted, and drops everything on clear', async () => {
    const feed = new TurnAudioFeed();
    feed.expect(TURN, 0);
    const controller = new AbortController();
    const waiting = feed.take(unit(0), controller.signal, { stream: true }, never);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });

    feed.expect(TURN, 1);
    feed.frame(frame(1, { pcm: [1, 1], sampleRate: 24_000 }));
    const result = (await feed.take(
      unit(1),
      new AbortController().signal,
      { stream: true },
      never,
    )) as Extract<SpeechFetchResult, { kind: 'stream' }>;
    feed.clear();
    await expect(readAll(result.body)).rejects.toMatchObject({ name: 'AbortError' });
    // Frames after it are ignored.
    feed.frame(frame(1, { pcm: [2, 2] }));
    expect(feed.has(unit(1))).toBe(false);
  });

  it('decodes base64 and writes a PCM WAV', () => {
    expect([...decodeBase64(b64([0, 255, 7]))]).toEqual([0, 255, 7]);
    const wav = pcmWav(new Uint8Array([5, 6]), 16_000);
    expect(wav.byteLength).toBe(46);
    expect([...(wavPayload(wav) ?? [])]).toEqual([5, 6]);
  });
});
