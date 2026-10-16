import type { PersonaSummary, VentureDetail } from '@foundry/contracts';

/**
 * How the vEIR assigned to a venture is shown: its face (portrait or monogram), its short name in
 * buttons and greetings ("Call Corin"), and its disclosure. A vEIR is an AI built from an EIR's
 * approved doctrine and style; nothing here may suggest it is the human EIR.
 */
export interface VeirDisplay {
  personaId: string;
  /** Persona name as released ("Corin's vEIR", "Foundry Guide"). */
  name: string;
  /** Short name for greetings and actions ("Corin", "Foundry Guide"). */
  shortName: string;
  kind: PersonaSummary['kind'];
  /** The persona release's AI disclosure. */
  disclosure: string;
  /** Served portrait, only when the EIR consented to their likeness; otherwise the monogram is shown. */
  portraitUrl: string | null;
}

const POSSESSIVE_VEIR = /^(.+?)[’']s\s+vEIR$/i;

/** "Corin's vEIR" → "Corin"; an EIR persona without that form → the EIR's first name; else the name. */
export function shortPersonaName(
  personaName: string,
  kind: PersonaSummary['kind'],
  eirDisplayName?: string | null,
): string {
  const name = personaName.trim();
  const possessive = POSSESSIVE_VEIR.exec(name);
  if (possessive?.[1]) return possessive[1].trim();
  if (kind === 'eir_persona' && eirDisplayName) {
    const first = eirDisplayName.trim().split(/\s+/)[0];
    if (first) return first;
  }
  return name;
}

/** The vEIR for a venture, or null when no persona is assigned. */
export function veirDisplay(
  venture: Pick<VentureDetail, 'persona' | 'assignedEir'> | null | undefined,
): VeirDisplay | null {
  const persona = venture?.persona;
  if (!persona) return null;
  return {
    personaId: persona.personaId,
    name: persona.name,
    shortName: shortPersonaName(persona.name, persona.kind, venture.assignedEir?.displayName ?? null),
    kind: persona.kind,
    disclosure: persona.disclosure,
    portraitUrl: null,
  };
}

/**
 * Monogram letters for a face: one letter for a single word ("Corin" → "C"), the first letters of the
 * first two words otherwise ("Foundry Guide" → "FG", "Maya Okafor-Lindqvist" → "MO").
 */
export function monogram(name: string, max: 1 | 2 = 2): string {
  const words = name
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+/u, ''))
    .filter(Boolean);
  if (words.length === 0) return '?';
  const letters = words.slice(0, max).map((word) => Array.from(word)[0] ?? '');
  return letters.join('').toLocaleUpperCase();
}
