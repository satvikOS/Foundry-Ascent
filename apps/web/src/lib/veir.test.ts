import { describe, expect, it } from 'vitest';

import { faceMonogram, monogram, veirDisplay, veirName } from './veir';

describe('veirName (the AI is always "<EIR first name>’s vEIR")', () => {
  it('keeps a persona already named as a vEIR', () => {
    expect(veirName("Corin's vEIR", 'eir_persona', 'Corin Halvorsen')).toBe("Corin's vEIR");
    expect(veirName('Ruth’s vEIR', 'eir_persona', null)).toBe('Ruth’s vEIR');
    expect(veirName('  Ruth’s   vEIR ', 'eir_persona')).toBe('Ruth’s vEIR');
  });

  it('never lets an EIR persona read as the EIR: any other name becomes "<first name>’s vEIR"', () => {
    expect(veirName('Corin Halvorsen', 'eir_persona')).toBe('Corin’s vEIR');
    expect(veirName('Corin', 'eir_persona')).toBe('Corin’s vEIR');
    // The first name of the persona's own consented EIR profile, when known.
    expect(veirName('Deep-tech pathway mentor', 'eir_persona', 'Ruth Abernathy-Song')).toBe('Ruth’s vEIR');
  });

  it('keeps a neutral guide’s own name', () => {
    expect(veirName('Foundry Guide', 'neutral_guide', 'Corin Halvorsen')).toBe('Foundry Guide');
  });
});

describe('veirDisplay', () => {
  it('is null without a persona', () => {
    expect(veirDisplay({ persona: null })).toBeNull();
    expect(veirDisplay(undefined)).toBeNull();
  });

  it('never names a vEIR after the assignment’s reviewing EIR', () => {
    // A persona built from Ruth but reviewed by Corin: the reviewing EIR's name must not appear.
    const venture = {
      persona: {
        personaId: '00000000-0000-4000-8000-000000000001',
        releaseId: '00000000-0000-4000-8000-000000000002',
        name: 'Ruth’s vEIR',
        kind: 'eir_persona' as const,
        version: 1,
        status: 'active' as const,
        disclosure: 'An AI.',
        allowedModes: ['diagnose' as const],
      },
      assignedEir: {
        id: '00000000-0000-4000-8000-000000000003',
        displayName: 'Corin Halvorsen',
        synthetic: true,
      },
    };
    expect(veirDisplay(venture)?.name).toBe('Ruth’s vEIR');
  });

  it('names the AI as the vEIR and offers no portrait until likeness consent supplies one', () => {
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
    });
    expect(veir).toMatchObject({ name: "Corin's vEIR", portraitUrl: null, kind: 'eir_persona' });
    expect(veir).not.toHaveProperty('shortName');
  });
});

describe('faceMonogram', () => {
  it('shows the EIR’s initial on a vEIR’s face and a guide’s initials', () => {
    expect(faceMonogram('Corin’s vEIR')).toBe('C');
    expect(faceMonogram("Ruth's vEIR")).toBe('R');
    expect(faceMonogram('Foundry Guide')).toBe('FG');
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
