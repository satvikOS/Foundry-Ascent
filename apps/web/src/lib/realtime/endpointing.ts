/**
 * Decides when the founder has finished speaking in hands-free mode: the transcript is stable (Transcribe
 * finalised the segment, every word of the partial is marked stable, or the partial stopped changing) and
 * the microphone has been quiet long enough for what was heard (adaptive endpointing, docs/runbooks/latency.md
 * "End of speech"): a finished sentence, a question or a short answer goes after about 300 ms of quiet, a line that
 * reads as finished without either after 500 ms, and one left open (a filler such as "um", a conjunction, "I mean",
 * a trailing comma, a fragment) only after 950 ms, so a slower speaker is not cut off mid-thought. Pure apart from the
 * injected clock, so it is unit tested with a fake one.
 */
import type { EndpointReason } from '@foundry/contracts';

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

export type { EndpointReason };

/** How finished a line reads: `complete` goes at once, `open` after a short pause, `incomplete` waits. */
export type EndpointClass = 'complete' | 'open' | 'incomplete';

export interface EndpointerOptions {
  /**
   * `adaptive` (the default): the quiet required follows what was heard. `fixed`: `silenceMs` whatever was heard
   * (the switch back, and the baseline the fixtures measure against).
   */
  readonly mode: 'adaptive' | 'fixed';
  /** Fixed mode's quiet time after the last voiced frame (about 600 ms feels conversational). */
  readonly silenceMs: number;
  /** A finished sentence, a question or a short answer. */
  readonly completeMs: number;
  /** A line that reads as finished but says nothing more about it. */
  readonly openMs: number;
  /** A line left open (filler, conjunction, self-correction, trailing comma, fragment). */
  readonly incompleteMs: number;
}

export const DEFAULT_SILENCE_MS = 600;

export const DEFAULT_ENDPOINTER: EndpointerOptions = {
  mode: 'adaptive',
  silenceMs: DEFAULT_SILENCE_MS,
  completeMs: 300,
  openMs: 500,
  incompleteMs: 950,
};

/**
 * In adaptive mode, how long a partial Transcribe has not marked stable must have stopped changing (at most the
 * wait itself): a revision after the send is caught by the call engine (it takes the turn back and merges).
 */
const SETTLE_MS = 250;
/**
 * The transcript is behind the voice when its last result came this long before the last voiced frame: words were
 * said that it has not shown yet, so the fixed silence applies (never quicker than before adaptive endpointing).
 */
const CATCH_UP_MS = 200;

/** A finished-turn decision: why, the quiet it required, and the quiet there was (null: no voiced frame seen). */
export interface EndpointDecision {
  readonly reason: EndpointReason;
  readonly class: EndpointClass;
  readonly waitMs: number;
  readonly quietMs: number | null;
}

