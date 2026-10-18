/**
 * Plays the vEIR's validated speech units in order through the call's one AudioContext.
 *
 * Each unit's audio comes from `POST /speech` (signed `turn.speech` units, the signed call intro, or a
 * passage of a completed turn's stored reply). Fetching is pipelined: while one unit plays, the next is
 * already being fetched and decoded. Playback runs source → gain (ducking on barge-in) → analyser (the
 * presence reacts to it) → speakers, so `stop()` silences at once.
 *
 * Calls speak only validated text. When the server cannot synthesise in this environment (`501
 * speech_unavailable`, local development), a development build may let the browser read the same validated
 * text, with a voice on this device only (`localService`): online browser voices send the text to a third
 * party and are not the vEIR's voice. Production builds pass no synthesis, so a 501 shows captions. Any
 * other failure shows the words without a voice ("captions only"), never a substitute voice: for
 * that unit alone when the failure may pass (a dropped connection, a busy synthesiser, audio that would not
 * decode), and for the rest of the call when the server refused the call's speech (kill switch, caps).
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
  /**
   * The unit's audio. For a call with a live face the server sends PCM in a WAV with its face-audio manifest:
   * the face may render exactly those bytes (docs/architecture/calls.md §4).
   */
  | { readonly kind: 'audio'; readonly data: ArrayBuffer; readonly faceManifest?: string }
  /** The server has no speech synthesis here (501); the browser may read validated text itself. */
  | { readonly kind: 'unavailable' }
  /** The server refused speech for this call (AI paused, caps reached, voice consent withdrawn). */
  | { readonly kind: 'refused' }
  /** This unit could not be voiced (network, a busy synthesiser, a unit the server would not voice). */
  | { readonly kind: 'failed' }
  /** This signed unit (or the intro) was already voiced for this call (409): shown, never asked for again. */
  | { readonly kind: 'played' }
  /** The call's or the day's speech budget is used up (429): words only for the rest of the call. */
  | { readonly kind: 'paused' };

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

/** Where a face plays the call's audio: the player's own input, so ducking and loudness work unchanged. */
export interface FaceRendererOutput {
  readonly context: PlayerAudio['context'];
  /** The player's gain (→ analyser → speakers). */
  readonly destination: AudioNode;
}

/**
 * A unit's audio as a face may render it: the PCM the server synthesized (the WAV's payload, 16-bit mono 24 kHz)
 * and the server's manifest of it. The face hands both back to the server, which relays them only if they match.
 */
export interface FaceUnitAudio {
  readonly pcm: Uint8Array;
  readonly manifest: string;
}

