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
}

/**
 * Whether a partial is probably the vEIR's own voice coming back through the speakers: every word of it
 * appears in what is being played. Echo cancellation catches most of it; this keeps the rest from cutting
 * the vEIR off.
 */
export function isLikelyEcho(partial: string, playing: string | null): boolean {
  const heard = words(partial);
  if (heard.length === 0) return true;
  if (playing === null) return false;
  const spoken = new Set(words(playing));
  return heard.every((word) => spoken.has(word));
}
