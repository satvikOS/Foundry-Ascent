import type { FaceRendererOutput } from '../playback';

/**
 * How a vendor face is seen and heard in the browser (docs/architecture/calls.md §4.3).
 *
 * The face's video and its audio play together in **one** media element holding one `MediaStream` with both of the
 * vendor's tracks, unmuted, so the browser keeps the mouth and the voice in step itself (WebRTC's own audio/video
 * playout). Rendering the two apart (the video in a muted element, the audio through Web Audio) loses that sync and
 * adds the `AudioContext`'s output latency, which is large on Bluetooth: the mouth visibly leads the voice.
 *
 * The call still needs the face's sound for its own accounting (a unit counts as heard from the face's first sound,
 * the captions follow it): an analyser taps the audio track and is connected to nothing, so nothing plays twice.
 * Ducking, barge-in and the end of the call act on the element itself (its volume, `muted`, `pause`).
 *
 * The element belongs to the face, not to the screen: the call tile shows it while the call screen is open
 * ({@link adoptFaceMedia}) and it waits, still playing, in a hidden spot of the page while the call is minimized
 * ({@link parkFaceMedia}), so minimizing never interrupts the voice and there is never a second element playing it.
 */

/** The face's one media element, as the adapter drives it (an `HTMLVideoElement` in the browser). */
export interface FaceMediaElement {
  srcObject: MediaProvider | null;
  muted: boolean;
  volume: number;
  readonly paused: boolean;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: 'pause', listener: () => void): void;
  removeEventListener(type: 'pause', listener: () => void): void;
  /** Takes it off the page (the face ended). */
  remove(): void;
}

/**
 * The face's audio, measured for the call. `level` is its loudness now (RMS, 0–1); `mute` silences the copy routed
 * into the call's output, when there is one (the fallback below).
 */
export interface FaceAudioTap {
  level(): number;
  mute?(muted: boolean): void;
  disconnect(): void;
}

/**
 * Where the face's sound goes besides the analyser: `analyser` (the element plays it; the tap only measures, and
 * is connected to nothing), or `output` (the browser refused the element's sound, see the adapter: the audio is
 * routed into the call's own output, as a voice without the element's lip sync, rather than not heard at all).
 */
export type FaceTapMode = 'analyser' | 'output';

const PARKING_ID = 'foundry-face-media';

/** The hidden spot of the page where the face's element waits, still playing, while no tile shows it. */
function parking(): HTMLElement {
  const existing = document.getElementById(PARKING_ID);
  if (existing !== null) return existing;
  const spot = document.createElement('div');
  spot.id = PARKING_ID;
  spot.setAttribute('aria-hidden', 'true');
  // Through the CSSOM (allowed by the strict CSP): a 1 px, transparent, inert box. The element keeps playing (an
  // element taken off the page would be paused by the browser).
  Object.assign(spot.style, {
    position: 'fixed',
    right: '0',
    bottom: '0',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
    opacity: '0',
    pointerEvents: 'none',
  });
  document.body.appendChild(spot);
  return spot;
}

/** The face's one element: video and audio together, unmuted, inline, parked until a tile shows it. */
export function createFaceMediaElement(): HTMLVideoElement {
  const element = document.createElement('video');
  element.autoplay = true;
  element.playsInline = true;
  element.muted = false;
  element.setAttribute('aria-hidden', 'true');
  element.dataset.slot = 'call-video';
  parking().appendChild(element);
  return element;
}

/** Plays the element again if the browser paused it (it was moved); best effort. */
function keepPlaying(element: HTMLVideoElement): void {
  if (element.srcObject === null || !element.paused) return;
  // `play()` may also throw (an environment without media playback).
  void Promise.resolve()
    .then(() => element.play())
    .catch(() => undefined);
}

/**
 * Shows the face's element in `host` (the call tile). Moving a playing element within the page keeps it playing.
 * Returns the function that parks it again, unless it has moved on meanwhile (another tile, or the face ended).
 */
export function adoptFaceMedia(element: HTMLVideoElement, host: HTMLElement): () => void {
  host.appendChild(element);
  keepPlaying(element);
  return () => {
    if (element.parentElement === host) parkFaceMedia(element);
  };
}

/** Puts the face's element back in its hidden spot (the call minimized), still playing; an ended face is dropped. */
export function parkFaceMedia(element: HTMLVideoElement): void {
  if (element.srcObject === null) {
    element.remove();
    return;
  }
  parking().appendChild(element);
  keepPlaying(element);
}

/** RMS of an analyser's current window. */
function rms(analyser: AnalyserNode, samples: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

/**
 * Taps the face's audio (`stream`, its audio track) on the call's `AudioContext`. In `analyser` mode the source
 * feeds only an analyser, connected to nothing (an analyser is processed without an output), so the call's graph
 * never plays the face. In `output` mode it is also routed, through its own gain (barge-in), into the call's output;
 * `hold` keeps a remote track flowing into Web Audio (Chromium needs a media element holding it, kept muted).
 */
export function tapFaceAudio(
  stream: MediaStream,
  output: FaceRendererOutput,
  mode: FaceTapMode,
  hold?: (stream: MediaStream) => () => void,
): FaceAudioTap {
  const context = output.context as unknown as AudioContext;
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  const samples = new Float32Array(analyser.fftSize);
  source.connect(analyser);
  let gain: GainNode | null = null;
  let release: (() => void) | null = null;
  if (mode === 'output') {
    gain = context.createGain();
    source.connect(gain);
    gain.connect(output.destination);
    release = hold?.(stream) ?? null;
  }
  return {
    level: () => rms(analyser, samples),
    mute: (muted) => {
      if (gain !== null) gain.gain.value = muted ? 0 : 1;
    },
    disconnect: () => {
      source.disconnect();
      gain?.disconnect();
      release?.();
    },
  };
}

/** Chromium plays a remote WebRTC track into Web Audio only while a media element holds it (kept muted). */
export function holdInMutedElement(stream: MediaStream): () => void {
  const holder = new Audio();
  holder.muted = true;
  holder.srcObject = stream;
  void holder.play().catch(() => undefined);
  return () => {
    holder.srcObject = null;
  };
}

/** Calls back once, at the founder's next click, tap or key on the page; returns its cancel. */
export function onNextGesture(callback: () => void): () => void {
  const events = ['pointerdown', 'keydown'] as const;
  const once = () => {
    cancel();
    callback();
  };
  const cancel = () => {
    for (const type of events) window.removeEventListener(type, once, true);
  };
  for (const type of events) window.addEventListener(type, once, true);
  return cancel;
}
