import { describe, expect, it } from 'vitest';

import { NEUTRAL_VEIR_NAME, veirAuthor } from './veir-name';

describe('veirAuthor', () => {
  it('credits AI work to the vEIR by its full name, never the EIR’s name alone', () => {
    expect(veirAuthor({ name: 'Corin’s vEIR', shortName: 'Corin', kind: 'eir_persona' })).toBe(
      'Corin’s vEIR',
    );
    // An EIR persona released under another name still reads as the vEIR.
    expect(veirAuthor({ name: 'Corin Halvorsen', shortName: 'Corin', kind: 'eir_persona' })).toBe(
      'Corin’s vEIR',
    );
  });

  it('keeps a neutral guide’s own name, and says “your vEIR” when none is assigned', () => {
    expect(veirAuthor({ name: 'Program Guide', shortName: 'Program Guide', kind: 'neutral_guide' })).toBe(
      'Program Guide',
    );
    expect(veirAuthor(null)).toBe(NEUTRAL_VEIR_NAME);
  });
});
