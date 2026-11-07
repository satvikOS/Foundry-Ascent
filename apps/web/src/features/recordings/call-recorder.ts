import { RECORDING_LIMITS, type RecordingMimeType } from '@foundry/contracts';

/*
 * Records a call as the founder experiences it (ADR-0023), in the browser, without a screen picker:
 *
 *   picture  one canvas, redrawn about 24 times a second: the vEIR's face while it shows (its video element, labelled
 *            "AI avatar" as on the call tile), otherwise the call's presence (a sphere that follows the vEIR's voice,
 *            with its name), so switching between voice and video mid-recording never changes the recorded track
 *   sound    a WebAudio mix on the call's own AudioContext: the vEIR's voice as the speakers get it, a vendor face's
 *            voice from its element, and the founder's microphone (silent while muted)
 *
 * MediaRecorder encodes both into the container the browser supports (webm on Chromium and Firefox, mp4 on Safari),
 * or sound only where a canvas cannot be captured. Everything stays in this page's memory until it is saved.
 */

/** The browser objects a recording needs (real ones in the app, fakes in tests). */
export interface RecorderBrowser {
  readonly MediaRecorder: typeof MediaRecorder | undefined;
  createCanvas(width: number, height: number): HTMLCanvasElement;
  createStream(tracks: MediaStreamTrack[]): MediaStream;
  /** A muted, inline video element playing `stream` (to draw a face that comes as a stream). */
  playStream(stream: MediaStream): HTMLVideoElement;
  now(): number;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const BROWSER_RECORDER: RecorderBrowser = {
  MediaRecorder: typeof MediaRecorder === 'undefined' ? undefined : MediaRecorder,
  createCanvas: (width, height) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  },
  createStream: (tracks) => new MediaStream(tracks),
  playStream: (stream) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    void video.play().catch(() => undefined);
    return video;
  },
  now: () => performance.now(),
  setInterval: (callback, ms) => window.setInterval(callback, ms),
  clearInterval: (handle) => {
    window.clearInterval(handle as number);
  },
};

/** A container MediaRecorder can write here, with the base type the recording is stored as. */
export interface RecordingFormat {
  /** What MediaRecorder is asked for (codecs included). */
  readonly recorderType: string;
  readonly mimeType: RecordingMimeType;
}

const VIDEO_FORMATS: readonly RecordingFormat[] = [
  { recorderType: 'video/webm;codecs=vp8,opus', mimeType: 'video/webm' },
  { recorderType: 'video/webm;codecs=vp9,opus', mimeType: 'video/webm' },
  { recorderType: 'video/webm', mimeType: 'video/webm' },
  { recorderType: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', mimeType: 'video/mp4' },
  { recorderType: 'video/mp4', mimeType: 'video/mp4' },
];
const AUDIO_FORMATS: readonly RecordingFormat[] = [
  { recorderType: 'audio/webm;codecs=opus', mimeType: 'audio/webm' },
  { recorderType: 'audio/webm', mimeType: 'audio/webm' },
  { recorderType: 'audio/mp4', mimeType: 'audio/mp4' },
];

/** The first format the browser records (`video` false: sound only), or null when it records neither. */
export function pickFormat(
  isTypeSupported: (type: string) => boolean,
  video: boolean,
): RecordingFormat | null {
  const safe = (type: string) => {
    try {
      return isTypeSupported(type);
    } catch {
      return false;
    }
  };
  return (
    (video ? VIDEO_FORMATS : []).concat(AUDIO_FORMATS).find((format) => safe(format.recorderType)) ?? null
  );
}

/** Whether this browser can record a call at all (MediaRecorder, WebAudio streams and a supported container). */
export function canRecordCalls(browser: Pick<RecorderBrowser, 'MediaRecorder'> = BROWSER_RECORDER): boolean {
  const Recorder = browser.MediaRecorder;
  if (Recorder === undefined || typeof AudioContext === 'undefined') return false;
  if (!('createMediaStreamDestination' in AudioContext.prototype)) return false;
  return pickFormat((type) => Recorder.isTypeSupported(type), false) !== null;
}

/** The audio graph a recording taps (CallEngine.recordingSources()). */
export interface RecordingAudio {
  readonly context: Pick<AudioContext, 'createGain' | 'createMediaStreamSource'> &
    Partial<Pick<AudioContext, 'createMediaStreamDestination'>>;
  readonly veir: AudioNode | null;
  readonly microphone: MediaStream | null;
}

/** What the picture shows now: the face's element (or stream) while it shows, else the presence. */
export interface RecordingPicture {
  /** The face's own element (a vendor face, video and voice together). */
  readonly media: HTMLVideoElement | null;
  /** The face as a stream (the stand-in canvas face). */
  readonly stream: MediaStream | null;
}

export interface CallRecorderInput {
  readonly audio: RecordingAudio;
  /** The vEIR's name, drawn with the presence. */
  readonly name: string;
  /** What the vEIR's presence follows: its measured loudness (0–1). */
  readonly level: () => number;
  /** The face to draw, read on every frame. */
  readonly picture: () => RecordingPicture;
}

export interface FinishedRecording {
  readonly media: Blob;
  readonly mimeType: RecordingMimeType;
  readonly durationMs: number;
}

const WIDTH = 960;
const HEIGHT = 540;
const FPS = 24;
const VIDEO_BITS = 1_000_000;
const AUDIO_BITS = 96_000;
/** Stop before the file reaches the largest recording the API takes. */
const SIZE_MARGIN = 8 * 1024 * 1024;

type Context2D = CanvasRenderingContext2D;

/** Draws `source` to cover the canvas (as the call tile shows it: `object-fit: cover`). */
function drawCover(ctx: Context2D, source: HTMLVideoElement): boolean {
  const width = source.videoWidth;
  const height = source.videoHeight;
  if (width === 0 || height === 0 || source.readyState < 2) return false;
  const scale = Math.max(WIDTH / width, HEIGHT / height);
  const w = width * scale;
  const h = height * scale;
  ctx.drawImage(source, (WIDTH - w) / 2, (HEIGHT - h) / 2, w, h);
  return true;
}

function drawLabel(ctx: Context2D, text: string): void {
  ctx.font = '600 15px system-ui, sans-serif';
  const width = ctx.measureText(text).width + 22;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(16, 16, width, 28, 14);
  else ctx.rect(16, 16, width, 28);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 27, 30);
}

