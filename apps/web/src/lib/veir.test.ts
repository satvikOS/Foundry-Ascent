import type { PersonaSummary, VeirIdentity } from '@foundry/contracts';
import { describe, expect, it } from 'vitest';

import {
  conversationVeir,
  monogram,
  personaName,
  veirDisplay,
  veirExplanation,
  veirFacts,
  veirFromIdentity,
  veirName,
  veirWelcome,
} from './veir';

/** Thomas: an EIR persona presented as an AI mentor under its own name (ADR-0021). */
const THOMAS: PersonaSummary = {
  personaId: '00000000-0000-4000-8000-000000000001',
  releaseId: '00000000-0000-4000-8000-000000000002',
  name: 'Thomas',
  kind: 'eir_persona',
  version: 1,
  status: 'active',
  disclosure: 'Thomas is an AI mentor.',
  allowedModes: ['diagnose'],
  presentation: 'mentor',
};

/** Corin's vEIR: an EIR's digital twin (ADR-0020). */
const CORIN: PersonaSummary = {
  ...THOMAS,
  personaId: '00000000-0000-4000-8000-000000000004',
  name: "Corin's vEIR",
  presentation: 'twin',
  eirFirstName: 'Corin',
};

describe('veirName (the name founders see)', () => {
  it('shows a mentor by its own name alone, whatever its EIR or consent', () => {
    expect(veirName('Thomas', 'eir_persona', 'mentor')).toBe('Thomas');
    expect(veirName('  Thomas   Reid ', 'eir_persona', 'mentor', 'Corin', true)).toBe('Thomas Reid');
  });

  it('keeps a twin’s AI marker, so it is never called by the person’s bare first name', () => {
    expect(veirName("Corin's vEIR", 'eir_persona', 'twin', 'Corin', true)).toBe('Corin · vEIR');
    expect(veirName("Corin's vEIR", 'eir_persona', 'twin', 'Corin', false)).toBe("Corin's vEIR");
    expect(veirName('Corin', 'eir_persona', 'twin', 'Corin Halvorsen')).toBe('Corin’s vEIR');
    expect(veirName('Corin', 'eir_persona', 'twin', null, true)).toBe('Corin’s vEIR');
    // An older API without the presentation is a twin: the safe side.
    expect(veirName('Corin', 'eir_persona', undefined, 'Corin')).toBe('Corin’s vEIR');
  });

  it('keeps a guide’s own name', () => {
    expect(veirName('Foundry Guide', 'neutral_guide', 'twin', null, true)).toBe('Foundry Guide');
  });

  it('shows stored names as stored (the studio)', () => {
    expect(personaName("  Corin's   vEIR ")).toBe("Corin's vEIR");
  });
});

describe('veirDisplay', () => {
  it('is null without a persona', () => {
    expect(veirDisplay({ persona: null })).toBeNull();
    expect(veirDisplay(undefined)).toBeNull();
  });

  it('shows a mentor by its name alone, whatever its EIR or consent', () => {
    for (const persona of [
      { ...THOMAS, eirFirstName: 'Corin', firstPerson: true, eirSeesWork: true },
      { ...THOMAS, eirFirstName: 'Corin', firstPerson: false },
      THOMAS,
    ]) {
      const veir = veirDisplay({ persona });
      expect(veir).toMatchObject({ name: 'Thomas', shortName: 'Thomas', presentation: 'mentor' });
      expect(veir?.name).not.toMatch(/vEIR/);
    }
  });

  it('shows a twin with its marker, by the first-person consent', () => {
    expect(veirDisplay({ persona: { ...CORIN, firstPerson: true } })).toMatchObject({
      name: 'Corin · vEIR',
      shortName: 'Corin · vEIR',
      presentation: 'twin',
      eirFirstName: 'Corin',
      firstPerson: true,
    });
    expect(veirDisplay({ persona: CORIN })?.name).toBe("Corin's vEIR");
    // No presentation at all (an older API): a twin.
    const { presentation: _omitted, ...older } = CORIN;
    expect(veirDisplay({ persona: older })?.presentation).toBe('twin');
  });

  it('never names a twin after the assignment’s reviewing EIR', () => {
    const veir = veirDisplay({
      persona: { ...CORIN, name: "Ruth's vEIR", eirFirstName: 'Ruth', firstPerson: true },
      assignedEir: {
        id: '00000000-0000-4000-8000-000000000003',
        displayName: 'Corin Halvorsen',
        synthetic: true,
      },
    } as Parameters<typeof veirDisplay>[0]);
    expect(veir?.name).toBe('Ruth · vEIR');
    expect(JSON.stringify(veir)).not.toContain('Corin');
  });

  it('shows a guide by its own name', () => {
    const veir = veirDisplay({
      persona: { ...THOMAS, name: 'Foundry Guide', kind: 'neutral_guide', firstPerson: true },
    });
    expect(veir).toMatchObject({ name: 'Foundry Guide', eirFirstName: null, firstPerson: false });
  });
});

