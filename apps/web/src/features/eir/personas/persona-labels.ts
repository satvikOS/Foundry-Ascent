import type { PersonaView, Style } from '@foundry/contracts';

import { isApiError } from '@/lib/api/errors';

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

/** The one wording for "an EIR persona needs consent before a release can be approved". */
export const CONSENT_NEEDED = 'Record consent before approving a release.';

/** Consent state for the persona list/detail. Neutral guides don't represent a person. */
export function consentState(
  persona: Pick<PersonaView, 'kind' | 'hasConsent'>,
): 'not_required' | 'on_file' | 'missing' {
  if (persona.kind === 'neutral_guide') return 'not_required';
  return persona.hasConsent ? 'on_file' : 'missing';
}

/**
 * Why a suspended EIR persona can't be resumed yet: it has no consent in force that covers doctrine (the
 * API refuses the resume). Null when nothing about consent stands in the way.
 */
export function resumeConsentBlocker(
  persona: Pick<PersonaView, 'kind' | 'hasConsent' | 'suspendedReason' | 'name'>,
): string | null {
  if (consentState(persona) !== 'missing') return null;
  return persona.suspendedReason === 'consent revoked'
    ? `Consent was revoked, so ${persona.name} can’t coach. A new consent that covers doctrine has to be recorded before it can resume.`
    : `${persona.name} has no consent in force that covers doctrine. One has to be recorded before it can resume.`;
}

/**
 * The reason the API gave for refusing an EIR persona that has no valid consent (403 with an error at
 * `consent`, e.g. "Consent was revoked. …"), or null for any other failure.
 */
export function consentRefusal(error: unknown): string | null {
  if (!isApiError(error) || error.code !== 'forbidden') return null;
  return error.fieldErrors.find((field) => field.path === 'consent')?.message ?? null;
}
