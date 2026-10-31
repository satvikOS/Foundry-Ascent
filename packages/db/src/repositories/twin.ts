/**
 * The vEIR's digital twin (migrations 0017, 0018): a persona's face and cloned voice at their vendors
 * (`persona_media`, curators only), what a call may use of them right now (`app.persona_twin`), and the vendor
 * face session of a call in its mode (`call_faces`, `call_face_texts`, owner role only).
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

/** How a face speaks (0018): `lite` renders audio our server made, `full` voices text our server admitted. */
export type FaceMode = 'lite' | 'full';
const FACE_MODES = ['lite', 'full'] as const;

const faceShape = {
  call_id: col.uuid,
  tenant_id: col.uuid,
  started_by: col.uuid,
  vendor: col.enum(['heygen', 'fake'] as const),
  mode: col.enum(FACE_MODES),
  session_ref: col.text,
  control: col.text.nullable,
  max_seconds: col.int,
  metered_seconds: col.int,
  started_at: col.ts,
  ended_at: col.ts.nullable,
  end_reason: col.text.nullable,
  lasted: col.int,
  /** Avatar lines of the vendor transcript verified so far (FULL). */
  transcript_verified: col.int,
  /** Seconds since the face's last transcript lines matched nothing it was allowed to say (null: none pending). */
  transcript_pending: col.int.nullable,
  /** Where the last check stopped: after the first `transcript_skip` avatar lines at this vendor timestamp. */
  transcript_cursor: col.num.nullable,
  transcript_skip: col.int,
  /** Seconds since a check last read the transcript to its end (since the face started, if none has). */
  transcript_unchecked: col.int,
};
const faceCodec = camelRow(faceShape);
/** A call's face; `control` is the base64 ciphertext of the control channel (null once ended). */
export type CallFaceRecord = CamelRow<typeof faceShape>;
const PENDING = `floor(extract(epoch FROM now() - transcript_pending_since))::integer`;
/** The transcript columns of a face (`f` names the table in statements that join). */
const transcriptColumns = (f = ''): string =>
  `${f}transcript_verified, floor(extract(epoch FROM now() - ${f}transcript_pending_since))::integer
     AS transcript_pending, ${f}transcript_cursor, ${f}transcript_skip,
   greatest(0, floor(extract(epoch FROM now() - coalesce(${f}transcript_checked_at, ${f}started_at))))::integer
     AS transcript_unchecked`;
