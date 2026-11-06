import { DEFAULT_PERSONA_NAME } from './version.js';

/**
 * Who the coach is, as far as identity rules are concerned.
 *
 * - `neutral`: the program-wide guide ("Foundry Guide"). It speaks for no one.
 * - `veir`: "<EIR first name>'s vEIR", an AI built with consent from one EIR's approved doctrine and
 *   style. It may say "I", use its persona name and work in the EIR's style, but it is never the EIR:
 *   it never claims to be them, to be live or human, or that they reviewed or endorsed anything.
 * - `mentor`: an AI mentor presented under its own name ("Thomas", a stock avatar's persona; ADR-0021). It speaks
 *   as itself in the first person; its doctrine is still an EIR's, under their consent, but it never presents
 *   itself as that EIR or as their twin, and it has no life, career or meetings of its own.
 */
export interface PersonaIdentity {
  kind: 'neutral' | 'veir' | 'mentor';
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

/** Honorifics before a name: never a first name (live pilot 42099643194: "Hi Dr." and "Thanks, Dr."). */
const HONORIFIC = /^(?:dr|prof|professor|mr|mrs|ms|miss|mx|sir|dame|rev|fr)\.?$/i;

/** First word of a display name, after any honorific ("Ruth Abernathy-Song" → "Ruth", "Dr. Ana Ruiz" → "Ana"). */
export function firstNameOf(displayName: string): string {
  const words = displayName.normalize('NFKC').trim().split(/\s+/);
  return words.find((w) => !HONORIFIC.test(w)) ?? words[0] ?? '';
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
  mentor = false,
): PersonaIdentity {
  const trimmedName = personaName?.trim() ?? '';
  const name = trimmedName === '' ? DEFAULT_PERSONA_NAME : trimmedName;
  // A mentor speaks under its own name: its EIR is never the name it presents (the validators still guard it).
  if (mentor && trimmedName !== '') {
    return { kind: 'mentor', personaName: name, eirFirstName: null, eirFullName: null };
  }
  const trimmedEir = eirName?.trim() ?? '';
  const full = trimmedEir === '' ? null : trimmedEir;
  const first = full !== null ? firstNameOf(full) : veirFirstName(name);
  if (first === null || first === '') {
    return { kind: 'neutral', personaName: name, eirFirstName: null, eirFullName: null };
  }
  return { kind: 'veir', personaName: name, eirFirstName: first, eirFullName: full };
}
