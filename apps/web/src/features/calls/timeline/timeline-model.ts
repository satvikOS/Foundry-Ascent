/**
 * The conversation timeline's data (design-spec §10.2): who spoke when, and how loud, as 10 Hz RMS bins. In memory
 * only and bounded: envelopes are never sent to the server or stored. A recorder is fed by the live call (or, on
 * the landing page, by a recorded envelope); a past session without measured audio becomes a timeline of turns
 * with no amplitude at all, which draws as a flat midline instead of invented bars.
 */

export type Speaker = 'veir' | 'student';

export interface TimelineTurn {
  readonly id: string;
  readonly speaker: Speaker;
  /** Milliseconds from the start of the timeline. */
  readonly startMs: number;
  /** Null while the turn is still going. */
  readonly endMs: number | null;
  /** 10 Hz RMS (0–1), one per bin since `startMs`. Empty when no amplitude was measured (a past session). */
  readonly bins: readonly number[];
  /** The words of the turn, when known (the captions already on screen; never stored). */
  readonly text: string;
}

/** What the timeline component reads. `subscribe` fires whenever a bin lands or a turn opens, closes or changes. */
export interface TimelineSource {
  readonly subscribe: (listener: () => void) => () => void;
  /** Bumps whenever turns are added, closed or annotated (not on every bin): React re-renders only on these. */
  readonly structure: () => number;
  readonly turns: () => readonly TimelineTurn[];
  /** How much time the timeline covers (ms): the latest bin's end. */
  readonly elapsedMs: () => number;
  /** False for a past session: segments only, a flat midline instead of bars. */
  readonly measured: boolean;
}

export const BIN_MS = 100;
/** A speaker's silence shorter than this stays inside their turn (a breath, the gap between two sentences). */
export const MERGE_GAP_MS = 800;
/** The call cap is 30 minutes: at 10 Hz for both speakers, at most this many bins are kept. */
export const MAX_BINS = 18_000;

/** The end of a turn as drawn: its close, or (still going) the end of its latest bin. */
export function turnEnd(turn: TimelineTurn, binMs = BIN_MS): number {
  return turn.endMs ?? turn.startMs + turn.bins.length * binMs;
}

interface MutableTurn {
  id: string;
  speaker: Speaker;
  startMs: number;
  endMs: number | null;
  bins: number[];
  text: string;
}

/** The current bin's running sums for each speaker heard in it. */
interface Accumulator {
  sum: number;
  frames: number;
}

/**
 * Builds a timeline from levels. `sample()` takes one animation frame of a live call (it averages the frames of
 * each 100 ms into a bin); `step()` appends one finished bin directly (a recorded envelope, a test).
 */
