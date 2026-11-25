/**
 * The models benchmark's measure of the path's matching (docs/runbooks/conversation-lab.md, "Models benchmark"; core
 * `path/semantic.ts`), in a turn's own order: a phrase of the playbook (a referral's first) or a rule, then what the message
 * means by one embedding model's vectors, then nothing. At the code's constants (`production`) and at those these messages
 * suggest, beside the phrases alone and what a turn does when its embedding is late (the nearest words, held to much more).
 *
 * The messages are the playbook's own tests' asks, asks and messages of nothing written without reading its phrases
 * (`@foundry/core/play-benchmark`) and the retrieval benchmark's questions. A message is read as the first of a
 * conversation of a venture with nothing on record. No database. What is returned is numbers and fixed names; each
 * message's outcome goes to the private report, by its set and number.
 */
import { performance } from 'node:perf_hooks';

import { classifyRisk } from '@foundry/ai';
import {
  decide,
  pickPlay,
  PLAY_MATCH_TOP,
  playAsks,
  PLAYBOOK,
  playMatchProfile,
  type DecideInput,
  type Decision,
  type PlayMatchProfile,
} from '@foundry/core';
import {
  BLIND_ASKS,
  CLIENT_QUESTIONS,
  HELD_OUT_ASKS,
  NEAR_MISSES,
  NO_ASKS,
  PARAPHRASES,
  PROTOCOL_ASKS,
  SHORT_ASKS,
  type Ask,
} from '@foundry/core/play-benchmark';
import { type retrievalRepo } from '@foundry/db';
import { type BenchmarkQuery } from '@foundry/db/retrieval-benchmark';

/** Sets of asks by name, and of messages nothing answers. */
export const ASK_SETS = [
  'client',
  'protocol',
  'paraphrases',
  'short',
  'held_out',
  'blind',
  'benchmark',
] as const;
export const NO_ASK_SETS = [
  'social',
  'venting',
  'off_topic',
  'fact',
  'report',
  'reaction',
  'benchmark_none',
] as const;
export type AskSet = (typeof ASK_SETS)[number];
export type NoAskSet = (typeof NO_ASK_SETS)[number];

interface Message {
  /** Its set and number: what the private report calls it. */
  readonly id: string;
  readonly text: string;
  readonly set: AskSet | NoAskSet | 'near_miss';
  /** The plays that answer it; of a near miss, the one that must not; none for a message of nothing. */
  readonly plays: readonly string[];
}

/** Every message, with the retrieval benchmark's questions only a play answers and those nothing in the corpus does. */
export function matchingMessages(queries: readonly BenchmarkQuery[]): Message[] {
  const pairs = (set: Message['set'], asks: readonly Ask[]): Message[] =>
    asks.map(([text, play], i) => ({ id: `${set}/${String(i + 1)}`, text, set, plays: [play] }));
  const playsOf = (q: BenchmarkQuery): string[] =>
    q.expected.flatMap((id) => (id.startsWith('play/') ? [id.slice('play/'.length)] : []));
  return [
    ...pairs('client', CLIENT_QUESTIONS),
    ...pairs('protocol', PROTOCOL_ASKS),
    ...pairs('paraphrases', PARAPHRASES),
    ...pairs('short', SHORT_ASKS),
    ...pairs('held_out', HELD_OUT_ASKS),
    ...BLIND_ASKS.map(({ ask, plays }, i): Message => ({
      id: `blind/${String(i + 1)}`,
      text: ask,
      set: 'blind',
      plays,
    })),
    ...pairs('near_miss', NEAR_MISSES),
    ...NO_ASKS.map(({ kind, text }, i): Message => ({
      id: `no_ask/${String(i + 1)}`,
      text,
      set: kind,
      plays: [],
    })),
    ...queries.flatMap((q): Message[] => {
      const plays = playsOf(q);
      if (q.kind === 'no_answer') return [{ id: q.id, text: q.query, set: 'benchmark_none', plays: [] }];
      // A question a note answers too is the retrieval's.
      return plays.length < q.expected.length ? [] : [{ id: q.id, text: q.query, set: 'benchmark', plays }];
    }),
  ];
}