describe('veirFromIdentity (the call settings)', () => {
  const IDENTITY: VeirIdentity = {
    personaId: THOMAS.personaId,
    name: 'Thomas',
    shortName: 'Thomas',
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
    presentation: 'mentor',
  };

  it('names the mentor by the same rule, and offers a portrait only with likeness consent', () => {
    expect(veirFromIdentity(IDENTITY)).toMatchObject({
      name: 'Thomas',
      shortName: 'Thomas',
      eirFirstName: 'Corin',
      eirSeesWork: false,
      portraitUrl: null,
    });
    expect(
      veirFromIdentity({ ...IDENTITY, embodiment: { ...IDENTITY.embodiment, likenessConsented: true } })
        .portraitUrl,
    ).toBe('https://example.test/p.png');
  });

  it('names a twin with its marker', () => {
    expect(veirFromIdentity({ ...IDENTITY, name: "Corin's vEIR", presentation: 'twin' }).name).toBe(
      'Corin · vEIR',
    );
  });
});

describe('what the mentor is (the About dialog, the welcome)', () => {
  const thomas = {
    kind: 'eir_persona' as const,
    presentation: 'mentor' as const,
    name: 'Thomas',
    eirFirstName: 'Corin',
    eirSeesWork: true,
  };
  const corin = { ...thomas, presentation: 'twin' as const, name: 'Corin · vEIR' };

  it('a mentor: an AI mentor whose approach the program wrote and approved, never an EIR’s (ADR-0021)', () => {
    expect(veirExplanation(thomas)).toBe(
      'Thomas is an AI mentor, not a person. The program wrote and approved the coaching approach Thomas follows; no person writes or approves individual replies.',
    );
    const all = [
      veirExplanation(thomas),
      ...veirFacts(thomas).map((f) => f.text),
      ...veirWelcome(thomas).lines,
    ];
    expect(all.join(' ')).not.toMatch(/consent|their review|doctrine and style|Corin’s/);
  });

  it('a twin: built with its EIR’s consent from their approved doctrine and style, released after review', () => {
    expect(veirExplanation(corin)).toBe(
      'Corin · vEIR is an AI mentor, built with Corin’s consent from their approved doctrine and style, and released after their review.',
    );
    // A twin named exactly as its EIR does not read as "Corin, built with Corin's consent".
    expect(veirExplanation({ ...corin, name: 'Corin' })).not.toContain('Corin’s consent');
  });

  it('a guide: the program’s', () => {
    expect(
      veirExplanation({
        kind: 'neutral_guide',
        presentation: 'twin',
        name: 'Foundry Guide',
        eirFirstName: null,
        eirSeesWork: false,
      }),
    ).toBe('Foundry Guide is the program’s AI mentor, built on its coaching doctrine.');
  });

  it('never claims each answer is approved by a person, or that it never speaks for the EIR', () => {
    for (const veir of [thomas, corin]) {
      const all = [veirExplanation(veir), ...veirFacts(veir).map((f) => f.text)].join(' ');
      expect(all).not.toMatch(/wrote or approved|approves? (its|each) (replies|answers)|never speaks for/i);
    }
  });

  it('lists the facts: AI mentor, AI face and voice, memory and Private, people, limits', () => {
    const facts = veirFacts(thomas);
    expect(facts.map((f) => f.id)).toEqual(['what', 'face', 'memory', 'people', 'limits']);
    const text = facts.map((f) => f.text).join(' ');
    expect(text).toContain('AI avatar');
    expect(text).toContain('AI-generated');
    expect(text).toContain('Private');
    expect(text).toContain('A person from the program');
    expect(text).toMatch(/can’t pass messages.*schedule.*legal, medical or financial advice/);
    // Who sees the work: the person, by their role beside a mentor's name, by their name beside a twin's.
    expect(facts[0]?.text).toContain('Corin, your entrepreneur-in-residence, sees what you work on here.');
    expect(veirFacts(corin)[0]?.text).toContain('Corin sees what you work on here.');
    expect(veirFacts({ ...thomas, eirSeesWork: false })[0]?.text).not.toContain('sees what you work on');
  });

  it('welcomes by name', () => {
    expect(veirWelcome(thomas)).toEqual({
      title: 'Meet Thomas',
      lines: [
        veirExplanation(thomas),
        'Corin, your entrepreneur-in-residence, sees what you work on here, and a person from the program is there when you need one.',
      ],
    });
    expect(veirWelcome(corin).title).toBe('Meet Corin · vEIR');
    expect(veirWelcome({ ...thomas, eirSeesWork: false }).lines[1]).toBe(
      'A person from the program is there whenever you need one.',
    );
  });
});

