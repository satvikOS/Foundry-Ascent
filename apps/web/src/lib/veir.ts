import type { PersonaSummary, SessionView, VentureDetail } from '@foundry/contracts';

/**
 * How the vEIR assigned to a venture is shown: its face (portrait or monogram), its name and its disclosure.
 * A vEIR is an AI built from an EIR's approved doctrine and style; nothing here may suggest it is the human
 * EIR.
 *
 * Naming rule (honesty invariant): wherever the AI acts or is addressed, it is "<EIR first name>’s vEIR"
 * ("Corin’s vEIR"): in buttons ("Call Corin’s vEIR"), headers, the call stage, memory and notebook credits,
 * aria-labels and announcements. A bare EIR name ("Corin", "Corin Halvorsen") only ever means the person. A
 * neutral guide with no EIR keeps its own name ("Foundry Guide"). Every surface takes the name from here.
 */
export interface VeirDisplay {
  personaId: string;
  /** What the AI is called everywhere: "Corin’s vEIR", or a neutral guide's own name. */
  name: string;
  kind: PersonaSummary['kind'];
  /** The persona release's AI disclosure. */
  disclosure: string;
  /** Served portrait, only when the EIR consented to their likeness; otherwise the monogram is shown. */
  portraitUrl: string | null;
}

const POSSESSIVE_VEIR = /^(.+?)[’']s\s+vEIR$/i;
const ENDS_WITH_VEIR = /\bvEIR$/i;

/**
 * The name of a vEIR (see {@link VeirDisplay}): a persona already called "…’s vEIR" (or "… vEIR") keeps its
 * name; any other EIR persona becomes "<first name>’s vEIR", the first name taken from the persona's own
 * consented EIR profile when known (`PersonaView.eirProfile`), else from its own name. Never pass the venture
 * assignment's reviewing EIR: that person did not necessarily consent to this vEIR. A neutral guide keeps its
 * own name.
 */
export function veirName(
  personaName: string,
  kind: PersonaSummary['kind'],
  profileDisplayName?: string | null,
): string {
  const name = personaName.trim().replace(/\s+/g, ' ');
  if (kind !== 'eir_persona' || ENDS_WITH_VEIR.test(name)) return name;
  const first = (profileDisplayName ?? name).trim().split(/\s+/)[0] ?? '';
  return `${first === '' ? name : first}’s vEIR`;
}

/** The vEIR for a venture, or null when no persona is assigned. Named after the persona alone. */
export function veirDisplay(venture: Pick<VentureDetail, 'persona'> | null | undefined): VeirDisplay | null {
  const persona = venture?.persona;
  if (!persona) return null;
  return {
    personaId: persona.personaId,
    name: veirName(persona.name, persona.kind),
    kind: persona.kind,
    disclosure: persona.disclosure,
    portraitUrl: null,
  };
}

/**
 * Who a conversation is with: the venture's vEIR when the conversation is with it, otherwise the conversation's
 * own persona (an older conversation can be with a persona the venture no longer has), named by that persona's
 * own kind: a guide keeps its name ("Foundry Guide", never "Foundry’s vEIR"). Without the kind (an older API),
 * a name ending in "vEIR" is an EIR persona's, which the API requires them to carry.
 */
export function conversationVeir(
  session: Pick<SessionView, 'personaId' | 'personaName' | 'personaKind'>,
  current: Pick<VeirDisplay, 'personaId' | 'name' | 'kind'> | null,
): { name: string; kind: PersonaSummary['kind'] } {
  if (current?.personaId === session.personaId) return { name: current.name, kind: current.kind };
  const kind =
    session.personaKind ??
    (ENDS_WITH_VEIR.test(session.personaName.trim()) ? 'eir_persona' : 'neutral_guide');
  return { name: veirName(session.personaName, kind), kind };
}

/** The letters on a vEIR's face: its EIR's initial for "Corin’s vEIR" ("C"), a guide's initials ("FG"). */
export function faceMonogram(name: string): string {
  const possessive = POSSESSIVE_VEIR.exec(name.trim());
  return possessive?.[1] ? monogram(possessive[1], 1) : monogram(name);
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
