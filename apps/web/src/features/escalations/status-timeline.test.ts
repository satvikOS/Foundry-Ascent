import { EscalationStatus, type EscalationView } from '@foundry/contracts';
import { describe, expect, it } from 'vitest';

import { IDS } from '@/features/coach/testing';
import { isOpenEscalation, isRoutable, needsFounderConsent } from '@/features/program/escalations/status';

import { escalationTimeline } from './status-timeline';

const NOW = '2026-10-05T09:00:00.000Z';

function escalation(overrides: Partial<EscalationView> = {}): EscalationView {
  return {
    id: IDS.ref,
    ventureId: IDS.venture,
    ventureName: 'Seat Finder',
    sessionId: IDS.session,
    turnId: IDS.turn,
    category: 'ip_licensing',
    priority: 'P2',
    status: 'awaiting_consent',
    requestedRole: 'specialist',
    packet: null,
    sharingConsentAt: null,
    assignee: null,
    dueAt: null,
    resolution: null,
    createdBy: { id: IDS.principal, displayName: 'Maya Example', title: null, synthetic: true },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const states = (e: EscalationView) => escalationTimeline(e).map((s) => `${s.id}:${s.state}`);

describe('escalationTimeline', () => {
  it('waits on founder consent before anything is shared', () => {
    expect(states(escalation())).toEqual([
      'drafted:done',
      'consent:current',
      'routed:upcoming',
      'acknowledged:upcoming',
      'resolved:upcoming',
    ]);
  });

  it('shows a consented, unassigned request (awaiting_assignment) as waiting in the routing queue', () => {
    const waiting = escalation({ status: 'awaiting_assignment', sharingConsentAt: NOW });
    expect(states(waiting)).toEqual([
      'drafted:done',
      'consent:done',
      'routed:current',
      'acknowledged:upcoming',
      'resolved:upcoming',
    ]);
    expect(escalationTimeline(waiting)[2]?.detail).toBe('Waiting for the program team to assign someone.');
    expect(needsFounderConsent(waiting)).toBe(false);
    expect(needsFounderConsent(escalation())).toBe(true);
    expect(needsFounderConsent(escalation({ status: 'draft' }))).toBe(true);
  });

  it('separates open, routable and closed statuses', () => {
    const open = EscalationStatus.options.filter((status) => isOpenEscalation({ status }));
    expect(open).toEqual(['draft', 'awaiting_consent', 'awaiting_assignment', 'routed', 'acknowledged']);
    const routable = EscalationStatus.options.filter((status) => isRoutable({ status }));
    // The founder must consent first; closed ones stay closed.
    expect(routable).toEqual(['awaiting_assignment', 'routed', 'acknowledged']);
  });

  it('tracks routing and acknowledgement after consent', () => {
    expect(states(escalation({ status: 'routed', sharingConsentAt: NOW }))).toEqual([
      'drafted:done',
      'consent:done',
      'routed:current',
      'acknowledged:upcoming',
      'resolved:upcoming',
    ]);
    expect(states(escalation({ status: 'acknowledged', sharingConsentAt: NOW }))).toContain(
      'acknowledged:current',
    );
  });

  it('completes on resolution with the summary', () => {
    const steps = escalationTimeline(
      escalation({
        status: 'resolved',
        sharingConsentAt: NOW,
        resolution: { summary: 'Talk to tech transfer first.', nextSteps: [] },
      }),
    );
    expect(steps.every((s) => s.state === 'done')).toBe(true);
    expect(steps.at(-1)?.detail).toBe('Talk to tech transfer first.');
  });

  it('ends early when withdrawn or declined', () => {
    expect(states(escalation({ status: 'withdrawn' }))).toEqual(['drafted:done', 'withdrawn:withdrawn']);
    expect(states(escalation({ status: 'declined', sharingConsentAt: NOW }))).toEqual([
      'drafted:done',
      'consent:done',
      'declined:declined',
    ]);
  });
});
