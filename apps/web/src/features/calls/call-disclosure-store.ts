import { useCallback, useSyncExternalStore } from 'react';

import { safeStorage } from '@/lib/storage';

import type { CallKind } from './call-kind';

/*
 * The disclosure read before the first call of each kind (call-disclosure.tsx), remembered per person in this
 * browser: a versioned key, so new facts are shown again once. The person may re-read it from the call settings.
 */
const DISCLOSURE_VERSION = 1;

export function disclosureKey(principalId: string, kind: CallKind): string {
  return `fa.call.disclosure.v${String(DISCLOSURE_VERSION)}.${kind}.${principalId}`;
}

const listeners = new Set<() => void>();
/** Acknowledged in this page view though the browser would not store it (storage disabled). */
const unstored = new Set<string>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function disclosureSeen(principalId: string, kind: CallKind): boolean {
  const key = disclosureKey(principalId, kind);
  return unstored.has(key) || safeStorage.get(key) !== null;
}

export function acknowledgeDisclosure(principalId: string, kind: CallKind): void {
  const key = disclosureKey(principalId, kind);
  if (disclosureSeen(principalId, kind)) return;
  safeStorage.set(key, new Date().toISOString());
  if (safeStorage.get(key) === null) unstored.add(key);
  for (const listener of [...listeners]) listener();
}

/** Whether this person has read the disclosure for this kind of call, and a way to say they have. */
export function useCallDisclosure(
  principalId: string,
  kind: CallKind,
): [seen: boolean, acknowledge: () => void] {
  const seen = useSyncExternalStore(
    subscribe,
    () => disclosureSeen(principalId, kind),
    () => true,
  );
  const acknowledge = useCallback(() => {
    acknowledgeDisclosure(principalId, kind);
  }, [principalId, kind]);
  return [seen, acknowledge];
}
