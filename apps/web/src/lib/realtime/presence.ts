import './presence.css';

import type { AudioLevels, AvatarMountOptions, AvatarProvider, AvatarState, SpokenUnit } from './avatar';

const PARTS = ['halo', 'ring-outer', 'ring-inner', 'arc'] as const;

/** Speech RMS sits around 0.02–0.2; a square root spreads that over the 0–1 the form animates with. */
function perceived(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  return Math.min(1, Math.sqrt(rms * 6));
}

/** Quick to rise, slow to fall, so the form breathes instead of flickering. */
function follow(current: number, target: number): number {
  return current + (target - current) * (target > current ? 0.45 : 0.12);
}

/**
 * The built-in avatar ("presence"): concentric hairlines and a soft halo drawn from the theme's tokens. The
 * outer ring and halo follow the vEIR's voice, the inner ring the founder's microphone, and an arc turns
 * while it connects or thinks. No likeness is implied; the vEIR's monogram or consented portrait sits in
 * the middle (rendered by the call stage).
 */
export class PresenceAvatar implements AvatarProvider {
  readonly id = 'builtin' as const;
  readonly drawsFace = false;
  readonly voicing = 'engine' as const;
  private root: HTMLDivElement | null = null;
  private reducedMotion = false;
  private veir = 0;
  private founder = 0;
  private written = { veir: -1, founder: -1 };

  mount(stage: HTMLElement, options: AvatarMountOptions): void {
    this.unmount();
    const root = document.createElement('div');
    root.className = 'fa-presence';
    root.dataset.state = 'idle';
    root.dataset.motion = options.reducedMotion ? 'reduced' : 'full';
    root.setAttribute('aria-hidden', 'true');
    for (const part of PARTS) {
      const element = document.createElement('div');
      element.className = `fa-presence__${part}`;
      root.append(element);
    }
    stage.prepend(root);
    this.root = root;
    this.reducedMotion = options.reducedMotion;
  }

  setState(state: AvatarState): void {
    if (this.root) this.root.dataset.state = state;
  }

  setLevels(levels: AudioLevels): void {
    const root = this.root;
    if (!root || this.reducedMotion) return;
    this.veir = follow(this.veir, perceived(levels.veir));
    this.founder = follow(this.founder, perceived(levels.founder));
    // Write only real changes: this runs every animation frame.
    if (Math.abs(this.veir - this.written.veir) > 0.004) {
      root.style.setProperty('--fa-veir', this.veir.toFixed(3));
      this.written.veir = this.veir;
    }
    if (Math.abs(this.founder - this.written.founder) > 0.004) {
      root.style.setProperty('--fa-founder', this.founder.toFixed(3));
      this.written.founder = this.founder;
    }
  }

  speak(_unit: SpokenUnit): void {
    const root = this.root;
    if (!root || this.reducedMotion) return;
    root.classList.remove('is-blooming');
    // Restart the animation for every sentence (reading layout flushes the removed class).
    root.getBoundingClientRect();
    root.classList.add('is-blooming');
  }

  unmount(): void {
    this.root?.remove();
    this.root = null;
    this.veir = 0;
    this.founder = 0;
    this.written = { veir: -1, founder: -1 };
  }
}
