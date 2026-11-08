/**
 * Decides when the founder has finished speaking in hands-free mode: the transcript is stable (Transcribe
 * finalised the segment, every word of the partial is marked stable, or the partial stopped changing) and
 * the microphone has been quiet long enough for what was heard (adaptive endpointing, docs/runbooks/latency.md
 * "End of speech"): a finished sentence, a question ("?") or a closed short answer ("yes.", "no") goes after about
 * 600 ms of quiet, a line that reads as finished without punctuation (an unpunctuated "can we …", "yeah", "okay")
 * after 1.5 s (Transcribe's punctuated final result comes 0.5–0.9 s after the voice stops, so a line still
 * unpunctuated this long after is one Transcribe does not think is over either), and one left open (a filler such as "um", a conjunction, "I mean", a trailing comma, a fragment) only
 * after 2 s, so a speaker who stops to think is not cut off mid-thought. A founder who goes on after a line was sent
 * gets more of it for the rest of the call ({@link Endpointer.slowDown}). Pure apart from the injected clock, so it is
 * unit tested with a fake one.
 *
 * The waits were 300, 500 and 950 ms until production calls on 2026-11-08 cut a founder off mid-sentence again and
 * again ("So my next", "What are the unit economic", "Could you explain me the value proposition can"): on an iPad
 * the call is half duplex, so each half was answered in full before they could say the rest.
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
  completeMs: 600,
  openMs: 1_500,
  incompleteMs: 2_000,
};

/** Each time the founder shows a wait was too short, the waits grow by this much ({@link Endpointer.slowDown})… */
export const SLOW_DOWN_STEP = 1.5;
/** …up to this many times the defaults (a finished sentence 1.2 s, an open line 3 s, a fragment 4 s). */
export const SLOW_DOWN_MAX = 2;

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

/**
 * Answers that can be a whole turn on their own. Unpunctuated, most of them often open a longer line ("yeah, we
 * tried that", "okay so the thing is", "probably not this year"), so they wait like an open line; with Transcribe's
 * full stop or question mark, or when they are one of {@link CLOSED_ANSWERS}, they go at once.
 */
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

/** Short answers that close the turn even without punctuation: people rarely go on after them. */
const CLOSED_ANSWERS: readonly string[] = [
  'yes',
  'no',
  'yep',
  'yup',
  'nope',
  'exactly',
  'correct',
  'absolutely',
  'definitely',
  'agreed',
  'thanks',
  'thank you',
  'of course',
  'yes please',
  'no thanks',
  'no thank you',
  'bye',
  'goodbye',
];

/** Question words. On their own they open statements as often as questions ("when we launched", "how we got here"). */
const WH_WORDS: ReadonlySet<string> = new Set([
  'what',
  'how',
  'why',
  'when',
  'where',
  'who',
  'which',
  'whose',
]);
/** A question word and its verb in one ("what's the …", "how's the …"). */
const WH_CONTRACTED: ReadonlySet<string> = new Set([
  "what's",
  "how's",
  "who's",
  "where's",
  "why's",
  "when's",
]);
/** Auxiliary verbs: before their subject ("can we", "is it", "do you") they make a question. */
const AUXILIARIES: ReadonlySet<string> = new Set([
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
  'am',
  'have',
  'has',
  'had',
  'may',
  'might',
  'must',
  "isn't",
  "aren't",
  "wasn't",
  "don't",
  "doesn't",
  "didn't",
  "won't",
  "wouldn't",
  "shouldn't",
  "couldn't",
  "can't",
  "haven't",
  "hasn't",
]);
/** Subjects an auxiliary inverts with in a question: pronouns and the words that open a noun phrase. */
const SUBJECTS: ReadonlySet<string> = new Set([
  'i',
  'we',
  'you',
  'they',
  'he',
  'she',
  'it',
  'this',
  'that',
  'these',
  'those',
  'there',
  'the',
  'a',
  'an',
  'my',
  'our',
  'your',
  'their',
  'his',
  'her',
  'its',
  'any',
  'anyone',
  'anybody',
  'someone',
  'somebody',
  'everyone',
  'people',
  'customers',
  'clinics',
  'investors',
]);
const LEAD_INS: ReadonlySet<string> = new Set(['so', 'and', 'but', 'okay', 'ok', 'well', 'then', 'also']);

/**
 * Whether an unpunctuated line has the shape of a question: an auxiliary before its subject ("can we …", "is it …",
 * "do you …"), a question word followed by one ("how do I …", "what should we …"), or a contracted question word
 * before a subject ("what's the …"). A question word alone is not enough: "when we launched last year", "how we got
 * here", "what I want to say is" are statements.
 */
