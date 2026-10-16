import type { PersonaView } from '@foundry/contracts';

/** Sections of a persona's page in the EIR studio, in display order (kept in the `tab` search param). */
const PERSONA_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'doctrine', label: 'Doctrine & style' },
  { id: 'library', label: 'Knowledge library' },
  { id: 'lessons', label: 'Lessons' },
  { id: 'releases', label: 'Releases' },
  { id: 'testbench', label: 'Test bench' },
  { id: 'consent', label: 'Consent' },
  { id: 'embodiment', label: 'Voice & face' },
] as const;

export type PersonaTab = (typeof PERSONA_TABS)[number]['id'];

export function isPersonaTab(value: unknown): value is PersonaTab {
  return typeof value === 'string' && PERSONA_TABS.some((tab) => tab.id === value);
}

/**
 * Tabs that apply to a persona and its viewer: a neutral guide represents no one, so it has no consent section;
 * the Test bench is for the persona's curators only (the API refuses everyone else).
 */
export function personaTabs(
  persona: Pick<PersonaView, 'kind' | 'canCurate'>,
): (typeof PERSONA_TABS)[number][] {
  return PERSONA_TABS.filter(
    (tab) =>
      (tab.id !== 'consent' || persona.kind === 'eir_persona') &&
      (tab.id !== 'testbench' || persona.canCurate === true),
  );
}
