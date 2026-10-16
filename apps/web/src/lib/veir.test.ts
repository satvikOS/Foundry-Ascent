import { describe, expect, it } from 'vitest';

import { monogram, shortPersonaName, veirDisplay } from './veir';

describe('shortPersonaName', () => {
  it('takes the EIR name from a possessive vEIR persona name', () => {
    expect(shortPersonaName("Corin's vEIR", 'eir_persona', 'Corin Halvorsen')).toBe('Corin');
    expect(shortPersonaName('Ruth’s vEIR', 'eir_persona', null)).toBe('Ruth');
  });

  it('falls back to the EIR first name for other EIR persona names', () => {
    expect(shortPersonaName('Deep-tech pathway mentor', 'eir_persona', 'Ruth Abernathy-Song')).toBe('Ruth');
  });

  it('keeps the neutral guide name whole', () => {
    expect(shortPersonaName('Foundry Guide', 'neutral_guide', 'Corin Halvorsen')).toBe('Foundry Guide');
  });
});

describe('veirDisplay', () => {
  it('is null without a persona', () => {
    expect(veirDisplay({ persona: null, assignedEir: null })).toBeNull();
    expect(veirDisplay(undefined)).toBeNull();
  });

  it('never offers a portrait until likeness consent supplies one', () => {
    const veir = veirDisplay({
      persona: {
        personaId: '00000000-0000-4000-8000-000000000001',
        releaseId: '00000000-0000-4000-8000-000000000002',
        name: "Corin's vEIR",
        kind: 'eir_persona',
        version: 1,
        status: 'active',
        disclosure: 'Corin’s vEIR is an AI.',
        allowedModes: ['diagnose'],
      },
      assignedEir: {
        id: '00000000-0000-4000-8000-000000000003',
        displayName: 'Corin Halvorsen',
        synthetic: true,
      },
    });
    expect(veir).toMatchObject({ shortName: 'Corin', portraitUrl: null, kind: 'eir_persona' });
  });
});

describe('monogram', () => {
  it('uses one letter per word, up to the limit', () => {
    expect(monogram('Corin')).toBe('C');
    expect(monogram('Foundry Guide')).toBe('FG');
    expect(monogram('Maya Okafor-Lindqvist')).toBe('MO');
    expect(monogram('Corin Halvorsen', 1)).toBe('C');
  });

  it('skips leading punctuation and handles empty names', () => {
    expect(monogram('  (ruth)  abernathy ')).toBe('RA');
    expect(monogram('   ')).toBe('?');
  });
});
