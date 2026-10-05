import { EscalationPacket, type CoachResponse, type EvidenceItem } from '@foundry/contracts';
import { describe, expect, it } from 'vitest';

import { assemblePacket, dueAtFor } from './escalation-packet.js';

const evidence: EvidenceItem[] = [
  {
    key: 'E1',
    kind: 'memory',
    refId: '00000000-0000-4000-8000-000000000001',
    title: 'Private interview notes',
    excerpt: 'secret',
    score: 1,
    freshnessAt: null,
    status: 'confirmed',
  },
  {
    key: 'E2',
    kind: 'chunk',
    refId: '00000000-0000-4000-8000-000000000002',
    title: 'Pitch deck — Pricing',
    excerpt: 'secret',
    score: 1,
    freshnessAt: null,
    status: 'active',
  },
  {
    key: 'E3',
    kind: 'doctrine',
    refId: '00000000-0000-4000-8000-000000000003',
    title: 'Evidence standard',
    excerpt: 'x',
    score: 1,
    freshnessAt: null,
    status: 'active',
  },
  {
    key: 'E4',
    kind: 'resource',
    refId: '00000000-0000-4000-8000-000000000004',
    title: 'Legal clinic',
    excerpt: 'x',
    score: 1,
    freshnessAt: null,
    status: 'active',
  },
];

const response: CoachResponse = {
  mode: 'coach',
  answer: 'General information only.',
  claims: [
    { text: 'a', kind: 'fact', evidence_ids: ['E1', 'E4'] },
    { text: 'b', kind: 'inference', evidence_ids: ['E3'] },
  ],
  uncertainty: [{ item: 'Who owns the IP', level: 'high' }],
  challenge: null,
  next_actions: [{ owner: 'founder', action: 'Book the legal clinic', target_date: null }],
  escalation: {
    required: true,
    category: 'ip_licensing',
    priority: 'P1',
    reason: 'IP ownership question',
    requested_role: 'specialist',
  },
  memory_candidates: [],
  follow_up_questions: [],
  rehearsal: null,
};

describe('assemblePacket', () => {
  it('keeps the founder question verbatim and shares no venture records', () => {
    const question = '  Who owns the code our RA wrote?\n(asked twice)  ';
    const packet = EscalationPacket.parse(
      assemblePacket({
        founderQuestion: question,
        desiredDecision: null,
        category: 'ip_licensing',
        priority: 'P1',
        turn: { response, evidence },
      }),
    );
    expect(packet.founderQuestion).toBe(question);
    expect(packet.sharedFacts).toEqual([]);
    expect(packet.evidenceConsidered).toEqual([
      { key: 'E3', title: 'Evidence standard' },
      { key: 'E4', title: 'Legal clinic' },
    ]);
    expect(JSON.stringify(packet)).not.toContain('Private interview notes');
    expect(JSON.stringify(packet)).not.toContain('secret');
    expect(packet).toMatchObject({
      unknowns: ['Who owns the IP'],
      reason: 'IP ownership question',
      proposedNextStep: 'Book the legal clinic',
      aiGenerated: true,
    });
    expect(packet.urgency).toMatch(/P1/);
  });

  it('falls back to a neutral reason without a turn', () => {
    const packet = assemblePacket({
      founderQuestion: 'Q',
      desiredDecision: 'D',
      category: 'expert_judgment',
      priority: 'P3',
    });
    expect(packet.reason).toMatch(/expert judgment/);
    expect(packet.unknowns).toEqual([]);
    expect(packet.proposedNextStep).toBeNull();
  });
});

describe('dueAtFor', () => {
  const tz = 'America/New_York';
  it('P0 immediately, P1 next business day, P2 five days, P3 none', () => {
    const wednesday = new Date('2026-10-07T15:00:00Z');
    expect(dueAtFor('P0', wednesday, tz)?.toISOString()).toBe(wednesday.toISOString());
    expect(dueAtFor('P1', wednesday, tz)?.toISOString()).toBe('2026-10-08T15:00:00.000Z');
    expect(dueAtFor('P2', wednesday, tz)?.toISOString()).toBe('2026-10-12T15:00:00.000Z');
    expect(dueAtFor('P3', wednesday, tz)).toBeNull();
  });

  it('skips weekends for P1 in the business time zone', () => {
    const friday = new Date('2026-10-09T15:00:00Z');
    expect(dueAtFor('P1', friday, tz)?.toISOString()).toBe('2026-10-12T15:00:00.000Z');
    // Friday 11pm in New York is already Saturday in UTC: still due Monday.
    const lateFriday = new Date('2026-10-10T03:00:00Z');
    expect(dueAtFor('P1', lateFriday, tz)?.toISOString()).toBe('2026-10-13T03:00:00.000Z');
  });
});