const FACE_COLUMNS = `call_id, tenant_id, started_by, vendor, mode, session_ref,
  encode(control_ciphertext, 'base64') AS control, max_seconds, metered_seconds, started_at, ended_at, end_reason,
  ceil(extract(epoch FROM coalesce(ended_at, now()) - started_at))::integer AS lasted,
  ${transcriptColumns()}`;

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
    /** How the face speaks (default `lite`). */
    readonly mode?: FaceMode;
    readonly sessionRef: string;
    /** Base64 AES-GCM ciphertext of the control channel, or null. */
    readonly control: string | null;
    readonly maxSeconds: number;
  },
): Promise<CallFaceRecord | null> {
  return queryFirst(
    sx,
    `INSERT INTO call_faces (call_id, tenant_id, started_by, vendor, mode, session_ref, control_ciphertext, max_seconds)
     SELECT c.id, c.tenant_id, c.started_by, :vendor, :mode, :ref, decode(:control, 'base64'), :max
       FROM calls c WHERE c.id = :call AND c.started_by = :by AND c.status = 'live'
     ON CONFLICT (call_id) DO NOTHING
     RETURNING ${FACE_COLUMNS}`,
    {
      call: p.uuid(input.callId),
      by: p.uuid(input.startedBy),
      vendor: p.text(input.vendor),
      mode: p.text(input.mode ?? 'lite'),
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
  /** The face's mode, which decides its price. */
  readonly mode: FaceMode;
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
               f.started_by, f.vendor, f.mode`,
    { call: p.uuid(callId) },
    (r) => ({
      added: col.int.decode(r.added, 'added'),
      tenantId: col.uuid.decode(r.tenant_id, 'tenant_id'),
      ventureId: col.uuid.decode(r.venture_id, 'venture_id'),
      startedBy: col.uuid.decode(r.started_by, 'started_by'),
      vendor: col.enum(['heygen', 'fake'] as const).decode(r.vendor, 'vendor'),
      mode: col.enum(FACE_MODES).decode(r.mode, 'mode'),
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
     RETURNING f.call_id, f.tenant_id, f.started_by, f.vendor, f.mode, f.session_ref, prev.control, f.max_seconds,
               f.metered_seconds, f.started_at, f.ended_at, f.end_reason,
               ceil(extract(epoch FROM f.ended_at - f.started_at))::integer AS lasted,
               ${transcriptColumns('f.')}`,
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

/**
 * Admits one validated unit to the call's live FULL face (`sessionRef`): the vendor may then voice its text. In one
 * statement, under the face's row lock, each unit is admitted once and in order: a later unit of the reply the face
 * is saying (`turnKey`, a higher `seq`), or the first unit the face takes of a reply (or the intro) it never said
 * before. So validated units reach the face only once each, never replayed or reordered, never resumed from a reply
 * it already left. `digests` (salted SHA-256 of the unit's normalized words and sentences, never the words) are
 * what the face's transcript is reconciled against. `preapproved` marks a unit the turn engine admitted as it signed
 * it (0020), which `POST /calls/:id/face/say` may then confirm again ({@link preapprovedFaceText}). False when
 * refused.
 */
export async function admitFaceText(
  sx: SystemExecutor,
  input: {
    readonly callId: string;
    readonly sessionRef: string;
    /** The speech unit's call_speech key (`intro` or `unit.<turn>.<seq>`). */
    readonly unit: string;
    /** `intro` or the turn id. */
    readonly turnKey: string;
    readonly seq: number;
    /** The whole unit's digests first (`wholes` of them), then its sentences' (`faceTextDigests`). */
    readonly digests: readonly string[];
    readonly wholes: number;
    /** Admitted by the turn engine as it signed the unit (0020); false (the default) for `face/say`. */
    readonly preapproved?: boolean;
  },
): Promise<boolean> {
  const admitted = await queryFirst(
    sx,
    `WITH face AS (
       UPDATE call_faces f SET said_turn = :turn, said_seq = :seq
        WHERE f.call_id = :call AND f.session_ref = :ref AND f.ended_at IS NULL AND f.mode = 'full'
          AND (f.said_turn IS NULL
               OR (f.said_turn = :turn AND f.said_seq < :seq)
               OR (f.said_turn <> :turn
                   AND NOT EXISTS (SELECT 1 FROM call_face_texts t
                                    WHERE t.call_id = f.call_id AND t.turn_key = :turn)))
        RETURNING f.call_id)
     INSERT INTO call_face_texts (call_id, unit, turn_key, seq, digests, wholes, preapproved)
     SELECT face.call_id, :unit, :turn, :seq, :digests, :wholes, :preapproved FROM face
     ON CONFLICT (call_id, unit) DO NOTHING
     RETURNING call_id`,
    {
      call: p.uuid(input.callId),
      ref: p.text(input.sessionRef),
      unit: p.text(input.unit),
      turn: p.text(input.turnKey),
      seq: p.int(input.seq),
      digests: p.textArray(input.digests),
      wholes: p.int(input.wholes),
      preapproved: p.bool(input.preapproved === true),
    },
    (r) => col.uuid.decode(r.call_id, 'call_id'),
  );
  return admitted !== null;
}

/**
 * Whether the turn engine already admitted exactly these words as `unit` to the call's live FULL face
 * (`sessionRef`): a unit it pre-approved, whose `digests` (the whole unit's and its sentences', as
 * {@link admitFaceText} stored them) are the same. A unit `face/say` admitted itself is never one.
 */
export async function preapprovedFaceText(
  sx: SystemExecutor,
  input: {
    readonly callId: string;
    readonly sessionRef: string;
    readonly unit: string;
    readonly digests: readonly string[];
  },
): Promise<boolean> {
  const found = await queryFirst(
    sx,
    `SELECT t.call_id FROM call_face_texts t
       JOIN call_faces f ON f.call_id = t.call_id
      WHERE t.call_id = :call AND t.unit = :unit AND t.preapproved AND t.digests = :digests
        AND f.session_ref = :ref AND f.ended_at IS NULL AND f.mode = 'full'`,
    {
      call: p.uuid(input.callId),
      ref: p.text(input.sessionRef),
      unit: p.text(input.unit),
      digests: p.textArray(input.digests),
    },
    (r) => col.uuid.decode(r.call_id, 'call_id'),
  );
  return found !== null;
}

/** A unit a FULL face was allowed to say: its digests, and what of it the transcript already showed said. */
export interface FaceTextUnit {
  readonly unit: string;
  readonly digests: readonly string[];
  readonly wholes: number;
  /** Bit i: the transcript matched `digests[i]`. */
  readonly said: number;
}

/** The units the call's FULL face was allowed to say, in admission order (owner role). */
export function faceTextUnits(sx: SystemExecutor, callId: string): Promise<FaceTextUnit[]> {
  return queryRows(
    sx,
    `SELECT unit, digests, wholes, said_mask FROM call_face_texts WHERE call_id = :call ORDER BY ord`,
    { call: p.uuid(callId) },
    (r) => ({
      unit: col.text.decode(r.unit, 'unit'),
      digests: col.textArray.decode(r.digests, 'digests'),
      wholes: col.int.decode(r.wholes, 'wholes'),
      said: col.int.decode(r.said_mask, 'said_mask'),
    }),
  );
}

/**
 * Records a check of a live FULL face's transcript, only if no other check moved its cursor since this one read it
 * (`from`): the lines it verified (`added`), where it stopped (`cursor`), what each matched unit has now said
 * (`said`, only ever adding bits), whether its last lines are still unmatched (`pending`: the time a check first
 * saw them is kept; cleared once they match) and whether it read the transcript to its end (`complete`). Returns
 * the seconds those lines have been pending (null: none), or null when another check won or the face ended.
 */
export async function recordFaceTranscript(
  sx: SystemExecutor,
  input: {
    readonly callId: string;
    readonly from: { readonly at: number | null; readonly skip: number };
    readonly cursor: { readonly at: number | null; readonly skip: number };
    readonly added: number;
    readonly said: ReadonlyMap<string, number>;
    readonly pending: boolean;
    readonly complete: boolean;
  },
): Promise<{ readonly pending: number | null } | null> {
  const row = await queryFirst(
    sx,
    `UPDATE call_faces
        SET transcript_verified = least(transcript_verified + :added, 100000),
            transcript_cursor = :cursor, transcript_skip = least(:skip, 100000),
            transcript_pending_since = CASE WHEN :pending THEN coalesce(transcript_pending_since, now()) END,
            transcript_checked_at = CASE WHEN :complete THEN now() ELSE transcript_checked_at END
      WHERE call_id = :call AND ended_at IS NULL AND mode = 'full'
        AND transcript_cursor IS NOT DISTINCT FROM :fromCursor AND transcript_skip = :fromSkip
      RETURNING ${PENDING} AS pending`,
    {
      call: p.uuid(input.callId),
      added: p.int(Math.max(0, Math.min(100000, Math.floor(input.added)))),
      cursor: p.nullable.num(input.cursor.at),
      skip: p.int(Math.max(0, Math.min(100000, Math.floor(input.cursor.skip)))),
      fromCursor: p.nullable.num(input.from.at),
      fromSkip: p.int(Math.max(0, Math.min(100000, Math.floor(input.from.skip)))),
      pending: p.bool(input.pending),
      complete: p.bool(input.complete),
    },
    (r) => ({ pending: col.int.nullable.decode(r.pending, 'pending') }),
  );
  if (row === null) return null;
  for (const [unit, said] of input.said) {
    await sx.query(
      `UPDATE call_face_texts SET said_mask = said_mask | :said WHERE call_id = :call AND unit = :unit`,
      { call: p.uuid(input.callId), unit: p.text(unit), said: p.bigint(said) },
    );
  }
  return row;
}
