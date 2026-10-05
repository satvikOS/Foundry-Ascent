import type { PersonaView, Style } from '@foundry/contracts';

export const PERSONA_KIND_LABELS: Record<PersonaView['kind'], string> = {
  neutral_guide: 'Neutral guide',
  eir_persona: 'EIR persona',
};

export const STYLE_OPTIONS = {
  directness: [
    { value: 'gentle', label: 'Gentle', description: 'Leads with questions; softens hard truths.' },
    { value: 'balanced', label: 'Balanced', description: 'States concerns plainly, with context.' },
    { value: 'direct', label: 'Direct', description: 'Names the problem first, then explains.' },
  ],
  warmth: [
    { value: 'reserved', label: 'Reserved', description: 'Professional and matter-of-fact.' },
    { value: 'warm', label: 'Warm', description: 'Encouraging; acknowledges effort and progress.' },
  ],
  pace: [
    { value: 'measured', label: 'Measured', description: 'Slower, more explanation per step.' },
    { value: 'brisk', label: 'Brisk', description: 'Short answers, quick next steps.' },
  ],
} as const satisfies {
  [K in 'directness' | 'warmth' | 'pace']: readonly { value: Style[K]; label: string; description: string }[];
};

export function styleLabel<K extends keyof typeof STYLE_OPTIONS>(key: K, value: Style[K]): string {
  const options: readonly { value: string; label: string }[] = STYLE_OPTIONS[key];
  return options.find((option) => option.value === value)?.label ?? value;
}

/** Consent state for the persona list/detail. Neutral guides don't represent a person. */
export function consentState(
  persona: Pick<PersonaView, 'kind' | 'hasConsent'>,
): 'not_required' | 'on_file' | 'missing' {
  if (persona.kind === 'neutral_guide') return 'not_required';
  return persona.hasConsent ? 'on_file' : 'missing';
}
