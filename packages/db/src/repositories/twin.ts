/**
 * The vEIR's digital twin (migration 0017): a persona's face and cloned voice at their vendors
 * (`persona_media`, curators only), what a call may use of them right now (`app.persona_twin`), and the vendor
 * face session of a call (`call_faces`, owner role only).
 */
import { TwinMediaKind, TwinMediaStatus, TwinMediaVendor, type TwinMediaView } from '@foundry/contracts';

import { camelRow, col, type CamelRow } from '../columns.js';
import { type SqlExecutor, type SystemExecutor } from '../executor.js';
import { p } from '../params.js';
import { queryFirst, queryNumber, queryOne, queryRows } from './common.js';

// ------------------------------------------------------------------------------------------------
// A persona's media at its vendors
// ------------------------------------------------------------------------------------------------

const mediaShape = {
  persona_id: col.uuid,
  tenant_id: col.uuid,
  kind: col.enum(TwinMediaKind.options),
  vendor: col.enum(TwinMediaVendor.options),
  vendor_ref: col.text,
  status: col.enum(TwinMediaStatus.options),
  updated_by: col.uuid,
  updated_at: col.ts,
};
const mediaCodec = camelRow(mediaShape);
export type PersonaMediaRecord = CamelRow<typeof mediaShape>;
const MEDIA_COLUMNS = 'persona_id, tenant_id, kind, vendor, vendor_ref, status, updated_by, updated_at';

export function toTwinMediaView(m: PersonaMediaRecord): TwinMediaView {
  return { kind: m.kind, vendor: m.vendor, vendorRef: m.vendorRef, status: m.status, updatedAt: m.updatedAt };
}

/** The persona's face and voice records (curators of the persona; others see none). */
export function listPersonaMedia(ex: SqlExecutor, personaId: string): Promise<PersonaMediaRecord[]> {
  return queryRows(
    ex,
    `SELECT ${MEDIA_COLUMNS} FROM persona_media WHERE persona_id = :persona ORDER BY kind`,
    { persona: p.uuid(personaId) },
    (r) => mediaCodec.decode(r),
  );
}

/**
 * Records the vendor id and status of a persona's face or voice (one of each kind). `ready` is refused by the
 * database unless the consent in force covers the scope (`persona_media_consent`).
 */
export function upsertPersonaMedia(
  ex: SqlExecutor,
  input: {
    readonly personaId: string;
    readonly tenantId: string;
    readonly kind: TwinMediaKind;
    readonly vendor: TwinMediaVendor;
    readonly vendorRef: string;
    readonly status: TwinMediaStatus;
    readonly updatedBy: string;
  },
): Promise<PersonaMediaRecord> {
  return queryOne(
    ex,
    `INSERT INTO persona_media AS m (persona_id, tenant_id, kind, vendor, vendor_ref, status, updated_by)
     VALUES (:persona, :tenant, :kind, :vendor, :ref, :status, :by)
     ON CONFLICT (persona_id, kind) DO UPDATE
       SET vendor = EXCLUDED.vendor, vendor_ref = EXCLUDED.vendor_ref, status = EXCLUDED.status,
           updated_by = EXCLUDED.updated_by
     RETURNING ${MEDIA_COLUMNS}`,
    {
      persona: p.uuid(input.personaId),
      tenant: p.uuid(input.tenantId),
      kind: p.text(input.kind),
      vendor: p.text(input.vendor),
      ref: p.text(input.vendorRef),
      status: p.text(input.status),
      by: p.uuid(input.updatedBy),
    },
    (r) => mediaCodec.decode(r),
    'upsertPersonaMedia',
  );
}

/** Withdraws the persona's media of `kind` (null when there is none, or it was already withdrawn). */
export function withdrawPersonaMedia(
  ex: SqlExecutor,
  input: { readonly personaId: string; readonly kind: TwinMediaKind; readonly updatedBy: string },
): Promise<PersonaMediaRecord | null> {
  return queryFirst(
    ex,
    `UPDATE persona_media SET status = 'withdrawn', updated_by = :by
     WHERE persona_id = :persona AND kind = :kind AND status <> 'withdrawn'
     RETURNING ${MEDIA_COLUMNS}`,
    { persona: p.uuid(input.personaId), kind: p.text(input.kind), by: p.uuid(input.updatedBy) },
    (r) => mediaCodec.decode(r),
  );
}

