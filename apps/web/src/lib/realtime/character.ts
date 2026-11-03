import './character.css';

import type { AudioLevels, AvatarMountOptions, AvatarProvider, AvatarState, SpokenUnit } from './avatar';

/** Original Foundry SVG artwork; no external assets, likeness, rendering service, or runtime dependency. */
const ART = `<svg viewBox="0 0 320 340" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<defs><linearGradient id="fa-character-coat" x2="0" y2="1"><stop stop-color="var(--presence-coat)"/><stop offset="1" stop-color="var(--presence-coat-shadow)"/></linearGradient></defs>
<ellipse cx="160" cy="322" rx="105" ry="8" fill="var(--border)"/>
<g class="fa-character__body"><path d="M48 321c2-63 33-91 76-99h72c43 8 74 36 76 99" fill="url(#fa-character-coat)"/>
<path d="m124 219 36 48 36-48-16-13h-40z" fill="var(--presence-skin)"/>
<path d="m118 221 42 46-23 26-30-67m95-5-42 46 23 26 30-67" fill="var(--presence-lapel)"/>
<path d="M160 269v51" stroke="var(--presence-seam)" stroke-width="2"/>
<path d="M210 280h22" stroke="var(--presence-seam)" stroke-width="3" stroke-linecap="round"/></g>
<g class="fa-character__head"><ellipse cx="93" cy="147" rx="12" ry="21" fill="var(--presence-skin)"/>
<ellipse cx="227" cy="147" rx="12" ry="21" fill="var(--presence-skin)"/>
<path d="M94 104c0-52 132-57 132 0v51c0 43-28 75-66 75s-66-32-66-75z" fill="var(--presence-skin)"/>
<path d="M91 133c-12-50 2-99 61-101 55-2 91 33 78 102l-15-35c-40 9-66-6-80-18-5 21-20 34-35 38l-4 23z" fill="var(--presence-hair)"/>
<path d="M112 131q14-9 28-1m40 0q14-8 28 1" fill="none" stroke="var(--presence-hair)" stroke-width="4" stroke-linecap="round"/>
<g class="fa-character__eyes"><ellipse cx="127" cy="149" rx="4" ry="6" fill="var(--presence-ink)"/><ellipse cx="193" cy="149" rx="4" ry="6" fill="var(--presence-ink)"/></g>
<path d="m159 150-5 22h10" fill="none" stroke="var(--presence-skin-shadow)" stroke-width="3" stroke-linecap="round"/>
<g class="fa-character__mouth"><ellipse cx="160" cy="193" rx="15" ry="3" fill="var(--presence-ink)"/><path d="M148 191h24" stroke="var(--presence-teeth)" stroke-width="3" stroke-linecap="round"/></g>
<path class="fa-character__rest-mouth" d="M146 190q14 8 28 0" fill="none" stroke="var(--presence-ink)" stroke-width="3" stroke-linecap="round"/>
</g></svg>`;

/** An amplitude-driven live character. The call owns audio; this renderer only samples its analyser. */
export class LocalCharacter implements AvatarProvider {
  readonly id = 'builtin' as const;
  readonly drawsFace = true;
  readonly voicing = 'engine' as const;
  private root: HTMLDivElement | null = null;
  private state: AvatarState = 'idle';
  private reducedMotion = false;
  private mouth = 0;

  mount(stage: HTMLElement, options: AvatarMountOptions): void {
    this.unmount();
    const root = document.createElement('div');
    root.className = 'fa-character';
    root.setAttribute('aria-hidden', 'true');
    // This is a fixed, authored string, never user or provider content.
    root.innerHTML = ART;
    root.dataset.state = this.state;
    root.dataset.motion = options.reducedMotion ? 'reduced' : 'full';
    stage.prepend(root);
    this.root = root;
    this.reducedMotion = options.reducedMotion;
  }

  setState(state: AvatarState): void {
    this.state = state;
    if (this.root) this.root.dataset.state = state;
    if (state !== 'speaking') this.closeMouth();
  }

  setLevels(levels: AudioLevels): void {
    if (!this.root || this.reducedMotion) return;
    const rms = Number.isFinite(levels.veir) ? Math.max(0, levels.veir) : 0;
    // No text-length timing or pretend phonemes: silence always closes the mouth, including captions-only.
    const target = this.state === 'speaking' && rms > 0.003 ? Math.min(1, Math.sqrt(rms * 7)) : 0;
    this.mouth = target === 0 ? 0 : this.mouth + (target - this.mouth) * 0.6;
    this.root.style.setProperty('--mouth', this.mouth.toFixed(3));
    this.root.dataset.audible = this.mouth > 0 ? 'true' : 'false';
  }

  speak(_unit: SpokenUnit): void {
    /* Playback levels, never captions, move the mouth. */
  }

  private closeMouth(): void {
    this.mouth = 0;
    this.root?.style.setProperty('--mouth', '0');
    if (this.root) this.root.dataset.audible = 'false';
  }

  unmount(): void {
    this.closeMouth();
    this.root?.remove();
    this.root = null;
  }
}