describe('monogram (people and ventures only)', () => {
  it('uses one letter per word, up to the limit', () => {
    expect(monogram('Corin')).toBe('C');
    expect(monogram('Foundry Guide')).toBe('FG');
    expect(monogram('Maya Okafor-Lindqvist')).toBe('MO');
    expect(monogram('Corin Halvorsen', 1)).toBe('C');
  });
});

describe('conversationVeir (who a conversation is with)', () => {
  const current = veirDisplay({
    persona: { ...THOMAS, personaId: 'p-thomas', eirFirstName: 'Corin', firstPerson: true },
  });

  it('names a conversation with the venture’s current mentor after it', () => {
    expect(
      conversationVeir(
        {
          personaId: 'p-thomas',
          personaName: 'Thomas',
          personaKind: 'eir_persona',
          personaPresentation: 'mentor',
        },
        current,
      ),
    ).toMatchObject({ name: 'Thomas', kind: 'eir_persona' });
  });

  it('names an older conversation’s persona by its own presentation', () => {
    expect(
      conversationVeir(
        {
          personaId: 'p-old',
          personaName: "Ruth's vEIR",
          personaKind: 'eir_persona',
          personaPresentation: 'twin',
        },
        current,
      ),
    ).toMatchObject({ name: "Ruth's vEIR", kind: 'eir_persona' });
    expect(
      conversationVeir(
        { personaId: 'p-old', personaName: 'Ada', personaKind: 'eir_persona', personaPresentation: 'mentor' },
        current,
      ),
    ).toMatchObject({ name: 'Ada' });
    // An older API without the kind or presentation: a name ending in "vEIR" is an EIR persona's, a twin.
    const older = { personaId: 'p-old', personaName: "Ruth's vEIR" } as Parameters<
      typeof conversationVeir
    >[0];
    expect(conversationVeir(older, current)).toMatchObject({
      name: "Ruth's vEIR",
      kind: 'eir_persona',
      presentation: 'twin',
    });
  });

  it('keeps an older conversation’s guide as the guide', () => {
    expect(
      conversationVeir(
        {
          personaId: 'p-guide',
          personaName: 'Foundry Guide',
          personaKind: 'neutral_guide',
          personaPresentation: 'twin',
        },
        current,
      ),
    ).toMatchObject({ name: 'Foundry Guide', kind: 'neutral_guide' });
  });
});
