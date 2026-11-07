import { RECORDING_LIMITS, type RecordingMimeType } from '@foundry/contracts';

import type { CaptionSpeaker } from './captions';

/*
 * Records a call as the founder experiences it (ADR-0023), in the browser:
 *
 *   picture  the screen the founder shared for it (this tab, from getDisplayMedia on the Record press: the call as
 *            they see it, captions, conversation and controls), or, where a screen cannot be shared (iOS, most phones)
 *            or was not, one canvas composing the call view about 24 times a second: the vEIR's face while it shows
 *            (labelled "AI avatar" as on the call tile) or the call's presence (a sphere that follows the vEIR's
 *            voice), its name, the recording's time and the conversation's latest lines from both speakers. Either
 *            way one video track for the whole recording, so switching between voice and video never changes it.
 *   sound    a WebAudio mix on the call's own AudioContext: the vEIR's voice as the speakers get it, a vendor face's
 *            voice from its element, and the founder's microphone, silent whenever the call does not hear it (muted,
 *            on hold, or push to talk released: what is said off-mic is never recorded). The shared screen brings
 *            no sound of its own, so nothing is heard twice.
 *
 * MediaRecorder encodes both into the container the browser supports (webm on Chromium and Firefox, mp4 on Safari),
 * or sound only where no picture can be captured. Everything stays in this page's memory until it is saved.
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

/**
 * How a recording asks to share the screen: this tab, offered first and alone where the browser can (Chromium, Edge),
 * without its sound (the recording mixes the call's own), at most 1080p and 15 frames a second. Options a browser does
 * not know are ignored by it (Firefox offers windows and screens).
 */
const SCREEN_OPTIONS: DisplayMediaStreamOptions & Record<string, unknown> = {
  video: {
    displaySurface: 'browser',
    frameRate: { ideal: 15, max: 15 },
    width: { max: 1920 },
    height: { max: 1080 },
  },
  audio: false,
  preferCurrentTab: true,
  selfBrowserSurface: 'include',
  surfaceSwitching: 'exclude',
  systemAudio: 'exclude',
  monitorTypeSurfaces: 'exclude',
};

/** The browser's media devices: none outside a secure context, whatever the types say. */
function mediaDevices(): Partial<Pick<MediaDevices, 'getDisplayMedia'>> | undefined {
  return (navigator as Partial<Navigator>).mediaDevices;
}

/**
 * Asks to share the screen for a recording (the browser's own prompt), or null where a screen cannot be shared (iOS
 * and iPadOS Safari, most phones). Called in the Record press itself: a browser asks only from a person's gesture.
 */
export function requestScreen(
  devices: Partial<Pick<MediaDevices, 'getDisplayMedia'>> | undefined = mediaDevices(),
): Promise<MediaStream> | null {
  if (devices?.getDisplayMedia === undefined) return null;
  return devices.getDisplayMedia(SCREEN_OPTIONS);
}

/** Whether this browser can share the screen for a recording (else the call view is composed instead). */
export function canShareScreen(): boolean {
  return mediaDevices()?.getDisplayMedia !== undefined;
}

/** The audio graph a recording taps (CallEngine.recordingSources()). */
export interface RecordingAudio {
  readonly context: Pick<AudioContext, 'createGain' | 'createMediaStreamSource'> &
    Partial<Pick<AudioContext, 'createMediaStreamDestination'>>;
  readonly veir: AudioNode | null;
  readonly microphone: MediaStream | null;
  /** Whether the call hears the microphone now: false while muted, on hold or with push to talk released. */
  readonly microphoneOpen: boolean;
}

/** What the picture shows now: the face's element (or stream) while it shows, else the presence. */
export interface RecordingPicture {
  /** The face's own element (a vendor face, video and voice together). */
  readonly media: HTMLVideoElement | null;
  /** The face as a stream (the stand-in canvas face). */
  readonly stream: MediaStream | null;
}

/** One line of the conversation as the call view shows it (drawn when the call view is composed). */
export interface TranscriptLine {
  readonly speaker: CaptionSpeaker;
  readonly text: string;
  /** Still being heard (it may change). */
  readonly live: boolean;
}

export interface CallRecorderInput {
  readonly audio: RecordingAudio;
  /** The vEIR's name, drawn with the presence and its lines. */
  readonly name: string;
  /** The founder's name on their lines. */
  readonly founderName: string;
  /** What the vEIR's presence follows: its measured loudness (0–1). */
  readonly level: () => number;
  /** The face to draw, read on every frame. */
  readonly picture: () => RecordingPicture;
  /** The conversation's latest lines, both speakers, oldest first (read on every frame of a composed view). */
  readonly transcript: () => readonly TranscriptLine[];
  /**
   * The screen shared for this recording (getDisplayMedia), or null: the call view is composed instead. The recorder
   * owns it from here: its tracks stop when the recording does.
   */
  readonly display: MediaStream | null;
}

