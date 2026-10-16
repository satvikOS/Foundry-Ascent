/**
 * Call-minute accounting from the turns people spoke (no separate call records exist: a call is the stream of
 * spoken turns of one conversation). A call is a run of spoken turns with no gap longer than
 * {@link CALL_GAP_SECONDS}; it lasts from its first spoken turn to its last one plus {@link CALL_TAIL_SECONDS}
 * for the final answer, or until now while it is still going.
 */
export const CALL_GAP_SECONDS = 10 * 60;
export const CALL_TAIL_SECONDS = 60;

export interface VoiceTurnTime {
  readonly sessionId: string;
  /** ISO time the spoken turn was sent. */
  readonly at: string;
}

export interface CallSegment {
  readonly sessionId: string;
  readonly startedAt: number;
  readonly lastTurnAt: number;
  /** Still going: the last spoken turn is within the gap of `now`. */
  readonly ongoing: boolean;
  readonly minutes: number;
}

export interface CallUsage {
  readonly segments: readonly CallSegment[];
  /** Minutes the person spent in calls today (UTC day of the turns given). */
  readonly minutesToday: number;
}

/** Splits spoken turns into calls and measures them (pure; unit tested). */
export function measureCalls(turns: readonly VoiceTurnTime[], now: Date): CallUsage {
  const nowMs = now.getTime();
  const bySession = new Map<string, number[]>();
  for (const turn of turns) {
    const at = Date.parse(turn.at);
    if (Number.isNaN(at)) continue;
    const list = bySession.get(turn.sessionId) ?? [];
    list.push(at);
    bySession.set(turn.sessionId, list);
  }
  const segments: CallSegment[] = [];
  for (const [sessionId, times] of bySession) {
    times.sort((a, b) => a - b);
    let start = times[0] ?? 0;
    let last = start;
    const close = (ongoing: boolean): void => {
      const end = ongoing ? Math.max(nowMs, last) : last + CALL_TAIL_SECONDS * 1000;
      segments.push({
        sessionId,
        startedAt: start,
        lastTurnAt: last,
        ongoing,
        minutes: (end - start) / 60_000,
      });
    };
    for (const at of times.slice(1)) {
      if (at - last > CALL_GAP_SECONDS * 1000) {
        close(false);
        start = at;
      }
      last = at;
    }
    close(nowMs - last <= CALL_GAP_SECONDS * 1000);
  }
  return { segments, minutesToday: segments.reduce((sum, s) => sum + s.minutes, 0) };
}

/** Minutes of the call going on in a conversation now (0 when none is). */
export function currentCallMinutes(usage: CallUsage, sessionId: string): number {
  return usage.segments.find((s) => s.sessionId === sessionId && s.ongoing)?.minutes ?? 0;
}

/** Minutes left today under the daily cap (never negative, one decimal). */
export function remainingCallMinutes(usage: CallUsage, dailyCap: number): number {
  return Math.max(0, Math.floor((dailyCap - usage.minutesToday) * 10) / 10);
}
