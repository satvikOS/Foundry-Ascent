import type { PersonaSummary, SessionView, VeirIdentity, VentureDetail } from '@foundry/contracts';

/**
 * How the vEIR assigned to a venture is shown: its name, its face (a consented portrait, else the small sphere) and
 * what it is. A vEIR is an AI mentor built with an EIR's consent from their approved doctrine and style.
 *
 * Naming rule (owner, 2026-11-05; every surface takes the name from here): the mentor is shown by its persona's
 * display name alone ("Thomas"), never "Thomas’s vEIR", "Thomas · vEIR" or a "vEIR" badge beside it. The name
 * comes from the persona's data; a name stored with a "vEIR" label ("Corin’s vEIR", "Corin · vEIR") is shown
 * without it. A neutral guide keeps its own name ("Foundry Guide"). Where the human EIR is meant (human help,
 * reviews, the studio), the person is their full name ("Corin Halvorsen"). That it is an AI is said in the About
 * dialog (the right panel), the first-visit welcome, before a first call, and on the AI avatar's own label; the
 * transcript never carries it.
 */
export interface VeirDisplay {
  personaId: string;
  /** The mentor's display name ("Thomas"), in text and rendered alike. */
  name: string;
  /** The same display name (kept for callers that render the short form). */
  shortName: string;
  kind: PersonaSummary['kind'];
  /** The first name of the EIR the persona was built with ("Corin"); null for a guide. */
  eirFirstName: string | null;
  /** The EIR consented to the persona speaking in the first person. */
  firstPerson: boolean;
  /** The vEIR's own EIR is the venture's assigned EIR, who sees its work. */
  eirSeesWork: boolean;
  /** The persona release's AI disclosure (exports and print). */
  disclosure: string;
  /** Served portrait, only when the EIR consented to their likeness; otherwise the sphere is shown. */
  portraitUrl: string | null;
}

/** What naming a mentor needs: its display name and what the About dialog explains. */
export type VeirName = Pick<
  VeirDisplay,
  'name' | 'shortName' | 'kind' | 'eirFirstName' | 'firstPerson' | 'eirSeesWork'
>;

/** Who to call the mentor when no persona is known yet. */
export const NEUTRAL_MENTOR_NAME = 'your mentor';

const POSSESSIVE_VEIR = /^(.+?)[’']s\s+vEIR$/i;
const TILE_VEIR = /^(.+?)\s+·\s+vEIR$/i;
const ENDS_WITH_VEIR = /\bvEIR$/i;
const TRAILING_VEIR = /\s*[·\-–—,:]?\s*\bvEIR$/i;

/** The first word of a name ("Corin Halvorsen" → "Corin"). */
function firstWord(name: string | null | undefined): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? '';
}

/**
 * The mentor's display name from its persona's name: the name itself, without a "vEIR" label ("Thomas" → "Thomas",
 * "Corin’s vEIR" → "Corin", "Corin · vEIR" → "Corin"). A name that is nothing but the label stays as it is.
 */
export function veirName(personaName: string): string {
  const name = personaName.trim().replace(/\s+/g, ' ');
  const bare =
    POSSESSIVE_VEIR.exec(name)?.[1] ?? TILE_VEIR.exec(name)?.[1] ?? name.replace(TRAILING_VEIR, '');
  return bare.trim() === '' ? name : bare.trim();
}

function named(
  personaName: string,
  kind: PersonaSummary['kind'],
  eirFirstName: string | null,
  firstPerson: boolean,
): Pick<VeirDisplay, 'name' | 'shortName' | 'eirFirstName' | 'firstPerson'> {
  const name = kind === 'eir_persona' ? veirName(personaName) : personaName.trim().replace(/\s+/g, ' ');
  const eir = kind === 'eir_persona' ? firstWord(eirFirstName) || null : null;
  return { name, shortName: name, eirFirstName: eir, firstPerson: kind === 'eir_persona' && firstPerson };
}

/** The mentor for a venture, or null when no persona is assigned. Named after the persona alone. */
export function veirDisplay(venture: Pick<VentureDetail, 'persona'> | null | undefined): VeirDisplay | null {
  const persona = venture?.persona;
  if (!persona) return null;
  return {
    personaId: persona.personaId,
    ...named(persona.name, persona.kind, persona.eirFirstName ?? null, persona.firstPerson ?? false),
    kind: persona.kind,
    eirSeesWork: persona.kind === 'eir_persona' && persona.eirSeesWork === true,
    disclosure: persona.disclosure,
    portraitUrl: null,
  };
}