/** What a call may use of a persona's twin now: ready media under its consent scope (`app.persona_twin`). */
export interface PersonaTwin {
  /** The HeyGen avatar id, while ready and covered by likeness consent. */
  readonly face: { readonly vendor: 'heygen'; readonly ref: string } | null;
  /** The ElevenLabs voice id, while ready and covered by voice consent. */
  readonly voice: { readonly vendor: 'elevenlabs'; readonly ref: string } | null;
}

export async function personaTwin(ex: SqlExecutor, personaId: string): Promise<PersonaTwin> {
  const rows = await queryRows(
    ex,
    'SELECT kind, vendor, vendor_ref FROM app.persona_twin(:persona)',
    { persona: p.uuid(personaId) },
    (r) => ({
      kind: col.text.decode(r.kind, 'kind'),
      vendor: col.text.decode(r.vendor, 'vendor'),
      ref: col.text.decode(r.vendor_ref, 'vendor_ref'),
    }),
  );
  const face = rows.find((r) => r.kind === 'face' && r.vendor === 'heygen');
  const voice = rows.find((r) => r.kind === 'voice' && r.vendor === 'elevenlabs');
  return {
    face: face ? { vendor: 'heygen', ref: face.ref } : null,
    voice: voice ? { vendor: 'elevenlabs', ref: voice.ref } : null,
  };
}

// ------------------------------------------------------------------------------------------------
// The vendor face session of a call (owner role)
// ------------------------------------------------------------------------------------------------

const faceShape = {
  call_id: col.uuid,
  tenant_id: col.uuid,
  started_by: col.uuid,
  vendor: col.enum(['heygen', 'fake'] as const),
  session_ref: col.text,
  control: col.text.nullable,
  max_seconds: col.int,
  metered_seconds: col.int,
  started_at: col.ts,
  ended_at: col.ts.nullable,
  end_reason: col.text.nullable,
  lasted: col.int,
};
const faceCodec = camelRow(faceShape);
/** A call's face; `control` is the base64 ciphertext of the control channel (null once ended). */
export type CallFaceRecord = CamelRow<typeof faceShape>;
const FACE_COLUMNS = `call_id, tenant_id, started_by, vendor, session_ref, encode(control_ciphertext, 'base64') AS control,
  max_seconds, metered_seconds, started_at, ended_at, end_reason,
  ceil(extract(epoch FROM coalesce(ended_at, now()) - started_at))::integer AS lasted`;

export function getCallFace(sx: SystemExecutor, callId: string): Promise<CallFaceRecord | null> {
  return queryFirst(
    sx,
    `SELECT ${FACE_COLUMNS} FROM call_faces WHERE call_id = :call`,
    { call: p.uuid(callId) },
    (r) => faceCodec.decode(r),
  );
}

/**
 * Records the face session of a live call of `startedBy` (at most one per call, ever). Null when the call is not
 * that person's live call, or already had a face.
 */
export function startCallFace(
  sx: SystemExecutor,
  input: {
    readonly callId: string;
    readonly startedBy: string;
    readonly vendor: 'heygen' | 'fake';
    readonly sessionRef: string;
    /** Base64 AES-GCM ciphertext of the control channel, or null. */
    readonly control: string | null;
    readonly maxSeconds: number;
  },
): Promise<CallFaceRecord | null> {
  return queryFirst(
    sx,
    `INSERT INTO call_faces (call_id, tenant_id, started_by, vendor, session_ref, control_ciphertext, max_seconds)
     SELECT c.id, c.tenant_id, c.started_by, :vendor, :ref, decode(:control, 'base64'), :max
       FROM calls c WHERE c.id = :call AND c.started_by = :by AND c.status = 'live'
     ON CONFLICT (call_id) DO NOTHING
     RETURNING ${FACE_COLUMNS}`,
    {
      call: p.uuid(input.callId),
      by: p.uuid(input.startedBy),
      vendor: p.text(input.vendor),
      ref: p.text(input.sessionRef),
      control: p.nullable.text(input.control),
      max: p.int(Math.max(0, Math.min(14_400, Math.floor(input.maxSeconds)))),
    },
    (r) => faceCodec.decode(r),
  );
}

