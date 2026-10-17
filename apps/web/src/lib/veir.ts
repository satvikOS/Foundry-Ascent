import type { PersonaSummary, SessionView, VeirIdentity, VentureDetail } from '@foundry/contracts';

/**
 * How the vEIR assigned to a venture is shown: its face (portrait or monogram), its name with its badge, and what a
 * vEIR is. A vEIR is an EIR's digital twin, an AI built with the EIR's consent from how they coach.
 *
 * Naming rule (the presence policy; every surface takes the name from here):
 * - With the EIR's first-person consent (`firstPerson`), the twin appears like a call tile: the EIR's first name
 *   with a "vEIR" badge ("Corin · vEIR"). In text (buttons, placeholders, aria-labels, announcements) it is
 *   "Corin · vEIR"; rendered, the name "Corin" sits beside the badge, which opens a short explanation.
 * - Without it, the twin is "Corin’s vEIR" (its badge reads "AI").
 * - A neutral guide keeps its own name ("Foundry Guide", badge "AI").
 * - Where the human EIR is meant (human help, reviews, the studio), the person is their full name ("Corin
 *   Halvorsen"); a bare first name alone is never the AI's label outside the name-and-badge pair.
 */
export interface VeirDisplay {
  personaId: string;
  /** The twin in text: "Corin · vEIR", "Corin’s vEIR", or a guide's own name. */
  name: string;
  /** The name rendered beside the badge: "Corin", "Corin’s vEIR", or a guide's own name. */
  shortName: string;
  /** The badge that travels with the name and opens the explanation. */
  badge: VeirBadgeText;
  kind: PersonaSummary['kind'];
  /** The EIR's first name ("Corin") for a vEIR; null for a guide. */
  eirFirstName: string | null;
  /** Shown under the EIR's first name, speaking as their digital twin (the EIR consented). */
  firstPerson: boolean;
  /** The vEIR's own EIR is the venture's assigned EIR, who sees its work. */
  eirSeesWork: boolean;
  /** The persona release's AI disclosure (exports and print). */
  disclosure: string;
  /** Served portrait, only when the EIR consented to their likeness; otherwise the monogram is shown. */
  portraitUrl: string | null;
}

export type VeirBadgeText = 'vEIR' | 'AI';

const POSSESSIVE_VEIR = /^(.+?)[’']s\s+vEIR$/i;
const TILE_VEIR = /^(.+?)\s+·\s+vEIR$/;
const ENDS_WITH_VEIR = /\bvEIR$/i;

/** The first word of a name ("Corin Halvorsen" → "Corin"). */
function firstWord(name: string | null | undefined): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? '';
}

/** The EIR first name a persona's own name carries ("Corin’s vEIR" → "Corin"), or ''. */
function possessiveFirstName(personaName: string): string {
  return POSSESSIVE_VEIR.exec(personaName.trim())?.[1]?.trim() ?? '';
}

/**
 * The name of a vEIR in text (see {@link VeirDisplay}). With the first-person consent it is the tile name
 * "<first name> · vEIR"; otherwise a persona already called "…’s vEIR" (or "… vEIR") keeps its name and any
 * other EIR persona becomes "<first name>’s vEIR". The first name comes from the persona's own consented EIR
 * (`PersonaView.eirProfile`, `PersonaSummary.eirFirstName`) when known, else from its own name. Never pass the
 * venture assignment's reviewing EIR: that person did not necessarily consent to this vEIR. A neutral guide keeps
 * its own name.
 */
export function veirName(
  personaName: string,
  kind: PersonaSummary['kind'],
  profileDisplayName?: string | null,
  firstPerson = false,
): string {
  const name = personaName.trim().replace(/\s+/g, ' ');
  if (kind !== 'eir_persona') return name;
  const first = firstWord(profileDisplayName) || possessiveFirstName(name);
  if (firstPerson && first !== '') return `${first} · vEIR`;
  if (ENDS_WITH_VEIR.test(name)) return name;
  const fallback = first || firstWord(name);
  return `${fallback === '' ? name : fallback}’s vEIR`;
}

/** The name and badge for a vEIR shown as a pair (see {@link VeirDisplay}). */
function pairFor(
  personaName: string,
  kind: PersonaSummary['kind'],
  eirFirstName: string | null,
  firstPerson: boolean,
): Pick<VeirDisplay, 'name' | 'shortName' | 'badge' | 'eirFirstName' | 'firstPerson'> {
  const name = veirName(personaName, kind, eirFirstName, firstPerson);
  if (kind !== 'eir_persona') {
    return { name, shortName: name, badge: 'AI', eirFirstName: null, firstPerson: false };
  }
  // A first name is a non-empty word: '' (none given) falls through to the next source.
  const first =
    [firstWord(eirFirstName), possessiveFirstName(name), TILE_VEIR.exec(name)?.[1] ?? ''].find(
      (candidate) => candidate !== '',
    ) ?? null;
  const tile = firstPerson && first !== null;
  return {
    name,
    shortName: tile ? first : name,
    badge: tile ? 'vEIR' : 'AI',
    eirFirstName: first,
    firstPerson: tile,
  };
}

