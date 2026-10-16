import { useCallback, useSyncExternalStore } from 'react';

import type { TalkMode } from '@/lib/realtime/call-engine';
import { safeStorage } from '@/lib/storage';

/**
 * Per-viewer call preferences (UI only, never content), kept in this browser. Components that show the same
 * preference (the dock's captions toggle, the call settings menu) stay in step through one small store.
 */
const KEYS = {
  captions: 'fa.call.captions',
  captionSize: 'fa.call.caption-size',
  announceCaptions: 'fa.call.announce-captions',
  talkMode: 'fa.call.talk-mode',
  voiceNotice: 'fa.call.voice-notice',
} as const;

const listeners = new Set<() => void>();
/** Choices the browser would not store (storage disabled or full): they hold for this page view. */
const unstored = new Map<string, string>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function read(key: string): string | null {
  return unstored.get(key) ?? safeStorage.get(key);
}

function write(key: string, value: string): void {
  safeStorage.set(key, value);
  if (safeStorage.get(key) === value) unstored.delete(key);
  else unstored.set(key, value);
  for (const listener of listeners) listener();
}

function useStored(key: string): string | null {
  return useSyncExternalStore(subscribe, () => read(key));
}

export function storedTalkMode(): TalkMode {
  return read(KEYS.talkMode) === 'push_to_talk' ? 'push_to_talk' : 'hands_free';
}

export function storeTalkMode(mode: TalkMode): void {
  write(KEYS.talkMode, mode);
}

/** Captions are on unless the person turned them off (the choice sticks across calls). */
export function useCaptionsPreference(): [boolean, (on: boolean) => void] {
  const on = useStored(KEYS.captions) !== '0';
  const update = useCallback((next: boolean) => {
    write(KEYS.captions, next ? '1' : '0');
  }, []);
  return [on, update];
}

export type CaptionSize = 'sm' | 'md' | 'lg';

export const CAPTION_SIZES: readonly { readonly value: CaptionSize; readonly label: string }[] = [
  { value: 'sm', label: 'Small' },
  { value: 'md', label: 'Medium' },
  { value: 'lg', label: 'Large' },
];

export function useCaptionSize(): [CaptionSize, (size: CaptionSize) => void] {
  const stored = useStored(KEYS.captionSize);
  const size: CaptionSize = stored === 'sm' || stored === 'lg' ? stored : 'md';
  const update = useCallback((next: CaptionSize) => {
    write(KEYS.captionSize, next);
  }, []);
  return [size, update];
}

/**
 * Whether a screen reader reads the vEIR's captions as they change. Off by default: the vEIR's voice and a
 * screen reader would talk over each other. On for people who follow the call by screen reader.
 */
export function useAnnounceCaptions(): [boolean, (on: boolean) => void] {
  const on = useStored(KEYS.announceCaptions) === '1';
  const update = useCallback((next: boolean) => {
    write(KEYS.announceCaptions, next ? '1' : '0');
  }, []);
  return [on, update];
}

/**
 * Whether this person has seen how a call handles their voice (the first call shows it before starting).
 * Kept per browser until the acknowledgement is stored with the person's account.
 */
export function useVoiceNoticeSeen(): [boolean, () => void] {
  const seen = useStored(KEYS.voiceNotice) === '1';
  const acknowledge = useCallback(() => {
    write(KEYS.voiceNotice, '1');
  }, []);
  return [seen, acknowledge];
}
