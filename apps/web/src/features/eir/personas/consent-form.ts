import { ConsentAssetType, type ConsentView } from '@foundry/contracts';
import { z } from 'zod';

import { dateInputToIso, parseCommaList } from '@/features/admin/shared/form';
import { type RecordConsentInput } from '@/lib/api/hooks/veir-pools';

export const CONSENT_ASSETS: readonly { value: ConsentAssetType; label: string; description: string }[] = [
  {
    value: 'doctrine',
    label: 'Doctrine',
    description: 'The frameworks and judgement the vEIR is built from.',
  },
  { value: 'style', label: 'Style', description: 'How the EIR talks.' },
  { value: 'cases', label: 'Cases', description: 'Examples from the EIR’s own experience.' },
  { value: 'voice', label: 'Voice', description: 'A synthetic voice on calls.' },
  { value: 'likeness', label: 'Likeness', description: 'A portrait as the vEIR’s face.' },
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
  assetTypes: z.array(ConsentAssetType).min(1, 'Choose at least one thing the consent covers.'),
  approvedUses: list('uses'),
  audiences: list('audiences'),
  evidenceRef: z.string().trim().max(500, 'Use 500 characters or fewer.'),
  /** <input type="date"> value or ''. */
  expires: z
    .string()
    .refine((value) => value === '' || dateInputToIso(value) !== null, 'Enter a valid date.'),
});
export type ConsentFormValues = z.infer<typeof ConsentForm>;

/** Prefill from the consent in force (a new record replaces it), or start with doctrine and style. */
export function consentToForm(current: ConsentView | null): ConsentFormValues {
  return {
    assetTypes: current ? [...current.assetTypes] : ['doctrine', 'style'],
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

export type ConsentState = 'in_force' | 'revoked' | 'expired';

export function consentStatus(
  consent: Pick<ConsentView, 'revokedAt' | 'expiresAt'>,
  now = Date.now(),
): ConsentState {
  if (consent.revokedAt !== null) return 'revoked';
  if (consent.expiresAt !== null && Date.parse(consent.expiresAt) <= now) return 'expired';
  return 'in_force';
}
