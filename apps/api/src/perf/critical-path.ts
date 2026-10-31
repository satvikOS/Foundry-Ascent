import { type TracedRoundTrip } from './rig.js';
import { type TurnSample } from './scenarios.js';

/**
 * The database round trips a request waited for one after another (docs/runbooks/latency.md, "Round trips before
 * the stream and the first spoken unit"). On the RDS Data API every statement, begin and commit is one HTTPS call, so
 * the time a request spends on the database before a moment is the number of round trips it made in sequence, not
 * the number it made.
 */
export interface TimedRoundTrip {
  /** `performance.now()` when the round trip was sent. */
  readonly start: number;
  /** `performance.now()` when it was answered. */
  readonly end: number;
}

/**
 * The longest run of round trips, each sent once the one before it had been answered, among those answered by
 * `until` (a `performance.now()` time). Round trips that overlap count once per run, so work done alongside (another
 * transaction, a write handed to the host) adds nothing unless it is longer than what it ran beside.
 *
 * Read it on a run whose other waits are zero (the model, the embedding): a round trip sent and answered while the
 * request waited for something else (a commit nobody waits for, during the model's first token) would otherwise
 * extend the run it follows. With those waits at zero, such a round trip is still in flight at the moment measured.
 */
export function sequentialRoundTrips(trips: readonly TimedRoundTrip[], until: number): number {
  const done = trips.filter((t) => t.end <= until).sort((a, b) => a.end - b.end);
  const depth: number[] = [];
  let longest = 0;
  for (let i = 0; i < done.length; i += 1) {
    const trip = done[i];
    if (trip === undefined) continue;
    let before = 0;
    for (let j = 0; j < i; j += 1) {
      const earlier = done[j];
      if (earlier !== undefined && earlier.end <= trip.start) before = Math.max(before, depth[j] ?? 0);
    }
    depth[i] = before + 1;
    longest = Math.max(longest, before + 1);
  }
  return longest;
}

/** The round trips one turn waited for one after another, to two moments. */
export interface SequentialSample {
  readonly channel: TurnSample['channel'];
  /** To the response headers (the stream opened). */
  readonly streamOpen: number;
  /** To the first spoken unit (`turn.speech`; null on a typed turn). */
  readonly firstSpeech: number | null;
  /** To the first validated sentence (`turn.delta`). */
  readonly firstDelta: number | null;
}

/** The round trips `turn` waited for one after another, to its stream opening and its first spoken unit. */
export function sequentialOf(queries: readonly TracedRoundTrip[], turn: TurnSample): SequentialSample {
  const trips = queries.filter((q) => q.requestId === turn.requestId);
  const at = (ms: number | null): number | null =>
    ms === null ? null : sequentialRoundTrips(trips, turn.sentAt + ms);
  return {
    channel: turn.channel,
    streamOpen: sequentialRoundTrips(trips, turn.sentAt + turn.headersMs),
    firstSpeech: at(turn.firstSpeechMs),
    firstDelta: at(turn.firstDeltaMs),
  };
}
