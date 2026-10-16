import type { EirProfileView, LessonView, PersonaReleaseView, PersonaView } from '@foundry/contracts';
import type { z } from 'zod';

/** Test-only: personas, releases and lessons shaped like the API returns them. */

export const IDS = {
  corin: '6b2f3c4d-5e6f-4a71-8b82-c3d4e5f60718',
  ruth: '7c3a4d5e-6f70-4b82-9c93-d4e5f6071829',
  guide: '8d4b5e6f-7081-4c93-8da4-e5f60718293a',
  corinEir: '9e5c6f70-8192-4da4-9eb5-f60718293a4b',
  ruthEir: 'af6d7081-92a3-4eb5-afc6-0718293a4b5c',
  release: '5a1e2b3c-4d5e-4f60-8a71-b2c3d4e5f607',
  venture: 'b0718293-a4b5-4c6d-8e7f-8091a2b3c4d5',
  lesson: 'c1829304-b5c6-4d7e-9f80-91a2b3c4d5e6',
} as const;

export const RELEASE: PersonaReleaseView = {
  id: IDS.release,
  personaId: IDS.corin,
  version: 1,
  doctrine: {
    summary: 'Customer discovery first.',
    frameworks: [{ name: 'Last-time interview', whenToUse: 'Early discovery', keyQuestions: ['When?'] }],
    evidenceStandard: 'Past behaviour beats stated intent.',
    typicalQuestions: [],
    redLines: ['Never claim to be Corin.'],
    escalationTopics: ['IP ownership'],
    referralDestinations: [],
    teachingPrinciples: [],
  },
  style: {
    directness: 'direct',
    warmth: 'reserved',
    pace: 'brisk',
    vocabulary: [],
    feedbackStructure: 'One thing that matters, then one next step.',
    avoid: [],
  },
  disclosureText:
    "You are talking with Corin's vEIR, an AI coach. It is not a person, and no human EIR wrote these responses.",
  allowedModes: ['diagnose', 'coach'],
  status: 'approved',
  createdBy: null,
  approvedBy: { id: IDS.corinEir, displayName: 'Local Owner', title: null, synthetic: false },
  approvedAt: '2026-10-16T09:00:00.000Z',
  createdAt: '2026-10-16T09:00:00.000Z',
};

export function persona(overrides: Partial<PersonaView> = {}): PersonaView {
  return {
    id: IDS.corin,
    name: "Corin's vEIR",
    kind: 'eir_persona',
    status: 'active',
    suspendedReason: null,
    eirProfile: {
      id: IDS.corinEir,
      displayName: 'Corin Halvorsen',
      synthetic: true,
      expertiseTags: ['pricing'],
    },
    hasConsent: true,
    activeRelease: RELEASE,
    releases: [
      {
        id: IDS.release,
        version: 1,
        status: 'approved',
        approvedAt: RELEASE.approvedAt,
        createdAt: RELEASE.createdAt,
      },
    ],
    assignedVentureCount: 2,
    canCurate: true,
    canManageConsent: true,
    ...overrides,
  };
}

export const RUTH = persona({
  id: IDS.ruth,
  name: "Ruth's vEIR",
  eirProfile: { id: IDS.ruthEir, displayName: 'Ruth Abernathy-Song', synthetic: true, expertiseTags: [] },
});

export const GUIDE = persona({
  id: IDS.guide,
  name: 'Foundry Guide',
  kind: 'neutral_guide',
  eirProfile: null,
  canManageConsent: false,
});

export function eirProfile(id: string, displayName: string): z.infer<typeof EirProfileView> {
  return {
    id,
    displayName,
    title: null,
    expertiseTags: [],
    routingIntents: [],
    synthetic: true,
    status: 'active',
  };
}

export function lesson(overrides: Partial<LessonView> = {}): LessonView {
  return {
    id: IDS.lesson,
    personaId: IDS.corin,
    title: 'Polite interest is not demand',
    context: 'Early discovery with friendly users.',
    signal: 'Founders count compliments as validation.',
    intervention: 'Ask for a commitment that costs something.',
    outcome: 'Teams see which signals hold.',
    limits: 'Does not apply once paid pilots exist.',
    sourceClass: 'distilled',
    status: 'draft',
    origin: 'distilled',
    createdAt: '2026-10-16T09:00:00.000Z',
    ...overrides,
  };
}
