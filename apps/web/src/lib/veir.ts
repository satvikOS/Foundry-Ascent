import type {
  PersonaPresentation,
  PersonaSummary,
  SessionView,
  VeirIdentity,
  VentureDetail,
} from '@foundry/contracts';

/**
 * How the mentor assigned to a venture is shown: its name, its face (a consented portrait, else the small sphere) and
 * what it is.
 *
 * Naming rule (every surface takes the name from here):
 * - A **mentor** (`presentation: 'mentor'`, ADR-0021: "Thomas") is shown by its persona's display name alone, never
 *   "Thomas’s vEIR", "Thomas · vEIR" or a "vEIR" badge beside it. What it is is said in the About dialog (the right
 *   panel), the first-visit welcome, before a first call and on the AI avatar's own label; never in the transcript.
 * - A **twin** (`presentation: 'twin'`, ADR-0020: an EIR's digital twin) carries its AI marker in its name, so the AI
 *   is never called by the person's bare first name: "Corin · vEIR" with the EIR's first-person consent, otherwise
 *   "Corin’s vEIR". A missing presentation (an older API) is a twin: the safe side.
 * - A neutral guide keeps its own name ("Foundry Guide").
 * - Where the human EIR is meant (human help, reviews, the studio), the person is their full name ("Corin
 *   Halvorsen").
 */
export interface VeirDisplay {
  personaId: string;
  /** The mentor's name in text and rendered alike: "Thomas", "Corin · vEIR", "Corin’s vEIR", "Foundry Guide". */
  name: string;
  /** The same name (kept for callers that render the short form). */
  shortName: string;
  kind: PersonaSummary['kind'];
  /** How an EIR persona presents itself; a guide is `twin` (it has no EIR to be mistaken for). */
  presentation: PersonaPresentation;
  /** The first name of the EIR the persona was built with ("Corin"); null for a guide. */
  eirFirstName: string | null;
  /** The EIR consented to the persona speaking in the first person. */
  firstPerson: boolean;
  /** The persona's EIR is the venture's assigned EIR, who sees its work. */
  eirSeesWork: boolean;
  /** The persona release's AI disclosure (exports and print). */
  disclosure: string;
  /** Served portrait, only when the EIR consented to their likeness; otherwise the sphere is shown. */
  portraitUrl: string | null;
}

/** What naming a mentor needs: its display name and what the About dialog explains. */
export type VeirName = Pick<
  VeirDisplay,
  'name' | 'shortName' | 'kind' | 'presentation' | 'eirFirstName' | 'firstPerson' | 'eirSeesWork'
>;

/** Who to call the mentor when no persona is known yet. */
export const NEUTRAL_MENTOR_NAME = 'your mentor';

const POSSESSIVE_VEIR = /^(.+?)[’']s\s+vEIR$/i;
const TILE_VEIR = /^(.+?)\s+·\s+vEIR$/i;
const ENDS_WITH_VEIR = /\bvEIR$/i;

/** The first word of a name ("Corin Halvorsen" → "Corin"). */
function firstWord(name: string | null | undefined): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? '';
}

/** A name with its spaces tidied, as stored names are shown (the studio shows a persona's name this way). */
export function personaName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/**
 * A persona's name as founders see it (see {@link VeirDisplay}): a mentor's and a guide's own name; a twin's
 * "<first name> · vEIR" with the first-person consent, else its stored "…’s vEIR" (or "… vEIR"), else
 * "<first name>’s vEIR". The first name is the persona's own consented EIR's when known, else from its own name;
 * never the venture assignment's reviewing EIR (that person did not necessarily consent to this persona).
 */
export function veirName(
  name: string,
  kind: PersonaSummary['kind'],
  presentation: PersonaPresentation | null | undefined,
  eirFirstName?: string | null,
  firstPerson = false,
): string {
  const own = personaName(name);
  if (kind !== 'eir_persona' || presentation === 'mentor') return own;
  const first =
    [
      firstWord(eirFirstName),
      POSSESSIVE_VEIR.exec(own)?.[1]?.trim() ?? '',
      TILE_VEIR.exec(own)?.[1]?.trim() ?? '',
    ].find((candidate) => candidate !== '') ?? '';
  if (firstPerson && first !== '') return `${first} · vEIR`;
  if (ENDS_WITH_VEIR.test(own)) return own;
  const fallback = first || firstWord(own);
  return `${fallback === '' ? own : fallback}’s vEIR`;
}

