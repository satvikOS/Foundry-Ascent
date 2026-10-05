import { createHash } from 'node:crypto';

/** Namespace for deterministic seed identifiers (UUIDv5). Never change: ids must be stable across deploys. */
export const SEED_NAMESPACE = '6f1c3a52-9d7e-4b0a-8f2e-3c5d7a9b1e04';

function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

function format(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** RFC 9562 UUIDv5 of `name` in `namespace`. */
export function uuidV5(name: string, namespace: string = SEED_NAMESPACE): string {
  const hash = createHash('sha1').update(uuidBytes(namespace)).update(name, 'utf8').digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return format(bytes);
}

/** Deterministic id for a seed object, scoped by tenant slug: `seedId('ain', 'venture', 'quietquad')`. */
export function seedId(tenantSlug: string, ...parts: string[]): string {
  return uuidV5([tenantSlug, ...parts].join('/'));
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Per-venture canary embedded in one memory item and one document chunk of the synthetic seed:
 * `CANARY::<venture-slug>::<8 chars>`. Deterministic, so evals can compute it; it must never appear in
 * another venture's responses.
 */
export function ventureCanary(ventureSlug: string): string {
  const digest = createHash('sha256').update(`foundry-ascent/canary/${ventureSlug}`, 'utf8').digest();
  let out = '';
  for (let i = 0; i < 8; i += 1) out += CROCKFORD[(digest[i] ?? 0) % 32] ?? '0';
  return `CANARY::${ventureSlug}::${out}`;
}
