import { useCallback, useState } from 'react';

import type { TalkMode } from '@/lib/realtime/call-engine';
import { safeStorage } from '@/lib/storage';

/** Per-viewer call preferences (UI only, never content). */
const KEYS = {
  captions: 'fa.call.captions',
  talkMode: 'fa.call.talk-mode',
} as const;

export function storedTalkMode(): TalkMode {
  return safeStorage.get(KEYS.talkMode) === 'push_to_talk' ? 'push_to_talk' : 'hands_free';
}

export function storeTalkMode(mode: TalkMode): void {
  safeStorage.set(KEYS.talkMode, mode);
}

/** Captions are on unless the person turned them off (the choice sticks across calls). */
export function useCaptionsPreference(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => safeStorage.get(KEYS.captions) !== '0');
  const update = useCallback((next: boolean) => {
    safeStorage.set(KEYS.captions, next ? '1' : '0');
    setOn(next);
  }, []);
  return [on, update];
}