/** What the picture is: the shared screen, the composed call view, or none (sound only). */
export type RecordingCapture = 'screen' | 'view' | 'sound';

export interface FinishedRecording {
  readonly media: Blob;
  readonly mimeType: RecordingMimeType;
  readonly durationMs: number;
}

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 24;
/** A shared screen is mostly still text: this keeps it sharp and a 30-minute call well under the size limit. */
const VIDEO_BITS = 1_500_000;
const AUDIO_BITS = 96_000;
/** Stop before the file reaches the largest recording the API takes. */
const SIZE_MARGIN = 8 * 1024 * 1024;
const CANNOT_RECORD = 'This browser can’t record calls.';
const NOTHING_RECORDED = 'Nothing was recorded.';

type Context2D = CanvasRenderingContext2D;

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The composed call view: the stage (face or presence) on the left, the conversation on the right. */
const STAGE: Rect = { x: 32, y: 88, w: 736, h: 600 };
const PANEL: Rect = { x: 800, y: 88, w: 448, h: 600 };
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const LINE_HEIGHT = 28;
const SPEAKER_GAP = 14;
const COLORS = {
  top: '#0c0d10',
  bottom: '#16181d',
  surface: 'rgba(255, 255, 255, 0.04)',
  text: '#f4f5f7',
  muted: '#9aa0ab',
  veir: '#b8c6ff',
  record: '#ef4444',
} as const;

/** `m:ss` (or `h:mm:ss`), as the call shows its time. */
function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0
    ? `${String(hours)}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${String(minutes)}:${seconds}`;
}

function roundRect(ctx: Context2D, rect: Rect, radius: number): void {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(rect.x, rect.y, rect.w, rect.h, radius);
  else ctx.rect(rect.x, rect.y, rect.w, rect.h);
}

/** Draws `source` to cover `rect` (as the call tile shows it: `object-fit: cover`). */
function drawCover(ctx: Context2D, source: HTMLVideoElement, rect: Rect): boolean {
  const width = source.videoWidth;
  const height = source.videoHeight;
  if (width === 0 || height === 0 || source.readyState < 2) return false;
  const scale = Math.max(rect.w / width, rect.h / height);
  const w = width * scale;
  const h = height * scale;
  ctx.save();
  roundRect(ctx, rect, 20);
  ctx.clip();
  ctx.drawImage(source, rect.x + (rect.w - w) / 2, rect.y + (rect.h - h) / 2, w, h);
  ctx.restore();
  return true;
}

function drawLabel(ctx: Context2D, text: string, x: number, y: number): void {
  ctx.font = `600 15px ${FONT}`;
  const width = ctx.measureText(text).width + 22;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  roundRect(ctx, { x, y, w: width, h: 28 }, 14);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 11, y + 14);
}

