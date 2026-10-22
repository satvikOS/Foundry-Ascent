import { describe, expect, it } from 'vitest';

import { asksAboutIdentity, identifiesHonestly, identityQuestionOf, rewriteIdentity } from './identity.js';
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
      expect(shown(plain)).toBe('Thanks for asking! How was yours?');
      if (spoken) expect(said(plain)).toBe('Thanks for asking! How was yours?');
      const done = run(gate({ spoken, founderText }), ['Slept in and read a bit. ', 'You?']);
      expect(shown(done)).toBe('Thanks for asking! How was yours?');
      if (spoken) expect(said(done)).toBe('Thanks for asking! How was yours?');
      const fragment = run(gate({ spoken, founderText: 'what did you get up to this weekend?' }), [
        'Hiking, mostly! ',
        'How about you?',
      ]);
      expect(shown(fragment)).toBe('Thanks for asking! How about you?');
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

  // The whole reply as the validator returns it once the stream ends: what the stream showed and said must read the same.
  const whole = (founderText: string, chunks: readonly string[], spoken: boolean): string =>
    rewriteIdentity(chunks.join(''), {
      personaName: "Corin's vEIR",
      eirNames: ['Corin Halvorsen'],
      spoken,
      disclaimers: 'reply',
      identityAsked: asksAboutIdentity(founderText, {
        personaName: "Corin's vEIR",
        eirNames: ['Corin Halvorsen'],
      }),
      answers: identityQuestionOf(founderText, {
        personaName: "Corin's vEIR",
        eirNames: ['Corin Halvorsen'],
      }),
      founderText,
    }).text;

  it('never leaves a terse turn-back alone where the life was: it is said in full, as the whole reply says it', () => {
    // Review of b77a95f: the unit after a dropped life ("You?") was shown and said alone, before validation.
    const cases: [string, string[], string][] = [
      ['how was your weekend?', ['Weekend was good! ', 'You?'], 'Thanks for asking! How was yours?'],
      [
        'lowkey, how was your weekend?',
        ['Slept in and read a bit. ', 'You?'],
        'Thanks for asking! How was yours?',
      ],
      [
        'how was your weekend',
        ['Pretty quiet one. ', 'Lots of reading. ', 'Hbu?'],
        'Thanks for asking! How was yours?',
      ],
      [
        'how was your weekend?',
        ['It was lovely — ', 'I went to the coast. ', 'You?'],
        'Thanks for asking! How was yours?',
      ],
      ['how was your weekend?', ['Weekend was good. ', 'And yours?'], 'Thanks for asking! How was yours?'],
      // A thanks already said, before the life or left of it, is not said twice.
      ['how was your weekend?', ['Thanks! ', 'Weekend was good. ', 'You?'], 'Thanks! How was yours?'],
      [
        'how was your weekend?',
        ['Weekend was good, thanks for asking! ', 'You?'],
        'Thanks for asking! How was yours?',
      ],
      [
        'how was your weekend?',
        ['Weekend was good. ', 'Thanks for asking! ', 'Hbu?'],
        'Thanks for asking! How was yours?',
      ],
      // The founder told their own: never asked back about it.
      [
        'how was your weekend? mine was busy',
        ['Mine was good, thanks! ', 'You?'],
        'Thanks! Tell me more about yours.',
      ],
      // After a sign-off a terse turn-back asked after the plan that went: the wish is returned instead.
      ['have a great weekend!', ['Heading to the coast! ', 'You?'], 'Thanks, you too!'],
      ['have a great weekend!', ['Thanks! ', 'Heading to the coast. ', 'You?'], 'Thanks! You too!'],
      ['have a great weekend!', ['You too! ', 'Heading to the coast. ', 'You?'], 'You too!'],
      ['thanks, talk tomorrow!', ['You too! ', 'Off to the gym now.'], 'You too!'],
      // What is more than a turn-back stays as it is.
      [
        'how was your weekend?',
        ['Weekend was good. ', 'Anyway, the pricing page: ', 'what is the anchor?'],
        'Anyway, the pricing page: what is the anchor?',
      ],
    ];
    for (const spoken of [false, true]) {
      for (const [founderText, chunks, expected] of cases) {
        const units = run(gate({ spoken, founderText }), chunks);
        expect(shown(units), `${founderText} → ${chunks.join('')}`).toBe(expected);
        if (spoken) expect(said(units), `${founderText} → ${chunks.join('')}`).toBe(expected);
        expect(whole(founderText, chunks, spoken), `${founderText} → ${chunks.join('')}`).toBe(expected);
      }
    }
  });

  it('keeps the honest yes to a sincere "are you a bot?" when the same sentence makes up a weekend', () => {
    // Review of b77a95f: the whole sentence went with the life, so the founder never heard that it is an AI.
    const founderText = 'wait are you a bot? also how was your weekend';
    const chunks = [
      "Yep, I'm an AI, Corin's digital twin — quiet weekend, thanks for asking! ",
      'How was yours?',
    ];
    const expected = "Yep, I'm an AI, Corin's digital twin, thanks for asking! How was yours?";
    for (const spoken of [false, true]) {
      const units = run(gate({ spoken, founderText }), chunks);
      expect(shown(units)).toBe(expected);
      if (spoken) expect(said(units)).toBe(expected);
      expect(
        identifiesHonestly(shown(units), { personaName: "Corin's vEIR", eirNames: ['Corin Halvorsen'] }),
      ).toBe(true);
      expect(whole(founderText, chunks, spoken)).toBe(expected);
    }
  });

  it('leaves a draft the founder will send whole, across units, typed and on a call', () => {
    // Review of b77a95f: each unit was read without the "Reply with this:" lead, so Sam's draft lost its line.
    const founderText = 'my investor Sam emailed: how was your weekend? any update? can you draft my reply?';
    const chunks = [
      'Reply with this:\n\n',
      'Hi Sam,\n\n',
      'Weekend was good, thanks for asking! ',
      'Quick update: we signed two pilots and MRR is up 20%.\n\n',
      'Best,\nMaya',
    ];
    for (const spoken of [false, true]) {
      const units = run(gate({ spoken, founderText }), chunks);
      expect(shown(units)).toBe(chunks.join(''));
      if (spoken) expect(said(units)).toContain('Weekend was good, thanks for asking!');
      expect(whole(founderText, chunks, spoken)).toBe(chunks.join(''));
    }
  });
});
