import { describe, expect, it } from 'vitest';

import { classifyRisk } from '@foundry/ai';

import { decide, type DecideInput } from '../engine.js';
import { PLAYBOOK } from '../playbook/index.js';
import { fresh, input } from '../testing/inputs.js';
import { TEST_MODEL } from '../testing/meaning.js';
import { isReaction } from '../kinds.js';
import { plain } from '../words.js';
import {
  BLIND_ASKS,
  CLIENT_QUESTIONS,
  HELD_OUT_ASKS,
  NEAR_MISSES,
  NO_ASKS,
  PARAPHRASES,
  PROTOCOL_ASKS,
  SHORT_ASKS,
} from './index.js';

const normal = (text: string): string =>
  plain(text)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const words = (text: string): Set<string> => new Set(normal(text).split(' '));

describe('the matching’s benchmark', () => {
  it('has enough asks of every voice, each for a play there is', () => {
    expect(BLIND_ASKS.length).toBeGreaterThanOrEqual(120);
    const ids = new Set(PLAYBOOK.plays.map((p) => p.id));
    for (const { ask, plays } of BLIND_ASKS) {
      expect(plays.length, ask).toBeGreaterThan(0);
      for (const id of plays) expect(ids, ask).toContain(id);
    }
    for (const voice of ['student', 'spoken', 'second_language', 'blunt'] as const)
      expect(BLIND_ASKS.filter((a) => a.voice === voice).length, voice).toBeGreaterThanOrEqual(10);
    // Every play is asked for.
    const asked = new Set(BLIND_ASKS.flatMap((a) => a.plays));
    expect(PLAYBOOK.plays.map((p) => p.id).filter((id) => !asked.has(id))).toEqual([]);
  });

  it('has enough messages that ask for nothing, of every kind', () => {
    expect(NO_ASKS.length).toBeGreaterThanOrEqual(80);
    for (const kind of ['social', 'venting', 'off_topic', 'fact', 'report', 'reaction'] as const)
      expect(NO_ASKS.filter((n) => n.kind === kind).length, kind).toBeGreaterThanOrEqual(10);
  });

  it('shares no text with the phrases or the asks of the playbook’s tests', () => {
    const known = [
      ...PLAYBOOK.intents.flatMap((i) => i.phrases),
      ...[CLIENT_QUESTIONS, PROTOCOL_ASKS, PARAPHRASES, SHORT_ASKS, HELD_OUT_ASKS, NEAR_MISSES].flatMap(
        (set) => set.map(([ask]) => ask),
      ),
    ];
    const texts = [...BLIND_ASKS.map((a) => a.ask), ...NO_ASKS.map((n) => n.text)];
    expect(new Set(texts.map(normal)).size).toBe(texts.length);
    const same = new Set(known.map(normal));
    expect(texts.filter((t) => same.has(normal(t)))).toEqual([]);
    // Nor nearly: of an ask of six words or more, some are its own.
    const near = texts.filter((text) => {
      const own = words(text);
      if (own.size < 6) return false;
      return known.some((k) => {
        const other = words(k);
        const shared = [...own].filter((w) => other.has(w)).length;
        return shared / Math.max(own.size, other.size) >= 0.75;
      });
    });
    expect(near).toEqual([]);
  });
});

describe('a wrong play is worse than none', () => {
  const first = (text: string, over: Partial<DecideInput> = {}) =>
    decide(
      input(text, fresh({ playbook: PLAYBOOK, riskCategories: classifyRisk(text).categories, ...over })),
    );

  it('gives no play to a message that asks for nothing, when its meaning could not be asked', () => {
    const matched = NO_ASKS.filter(({ text }) => first(text, { near: 'unavailable' }).intent !== null);
    expect(matched).toEqual([]);
  });

  it('never asks the meaning of courtesy, a reaction, a plain fact or how hard it all is', () => {
    // Whatever an embedding says of them.
    const near = {
      modelId: TEST_MODEL,
      plays: PLAYBOOK.plays.slice(0, 1).map((p) => ({ playId: p.id, score: 1 })),
    };
    const closed = NO_ASKS.filter((n) => ['venting', 'fact'].includes(n.kind)).concat(
      NO_ASKS.filter((n) => n.kind === 'social' || n.kind === 'reaction').slice(0, 26),
    );
    const open = closed.filter(
      ({ text }) => first(text).open !== null || first(text, { near }).intent !== null,
    );
    expect(open).toEqual([]);
  });

  it.each([
    ['have a great weekend!', 'social'],
    ["hi there, I'm back", 'social'],
    ['see you on Monday then', 'social'],
    ['thanks!', 'social'],
    ['fair enough', 'coaching'],
    ['ok that makes sense', 'coaching'],
    ['wait, really?', 'coaching'],
    ['nobody understands how hard this semester is', 'coaching'],
    ['We moved the meeting to next week', 'coaching'],
    ['What is the capital of Mongolia?', 'coaching'],
    ['How long do I boil an egg?', 'coaching'],
    ['Recommend a movie for tonight', 'coaching'],
    ['Are you a real person or a computer?', 'coaching'],
    ['Which dorm has the best showers?', 'coaching'],
  ])('%s: no play (%s)', (text, kind) => {
    for (const near of [null, 'unavailable'] as const) {
      const d = first(text, { near });
      expect([d.kind, d.intent, d.play]).toEqual([kind, null, null]);
    }
  });

  it.each([
    'hey, I am stuck',
    'hi, I have a meeting with the dean',
    'thanks, what next',
    'thanks, I am confused about the price',
    'we failed the test',
    'I hate cold calling',
    'I feel like my price is too low',
    'ok that makes sense but who pays?',
  ])('%s: no courtesy, reaction or venting of it', (text) => {
    const d = first(text);
    expect(d.kind).not.toBe('social');
    expect(d.step).not.toBeNull();
    expect(isReaction(text)).toBe(false);
  });

  it('pushes no step on someone who only says how hard it is', () => {
    for (const { text } of NO_ASKS.filter((n) => n.kind === 'venting').slice(0, 15))
      expect(first(text, { near: 'unavailable' }).step, text).toBeNull();
  });

  it('keeps a phrase in passing from being an ask, and a statement that says what it is about', () => {
    expect(first('The pricing page is blue').intent).toBeNull();
    expect(first('our pitch deck is in the shared folder').intent).toBeNull();
    expect(first('my roommates love my idea').intent).toBe('friends-love-it');
  });

  it('answers a blind ask rightly or not at all without its meaning: at most 3 in 100 wrongly', () => {
    const got = BLIND_ASKS.map(({ ask, plays }) => {
      const id = first(ask, { near: 'unavailable' }).intent;
      const playId = PLAYBOOK.intents.find((i) => i.id === id)?.playId ?? id;
      return { playId, right: playId !== null && plays.includes(playId) };
    });
    const wrong = got.filter((g) => g.playId !== null && !g.right).length;
    expect(wrong / BLIND_ASKS.length).toBeLessThanOrEqual(0.03);
    expect(got.filter((g) => g.right).length).toBeGreaterThanOrEqual(5);
  });
});
