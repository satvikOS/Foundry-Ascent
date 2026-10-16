/**
 * The tenant's EIR names as words, for rules that keep a vEIR's own lines (the conversation opener, the call
 * intro, a persona's name) from speaking for, or about, the human EIR it was built from.
 */
import { personasRepo, type SqlExecutor } from '@foundry/db';

export function normalizedName(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Words of the tenant's EIR names (three letters or more), lower-cased: first names, surnames, parts. */
export function eirNameWords(eirNames: readonly string[]): Set<string> {
  const words = new Set<string>();
  for (const name of eirNames) {
    for (const word of normalizedName(name).split(/[^\p{L}]+/u)) if (word.length >= 3) words.add(word);
  }
  return words;
}

/**
 * Whether `text` names one of the tenant's EIRs at all (a first name, a surname or a full name). A vEIR line
 * that names its EIR is how third-person endorsement, review and presence claims ("Corin asked me to check in")
 * get past the identity rewrite, so the opener and the call intro leave such lines out.
 */
export function mentionsEir(text: string, eirNames: readonly string[]): boolean {
  const words = eirNameWords(eirNames);
  return normalizedName(text)
    .split(/[^\p{L}]+/u)
    .some((word) => words.has(word));
}

/**
 * Whether a persona name presents the vEIR as an EIR ("Corin Halvorsen", "Coach Corin") rather than as their
 * vEIR ("Corin's vEIR", "Corin Halvorsen's vEIR"): it names an EIR other than in the possessive.
 */
export function personaNameClaimsEir(personaName: string, eirNames: readonly string[]): boolean {
  const words = eirNameWords(eirNames);
  const possessives = [...eirNames.map(normalizedName), ...words].sort((a, b) => b.length - a.length);
  let rest = normalizedName(personaName);
  for (const name of possessives) rest = rest.split(`${name}'s`).join(' ').split(`${name}’s`).join(' ');
  return rest.split(/[^\p{L}]+/u).some((word) => words.has(word));
}

/**
 * The display name of the EIR a vEIR is built from: the persona's own EIR profile, the one its consent covers
 * (null for a neutral guide). Every place the server names a vEIR or its EIR takes the name from here, never
 * from the venture assignment's reviewing EIR: that person did not necessarily consent to this vEIR.
 */
export async function veirEirName(
  ex: SqlExecutor,
  persona: Pick<personasRepo.PersonaRecord, 'id' | 'kind'>,
): Promise<string | null> {
  return persona.kind === 'eir_persona' ? personasRepo.getPersonaEirName(ex, persona.id) : null;
}
