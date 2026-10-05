/**
 * Rehearsal counterpart chosen in the start-session dialog, handed to the session canvas. Kept in
 * memory only (never persisted to storage): it describes a role such as "Seed investor", and the
 * composer shows it so it can be changed at any time. Reads are non-destructive so React StrictMode's
 * double-invoked state initialisers see the same value.
 */
const pending = new Map<string, string>();

export function setPendingCounterpart(sessionId: string, counterpart: string): void {
  const value = counterpart.trim();
  if (value) pending.set(sessionId, value);
}

export function pendingCounterpart(sessionId: string): string | null {
  return pending.get(sessionId) ?? null;
}

export function clearPendingCounterpart(sessionId: string): void {
  pending.delete(sessionId);
}