/** The call's presence: a soft sphere that swells with the vEIR's voice, its name under it. */
function drawPresence(ctx: Context2D, name: string, level: number, t: number): void {
  const background = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  background.addColorStop(0, '#0c0d10');
  background.addColorStop(1, '#16181d');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  const breathing = 1 + Math.sin(t / 900) * 0.015;
  const radius = 118 * breathing * (1 + Math.min(1, Math.sqrt(level * 6)) * 0.12);
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2 - 28;
  const glow = ctx.createRadialGradient(cx, cy, radius * 0.2, cx, cy, radius * 1.6);
  glow.addColorStop(0, 'rgba(160, 182, 255, 0.35)');
  glow.addColorStop(1, 'rgba(160, 182, 255, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  const sphere = ctx.createRadialGradient(
    cx - radius * 0.35,
    cy - radius * 0.4,
    radius * 0.1,
    cx,
    cy,
    radius,
  );
  sphere.addColorStop(0, '#e8ecff');
  sphere.addColorStop(0.45, '#8ea2e8');
  sphere.addColorStop(1, '#2b3566');
  ctx.fillStyle = sphere;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f4f5f7';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '600 26px system-ui, sans-serif';
  ctx.fillText(name, cx, cy + radius + 58);
  ctx.textAlign = 'start';
  drawLabel(ctx, 'AI voice');
}

/**
 * One recording of a live call. `start` begins at once; `sync` re-taps sources that changed (the microphone
 * reconnected, the face's voice arrived or came back); `stop` resolves with the file. A recording that nears the
 * largest file the API takes stops by itself (`onLimit`).
 */
export class CallRecorder {
  private recorder: MediaRecorder | null = null;
  private readonly chunks: Blob[] = [];
  private bytes = 0;
  private startedAt = 0;
  private timer: unknown = null;
  private canvasTrack: MediaStreamTrack | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private veir: AudioNode | null = null;
  private microphone: { stream: MediaStream; node: AudioNode } | null = null;
  private faceVoice: { track: MediaStreamTrack; node: AudioNode } | null = null;
  private faceStream: { stream: MediaStream; video: HTMLVideoElement } | null = null;
  private format: RecordingFormat | null = null;
  private stopping: Promise<FinishedRecording> | null = null;
  onLimit: (() => void) | null = null;

  constructor(
    private readonly input: CallRecorderInput,
    private readonly browser: RecorderBrowser = BROWSER_RECORDER,
  ) {}

