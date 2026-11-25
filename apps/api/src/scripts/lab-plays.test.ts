/** The models benchmark's measure of the path's matching, on vectors made up to say what it must say of them. */
import { hashEmbedding } from '@foundry/ai';
import { PLAYBOOK, playAsks } from '@foundry/core';
import { benchmarkQueries } from '@foundry/db/retrieval-benchmark';
import { describe, expect, it } from 'vitest';

import {
  ASK_SETS,
  benchPlays,
  FLOORS,
  MARGINS,
  matchingMessages,
  MIN_CHOSEN_RIGHT,
  nearestOf,
  NO_ASK_SETS,
  productionPlay,
  ruleOutcomes,
  type MatchingVectors,
} from './lab-plays.js';

const TITAN = 'amazon.titan-embed-text-v2:0';
const messages = matchingMessages(benchmarkQueries());
const ruled = ruleOutcomes(messages);
const { asks } = playAsks(PLAYBOOK);
const axis = new Map(PLAYBOOK.plays.map((p, i) => [p.id, i]));
const SIZE = PLAYBOOK.plays.length + 1;

/** A direction for each play, and one no play has. */
function toward(playId: string | null, weight: number): number[] {
  const v = new Array<number>(SIZE).fill(0);
  v[SIZE - 1] = Math.sqrt(1 - weight * weight);
  if (playId !== null) v[axis.get(playId) ?? 0] = weight;
  return v;
}

/** A model that means what it should: each ask lies by its first play, everything else by none. */
const perfect: MatchingVectors = {
  modelId: TITAN,
  asks: asks.map((a) => toward(a.playId, 1)),
  messages: new Map(
    messages.map((m) => [m.text, toward(m.set === 'near_miss' ? null : (m.plays[0] ?? null), 0.8)]),
  ),
};
/** A model that means nothing: every message lies by one play. */
const useless: MatchingVectors = {
  ...perfect,
  messages: new Map(messages.map((m) => [m.text, toward('pricing', 0.9)])),
};

describe('the messages', () => {
  it('are the playbook’s tests’ asks, the blind ones, near misses, the benchmark’s and 80 of nothing or more', () => {
    const of = (set: string) => messages.filter((m) => m.set === set).length;
    for (const set of [...ASK_SETS, ...NO_ASK_SETS, 'near_miss']) expect(of(set), set).toBeGreaterThan(5);
    expect(of('blind')).toBeGreaterThanOrEqual(120);
    expect(of('benchmark')).toBeGreaterThanOrEqual(50);
    expect(
      NO_ASK_SETS.filter((s) => s !== 'benchmark_none').reduce((n, s) => n + of(s), 0),
    ).toBeGreaterThanOrEqual(80);
    expect(new Set(messages.map((m) => m.id)).size).toBe(messages.length);
  });
});

describe('the measure', () => {
  it('finds the constants that take what a good model knows, beside the phrases and a late embedding', () => {
    const { result, kept } = benchPlays(ruled, perfect, 1024);
    const { production, suggested, phrases, fallback, held, heldPhrases } = result.scores;
    expect(result.suggested).not.toBeNull();
    expect([phrases.chosen, fallback.chosen]).toEqual([0, 0]);
    expect(suggested.chosen).toBeGreaterThan(300);
    expect(suggested.all.right).toBeGreaterThan(phrases.all.right + 0.4);
    expect(suggested.asks.blind.right).toBeGreaterThan(0.75);
    expect(suggested.chosenRight).toBe(1);
    expect(suggested.falseMatchAll).toEqual(phrases.falseMatchAll);
    expect(held.all.right).toBeGreaterThan(heldPhrases.all.right);
    // The code's own constants, as a turn would use them.
    expect(production.all.right).toBeGreaterThan(phrases.all.right);
    // Strictest of the equal ones.
    expect(result.suggested?.margin).toBe(Math.max(...MARGINS));
    expect(result.grid).toHaveLength(FLOORS.length * MARGINS.length);
    expect(result.nearestRight).toEqual({ first: 1, top: 1 });
    // Numbers and fixed names only; the private part says which message by its set and number.
    const printed = JSON.stringify(result);
    for (const m of messages) expect(printed).not.toContain(m.text);
    expect(Object.keys(kept)).toHaveLength(messages.length);
    expect(JSON.stringify(kept)).not.toContain(messages[0]?.text);
  });

  it('a wrong play is worse than none: without meaning, none on the messages of nothing and 3 in 100 of the blind asks', () => {
    const { fallback, phrases } = benchPlays(ruled, useless, 1024).result.scores;
    for (const set of NO_ASK_SETS) {
      // A few of the benchmark's name a risk (a lawyer, a doctor): the classifier's referral, as before.
      const most = set === 'benchmark_none' ? 0.05 : 0;
      expect(fallback.falseMatch[set].matched, set).toBeLessThanOrEqual(most);
      expect(phrases.falseMatch[set], set).toEqual(fallback.falseMatch[set]);
    }
    expect(fallback.asks.blind.wrong).toBeLessThanOrEqual(0.03);
    expect(fallback.all.wrong).toBeLessThanOrEqual(0.02);
    expect(fallback.all.right).toBeGreaterThan(phrases.all.right);
    expect(fallback.nearMiss.matched).toBe(0);
  });

  it('suggests nothing when nothing is good enough, and shows what the code’s constants would do', () => {
    const { result } = benchPlays(ruled, useless, 1024);
    expect(result.suggested).toBeNull();
    // Without constants a turn is one whose embedding never came.
    expect(result.scores.suggested).toEqual(result.scores.fallback);
    expect(result.scores.production.falseMatchAll.matched).toBeGreaterThan(0.1);
    expect(result.scores.production.chosenRight).toBeLessThan(MIN_CHOSEN_RIGHT);
  });

  it('asks the meaning only of a message no phrase or rule reads, and chooses as production’s turn does', () => {
    const near = nearestOf(perfect);
    for (const r of ruled) if (r.open !== null) expect(r.playId, r.message.id).toBeNull();
    const first = messages.find((m) => m.set === 'blind');
    expect(near.get(first?.text ?? '')?.plays).toHaveLength(3);
    const choose = productionPlay(perfect);
    const late = productionPlay(null);
    const { kept } = benchPlays(ruled, perfect, 1024);
    for (const r of ruled.filter((_, i) => i % 25 === 0)) {
      const row = kept[r.message.id] as { production: string | null; fallback: string | null };
      expect(choose(r.message.text), r.message.id).toBe(row.production);
      expect(late(r.message.text), r.message.id).toBe(row.fallback);
    }
  });

  it('is deterministic', () => {
    const hashed = (text: string) => hashEmbedding(text, 256);
    const vectors: MatchingVectors = {
      modelId: TITAN,
      asks: asks.map((a) => hashed(a.text)),
      messages: new Map(messages.map((m) => [m.text, hashed(m.text)])),
    };
    const one = benchPlays(ruled, vectors, 256).result;
    const two = benchPlays(ruled, vectors, 256).result;
    expect({ ...one, decideMs: 0 }).toEqual({ ...two, decideMs: 0 });
  }, 60_000);
});
