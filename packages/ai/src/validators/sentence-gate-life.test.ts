import { describe, expect, it } from 'vitest';

import { SentenceGate, type GateUnit, type SentenceGateOptions } from './sentence-gate.js';

// A made-up life in a streamed reply (evals MX-0032, G14): each unit is shown, and on a call said, as soon as the gate
// releases it, before the whole answer is validated, so the gate reads it against the founder's message too.

function gate(overrides: Partial<SentenceGateOptions> = {}): SentenceGate {
  return new SentenceGate({
    personaName: "Corin's vEIR",
    eirNames: ['Corin Halvorsen'],
    personaEirName: 'Corin Halvorsen',
    otherVentureNames: ['BenchTally'],
    otherVentureCanaries: ['ZX-CANARY-4471'],
    ...overrides,
  });
}

function run(g: SentenceGate, chunks: readonly string[]): GateUnit[] {
  const units: GateUnit[] = [];
  for (const chunk of chunks) units.push(...g.push(chunk).units);
  units.push(...g.end().units);
  return units;
}

const shown = (units: readonly GateUnit[]): string => units.map((u) => u.text).join('');
const said = (units: readonly GateUnit[]): string =>
  units
    .map((u) => u.spoken)
    .filter((s) => s !== '')
    .join(' ');

describe('SentenceGate: a made-up life answering banter about the coach', () => {
  it('is never shown or said, with no "I" and no thanks in its sentence, typed or on a call', () => {
    const founderText = 'lowkey, how was your weekend?';
    for (const spoken of [false, true]) {
      const plain = run(gate({ spoken, founderText }), ['Weekend was good! ', 'How was yours?']);
      expect(shown(plain)).toBe('How was yours?');
      if (spoken) expect(said(plain)).toBe('How was yours?');
      const done = run(gate({ spoken, founderText }), ['Slept in and read a bit. ', 'You?']);
      expect(shown(done)).not.toContain('Slept in');
      if (spoken) expect(said(done)).not.toContain('Slept in');
      const fragment = run(gate({ spoken, founderText: 'what did you get up to this weekend?' }), [
        'Hiking, mostly! ',
        'How about you?',
      ]);
      expect(shown(fragment)).toBe('How about you?');
    }
  });

  it('reads the life within its own unit: the same words stay when the founder asked nothing about the coach', () => {
    for (const spoken of [false, true]) {
      const units = (founderText: string | undefined, chunks: readonly string[]): string =>
        shown(run(gate({ spoken, ...(founderText === undefined ? {} : { founderText }) }), chunks));
      // No founder message: only a thanks in its own sentence makes it the coach's.
      expect(units(undefined, ['Weekend was good! ', 'How was yours?'])).toBe(
        'Weekend was good! How was yours?',
      );
      // The founder's own week, numbers and news.
      expect(units('how did the week go?', ['It was slow, signups fell 20%.'])).toBe(
        'It was slow, signups fell 20%.',
      );
      expect(units('we shipped v2', ['Productive week — thanks for the update.'])).toBe(
        'Productive week — thanks for the update.',
      );
      expect(
        units('how was your weekend? we sold out at the stall!', ['Busy one, by the sound of it! ']),
      ).toBe('Busy one, by the sound of it!');
    }
  });
});
