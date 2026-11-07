import { RECORDING_LIMITS, type RecordingMimeType } from '@foundry/contracts';

import { resolvedTheme, type ResolvedTheme } from '@/lib/theme';

import type { CaptionSpeaker } from './captions';

/*
 * Records a call as the founder experiences it (ADR-0023), in the browser:
 *
 *   picture  one canvas, captured as the recording's only video track (switching between voice and video, or
 *            minimizing the call, never changes it). It shows this tab as the founder sees it (shared from
 *            getDisplayMedia on the Record press: the call, its captions, conversation and controls) while the call
 *            screen is open, and the composed call view otherwise: while the call is minimized (the tab then shows
 *            other pages, which are never recorded), and for the whole recording where this tab cannot be shared
 *            (iOS, most phones, Firefox and Safari, which share windows and screens, never just this tab) or was
 *            not. The composed view is the vEIR's face while it shows (labelled "AI avatar" as on the call tile) or
 *            the call's presence (a sphere that follows the vEIR's voice), its name, the recording's time and the
 *            conversation's latest lines from both speakers.
 *   sound    a WebAudio mix on the call's own AudioContext: the vEIR's voice as the speakers get it, a vendor face's
 *            voice from its element, and the founder's microphone, silent whenever the call does not hear it (muted,
 *            on hold, or push to talk released: what is said off-mic is never recorded). The shared screen brings
 *            no sound of its own, so nothing is heard twice.
 *
 * MediaRecorder encodes both as H.264 and AAC in mp4 where the browser can (Chrome and Edge on a Mac or Windows,
 * Safari): a downloaded file then states its length and opens in the computer's own player. Elsewhere (Firefox,
 * Chromium on Linux) it is webm, or sound only where no picture can be captured. Everything stays in this page's
 * memory until it is saved.
 */