/** What a venture with nothing on record says first. */
function firstMessage(message: string): DecideInput {
  return {
    playbook: PLAYBOOK,
    ventureId: '00000000-0000-4000-8000-000000000001',
    venture: { name: 'New venture', stage: 'idea', oneLiner: '', domain: 'general', currentGoal: null },
    reads: { path: null, steps: [], criteria: [], memory: [] },
    today: '2026-11-24',
    message,
    previousReply: null,
    mode: null,
    counterpart: null,
    conversationMode: null,
    crisis: false,
    riskCategories: classifyRisk(message).categories,
    recordText: '',
    background: [],
    started: false,
  };
}

/** What the phrases and rules make of a message, whether its meaning is asked, and what it gets when that cannot be. */
interface Ruled {
  readonly message: Message;
  readonly playId: string | null;
  readonly matched: Decision['matched'];
  readonly open: Decision['open'];
  readonly unasked: string | null;
}

const playOfIntent = new Map(PLAYBOOK.intents.map((i) => [i.id, i.playId]));
/** Asked of the whole path ("get me organized", "what next"): one answer. */
const OVERVIEW = 'overview';
const OVERVIEW_PLAYS = new Set(PLAYBOOK.intents.filter((i) => i.overview !== undefined).map((i) => i.playId));

function playOfDecision(d: Decision): string | null {
  if (d.intent === null) return null;
  return playOfIntent.get(d.intent) ?? (d.overview ? OVERVIEW : null);
}

/** Whether `playId` answers a message that any of `plays` does. */
const answers = (playId: string | null, plays: readonly string[]): boolean =>
  playId !== null &&
  (plays.includes(playId) || (playId === OVERVIEW && plays.some((p) => OVERVIEW_PLAYS.has(p))));

export function ruleOutcomes(messages: readonly Message[]): Ruled[] {
  return messages.map((message) => {
    const first = firstMessage(message.text);
    const d = decide(first);
    return {
      message,
      playId: playOfDecision(d),
      matched: d.matched,
      open: d.open,
      unasked: playOfDecision(decide({ ...first, near: 'unavailable' })),
    };
  });
}

/** The play a turn's first message gets with these vectors, as production decides (null: none were made). */
export function productionPlay(vectors: MatchingVectors | null): (message: string) => string | null {
  const near = vectors === null ? null : nearestOf(vectors);
  return (message) =>
    playOfDecision(decide({ ...firstMessage(message), near: near?.get(message) ?? 'unavailable' }));
}

/** The nearest plays of every message, by one model's vectors. */
export interface MatchingVectors {
  readonly modelId: string;
  /** One per text of `playAsks(PLAYBOOK).asks`, in its order. */
  readonly asks: readonly (readonly number[])[];
  /** Message text → vector. */
  readonly messages: ReadonlyMap<string, readonly number[]>;
}

function unit(v: readonly number[]): number[] {
  const norm = Math.hypot(...v);
  return norm === 0 ? [...v] : v.map((x) => x / norm);
}

/** As `retrievalRepo.nearestPlays` gives them: each play by its closest ask, best first. */
export function nearestOf(vectors: MatchingVectors): Map<string, retrievalRepo.NearPlays> {
  const asks = playAsks(PLAYBOOK).asks.map((a, i) => ({
    playId: a.playId,
    vector: unit(vectors.asks[i] ?? []),
  }));
  const out = new Map<string, retrievalRepo.NearPlays>();
  for (const [text, raw] of vectors.messages) {
    const v = unit(raw);
    const best = new Map<string, number>();
    for (const { playId, vector } of asks) {
      let dot = 0;
      for (let i = 0; i < v.length; i += 1) dot += (v[i] ?? 0) * (vector[i] ?? 0);
      if (dot > (best.get(playId) ?? -2)) best.set(playId, dot);
    }
    const plays = [...best]
      .map(([playId, score]) => ({ playId, score }))
      .sort((a, b) => b.score - a.score || (a.playId < b.playId ? -1 : 1))
      .slice(0, PLAY_MATCH_TOP);
    out.set(text, { modelId: vectors.modelId, plays });
  }
  return out;
}

