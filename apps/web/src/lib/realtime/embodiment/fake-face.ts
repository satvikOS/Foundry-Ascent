import type { AvatarSessionResponse } from '@foundry/contracts';

import type {
  AudioLevels,
  AvatarMountOptions,
  AvatarProvider,
  AvatarState,
  FaceRelay,
  SpokenUnit,
} from '../avatar';
import type { FaceRenderer, FaceRendererOutput, FaceRenderHandlers, FaceUnitAudio } from '../playback';

/**
 * The development stand-in for a vendor face (docs/architecture/calls.md §4): a face drawn on a canvas and
 * captured as a `MediaStream`, exactly where a vendor's WebRTC video arrives, so the call tile, the hand-over
 * of the call's validated audio (voicing `audio`) and every fallback run without a vendor account. It draws no
 * one's likeness. The local API serves it with `EMBODIMENT_PROVIDER=fake`; its session token starts `fake.`.
 *
 * Like a real vendor face it renders only what the server relays: `render` hands the unit's audio back to the
 * server (`POST /calls/:id/face/speak`, which checks it against its manifest) and only once the server accepted
 * it plays that audio into the call's own output, as a vendor's audio track would arrive in step with its video.
 * A unit the server did not give the face, or refused, is played by the call itself.
 */

export interface FakeFaceDeps {
  createCanvas(width: number, height: number): HTMLCanvasElement;
  captureStream(canvas: HTMLCanvasElement, fps: number): MediaStream;
  requestFrame(callback: (time: number) => void): number;
  cancelFrame(handle: number): void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Simulated vendor timings: joining the session, and the render pipeline's delay before a unit is heard. */
  readonly connectMs?: number;
  readonly renderMs?: number;
}

export function browserFakeFaceDeps(): FakeFaceDeps {
  return {
    createCanvas: (width, height) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      return canvas;
    },
    captureStream: (canvas, fps) => canvas.captureStream(fps),
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (handle) => {
      cancelAnimationFrame(handle);
    },
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (handle) => {
      window.clearTimeout(handle as number);
    },
  };
}

const WIDTH = 640;
const HEIGHT = 360;
const FPS = 30;
const CONNECT_MS = 600;
const RENDER_MS = 150;

/** A dark video room whatever the theme, like a call tile. No likeness: a neutral silhouette. */
const PALETTE = {
  top: '#191c22',
  bottom: '#0b0c0f',
  body: '#2b303a',
  head: '#3b414d',
  features: '#e6e8ec',
  mouth: '#121418',
} as const;

function abortError(): DOMException {
  return new DOMException('face_closed', 'AbortError');
}

export class FakeFaceAvatar implements AvatarProvider {
  readonly id = 'fake' as const;
  readonly drawsFace = true;
  readonly voicing = 'audio' as const;

  private canvas: HTMLCanvasElement | null = null;
  /** The join still under way (cancelled by `unmount`). */
  private joining: unknown = null;
  private stream: MediaStream | null = null;
  private frame: number | null = null;
  private live = false;
  private reducedMotion = false;
  private state: AvatarState = 'connecting';
  private mouth = 0;
  private target = 0;
  private readonly lostListeners = new Set<() => void>();
  private relay: FaceRelay | null = null;
  private readonly face: FaceRenderer = {
    ready: () => this.live,
    render: (buffer, output, handlers, audio) => this.render(buffer, output, handlers, audio),
    voicing: 'audio',
  };

  constructor(private readonly deps: FakeFaceDeps) {}

  mount(_stage: HTMLElement, options: AvatarMountOptions): void {
    this.reducedMotion = options.reducedMotion;
  }

  setState(state: AvatarState): void {
    this.state = state;
  }

  setLevels(levels: AudioLevels): void {
    this.target = Number.isFinite(levels.veir) ? Math.min(1, Math.sqrt(Math.max(0, levels.veir) * 6)) : 0;
  }

  speak(_unit: SpokenUnit): void {
    // The mouth follows the audio itself (setLevels); nothing to do per sentence.
  }

