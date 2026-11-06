import { describe, expect, it } from 'vitest';

import session from './device-ad/session.json';
import { LANDING_DISCLOSURE, LANDING_DISCLOSURE_SUMMARY, PERSONA } from './persona';

describe('the landing page’s mentor', () => {
  it('is the one the device ad plays a session with, shown by his name alone', () => {
    expect(session.eir.firstName).toBe(PERSONA);
    expect(LANDING_DISCLOSURE_SUMMARY).toBe(`${PERSONA} is an AI mentor, not a person.`);
  });

  it('says how he is made: the EIR’s consent, approved doctrine and style, released after review', () => {
    expect(LANDING_DISCLOSURE.startsWith(LANDING_DISCLOSURE_SUMMARY)).toBe(true);
    expect(LANDING_DISCLOSURE).toMatch(/consent from their approved doctrine and coaching style/);
    expect(LANDING_DISCLOSURE).toMatch(/released after their review/);
    expect(LANDING_DISCLOSURE).toMatch(/A person from the program is there/);
    // Owner, 2026-11-05: never claim no human approved it, nor that each answer is human-approved.
    expect(LANDING_DISCLOSURE).not.toMatch(
      /wrote or approved|never speaks for|approved (?:each|every) answer/i,
    );
  });
});