/** The mentor as the call settings describe it (`VeirIdentity`), named by the same rule. */
export function veirFromIdentity(identity: VeirIdentity): VeirDisplay {
  return {
    personaId: identity.personaId,
    ...named(identity.name, identity.kind, identity.eirDisplayName ?? null, identity.firstPerson === true),
    kind: identity.kind,
    eirSeesWork: identity.kind === 'eir_persona' && identity.eirSeesWork === true,
    disclosure: identity.disclosure,
    portraitUrl: identity.embodiment.likenessConsented ? identity.embodiment.portraitUrl : null,
  };
}

/**
 * Who a conversation is with: the venture's mentor when the conversation is with it, otherwise the conversation's
 * own persona (an older conversation can be with a persona the venture no longer has), named by the same rule.
 * Without the kind (an older API), a name ending in "vEIR" is an EIR persona's.
 */
export function conversationVeir(
  session: Pick<SessionView, 'personaId' | 'personaName' | 'personaKind'>,
  current: VeirDisplay | null,
): VeirName {
  if (current?.personaId === session.personaId) return current;
  const kind =
    session.personaKind ??
    (ENDS_WITH_VEIR.test(session.personaName.trim()) ? 'eir_persona' : 'neutral_guide');
  return { ...named(session.personaName, kind, null, false), kind, eirSeesWork: false };
}

type AboutInput = Pick<VeirDisplay, 'kind' | 'name' | 'eirFirstName' | 'eirSeesWork'>;

/** The EIR as the About text names them: their first name, or "an EIR" when it would read as the mentor's own. */
function eirLabel(veir: AboutInput): string | null {
  const first = veir.eirFirstName;
  if (veir.kind !== 'eir_persona' || first === null) return null;
  return first.toLocaleLowerCase() === veir.name.toLocaleLowerCase() ? null : first;
}

/** What the mentor is, in one sentence (the About dialog's first line, the welcome's first line). */
export function veirExplanation(veir: AboutInput): string {
  if (veir.kind !== 'eir_persona') {
    return `${veir.name} is the program’s AI mentor, built on its coaching doctrine.`;
  }
  const eir = eirLabel(veir);
  return eir
    ? `${veir.name} is an AI mentor, built with ${eir}’s consent from their approved doctrine and style, and released after their review.`
    : `${veir.name} is an AI mentor, built with an entrepreneur-in-residence’s consent from their approved doctrine and style, and released after their review.`;
}

/** One fact of the About dialog: a short heading and its sentence. */
export interface VeirFact {
  readonly id: 'what' | 'face' | 'memory' | 'people' | 'limits';
  readonly title: string;
  readonly text: string;
}

/**
 * The plain facts about the mentor (the About dialog, reachable from the right panel at any time): what it is, that
 * a call's face and voice are AI-generated, what is remembered and the Private option, that a person from the
 * program is there, and what it cannot do.
 */
export function veirFacts(veir: AboutInput): readonly VeirFact[] {
  const eir = eirLabel(veir);
  const sees = veir.eirSeesWork && eir ? ` ${eir} sees what you work on here.` : '';
  return [
    { id: 'what', title: 'An AI mentor', text: `${veirExplanation(veir)}${sees}` },
    {
      id: 'face',
      title: 'Face and voice',
      text: `On a call, ${veir.name}’s voice is AI-generated, and on video the face is an AI avatar.`,
    },
    {
      id: 'memory',
      title: 'What is remembered',
      text: 'What you discuss is remembered for next time; you can read and correct it in Knowledge. Choose Private for a one-off that isn’t kept.',
    },
    {
      id: 'people',
      title: 'People are there',
      text: 'A person from the program is available whenever you need one: ask for human help at any time.',
    },
    {
      id: 'limits',
      title: 'Limits',
      text: `${veir.name} can’t pass messages to anyone or schedule meetings, and doesn’t give legal, medical or financial advice.`,
    },
  ];
}

/**
 * The welcome a person sees the first time they meet their mentor (stored with them once read): two short
 * sentences on what it is. The voice facts of a call stay with the call.
 */
export function veirWelcome(veir: AboutInput): { title: string; lines: [string, string] } {
  const eir = eirLabel(veir);
  return {
    title: `Meet ${veir.name}`,
    lines: [
      veirExplanation(veir),
      veir.eirSeesWork && eir
        ? `${eir} sees what you work on here, and a person from the program is there when you need one.`
        : 'A person from the program is there whenever you need one.',
    ],
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
