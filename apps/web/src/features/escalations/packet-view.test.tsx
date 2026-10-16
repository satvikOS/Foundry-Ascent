import type { EscalationView } from '@foundry/contracts';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DELETED_CONVERSATION, PacketView } from './packet-view';

const PERSON = {
  id: '00000000-0000-4000-8000-000000000009',
  displayName: 'Maya Example',
  title: null,
  synthetic: true,
};

function escalation(overrides: Partial<EscalationView> = {}): EscalationView {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    ventureId: '00000000-0000-4000-8000-000000000002',
    ventureName: 'QuietQuad',
    sessionId: null,
    turnId: null,
    category: 'ip_licensing',
    priority: 'P2',
    status: 'assigned',
    requestedRole: 'eir',
    packet: {
      founderQuestion: 'Should we file a provisional patent before demo day?',
      desiredDecision: 'File now or wait',
      sharedFacts: [{ memoryId: '00000000-0000-4000-8000-000000000003', text: 'Demo day is in May.' }],
      evidenceConsidered: [{ key: 'E1', title: 'Pilot plan' }],
      conflictingSignals: [],
      unknowns: ['Prior art'],
      reason: 'Legal questions need a person.',
      urgency: 'Before demo day',
      proposedNextStep: null,
      sessionSummary: null,
      aiGenerated: true,
    },
    sharingConsentAt: '2026-10-01T12:00:00.000Z',
    assignee: null,
    dueAt: null,
    resolution: null,
    createdBy: PERSON,
    createdAt: '2026-10-01T11:00:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z',
    ...overrides,
  } as EscalationView;
}

describe('PacketView (one packet renderer for the founder and the person it went to)', () => {
  it('labels the brief for the person it went to, marks memory facts and leaves empty rows out', () => {
    render(<PacketView escalation={escalation()} audience="assignee" />);
    expect(screen.getByText('AI-drafted')).toBeInTheDocument();
    expect(screen.getByText(/Shared by the founder .* Verify before acting\./)).toBeInTheDocument();
    expect(screen.getByText('Founder’s question')).toBeInTheDocument();
    expect(screen.getByText('(from venture memory)')).toBeInTheDocument();
    expect(screen.queryByText('Conflicting signals')).toBeNull();
    expect(screen.queryByText('Proposed next step')).toBeNull();
  });

  it('speaks to the founder in their own words', () => {
    render(<PacketView escalation={escalation()} audience="founder" />);
    expect(screen.getByText('Your question')).toBeInTheDocument();
    expect(screen.queryByText('(from venture memory)')).toBeNull();
  });

  it('says calmly that a request from a deleted conversation lost its details', () => {
    const base = escalation();
    const erased = escalation({
      status: 'withdrawn',
      sharingConsentAt: null,
      packet: base.packet
        ? { ...base.packet, founderQuestion: DELETED_CONVERSATION, reason: DELETED_CONVERSATION }
        : null,
    });
    render(<PacketView escalation={erased} audience="founder" />);
    expect(screen.getByText(/came from a conversation that was deleted/)).toBeInTheDocument();
    expect(screen.queryByText(DELETED_CONVERSATION)).toBeNull();
    expect(screen.queryByText('Your question')).toBeNull();
  });
});
