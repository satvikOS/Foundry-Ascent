import type { PersonaView } from '@foundry/contracts';

/** The one wording for "adding an EIR, or building a vEIR, records no consent". */
export const CONSENT_FIRST = 'Consent needed before a vEIR can be released';

/**
 * Where an EIR stands with their vEIR: none yet; one that waits for the EIR's consent (a vEIR is only released
 * once its EIR has recorded consent covering doctrine); or one with consent on file.
 */
export type EirVeirState =
  | { kind: 'no_veir' }
  | { kind: 'consent_needed'; persona: PersonaView }
  | { kind: 'consent_on_file'; persona: PersonaView };

export function eirVeirState(profileId: string, personas: readonly PersonaView[]): EirVeirState {
  const persona = personas.find(
    (p) => p.kind === 'eir_persona' && p.status !== 'retired' && p.eirProfile?.id === profileId,
  );
  if (!persona) return { kind: 'no_veir' };
  return persona.hasConsent ? { kind: 'consent_on_file', persona } : { kind: 'consent_needed', persona };
}