/** The call's presence in the stage: a soft sphere that swells with the vEIR's voice. */
function drawPresence(ctx: Context2D, level: number, t: number): void {
  ctx.fillStyle = COLORS.surface;
  roundRect(ctx, STAGE, 20);
  ctx.fill();
  const breathing = 1 + Math.sin(t / 900) * 0.015;
  const radius = 128 * breathing * (1 + Math.min(1, Math.sqrt(level * 6)) * 0.12);
  const cx = STAGE.x + STAGE.w / 2;
  const cy = STAGE.y + STAGE.h / 2;
  const glow = ctx.createRadialGradient(cx, cy, radius * 0.2, cx, cy, radius * 1.6);
  glow.addColorStop(0, 'rgba(160, 182, 255, 0.35)');
  glow.addColorStop(1, 'rgba(160, 182, 255, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(STAGE.x, STAGE.y, STAGE.w, STAGE.h);
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
}

/** `text` broken into lines no wider than `width` (a word longer than the line is cut). */
function wrap(ctx: Context2D, text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line === '' ? word : `${line} ${word}`;
    if (ctx.measureText(next).width <= width) {
      line = next;
      continue;
    }
    if (line !== '') lines.push(line);
    line = word;
    while (ctx.measureText(line).width > width && line.length > 1) {
      let cut = line.length - 1;
      while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > width) cut -= 1;
      lines.push(line.slice(0, cut));
      line = line.slice(cut);
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

interface LaidOutLine {
  readonly speaker: CaptionSpeaker;
  readonly live: boolean;
  /** The speaker's name, then the words, wrapped to the panel. */
  readonly rows: readonly string[];
}

/**
 * One recording of a live call. `start` begins at once; `sync` re-taps sources that changed (the microphone
 * reconnected, the face's voice arrived or came back); `stop` resolves with the file. A recording that nears the
 * largest file the API takes stops by itself (`onLimit`), and so does one whose shared screen the person stopped
 * sharing from the browser's own controls (`onScreenEnded`).
 */
export class CallRecorder {
  private recorder: MediaRecorder | null = null;
  private readonly chunks: Blob[] = [];
  private bytes = 0;
  private startedAt = 0;
  private timer: unknown = null;
  private videoTrack: MediaStreamTrack | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private veir: AudioNode | null = null;
  private microphone: { stream: MediaStream; node: AudioNode; gate: GainNode } | null = null;
  private faceVoice: { track: MediaStreamTrack; node: AudioNode } | null = null;
  private faceStream: { stream: MediaStream; video: HTMLVideoElement } | null = null;
  private format: RecordingFormat | null = null;
  private stopping: Promise<FinishedRecording> | null = null;
  /** The composed view's conversation, laid out once per change of its lines. */
  private layout: { key: string; lines: readonly LaidOutLine[] } = { key: '', lines: [] };
  /** What the picture is (known once started). */
  capture: RecordingCapture = 'sound';
  onLimit: (() => void) | null = null;
  onScreenEnded: (() => void) | null = null;

  constructor(
    private readonly input: CallRecorderInput,
    private readonly browser: RecorderBrowser = BROWSER_RECORDER,
  ) {}

  /** Starts recording. Throws when this browser cannot record (no MediaRecorder, no supported container). */
  start(): void {
    const Recorder = this.browser.MediaRecorder;
    const { context } = this.input.audio;
    if (Recorder === undefined || context.createMediaStreamDestination === undefined) {
      this.stopDisplay();
      throw new Error(CANNOT_RECORD);
    }
    const screen = this.input.display?.getVideoTracks().find((track) => track.readyState === 'live') ?? null;
    const canvas = screen === null ? this.browser.createCanvas(WIDTH, HEIGHT) : null;
    const ctx =
      canvas !== null && typeof canvas.captureStream === 'function' ? canvas.getContext('2d') : null;
    const format = pickFormat((type) => Recorder.isTypeSupported(type), screen !== null || ctx !== null);
    if (format === null) {
      this.stopDisplay();
      throw new Error(CANNOT_RECORD);
    }
    const destination = context.createMediaStreamDestination();
    this.destination = destination;
    this.format = format;
    const tracks = [...destination.stream.getAudioTracks()];
    if (format.mimeType.startsWith('video/')) {
      if (screen !== null) {
        // Text on a screen: the encoder keeps it sharp rather than smooth.
        screen.contentHint = 'detail';
        screen.addEventListener('ended', this.screenEnded);
        this.videoTrack = screen;
        this.capture = 'screen';
        tracks.unshift(screen);
      } else if (canvas !== null && ctx !== null) {
        this.draw(ctx);
        const [video] = canvas.captureStream(FPS).getVideoTracks();
        if (video) {
          this.videoTrack = video;
          this.capture = 'view';
          tracks.unshift(video);
          this.timer = this.browser.setInterval(() => {
            this.draw(ctx);
          }, 1000 / FPS);
        }
      }
    }
    // A screen shared for a recording that can only be sound is not kept shared.
    if (this.capture !== 'screen') this.stopDisplay();
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
      this.disconnect(this.microphone?.node ?? null);
      this.disconnect(this.microphone?.gate ?? null);
      this.microphone = null;
      if (audio.microphone !== null && audio.microphone.getAudioTracks().length > 0) {
        const node = context.createMediaStreamSource(audio.microphone);
        // The microphone reaches the recording through a gate the call's own gating drives.
        const gate = context.createGain();
        node.connect(gate);
        gate.connect(destination);
        this.microphone = { stream: audio.microphone, node, gate };
      }
    }
    if (this.microphone !== null) this.microphone.gate.gain.value = audio.microphoneOpen ? 1 : 0;
    // A vendor face plays its voice in its own element. When the browser refused that element's sound, the face routes
    // its voice into the call's output instead (muted at full volume), which the recording already taps: never twice.
    const media = this.input.picture().media;
    const source = media?.srcObject;
    const refused = media !== null && media.muted && media.volume > 0;
    const track = source instanceof MediaStream && !refused ? (source.getAudioTracks()[0] ?? null) : null;
    if (track !== (this.faceVoice?.track ?? null)) {
      this.disconnect(this.faceVoice?.node ?? null);
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
        reject(new Error(NOTHING_RECORDED));
        return;
      }
      const durationMs = this.elapsedMs();
      recorder.onstop = () => {
        this.release();
        const media = new Blob(this.chunks, { type: format.mimeType });
        if (media.size === 0) reject(new Error(NOTHING_RECORDED));
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

  /** The person stopped sharing the screen (the browser's own Stop sharing): the recording ends there. */
  private readonly screenEnded = (): void => {
    this.onScreenEnded?.();
  };

  /** The composed call view: header (name, kind, time), stage (face or presence), conversation. */
  private draw(ctx: Context2D): void {
    const background = ctx.createLinearGradient(0, 0, 0, HEIGHT);
    background.addColorStop(0, COLORS.top);
    background.addColorStop(1, COLORS.bottom);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.textAlign = 'start';
    const picture = this.input.picture();
    let face: HTMLVideoElement | null = picture.media;
    if (face === null && picture.stream !== null) {
      if (this.faceStream?.stream !== picture.stream) {
        this.faceStream = { stream: picture.stream, video: this.browser.playStream(picture.stream) };
      }
      face = this.faceStream.video;
    }
    const avatar = face !== null && drawCover(ctx, face, STAGE);
    if (!avatar) drawPresence(ctx, this.input.level(), this.browser.now());
    drawLabel(ctx, avatar ? 'AI avatar' : 'AI voice', STAGE.x + 16, STAGE.y + 16);
    // Header: whose call, and how long it has been recorded.
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.text;
    ctx.font = `600 24px ${FONT}`;
    ctx.fillText(this.input.name, STAGE.x, 46);
    ctx.font = `600 20px ${FONT}`;
    const time = clock(this.elapsedMs());
    const timeWidth = ctx.measureText(time).width;
    ctx.fillText(time, WIDTH - 32 - timeWidth, 46);
    ctx.fillStyle = COLORS.record;
    ctx.beginPath();
    ctx.arc(WIDTH - 32 - timeWidth - 16, 46, 6, 0, Math.PI * 2);
    ctx.fill();
    this.drawConversation(ctx);
  }

  /** The conversation's latest lines, newest at the bottom, as many as fit the panel. */
  private drawConversation(ctx: Context2D): void {
    ctx.fillStyle = COLORS.surface;
    roundRect(ctx, PANEL, 20);
    ctx.fill();
    const pad = 24;
    const lines = this.input.transcript();
    const key = lines.map((line) => `${line.speaker}${line.live ? '~' : ':'}${line.text}`).join('\n');
    if (key !== this.layout.key) {
      ctx.font = `400 20px ${FONT}`;
      this.layout = {
        key,
        lines: lines.map((line) => ({
          speaker: line.speaker,
          live: line.live,
          rows: wrap(ctx, line.text, PANEL.w - pad * 2),
        })),
      };
    }
    ctx.save();
    roundRect(ctx, PANEL, 20);
    ctx.clip();
    ctx.textBaseline = 'alphabetic';
    let y = PANEL.y + PANEL.h - pad;
    for (const line of [...this.layout.lines].reverse()) {
      if (y < PANEL.y + pad) break;
      for (const row of [...line.rows].reverse()) {
        ctx.font = `400 20px ${FONT}`;
        ctx.fillStyle = line.speaker === 'veir' ? COLORS.text : COLORS.muted;
        ctx.globalAlpha = line.live ? 0.7 : 1;
        ctx.fillText(row, PANEL.x + pad, y);
        y -= LINE_HEIGHT;
      }
      ctx.globalAlpha = 1;
      ctx.font = `600 15px ${FONT}`;
      ctx.fillStyle = line.speaker === 'veir' ? COLORS.veir : COLORS.muted;
      ctx.fillText(line.speaker === 'veir' ? this.input.name : this.input.founderName, PANEL.x + pad, y + 4);
      y -= LINE_HEIGHT + SPEAKER_GAP;
    }
    ctx.restore();
  }

  private disconnect(node: AudioNode | null, destination?: AudioNode): void {
    try {
      if (destination === undefined) node?.disconnect();
      else node?.disconnect(destination);
    } catch {
      // Already disconnected, or the call's audio closed first (the call ended).
    }
  }

  /** Stops sharing the screen (the browser's sharing indicator goes away). */
  private stopDisplay(): void {
    for (const track of this.input.display?.getTracks() ?? []) track.stop();
  }

  private release(): void {
    if (this.timer !== null) this.browser.clearInterval(this.timer);
    this.timer = null;
    this.videoTrack?.removeEventListener('ended', this.screenEnded);
    this.videoTrack?.stop();
    this.videoTrack = null;
    this.stopDisplay();
    if (this.destination !== null) this.disconnect(this.veir, this.destination);
    this.veir = null;
    this.disconnect(this.microphone?.node ?? null);
    this.disconnect(this.microphone?.gate ?? null);
    this.microphone = null;
    this.disconnect(this.faceVoice?.node ?? null);
    this.faceVoice = null;
    if (this.faceStream) this.faceStream.video.srcObject = null;
    this.faceStream = null;
    for (const track of this.destination?.stream.getTracks() ?? []) track.stop();
    this.destination = null;
  }
}
