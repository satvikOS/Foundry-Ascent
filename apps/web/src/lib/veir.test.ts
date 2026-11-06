import type { PersonaSummary, VeirIdentity } from '@foundry/contracts';
import { describe, expect, it } from 'vitest';

import {
  conversationVeir,
  monogram,
  veirDisplay,
  veirExplanation,
  veirFacts,
  veirFromIdentity,
  veirName,
  veirWelcome,
} from './veir';

const PERSONA: PersonaSummary = {
  personaId: '00000000-0000-4000-8000-000000000001',
  releaseId: '00000000-0000-4000-8000-000000000002',
  name: 'Thomas',
  kind: 'eir_persona',
  version: 1,
  status: 'active',
  disclosure: 'Thomas is an AI mentor.',
  allowedModes: ['diagnose'],
};

describe('veirName (the persona display name)', () => {
  it('is the persona’s own name', () => {
    expect(veirName('Thomas')).toBe('Thomas');
    expect(veirName('  Thomas   Reid ')).toBe('Thomas Reid');
  });

  it('drops a stored "vEIR" label, in any of its forms', () => {
    expect(veirName("Corin's vEIR")).toBe('Corin');
    expect(veirName('Thomas’s vEIR')).toBe('Thomas');
    expect(veirName('Thomas · vEIR')).toBe('Thomas');
    expect(veirName('Thomas vEIR')).toBe('Thomas');
    expect(veirName('Thomas - VEIR')).toBe('Thomas');
  });

  it('keeps a name that is nothing but the label', () => {
    expect(veirName('vEIR')).toBe('vEIR');
  });
});

describe('veirDisplay', () => {
  it('is null without a persona', () => {
    expect(veirDisplay({ persona: null })).toBeNull();
    expect(veirDisplay(undefined)).toBeNull();
  });

  it('shows just the persona’s name, whatever its EIR or consent', () => {
    for (const persona of [
      { ...PERSONA, eirFirstName: 'Corin', firstPerson: true, eirSeesWork: true },
      { ...PERSONA, eirFirstName: 'Corin', firstPerson: false },
      PERSONA, // an older API: no presence fields at all
    ]) {
      const veir = veirDisplay({ persona });
      expect(veir).toMatchObject({ name: 'Thomas', shortName: 'Thomas', portraitUrl: null });
      expect(veir?.name).not.toMatch(/vEIR/);
    }
    expect(
      veirDisplay({ persona: { ...PERSONA, eirFirstName: 'Corin', firstPerson: true, eirSeesWork: true } }),
    ).toMatchObject({ eirFirstName: 'Corin', firstPerson: true, eirSeesWork: true });
  });

  it('shows a persona stored with a vEIR label by its name alone', () => {
    expect(veirDisplay({ persona: { ...PERSONA, name: "Corin's vEIR" } })?.name).toBe('Corin');
  });

  it('never names a mentor after the assignment’s reviewing EIR', () => {
    const veir = veirDisplay({
      persona: { ...PERSONA, eirFirstName: 'Ruth', firstPerson: true },
      assignedEir: {
        id: '00000000-0000-4000-8000-000000000003',
        displayName: 'Corin Halvorsen',
        synthetic: true,
      },
    } as Parameters<typeof veirDisplay>[0]);
    expect(veir?.name).toBe('Thomas');
    expect(JSON.stringify(veir)).not.toContain('Corin');
  });

  it('shows a guide by its own name', () => {
    const veir = veirDisplay({
      persona: { ...PERSONA, name: 'Foundry Guide', kind: 'neutral_guide', firstPerson: true },
    });
    expect(veir).toMatchObject({ name: 'Foundry Guide', eirFirstName: null, firstPerson: false });
  });
});

describe('veirFromIdentity (the call settings)', () => {
  const IDENTITY: VeirIdentity = {
    personaId: PERSONA.personaId,
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
    expect(veirFromIdentity({ ...IDENTITY, name: 'Thomas · vEIR' }).name).toBe('Thomas');
  });
});

describe('what the mentor is (the About dialog, the welcome)', () => {
  const thomas = { kind: 'eir_persona' as const, name: 'Thomas', eirFirstName: 'Corin', eirSeesWork: true };

  it('says it is an AI mentor built with the EIR’s consent and released after their review', () => {
    expect(veirExplanation(thomas)).toBe(
      'Thomas is an AI mentor, built with Corin’s consent from their approved doctrine and style, and released after their review.',
    );
    // A persona named like its EIR does not read as "Corin, built with Corin's consent".
    expect(veirExplanation({ ...thomas, name: 'Corin' })).not.toContain('Corin’s consent');
    expect(
      veirExplanation({
        kind: 'neutral_guide',
        name: 'Foundry Guide',
        eirFirstName: null,
        eirSeesWork: false,
      }),
    ).toBe('Foundry Guide is the program’s AI mentor, built on its coaching doctrine.');
  });

  it('never claims each answer is approved by a person, or that it never speaks for the EIR', () => {
    const all = [veirExplanation(thomas), ...veirFacts(thomas).map((f) => f.text)].join(' ');
    expect(all).not.toMatch(/wrote or approved|approves? (its|each) (replies|answers)|never speaks for/i);
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
    expect(facts[0]?.text).toContain('Corin sees what you work on here.');
    expect(veirFacts({ ...thomas, eirSeesWork: false })[0]?.text).not.toContain('sees what you work on');
  });

  it('welcomes by name in two short sentences', () => {
    expect(veirWelcome(thomas)).toEqual({
      title: 'Meet Thomas',
      lines: [
        veirExplanation(thomas),
        'Corin sees what you work on here, and a person from the program is there when you need one.',
      ],
    });
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
  const THOMAS = veirDisplay({
    persona: { ...PERSONA, personaId: 'p-thomas', eirFirstName: 'Corin', firstPerson: true },
  });

  it('names a conversation with the venture’s current mentor after it', () => {
    expect(
      conversationVeir({ personaId: 'p-thomas', personaName: 'Thomas', personaKind: 'eir_persona' }, THOMAS),
    ).toMatchObject({ name: 'Thomas', kind: 'eir_persona' });
  });

  it('names an older conversation’s persona by the same rule', () => {
    expect(
      conversationVeir(
        { personaId: 'p-old', personaName: "Ruth's vEIR", personaKind: 'eir_persona' },
        THOMAS,
      ),
    ).toMatchObject({ name: 'Ruth', kind: 'eir_persona' });
    // An older API without the kind: a name ending in "vEIR" is an EIR persona's.
    const older = { personaId: 'p-old', personaName: "Ruth's vEIR" } as Parameters<
      typeof conversationVeir
    >[0];
    expect(conversationVeir(older, THOMAS)).toMatchObject({
      name: 'Ruth',
      kind: 'eir_persona',
    });
  });

  it('keeps an older conversation’s guide as the guide', () => {
    expect(
      conversationVeir(
        { personaId: 'p-guide', personaName: 'Foundry Guide', personaKind: 'neutral_guide' },
        THOMAS,
      ),
    ).toMatchObject({ name: 'Foundry Guide', kind: 'neutral_guide' });
  });
});
