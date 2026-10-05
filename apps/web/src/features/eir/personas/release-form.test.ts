import { CreatePersonaReleaseRequest, DEFAULT_DISCLOSURE, type PersonaReleaseView } from '@foundry/contracts';
import { describe, expect, it } from 'vitest';

import { formToRelease, releaseToForm, ReleaseFormSchema } from './release-form';

const RELEASE: PersonaReleaseView = {
  id: '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
  personaId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  version: 3,
  doctrine: {
    summary: 'Evidence before eloquence.',
    frameworks: [
      { name: 'Assumption mapping', whenToUse: 'Early discovery', keyQuestions: ['What must be true?'] },
    ],
    evidenceStandard: 'Primary customer evidence.',
    typicalQuestions: ['Who pays?'],
    redLines: ['No investment advice'],
    escalationTopics: ['Securities'],
    referralDestinations: ['Tech transfer office'],
    teachingPrinciples: ['Ask before telling'],
  },
  style: {
    directness: 'direct',
    warmth: 'warm',
    pace: 'brisk',
    vocabulary: ['riskiest assumption'],
    feedbackStructure: 'Working → risk → next step',
    avoid: ['jargon'],
  },
  disclosureText: DEFAULT_DISCLOSURE,
  allowedModes: ['diagnose', 'challenge'],
  status: 'approved',
  createdBy: null,
  approvedBy: null,
  approvedAt: '2026-09-01T10:00:00.000Z',
  createdAt: '2026-08-30T10:00:00.000Z',
};

describe('release form', () => {
  it('round-trips an existing release into a valid create request', () => {
    const values = releaseToForm(RELEASE, DEFAULT_DISCLOSURE);
    expect(values.redLines).toBe('No investment advice');
    expect(ReleaseFormSchema.safeParse(values).success).toBe(true);
    const request = formToRelease(values);
    expect(CreatePersonaReleaseRequest.safeParse(request).success).toBe(true);
    expect(request.doctrine).toEqual(RELEASE.doctrine);
    expect(request.style).toEqual(RELEASE.style);
  });

  it('splits one-per-line fields, drops blank lines and keeps the canonical mode order', () => {
    const values = {
      ...releaseToForm(RELEASE, DEFAULT_DISCLOSURE),
      redLines: '  No legal advice \n\n No valuations ',
      allowedModes: ['route', 'diagnose'] as const,
    };
    const request = formToRelease({ ...values, allowedModes: [...values.allowedModes] });
    expect(request.doctrine.redLines).toEqual(['No legal advice', 'No valuations']);
    expect(request.allowedModes).toEqual(['diagnose', 'route']);
  });

  it('requires red lines, escalation topics, a mode and an AI disclosure', () => {
    const values = releaseToForm(null, DEFAULT_DISCLOSURE);
    const result = ReleaseFormSchema.safeParse({
      ...values,
      redLines: '',
      escalationTopics: ' \n ',
      allowedModes: [],
      disclosureText: 'You are talking with a coach who will help you think it through.',
    });
    expect(result.success).toBe(false);
    const paths = result.error?.issues.map((issue) => issue.path.join('.'));
    expect(paths).toEqual(
      expect.arrayContaining(['summary', 'redLines', 'escalationTopics', 'allowedModes', 'disclosureText']),
    );
    const disclosure = result.error?.issues.find((issue) => issue.path[0] === 'disclosureText');
    expect(disclosure?.message).toBe('The disclosure must say plainly that this is an AI.');
  });

  it('defaults a first release to every mode and the platform disclosure', () => {
    const values = releaseToForm(null, DEFAULT_DISCLOSURE);
    expect(values.allowedModes).toHaveLength(6);
    expect(values.disclosureText).toBe(DEFAULT_DISCLOSURE);
    expect(values.frameworks).toEqual([]);
  });
});