  /** Starts recording. Throws when this browser cannot record (no MediaRecorder, no supported container). */
  start(): void {
    const Recorder = this.browser.MediaRecorder;
    const { context } = this.input.audio;
    if (Recorder === undefined || context.createMediaStreamDestination === undefined) {
      throw new Error('This browser can’t record calls.');
    }
    const destination = context.createMediaStreamDestination();
    this.destination = destination;
    const canvas = this.browser.createCanvas(WIDTH, HEIGHT);
    const ctx = typeof canvas.captureStream === 'function' ? canvas.getContext('2d') : null;
    const format = pickFormat((type) => Recorder.isTypeSupported(type), ctx !== null);
    if (format === null) throw new Error('This browser can’t record calls.');
    this.format = format;
    const tracks = [...destination.stream.getAudioTracks()];
    if (ctx !== null && format.mimeType.startsWith('video/')) {
      this.draw(ctx);
      const [video] = canvas.captureStream(FPS).getVideoTracks();
      if (video) {
        this.canvasTrack = video;
        tracks.unshift(video);
        this.timer = this.browser.setInterval(() => {
          this.draw(ctx);
        }, 1000 / FPS);
      }
    }
    this.sync();
    const recorder = new Recorder(this.browser.createStream(tracks), {
      mimeType: format.recorderType,
      videoBitsPerSecond: VIDEO_BITS,
      audioBitsPerSecond: AUDIO_BITS,
    });
    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return;
      this.chunks.push(event.data);
      this.bytes += event.data.size;
      if (this.bytes >= RECORDING_LIMITS.maxBytes - SIZE_MARGIN) this.onLimit?.();
    };
    this.recorder = recorder;
    this.startedAt = this.browser.now();
    // Data every second: a recording that stops abruptly (the page going away) keeps what was recorded until then.
    recorder.start(1000);
  }

  /** How long it has been recording (ms). */
  elapsedMs(): number {
    return this.recorder === null ? 0 : Math.max(0, this.browser.now() - this.startedAt);
  }

  /** Re-taps the call's sound where it changed: the microphone, the face's own voice, the vEIR's output. */
  sync(audio: RecordingAudio = this.input.audio): void {
    const destination = this.destination;
    if (destination === null) return;
    const { context } = audio;
    if (audio.veir !== this.veir) {
      this.disconnect(this.veir, destination);
      audio.veir?.connect(destination);
      this.veir = audio.veir;
    }
    if (audio.microphone !== (this.microphone?.stream ?? null)) {
      this.microphone?.node.disconnect();
      this.microphone = null;
      if (audio.microphone !== null && audio.microphone.getAudioTracks().length > 0) {
        const node = context.createMediaStreamSource(audio.microphone);
        node.connect(destination);
        this.microphone = { stream: audio.microphone, node };
      }
    }
    const media = this.input.picture().media;
    const source = media?.srcObject;
    const track = source instanceof MediaStream ? (source.getAudioTracks()[0] ?? null) : null;
    if (track !== (this.faceVoice?.track ?? null)) {
      this.faceVoice?.node.disconnect();
      this.faceVoice = null;
      if (track !== null) {
        const node = context.createMediaStreamSource(this.browser.createStream([track]));
        node.connect(destination);
        this.faceVoice = { track, node };
      }
    }
  }

  /** Stops recording and resolves with the file (once; later calls get the same promise). */
  stop(): Promise<FinishedRecording> {
    if (this.stopping) return this.stopping;
    const recorder = this.recorder;
    const format = this.format;
    this.stopping = new Promise<FinishedRecording>((resolve, reject) => {
      if (recorder === null || format === null) {
        reject(new Error('Nothing was recorded.'));
        return;
      }
      const durationMs = this.elapsedMs();
      recorder.onstop = () => {
        this.release();
        const media = new Blob(this.chunks, { type: format.mimeType });
        if (media.size === 0) reject(new Error('Nothing was recorded.'));
        else resolve({ media, mimeType: format.mimeType, durationMs: Math.max(1, Math.round(durationMs)) });
      };
      recorder.onerror = () => {
        this.release();
        reject(new Error('The recording stopped unexpectedly.'));
      };
      if (recorder.state === 'inactive') recorder.onstop(new Event('stop'));
      else recorder.stop();
    });
    return this.stopping;
  }

  private draw(ctx: Context2D): void {
    const picture = this.input.picture();
    let face: HTMLVideoElement | null = picture.media;
    if (face === null && picture.stream !== null) {
      if (this.faceStream?.stream !== picture.stream) {
        this.faceStream = { stream: picture.stream, video: this.browser.playStream(picture.stream) };
      }
      face = this.faceStream.video;
    }
    if (face !== null) {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      if (drawCover(ctx, face)) {
        drawLabel(ctx, 'AI avatar');
        return;
      }
    }
    drawPresence(ctx, this.input.name, this.input.level(), this.browser.now());
  }

  private disconnect(node: AudioNode | null, destination: AudioNode): void {
    try {
      node?.disconnect(destination);
    } catch {
      // Already disconnected (the call's audio closed first).
    }
  }

  private release(): void {
    if (this.timer !== null) this.browser.clearInterval(this.timer);
    this.timer = null;
    this.canvasTrack?.stop();
    this.canvasTrack = null;
    if (this.destination !== null) this.disconnect(this.veir, this.destination);
    this.veir = null;
    this.microphone?.node.disconnect();
    this.microphone = null;
    this.faceVoice?.node.disconnect();
    this.faceVoice = null;
    if (this.faceStream) this.faceStream.video.srcObject = null;
    this.faceStream = null;
    for (const track of this.destination?.stream.getTracks() ?? []) track.stop();
    this.destination = null;
  }
}
