import { z } from 'zod';

import raw from '../../media-vendors.json' with { type: 'json' };

/**
 * `packages/core/media-vendors.json`, shared with apps/api (endpoints, secret names) and infra/cdk (the secrets the
 * API role may read, the CSP hosts), so the prices core meters at, the secrets the adapters read and the grants
 * infra gives cannot drift apart.
 */
const Origin = z.url().refine((u) => u.startsWith('https://') && !u.endsWith('/'), 'an https origin');
const SecretName = z.string().regex(/^foundry-ascent\/media\/[a-z0-9-]+$/);

const MediaVendors = z.object({
  face: z.object({
    heygen: z.object({
      product: z.string(),
      usdPerMinute: z.number().positive(),
      secretName: SecretName,
      apiOrigin: Origin,
      /** FULL mode (the vendor's stock voice speaks admitted text): the same key and API, twice the credits. */
      full: z.object({ product: z.string(), usdPerMinute: z.number().positive() }),
    }),
  }),
  voice: z.object({
    elevenlabs: z.object({
      product: z.string(),
      usdPer1kCharacters: z.number().positive(),
      defaultModel: z.string().regex(/^[a-z0-9_]+$/),
      secretName: SecretName,
      apiOrigin: Origin,
    }),
  }),
});
export type MediaVendors = z.infer<typeof MediaVendors>;

export const MEDIA_VENDORS: MediaVendors = MediaVendors.parse(raw);

/** The price-file rate of a face of `vendor` in `mode` (the stand-in costs nothing). */
export function faceListPrice(vendor: 'heygen' | 'fake', mode: 'lite' | 'full'): number {
  if (vendor !== 'heygen') return 0;
  return mode === 'full'
    ? MEDIA_VENDORS.face.heygen.full.usdPerMinute
    : MEDIA_VENDORS.face.heygen.usdPerMinute;
}

/** Cost of `seconds` of a face session at `usdPerMinute` (the vendor bills elapsed time, silence included). */
export function faceCostUsd(seconds: number, usdPerMinute: number): number {
  return (Math.max(0, seconds) / 60) * usdPerMinute;
}

/** Cost of `characters` of cloned-voice synthesis at `usdPer1kCharacters`. */
export function voiceCostUsd(characters: number, usdPer1kCharacters: number): number {
  return (Math.max(0, characters) / 1000) * usdPer1kCharacters;
}
