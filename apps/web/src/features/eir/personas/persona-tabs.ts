import type { PersonaView } from '@foundry/contracts';

/** Sections of a persona's page in the EIR studio, in display order (kept in the `tab` search param). */
export const PERSONA_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'doctrine', label: 'Doctrine & style' },
  { id: 'library', label: 'Knowledge library' },
  { id: 'lessons', label: 'Lessons' },
  { id: 'releases', label: 'Releases' },
  { id: 'consent', label: 'Consent' },
  { id: 'embodiment', label: 'Voice & face' },
] as const;

export type PersonaTab = (typeof PERSONA_TABS)[number]['id'];

export function isPersonaTab(value: unknown): value is PersonaTab {
  return typeof value === 'string' && PERSONA_TABS.some((tab) => tab.id === value);
}

/** Tabs that apply to a persona: a neutral guide represents no one, so it has no consent section. */
export function personaTabs(persona: Pick<PersonaView, 'kind'>): (typeof PERSONA_TABS)[number][] {
  return PERSONA_TABS.filter((tab) => tab.id !== 'consent' || persona.kind === 'eir_persona');
}
