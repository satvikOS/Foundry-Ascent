import type { PersonaView } from '@foundry/contracts';

import type { ProgramVenture } from '@/lib/api/hooks/program';
import { type AssignPersonaInput } from '@/lib/api/hooks/veir-pools';

/** A persona can coach a venture only while active with an approved release. */
export function isAssignable(persona: Pick<PersonaView, 'status' | 'activeRelease'>): boolean {
  return persona.status === 'active' && persona.activeRelease !== null;
}

/**
 * The reviewing EIR a choice implies. A vEIR is always reviewed by the EIR it is built from (the API
 * refuses anyone else); the neutral program guide is reviewed by whoever is picked, or nobody.
 */
export function reviewingEirId(
  persona: Pick<PersonaView, 'kind' | 'eirProfile'>,
  pickedEirId: string | null,
): string | null {
  return persona.kind === 'eir_persona' ? (persona.eirProfile?.id ?? null) : pickedEirId;
}

/** The `POST /ventures/:id/assignment` body for a choice. */
export function assignmentRequest(
  persona: Pick<PersonaView, 'id' | 'kind' | 'eirProfile'>,
  pickedEirId: string | null,
): AssignPersonaInput {
  return { personaId: persona.id, eirProfileId: reviewingEirId(persona, pickedEirId) };
}

/** Whether the choice is what the venture already has (nothing to save). */
export function isCurrentAssignment(
  row: Pick<ProgramVenture, 'personaId' | 'reviewingEir'>,
  request: AssignPersonaInput,
): boolean {
  return (
    row.personaId === request.personaId && (row.reviewingEir?.id ?? null) === (request.eirProfileId ?? null)
  );
}

/** Ventures per persona id (and `null` for unassigned), for the filter chips. */
export function countByPersona(
  rows: readonly Pick<ProgramVenture, 'personaId'>[],
): Map<string | null, number> {
  const counts = new Map<string | null, number>();
  for (const row of rows) counts.set(row.personaId, (counts.get(row.personaId) ?? 0) + 1);
  return counts;
}
