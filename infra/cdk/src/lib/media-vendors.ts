/**
 * The infra side of `packages/core/media-vendors.json`: the Secrets Manager names the API's digital-twin adapters
 * read (apps/api media-secrets.ts) and core prices against. The API role may read exactly these secrets, and only
 * the ones of a vendor the deployment wires (config `media`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../paths.js';

export const MEDIA_VENDORS_FILE = join(REPO_ROOT, 'packages', 'core', 'media-vendors.json');

const SECRET_NAME = /^foundry-ascent\/media\/[a-z0-9-]+$/;

export interface MediaVendorSecrets {
  /** HeyGen LiveAvatar's API key (`{"apiKey": "…"}`). */
  readonly face: string;
  /** ElevenLabs' API key. */
  readonly voice: string;
}

function secretName(raw: unknown, path: string): string {
  const name = (raw as { secretName?: unknown } | undefined)?.secretName;
  if (typeof name !== 'string' || !SECRET_NAME.test(name)) {
    throw new Error(`${MEDIA_VENDORS_FILE}: ${path}.secretName must match ${String(SECRET_NAME)}`);
  }
  return name;
}

export function loadMediaVendorSecrets(file: string = MEDIA_VENDORS_FILE): MediaVendorSecrets {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as {
    face?: { heygen?: unknown };
    voice?: { elevenlabs?: unknown };
  };
  return {
    face: secretName(raw.face?.heygen, '$.face.heygen'),
    voice: secretName(raw.voice?.elevenlabs, '$.voice.elevenlabs'),
  };
}

/**
 * The ARN pattern of one secret: Secrets Manager appends a random 6-character suffix to a secret's name, so
 * `name-??????` matches exactly that secret (and not `name-other`, as `name*` would).
 */
export function secretArnPattern(partition: string, region: string, account: string, name: string): string {
  return `arn:${partition}:secretsmanager:${region}:${account}:secret:${name}-??????`;
}
