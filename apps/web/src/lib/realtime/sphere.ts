import './sphere.css';

import type { AudioLevels, AvatarMountOptions, AvatarProvider, AvatarState, SpokenUnit } from './avatar';

/**
 * Everything the sphere can show. The call engine's avatar states, plus what only the call screen knows: the
 * call is on hold or its sound is off (`paused`), the connection dropped or the call failed (`disconnected`),
 * and the call is over (`ended`).
 */
export type SphereState = AvatarState | 'paused' | 'disconnected' | 'ended';

/** Speech RMS sits around 0.02–0.2; a square root spreads that over the 0–1 the form animates with. */
export function perceived(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  return Math.min(1, Math.sqrt(rms * 6));
}

/** Quick to rise, slow to fall, so the form breathes instead of flickering. */
export function follow(current: number, target: number): number {
  return current + (target - current) * (target > current ? 0.45 : 0.12);
}

/** Below this smoothed playback level the vEIR is not audible: the sphere shows listening, never speaking. */
export const AUDIBLE = 0.02;

/** Seconds per drift cycle: slow while listening, livelier while audibly speaking. */
const DRIFT_LISTENING_S = 40;
const DRIFT_SPEAKING_S = 18;
/** Thinking: one calm, even turn of the clouds per this many seconds (never level-coupled, never a ring). */
const SPIN_THINKING_S = 24;
/** Longest frame step folded into the motion (a stalled tab never jumps the clouds). */
const MAX_STEP_S = 0.1;

interface Pose {
  scale: number;
  light: number;
  ax: number;
  ay: number;
  ar: number;
  bx: number;
  by: number;
  br: number;
}

const REST: Pose = { scale: 1, light: 0.3, ax: 0, ay: 0, ar: 0, bx: 0, by: 0, br: 0 };

function moved(a: Pose, b: Pose): boolean {
  return (
    Math.abs(a.scale - b.scale) > 0.0008 ||
    Math.abs(a.light - b.light) > 0.004 ||
    Math.abs(a.ax - b.ax) > 0.02 ||
    Math.abs(a.ay - b.ay) > 0.02 ||
    Math.abs(a.ar - b.ar) > 0.02 ||
    Math.abs(a.bx - b.bx) > 0.02 ||
    Math.abs(a.by - b.by) > 0.02 ||
    Math.abs(a.br - b.br) > 0.02
  );
}

/**
 * The voice sphere: the call's default presence. A soft, cloud-textured orb (an original noise texture over the
 * voice palette) that shows the call's real state. Listening follows the founder's microphone, speaking follows
 * only the audio actually playing (`levels.veir`, the playback analyser), thinking turns the clouds evenly, and
 * muted, paused, disconnected and ended hold still. Per-frame work is a few compositor-only transform and
 * opacity writes, made only when something moved; React never renders per frame.
 *
 * DOM and CSS only: `.fa-sphere` (breathing while idle or connecting, in CSS) > `.fa-sphere__body` (level
 * scale) > two cloud layers and a cream highlight.
 */
export class SphereAvatar implements AvatarProvider {
  readonly id = 'builtin' as const;
  readonly voicing = 'engine' as const;
  private root: HTMLDivElement | null = null;
  private body: HTMLDivElement | null = null;
  private cloudA: HTMLDivElement | null = null;
  private cloudB: HTMLDivElement | null = null;
  private light: HTMLDivElement | null = null;
  private state: SphereState = 'idle';
  private reducedMotion = false;
  private veir = 0;
  private founder = 0;
  /** Drift phase (cycles) and thinking spin (degrees): advanced only in the states that move. */
  private drift = 0;
  private spin = 0;
  private lastFrame: number | null = null;
  private written: Pose = { ...REST };

  constructor(private readonly now: () => number = () => performance.now()) {}

  mount(stage: HTMLElement, options: AvatarMountOptions): void {
    this.unmount();
    const root = document.createElement('div');
    root.className = 'fa-sphere';
    root.dataset.state = this.state;
    root.dataset.motion = options.reducedMotion ? 'reduced' : 'full';
    root.setAttribute('aria-hidden', 'true');
    const part = (name: string) => {
      const element = document.createElement('div');
      element.className = `fa-sphere__${name}`;
      return element;
    };
    const body = part('body');
    const clouds = part('clouds');
    const cloudA = part('cloud');
    const cloudB = part('cloud');
    cloudB.classList.add('fa-sphere__cloud--b');
    const light = part('light');
    // The tinted undersides first, the white clouds over them.
    clouds.append(cloudB, cloudA);
    body.append(clouds, light);
    root.append(body);
    stage.prepend(root);
    this.root = root;
    this.body = body;
    this.cloudA = cloudA;
    this.cloudB = cloudB;
    this.light = light;
    this.reducedMotion = options.reducedMotion;
    this.written = { ...REST, light: -1 };
    this.write({ ...REST });
  }

