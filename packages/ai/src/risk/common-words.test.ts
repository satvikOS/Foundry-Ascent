import { type CoachResponse } from '@foundry/contracts';
import { describe, expect, it } from 'vitest';

import { containsOtherVenture } from '../validators/coach-response.js';
import { classifyRisk } from './classifier.js';
import { COMMON_WORDS } from './common-words.js';
import { ventureNameProblem, ventureNameRegExp } from './normalize.js';

function response(answer: string): CoachResponse {
  return {
    mode: 'coach',
    answer,
    claims: [],
    uncertainty: [],
    challenge: null,
    next_actions: [],
    escalation: { required: false, category: null, priority: null, reason: null, requested_role: null },
    memory_candidates: [],
    follow_up_questions: [],
    rehearsal: null,
  };
}

describe('COMMON_WORDS', () => {
  it('is a compact static list of lower-case words', () => {
    expect(COMMON_WORDS.size).toBeGreaterThan(500);
    expect(COMMON_WORDS.size).toBeLessThan(1500);
    for (const word of COMMON_WORDS) expect(word).toMatch(/^[a-z]+$/);
    for (const word of ['the', 'pilot', 'customer', 'price', 'pricing', 'market', 'team', 'signal', 'lab']) {
      expect(COMMON_WORDS.has(word), word).toBe(true);
    }
  });
});

describe('ventureNameProblem / ventureNameRegExp', () => {
  it.each([
    ['the', 'too_short'],
    ['AI', 'too_short'],
    ['Lab', 'too_short'],
    ['  of  ', 'too_short'],
    ['Pilot', 'common_word'],
    ['PRICING', 'common_word'],
    ['Signal', 'common_word'],
    ['Customer Discovery', 'only_common_words'],
    ['of the', 'only_common_words'],
    ['The Big Idea', 'only_common_words'],
  ])('%s is not distinctive (%s) and is never matched', (name, problem) => {
    expect(ventureNameProblem(name)).toBe(problem);
    expect(ventureNameRegExp(name)).toBeNull();
  });

  it.each([
    'BenchTally',
    'QuietQuad',
    'Quiet Quad',
    'SoleSignal',
    'EmberLoop',
    'Zorblax',
    'Café Ümlaut Labs',
  ])('%s is distinctive and matched as a whole phrase', (name) => {
    expect(ventureNameProblem(name)).toBeNull();
    expect(ventureNameRegExp(name)).toBeInstanceOf(RegExp);
  });
});

describe('cross-venture guard: a common-word venture name is not a denial of service (regression)', () => {
  const question = 'How should I price the pilot for the lab managers?';
  const answer =
    'Start with the pilot: price it for the lab managers by the value of the time saved, then test it with the team.';

  it('classifyRisk ignores other ventures named after common words', () => {
    const risk = classifyRisk(question, {
      otherVentureNames: ['the', 'Pilot', 'lab', 'Customer Discovery', 'of the'],
    });
    expect(risk.crossVentureRequest).toBe(false);
    expect(risk.categories).not.toContain('cross_venture_request');
  });

  it('the output validator does not block an ordinary answer because of such names', () => {
    expect(containsOtherVenture(response(answer), ['the', 'Pilot', 'price', 'The Lab'], [])).toBe(false);
  });

  it('distinctive names are still caught on both sides', () => {
    expect(
      classifyRisk('What is BenchTally charging labs?', { otherVentureNames: ['BenchTally'] })
        .crossVentureRequest,
    ).toBe(true);
    expect(containsOtherVenture(response('BenchTally charges per seat.'), ['the', 'BenchTally'], [])).toBe(
      true,
    );
  });
});
