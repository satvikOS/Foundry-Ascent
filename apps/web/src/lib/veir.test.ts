import type { PersonaSummary, VeirIdentity } from '@foundry/contracts';
import { describe, expect, it } from 'vitest';

import {
  conversationVeir,
  faceMonogram,
  monogram,
  veirDisplay,
  veirExplanation,
  veirFromIdentity,
  veirName,
  veirWelcome,
} from './veir';

const PERSONA: PersonaSummary = {
  personaId: '00000000-0000-4000-8000-000000000001',
  releaseId: '00000000-0000-4000-8000-000000000002',
  name: "Corin's vEIR",
  kind: 'eir_persona',
  version: 1,
  status: 'active',
  disclosure: 'Corin’s vEIR is an AI.',
  allowedModes: ['diagnose'],
};

describe('veirName (the twin in text)', () => {
  it('is "<first name> · vEIR" with the EIR’s first-person consent', () => {
    expect(veirName("Corin's vEIR", 'eir_persona', 'Corin Halvorsen', true)).toBe('Corin · vEIR');
    // The first name of the persona's own consented EIR, else its own possessive name.
    expect(veirName('Deep-tech pathway mentor', 'eir_persona', 'Ruth Abernathy-Song', true)).toBe(
      'Ruth · vEIR',
    );
    expect(veirName('Ruth’s vEIR', 'eir_persona', null, true)).toBe('Ruth · vEIR');
  });

  it('keeps "<first name>’s vEIR" without that consent', () => {
    expect(veirName("Corin's vEIR", 'eir_persona', 'Corin Halvorsen')).toBe("Corin's vEIR");
    expect(veirName('  Ruth’s   vEIR ', 'eir_persona')).toBe('Ruth’s vEIR');
    // An EIR persona never reads as the EIR: any other name becomes "<first name>’s vEIR".
    expect(veirName('Corin Halvorsen', 'eir_persona')).toBe('Corin’s vEIR');
    expect(veirName('Corin', 'eir_persona')).toBe('Corin’s vEIR');
    expect(veirName('Deep-tech pathway mentor', 'eir_persona', 'Ruth Abernathy-Song')).toBe('Ruth’s vEIR');
  });

  it('keeps a neutral guide’s own name, consent or not', () => {
    expect(veirName('Foundry Guide', 'neutral_guide', 'Corin Halvorsen', true)).toBe('Foundry Guide');
  });
});

describe('veirDisplay', () => {
  it('is null without a persona', () => {
    expect(veirDisplay({ persona: null })).toBeNull();
    expect(veirDisplay(undefined)).toBeNull();
  });

  it('shows the twin like a call tile: "Corin" beside a "vEIR" badge, with the consent', () => {
    const veir = veirDisplay({
      persona: { ...PERSONA, eirFirstName: 'Corin', firstPerson: true, eirSeesWork: true },
    });
    expect(veir).toMatchObject({
      name: 'Corin · vEIR',
      shortName: 'Corin',
      badge: 'vEIR',
      eirFirstName: 'Corin',
      firstPerson: true,
      eirSeesWork: true,
      portraitUrl: null,
    });
  });

  it('stays "Corin’s vEIR" with an "AI" badge without it, and for an older API', () => {
    for (const persona of [
      { ...PERSONA, eirFirstName: 'Corin', firstPerson: false },
      PERSONA, // no presence fields at all
    ]) {
      expect(veirDisplay({ persona })).toMatchObject({
        name: "Corin's vEIR",
        shortName: "Corin's vEIR",
        badge: 'AI',
        firstPerson: false,
        eirSeesWork: false,
      });
    }
  });

  it('never names a vEIR after the assignment’s reviewing EIR', () => {
    // A persona built from Ruth but reviewed by Corin: the reviewing EIR's name must not appear.
    const veir = veirDisplay({
      persona: { ...PERSONA, name: 'Ruth’s vEIR', eirFirstName: 'Ruth', firstPerson: true },
      assignedEir: {
        id: '00000000-0000-4000-8000-000000000003',
        displayName: 'Corin Halvorsen',
        synthetic: true,
      },
    } as Parameters<typeof veirDisplay>[0]);
    expect(veir?.name).toBe('Ruth · vEIR');
    expect(veir?.name).not.toContain('Corin');
  });

  it('shows a guide by its own name with an "AI" badge', () => {
    const veir = veirDisplay({
      persona: { ...PERSONA, name: 'Foundry Guide', kind: 'neutral_guide', firstPerson: true },
    });
    expect(veir).toMatchObject({
      name: 'Foundry Guide',
      shortName: 'Foundry Guide',
      badge: 'AI',
      firstPerson: false,
    });
  });
});

