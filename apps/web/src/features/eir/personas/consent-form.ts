import { ConsentAssetType, type ConsentView } from '@foundry/contracts';
import { z } from 'zod';

import { dateInputToIso, parseCommaList } from '@/features/admin/shared/form';
import { type RecordConsentInput } from '@/lib/api/hooks/veir-pools';

export const CONSENT_ASSETS: readonly {
  value: ConsentAssetType;
  label: string;
  description: string;
  /** Every record covers it: the vEIR can't coach without it. */
  required?: true;
}[] = [
  {
    value: 'doctrine',
    label: 'Doctrine',
    description: 'Required. The frameworks and judgement the vEIR is built from.',
    required: true,
  },
  { value: 'style', label: 'Style', description: 'How the EIR talks.' },
  { value: 'cases', label: 'Cases', description: 'Examples from the EIR’s own experience.' },
  { value: 'voice', label: 'Voice', description: 'Their voice on calls, including a cloned voice.' },
  { value: 'likeness', label: 'Likeness', description: 'Their face: a portrait, and a video face on calls.' },
  {
    value: 'first_person',
    label: 'First-person twin',
    description: 'Founders meet it under the EIR’s first name with a vEIR badge, as their digital twin.',
  },
];

export function assetLabel(asset: ConsentAssetType): string {
  return CONSENT_ASSETS.find((a) => a.value === asset)?.label ?? asset;
}

const list = (label: string) =>
  z
    .string()
    .refine((value) => parseCommaList(value).length <= 10, `List at most 10 ${label}.`)
    .refine(
      (value) => parseCommaList(value).every((item) => item.length <= 80),
      'Keep each item under 80 characters.',
    );

/** Record-consent form (mirrors CreateConsentRequest; the API validates again). */
export const ConsentForm = z.object({
  assetTypes: z
    .array(ConsentAssetType)
    .refine((assets) => assets.includes('doctrine'), 'A vEIR can’t coach without consent to its doctrine.'),
  approvedUses: list('uses'),
  audiences: list('audiences'),
  evidenceRef: z.string().trim().max(500, 'Use 500 characters or fewer.'),
  /** <input type="date"> value or ''. */
  expires: z
    .string()
    .refine((value) => value === '' || dateInputToIso(value) !== null, 'Enter a valid date.'),
});
export type ConsentFormValues = z.infer<typeof ConsentForm>;

/** Prefill from the consent in use (the vEIR relies on the new record instead), or doctrine and style. */
export function consentToForm(current: ConsentView | null): ConsentFormValues {
  return {
    assetTypes: current
      ? ['doctrine', ...current.assetTypes.filter((a) => a !== 'doctrine')]
      : ['doctrine', 'style'],
    approvedUses: current ? current.approvedUses.join(', ') : '',
    audiences: current ? current.audiences.join(', ') : '',
    evidenceRef: current?.evidenceRef ?? '',
    expires: '',
  };
}

export function formToConsent(values: ConsentFormValues): RecordConsentInput {
  const evidence = values.evidenceRef.trim();
  return {
    // Keep the canonical order regardless of click order.
    assetTypes: ConsentAssetType.options.filter((asset) => values.assetTypes.includes(asset)),
    approvedUses: parseCommaList(values.approvedUses),
    audiences: parseCommaList(values.audiences),
    evidenceRef: evidence === '' ? null : evidence,
    expiresAt: values.expires === '' ? null : dateInputToIso(values.expires),
  };
}

/**
 * What the persona can run on: the consent it relies on (the one listing it as a dependent), and whether
 * that record is in force and covers doctrine, as approval and resume require.
 */
export function reliedOnConsent(
  personaId: string,
  consents: readonly ConsentView[],
  now = Date.now(),
): { consent: ConsentView | null; state: 'in_force' | 'no_doctrine' | 'lapsed' | 'none' } {
  const consent = consents.find((c) => c.personas?.some((p) => p.id === personaId)) ?? null;
  if (consent === null) return { consent, state: 'none' };
  if (consentStatus(consent, now) !== 'in_force') return { consent, state: 'lapsed' };
  return { consent, state: consent.assetTypes.includes('doctrine') ? 'in_force' : 'no_doctrine' };
}

type ConsentState = 'in_force' | 'revoked' | 'expired';

export function consentStatus(
  consent: Pick<ConsentView, 'revokedAt' | 'expiresAt'>,
  now = Date.now(),
): ConsentState {
  if (consent.revokedAt !== null) return 'revoked';
  if (consent.expiresAt !== null && Date.parse(consent.expiresAt) <= now) return 'expired';
  return 'in_force';
}
