import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import { type SessionSigningKey } from '../auth/session-token.js';
import { type VerifiedFaceAudio } from '../ports.js';

/**
 * Audio for the face of a call (docs/architecture/calls.md §4), and the two secrets around it.
 *
 * The face (HeyGen LiveAvatar, LITE mode) renders PCM we send it: 16-bit mono little-endian at 24 kHz. Its speak
 * channel never leaves the server. `POST /speech` synthesizes a signed unit for a call with a live face as that PCM
 * (in a WAV container, so the browser can still play it itself if the face fails) and adds a **face-audio
 * manifest**: the hashes of the audio's one-second chunks and the unit, call and face session it belongs to,
 * under an HMAC only the server can make. When the unit's turn to be heard comes, the browser hands those exact
 * bytes back (`POST /calls/:id/face/speak`), the server checks every chunk against the manifest, and only then
 * relays it to the face. So the face can only ever render audio our server made from words the validators
 * approved, in this call's own face session, without synthesizing (and paying for) a unit twice.
 *
 * The control channel (LITE's `ws_url`) is a credential: it is stored only encrypted (AES-256-GCM under a key
 * derived from the platform session-signing key with its own label) and erased when the face ends.
 *
 * Both keys are derived (HKDF-SHA256) from the session-signing key with labels of their own, so neither a speech
 * signature, a session token nor a manifest can stand in for another. They carry the key id, so they keep working
 * through a key rotation (the session keys' grace window).
 */

/** The face renders 24 kHz audio. */
export const FACE_SAMPLE_RATE = 24_000;
/** One second of 16-bit mono PCM at 24 kHz: the manifest's chunk (and the size the vendor recommends per packet). */
export const FACE_CHUNK_BYTES = FACE_SAMPLE_RATE * 2;
/** Chunks one hand-over may carry (18 s; the API reads at most 1 MiB per request). */
export const FACE_MAX_PART_CHUNKS = 18;
/** The longest unit a manifest covers (a unit is at most 600 characters: about 45 s of speech). */
export const FACE_MAX_UNIT_CHUNKS = 90;
/** Bytes of a chunk's hash kept in the manifest (128 bits). */
const HASH_BYTES = 16;

const MANIFEST_INFO = 'foundry-ascent/face-audio/v1';
const MANIFEST_VERSION = 'fa1';
const CONTROL_INFO = 'foundry-ascent/face-control/v1';
const CONTROL_VERSION = 'fc1';
const WAV_HEADER_BYTES = 44;

function derive(key: SessionSigningKey, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', key.bytes, new Uint8Array(0), info, 32));
}

// ------------------------------------------------------------------------------------------------
// PCM and WAV
// ------------------------------------------------------------------------------------------------

/** A WAV container (RIFF, PCM, 16-bit mono) around `pcm`. */
export function pcmToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(WAV_HEADER_BYTES + pcm.byteLength);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) out[offset + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, WAV_HEADER_BYTES);
  return out;
}

/**
 * Resamples 16-bit mono PCM (linear interpolation). Amazon Polly's PCM stops at 16 kHz; the face takes 24 kHz.
 * An odd trailing byte is dropped.
 */
export function resamplePcm16(pcm: Uint8Array, fromHz: number, toHz: number): Uint8Array {
  const samples = Math.floor(pcm.byteLength / 2);
  if (fromHz === toHz || samples === 0) return pcm.slice(0, samples * 2);
  const input = new DataView(pcm.buffer, pcm.byteOffset, samples * 2);
  const count = Math.floor((samples * toHz) / fromHz);
  const out = new Uint8Array(count * 2);
  const output = new DataView(out.buffer);
  const step = fromHz / toHz;
  for (let i = 0; i < count; i += 1) {
    const at = i * step;
    const lo = Math.floor(at);
    const hi = Math.min(samples - 1, lo + 1);
    const frac = at - lo;
    const a = input.getInt16(lo * 2, true);
    const b = input.getInt16(hi * 2, true);
    output.setInt16(i * 2, Math.round(a + (b - a) * frac), true);
  }
  return out;
}

/** The PCM payload of 16-bit PCM: whole samples only. */
export function wholeSamples(pcm: Uint8Array): Uint8Array {
  return pcm.byteLength % 2 === 0 ? pcm : pcm.subarray(0, pcm.byteLength - 1);
}

/** Reads a whole stream into one buffer. */
export async function readAll(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('audio too long');
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// The face-audio manifest
// ------------------------------------------------------------------------------------------------

export interface FaceAudioClaims {
  readonly callId: string;
  /** The call's face session (`call_faces.session_ref`). */
  readonly sessionRef: string;
  /** The unit (`call_speech` key: `intro`, `unit.<turn>.<seq>`). */
  readonly unit: string;
}

interface ManifestBody {
  readonly c: string;
  readonly f: string;
  readonly u: string;
  /** Total PCM bytes. */
  readonly n: number;
  /** base64url of each chunk's truncated SHA-256. */
  readonly h: readonly string[];
}

function chunkHash(chunk: Uint8Array): string {
  return createHash('sha256').update(chunk).digest().subarray(0, HASH_BYTES).toString('base64url');
}

function chunksOf(pcm: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < pcm.byteLength; offset += FACE_CHUNK_BYTES) {
    chunks.push(pcm.subarray(offset, Math.min(pcm.byteLength, offset + FACE_CHUNK_BYTES)));
  }
  return chunks;
}

