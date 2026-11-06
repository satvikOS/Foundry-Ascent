import { describe, expect, it } from 'vitest';

import session from './device-ad/session.json';
import { LANDING_DISCLOSURE, LANDING_DISCLOSURE_SUMMARY, PERSONA } from './persona';

describe('the landing page’s mentor', () => {
  it('is the one the device ad plays a session with, shown by his name alone', () => {
    expect(session.mentor).toBe(PERSONA);
    // His name is never a person's: the EIR in the ad's data has a name of their own.
    expect(session.eir.split(' ')[0]).not.toBe(PERSONA);
    expect(LANDING_DISCLOSURE_SUMMARY).toBe(`${PERSONA} is an AI mentor, not a person.`);
  });

  it('says how he is made, as his release does (ADR-0021): the program wrote and approved his approach', () => {
    expect(LANDING_DISCLOSURE.startsWith(LANDING_DISCLOSURE_SUMMARY)).toBe(true);
    expect(LANDING_DISCLOSURE).toMatch(/coaching approach was written and approved by the program/);
    expect(LANDING_DISCLOSURE).toMatch(/no person writes or approves his individual replies/);
    expect(LANDING_DISCLOSURE).toMatch(/A person from the program is there/);
    // No entrepreneur-in-residence wrote or reviewed Thomas's doctrine: nothing public may say one did.
    expect(LANDING_DISCLOSURE).not.toMatch(/entrepreneur-in-residence|EIR|consent|their review/i);
  });
});
