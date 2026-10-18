/**
 * Decides when the founder has finished speaking in hands-free mode: the transcript is stable (Transcribe
 * finalised the segment, every word of the partial is marked stable, or the partial stopped changing) and
 * the microphone has been quiet for `silenceMs`. Pure apart from the injected clock, so it is unit tested
 * with a fake one.
 */

/** One Transcribe result: a segment that is still changing (partial) or finished. */
export interface TranscriptResult {
  readonly resultId: string;
  readonly text: string;
  readonly partial: boolean;
  /** Every word carries Transcribe's partial-results-stabilisation "Stable" flag. */
  readonly stable: boolean;
  /**
   * The leading words Transcribe already marked "Stable" (it will not revise them): the whole text of a finished
   * segment, '' when none (or when the transcriber does not say). One of them that is not a backchannel is the
   * founder taking the floor.
   */
  readonly stableText?: string;
}

export interface EndpointerOptions {
  /** Quiet time after the last voiced frame before a turn ends (about 600 ms feels conversational). */
  readonly silenceMs: number;
}

export const DEFAULT_SILENCE_MS = 600;

function words(text: string): string[] {
  return text
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** The words of `text` that come after the already-used `prefix` (null when `text` does not extend it). */
function suffixAfter(prefix: string, text: string): string | null {
  const used = words(prefix);
  const raw = text.trim().split(/\s+/).filter(Boolean);
  const normalised = raw.map((w) => words(w).join(''));
  for (let i = 0; i < used.length; i++) if (normalised[i] !== used[i]) return null;
  return raw.slice(used.length).join(' ');
}

interface Segment {
  text: string;
  partial: boolean;
  stable: boolean;
  changedAt: number;
}

export class Endpointer {
  private readonly segments = new Map<string, Segment>();
  /** Segments already sent as (part of) a turn, with the text that was used. */
  private readonly consumed = new Map<string, string>();
  private lastVoiceAt = Number.NEGATIVE_INFINITY;
  private readonly silenceMs: number;

  constructor(
    private readonly now: () => number,
    options: Partial<EndpointerOptions> = {},
  ) {
    this.silenceMs = options.silenceMs ?? DEFAULT_SILENCE_MS;
  }

  /** A transcript update. Updates of a segment already used for a turn only count for new trailing words. */
  onResult(result: TranscriptResult): void {
    let id = result.resultId;
    let text = result.text.trim();
    const used = this.consumed.get(id);
    if (used !== undefined) {
      const suffix = suffixAfter(used, text);
      if (suffix === null || suffix === '') return;
      id = `${id}#${String(words(used).length)}`;
      text = suffix;
    }
    const previous = this.segments.get(id);
    if (text === '') {
      this.segments.delete(id);
      return;
    }
    this.segments.set(id, {
      text,
      partial: result.partial,
      stable: result.stable,
      changedAt: previous?.text === text ? previous.changedAt : this.now(),
    });
  }

  /** A voiced microphone frame (from the VAD). */
  onVoice(): void {
    this.lastVoiceAt = this.now();
  }

  /** Everything heard since the last turn, in order. */
  text(): string {
    return [...this.segments.values()]
      .map((s) => s.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  hasSpeech(): boolean {
    return this.text() !== '';
  }

  /** Whether the founder has finished: stable transcript plus `silenceMs` of quiet. */
  isComplete(): boolean {
    if (!this.hasSpeech()) return false;
    const now = this.now();
    if (now - this.lastVoiceAt < this.silenceMs) return false;
    for (const segment of this.segments.values()) {
      if (!segment.partial || segment.stable) continue;
      if (now - segment.changedAt < this.silenceMs) return false;
    }
    return true;
  }

  /** Takes the utterance (marking its segments as used) and starts listening for the next one. */
  take(): string {
    const text = this.text();
    for (const [id, segment] of this.segments) {
      const base = id.split('#')[0] ?? id;
      const previous = this.consumed.get(base);
      this.consumed.set(base, previous === undefined ? segment.text : `${previous} ${segment.text}`);
    }
    this.segments.clear();
    if (this.consumed.size > 64) {
      // Old segments never update again; keep the map small on long calls.
      const keep = [...this.consumed.entries()].slice(-16);
      this.consumed.clear();
      for (const [id, value] of keep) this.consumed.set(id, value);
    }
    return text;
  }

  /** Drops what was heard without sending it (mute, switching to typing). */
  discard(): void {
    this.take();
  }

  /**
   * Forgets the segments `keep` rejects (the vEIR's echo, a backchannel), keeping the rest. A forgotten
   * segment Transcribe revises later is heard afresh.
   */
  retain(keep: (text: string) => boolean): void {
    for (const [id, segment] of this.segments) if (!keep(segment.text)) this.segments.delete(id);
  }
}

/**
 * Sounds people make to show they are listening, not to take the floor ("yeah", "mm-hmm", "right", "got it",
 * "I see"). Said while the vEIR speaks, they neither cut it off nor become a turn of their own. Never an opener of
 * a turn such as "sorry", "wait", "but" or "actually": "Sorry to cut in" takes the floor (LAB-V4).
 */
const BACKCHANNELS: ReadonlySet<string> = new Set([
  'ah',
  'aha',
  'cool',
  'exactly',
  'got',
  'great',
  'hm',
  'hmm',
  'huh',
  'i',
  'it',
  'mhm',
  'mm',
  'mmhmm',
  'mmm',
  'nice',
  'oh',
  'ok',
  'okay',
  'right',
  'see',
  'sure',
  'totally',
  'true',
  'uh',
  'uhhuh',
  'um',
  'wow',
  'yeah',
  'yep',
  'yes',
  'yup',
]);

/**
 * The words of what the founder said that can only mean they are taking the floor: not the vEIR's own voice
 * coming back through the speakers (every word of `spoken`, what it has said of this reply so far; echo
 * cancellation catches most of it) and not a backchannel.
 */
export function floorWords(heard: string, spoken: string): string[] {
  const echo = new Set(words(spoken));
  return words(heard).filter((word) => !echo.has(word) && !BACKCHANNELS.has(word));
}

/**
 * How long the founder's voice runs on while the vEIR speaks before it is taken as them taking the floor, words
 * or not (the transcript lags the voice by a second or more). Backchannels are shorter: "yeah" or "okay" about
 * 300 ms, "mm-hmm" about 500 ms. The lab measured 2.0 s from the start of a barge-in to the reply stopping, while
 * the stop waited for confirmed words (LAB-V4); with this, about 0.8 s.
 */
export const BARGE_SUSTAIN_MS = 700;
/** A pause longer than this ends a run of voice (the gaps between words are shorter). */
export const BARGE_GAP_MS = 250;
/** A single unsettled word that is not a backchannel takes the floor once the voice has run this long. */
export const BARGE_WORD_SUSTAIN_MS = 300;

/**
 * One run of the founder's voice while the vEIR speaks, from the VAD's frames: how long it has gone on, with the
 * short gaps between words inside it. Pure apart from the injected clock.
 */
export class VoiceRun {
  private startedAt: number | null = null;
  private lastVoicedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly now: () => number,
    private readonly gapMs = BARGE_GAP_MS,
  ) {}

  /** A microphone frame; returns how long the current run has gone on (0 when there is none). */
  frame(voiced: boolean): number {
    const now = this.now();
    if (voiced) {
      if (this.startedAt === null || now - this.lastVoicedAt > this.gapMs) this.startedAt = now;
      this.lastVoicedAt = now;
    } else if (this.startedAt !== null && now - this.lastVoicedAt > this.gapMs) {
      this.startedAt = null;
    }
    return this.duration();
  }

  /** How long the current run has gone on (ms), 0 when the founder is quiet. */
  duration(): number {
    if (this.startedAt === null || this.now() - this.lastVoicedAt > this.gapMs) return 0;
    return this.lastVoicedAt - this.startedAt;
  }

  reset(): void {
    this.startedAt = null;
    this.lastVoicedAt = Number.NEGATIVE_INFINITY;
  }
}
