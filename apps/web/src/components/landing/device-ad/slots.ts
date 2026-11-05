import type { ComponentType } from 'react';

import { createAvatarProvider, type AvatarProvider } from '@/lib/realtime/avatar';

import { AdTimeline, type TimelineSlotProps } from './timeline';

/**
 * Where the call's own voice surface plugs into the landing page (the device ad's phone and the voice demo). The
 * defaults are today's: the call's presence provider, with the vEIR's monogram inside it, and the ad's timeline.
 * A new presence (any `AvatarProvider`) or timeline (the same turns) drops in here without touching the sequence.
 */
export interface VoiceSlots {
  createPresence: () => AvatarProvider;
  /** The monogram sits inside the presence (the ring presence) rather than as a badge under it. */
  monogramInside: boolean;
  Timeline: ComponentType<TimelineSlotProps>;
}

export const DEFAULT_VOICE_SLOTS: VoiceSlots = {
  createPresence: () => createAvatarProvider('builtin'),
  monogramInside: true,
  Timeline: AdTimeline,
};

/** A device the app has marked slow (`data-perf="low"` on the root) gets still final frames. */
export function slowDevice(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.perf === 'low';
}