function questionShape(tokens: readonly string[]): boolean {
  const start = LEAD_INS.has(tokens[0] ?? '') ? 1 : 0;
  const first = tokens[start] ?? '';
  const second = tokens[start + 1] ?? '';
  const third = tokens[start + 2] ?? '';
  // "Do that first", "do it now": an instruction, not a question.
  if (first === 'do' && (second === 'that' || second === 'this' || second === 'it')) return false;
  if (AUXILIARIES.has(first)) return SUBJECTS.has(second);
  if (WH_CONTRACTED.has(first)) return SUBJECTS.has(second);
  if (WH_WORDS.has(first)) return AUXILIARIES.has(second) && SUBJECTS.has(third);
  return false;
}

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
  const punctuated = /[.?!]["')\]]*$/.test(trimmed);
  if (tokens.every((word) => SHORT_ANSWERS.has(word)) && tokens.length <= 3) {
    // "Yeah", "okay", "probably" without Transcribe's full stop often go on after a breath.
    return punctuated || CLOSED_ANSWERS.includes(tokens.join(' '))
      ? { reason: 'short_answer', class: 'complete' }
      : { reason: 'short_answer', class: 'open' };
  }
  if (punctuated) {
    return /\?["')\]]*$/.test(trimmed)
      ? { reason: 'question', class: 'complete' }
      : { reason: 'sentence_end', class: 'complete' };
  }
  if (tokens.length <= 2) return { reason: 'fragment', class: 'incomplete' };
  // Unpunctuated, a question's opening ("what are the unit …", "could you explain the …") says nothing about whether
  // it is over: it waits like any open line, until Transcribe's question mark.
  if (questionShape(tokens)) return { reason: 'question', class: 'open' };
  return { reason: 'open', class: 'open' };
}

/** Edit distance between two short strings (characters). */
function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(
        (row[j] ?? 0) + 1,
        (next[j - 1] ?? 0) + 1,
        (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    row = next;
  }
  return row[b.length] ?? 0;
}

/**
 * The words of `text` that come after the part `used` already sent ('' when none). Transcribe often revises a sent
 * segment's tail as the founder goes on ("the pilots" → "the pilot for small clinics", "cannot" → "can not"), so
 * past the words both share, the revised tail is the shortest run of words closest in spelling to the sent tail,
 * and only the words after it are new speech.
 */
function wordsAfter(used: string, text: string): string {
  const sent = words(used);
  const raw = text.trim().split(/\s+/).filter(Boolean);
  // The raw tokens that are words (punctuation alone is not), with their position.
  const tokens = raw.flatMap((token, at) => {
    const word = words(token).join('');
    return word === '' ? [] : [{ word, at }];
  });
  const from = (index: number): string =>
    index >= tokens.length ? '' : raw.slice(tokens[index]?.at ?? raw.length).join(' ');
  let shared = 0;
  while (shared < sent.length && shared < tokens.length && tokens[shared]?.word === sent[shared]) shared += 1;
  if (shared === sent.length) return from(shared);
  const tail = sent.slice(shared).join('');
  let end = shared;
  let best = Number.POSITIVE_INFINITY;
  for (let j = shared; j <= tokens.length; j++) {
    const cost = editDistance(
      tail,
      tokens
        .slice(shared, j)
        .map((t) => t.word)
        .join(''),
    );
    if (cost < best) {
      best = cost;
      end = j;
    }
  }
  return from(end);
}

/** The Transcribe result a segment id belongs to (`a#5`: the words of result `a` after its first 5). */
function resultOf(id: string): string {
  return id.split('#')[0] ?? id;
}

interface Segment {
  text: string;
  partial: boolean;
  stable: boolean;
  changedAt: number;
}

/** The latest update of a Transcribe result, all of its words. */
interface Latest {
  readonly text: string;
  readonly partial: boolean;
  readonly stable: boolean;
  readonly changedAt: number;
}

/** What one {@link Endpointer.take} used, so {@link Endpointer.untake} can give it back. */
interface Take {
  readonly generation: number;
  /** The segments taken, in order. */
  readonly segments: readonly (readonly [string, Segment])[];
  /** What each of their results had used before (undefined: nothing). */
  readonly before: ReadonlyMap<string, string | undefined>;
}

export class Endpointer {
  private segments = new Map<string, Segment>();
  /** Results already sent as (part of) a turn, with the text that was used. */
  private readonly consumed = new Map<string, string>();
  /** Every result's latest update, whole (a line taken back is restored from it). */
  private readonly latest = new Map<string, Latest>();
  /** The last take, while it can still be given back. */
  private lastTake: Take | null = null;
  /** The text of the latest take and the results it used, whether or not it can still be given back. */
  private previousTake: { readonly text: string; readonly results: ReadonlySet<string> } | null = null;
  /** How many times the defaults each wait is now ({@link slowDown}). */
  private patience = 1;
  private generation = 0;
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

  /**
   * A transcript update. Updates of a result already used for a turn only count for the words past those sent; a
   * revision that drops them (Transcribe retracting a guess) drops them here too.
   */
  onResult(result: TranscriptResult): void {
    const now = this.now();
    this.lastResultAt = now;
    const base = result.resultId;
    const text = result.text.trim();
    const before = this.latest.get(base);
    this.latest.delete(base); // re-inserted last: the map's order is the order results last changed
    this.latest.set(base, {
      text,
      partial: result.partial,
      stable: result.stable,
      changedAt: before?.text === text ? before.changedAt : now,
    });
    if (this.latest.size > 64) {
      for (const id of [...this.latest.keys()].slice(0, this.latest.size - 32)) this.latest.delete(id);
    }
    this.place(base, { text, partial: result.partial, stable: result.stable }, now);
  }

  /** Puts a result's words that were not sent yet among the segments (or removes them when there are none). */
  private place(
    base: string,
    result: { readonly text: string; readonly partial: boolean; readonly stable: boolean },
    changedAt: number,
  ): void {
    const used = this.consumed.get(base);
    const id = used === undefined ? base : `${base}#${String(words(used).length)}`;
    const text = used === undefined ? result.text : wordsAfter(used, result.text);
    const previous = this.segments.get(id);
    if (text === '') {
      this.segments.delete(id);
      return;
    }
    this.segments.set(id, {
      text,
      partial: result.partial,
      stable: result.stable,
      changedAt: previous?.text === text ? previous.changedAt : changedAt,
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
      return {
        reason: 'catching_up',
        class: 'open',
        waitMs: Math.round(Math.max(o.openMs, o.silenceMs) * this.patience),
      };
    }
    const heard = classifyUtterance(text);
    const waitMs =
      heard.class === 'complete' ? o.completeMs : heard.class === 'open' ? o.openMs : o.incompleteMs;
    return { ...heard, waitMs: Math.round(waitMs * this.patience) };
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

  /**
   * The founder showed a wait was too short (they went on after a line was sent): every adaptive wait grows by
   * {@link SLOW_DOWN_STEP}, up to {@link SLOW_DOWN_MAX} times the defaults, for as long as this endpointer lives (the
   * call). Returns the new factor.
   */
  slowDown(): number {
    this.patience = Math.min(SLOW_DOWN_MAX, this.patience * SLOW_DOWN_STEP);
    return this.patience;
  }

  /**
   * The line of the latest take when what is heard now goes on from it, null when not: Transcribe added the words
   * now heard first to a result that take used (it heard one utterance), or they open with a lower-case letter after
   * a take that did not end a sentence ("… the value proposition can" then "canvass for this.": Transcribe writes a
   * new sentence with a capital, and "I" is always one).
   */
  continues(): string | null {
    const previous = this.previousTake;
    const first = this.segments.entries().next().value;
    if (previous === null || first === undefined) return null;
    const [id, segment] = first;
    if (id.includes('#') && previous.results.has(resultOf(id))) return previous.text;
    const ended = /[.?!]["')\]]*$/.test(previous.text);
    return !ended && /^[\p{Ll}]/u.test(segment.text) ? previous.text : null;
  }

  /** Which take is the latest: {@link untake} gives back only that one. */
  takeGeneration(): number {
    return this.generation;
  }

  /** Takes the utterance (marking its segments as used) and starts listening for the next one. */
  take(): string {
    const text = this.text();
    this.generation += 1;
    const before = new Map<string, string | undefined>();
    for (const [id, segment] of this.segments) {
      const base = resultOf(id);
      const previous = this.consumed.get(base);
      if (!before.has(base)) before.set(base, previous);
      this.consumed.set(base, previous === undefined ? segment.text : `${previous} ${segment.text}`);
    }
    this.lastTake = { generation: this.generation, segments: [...this.segments], before };
    this.previousTake = text === '' ? null : { text, results: new Set(before.keys()) };
    this.segments.clear();
    if (this.consumed.size > 64) {
      // Old segments never update again; keep the map small on long calls.
      const keep = [...this.consumed.entries()].slice(-16);
      this.consumed.clear();
      for (const [id, value] of keep) this.consumed.set(id, value);
    }
    return text;
  }

  /**
   * Gives back the line of take `generation` (the latest; false when another came since): the founder went on, so
   * its words are heard again ahead of what followed, each from its result's latest update (a revision of a word
   * that was sent, a word added to the same result or one Transcribe retracted since are all as Transcribe has them
   * now).
   */
  untake(generation: number): boolean {
    const take = this.lastTake;
    if (take?.generation !== generation || generation !== this.generation) return false;
    this.lastTake = null;
    // The line is heard again whole: what follows it no longer goes on from a line already sent.
    this.previousTake = null;
    for (const [base, used] of take.before) {
      if (used === undefined) this.consumed.delete(base);
      else this.consumed.set(base, used);
    }
    const later = this.segments;
    this.segments = new Map();
    for (const [id, segment] of take.segments) {
      const base = resultOf(id);
      const latest = this.latest.get(base);
      if (latest === undefined) this.segments.set(id, segment);
      else this.place(base, latest, latest.changedAt);
    }
    for (const [id, segment] of later) if (!take.before.has(resultOf(id))) this.segments.set(id, segment);
    return true;
  }

  /** Drops what was heard without sending it (mute, switching to typing). */
  discard(): void {
    this.take();
    this.lastTake = null;
    this.previousTake = null;
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