function manifestMac(key: SessionSigningKey, payload: string): Buffer {
  return createHmac('sha256', derive(key, MANIFEST_INFO)).update(payload, 'utf8').digest();
}

/**
 * The manifest of a unit's face audio: `fa1.<keyId>.<payload>.<mac>`, about 1 kB for a long unit (an HTTP
 * header). Null when the audio is longer than a unit can be.
 */
export function signFaceAudio(
  key: SessionSigningKey,
  claims: FaceAudioClaims,
  pcm: Uint8Array,
): string | null {
  const chunks = chunksOf(pcm);
  if (chunks.length === 0 || chunks.length > FACE_MAX_UNIT_CHUNKS) return null;
  const body: ManifestBody = {
    c: claims.callId.toLowerCase(),
    f: claims.sessionRef,
    u: claims.unit,
    n: pcm.byteLength,
    h: chunks.map(chunkHash),
  };
  const payload = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  return `${MANIFEST_VERSION}.${key.id}.${payload}.${manifestMac(key, payload).toString('base64url')}`;
}

export type FaceAudioCheck =
  | {
      readonly ok: true;
      readonly audio: VerifiedFaceAudio;
      readonly unit: string;
      /** The unit's length in one-second chunks. */
      readonly chunks: number;
      /** The chunks this part carries (from `firstChunk`). */
      readonly partChunks: number;
    }
  /** `manifest_invalid`: not a manifest this server made; `wrong_call`: another call or face session;
   * `audio_mismatch`: the bytes are not the audio it covers. */
  | { readonly ok: false; readonly reason: 'manifest_invalid' | 'wrong_call' | 'audio_mismatch' };

/**
 * Checks one part of a unit's face audio: the manifest is this server's (any verification key), names this call
 * and face session, and every chunk of `pcm`, starting at chunk `part`, is exactly the chunk it covers. Only then
 * is the audio a {@link VerifiedFaceAudio}. Never throws.
 */
export function verifyFaceAudio(
  keys: readonly SessionSigningKey[],
  manifest: string,
  expected: { readonly callId: string; readonly sessionRef: string },
  part: { readonly firstChunk: number; readonly pcm: Uint8Array },
): FaceAudioCheck {
  if (manifest.length > 8_000) return { ok: false, reason: 'manifest_invalid' };
  const pieces = manifest.split('.');
  if (pieces.length !== 4 || pieces[0] !== MANIFEST_VERSION) return { ok: false, reason: 'manifest_invalid' };
  const [, keyId, payload, mac] = pieces as [string, string, string, string];
  const key = keys.find((k) => k.id === keyId);
  if (key === undefined) return { ok: false, reason: 'manifest_invalid' };
  const given = Buffer.from(mac, 'base64url');
  const wanted = manifestMac(key, payload);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    return { ok: false, reason: 'manifest_invalid' };
  }
  let body: ManifestBody;
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ManifestBody;
  } catch {
    return { ok: false, reason: 'manifest_invalid' };
  }
  if (body.c !== expected.callId.toLowerCase() || body.f !== expected.sessionRef) {
    return { ok: false, reason: 'wrong_call' };
  }
  const chunks = chunksOf(part.pcm);
  const first = part.firstChunk;
  if (
    !Number.isInteger(first) ||
    first < 0 ||
    chunks.length === 0 ||
    chunks.length > FACE_MAX_PART_CHUNKS ||
    first + chunks.length > body.h.length
  ) {
    return { ok: false, reason: 'audio_mismatch' };
  }
  // Every chunk but the unit's last is a full second; the bytes must be exactly the ones covered.
  const last = first + chunks.length === body.h.length;
  const expectedBytes = last ? body.n - first * FACE_CHUNK_BYTES : chunks.length * FACE_CHUNK_BYTES;
  if (part.pcm.byteLength !== expectedBytes) return { ok: false, reason: 'audio_mismatch' };
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    if (chunk === undefined || chunkHash(chunk) !== body.h[first + i]) {
      return { ok: false, reason: 'audio_mismatch' };
    }
  }
  return {
    ok: true,
    unit: body.u,
    chunks: body.h.length,
    partChunks: chunks.length,
    audio: { pcm: part.pcm, utterance: body.u, first: first === 0, last } as unknown as VerifiedFaceAudio,
  };
}

// ------------------------------------------------------------------------------------------------
// The control channel, encrypted at rest
// ------------------------------------------------------------------------------------------------

/** Encrypts the face's control channel for storage: base64 of `fc1.<keyId>.<iv|tag|ciphertext>`. */
export function encryptControl(key: SessionSigningKey, plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derive(key, CONTROL_INFO), iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const sealed = Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
  return Buffer.from(`${CONTROL_VERSION}.${key.id}.${sealed}`, 'utf8').toString('base64');
}

/** The control channel back from its stored form (null when no key opens it, or it was tampered with). */
export function decryptControl(
  keys: readonly SessionSigningKey[],
  stored: string,
  aad: string,
): string | null {
  try {
    const text = Buffer.from(stored, 'base64').toString('utf8');
    const pieces = text.split('.');
    if (pieces.length !== 3 || pieces[0] !== CONTROL_VERSION) return null;
    const [, keyId, sealed] = pieces as [string, string, string];
    const key = keys.find((k) => k.id === keyId);
    if (key === undefined) return null;
    const raw = Buffer.from(sealed, 'base64url');
    if (raw.length < 29) return null;
    const decipher = createDecipheriv('aes-256-gcm', derive(key, CONTROL_INFO), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