export interface Share {
  readonly messages: number;
  /** Got a play that answers it. */
  readonly right: number;
  /** Got another play. */
  readonly wrong: number;
}

/** How a way of matching does: shares of each set (0 to 1). */
export interface MatchingScore {
  readonly asks: Readonly<Record<AskSet, Share>>;
  readonly all: Share;
  /** Of the messages no play answers, how many got one. */
  readonly falseMatch: Readonly<Record<NoAskSet, { readonly messages: number; readonly matched: number }>>;
  readonly falseMatchAll: { readonly messages: number; readonly matched: number };
  /** Near misses answered with the play they must not get. */
  readonly nearMiss: { readonly messages: number; readonly matched: number };
  /** Messages the stage by meaning chose for, and of those on asks how many rightly. */
  readonly chosen: number;
  readonly chosenRight: number;
}

const round = (x: number): number => Math.round(x * 1000) / 1000;
const part = (n: number, of: number): number => (of === 0 ? 0 : round(n / of));

/** One message's play under a way of matching, and whether meaning chose it. */
type Outcome = (r: Ruled) => { readonly playId: string | null; readonly byMeaning: boolean };

/** The phrases and rules alone. */
const byPhrase: Outcome = (r) => ({ playId: r.playId, byMeaning: false });
/** A turn whose embedding failed or was late, or whose model has no constants. */
const unasked: Outcome = (r) => ({ playId: r.unasked, byMeaning: false });

type Near = ReadonlyMap<string, retrievalRepo.NearPlays>;

/** As a turn decides: a phrase or a rule, then what it means, then nothing. */
const ordered =
  (near: Near, profile: PlayMatchProfile): Outcome =>
  (r) => {
    const found = near.get(r.message.text);
    if (r.open === null || found === undefined) return byPhrase(r);
    const intent = pickPlay(PLAYBOOK, r.message.text, found, r.open, profile).intent;
    return intent === null ? byPhrase(r) : { playId: intent.playId, byMeaning: true };
  };

export function scoreMatching(ruled: readonly Ruled[], outcome: Outcome): MatchingScore {
  const results = ruled.map((r) => ({ ...r, ...outcome(r) }));
  const shareOf = (of: typeof results): Share => ({
    messages: of.length,
    right: part(of.filter((r) => answers(r.playId, r.message.plays)).length, of.length),
    wrong: part(of.filter((r) => r.playId !== null && !answers(r.playId, r.message.plays)).length, of.length),
  });
  const matchedOf = (of: typeof results) => ({
    messages: of.length,
    matched: part(of.filter((r) => r.playId !== null).length, of.length),
  });
  const inSet = (set: string) => results.filter((r) => r.message.set === set);
  const isAsk = (r: (typeof results)[number]): boolean => ASK_SETS.some((s) => s === r.message.set);
  const isNone = (r: (typeof results)[number]): boolean => NO_ASK_SETS.some((s) => s === r.message.set);
  const near = inSet('near_miss');
  const chosen = results.filter((r) => r.byMeaning && isAsk(r));
  return {
    asks: Object.fromEntries(ASK_SETS.map((s) => [s, shareOf(inSet(s))])) as Record<AskSet, Share>,
    all: shareOf(results.filter(isAsk)),
    falseMatch: Object.fromEntries(NO_ASK_SETS.map((s) => [s, matchedOf(inSet(s))])) as Record<
      NoAskSet,
      { messages: number; matched: number }
    >,
    falseMatchAll: matchedOf(results.filter(isNone)),
    nearMiss: {
      messages: near.length,
      matched: part(near.filter((r) => answers(r.playId, r.message.plays)).length, near.length),
    },
    chosen: results.filter((r) => r.byMeaning).length,
    chosenRight: part(chosen.filter((r) => answers(r.playId, r.message.plays)).length, chosen.length),
  };
}