/** The browser objects a recording needs (real ones in the app, fakes in tests). */
export interface RecorderBrowser {
  readonly MediaRecorder: typeof MediaRecorder | undefined;
  createCanvas(width: number, height: number): HTMLCanvasElement;
  createStream(tracks: MediaStreamTrack[]): MediaStream;
  /** A muted, inline video element playing `stream` (to draw a face that comes as a stream). */
  playStream(stream: MediaStream): HTMLVideoElement;
  /** This page's size in device pixels: what a capture of this tab is made of (scaled down to fit what was asked). */
  viewport(): { width: number; height: number };
  /** The app's theme now (the composed call view follows it, as the shared tab does). */
  theme(): ResolvedTheme;
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
  viewport: () => ({
    width: window.innerWidth * window.devicePixelRatio,
    height: window.innerHeight * window.devicePixelRatio,
  }),
  theme: resolvedTheme,
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

/**
 * mp4 with H.264 and AAC first: MediaRecorder writes no length into a webm file (a player shows none and seeks poorly,
 * and QuickTime opens no webm at all), while its mp4 states it. A bare `mp4` comes only after webm: Chromium may fill
 * it with Opus, which QuickTime does not play either.
 */
const VIDEO_FORMATS: readonly RecordingFormat[] = [
  { recorderType: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', mimeType: 'video/mp4' },
  { recorderType: 'video/webm;codecs=vp8,opus', mimeType: 'video/webm' },
  { recorderType: 'video/webm;codecs=vp9,opus', mimeType: 'video/webm' },
  { recorderType: 'video/webm', mimeType: 'video/webm' },
  { recorderType: 'video/mp4', mimeType: 'video/mp4' },
];
const AUDIO_FORMATS: readonly RecordingFormat[] = [
  { recorderType: 'audio/mp4;codecs=mp4a.40.2', mimeType: 'audio/mp4' },
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
 * How a recording asks to share the screen: this tab, offered first (Chromium, Edge), without its sound (the recording
 * mixes the call's own), at most 1080p and 15 frames a second. Whatever else the person picks is refused once shared
 * ({@link sharesThisTab}).
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

/** What this page says about itself to a capture of it (the Capture Handle API, Chromium and Edge). */
interface CaptureHandleConfig {
  readonly handle: string;
  readonly exposeOrigin: boolean;
  readonly permittedOrigins: readonly string[];
}

/** The screen-sharing parts of the browser's media devices. */
export interface ScreenDevices {
  readonly getDisplayMedia?: (options: DisplayMediaStreamOptions) => Promise<MediaStream>;
  readonly setCaptureHandleConfig?: (config: CaptureHandleConfig) => void;
}

/** The browser's media devices: none outside a secure context, whatever the types say. */
function mediaDevices(): ScreenDevices | undefined {
  return (navigator as Partial<Navigator>).mediaDevices;
}

/** This page's capture handle: a capture of a tab that carries it is a capture of this tab. */
let pageHandle: string | null = null;

/**
 * Whether this tab can be shared for a recording, and known to be this tab once shared: only where the page can tell a
 * capture of itself (Chromium and Edge on a computer). Firefox and Safari share windows and screens only, and phones
 * nothing, so there the call view is composed instead and no screen is asked for.
 */
export function canShareScreen(devices: ScreenDevices | undefined = mediaDevices()): boolean {
  return devices?.getDisplayMedia !== undefined && devices.setCaptureHandleConfig !== undefined;
}

/**
 * Asks to share this tab for a recording (the browser's own prompt), or null where it cannot be shared
 * ({@link canShareScreen}). Called in the Record press itself: a browser asks only from a person's gesture.
 */
export function requestScreen(
  devices: ScreenDevices | undefined = mediaDevices(),
): Promise<MediaStream> | null {
  if (devices?.getDisplayMedia === undefined || devices.setCaptureHandleConfig === undefined) return null;
  pageHandle ??= crypto.randomUUID();
  devices.setCaptureHandleConfig({
    handle: pageHandle,
    exposeOrigin: false,
    permittedOrigins: [window.location.origin],
  });
  return devices.getDisplayMedia(SCREEN_OPTIONS);
}

/**
 * Whether `display` is this tab: a browser tab carrying this page's capture handle. Another tab, a window or a whole
 * screen would record what is outside the call (other pages, other apps, notifications), so it is not recorded.
 */
export function sharesThisTab(display: MediaStream): boolean {
  // The page a capture shows, as that page described itself (Chromium and Edge).
  const track: (MediaStreamTrack & { getCaptureHandle?: () => { handle: string } | null }) | undefined =
    display.getVideoTracks()[0];
  if (track === undefined || pageHandle === null) return false;
  return (
    track.getSettings().displaySurface === 'browser' && track.getCaptureHandle?.()?.handle === pageHandle
  );
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
   * This tab, shared for this recording (getDisplayMedia, {@link sharesThisTab}), or null: the call view is composed
   * instead. The recorder owns it from here: its tracks stop when the recording does.
   */
  readonly display: MediaStream | null;
  /**
   * Whether the call screen is open, read on every frame: only then does the shared tab show the call. Otherwise
   * (minimized, the tab showing other pages) the composed call view is recorded.
   */
  readonly onScreen: () => boolean;
}

/** What the picture is: this tab (the composed call view while minimized), the composed call view, or none. */
export type RecordingCapture = 'screen' | 'view' | 'sound';

export interface FinishedRecording {
  readonly media: Blob;
  readonly mimeType: RecordingMimeType;
  readonly durationMs: number;
}

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 24;
/** The largest picture of a shared tab (its own size, scaled down to fit). */
const SCREEN_MAX = { width: 1920, height: 1080 } as const;
/** As often as the tab is shared (SCREEN_OPTIONS). */
const SCREEN_FPS = 15;
/**
 * After the call screen opens again, how long the composed view stays: the shared tab's frames arrive a little late,
 * and the first of them may still show the page the call was minimized over.
 */
const SCREEN_SETTLE_MS = 500;
/**
 * A shared tab is mostly still text, which needs more bits to stay sharp (about 340 MB for a 30-minute call); the
 * composed view is drawn larger and holds less (about 235 MB), which matters most on the phones that record it.
 */
const SCREEN_BITS = 1_500_000;
const VIEW_BITS = 1_000_000;
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

interface Palette {
  readonly top: string;
  readonly bottom: string;
  readonly surface: string;
  readonly text: string;
  readonly muted: string;
  readonly veir: string;
  readonly record: string;
}

/** The composed view in the app's own theme, so a take that minimizes the call does not flip from light to dark. */
const PALETTES: Record<ResolvedTheme, Palette> = {
  dark: {
    top: '#0c0d10',
    bottom: '#16181d',
    surface: 'rgba(255, 255, 255, 0.04)',
    text: '#f4f5f7',
    muted: '#9aa0ab',
    veir: '#b8c6ff',
    record: '#ef4444',
  },
  light: {
    top: '#fafaf9',
    bottom: '#f1f1ee',
    surface: 'rgba(17, 17, 16, 0.04)',
    text: '#111110',
    muted: '#5c5c58',
    veir: '#3b4bb5',
    record: '#dc2626',
  },
};

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

/**
 * The canvas a shared tab is drawn on: the tab's own shape (this page in device pixels, `viewport`) scaled down to fit
 * the capture's size and {@link SCREEN_MAX}, in even numbers as encoders want them. The capture's settings alone would
 * not do: Chromium reports the largest size asked for there, not its frames' (a 16:10 laptop's tab would be drawn
 * with black bars down both sides).
 */
function screenSize(
  track: MediaStreamTrack,
  viewport: { width: number; height: number },
): { width: number; height: number } {
  const settings = track.getSettings();
  const known = (value: number | undefined): value is number => value !== undefined && value > 0;
  const bound = {
    width: Math.min(SCREEN_MAX.width, known(settings.width) ? settings.width : SCREEN_MAX.width),
    height: Math.min(SCREEN_MAX.height, known(settings.height) ? settings.height : SCREEN_MAX.height),
  };
  const shape = known(viewport.width) && known(viewport.height) ? viewport : bound;
  const scale = Math.min(1, bound.width / shape.width, bound.height / shape.height);
  const even = (value: number) => Math.max(2, Math.round((value * scale) / 2) * 2);
  return { width: even(shape.width), height: even(shape.height) };
}

/** Draws `source` whole in a `width`×`height` canvas, centred (a tab resized while it records keeps its shape). */
function drawContain(ctx: Context2D, source: HTMLVideoElement, width: number, height: number): boolean {
  const sourceWidth = source.videoWidth;
  const sourceHeight = source.videoHeight;
  if (!sourceWidth || !sourceHeight || source.readyState < 2) return false;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const w = sourceWidth * scale;
  const h = sourceHeight * scale;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, (width - w) / 2, (height - h) / 2, w, h);
  return true;
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
function drawPresence(ctx: Context2D, colors: Palette, level: number, t: number): void {
  ctx.fillStyle = colors.surface;
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
 * largest file the API takes stops by itself (`onLimit`), and so does one whose shared tab the person stopped sharing
 * from the browser's own controls (`onScreenEnded`).
 */
export class CallRecorder {
  private recorder: MediaRecorder | null = null;
  private readonly chunks: Blob[] = [];
  private bytes = 0;
  private startedAt = 0;
  private timer: unknown = null;
  private videoTrack: MediaStreamTrack | null = null;
  /** The canvas's size: the shared tab's, or the composed view's. */
  private size: { width: number; height: number } = { width: WIDTH, height: HEIGHT };
  /**
   * The shared tab: its track, the element its frames are drawn from, and since when (ms) the call screen has been open
   * (null: it is not, so the composed view is drawn).
   */
  private screen: { track: MediaStreamTrack; video: HTMLVideoElement; openSince: number | null } | null =
    null;
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
    const display = this.input.display;
    const screen = display?.getVideoTracks().find((track) => track.readyState === 'live') ?? null;
    this.size =
      screen === null ? { width: WIDTH, height: HEIGHT } : screenSize(screen, this.browser.viewport());
    const canvas = this.browser.createCanvas(this.size.width, this.size.height);
    const ctx = typeof canvas.captureStream === 'function' ? canvas.getContext('2d') : null;
    const format = pickFormat((type) => Recorder.isTypeSupported(type), ctx !== null);
    if (format === null) {
      this.stopDisplay();
      throw new Error(CANNOT_RECORD);
    }
    const destination = context.createMediaStreamDestination();
    this.destination = destination;
    this.format = format;
    const tracks = [...destination.stream.getAudioTracks()];
    if (format.mimeType.startsWith('video/') && ctx !== null) {
      const fps = screen === null ? FPS : SCREEN_FPS;
      if (display && screen !== null) {
        screen.addEventListener('ended', this.screenEnded);
        // Open now (Record was pressed in it): the tab shows the call from the first frame.
        const openSince = this.input.onScreen() ? -Infinity : null;
        this.screen = { track: screen, video: this.browser.playStream(display), openSince };
      }
      this.frame(ctx);
      const [video] = canvas.captureStream(fps).getVideoTracks();
      if (video) {
        // Text on a screen: the encoder keeps it sharp rather than smooth.
        if (this.screen !== null) video.contentHint = 'detail';
        this.videoTrack = video;
        this.capture = this.screen === null ? 'view' : 'screen';
        tracks.unshift(video);
        this.timer = this.browser.setInterval(() => {
          this.frame(ctx);
        }, 1000 / fps);
      }
    }
    // A screen shared for a recording that can only be sound is not kept shared.
    if (this.capture !== 'screen') this.stopDisplay();
    this.sync();
    const recorder = new Recorder(this.browser.createStream(tracks), {
      mimeType: format.recorderType,
      videoBitsPerSecond: this.capture === 'screen' ? SCREEN_BITS : VIEW_BITS,
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

  /** One frame: the shared tab while it shows the call, else the composed call view. */
  private frame(ctx: Context2D): void {
    const { width, height } = this.size;
    const screen = this.screen;
    if (screen !== null && this.showsCall(screen) && drawContain(ctx, screen.video, width, height)) return;
    // The composed view at its own size, scaled to fit the canvas and centred on its background.
    const colors = PALETTES[this.browser.theme()];
    const scale = Math.min(width / WIDTH, height / HEIGHT);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = colors.top;
    ctx.fillRect(0, 0, width, height);
    ctx.setTransform(scale, 0, 0, scale, (width - WIDTH * scale) / 2, (height - HEIGHT * scale) / 2);
    this.draw(ctx, colors);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Whether the shared tab shows the call now: the call screen is open, and has been for a moment. */
  private showsCall(screen: { openSince: number | null }): boolean {
    if (!this.input.onScreen()) {
      screen.openSince = null;
      return false;
    }
    const now = this.browser.now();
    screen.openSince ??= now;
    return now - screen.openSince >= SCREEN_SETTLE_MS;
  }

  /** The composed call view: header (name, kind, time), stage (face or presence), conversation. */
  private draw(ctx: Context2D, colors: Palette): void {
    const background = ctx.createLinearGradient(0, 0, 0, HEIGHT);
    background.addColorStop(0, colors.top);
    background.addColorStop(1, colors.bottom);
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
    if (!avatar) drawPresence(ctx, colors, this.input.level(), this.browser.now());
    drawLabel(ctx, avatar ? 'AI avatar' : 'AI voice', STAGE.x + 16, STAGE.y + 16);
    // Header: whose call, and how long it has been recorded.
    ctx.textBaseline = 'middle';
    ctx.fillStyle = colors.text;
    ctx.font = `600 24px ${FONT}`;
    ctx.fillText(this.input.name, STAGE.x, 46);
    ctx.font = `600 20px ${FONT}`;
    const time = clock(this.elapsedMs());
    const timeWidth = ctx.measureText(time).width;
    ctx.fillText(time, WIDTH - 32 - timeWidth, 46);
    ctx.fillStyle = colors.record;
    ctx.beginPath();
    ctx.arc(WIDTH - 32 - timeWidth - 16, 46, 6, 0, Math.PI * 2);
    ctx.fill();
    this.drawConversation(ctx, colors);
  }

  /** The conversation's latest lines, newest at the bottom, as many as fit the panel. */
  private drawConversation(ctx: Context2D, colors: Palette): void {
    ctx.fillStyle = colors.surface;
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
        ctx.fillStyle = line.speaker === 'veir' ? colors.text : colors.muted;
        ctx.globalAlpha = line.live ? 0.7 : 1;
        ctx.fillText(row, PANEL.x + pad, y);
        y -= LINE_HEIGHT;
      }
      ctx.globalAlpha = 1;
      ctx.font = `600 15px ${FONT}`;
      ctx.fillStyle = line.speaker === 'veir' ? colors.veir : colors.muted;
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
    this.videoTrack?.stop();
    this.videoTrack = null;
    if (this.screen !== null) {
      this.screen.track.removeEventListener('ended', this.screenEnded);
      this.screen.video.srcObject = null;
    }
    this.screen = null;
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