/** The PCM payload of a WAV (its `data` chunk), or null when the bytes are not a PCM WAV. */
export function wavPayload(data: ArrayBuffer): Uint8Array | null {
  const bytes = new Uint8Array(data);
  const text = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.byteLength < 12 || text(0) !== 'RIFF' || text(8) !== 'WAVE') return null;
  const view = new DataView(data);
  for (let offset = 12; offset + 8 <= bytes.byteLength;) {
    const size = view.getUint32(offset + 4, true);
    if (text(offset) === 'data') {
      return bytes.slice(offset + 8, Math.min(bytes.byteLength, offset + 8 + size));
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

export interface FaceRenderHandlers {
  /** The unit's first sound is heard (captions and the first-audio timing follow this, not the hand-over). */
  onStart(): void;
  /**
   * Heard to its end (`ended`), or the face could not make it heard (`failed`). A unit that failed before its
   * start is played by the call itself, so the founder never loses a sentence to the face.
   */
  onEnd(outcome: 'ended' | 'failed'): void;
}

/**
 * A face that makes the call's validated audio heard itself, lip-synced (voicing `audio`, docs/architecture/
 * calls.md §4): a vendor's speech-to-video over WebRTC, or the development stand-in. It only ever receives
 * audio this call already fetched from `POST /speech` (signed, validated units), never text to voice.
 */
export interface FaceRenderer {
  /** Whether it can take a unit now (connected, video flowing). Otherwise the call plays the unit itself. */
  ready(): boolean;
  /**
   * Makes one decoded unit heard; returns the function that stops it at once (barge-in, end). `audio` is what
   * the face may render (null for a unit the server did not give the face: it is played by the call itself).
   */
  render(
    buffer: AudioBuffer,
    output: FaceRendererOutput,
    handlers: FaceRenderHandlers,
    audio: FaceUnitAudio | null,
  ): () => void;
}

export interface PlayerEvents {
  /** A unit starts being heard (captions follow this), and how it is heard. */
  onUnitStart(unit: SpeechUnitToPlay, route: VoiceRoute): void;
  /** A unit finished (`completed` false when it was stopped part-way). */
  onUnitEnd(unit: SpeechUnitToPlay, completed: boolean): void;
  /** Nothing left to play. */
  onIdle(): void;
  /** The speech budget ran out: the rest of the call is words only (the UI says so once, calmly). */
  onVoicePaused?(): void;
}

type Prepared = (
  | { readonly kind: 'buffer'; readonly buffer: AudioBuffer; readonly face?: FaceUnitAudio }
  | { readonly kind: 'browser' }
  | { readonly kind: 'captions' }
) & {
  /** The way every later unit is heard from now on (set when the server answered for the whole call). */
  readonly sticky?: Exclude<VoiceRoute, 'server'>;
  /** Why the route became sticky captions, when the UI says something about it. */
  readonly why?: 'paused';
  /** Shown without a voice and without changing how the call says it is heard (an already played unit). */
  readonly quiet?: boolean;
};

interface Entry {
  readonly unit: SpeechUnitToPlay;
  controller: AbortController;
  prepared: Promise<Prepared> | null;
}

/** Units being fetched ahead of the one playing. */
const PREFETCH = 2;
/** Beyond a unit's own length, how long a face may take before the call counts the unit as heard. */
const FACE_GUARD_MS = 4_000;
/** Duck level while the founder may be barging in. */
const DUCK_GAIN = 0.2;

/**
 * An English voice the browser speaks with on this device (`localService`), or null. Online voices (Chrome's
 * "Google …" voices) send the text to a third party, so they are never used.
 */
export function localEnglishVoice(
  synthesis: Pick<SpeechSynthesis, 'getVoices'> | null,
): SpeechSynthesisVoice | null {
  if (synthesis === null) return null;
  return (
    synthesis.getVoices().find((voice) => voice.localService && voice.lang.toLowerCase().startsWith('en')) ??
    null
  );
}

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
  private face: FaceRenderer | null = null;

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

  /**
   * The face that renders the call's audio from now on (null: the speakers). A unit already playing finishes
   * where it started.
   */
  setFace(face: FaceRenderer | null): void {
    this.face = face;
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
    switch (result.kind) {
      case 'unavailable': {
        const route = localEnglishVoice(this.audio.synthesis) ? 'browser' : 'captions';
        return { kind: route, sticky: route };
      }
      case 'refused':
        return { kind: 'captions', sticky: 'captions' };
      case 'paused':
        return { kind: 'captions', sticky: 'captions', why: 'paused' };
      case 'played':
        // Heard already (a replayed unit): its caption shows, it is never asked for again.
        return { kind: 'captions', quiet: true };
      case 'failed':
        // This unit only: the next one asks for the voice again.
        return { kind: 'captions' };
      case 'audio': {
        // Copied before decoding (decodeAudioData takes the bytes): the face may render exactly these.
        const pcm = result.faceManifest === undefined ? null : wavPayload(result.data);
        const face =
          pcm === null || result.faceManifest === undefined ? null : { pcm, manifest: result.faceManifest };
        try {
          const buffer = await this.audio.context.decodeAudioData(result.data);
          return face === null ? { kind: 'buffer', buffer } : { kind: 'buffer', buffer, face };
        } catch {
          return { kind: 'captions' };
        }
      }
    }
  }

  private setRoute(route: Exclude<VoiceRoute, 'server'>): void {
    if (route === this.route) return;
    this.route = route;
    // Units already being fetched from the server are prepared again for the new route.
    for (const entry of this.queue) {
      entry.controller.abort();
      entry.controller = new AbortController();
      entry.prepared = null;
    }
  }

  private async playNext(): Promise<void> {
    const entry = this.queue[0];
    if (entry === undefined || this.disposed) return;
    const generation = this.generation;
    entry.prepared ??= this.prepare(entry);
    const prepared = await entry.prepared;
    if (generation !== this.generation || this.queue[0] !== entry) return;
    this.queue.shift();
    if (prepared.sticky) this.setRoute(prepared.sticky);
    if (prepared.why === 'paused') this.events.onVoicePaused?.();
    // A route change applies to everything after this unit too.
    this.prefetch();

    const route: VoiceRoute =
      prepared.kind === 'buffer' ? 'server' : prepared.quiet === true ? this.route : prepared.kind;
    const completed = await new Promise<boolean>((resolve) => {
      // A unit is announced when it starts being heard: at once here, or when a face reports its first sound
      // (never before `playing` is set, and never after it was stopped).
      // Set from `announce`, which the start may call before it returns.
      let announced = false;
      let wanted = false as boolean;
      let registered = false;
      const announce = () => {
        wanted = true;
        if (announced || !registered || generation !== this.generation) return;
        announced = true;
        this.events.onUnitStart(entry.unit, route);
      };
      const { stop, deferred } = this.start(prepared, entry.unit, resolve, announce);
      this.playing = { entry, stop };
      registered = true;
      if (!deferred || wanted) announce();
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

  /**
   * Starts making one unit heard; returns the function that stops it early, and whether the start is
   * `deferred` (a face announces its first sound through `started`).
   */
  private start(
    prepared: Prepared,
    unit: SpeechUnitToPlay,
    done: (completed: boolean) => void,
    started: () => void,
  ): { stop: () => void; deferred: boolean } {
    let settled = false;
    const settle = (completed: boolean) => {
      if (settled) return;
      settled = true;
      done(completed);
    };

    if (prepared.kind === 'buffer') {
      const face = this.face;
      if (face?.ready() === true) {
        return {
          stop: this.renderOnFace(face, prepared.buffer, prepared.face ?? null, settle, started),
          deferred: true,
        };
      }
      return { stop: this.playBuffer(prepared.buffer, settle), deferred: false };
    }
    return { stop: this.startWithoutAudio(prepared, unit, settle), deferred: false };
  }

  /** Plays decoded audio through the call's own path (gain → analyser → speakers). */
  private playBuffer(buffer: AudioBuffer, settle: (completed: boolean) => void): () => void {
    const source = this.audio.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    // A suspended context never ends its sources; the guard keeps the call from waiting forever.
    const guard = this.audio.setTimeout(
      () => {
        settle(true);
      },
      buffer.duration * 1000 + 1500,
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

  /**
   * Hands decoded audio to the face, which plays it into the player's gain in step with its video. A face that
   * fails before the unit's first sound gives it back: the call plays it itself, so no sentence is lost.
   */
  private renderOnFace(
    face: FaceRenderer,
    buffer: AudioBuffer,
    audio: FaceUnitAudio | null,
    settle: (completed: boolean) => void,
    started: () => void,
  ): () => void {
    let finished = false;
    let began = false;
    let fallback: (() => void) | null = null;
    const guard = this.audio.setTimeout(
      () => {
        finished = true;
        settle(true);
      },
      buffer.duration * 1000 + FACE_GUARD_MS,
    );
    const stopFace = face.render(
      buffer,
      { context: this.audio.context, destination: this.gain },
      {
        onStart: () => {
          if (finished || began) return;
          began = true;
          started();
        },
        onEnd: (outcome) => {
          if (finished) return;
          finished = true;
          this.audio.clearTimeout(guard);
          if (outcome === 'failed' && !began) {
            started();
            fallback = this.playBuffer(buffer, settle);
            return;
          }
          // A face that never reported the start still made the unit heard: announce it before its end.
          if (!began) started();
          settle(outcome === 'ended');
        },
      },
      audio,
    );
    return () => {
      finished = true;
      this.audio.clearTimeout(guard);
      stopFace();
      if (fallback) fallback();
      else settle(false);
    };
  }

  /** The browser's voice or captions only. */
  private startWithoutAudio(
    prepared: Prepared,
    unit: SpeechUnitToPlay,
    settle: (completed: boolean) => void,
  ): () => void {
    // Browser voice or captions only: a timer guards against a speech engine that never reports the end.
    const guard = this.audio.setTimeout(
      () => {
        settle(true);
      },
      prepared.kind === 'browser' ? readingTimeMs(unit.text) * 2 : readingTimeMs(unit.text),
    );
    const synthesis = this.audio.synthesis;
    const voice = prepared.kind === 'browser' ? localEnglishVoice(synthesis) : null;
    if (synthesis && voice) {
      const utterance = this.audio.createUtterance(unit.text);
      utterance.lang = 'en-US';
      utterance.voice = voice;
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
