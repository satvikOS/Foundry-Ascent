import { describe, expect, it } from 'vitest';

import { type pathRepo } from '@foundry/db';

import { NO_READS } from './testing/inputs.js';
import { readTurnOf } from './testing/understood.js';
import { ofAnotherBusiness, otherBusinessesIn } from './other-business.js';

describe('another business of theirs', () => {
  it('is named by their own words', () => {
    expect(otherBusinessesIn(["The kiln pays 40 a week. My pottery's the other business we own."])).toEqual([
      'pottery',
    ]);
    expect(otherBusinessesIn(['my other business, the food truck, does fine'])).toEqual(['food truck']);
    expect(otherBusinessesIn(['the cafe is a separate thing'])).toEqual(['cafe']);
    expect(otherBusinessesIn(['I run the stall on Saturdays'])).toEqual([]);
  });

  it('a note about it is none of the venture', () => {
    expect(ofAnotherBusiness('Pottery sells mugs at $12 each', ['pottery'])).toBe(true);
    expect(ofAnotherBusiness('One studio pays 40 dollars a week', ['pottery'])).toBe(false);
    expect(ofAnotherBusiness('Food costs $3 a box', ['food truck'])).toBe(false);
  });
});

describe('what the venture has', () => {
  const note = (id: string, content: string): pathRepo.PathMemory => ({
    id,
    type: 'fact',
    title: 'Told',
    content,
    attributes: {},
    status: 'confirmed',
    origin: 'founder',
    pinned: false,
    createdAt: '2026-11-10T09:00:00.000Z',
  });
  it('holds none of another business of theirs', () => {
    const memory = [
      note('aaaaaaaa-0000-4000-8000-000000000011', 'One studio pays 40 dollars weekly to use the kiln.'),
      note('aaaaaaaa-0000-4000-8000-000000000012', 'Pottery sells mugs for 12 dollars each.'),
    ];
    const t = readTurnOf('What has KilnShare got so far, and what is missing?', null, {
      reads: { ...NO_READS, memory },
      venture: {
        name: 'KilnShare',
        stage: 'validation',
        oneLiner: 'Kiln time shared by the hour.',
        domain: 'consumer',
        currentGoal: 'A second studio.',
      },
      earlierMessages: ["My pottery's the other business we own."],
    } as never);
    expect(t.prompt.lead?.text).toMatch(/one studio pays 40 dollars weekly/i);
    expect(t.prompt.lead?.text).not.toMatch(/mugs/);
  });
});
