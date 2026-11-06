/**
 * The audio of a spoken turn's units, voiced by the server inside the turn's own stream (docs/runbooks/latency.md):
 * a turn asked with `speechAudio: 'pcm'` announces each unit the server voices with `turn.speech` `audio: true` and
 * sends its PCM as `turn.audio` frames (base64, its rate on the first, a closing frame). This keeps each such unit's
 * bytes until the player asks for its audio, and hands them over as `POST /speech` would have (raw PCM still arriving),
 * so the player, its jitter buffer and a LITE face fed from it are unchanged, with no request on the way to the first
 * sound. A unit the server did not voice, or could not (`end: failed`, `refused`, or a stream that closed before its
 * closing frame), is asked from `POST /speech` as before; a used-up speech budget (`paused`) pauses the voice as
 * `POST /speech` would.
 */
import type { TurnStreamEventT } from '../api/sse';
import type { SpeechFetchOptions, SpeechFetchResult, SpeechUnitToPlay } from './playback';

type AudioFrame = Extract<TurnStreamEventT, { event: 'turn.audio' }>;
type AudioEnd = NonNullable<AudioFrame['end']>;

/** The rate of a unit whose first frame did not say (ElevenLabs' `pcm_24000`). */
const DEFAULT_RATE = 24_000;

interface UnitAudio {
  /** Bytes received before the player asked for the unit. */
  chunks: Uint8Array[];
  /** The stream handed to the player, while it is open. */
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  sampleRate: number | null;
  end: AudioEnd | null;
  /** Woken by the first audio or the end. */
  waiters: (() => void)[];
  taken: boolean;
}

function keyOf(turnId: string, seq: number): string {
  return `${turnId.toLowerCase()}:${String(seq)}`;
}

/** Base64 → bytes. */
export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 16-bit mono little-endian PCM in a WAV container (a player that decodes whole units). */
export function pcmWav(pcm: Uint8Array, sampleRate: number): ArrayBuffer {
  const out = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(out);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  new Uint8Array(out, 44).set(pcm);
  return out;
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

export class TurnAudioFeed {
  private readonly units = new Map<string, UnitAudio>();

  /** A unit announced with `audio: true`: its frames follow in the turn's stream. */
  expect(turnId: string, seq: number): void {
    const key = keyOf(turnId, seq);
    if (this.units.has(key)) return;
    this.units.set(key, {
      chunks: [],
      controller: null,
      sampleRate: null,
      end: null,
      waiters: [],
      taken: false,
    });
  }

  /** Whether the unit's audio comes from the turn's stream. */
  has(unit: Pick<SpeechUnitToPlay, 'turnId' | 'seq'>): boolean {
    return unit.turnId !== null && this.units.has(keyOf(unit.turnId, unit.seq));
  }

  /** One `turn.audio` frame (frames of a unit not expected, or dropped, are ignored). */
  frame(event: AudioFrame): void {
    const key = keyOf(event.turnId, event.seq);
    const unit = this.units.get(key);
    if (unit?.end !== null) return;
    if (event.pcm !== undefined && event.pcm !== '') {
      let bytes: Uint8Array;
      try {
        bytes = decodeBase64(event.pcm);
      } catch {
        bytes = new Uint8Array(0);
      }
      unit.sampleRate ??= event.sampleRate ?? DEFAULT_RATE;
      if (bytes.byteLength > 0) {
        if (unit.controller !== null) unit.controller.enqueue(bytes);
        else unit.chunks.push(bytes);
      }
    }
    if (event.end !== undefined) this.finish(key, unit, event.end);
    this.wake(unit);
  }

  /** The turn's stream ended: its units still open never get more audio (asked from `POST /speech` if none came). */
  closeTurn(turnId: string): void {
    const prefix = `${turnId.toLowerCase()}:`;
    for (const [key, unit] of this.units) {
      if (!key.startsWith(prefix) || unit.end !== null) continue;
      this.finish(key, unit, unit.sampleRate === null ? 'failed' : 'done');
      this.wake(unit);
    }
  }

  /** Forgets everything (barge-in, a new turn, the end of the call): open streams stop. */
  clear(): void {
    for (const unit of this.units.values()) {
      try {
        unit.controller?.error(abortError());
      } catch {
        /* already closed */
      }
      unit.controller = null;
      unit.end ??= 'failed';
      this.wake(unit);
    }
    this.units.clear();
  }

  /**
   * The unit's audio as `POST /speech` would answer it, when it comes from the turn's stream (else null: ask
   * `POST /speech`). `fallback` asks `POST /speech` for a unit the server could not voice in the stream.
   */
  take(
    unit: SpeechUnitToPlay,
    signal: AbortSignal,
    options: SpeechFetchOptions | undefined,
    fallback: () => Promise<SpeechFetchResult>,
  ): Promise<SpeechFetchResult> | null {
    if (unit.turnId === null) return null;
    const key = keyOf(unit.turnId, unit.seq);
    const entry = this.units.get(key);
    if (entry === undefined || entry.taken) return null;
    entry.taken = true;
    return this.deliver(key, entry, signal, options, fallback);
  }

  private async deliver(
    key: string,
    entry: UnitAudio,
    signal: AbortSignal,
    options: SpeechFetchOptions | undefined,
    fallback: () => Promise<SpeechFetchResult>,
  ): Promise<SpeechFetchResult> {
    // The first audio, or the unit's end.
    while (entry.sampleRate === null && entry.end === null && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const done = () => {
          signal.removeEventListener('abort', done);
          resolve();
        };
        entry.waiters.push(done);
        signal.addEventListener('abort', done, { once: true });
      });
    }
    if (signal.aborted) {
      this.drop(key, entry);
      throw abortError();
    }
    if (entry.sampleRate === null) {
      this.units.delete(key);
      return entry.end === 'paused' ? { kind: 'paused' } : fallback();
    }
    const sampleRate = entry.sampleRate;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (const chunk of entry.chunks) controller.enqueue(chunk);
        entry.chunks = [];
        if (entry.end !== null) {
          controller.close();
          this.units.delete(key);
        } else entry.controller = controller;
      },
      cancel: () => {
        this.drop(key, entry);
      },
    });
    signal.addEventListener(
      'abort',
      () => {
        try {
          entry.controller?.error(abortError());
        } catch {
          /* closed */
        }
        this.drop(key, entry);
      },
      { once: true },
    );
    if (options?.stream === true) return { kind: 'stream', body, sampleRate };
    // A player that decodes whole units (a face that renders whole audio): the unit's PCM as a WAV, once it all came.
    const parts: Uint8Array[] = [];
    let length = 0;
    const reader = body.getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      parts.push(next.value);
      length += next.value.byteLength;
    }
    const pcm = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      pcm.set(part, offset);
      offset += part.byteLength;
    }
    return { kind: 'audio', data: pcmWav(pcm, sampleRate) };
  }

  private finish(key: string, unit: UnitAudio, end: AudioEnd): void {
    unit.end = end;
    if (unit.controller !== null) {
      try {
        unit.controller.close();
      } catch {
        /* errored */
      }
      unit.controller = null;
      this.units.delete(key);
    }
  }

  private drop(key: string, unit: UnitAudio): void {
    unit.controller = null;
    unit.end ??= 'failed';
    if (this.units.get(key) === unit) this.units.delete(key);
  }

  private wake(unit: UnitAudio): void {
    const waiters = unit.waiters;
    unit.waiters = [];
    for (const wake of waiters) wake();
  }
}
