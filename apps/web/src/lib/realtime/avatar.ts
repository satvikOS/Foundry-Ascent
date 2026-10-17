import type { AvatarSessionResponse, AvatarVoicing, EmbodimentProviderId } from '@foundry/contracts';

import type { FaceRenderer } from './playback';
import { PresenceAvatar } from './presence';

/**
 * The face of a call (docs/architecture/calls.md §4). The call engine owns the conversation (speech in,
 * validated speech out); an avatar provider only embodies it. `builtin` is the presence: an abstract,
 * audio-reactive form around the vEIR's monogram (or consented portrait), drawn from the colour tokens.
 * A vendor face (a realtime avatar over WebRTC) implements the same interface plus the optional vendor part:
 * it connects with the API's single-use token, hands the call tile its video, and, with voicing `audio`,
 * renders the call's own validated audio itself, lip-synced, through `renderer()`.
 */

export type AvatarState = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'muted' | 'idle';

export type { FaceRenderer } from './playback';

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
  readonly id: EmbodimentProviderId;
  /**
   * True when the provider draws the face itself (a vendor's video). The built-in presence frames the
   * vEIR's monogram or consented portrait, which the call stage renders inside it.
   */
  readonly drawsFace: boolean;
  /**
   * How the vEIR is heard with this face. `engine`: the call plays its own audio and the face follows its
   * loudness (`setLevels`). `audio`: the face renders the call's validated audio itself (`renderer()`), and the
   * call plays a unit itself whenever the face cannot. `text` (a vendor voicing validated text) is reserved.
   */
  readonly voicing: AvatarVoicing;
  mount(stage: HTMLElement, options: AvatarMountOptions): void;
  setState(state: AvatarState): void;
  setLevels(levels: AudioLevels): void;
  speak(unit: SpokenUnit): void;
  unmount(): void;

  // Vendor faces only ---------------------------------------------------------------------------------

  /**
   * Opens the vendor session with the API's single-use token (`POST /calls/avatar-session`); resolves once the
   * first frame arrived, rejects when it cannot (the call keeps the presence).
   */
  connect?(session: AvatarSessionResponse, signal: AbortSignal): Promise<void>;
  /** The face's live video for the call tile (a vendor's WebRTC stream). */
  video?(): MediaStream | null;
  /** Voicing `audio`: where the call hands each validated unit's audio. */
  renderer?(): FaceRenderer | null;
  /** The face stopped (the vendor dropped, its video ended): the call goes on with the presence. */
  onLost?(listener: () => void): () => void;
}

/**
 * The provider for a persona's embodiment, synchronously: the built-in presence. A vendor face is loaded
 * with {@link loadAvatarProvider} once the API minted its session.
 */
export function createAvatarProvider(_id?: EmbodimentProviderId): AvatarProvider {
  return new PresenceAvatar();
}

/**
 * Vendor adapters, each its own chunk: a vendor SDK is downloaded only when a call uses that vendor (and the
 * shell's bundle never carries one). `fake` is the development stand-in the local API can serve.
 */
const VENDOR_FACES: Partial<Record<EmbodimentProviderId, () => Promise<AvatarProvider>>> = {
  fake: async () => {
    const { FakeFaceAvatar, browserFakeFaceDeps } = await import('./embodiment/fake-face');
    return new FakeFaceAvatar(browserFakeFaceDeps());
  },
};

/** A vendor face's adapter, or null when this build has none for it (the call keeps the presence). */
export async function loadAvatarProvider(id: EmbodimentProviderId): Promise<AvatarProvider | null> {
  const load = VENDOR_FACES[id];
  if (load === undefined) return null;
  try {
    return await load();
  } catch {
    // A chunk that failed to load (offline, a new deploy): the presence instead.
    return null;
  }
}
