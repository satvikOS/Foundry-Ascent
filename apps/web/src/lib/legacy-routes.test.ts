import { describe, expect, it } from 'vitest';

import { legacyAdminSection, legacyVentureTarget } from './legacy-routes';

const SESSION = '3f1f8a52-1c2b-4c1e-9f0a-2b7d1a4c5e6f';

describe('legacyVentureTarget', () => {
  it('sends the overview, the coach list and the bare venture to a new chat', () => {
    expect(legacyVentureTarget('', {})).toEqual({ page: 'chat' });
    expect(legacyVentureTarget('overview', {})).toEqual({ page: 'chat' });
    expect(legacyVentureTarget('coach', { start: 'rehearse' })).toEqual({ page: 'chat' });
    expect(legacyVentureTarget('coach/', {})).toEqual({ page: 'chat' });
  });

  it('keeps the session id and a valid view for conversations', () => {
    expect(legacyVentureTarget(`coach/${SESSION}`, { view: 'recap', junk: 1 })).toEqual({
      page: 'conversation',
      sessionId: SESSION,
      search: { view: 'recap' },
    });
    expect(legacyVentureTarget(`coach/${SESSION.toUpperCase()}`, { view: 'bogus' })).toEqual({
      page: 'conversation',
      sessionId: SESSION,
      search: {},
    });
    expect(legacyVentureTarget('coach/not-a-session', {})).toEqual({ page: 'chat' });
  });

  it('maps memory and the typed views to Knowledge filters', () => {
    expect(legacyVentureTarget('memory', { q: 'pilot', view: 'proposed' })).toEqual({
      page: 'knowledge',
      search: { q: 'pilot', view: 'proposed' },
    });
    expect(legacyVentureTarget('decisions', {})).toEqual({ page: 'knowledge', search: { type: 'decision' } });
    expect(legacyVentureTarget('experiments', {})).toEqual({
      page: 'knowledge',
      search: { type: 'experiment' },
    });
    expect(legacyVentureTarget('milestones', {})).toEqual({
      page: 'knowledge',
      search: { type: 'milestone' },
    });
    expect(legacyVentureTarget('evidence', {})).toEqual({ page: 'knowledge', search: { view: 'evidence' } });
  });

  it('maps documents, team and escalations (keeping a valid escalation id)', () => {
    expect(legacyVentureTarget('documents', {})).toEqual({ page: 'documents' });
    expect(legacyVentureTarget('team', {})).toEqual({ page: 'team' });
    expect(legacyVentureTarget('escalations', { id: SESSION })).toEqual({
      page: 'help',
      search: { id: SESSION },
    });
    expect(legacyVentureTarget('escalations', { id: '../x' })).toEqual({ page: 'help', search: {} });
  });

  it('opens a new chat for anything unknown', () => {
    expect(legacyVentureTarget('something-else/deeper', {})).toEqual({ page: 'chat' });
  });
});

describe('legacyAdminSection', () => {
  it('keeps known sections and falls back to people & access', () => {
    expect(legacyAdminSection('audit')).toBe('audit');
    expect(legacyAdminSection('usage/')).toBe('usage');
    expect(legacyAdminSection('')).toBe('principals');
    expect(legacyAdminSection('nope')).toBe('principals');
  });
});
