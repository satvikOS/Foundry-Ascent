/**
 * Plays the vEIR's validated speech units in order through the call's one AudioContext.
 *
 * Each unit's audio comes from `POST /speech` (signed `turn.speech` units, the signed call intro, or a
 * passage of a completed turn's stored reply). Fetching is pipelined: while one unit plays, the next is
 * already being fetched and decoded. Playback runs source → gain (ducking on barge-in) → analyser (the
 * presence reacts to it) → speakers, so `stop()` silences at once.
 *
 * Calls speak only validated text. When the server cannot synthesise in this environment (`501
 * speech_unavailable`, local development), the browser's own `speechSynthesis` reads the same validated
 * text; any other failure shows the words without a voice ("captions only"), never a substitute voice.
 */

export interface SpeechUnitToPlay {
  /** Null for the call intro. */
  readonly turnId: string | null;
  readonly seq: number;
  readonly text: string;
  /** Server signature of a streamed unit or the intro; absent for a passage of a stored reply. */
  readonly sig?: string;
}

/** How a unit is heard. */
export type VoiceRoute = 'server' | 'browser' | 'captions';

export type SpeechFetchResult =
  | { readonly kind: 'audio'; readonly data: ArrayBuffer }
  /** The server has no speech synthesis here (501); the browser may read validated text itself. */
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed' };

export interface PlayerAudio {
  readonly context: Pick<
    AudioContext,
    'createGain' | 'createAnalyser' | 'createBufferSource' | 'decodeAudioData' | 'destination' | 'currentTime'
  >;
  fetchSpeech(unit: SpeechUnitToPlay, signal: AbortSignal): Promise<SpeechFetchResult>;
  /** The browser's speech synthesis, or null where there is none. */
  readonly synthesis: Pick<SpeechSynthesis, 'speak' | 'cancel' | 'getVoices'> | null;
  createUtterance(text: string): SpeechSynthesisUtterance;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface PlayerEvents {
  /** A unit starts being heard (captions follow this). */
  onUnitStart(unit: SpeechUnitToPlay, route: VoiceRoute): void;
  /** A unit finished (`completed` false when it was stopped part-way). */
  onUnitEnd(unit: SpeechUnitToPlay, completed: boolean): void;
  /** Nothing left to play. */
  onIdle(): void;
  /** The way units are heard changed for the rest of the call (browser voice, or captions only). */
  onRouteChange(route: VoiceRoute): void;
}

type Prepared =
  | { readonly kind: 'buffer'; readonly buffer: AudioBuffer }
  | { readonly kind: 'browser' }
  | { readonly kind: 'captions' };

interface Entry {
  readonly unit: SpeechUnitToPlay;
  controller: AbortController;
  prepared: Promise<Prepared> | null;
}

/** Units being fetched ahead of the one playing. */
const PREFETCH = 2;
/** Duck level while the founder may be barging in. */
const DUCK_GAIN = 0.2;

/** Time to read a unit shown without a voice, and the guard for a browser voice that never ends. */
export function readingTimeMs(text: string): number {
  return Math.min(12_000, 1_200 + text.length * 45);
}

export class SpeechPlayer {
  private readonly queue: Entry[] = [];
  private playing: { entry: Entry; stop: () => void } | null = null;
  private route: VoiceRoute = 'server';
  private readonly gain: GainNode;
  private readonly analyser: AnalyserNode;
  private readonly samples: Float32Array<ArrayBuffer>;
  private disposed = false;
  private generation = 0;

  constructor(
    private readonly audio: PlayerAudio,
    private readonly events: PlayerEvents,
  ) {
    const { context } = audio;
    this.gain = context.createGain();
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 512;
    this.samples = new Float32Array(this.analyser.fftSize);
    this.gain.connect(this.analyser);
    this.analyser.connect(context.destination);
  }

  get voice(): VoiceRoute {
    return this.route;
  }

  /** The unit being heard, if any. */
  get current(): SpeechUnitToPlay | null {
    return this.playing?.entry.unit ?? null;
  }

  get busy(): boolean {
    return this.playing !== null || this.queue.length > 0;
  }

  /** RMS of what is playing through the speakers (0–1). */
  level(): number {
    if (this.playing === null) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const s of this.samples) sum += s * s;
    return Math.sqrt(sum / this.samples.length);
  }

  enqueue(unit: SpeechUnitToPlay): void {
    if (this.disposed) return;
    this.queue.push({ unit, controller: new AbortController(), prepared: null });
    this.prefetch();
    if (this.playing === null) void this.playNext();
  }

  /** Stops at once and drops everything queued. */
  stop(): void {
    this.generation += 1;
    for (const entry of this.queue.splice(0)) entry.controller.abort();
    const playing = this.playing;
    this.playing = null;
    playing?.entry.controller.abort();
    playing?.stop();
    this.unduck();
  }