  setState(state: SphereState): void {
    this.state = state;
    if (this.root) this.root.dataset.state = state;
  }

  /** Called every animation frame with the measured loudness of both sides (0–1 RMS). */
  setLevels(levels: AudioLevels): void {
    if (!this.root || this.reducedMotion) return;
    const now = this.now();
    const step =
      this.lastFrame === null ? 0 : Math.min(MAX_STEP_S, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    this.veir = follow(this.veir, perceived(levels.veir));
    this.founder = follow(this.founder, perceived(levels.founder));
    const pose = this.pose(step);
    if (pose) this.write(pose);
  }

  /** Whether the vEIR is audible right now (smoothed playback level above the floor). */
  audible(): boolean {
    return this.veir > AUDIBLE;
  }

  private pose(step: number): Pose | null {
    const state = this.state;
    if (state === 'listening' || state === 'speaking') {
      // Speaking moves only with audible output: when the playback level falls away, the release (0.12 per
      // frame, ~300 ms) settles it into the listening look.
      const speaking = state === 'speaking' && this.veir > AUDIBLE;
      this.drift += step / (speaking ? DRIFT_SPEAKING_S : DRIFT_LISTENING_S);
      const level = speaking ? this.veir : 0;
      const voice = state === 'listening' ? this.founder : 0;
      const phase = this.drift * Math.PI * 2;
      const sway = 1.4 * level;
      return {
        scale: speaking ? 1 + 0.06 * level : 1 + 0.035 * voice,
        light: speaking ? 0.4 + 0.6 * level : 0.35 + 0.4 * voice,
        ax: Math.sin(phase) * 7 + Math.sin(phase * 3.1) * sway,
        ay: Math.cos(phase * 0.7) * 2.5 + Math.cos(phase * 2.3) * sway * 0.5,
        ar: Math.sin(phase * 0.5) * 6 + this.spin,
        bx: Math.cos(phase * 0.8) * -6 - Math.sin(phase * 2.7) * sway,
        by: Math.sin(phase * 0.6) * 3,
        br: Math.cos(phase * 0.4) * -8 - this.spin * 0.6,
      };
    }
    if (state === 'thinking') {
      this.spin = (this.spin + (step * 360) / SPIN_THINKING_S) % 360;
      const phase = this.drift * Math.PI * 2;
      return {
        scale: 1,
        light: 0,
        ax: Math.sin(phase) * 7,
        ay: Math.cos(phase * 0.7) * 2.5,
        ar: Math.sin(phase * 0.5) * 6 + this.spin,
        bx: Math.cos(phase * 0.8) * -6,
        by: Math.sin(phase * 0.6) * 3,
        br: Math.cos(phase * 0.4) * -8 - this.spin * 0.6,
      };
    }
    // idle and connecting breathe in CSS; muted, paused, disconnected and ended hold still where they are.
    return null;
  }

  private write(pose: Pose): void {
    if (!this.body || !this.cloudA || !this.cloudB || !this.light) return;
    if (!moved(pose, this.written)) return;
    this.body.style.transform = `scale(${pose.scale.toFixed(4)})`;
    this.cloudA.style.transform = `translate3d(${pose.ax.toFixed(2)}%, ${pose.ay.toFixed(2)}%, 0) rotate(${pose.ar.toFixed(2)}deg)`;
    this.cloudB.style.transform = `translate3d(${pose.bx.toFixed(2)}%, ${pose.by.toFixed(2)}%, 0) rotate(${pose.br.toFixed(2)}deg) scale(1.15)`;
    this.light.style.opacity = pose.light.toFixed(3);
    this.written = pose;
  }

  speak(_unit: SpokenUnit): void {
    // Captions and queued text are not audible. Only the playback analyser may move the speaking sphere.
  }

  unmount(): void {
    this.root?.remove();
    this.root = null;
    this.body = null;
    this.cloudA = null;
    this.cloudB = null;
    this.light = null;
    this.veir = 0;
    this.founder = 0;
    this.lastFrame = null;
  }
}
