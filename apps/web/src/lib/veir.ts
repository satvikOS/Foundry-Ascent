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

/**
 * The short name of a persona: "Corin's vEIR" → "Corin". An EIR persona named otherwise takes the first
 * name of the EIR it was built from (`profileDisplayName`: the persona's own consented EIR profile, as in
 * `PersonaView.eirProfile`), and the persona's name when that is unknown. Never pass the venture
 * assignment's reviewing EIR: that person did not necessarily consent to this vEIR.
 */
export function shortPersonaName(
  personaName: string,
  kind: PersonaSummary['kind'],
  profileDisplayName?: string | null,
): string {
  const name = personaName.trim();
  const possessive = POSSESSIVE_VEIR.exec(name);
  if (possessive?.[1]) return possessive[1].trim();
  if (kind === 'eir_persona' && profileDisplayName) {
    const first = profileDisplayName.trim().split(/\s+/)[0];
    if (first) return first;
  }
  return name;
}

/** The vEIR for a venture, or null when no persona is assigned. Named after the persona alone. */
export function veirDisplay(venture: Pick<VentureDetail, 'persona'> | null | undefined): VeirDisplay | null {
  const persona = venture?.persona;
  if (!persona) return null;
  return {
    personaId: persona.personaId,
    name: persona.name,
    shortName: shortPersonaName(persona.name, persona.kind),
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