/** What one metering of a face added, and whom the usage ledger bills it to. */
export interface FaceMetering {
  /** Seconds this metering added (0 when nothing was due). */
  readonly added: number;
  readonly tenantId: string;
  readonly ventureId: string;
  /** The person whose call it is (the face's starter). */
  readonly startedBy: string;
  readonly vendor: 'heygen' | 'fake';
}

/**
 * Brings a face's metered seconds up to the server's clock (up to its end once it ended, never beyond its
 * `max_seconds`) and returns how many seconds this added, with whom to bill them; null when the call has no face.
 * The caller writes the usage-ledger row in the same transaction, so `metered_seconds` is always what the ledger
 * holds (the row lock makes concurrent meterings add each second once).
 */
export function meterCallFace(sx: SystemExecutor, callId: string): Promise<FaceMetering | null> {
  return queryFirst(
    sx,
    `WITH prev AS (SELECT f.call_id, f.metered_seconds AS before FROM call_faces f WHERE f.call_id = :call FOR UPDATE)
     UPDATE call_faces AS f
        SET metered_seconds = least(f.max_seconds, greatest(f.metered_seconds,
              ceil(extract(epoch FROM coalesce(f.ended_at, now()) - f.started_at))::integer))
       FROM prev, calls c WHERE f.call_id = prev.call_id AND c.id = f.call_id
     RETURNING greatest(0, f.metered_seconds - prev.before)::integer AS added, f.tenant_id, c.venture_id,
               f.started_by, f.vendor`,
    { call: p.uuid(callId) },
    (r) => ({
      added: col.int.decode(r.added, 'added'),
      tenantId: col.uuid.decode(r.tenant_id, 'tenant_id'),
      ventureId: col.uuid.decode(r.venture_id, 'venture_id'),
      startedBy: col.uuid.decode(r.started_by, 'started_by'),
      vendor: col.enum(['heygen', 'fake'] as const).decode(r.vendor, 'vendor'),
    }),
  );
}

/**
 * Faces that ended with seconds not yet billed (their call was closed by the reaper, or the metering after the
 * end did not run): the calls to meter. Oldest first, at most `limit`.
 */
export function unbilledEndedFaces(sx: SystemExecutor, input: { readonly limit: number }): Promise<string[]> {
  return queryRows(
    sx,
    `SELECT f.call_id FROM call_faces f
      WHERE f.ended_at IS NOT NULL
        AND f.metered_seconds < least(f.max_seconds, ceil(extract(epoch FROM f.ended_at - f.started_at))::integer)
      ORDER BY f.ended_at LIMIT :limit`,
    { limit: p.int(input.limit) },
    (r) => col.uuid.decode(r.call_id, 'call_id'),
  );
}

/**
 * Ends a call's face (`reason`: why) and erases its control channel. Returns the face as it was before ending
 * (with its ciphertext, so the vendor session can be stopped), or null when it had no live face.
 */
export function endCallFace(
  sx: SystemExecutor,
  input: { readonly callId: string; readonly reason: string },
): Promise<CallFaceRecord | null> {
  return queryFirst(
    sx,
    `WITH prev AS (
       SELECT f.call_id, encode(f.control_ciphertext, 'base64') AS control
         FROM call_faces f WHERE f.call_id = :call AND f.ended_at IS NULL FOR UPDATE)
     UPDATE call_faces AS f SET ended_at = now(), end_reason = :reason, control_ciphertext = NULL,
                                speaking_unit = NULL
       FROM prev WHERE f.call_id = prev.call_id
     RETURNING f.call_id, f.tenant_id, f.started_by, f.vendor, f.session_ref, prev.control, f.max_seconds,
               f.metered_seconds, f.started_at, f.ended_at, f.end_reason,
               ceil(extract(epoch FROM f.ended_at - f.started_at))::integer AS lasted`,
    { call: p.uuid(input.callId), reason: p.text(input.reason) },
    (r) => faceCodec.decode(r),
  );
}