export class TimelineRecorder implements TimelineSource {
  readonly measured = true;
  private list: MutableTurn[] = [];
  private open: Record<Speaker, MutableTurn | null> = { veir: null, student: null };
  /** Silent bins since each open turn last heard its speaker. */
  private silent: Record<Speaker, number> = { veir: 0, student: 0 };
  private acc: Record<Speaker, Accumulator> = {
    veir: { sum: 0, frames: 0 },
    student: { sum: 0, frames: 0 },
  };
  /** Words announced for a speaker's next turn, before its first bin opened it. */
  private pending: Record<Speaker, string> = { veir: '', student: '' };
  private startedAt: number | null = null;
  private binStart = 0;
  private bins = 0;
  private stored = 0;
  private version = 0;
  private sequence = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly options: {
      readonly binMs?: number;
      readonly mergeGapMs?: number;
      readonly maxBins?: number;
    } = {},
  ) {}

  private get binMs(): number {
    return this.options.binMs ?? BIN_MS;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  structure = (): number => this.version;

  turns = (): readonly TimelineTurn[] => this.list;

  elapsedMs = (): number => this.bins * this.binMs;

  /**
   * One animation frame of a live call. `now` is a monotonic time in ms; each speaker is their measured level
   * while they are speaking, or null. A long gap (the page was hidden, the call on hold) closes open turns.
   */
  sample(now: number, levels: { readonly veir: number | null; readonly student: number | null }): void {
    if (this.startedAt === null) {
      this.startedAt = now;
      this.binStart = now;
    }
    if (now - this.binStart > this.binMs * 10) {
      // Frames stopped for a while (hidden page, hold): nothing was heard in that time.
      this.flush();
      const missed = Math.floor((now - this.binStart) / this.binMs) - 1;
      for (let i = 0; i < missed; i++) this.step({ veir: null, student: null }, false);
      this.binStart = now;
      this.notify();
    }
    // A frame at or past the bin's end belongs to the next bin: close the current one first.
    if (now - this.binStart >= this.binMs) {
      this.flush();
      this.binStart += this.binMs;
      if (now - this.binStart >= this.binMs) this.binStart = now;
    }
    for (const speaker of ['veir', 'student'] as const) {
      const level = levels[speaker];
      if (level === null) continue;
      this.acc[speaker].sum += Number.isFinite(level) ? Math.max(0, level) : 0;
      this.acc[speaker].frames += 1;
    }
  }

  /** Closes the current bin from the frames averaged into it. */
  private flush(): void {
    const mean = (speaker: Speaker): number | null => {
      const { sum, frames } = this.acc[speaker];
      return frames > 0 ? Math.min(1, sum / frames) : null;
    };
    const bin = { veir: mean('veir'), student: mean('student') };
    this.acc = { veir: { sum: 0, frames: 0 }, student: { sum: 0, frames: 0 } };
    this.step(bin);
  }

  /** Appends one bin: each speaker's level in it, or null when they were not speaking. */
  step(bin: { readonly veir: number | null; readonly student: number | null }, notify = true): void {
    const t = this.bins * this.binMs;
    let changed = false;
    for (const speaker of ['veir', 'student'] as const) {
      const level = bin[speaker];
      const other: Speaker = speaker === 'veir' ? 'student' : 'veir';
      const open = this.open[speaker];
      if (level !== null) {
        // The other speaker, silent now, ends where they were last heard: turns never overlap a handover.
        if (this.open[other] && this.silent[other] > 0) {
          this.close(other);
          changed = true;
        }
        if (open) {
          for (let i = 0; i < this.silent[speaker]; i++) open.bins.push(0);
          this.stored += this.silent[speaker];
          open.bins.push(level);
        } else {
          this.sequence += 1;
          const turn: MutableTurn = {
            id: `${speaker}-${String(this.sequence)}`,
            speaker,
            startMs: t,
            endMs: null,
            bins: [level],
            text: this.pending[speaker],
          };
          this.pending[speaker] = '';
          this.list.push(turn);
          this.open[speaker] = turn;
          changed = true;
        }
        this.stored += 1;
        this.silent[speaker] = 0;
      } else if (open) {
        this.silent[speaker] += 1;
        if (this.silent[speaker] * this.binMs >= (this.options.mergeGapMs ?? MERGE_GAP_MS)) {
          this.close(speaker);
          changed = true;
        }
      }
    }
    this.bins += 1;
    this.trim();
    if (changed) this.version += 1;
    if (notify) this.notify();
  }

  private close(speaker: Speaker): void {
    const open = this.open[speaker];
    if (!open) return;
    open.endMs = open.startMs + open.bins.length * this.binMs;
    this.open[speaker] = null;
    this.silent[speaker] = 0;
  }

  /** Drops the oldest turns beyond the cap (a call never runs past it; this bounds memory regardless). */
  private trim(): void {
    const max = this.options.maxBins ?? MAX_BINS;
    while (this.stored > max && this.list.length > 1) {
      const dropped = this.list.shift();
      if (!dropped) break;
      this.stored -= dropped.bins.length;
      if (this.open[dropped.speaker] === dropped) this.open[dropped.speaker] = null;
      this.version += 1;
    }
  }

  /**
   * Adds words to a turn. `upcoming` (the vEIR's sentence as it starts playing): to the speaker's open turn, or to
   * the next one they open, which the first bin starts a moment later. Otherwise (the founder's line, final once
   * they stopped): to their latest turn, if it ended no longer than `withinMs` ago.
   */
  annotate(
    speaker: Speaker,
    text: string,
    options: { readonly upcoming?: boolean; readonly withinMs?: number } = {},
  ): void {
    const words = text.trim();
    if (!words) return;
    let turn: MutableTurn | undefined;
    if (options.upcoming) {
      turn = this.open[speaker] ?? undefined;
      if (!turn) {
        this.pending[speaker] = this.pending[speaker] ? `${this.pending[speaker]} ${words}` : words;
        return;
      }
    } else {
      turn = this.list.findLast((candidate) => candidate.speaker === speaker);
      if (!turn || this.elapsedMs() - turnEnd(turn, this.binMs) > (options.withinMs ?? 6_000)) return;
    }
    turn.text = turn.text ? `${turn.text} ${words}` : words;
    this.version += 1;
    this.notify();
  }

  /** Closes every open turn (the call ended). */
  finish(): void {
    let changed = false;
    for (const speaker of ['veir', 'student'] as const) {
      if (!this.open[speaker]) continue;
      // Trailing silence is not part of the turn.
      this.close(speaker);
      changed = true;
    }
    if (changed) {
      this.version += 1;
      this.notify();
    }
  }

  /** Forgets everything (a new call). */
  reset(): void {
    this.list = [];
    this.open = { veir: null, student: null };
    this.silent = { veir: 0, student: 0 };
    this.acc = { veir: { sum: 0, frames: 0 }, student: { sum: 0, frames: 0 } };
    this.pending = { veir: '', student: '' };
    this.startedAt = null;
    this.binStart = 0;
    this.bins = 0;
    this.stored = 0;
    this.version += 1;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/**
 * A past session's timeline from its turns' times alone: segments with no amplitude (drawn as a flat midline). We
 * do not invent a waveform for audio we did not measure.
 */
export function pastTimeline(
  turns: readonly {
    readonly speaker: Speaker;
    readonly startMs: number;
    readonly endMs: number;
    readonly text?: string;
  }[],
): TimelineSource {
  const list: TimelineTurn[] = turns
    .filter(
      (turn) => Number.isFinite(turn.startMs) && Number.isFinite(turn.endMs) && turn.endMs > turn.startMs,
    )
    .map((turn, index) => ({
      id: `${turn.speaker}-${String(index + 1)}`,
      speaker: turn.speaker,
      startMs: turn.startMs,
      endMs: turn.endMs,
      bins: [],
      text: turn.text ?? '',
    }));
  const elapsed = list.reduce((max, turn) => Math.max(max, turn.endMs ?? 0), 0);
  return {
    measured: false,
    subscribe: () => () => undefined,
    structure: () => 0,
    turns: () => list,
    elapsedMs: () => elapsed,
  };
}
