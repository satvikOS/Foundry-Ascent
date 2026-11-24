import { describe, expect, it } from 'vitest';

import {
  COACH_RELEASES,
  THOMAS_EVERYWHERE_RELEASE,
  coachAssignmentId,
  withoutReturnGreeting,
  withoutTwinName,
} from './coach-releases.js';
import { seedId } from './ids.js';
import { OWNER_RELEASES, parseOwnerReleases } from './owner-releases.js';
import { STORY_RELEASES } from './story-releases.js';

const RUTH = { name: "Ruth's vEIR", eirName: 'Ruth Abernathy-Song' };

describe('coach releases', () => {
  it('are named in the same list as the other releases, under keys of their own', () => {
    expect(parseOwnerReleases('thomas-2026-11-05, thomas-everywhere-2026-11-24')).toEqual([
      'thomas-2026-11-05',
      'thomas-everywhere-2026-11-24',
    ]);
    expect(() => parseOwnerReleases('thomas-everywhere-1999')).toThrow(/unknown release/);
    const keys = [...OWNER_RELEASES, ...STORY_RELEASES, ...COACH_RELEASES].map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('give each venture a deterministic assignment, its own per tenant, release and venture', () => {
    const of = (slug: string, key: string, venture: string): string =>
      coachAssignmentId({ key }, venture, (...parts) => seedId(slug, ...parts));
    const base = of('ain', THOMAS_EVERYWHERE_RELEASE.key, 'v1');
    expect(of('ain', THOMAS_EVERYWHERE_RELEASE.key, 'v1')).toBe(base);
    expect(
      new Set([
        base,
        of('ain', THOMAS_EVERYWHERE_RELEASE.key, 'v2'),
        of('ain', 'other', 'v1'),
        of('other', THOMAS_EVERYWHERE_RELEASE.key, 'v1'),
      ]).size,
    ).toBe(4);
  });
});

describe('withoutTwinName', () => {
  it.each([
    ["Ruth's vEIR suggested a paid pilot.", 'The coach suggested a paid pilot.'],
    ['Agreed with Ruth’s vEIR to call two labs.', 'Agreed with the coach to call two labs.'],
    ["Asked Ruth Abernathy-Song's digital twin for a script.", 'Asked the coach for a script.'],
    ['Done. Ruth · vEIR asked for the date.', 'Done. The coach asked for the date.'],
    ['Wants your vEIR to be blunt; the vEIR agreed.', 'Wants the coach to be blunt; the coach agreed.'],
  ])('%s', (text, expected) => {
    expect(withoutTwinName(text, RUTH)).toBe(expected);
  });

  it('leaves everything else alone: people, products and the neutral guide', () => {
    for (const text of [
      'Interviewed Ruth Miller about returns.',
      'Builds a digital twin of a lab freezer.',
      "Ruth's lab counts stock on Fridays.",
    ]) {
      expect(withoutTwinName(text, RUTH)).toBe(text);
    }
    const guide = 'Foundry Guide suggested five interviews.';
    expect(withoutTwinName(guide, { name: 'Foundry Guide', eirName: null })).toBe(guide);
  });
});

describe('withoutReturnGreeting', () => {
  it.each([
    ['Good to see you again. Want help with the pilot terms?', 'Want help with the pilot terms?'],
    ['Hi Priya, nice to hear from you again! Want help with it?', 'Want help with it?'],
    ['Welcome back. Want help with the labs?', 'Want help with the labs?'],
  ])('%s', (text, expected) => {
    expect(withoutReturnGreeting(text)).toBe(expected);
  });

  it('keeps an opener without one, and never leaves nothing', () => {
    for (const text of [
      'Want help setting up the $10 hem test with five people from your waitlist?',
      'Hi Priya. Want help getting back to the two labs?',
      'Good to see you again.',
    ]) {
      expect(withoutReturnGreeting(text)).toBe(text);
    }
  });
});
