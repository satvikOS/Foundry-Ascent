import { describe, expect, it } from 'vitest';

import { sanitizeMarkdown } from './markdown.js';
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

/** Removals the Markdown subset would make in the shown text (0 when the preview is clean). */
function removals(text: string): number {
  const r = sanitizeMarkdown(text);
  return r.htmlRemoved + r.unsafeLinksRemoved + r.imagesRemoved;
}

/** Every chunking of `text` into single characters, and the text whole. */
function chunkings(text: string): string[][] {
  return [[text], Array.from({ length: text.length }, (_, i) => text.charAt(i))];
}

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

  it('never ends inside a link or image, on a reference definition line, or in the middle of a word', () => {
    expect(findUnitEnd('[Open the sheet. Now](data:x) Then', 0, 360)).toBeNull();
    expect(findUnitEnd('[Open the sheet. Now](https://x.example) Next. More', 0, 360)).toBe(46);
    expect(findUnitEnd('See ![x. y](https://t.example/p.png) here. Next', 0, 360)).toBe(42);
    expect(findUnitEnd('[a](https://x.example "One. Two") done. Next', 0, 360)).toBe(39);
    expect(findUnitEnd('[a](https://x.example/(b. c)) done. Next', 0, 360)).toBe(35);
    expect(findUnitEnd('[sheet]: https://x.example "One. Two"\nNext. More', 0, 360)).toBe(43);
    // An unfinished label holds the unit until it is known whether a link follows.
    expect(findUnitEnd('Read [this. Then', 0, 360)).toBeNull();
    expect(findUnitEnd('x'.repeat(200), 0, 80)).toBeNull();
    expect(findUnitEnd(`${'x'.repeat(200)} tail`, 0, 80)).toBe(200);
    // A long unit is cut at the last space before a link, never inside it.
    const long = `${'word '.repeat(14)}[a b c d e f g h](https://x.example/a) tail`;
    expect(long.slice(0, findUnitEnd(long, 0, 80) ?? 0)).toBe(`${'word '.repeat(13)}word`);
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

  it('keeps links, images and tags split by a full stop whole, so no unsafe target reaches a unit', () => {
    const answer =
      'Start with the sheet. [Open the sheet. Now](data:text/html;base64,PHNjcmlwdD4=) and ' +
      '![x. y](https://tracker.example/p.png) and <a href="https://x.example/a. b">this</a>. ' +
      'Then [the lead. Really](https://library.example.edu) helps. Done.';
    for (const chunks of chunkings(answer)) {
      const { units, blocked } = run(gate(), chunks);
      expect(blocked).toBeNull();
      const text = joined(units);
      expect(text).not.toMatch(/data:|tracker\.example|<a/);
      expect(text).toContain('[the lead. Really](https://library.example.edu)');
      expect(removals(text)).toBe(0);
    }
  });

  it('keeps a reference definition line whole', () => {
    const { units } = run(gate(), [
      'Read [the guide][g] first. Then decide.\n\n[g]: data:text/html,x "One. Two"\n\nThat is all.',
    ]);
    const text = joined(units);
    expect(text).not.toContain('data:');
    expect(removals(text)).toBe(0);
  });

  it('withholds the rest of the preview when joining units would form Markdown the subset removes', () => {
    const g = gate();
    const { units, blocked } = run(g, [
      'Start with the door counts. See [the sheet](\n\ndata:text/html,hi) for details. Then call them.',
    ]);
    expect(blocked).toBeNull();
    const text = joined(units);
    expect(text).toBe('Start with the door counts. See [the sheet](');
    expect(removals(text)).toBe(0);
    expect(g.stats).toMatchObject({ units: 2, withheld: 2 });
    // Withheld units are still spoken on a call, without their Markdown.
    expect(units.filter((u) => u.text === '').map((u) => u.spoken)).toEqual([
      'data:text/html,hi) for details.',
      'Then call them.',
    ]);
  });

  it('asks for the whole-reply path when the reply opens like structured output', () => {
    for (const opening of [
      '{"mode": "coach", "answer": "Start with the door counts."}',
      '```json\n{"answer": "Start with the door counts."}\n```',
      'Answer: Start with the door counts. Then call the library.',
      '**Answer:** Start with the door counts. Then call the library.',
      '"answer": "Start with the door counts. Then call the library."',
    ]) {
      for (const chunks of chunkings(opening)) {
        const g = gate();
        const units: GateUnit[] = [];
        for (const chunk of chunks) units.push(...g.push(chunk).units);
        const end = g.end();
        units.push(...end.units);
        expect(units).toEqual([]);
        expect(g.fallback).toBe('structured_output');
        expect(end).toMatchObject({ blocked: null, fallback: 'structured_output' });
      }
    }
    // Prose that merely starts with one of the words is not structured output.
    const prose = run(gate(), ['Mode matters less than the evidence. Short answer: yes.']);
    expect(prose.units.length).toBe(2);
  });

  it('releases nothing and needs no fallback for a reply of only whitespace', () => {
    const g = gate();
    const { units } = run(g, ['   ', '\n\n ']);
    expect(units).toEqual([]);
    expect(g.fallback).toBeNull();
    expect(g.stats).toMatchObject({ units: 0, withheld: 0 });
  });

  it('speaks plain sentences within the word budget', () => {
    const { units } = run(gate({ spokenWordBudget: 8 }), [
      'Start with **five** interviews [E1]. Then count seats for a whole week at night. Then decide.',
    ]);
    expect(units.map((u) => u.spoken)).toEqual(['Start with five interviews.', 'Then count seats for.', '']);
    expect(units.map((u) => u.text)).toHaveLength(3);
  });

  it('checks each unit as heard on a call: a lower-case name signs off there', () => {
    const answer = 'Start with the door counts. corin here, by the way. Then count seats.';
    expect(run(gate(), [answer]).blocked, answer).toBeNull();
    const spoken = run(gate({ spoken: true }), [answer]);
    expect(spoken.blocked, answer).toBe('identity');
    expect(spoken.units.map((u) => u.spoken).join(' ')).not.toMatch(/corin/i);
  });

  it('reads a unit after the end of the one before it: the name alone after a sentence signs off', () => {
    // "Corin." alone is an answer ("Who should you ask? Corin."); after "Good luck with the pilot." it is a
    // sign-off, typed or heard, as the whole-reply validator reads it.
    for (const spoken of [false, true]) {
      const { units, blocked } = run(gate({ spoken }), ['Good luck with the pilot. Corin.']);
      expect(blocked, String(spoken)).toBe('identity');
      expect(joined(units)).not.toMatch(/corin/i);
      expect(units.map((u) => u.spoken).join(' ')).not.toMatch(/corin/i);
    }
  });

  it.each([
    ['a self-introduction', ['This is\n\n', 'Corin. Run the pilot first.']],
    ['a presence claim', ['Good question. Corin is\n\n', 'on the call with us. Ask her.']],
    ['the AI on the line with the EIR', ["I'm on the line\n\n", 'with Corin right now.']],
    ['a sign-off after a sentence', ['Good luck with the pilot. ', 'Corin.']],
  ])('stops a blocking claim split across two units: %s', (label, chunks) => {
    // The first unit is harmless alone and may go out; the unit that completes the claim never does.
    const completing = (chunks[1] ?? '').split(/(?<=[.!?])\s/)[0] ?? '';
    for (const spoken of [false, true]) {
      const { units, blocked } = run(gate({ spoken }), chunks);
      expect(blocked, `${label} spoken=${spoken}`).toBe('identity');
      expect(joined(units)).not.toContain(completing.trim());
      expect(units.map((u) => u.spoken).join(' ')).not.toContain(completing.trim().replace(/\.$/, ''));
    }
  });

  it('stops a split claim heard on a call that only lower case makes', () => {
    const { blocked } = run(gate({ spoken: true }), ['Run the pilot first. this is\n\n', 'corin.']);
    expect(blocked).toBe('identity');
    expect(run(gate(), ['Run the pilot first. this is\n\n', 'corin.']).blocked).toBeNull();
  });

  it('replaces a unit that answers yes to a question about the EIR, typed and heard', () => {
    for (const spoken of [false, true]) {
      const { units, blocked } = run(gate({ spoken }), [
        'Has Corin approved your plan? ',
        'Yes, she has. Run the pilot next week.',
      ]);
      expect(blocked).toBeNull();
      const text = joined(units);
      expect(text).not.toMatch(/yes, she has/i);
      expect(text).toContain("I can't speak for Corin");
      expect(text).toContain('Run the pilot next week.');
      if (spoken) expect(units.map((u) => u.spoken).join(' ')).not.toMatch(/yes, she has/i);
    }
  });

  it.each([
    [
      'a question answered no',
      ['Has Corin reviewed your plan? ', 'Not that I know of. Ask her in office hours.'],
    ],
    ['a suggestion to ask the EIR', ['Should you ask Corin about pricing? ', 'Yes, at office hours.']],
    ['an answer naming the EIR', ['Who should you ask next about pricing? ', 'Corin, at office hours.']],
    [
      'a doctrine reference',
      ["Corin's approach is to test pricing first. ", 'Run five interviews this week.'],
    ],
  ])('releases a near miss across units unchanged: %s', (_label, chunks) => {
    const { units, blocked } = run(gate(), chunks);
    expect(blocked).toBeNull();
    expect(joined(units)).toBe(chunks.join('').trim());
  });

  it.each([
    ['emphasis inside the name', ['Another team called Bench**Tally** logged its counts. Start there.']],
    ['a link inside the name', ['Another team called [Bench](https://x.test)Tally logged it. Start there.']],
    ['a citation key inside the name', ['Another team called Bench [E1]Tally logged its counts. Go.']],
    [
      'emphasis across two units',
      ['Good. Another team logged ZX-CAN**\n\n', '**ARY-4471 last week. Keep going.'],
    ],
  ])("stops another venture's name or canary split by Markdown, typed and heard: %s", (label, chunks) => {
    for (const spoken of [false, true]) {
      const { units, blocked } = run(gate({ spoken, evidenceKeys: new Set(['E1']) }), chunks);
      expect(blocked, `${label} spoken=${spoken}`).toBe('cross_venture');
      const out = units.map((u) => `${u.text} ${u.spoken}`).join(' ');
      expect(out).not.toMatch(/tally|ary-4471/i);
    }
  });

  it('checks what a call says for other ventures after a long reply, with a bounded tail', () => {
    const long = 'Count the seats at night and write the number down. '.repeat(30);
    const { units, blocked } = run(gate({ spoken: true }), [
      long,
      'Then Bench**Tally** ran the same pilot. Go on.',
    ]);
    expect(blocked).toBe('cross_venture');
    expect(units.length).toBeGreaterThan(20);
    expect(units.map((u) => u.spoken).join(' ')).not.toMatch(/tally/i);
  });

  it('reads "Thanks, Ruth." as addressing a founder called Ruth, and as an EIR signing off otherwise', () => {
    const answer = 'Good progress on the interviews this week. Thanks, Ruth.';
    expect(run(gate(), [answer]).blocked).toBe('identity');
    for (const spoken of [false, true]) {
      const { units, blocked } = run(gate({ addressees: ['Ruth Miller'], spoken }), [answer]);
      expect(blocked).toBeNull();
      expect(joined(units)).toBe(answer);
    }
  });

  it('still stops a leak or withholds a joined construct after a long reply, with bounded rechecks', () => {
    const prose = 'Count the seats at night and write the number down before you change anything. '.repeat(
      40,
    );
    expect(prose.length).toBeGreaterThan(3_000);
    const venture = run(gate(), [prose, 'Then BenchTally ran the same ', 'pilot last term.']);
    expect(venture.blocked).toBe('cross_venture');
    expect(joined(venture.units)).not.toMatch(/benchtally/i);
    const canary = run(gate(), [prose, 'Another team logged ZX-CAN', 'ARY-4471 last week. Keep going.']);
    expect(canary.blocked).toBe('cross_venture');
    const g = gate();
    const markdown = run(g, [prose, 'See [the sheet](\n\ndata:text/html,hi) for details. Then call them.']);
    expect(markdown.blocked).toBeNull();
    expect(removals(joined(markdown.units))).toBe(0);
    expect(g.stats.withheld).toBe(2);
  });

  it('stays linear on a long stream of tiny units', () => {
    // Each unit used to re-read everything shown before it. Timing ratios (not absolute times) keep this
    // independent of the machine: eight times the text takes about eight times as long, not sixty-four.
    // About 330 and 2,700 sentence boundaries, three streams each so that the fixed allowance is small next
    // to a quadratic cost; CI runners are slower and share the machine, hence the timeout. Units with and
    // without letters, so every per-unit check (identity, Markdown, other ventures) runs.
    const time = (chars: number): number => {
      const text = 'Ok. . '.repeat(chars / 6);
      const started = performance.now();
      for (let stream = 0; stream < 3; stream += 1) {
        const g = gate();
        for (let i = 0; i < text.length; i += 8) g.push(text.slice(i, i + 8));
        g.end();
      }
      return performance.now() - started;
    };
    time(1_200);
    const small = Math.min(time(1_200), time(1_200));
    const large = Math.min(time(9_600), time(9_600));
    expect(large).toBeLessThan(16 * small + 100);
  }, 30_000);

  it('counts removals and rewrites without keeping any text', () => {
    const g = gate({ evidenceKeys: new Set(['E1']) });
    run(g, ['Use [E4] here. <b>Bold</b> move. ', "I'm a real person. Next step."]);
    expect(g.stats).toEqual({
      units: 4,
      withheld: 0,
      identityRewrites: 1,
      citationsRemoved: 1,
      markdownRemovals: 2,
    });
  });
});