function words(text: string): string[] {
  return text
    .toLocaleLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Sounds that hold the floor while the speaker thinks: the line goes on after them. */
const FILLERS: ReadonlySet<string> = new Set([
  'um',
  'umm',
  'uhm',
  'uh',
  'uhh',
  'er',
  'erm',
  'ehm',
  'hmm',
  'mm',
]);

/**
 * Words a finished English sentence almost never ends on: conjunctions, articles, a possessive before its noun, a
 * subject pronoun before its verb, the prepositions "to" and "of", a copula ("the main thing is …") and contractions
 * of one. Ambiguous ones ("that", "in", "on", "with", "did", "can") are left out: a sentence ends on them often
 * enough. A finished line that does end on one ("that's how it is") only waits longer.
 */
const CONTINUATIONS: ReadonlySet<string> = new Set([
  'and',
  'but',
  'or',
  'nor',
  'so',
  'because',
  'cause',
  'cuz',
  'although',
  'whereas',
  'unless',
  'until',
  'if',
  'than',
  'whether',
  'which',
  'whose',
  'plus',
  'is',
  'are',
  'was',
  'were',
  'am',
  'the',
  'a',
  'an',
  'to',
  'of',
  'into',
  'onto',
  'via',
  'per',
  'my',
  'our',
  'your',
  'their',
  'i',
  'we',
  'they',
  'he',
  'she',
  "i'm",
  "we're",
  "they're",
  "you're",
  "he's",
  "she's",
  "it's",
  "there's",
  "that's",
  "what's",
  "let's",
  "i've",
  "we've",
  "i'd",
  "we'd",
  "i'll",
  "we'll",
  'gonna',
  'wanna',
  'gotta',
]);

/** "I think so", "I hope so": a finished line that ends on "so". */
const SO_ENDS: ReadonlySet<string> = new Set([
  'think',
  'hope',
  'guess',
  'believe',
  'suppose',
  'said',
  'say',
  'imagine',
  'expect',
  'afraid',
  'thought',
  'if',
  'even',
]);

/** Answers that are a whole turn on their own. */
const SHORT_ANSWERS: ReadonlySet<string> = new Set([
  'yes',
  'yeah',
  'yep',
  'yup',
  'no',
  'nope',
  'nah',
  'sure',
  'okay',
  'ok',
  'right',
  'exactly',
  'correct',
  'maybe',
  'perhaps',
  'probably',
  'definitely',
  'absolutely',
  'totally',
  'thanks',
  'thank',
  'you',
  'hi',
  'hello',
  'hey',
  'true',
  'agreed',
  'perfect',
  'great',
  'cool',
  'done',
  'fine',
  'good',
  'never',
  'always',
  'both',
  'neither',
  'none',
  'of',
  'course',
  'not',
  'really',
  'bye',
  'goodbye',
]);

/** Words that open a question (on their own, or after "so", "and", "but", "okay", "well"). */
const QUESTION_OPENERS: ReadonlySet<string> = new Set([
  'what',
  "what's",
  'how',
  "how's",
  'why',
  'when',
  'where',
  'who',
  'which',
  'whose',
  'can',
  'could',
  'should',
  'would',
  'will',
  'shall',
  'do',
  'does',
  'did',
  'is',
  'are',
  'was',
  'were',
  'have',
  'has',
  'may',
  'might',
  "isn't",
  "aren't",
  "don't",
  "doesn't",
  "didn't",
  "won't",
  "wouldn't",
  "shouldn't",
  "couldn't",
  "can't",
  'any',
]);
const LEAD_INS: ReadonlySet<string> = new Set(['so', 'and', 'but', 'okay', 'ok', 'well', 'then', 'also']);

/** Self-corrections that go on: "fifty, I mean …", "twelve, sorry …", "or rather …". */
function selfCorrection(tokens: readonly string[]): boolean {
  const last = tokens.at(-1);
  const previous = tokens.at(-2);
  if (last === 'mean' && previous === 'i') return true;
  if (last === 'rather' && previous === 'or') return true;
  return last === 'sorry' && tokens.length > 1;
}

/**
 * How finished a line reads, from its words and the punctuation Transcribe gave it. What it ends on decides first
 * (Transcribe's final result puts a full stop even after a trailing "and"), then the punctuation, then its shape.
 */
export function classifyUtterance(text: string): { reason: EndpointReason; class: EndpointClass } {
  const trimmed = text.trim();
  const tokens = words(trimmed);
  const last = tokens.at(-1);
  if (last === undefined) return { reason: 'fragment', class: 'incomplete' };
  if (/(?:\.\.\.|…|[,;:\-–—])["')\]]*$/.test(trimmed))
    return { reason: 'trailing_comma', class: 'incomplete' };
  if (selfCorrection(tokens)) return { reason: 'self_correction', class: 'incomplete' };
  if (FILLERS.has(last)) return { reason: 'filler', class: 'incomplete' };
  if (CONTINUATIONS.has(last) && !(last === 'so' && SO_ENDS.has(tokens.at(-2) ?? ''))) {
    return { reason: 'continuation', class: 'incomplete' };
  }
  if (tokens.every((word) => SHORT_ANSWERS.has(word)) && tokens.length <= 3) {
    return { reason: 'short_answer', class: 'complete' };
  }
  const punctuated = /[.?!]["')\]]*$/.test(trimmed);
  if (punctuated) {
    return /\?["')\]]*$/.test(trimmed)
      ? { reason: 'question', class: 'complete' }
      : { reason: 'sentence_end', class: 'complete' };
  }
  if (tokens.length <= 2) return { reason: 'fragment', class: 'incomplete' };
  const first = tokens[0] ?? '';
  const opener = LEAD_INS.has(first) ? (tokens[1] ?? '') : first;
  if (QUESTION_OPENERS.has(opener)) return { reason: 'question', class: 'complete' };
  return { reason: 'open', class: 'open' };
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
  /** When the transcriber last said anything (a result, changed or not, used or not). */
  private lastResultAt = Number.NEGATIVE_INFINITY;
  private readonly options: EndpointerOptions;

  constructor(
    private readonly now: () => number,
    options: Partial<EndpointerOptions> = {},
  ) {
    this.options = { ...DEFAULT_ENDPOINTER, ...options };
  }

  /** A transcript update. Updates of a segment already used for a turn only count for new trailing words. */
  onResult(result: TranscriptResult): void {
    this.lastResultAt = this.now();
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

  /** What is heard so far would need this much quiet, and why (null: nothing heard). */
  verdict(): Omit<EndpointDecision, 'quietMs'> | null {
    const text = this.text();
    if (text === '') return null;
    const o = this.options;
    if (o.mode === 'fixed') return { reason: 'fixed', class: 'open', waitMs: o.silenceMs };
    if (Number.isFinite(this.lastVoiceAt) && this.lastResultAt < this.lastVoiceAt - CATCH_UP_MS) {
      return { reason: 'catching_up', class: 'open', waitMs: Math.max(o.openMs, o.silenceMs) };
    }
    const heard = classifyUtterance(text);
    const waitMs =
      heard.class === 'complete' ? o.completeMs : heard.class === 'open' ? o.openMs : o.incompleteMs;
    return { ...heard, waitMs };
  }

  /** The founder has finished: a stable transcript and the quiet what they said needs; null while not. */
  decide(): EndpointDecision | null {
    const verdict = this.verdict();
    if (verdict === null) return null;
    const now = this.now();
    const quiet = now - this.lastVoiceAt;
    if (quiet < verdict.waitMs) return null;
    const settle = this.options.mode === 'fixed' ? verdict.waitMs : Math.min(verdict.waitMs, SETTLE_MS);
    for (const segment of this.segments.values()) {
      if (!segment.partial || segment.stable) continue;
      if (now - segment.changedAt < settle) return null;
    }
    return { ...verdict, quietMs: Number.isFinite(quiet) ? Math.round(quiet) : null };
  }

  /** Whether the founder has finished (see {@link decide}). */
  isComplete(): boolean {
    return this.decide() !== null;
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
 * Whether what the founder said, apart from the vEIR's own echo, is only backchannels ("yeah", "mm-hmm", "right"):
 * they are listening, not taking the floor.
 */
export function backchannelOnly(heard: string, spoken: string): boolean {
  const echo = new Set(words(spoken));
  const own = words(heard).filter((word) => !echo.has(word));
  return own.length > 0 && own.every((word) => BACKCHANNELS.has(word));
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
