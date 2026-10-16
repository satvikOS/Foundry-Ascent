import { describe, expect, it } from 'vitest';

import { defaultVeirName, eirsWithoutVeir, veirDisclosure, veirNameProblem } from './new-persona';
import { eirProfile, GUIDE, IDS, persona, RUTH } from './test-fixtures';

describe('new vEIR', () => {
  it('offers only active EIRs without a live vEIR', () => {
    const noor = eirProfile('22222222-3333-4444-8555-666666666666', 'Noor Example');
    const away = {
      ...eirProfile('33333333-4444-4555-8666-777777777777', 'Away EIR'),
      status: 'unavailable' as const,
    };
    const profiles = [
      eirProfile(IDS.corinEir, 'Corin Halvorsen'),
      eirProfile(IDS.ruthEir, 'Ruth Abernathy-Song'),
      noor,
      away,
    ];
    expect(eirsWithoutVeir(profiles, [GUIDE, persona(), RUTH]).map((p) => p.displayName)).toEqual([
      'Noor Example',
    ]);
    // A retired vEIR frees its EIR.
    expect(
      eirsWithoutVeir(profiles, [persona({ status: 'retired' }), RUTH]).map((p) => p.displayName),
    ).toEqual(['Corin Halvorsen', 'Noor Example']);
  });

  it('names a vEIR after the first name and discloses that it is an AI, not the EIR', () => {
    expect(defaultVeirName('Noor Example')).toBe("Noor's vEIR");
    const disclosure = veirDisclosure("Noor's vEIR", 'Noor Example');
    expect(disclosure).toMatch(/\bAI\b/);
    expect(disclosure).toContain('It is not a person');
    expect(disclosure).toContain('including Noor');
    expect(disclosure.length).toBeLessThanOrEqual(500);
  });

  it('refuses a name founders could take for the EIR in person', () => {
    const taken = [GUIDE, persona(), RUTH];
    for (const name of ['Noor Example', 'Noor', 'noor example', 'Noor here', 'Noor Example (AI)']) {
      expect(veirNameProblem(name, 'Noor Example', taken)).toBe(
        "Include “vEIR” so founders never take it for Noor, e.g. Noor's vEIR.",
      );
    }
    expect(veirNameProblem("Noor's vEIR", 'Noor Example', taken)).toBeNull();
    expect(veirNameProblem('Noor Example VEIR', 'Noor Example', taken)).toBeNull();
    expect(veirNameProblem("corin's veir", 'Noor Example', taken)).toBe(
      'Another persona already uses this name.',
    );
    expect(veirNameProblem('ab', 'Noor Example', taken)).toBe('Use 3 to 80 characters.');
  });
});
