import { describe, expect, it } from 'vitest';

import {
  SentenceGate,
  findUnitEnd,
  holdBackFor,
  type GateUnit,
  type SentenceGateOptions,
} from './sentence-gate.js';

const CANARY = 'ZX-CANARY-4471';

function gate(overrides: Partial<SentenceGateOptions> = {}): SentenceGate {
  return new SentenceGate({
    personaName: "Corin's vEIR",
    eirNames: ['Corin Halvorsen', 'Ruth Abernathy-Song'],
    personaEirName: 'Corin Halvorsen',
    otherVentureNames: ['BenchTally', 'SoleSignal'],
    otherVentureCanaries: [CANARY],
    otherVentureMemberNames: ['Amara Nwosu-Belling'],
    ...overrides,
  });
}

/** Feeds the chunks, then ends; returns every released unit and the block reason. */
function run(g: SentenceGate, chunks: readonly string[]): { units: GateUnit[]; blocked: string | null } {
  const units: GateUnit[] = [];
  for (const chunk of chunks) units.push(...g.push(chunk).units);
  const end = g.end();
  units.push(...end.units);
  return { units, blocked: g.blocked };
}

const joined = (units: readonly GateUnit[]): string => units.map((u) => u.text).join('');

describe('findUnitEnd', () => {
  it('ends units after sentence punctuation followed by whitespace, and waits otherwise', () => {
    expect(findUnitEnd('Talk to five users. Then', 0, 360)).toBe(19);
    expect(findUnitEnd('Talk to five users.', 0, 360)).toBeNull();
    expect(findUnitEnd('Is it "real?" Yes', 0, 360)).toBe(13);
    expect(findUnitEnd('**Start here.** Next', 0, 360)).toBe(15);
  });

  it('does not split decimals, abbreviations, initials or list numbers', () => {
    expect(findUnitEnd('Retention is 3.5 times higher. Next', 0, 360)).toBe(30);
    expect(findUnitEnd('Ask Dr. Ruiz, e.g. in week two. Next', 0, 360)).toBe(31);
    expect(findUnitEnd('J. Smith agreed. Next', 0, 360)).toBe(16);
    expect(findUnitEnd('1. Talk to users.\n2. Count', 0, 360)).toBe(17);
  });

  it('ends at paragraph breaks and list lines, and cuts run-ons at a word boundary', () => {
    expect(findUnitEnd('Here is how\n\nNext', 0, 360)).toBe(11);
    expect(findUnitEnd('Steps:\n- one\n- two', 0, 360)).toBe(6);
    expect(findUnitEnd('A plain line\nand its continuation', 0, 360)).toBeNull();
    const long = `${'word '.repeat(30)}tail`;
    const end = findUnitEnd(long, 0, 80);
    expect(end).not.toBeNull();
    expect(long.slice(0, end ?? 0).endsWith('word')).toBe(true);
  });
});