const steps = (from: number, to: number, by: number): number[] =>
  Array.from({ length: Math.round((to - from) / by) + 1 }, (_, i) => round(from + i * by));
export const FLOORS = steps(0.25, 0.85, 0.025);
export const MARGINS = [0.01, 0.02, 0.03, 0.05, 0.08] as const;
const GUARDS = [0, 0.05, 0.1] as const;
/** A referral play's floor, above the floor: a wrong one costs more. */
const REFERRAL_STEP = 0.08;
/** A wrong play is worse than none: of the asks meaning chooses for, how many it must get right. */
export const MIN_CHOSEN_RIGHT = 0.92;
/** Of the blind asks, how many may get a wrong play; of the benchmark's questions nothing answers, how many more one. */
export const MAX_BLIND_WRONG = 0.03;
export const MAX_ADDED_BENCHMARK = 0.02;

export interface GridPoint {
  readonly floor: number;
  readonly margin: number;
  readonly right: number;
  readonly wrong: number;
  readonly falseMatch: number;
}

const profileOf = (floor: number, margin: number, guard: number): PlayMatchProfile => ({
  floor,
  margin,
  guard,
  referralFloor: round(floor + REFERRAL_STEP),
});

/**
 * The constants that answer the most asks of `ruled` while meaning is right for {@link MIN_CHOSEN_RIGHT} of those it
 * chooses, at most {@link MAX_BLIND_WRONG} of the blind asks get a wrong play, no message that asks for nothing gets one
 * the phrases do not give it, and at most {@link MAX_ADDED_BENCHMARK} more of the benchmark's that nothing answers do;
 * null: no constants are that good.
 */
export function suggestProfile(
  ruled: readonly Ruled[],
  near: Near,
): { readonly suggested: PlayMatchProfile | null; readonly grid: readonly GridPoint[] } {
  const phrases = scoreMatching(ruled, byPhrase);
  const added = (score: MatchingScore, set: NoAskSet): number =>
    score.falseMatch[set].matched - phrases.falseMatch[set].matched;
  let best: { profile: PlayMatchProfile; score: MatchingScore } | null = null;
  const scored: { profile: PlayMatchProfile; score: MatchingScore }[] = [];
  for (const guard of GUARDS)
    for (const floor of FLOORS)
      for (const margin of MARGINS) {
        const profile = profileOf(floor, margin, guard);
        const score = scoreMatching(ruled, ordered(near, profile));
        scored.push({ profile, score });
        const good =
          score.chosen > 0 &&
          score.chosenRight >= MIN_CHOSEN_RIGHT &&
          score.asks.blind.wrong <= MAX_BLIND_WRONG &&
          NO_ASK_SETS.every(
            (set) => added(score, set) <= (set === 'benchmark_none' ? MAX_ADDED_BENCHMARK : 0),
          ) &&
          score.nearMiss.matched <= phrases.nearMiss.matched;
        // Of equal ones the strictest.
        if (good && (best === null || score.all.right >= best.score.all.right)) best = { profile, score };
      }
  const guard = best?.profile.guard ?? GUARDS[1];
  return {
    suggested: best?.profile ?? null,
    grid: scored
      .filter((s) => s.profile.guard === guard)
      .map(({ profile, score }) => ({
        floor: profile.floor,
        margin: profile.margin,
        right: score.all.right,
        wrong: score.all.wrong,
        falseMatch: score.falseMatchAll.matched,
      })),
  };
}