/**
 * Video seconds a person used this calendar month (UTC), from the server's clock: each face from its start to its
 * end (or now, while live), within its limit. It does not wait for the metering, so a face whose billing is still
 * due counts in full.
 */
export function faceSecondsThisMonth(ex: SystemExecutor, principalId: string): Promise<number> {
  return queryNumber(
    ex,
    `SELECT coalesce(sum(least(f.max_seconds,
                               ceil(extract(epoch FROM coalesce(f.ended_at, now()) - f.started_at))::integer)),
                     0)::integer AS n
       FROM call_faces f
      WHERE f.started_by = :principal
        AND f.started_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    { principal: p.uuid(principalId) },
  );
}

/**
 * Admits one part of a synthesized unit's audio to the call's live face (`sessionRef`): the `chunks` one-second
 * chunks from chunk `first`, of a unit `total` chunks long. In one statement, under the face's row lock:
 *  - the unit's first part (chunk 0) counts its hand-over (at most `maxPlays`) and makes it the unit the face is
 *    saying;
 *  - every later part must be of the unit the face is saying, start exactly where the last one ended, and stay
 *    within the unit (nothing after its last chunk).
 * So validated speech reaches the face only as whole units in their own order, each part once, never resumed
 * after barge-in or after another unit began. False when refused.
 */
export async function admitFacePart(
  sx: SystemExecutor,
  input: {
    readonly callId: string;
    readonly sessionRef: string;
    readonly unit: string;
    readonly first: number;
    readonly chunks: number;
    readonly total: number;
    readonly maxPlays: number;
  },
): Promise<boolean> {
  const admitted = await queryFirst(
    sx,
    `WITH face AS (
       SELECT f.call_id FROM call_faces f
        WHERE f.call_id = :call AND f.session_ref = :ref AND f.ended_at IS NULL
          AND (:first = 0 OR f.speaking_unit = :unit)
        FOR UPDATE),
     part AS (
       UPDATE call_speech s
          SET face_next_chunk = :first + :chunks,
              face_plays = s.face_plays + (CASE WHEN :first = 0 THEN 1 ELSE 0 END)
         FROM face
        WHERE s.call_id = face.call_id AND s.unit = :unit AND s.plays >= 1
          AND s.face_next_chunk = :first AND :chunks >= 1 AND :first + :chunks <= :total
          AND (:first > 0 OR s.face_plays < :max)
        RETURNING s.call_id, s.unit)
     UPDATE call_faces f SET speaking_unit = part.unit FROM part WHERE f.call_id = part.call_id
     RETURNING f.call_id`,
    {
      call: p.uuid(input.callId),
      ref: p.text(input.sessionRef),
      unit: p.text(input.unit),
      first: p.int(input.first),
      chunks: p.int(input.chunks),
      total: p.int(input.total),
      max: p.int(input.maxPlays),
    },
    (r) => col.uuid.decode(r.call_id, 'call_id'),
  );
  return admitted !== null;
}

/**
 * Barge-in: the face no longer says the unit it was saying, so no later part of it is admitted. True when the
 * call has a live face.
 */
export async function sealFaceUtterance(sx: SystemExecutor, callId: string): Promise<boolean> {
  const sealed = await queryFirst(
    sx,
    `UPDATE call_faces SET speaking_unit = NULL WHERE call_id = :call AND ended_at IS NULL RETURNING call_id`,
    { call: p.uuid(callId) },
    (r) => col.uuid.decode(r.call_id, 'call_id'),
  );
  return sealed !== null;
}
