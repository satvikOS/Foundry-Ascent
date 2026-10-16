import type { AvatarProviderId } from '@foundry/contracts';

import { PresenceAvatar } from './presence';

/**
 * The face of a call (docs/architecture/calls.md §4). The call engine owns the conversation (speech in,
 * validated speech out); an avatar provider only embodies it. `builtin` is the presence: an abstract,
 * audio-reactive form around the vEIR's monogram (or consented portrait), drawn from the colour tokens.
 * A vendor face (Anam, HeyGen LiveAvatar) would implement the same interface and render its video into
 * the stage.
 */

export type AvatarState = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'muted' | 'idle';

/** Loudness of both sides, 0–1, sampled every animation frame. */
export interface AudioLevels {
  readonly veir: number;
  readonly founder: number;
}

export interface AvatarMountOptions {
  /** Honour `prefers-reduced-motion`: a static form whose state shows only in the text label. */
  readonly reducedMotion: boolean;
}

/** A validated unit starting to be heard. */
export interface SpokenUnit {
  readonly text: string;
}

export interface AvatarProvider {
  readonly id: AvatarProviderId;
  /**
   * True when the provider draws the face itself (a vendor's video). The built-in presence frames the
   * vEIR's monogram or consented portrait, which the call stage renders inside it.
   */
  readonly drawsFace: boolean;
  mount(stage: HTMLElement, options: AvatarMountOptions): void;
  setState(state: AvatarState): void;
  setLevels(levels: AudioLevels): void;
  speak(unit: SpokenUnit): void;
  unmount(): void;
}

const PROVIDERS: Partial<Record<AvatarProviderId, () => AvatarProvider>> = {
  builtin: () => new PresenceAvatar(),
};

/**
 * The provider for a persona's embodiment. Only the built-in presence ships today; a persona configured
 * for a vendor keeps the presence until that vendor's adapter is registered here.
 */
export function createAvatarProvider(id: AvatarProviderId): AvatarProvider {
  const create = PROVIDERS[id] ?? (() => new PresenceAvatar());
  return create();
}