/** The vEIR for a venture, or null when no persona is assigned. Named after the persona and its own EIR. */
export function veirDisplay(venture: Pick<VentureDetail, 'persona'> | null | undefined): VeirDisplay | null {
  const persona = venture?.persona;
  if (!persona) return null;
  return {
    personaId: persona.personaId,
    ...pairFor(persona.name, persona.kind, persona.eirFirstName ?? null, persona.firstPerson ?? false),
    kind: persona.kind,
    eirSeesWork: persona.kind === 'eir_persona' && persona.eirSeesWork === true,
    disclosure: persona.disclosure,
    portraitUrl: null,
  };
}

/** The vEIR as the call settings describe it (`VeirIdentity`), named by the same rule. */
export function veirFromIdentity(identity: VeirIdentity): VeirDisplay {
  const eir = identity.kind === 'eir_persona' ? firstWord(identity.eirDisplayName) || null : null;
  return {
    personaId: identity.personaId,
    ...pairFor(identity.name, identity.kind, eir, identity.firstPerson === true),
    kind: identity.kind,
    eirSeesWork: identity.kind === 'eir_persona' && identity.eirSeesWork === true,
    disclosure: identity.disclosure,
    portraitUrl: identity.embodiment.likenessConsented ? identity.embodiment.portraitUrl : null,
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
  current: VeirDisplay | null,
): VeirName {
  if (current?.personaId === session.personaId) return current;
  const kind =
    session.personaKind ??
    (ENDS_WITH_VEIR.test(session.personaName.trim()) ? 'eir_persona' : 'neutral_guide');
  return { ...pairFor(session.personaName, kind, null, false), kind, eirSeesWork: false };
}

/** What naming a vEIR needs: its text name, the name and badge rendered as a pair, and what its badge explains. */
export type VeirName = Pick<
  VeirDisplay,
  'name' | 'shortName' | 'badge' | 'kind' | 'eirFirstName' | 'firstPerson' | 'eirSeesWork'
>;

/**
 * What a vEIR is, in one short paragraph (the badge's popover): the EIR's digital twin, an AI built with their
 * consent from how they coach; who sees the work; and that it is not the EIR in person, who does not write or
 * approve its replies. A guide is the program's AI coach.
 */
export function veirExplanation(
  veir: Pick<VeirDisplay, 'kind' | 'name' | 'eirFirstName' | 'eirSeesWork'>,
): string {
  const first = veir.eirFirstName;
  if (veir.kind !== 'eir_persona' || first === null) {
    return `${veir.name} is the program’s AI coach. It isn’t a person, and no one in the program writes or approves its replies.`;
  }
  const sees = veir.eirSeesWork ? ` ${first} sees what you work on here.` : '';
  return `${first}’s digital twin: an AI built with ${first}’s consent from how ${first} coaches.${sees} It isn’t ${first} in person, and ${first} doesn’t write or approve its replies.`;
}

/**
 * The welcome a person sees the first time they meet their vEIR (stored with them once read): two short sentences
 * on what it is. The voice facts of a call stay with the call.
 */
export function veirWelcome(veir: Pick<VeirDisplay, 'kind' | 'name' | 'eirFirstName' | 'eirSeesWork'>): {
  title: string;
  lines: [string, string];
} {
  const first = veir.eirFirstName;
  if (veir.kind !== 'eir_persona' || first === null) {
    return {
      title: `Meet ${veir.name}`,
      lines: ['The program’s AI coach, built on its coaching doctrine.', 'It isn’t a person.'],
    };
  }
  return {
    title: `Meet ${first}’s vEIR`,
    lines: [
      `${first}’s digital twin: an AI built with ${first}’s consent from how ${first} coaches.`,
      veir.eirSeesWork ? `${first} sees what you work on here.` : `It isn’t ${first} in person.`,
    ],
  };
}

/** The letters on a vEIR's face: its EIR's initial ("Corin · vEIR", "Corin’s vEIR" → "C"), a guide's initials. */
export function faceMonogram(name: string): string {
  const trimmed = name.trim();
  const eir = POSSESSIVE_VEIR.exec(trimmed)?.[1] ?? TILE_VEIR.exec(trimmed)?.[1];
  return eir ? monogram(eir, 1) : monogram(trimmed);
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