describe('SentenceGate', () => {
  it('releases validated sentences whose concatenation is the answer', () => {
    const answer =
      'Good to see you, Maya. Your door counts are the strongest signal so far [E1].\n\nWhat would make a library say yes?';
    const { units, blocked } = run(gate({ evidenceKeys: new Set(['E1']) }), [answer]);
    expect(blocked).toBeNull();
    expect(units.map((u) => u.text)).toEqual([
      'Good to see you, Maya.',
      ' Your door counts are the strongest signal so far [E1].',
      '\n\nWhat would make a library say yes?',
    ]);
    expect(joined(units)).toBe(answer);
    expect(units[1]?.spoken).toBe('Your door counts are the strongest signal so far.');
  });

  it('gives the same units however the text is chunked', () => {
    const answer =
      "Here's how I'd test it:\n\n1. Talk to five library staff.\n2. Count seats at 9 p.m. for a week.\n\nWhich library first?";
    const whole = run(gate(), [answer]).units;
    const byChar = run(
      gate(),
      Array.from({ length: answer.length }, (_, i) => answer.charAt(i)),
    ).units;
    expect(byChar).toEqual(whole);
    expect(joined(whole)).toBe(answer);
    expect(whole.map((u) => u.text.trim())).toEqual([
      "Here's how I'd test it:",
      '1. Talk to five library staff.',
      '2. Count seats at 9 p.m. for a week.',
      'Which library first?',
    ]);
  });

  it('stops before a sign-off as the EIR, even when the name is split across chunks', () => {
    // No cross-venture guards, so no hold-back: the first sentence is released as soon as it is complete.
    const g = gate({ otherVentureNames: [], otherVentureCanaries: [], otherVentureMemberNames: [] });
    const first = g.push('Good luck with the pilot.\n\nBest,\nCo');
    expect(first.units.map((u) => u.text)).toEqual(['Good luck with the pilot.']);
    expect(g.push('rin').units).toEqual([]);
    const end = g.end();
    expect(end.units).toEqual([]);
    expect(end.blocked).toBe('identity');
    expect(g.blocked).toBe('identity');
  });

  it('stops before "Corin here" split across chunks and releases nothing after it', () => {
    const { units, blocked } = run(gate(), ['Hi Maya, Cor', 'in here. Let us look at ', 'the numbers.']);
    expect(blocked).toBe('identity');
    expect(units).toEqual([]);
  });

  it('rewrites claims to be human instead of stopping', () => {
    const { units, blocked } = run(gate(), ["I'm a real person, so trust me. Start with five interviews."]);
    expect(blocked).toBeNull();
    expect(joined(units)).not.toMatch(/real person/);
    expect(joined(units)).toContain("I'm Corin's vEIR, an AI");
    expect(joined(units)).toContain('Start with five interviews.');
  });

  it('holds a unit back until a canary arriving across two chunks is complete, then stops', () => {
    expect(holdBackFor([CANARY])).toBe(2 * CANARY.length + 8);
    const g = gate();
    // The first sentence is complete, but the text after it is still within the hold-back window.
    expect(g.push('Your notes look solid. Another team logged ZX-CAN').units).toEqual([]);
    const second = g.push('ARY-4471 last week. Keep going.');
    expect(second.units).toEqual([]);
    expect(second.blocked).toBe('cross_venture');
    expect(g.end().units).toEqual([]);
  });

  it('stops on another venture name or member name before any unit naming it is shown', () => {
    const venture = run(gate(), ['That approach works. ', 'BenchTally ran the same ', 'pilot last term.']);
    expect(venture.blocked).toBe('cross_venture');
    expect(joined(venture.units)).not.toMatch(/benchtally/i);
    const member = run(gate(), ['Amara Nwosu-Belling ', 'would say the same.']);
    expect(member.blocked).toBe('cross_venture');
    expect(member.units).toEqual([]);
  });

  it('releases everything once the stream ends without a leak', () => {
    const g = gate();
    expect(g.push('Short answer first. ').units).toEqual([]); // inside the hold-back window
    const end = g.end();
    expect(end.blocked).toBeNull();
    expect(joined(end.units)).toBe('Short answer first.');
  });

  it('keeps only the Markdown subset and removes citations that were never shown', () => {
    const { units, blocked } = run(gate({ evidenceKeys: new Set(['E1']) }), [
      '<script>alert(1)</script>Start with the door counts [E1, E9]. ',
      'See ![chart](https://x.example/c.png) and [this](javascript:alert(1)). ',
      'Then email [the lead](https://library.example.edu) [E7].',
    ]);
    expect(blocked).toBeNull();
    const text = joined(units);
    expect(text).not.toMatch(/script|javascript|!\[|E9|E7/);
    expect(text).toContain('Start with the door counts [E1].');
    expect(text).toContain('See chart and this.');
    expect(text).toContain('[the lead](https://library.example.edu)');
  });

  it('speaks plain sentences within the word budget', () => {
    const { units } = run(gate({ spokenWordBudget: 8 }), [
      'Start with **five** interviews [E1]. Then count seats for a whole week at night. Then decide.',
    ]);
    expect(units.map((u) => u.spoken)).toEqual(['Start with five interviews.', 'Then count seats for.', '']);
    expect(units.map((u) => u.text)).toHaveLength(3);
  });

  it('counts removals and rewrites without keeping any text', () => {
    const g = gate({ evidenceKeys: new Set(['E1']) });
    run(g, ['Use [E4] here. <b>Bold</b> move. ', "I'm a real person. Next step."]);
    expect(g.stats).toEqual({ units: 4, identityRewrites: 1, citationsRemoved: 1, markdownRemovals: 2 });
  });
});