describe('veirFromIdentity (the call settings)', () => {
  const IDENTITY: VeirIdentity = {
    personaId: PERSONA.personaId,
    name: "Corin's vEIR",
    shortName: 'Corin',
    kind: 'eir_persona',
    eirDisplayName: 'Corin Halvorsen',
    tagline: null,
    disclosure: 'AI',
    embodiment: {
      provider: 'builtin',
      voiceId: null,
      portraitUrl: 'https://example.test/p.png',
      voiceConsented: true,
      likenessConsented: false,
    },
    firstPerson: true,
    eirSeesWork: false,
  };

  it('names the vEIR by the same rule, and offers a portrait only with likeness consent', () => {
    expect(veirFromIdentity(IDENTITY)).toMatchObject({
      name: 'Corin · vEIR',
      shortName: 'Corin',
      badge: 'vEIR',
      eirSeesWork: false,
      portraitUrl: null,
    });
    expect(
      veirFromIdentity({ ...IDENTITY, embodiment: { ...IDENTITY.embodiment, likenessConsented: true } })
        .portraitUrl,
    ).toBe('https://example.test/p.png');
    expect(veirFromIdentity({ ...IDENTITY, firstPerson: false }).name).toBe("Corin's vEIR");
  });
});

describe('what a vEIR is (the badge, the welcome)', () => {
  const corin = {
    kind: 'eir_persona' as const,
    name: 'Corin · vEIR',
    eirFirstName: 'Corin',
    eirSeesWork: true,
  };

  it('explains the twin honestly in one short paragraph', () => {
    expect(veirExplanation(corin)).toBe(
      'Corin’s digital twin: an AI built with Corin’s consent from how Corin coaches. Corin sees what you work on here. It isn’t Corin in person, and Corin doesn’t write or approve its replies.',
    );
    expect(veirExplanation({ ...corin, eirSeesWork: false })).not.toContain('sees what you work on');
    expect(
      veirExplanation({
        kind: 'neutral_guide',
        name: 'Foundry Guide',
        eirFirstName: null,
        eirSeesWork: false,
      }),
    ).toBe(
      'Foundry Guide is the program’s AI coach. It isn’t a person, and no one in the program writes or approves its replies.',
    );
  });

  it('welcomes in two short sentences, naming who sees the work only when that is true', () => {
    expect(veirWelcome(corin)).toEqual({
      title: 'Meet Corin’s vEIR',
      lines: [
        'Corin’s digital twin: an AI built with Corin’s consent from how Corin coaches.',
        'Corin sees what you work on here.',
      ],
    });
    expect(veirWelcome({ ...corin, eirSeesWork: false }).lines[1]).toBe('It isn’t Corin in person.');
  });
});

describe('faceMonogram', () => {
  it('shows the EIR’s initial on a vEIR’s face and a guide’s initials', () => {
    expect(faceMonogram('Corin’s vEIR')).toBe('C');
    expect(faceMonogram("Ruth's vEIR")).toBe('R');
    expect(faceMonogram('Corin · vEIR')).toBe('C');
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

describe('conversationVeir (who a conversation is with)', () => {
  const CORIN = veirDisplay({
    persona: { ...PERSONA, personaId: 'p-corin', eirFirstName: 'Corin', firstPerson: true },
  });
  const GUIDE_ID = 'p-guide';

  it('names a conversation with the venture’s current vEIR after it', () => {
    expect(
      conversationVeir(
        { personaId: 'p-corin', personaName: "Corin's vEIR", personaKind: 'eir_persona' },
        CORIN,
      ),
    ).toMatchObject({ name: 'Corin · vEIR', shortName: 'Corin', badge: 'vEIR', kind: 'eir_persona' });
  });

  it('keeps an older conversation’s guide as the guide, never "Foundry’s vEIR"', () => {
    expect(
      conversationVeir(
        { personaId: GUIDE_ID, personaName: 'Foundry Guide', personaKind: 'neutral_guide' },
        CORIN,
      ),
    ).toMatchObject({ name: 'Foundry Guide', kind: 'neutral_guide', badge: 'AI' });
    // An older API without the kind: a name without "vEIR" is a guide's.
    expect(
      conversationVeir({ personaId: GUIDE_ID, personaName: 'Foundry Guide', personaKind: null }, CORIN),
    ).toMatchObject({ name: 'Foundry Guide', kind: 'neutral_guide' });
  });

  it('names an older conversation with another EIR’s vEIR after that vEIR, without the tile name', () => {
    expect(
      conversationVeir(
        { personaId: 'p-ruth', personaName: "Ruth's vEIR", personaKind: 'eir_persona' },
        CORIN,
      ),
    ).toMatchObject({ name: "Ruth's vEIR", kind: 'eir_persona', badge: 'AI', firstPerson: false });
    expect(
      conversationVeir({ personaId: 'p-ruth', personaName: "Ruth's vEIR", personaKind: null }, null),
    ).toMatchObject({ name: "Ruth's vEIR", kind: 'eir_persona' });
  });
});