export interface PlayMatchingResult {
  readonly id: string;
  readonly dimensions: number;
  readonly messages: number;
  /** Of every message, how many are asked what they mean (a plain ask, and a guarded one). */
  readonly open: { readonly ask: number; readonly guarded: number };
  readonly current: PlayMatchProfile | null;
  /** From the even-numbered messages alone; null: no constants were good enough, so none should be set. */
  readonly suggested: PlayMatchProfile | null;
  readonly grid: readonly GridPoint[];
  /** Similarity of an ask with a play that answers it, and of a message of nothing with its nearest: p10, p50, p90. */
  readonly related: readonly number[];
  readonly unrelated: readonly number[];
  /** Of the asks, how many have a play that answers them nearest, and among the nearest three. */
  readonly nearestRight: { readonly first: number; readonly top: number };
  readonly scores: {
    /** What a turn does with this model: phrase, meaning at the code's constants, nothing. */
    readonly production: MatchingScore;
    readonly suggested: MatchingScore;
    /** The phrases and rules alone, and what a turn does when the embedding is late. */
    readonly phrases: MatchingScore;
    readonly fallback: MatchingScore;
    /** The suggested constants, and the phrases, on the messages the constants were not taken from. */
    readonly held: MatchingScore;
    readonly heldPhrases: MatchingScore;
  };
  readonly decideMs: number;
}

const percentiles = (values: readonly number[]): number[] => {
  const sorted = [...values].sort((x, y) => x - y);
  return [0.1, 0.5, 0.9].map((q) => round(sorted[Math.floor(q * (sorted.length - 1))] ?? 0));
};

export function benchPlays(
  ruled: readonly Ruled[],
  vectors: MatchingVectors,
  dimensions: number,
): { readonly result: PlayMatchingResult; readonly kept: Record<string, unknown> } {
  const started = performance.now();
  const near = nearestOf(vectors);
  const asksOnly = ruled.filter((r) => ASK_SETS.some((s) => s === r.message.set));
  const nones = ruled.filter((r) => NO_ASK_SETS.some((s) => s === r.message.set));
  const nearestIn = (r: Ruled, n: number): boolean =>
    (near.get(r.message.text)?.plays ?? []).slice(0, n).some((x) => r.message.plays.includes(x.playId));
  const rightScores = asksOnly.flatMap((r) =>
    (near.get(r.message.text)?.plays ?? [])
      .filter((x) => r.message.plays.includes(x.playId))
      .slice(0, 1)
      .map((x) => x.score),
  );
  const tuneOn = ruled.filter((_, i) => i % 2 === 0);
  const held = ruled.filter((_, i) => i % 2 === 1);
  const { suggested, grid } = suggestProfile(tuneOn, near);
  const current = playMatchProfile(vectors.modelId);
  const by = (profile: PlayMatchProfile | null): Outcome =>
    profile === null ? unasked : ordered(near, profile);
  const matchOf = (r: Ruled) => ({
    phrases: r.playId,
    by: r.matched,
    open: r.open,
    fallback: r.unasked,
    production: by(current)(r).playId,
    suggested: by(suggested)(r).playId,
    expected: r.message.plays,
    nearest: (near.get(r.message.text)?.plays ?? []).map((x) => `${x.playId}:${x.score.toFixed(3)}`),
  });
  return {
    kept: Object.fromEntries(ruled.map((r) => [r.message.id, matchOf(r)])),
    result: {
      id: vectors.modelId,
      dimensions,
      messages: ruled.length,
      open: {
        ask: ruled.filter((r) => r.open === 'ask').length,
        guarded: ruled.filter((r) => r.open === 'guarded').length,
      },
      current,
      suggested,
      grid,
      related: percentiles(rightScores),
      unrelated: percentiles(nones.flatMap((r) => near.get(r.message.text)?.plays[0]?.score ?? [])),
      nearestRight: {
        first: part(asksOnly.filter((r) => nearestIn(r, 1)).length, asksOnly.length),
        top: part(asksOnly.filter((r) => nearestIn(r, PLAY_MATCH_TOP)).length, asksOnly.length),
      },
      scores: {
        production: scoreMatching(ruled, by(current)),
        suggested: scoreMatching(ruled, by(suggested)),
        phrases: scoreMatching(ruled, byPhrase),
        fallback: scoreMatching(ruled, unasked),
        held: scoreMatching(held, by(suggested)),
        heldPhrases: scoreMatching(held, byPhrase),
      },
      decideMs: Math.round(performance.now() - started),
    },
  };
}
