import { describe, expect, it } from 'vitest';

import { GUIDE, IDS, persona, RUTH } from '@/features/eir/personas/test-fixtures';

import {
  assignmentRequest,
  countByPersona,
  isAssignable,
  isCurrentAssignment,
  reviewingEirId,
} from './assignment';

describe('assignment rules', () => {
  it('assigns only active personas with an approved release', () => {
    expect(isAssignable(persona())).toBe(true);
    expect(isAssignable(persona({ status: 'suspended' }))).toBe(false);
    expect(isAssignable(persona({ status: 'draft', activeRelease: null }))).toBe(false);
  });

  it('reviews a vEIR by its own EIR and the program guide by whoever is picked', () => {
    expect(reviewingEirId(RUTH, IDS.corinEir)).toBe(IDS.ruthEir);
    expect(reviewingEirId(GUIDE, IDS.corinEir)).toBe(IDS.corinEir);
    expect(reviewingEirId(GUIDE, null)).toBeNull();
    expect(assignmentRequest(RUTH, null)).toEqual({ personaId: IDS.ruth, eirProfileId: IDS.ruthEir });
    expect(assignmentRequest(GUIDE, null)).toEqual({ personaId: IDS.guide, eirProfileId: null });
  });

  it('knows when a choice changes nothing', () => {
    const row = { personaId: IDS.corin, reviewingEir: { id: IDS.corinEir, displayName: 'Corin Halvorsen' } };
    expect(isCurrentAssignment(row, assignmentRequest(persona(), null))).toBe(true);
    expect(isCurrentAssignment(row, assignmentRequest(RUTH, null))).toBe(false);
    expect(
      isCurrentAssignment(
        { personaId: IDS.guide, reviewingEir: null },
        { personaId: IDS.guide, eirProfileId: null },
      ),
    ).toBe(true);
  });

  it('counts ventures per vEIR, unassigned ones under null', () => {
    const counts = countByPersona([{ personaId: IDS.corin }, { personaId: IDS.corin }, { personaId: null }]);
    expect(counts.get(IDS.corin)).toBe(2);
    expect(counts.get(null)).toBe(1);
    expect(counts.get(IDS.ruth)).toBeUndefined();
  });
});