  /** Turns the vEIR down while a possible barge-in is confirmed. */
  duck(): void {
    this.gain.gain.setTargetAtTime(DUCK_GAIN, this.audio.context.currentTime, 0.01);
  }

  unduck(): void {
    this.gain.gain.setTargetAtTime(1, this.audio.context.currentTime, 0.05);
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
    try {
      this.gain.disconnect();
      this.analyser.disconnect();
    } catch {
      /* already disconnected */
    }
  }

  private prefetch(): void {
    for (const entry of this.queue.slice(0, PREFETCH)) {
      entry.prepared ??= this.prepare(entry);
    }
  }

  private async prepare(entry: Entry): Promise<Prepared> {
    if (this.route === 'browser') return { kind: 'browser' };
    if (this.route === 'captions') return { kind: 'captions' };
    let result: SpeechFetchResult;
    try {
      result = await this.audio.fetchSpeech(entry.unit, entry.controller.signal);
    } catch {
      result = { kind: 'failed' };
    }
    if (result.kind === 'unavailable') return { kind: this.audio.synthesis ? 'browser' : 'captions' };
    if (result.kind === 'failed') return { kind: 'captions' };
    try {
      return { kind: 'buffer', buffer: await this.audio.context.decodeAudioData(result.data) };
    } catch {
      return { kind: 'captions' };
    }
  }

  private setRoute(route: VoiceRoute): void {
    if (route === this.route || route === 'server') return;
    this.route = route;
    // Units already being fetched from the server are prepared again for the new route.
    for (const entry of this.queue) {
      entry.controller.abort();
      entry.controller = new AbortController();
      entry.prepared = null;
    }
    this.events.onRouteChange(route);
  }

  private async playNext(): Promise<void> {
    const entry = this.queue[0];
    if (entry === undefined || this.disposed) return;
    const generation = this.generation;
    entry.prepared ??= this.prepare(entry);
    const prepared = await entry.prepared;
    if (generation !== this.generation || this.queue[0] !== entry) return;
    this.queue.shift();
    if (prepared.kind !== 'buffer') this.setRoute(prepared.kind);
    // A route change applies to everything after this unit too.
    this.prefetch();

    const completed = await new Promise<boolean>((resolve) => {
      const finish = this.start(prepared, entry.unit, resolve);
      this.playing = { entry, stop: finish };
      this.events.onUnitStart(entry.unit, prepared.kind === 'buffer' ? 'server' : prepared.kind);
    });
    if (generation !== this.generation) {
      this.events.onUnitEnd(entry.unit, false);
      return;
    }
    this.playing = null;
    this.events.onUnitEnd(entry.unit, completed);
    if (this.queue.length > 0) void this.playNext();
    else this.events.onIdle();
  }

  /** Starts making one unit heard; returns the function that stops it early. */
  private start(prepared: Prepared, unit: SpeechUnitToPlay, done: (completed: boolean) => void): () => void {
    let settled = false;
    const settle = (completed: boolean) => {
      if (settled) return;
      settled = true;
      done(completed);
    };

    if (prepared.kind === 'buffer') {
      const source = this.audio.context.createBufferSource();
      source.buffer = prepared.buffer;
      source.connect(this.gain);
      // A suspended context never ends its sources; the guard keeps the call from waiting forever.
      const guard = this.audio.setTimeout(
        () => {
          settle(true);
        },
        prepared.buffer.duration * 1000 + 1500,
      );
      source.onended = () => {
        this.audio.clearTimeout(guard);
        settle(true);
      };
      source.start();
      return () => {
        this.audio.clearTimeout(guard);
        source.onended = null;
        try {
          source.stop();
        } catch {
          /* not started */
        }
        source.disconnect();
        settle(false);
      };
    }

    // Browser voice or captions only: a timer guards against a speech engine that never reports the end.
    const guard = this.audio.setTimeout(
      () => {
        settle(true);
      },
      prepared.kind === 'browser' ? readingTimeMs(unit.text) * 2 : readingTimeMs(unit.text),
    );
    const synthesis = this.audio.synthesis;
    if (prepared.kind === 'browser' && synthesis) {
      const utterance = this.audio.createUtterance(unit.text);
      utterance.lang = 'en-US';
      const english = synthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith('en'));
      if (english) utterance.voice = english;
      utterance.onend = () => {
        this.audio.clearTimeout(guard);
        settle(true);
      };
      utterance.onerror = () => {
        this.audio.clearTimeout(guard);
        settle(false);
      };
      synthesis.speak(utterance);
      return () => {
        this.audio.clearTimeout(guard);
        utterance.onend = null;
        utterance.onerror = null;
        synthesis.cancel();
        settle(false);
      };
    }
    return () => {
      this.audio.clearTimeout(guard);
      settle(false);
    };
  }
}