function named(
  name: string,
  kind: PersonaSummary['kind'],
  presentation: PersonaPresentation | null | undefined,
  eirFirstName: string | null,
  firstPerson: boolean,
): Pick<VeirDisplay, 'name' | 'shortName' | 'presentation' | 'eirFirstName' | 'firstPerson'> {
  const veir = kind === 'eir_persona';
  const mentor = veir && presentation === 'mentor';
  const shown = veirName(name, kind, presentation, eirFirstName, firstPerson);
  return {
    name: shown,
    shortName: shown,
    presentation: mentor ? 'mentor' : 'twin',
    eirFirstName: veir ? firstWord(eirFirstName) || null : null,
    firstPerson: veir && firstPerson,
  };
}

/** The mentor for a venture, or null when no persona is assigned. */
export function veirDisplay(venture: Pick<VentureDetail, 'persona'> | null | undefined): VeirDisplay | null {
  const persona = venture?.persona;
  if (!persona) return null;
  return {
    personaId: persona.personaId,
    ...named(
      persona.name,
      persona.kind,
      persona.presentation,
      persona.eirFirstName ?? null,
      persona.firstPerson ?? false,
    ),
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
    ...named(
      identity.name,
      identity.kind,
      identity.presentation,
      identity.eirDisplayName ?? null,
      identity.firstPerson === true,
    ),
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
  session: Pick<SessionView, 'personaId' | 'personaName' | 'personaKind' | 'personaPresentation'>,
  current: VeirDisplay | null,
): VeirName {
  if (current?.personaId === session.personaId) return current;
  const kind =
    session.personaKind ??
    (ENDS_WITH_VEIR.test(session.personaName.trim()) ? 'eir_persona' : 'neutral_guide');
  return {
    ...named(session.personaName, kind, session.personaPresentation, null, false),
    kind,
    eirSeesWork: false,
  };
}

type AboutInput = Pick<VeirDisplay, 'kind' | 'presentation' | 'name' | 'eirFirstName' | 'eirSeesWork'>;

/** The EIR as the About text names them: their first name, or null when it would read as the mentor's own. */
function eirLabel(veir: AboutInput): string | null {
  const first = veir.eirFirstName;
  if (veir.kind !== 'eir_persona' || first === null) return null;
  return veir.name.toLocaleLowerCase() === first.toLocaleLowerCase() ? null : first;
}

/**
 * Who, a person, sees the work: the persona's own EIR when they are this venture's assigned EIR (null otherwise).
 * A twin is named after its EIR ("Corin · vEIR"), so "Corin" alone reads as the person; beside a mentor's own name
 * the person is introduced by their role.
 */
function workSeenBy(veir: AboutInput): string | null {
  if (!veir.eirSeesWork || veir.kind !== 'eir_persona' || veir.eirFirstName === null) return null;
  return veir.presentation === 'mentor'
    ? `${veir.eirFirstName}, your entrepreneur-in-residence,`
    : veir.eirFirstName;
}

/**
 * What the mentor is, in one or two sentences (the About dialog's first fact, the welcome's first line), true to who
 * wrote its approach: a mentor's is the program's, written and approved before release, with no EIR said to have
 * written or reviewed it (ADR-0021); a twin is built with its EIR's consent from their approved doctrine and style,
 * released after their review (ADR-0020). Neither claims a person approves each reply.
 */
export function veirExplanation(veir: AboutInput): string {
  if (veir.kind !== 'eir_persona') {
    return `${veir.name} is the program’s AI mentor, built on its coaching doctrine.`;
  }
  if (veir.presentation === 'mentor') {
    return `${veir.name} is an AI mentor, not a person. The program wrote and approved the coaching approach ${veir.name} follows; no person writes or approves individual replies.`;
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
  const seer = workSeenBy(veir);
  const sees = seer ? ` ${seer} sees what you work on here.` : '';
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
  const seer = workSeenBy(veir);
  return {
    title: `Meet ${veir.name}`,
    lines: [
      veirExplanation(veir),
      seer
        ? `${seer} sees what you work on here, and a person from the program is there when you need one.`
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
