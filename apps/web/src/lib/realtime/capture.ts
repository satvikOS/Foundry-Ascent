/**
 * The microphone side of a call: getUserMedia (echo cancellation, noise suppression and auto gain on), a
 * MediaStreamSource in the call's one AudioContext, and the `pcm-capture` AudioWorklet that hands back
 * 16 kHz PCM frames with their RMS level. The worklet is a static file under `/worklets/`, so the strict
 * CSP (`script-src 'self'`) needs no blob: URLs.
 */

export const CAPTURE_WORKLET_URL = '/worklets/pcm-capture.js';
export const CAPTURE_PROCESSOR = 'pcm-capture';
export const STT_SAMPLE_RATE = 16_000;
export const FRAME_MS = 50;

export type MicFailure = 'denied' | 'unavailable';

export class MicrophoneError extends Error {
  override readonly name = 'MicrophoneError';
  constructor(readonly reason: MicFailure) {
    super(reason === 'denied' ? 'Microphone access was blocked' : 'No microphone is available');
  }
}

/** The pieces of Web Audio capture uses (real browser objects in the app, fakes in tests). */
export interface CaptureAudio {
  readonly context: Pick<AudioContext, 'createMediaStreamSource' | 'createGain' | 'destination'> & {
    readonly audioWorklet: Pick<AudioWorklet, 'addModule'>;
  };
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createWorkletNode(name: string, options: AudioWorkletNodeOptions): AudioWorkletNode;
  /** The browser's `devicechange` (a microphone plugged in or out); returns how to stop listening. */
  readonly watchDevices?: ((listener: () => void) => () => void) | null | undefined;
}

export type FrameListener = (pcm: Int16Array, rms: number) => void;

/**
 * What became of the microphone: unplugged or its permission revoked (`ended`), or silenced at the source
 * by the system, another app or the hardware (`muted`, until `unmuted`). Muting the call itself never shows
 * here: it disables the track, which the browser does not report.
 */
export type TrackChange = 'ended' | 'muted' | 'unmuted';
export type TrackListener = (change: TrackChange) => void;

/** The parts of a MediaStreamTrack capture watches (a real track in the app, a fake in tests). */
type WatchedTrack = Pick<MediaStreamTrack, 'readyState' | 'muted'> &
  Partial<Pick<MediaStreamTrack, 'addEventListener' | 'removeEventListener'>>;

/** Asks for the microphone; a refusal or a missing device becomes a MicrophoneError. */
export async function requestMicrophone(getUserMedia: CaptureAudio['getUserMedia']): Promise<MediaStream> {
  try {
    return await getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    throw new MicrophoneError(
      name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError'
        ? 'denied'
        : 'unavailable',
    );
  }
}

const loadedModules = new WeakSet<object>();

export class MicCapture {
  private listener: FrameListener | null = null;
  private trackListener: TrackListener | null = null;
  private stopped = false;
  /** `ended` was reported (once: a device change re-checks every track). */
  private ended = false;
  private readonly unwatch: (() => void)[] = [];

  private constructor(
    private readonly stream: MediaStream,
    private readonly nodes: { source: AudioNode; worklet: AudioWorkletNode; sink: GainNode },
    watchDevices: CaptureAudio['watchDevices'],
  ) {
    nodes.worklet.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
      if (this.stopped || !this.listener) return;
      const { pcm, rms } = event.data;
      this.listener(new Int16Array(pcm), rms);
    };
    // A microphone that goes away mid-call would otherwise go on "listening" to silence.
    for (const track of this.tracks()) {
      for (const [type, change] of [
        ['ended', 'ended'],
        ['mute', 'muted'],
        ['unmute', 'unmuted'],
      ] as const) {
        const report = () => {
          this.report(change);
        };
        if (typeof track.addEventListener !== 'function') continue;
        track.addEventListener(type, report);
        this.unwatch.push(() => track.removeEventListener?.(type, report));
      }
    }
    // Some browsers end a removed device's track late or without the event: a device change checks it.
    if (watchDevices) {
      this.unwatch.push(
        watchDevices(() => {
          if (this.tracks().some((track) => track.readyState === 'ended')) this.report('ended');
        }),
      );
    }
  }

  /** Connects an already granted stream to the capture worklet. */
  static async start(audio: CaptureAudio, stream: MediaStream): Promise<MicCapture> {
    const { context } = audio;
    if (!loadedModules.has(context)) {
      await context.audioWorklet.addModule(CAPTURE_WORKLET_URL);
      loadedModules.add(context);
    }
    const source = context.createMediaStreamSource(stream);
    const worklet = audio.createWorkletNode(CAPTURE_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: { targetSampleRate: STT_SAMPLE_RATE, frameMs: FRAME_MS },
    });
    // A silent sink keeps the worklet in the rendering graph in every browser without playing the mic.
    const sink = context.createGain();
    sink.gain.value = 0;
    source.connect(worklet);
    worklet.connect(sink);
    sink.connect(context.destination);
    return new MicCapture(stream, { source, worklet, sink }, audio.watchDevices);
  }

  onFrame(listener: FrameListener | null): void {
    this.listener = listener;
  }

  /** Hears when the microphone is unplugged or silenced at its source (see TrackChange). */
  onTrackChange(listener: TrackListener | null): void {
    this.trackListener = listener;
  }

  /** The source delivers silence whatever is said (muted by the system, not by the call). */
  get sourceMuted(): boolean {
    return this.tracks().some((track) => track.muted);
  }

  private tracks(): WatchedTrack[] {
    return this.stream.getAudioTracks();
  }

  private report(change: TrackChange): void {
    if (this.stopped || this.ended) return;
    if (change === 'ended') this.ended = true;
    this.trackListener?.(change);
  }

  /** Mutes at the source (the track delivers silence); the browser keeps its microphone indicator on. */
  setEnabled(enabled: boolean): void {
    for (const track of this.stream.getAudioTracks()) track.enabled = enabled;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.listener = null;
    this.trackListener = null;
    for (const unwatch of this.unwatch.splice(0)) unwatch();
    this.nodes.worklet.port.onmessage = null;
    for (const node of [this.nodes.source, this.nodes.worklet, this.nodes.sink]) {
      try {
        node.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    for (const track of this.stream.getTracks()) track.stop();
  }
}