  connect(session: AvatarSessionResponse, signal: AbortSignal, relay: FaceRelay): Promise<void> {
    if (session.provider !== 'fake' || session.token?.startsWith('fake.') !== true) {
      return Promise.reject(new Error('not_stand_in_session'));
    }
    this.relay = relay;
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.deps.clearTimeout(timer);
        this.joining = null;
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const timer = this.deps.setTimeout(() => {
        this.joining = null;
        signal.removeEventListener('abort', onAbort);
        try {
          const canvas = this.deps.createCanvas(WIDTH, HEIGHT);
          this.canvas = canvas;
          this.draw(0);
          const stream = this.deps.captureStream(canvas, FPS);
          this.stream = stream;
          for (const track of stream.getVideoTracks()) {
            track.addEventListener('ended', () => {
              this.lose();
            });
          }
          this.live = true;
          this.loop();
          resolve();
        } catch (err) {
          this.release();
          reject(err instanceof Error ? err : new Error('face_not_started'));
        }
      }, this.deps.connectMs ?? CONNECT_MS);
      this.joining = timer;
    });
  }

  video(): MediaStream | null {
    return this.stream;
  }

  renderer(): FaceRenderer {
    return this.face;
  }

  onLost(listener: () => void): () => void {
    this.lostListeners.add(listener);
    return () => {
      this.lostListeners.delete(listener);
    };
  }

  /** Development control: the vendor drops mid-call (its video ends); the call goes on with the presence. */
  drop(): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.lose();
  }

  unmount(): void {
    this.lostListeners.clear();
    this.release();
  }

  // Internals -----------------------------------------------------------------------------------------

  private render(
    buffer: AudioBuffer | null,
    output: FaceRendererOutput,
    handlers: FaceRenderHandlers,
    audio: FaceUnitAudio | null,
  ): () => void {
    let stopped = false;
    let relayed = false;
    let source: AudioBufferSourceNode | null = null;
    let timer: unknown = null;
    const controller = new AbortController();
    const relay = this.relay;
    const fail = () => {
      if (!stopped) handlers.onEnd('failed');
    };
    if (buffer === null || audio === null || relay === null || !this.live) {
      // The server gave the face nothing to render (a unit it may not show): the call plays it itself.
      timer = this.deps.setTimeout(fail, 0);
    } else {
      relay.speak(audio, controller.signal).then(
        () => {
          relayed = true;
          if (stopped) return;
          // The vendor's pipeline: the audio comes back with the video a moment later, and plays into the
          // call's own gain (ducking and loudness unchanged).
          timer = this.deps.setTimeout(() => {
            if (stopped) return;
            if (!this.live) {
              fail();
              return;
            }
            const node = output.context.createBufferSource();
            node.buffer = buffer;
            node.connect(output.destination);
            node.onended = () => {
              if (!stopped) handlers.onEnd('ended');
            };
            node.start();
            source = node;
            handlers.onStart();
          }, this.deps.renderMs ?? RENDER_MS);
        },
        () => {
          fail();
        },
      );
    }
    return () => {
      stopped = true;
      controller.abort();
      if (timer !== null) this.deps.clearTimeout(timer);
      if (relayed) relay?.interrupt();
      const node = source;
      source = null;
      if (node === null) return;
      node.onended = null;
      try {
        node.stop();
      } catch {
        /* not started */
      }
      node.disconnect();
    };
  }

  private lose(): void {
    if (!this.live) return;
    this.live = false;
    this.stopLoop();
    for (const listener of [...this.lostListeners]) listener();
  }

  private release(): void {
    if (this.joining !== null) this.deps.clearTimeout(this.joining);
    this.joining = null;
    this.live = false;
    this.stopLoop();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.canvas = null;
  }

  private loop(): void {
    const step = (time: number) => {
      if (!this.live) return;
      this.draw(time);
      this.frame = this.deps.requestFrame(step);
    };
    this.frame = this.deps.requestFrame(step);
  }

  private stopLoop(): void {
    if (this.frame !== null) this.deps.cancelFrame(this.frame);
    this.frame = null;
  }

  private draw(time: number): void {
    const g = this.canvas?.getContext('2d') ?? null;
    if (g === null) return;
    const t = time / 1000;
    const still = this.reducedMotion;
    // Quick to open, slower to close, like the presence.
    this.mouth += (this.target - this.mouth) * (this.target > this.mouth ? 0.5 : 0.18);

    const sky = g.createLinearGradient(0, 0, 0, HEIGHT);
    sky.addColorStop(0, PALETTE.top);
    sky.addColorStop(1, PALETTE.bottom);
    g.fillStyle = sky;
    g.fillRect(0, 0, WIDTH, HEIGHT);

    const cx = WIDTH / 2;
    const bob = still
      ? 0
      : Math.sin(t * 1.3) * 2.5 + (this.state === 'listening' ? Math.sin(t * 0.7) * 1.5 : 0);
    const headY = HEIGHT * 0.44 + bob;

    g.fillStyle = PALETTE.body;
    g.beginPath();
    g.ellipse(cx, HEIGHT + 30, 170, 120, 0, 0, Math.PI * 2);
    g.fill();

    g.fillStyle = PALETTE.head;
    g.beginPath();
    g.ellipse(cx, headY, 62, 76, 0, 0, Math.PI * 2);
    g.fill();

    // Eyes, with a blink every few seconds.
    const blink = !still && t % 4.2 < 0.14;
    g.fillStyle = PALETTE.features;
    for (const dx of [-22, 22]) {
      g.beginPath();
      g.ellipse(cx + dx, headY - 10, 6, blink ? 1 : 6, 0, 0, Math.PI * 2);
      g.fill();
    }

    // The mouth opens with the vEIR's voice.
    g.fillStyle = PALETTE.mouth;
    g.beginPath();
    g.ellipse(cx, headY + 36, 16, 2 + this.mouth * 12, 0, 0, Math.PI * 2);
    g.fill();
  }
}
