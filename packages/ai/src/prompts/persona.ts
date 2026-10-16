import { DEFAULT_PERSONA_NAME } from './version.js';

/**
 * Who the coach is, as far as identity rules are concerned.
 *
 * - `neutral`: the program-wide guide ("Foundry Guide"). It speaks for no one.
 * - `veir`: "<EIR first name>'s vEIR", an AI built with consent from one EIR's approved doctrine and
 *   style. It may say "I", use its persona name and work in the EIR's style, but it is never the EIR:
 *   it never claims to be them, to be live or human, or that they reviewed or endorsed anything.
 */
export interface PersonaIdentity {
  kind: 'neutral' | 'veir';
  /** Display name of the persona ("Foundry Guide", "Corin's vEIR"). */
  personaName: string;
  /** The EIR's first name ("Corin"), for `veir` personas. */
  eirFirstName: string | null;
  /** The EIR's full display name ("Corin Halvorsen") when known, for `veir` personas. */
  eirFullName: string | null;
}

/** `Corin's vEIR` / `Corin’s VEIR` → `Corin`; null for any other persona name. */
const VEIR_NAME = /^\s*(\p{Lu}[\p{L}\p{M}'’-]*?)['’]s\s+[vV]\s?[Ee][Ii][Rr]\s*$/u;

/** The EIR first name of a "<first name>'s vEIR" persona name, or null. */
export function veirFirstName(personaName: string): string | null {
  const match = VEIR_NAME.exec(personaName.normalize('NFKC'));
  const first = match?.[1]?.trim() ?? '';
  return first.replace(/[^\p{L}]/gu, '').length >= 2 ? first : null;
}

/** First word of a display name ("Ruth Abernathy-Song" → "Ruth"). */
export function firstNameOf(displayName: string): string {
  return displayName.normalize('NFKC').trim().split(/\s+/)[0] ?? '';
}

/**
 * Resolves the identity of a persona. `eirName` is the EIR's display name when the caller knows it
 * (the persona's EIR profile); otherwise the EIR first name is read from a "<name>'s vEIR" persona
 * name. A persona that names an EIR whose first name does not match the persona name is treated by
 * the EIR given, so the rules always protect the right person.
 */
export function resolvePersonaIdentity(
  personaName: string | undefined,
  eirName?: string | null,
): PersonaIdentity {
  const trimmedName = personaName?.trim() ?? '';
  const name = trimmedName === '' ? DEFAULT_PERSONA_NAME : trimmedName;
  const trimmedEir = eirName?.trim() ?? '';
  const full = trimmedEir === '' ? null : trimmedEir;
  const first = full !== null ? firstNameOf(full) : veirFirstName(name);
  if (first === null || first === '') {
    return { kind: 'neutral', personaName: name, eirFirstName: null, eirFullName: null };
  }
  return { kind: 'veir', personaName: name, eirFirstName: first, eirFullName: full };
}

/**
 * A disclosure for a vEIR persona release that meets the persistent-disclosure requirement (it says
 * the coach is an AI, that it is not a person, and that no human EIR authored or approved the
 * responses; evals `grade_disclosure`) while naming whose approach it carries.
 */
export function buildVeirDisclosure(input: { personaName: string; eirName: string }): string {
  const first = firstNameOf(input.eirName);
  return `You are talking with ${input.personaName}, an AI mentor built with consent from ${input.eirName}'s approach. It is not a person and it is not ${first}, and no human EIR authored or approved these responses.`;
}
