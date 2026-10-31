import type { AvatarSessionResponse, AvatarVoicing, EmbodimentProviderId } from '@foundry/contracts';

import type { FaceMediaElement } from './embodiment/face-media';
import type { FaceRenderer, FaceUnitAudio, SpeechUnitToPlay } from './playback';
import { PresenceAvatar } from './presence';

/**
 * The face of a call (docs/architecture/calls.md §4). The call engine owns the conversation (speech in,
 * validated speech out); an avatar provider only embodies it. `builtin` is the presence: an abstract,
 * audio-reactive form around the vEIR's monogram (or consented portrait), drawn from the colour tokens.
 * A vendor face (a realtime avatar over WebRTC) implements the same interface plus the optional vendor part:
 * it connects with the API's single-use token, hands the call tile its video, and, with voicing `audio`,
 * renders the call's own validated audio itself, lip-synced, through `renderer()`; with voicing `text` (a FULL
 * stock face) it has the vendor voice each validated unit's words, once the server admitted them.
 */

export type AvatarState = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'muted' | 'idle';

export type { FaceRenderer, FaceUnitAudio } from './playback';

/**
 * The server path of a face (`POST /calls/:id/face/*`). LITE: the face's speak channel stays on the server, which
 * relays a unit only when it is exactly the audio it synthesized for this call; the browser only watches. FULL:
 * the server admits each signed unit (`say`) before the browser may send the vendor its words.
 */
export interface FaceRelay {
  /** LITE: hands the server one unit's audio for the face; rejects when the server would not relay it. */
  speak(audio: FaceUnitAudio, signal: AbortSignal): Promise<void>;
  /**
   * FULL: asks the server to admit one signed unit (204); rejects when it would not (422: not this call's
   * validated words, already said, out of order), and then nothing is sent to the vendor.
   */
  say?(unit: SpeechUnitToPlay, signal: AbortSignal): Promise<void>;
  /** Barge-in: the face drops what it still has to say (best effort). */
  interrupt(): void;
}

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
   * call plays a unit itself whenever the face cannot. `text`: the vendor voices each validated unit's words with
   * its own stock voice (`renderer()`), and the call speaks a unit itself whenever the face cannot.
   */
  readonly voicing: AvatarVoicing;
  mount(stage: HTMLElement, options: AvatarMountOptions): void;
  setState(state: AvatarState): void;
  setLevels(levels: AudioLevels): void;
  speak(unit: SpokenUnit): void;
  unmount(): void;

  // Vendor faces only ---------------------------------------------------------------------------------

  /**
   * Joins the vendor session with the API's room token (`POST /calls/avatar-session`); resolves once the first
   * frame arrived, rejects when it cannot (the call keeps the presence). Audio for the face goes through `relay`.
   */
  connect?(session: AvatarSessionResponse, signal: AbortSignal, relay: FaceRelay): Promise<void>;
  /** The face's live video alone (a vendor's WebRTC stream, the stand-in's canvas): thumbnails, muted. */
  video?(): MediaStream | null;
  /**
   * The one media element that plays a vendor face's video and audio together (unmuted, so the browser keeps the
   * lips in step with the voice): the call tile shows this very element instead of a muted copy of `video()`.
   */
  media?(): FaceMediaElement | null;
  /** Voicing `audio` or `text`: where the call hands each validated unit. */
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
const VENDOR_FACES: Partial<
  Record<EmbodimentProviderId, (voicing: AvatarVoicing) => Promise<AvatarProvider>>
> = {
  fake: async (voicing) => {
    if (voicing === 'text') {
      // The stand-in of a FULL face: the real text path, over an in-page room that says each unit silently.
      const { LiveAvatarFace } = await import('./embodiment/liveavatar');
      const { standInLiveAvatarDeps } = await import('./embodiment/fake-liveavatar-room');
      return new LiveAvatarFace(standInLiveAvatarDeps(), { voicing: 'text', provider: 'fake' });
    }
    const { FakeFaceAvatar, browserFakeFaceDeps } = await import('./embodiment/fake-face');
    return new FakeFaceAvatar(browserFakeFaceDeps());
  },
  // HeyGen LiveAvatar over LiveKit: LITE watches the room; FULL also sends it the admitted words.
  heygen: async (voicing) => {
    const { LiveAvatarFace, browserLiveAvatarDeps } = await import('./embodiment/liveavatar');
    return new LiveAvatarFace(await browserLiveAvatarDeps(), {
      voicing: voicing === 'text' ? 'text' : 'audio',
      provider: 'heygen',
    });
  },
};

/**
 * A vendor face's adapter for the session's voicing, or null when this build has none for it (the call keeps the
 * presence).
 */
export async function loadAvatarProvider(
  id: EmbodimentProviderId,
  voicing: AvatarVoicing = 'audio',
): Promise<AvatarProvider | null> {
  const load = VENDOR_FACES[id];
  if (load === undefined) return null;
  try {
    return await load(voicing);
  } catch {
    // A chunk that failed to load (offline, a new deploy): the presence instead.
    return null;
  }
}
