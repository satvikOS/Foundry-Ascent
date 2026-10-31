-- Foundry Ascent — the face's mode: HeyGen LiveAvatar FULL with a vendor stock avatar and its stock voice, beside
-- the LITE face of 0017 (docs/runbooks/avatars.md, docs/architecture/calls.md §4).
-- Applied on top of 0001–0017 (there is no 0014); expand-only: nothing an older build reads or writes changes, and
-- every statement is re-runnable (IF NOT EXISTS, DROP … IF EXISTS before ADD).
--
--  1. call_faces.mode: `lite` (the face renders audio our server synthesized, 0017) or `full` (the vendor voices
--     text our server admitted, with its own stock voice). Every face before this migration is `lite`. Metering and
--     the daily maintenance bill a face at its mode's price.
--  2. call_faces.said_turn / said_seq: the last unit a FULL face was allowed to say (the order its units are
--     admitted in: later units of the same reply, or a reply it never said before), under the face's row lock.
--  3. call_faces.transcript_verified / transcript_pending_since: how many avatar lines of a FULL face's vendor
--     transcript the reconciliation has verified, and since when its last avatar lines have matched no admitted
--     unit (a line still being transcribed, or words our server never admitted).
--  4. call_face_texts: the units a FULL face was allowed to say, each once, as salted SHA-256 digests of their
--     normalized words and sentences (never the words). The heartbeat compares the vendor's transcript with them.
--     Owner role only; they go with the call.
--  5. call_speech.unit also takes `face.intro` and `face.<turn>.<seq>`: a unit reserved for a FULL face (its
--     characters within the call's speech budget, once), apart from the unit's own play, so the call can still
--     speak it in the stock voice when the face cannot.

-- ---------------------------------------------------------------------------------------------------
-- 1–3. The mode of a call's face, the order of its admitted units, and its transcript reconciliation
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE call_faces ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'lite';
ALTER TABLE call_faces DROP CONSTRAINT IF EXISTS call_faces_mode_check;
ALTER TABLE call_faces ADD CONSTRAINT call_faces_mode_check CHECK (mode IN ('lite', 'full'));

ALTER TABLE call_faces ADD COLUMN IF NOT EXISTS said_turn text;
ALTER TABLE call_faces ADD COLUMN IF NOT EXISTS said_seq integer;
ALTER TABLE call_faces DROP CONSTRAINT IF EXISTS call_faces_said_check;
ALTER TABLE call_faces ADD CONSTRAINT call_faces_said_check CHECK (
  (said_turn IS NULL AND said_seq IS NULL)
  OR (mode = 'full' AND said_seq BETWEEN 0 AND 99999
      AND said_turn ~ '^(intro|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'));

ALTER TABLE call_faces ADD COLUMN IF NOT EXISTS transcript_verified integer NOT NULL DEFAULT 0;
ALTER TABLE call_faces ADD COLUMN IF NOT EXISTS transcript_pending_since timestamptz;
ALTER TABLE call_faces DROP CONSTRAINT IF EXISTS call_faces_transcript_check;
ALTER TABLE call_faces ADD CONSTRAINT call_faces_transcript_check CHECK (
  transcript_verified BETWEEN 0 AND 100000
  AND (mode = 'full' OR (transcript_verified = 0 AND transcript_pending_since IS NULL)));

-- ---------------------------------------------------------------------------------------------------
-- 4. The units a FULL face was allowed to say
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS call_face_texts (
  call_id     uuid NOT NULL REFERENCES call_faces (call_id) ON DELETE CASCADE,
  -- The speech unit's call_speech key: `intro` or `unit.<turn id>.<seq>`.
  unit        text NOT NULL,
  -- `intro` or the turn id, and the unit's place in it.
  turn_key    text NOT NULL,
  seq         integer NOT NULL,
  -- Admission order.
  ord         bigint GENERATED ALWAYS AS IDENTITY,
  -- SHA-256 (hex) of the unit's normalized words and of each of its sentences, salted with the call id.
  digests     text[] NOT NULL,
  admitted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (call_id, unit),
  CONSTRAINT call_face_texts_unit_check CHECK (
    unit = 'intro'
    OR unit ~ '^unit[.][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.][0-9]{1,5}$'),
  CONSTRAINT call_face_texts_turn_check CHECK (
    turn_key ~ '^(intro|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
    AND seq BETWEEN 0 AND 99999),
  CONSTRAINT call_face_texts_digests_check CHECK (
    cardinality(digests) BETWEEN 1 AND 40
    AND array_to_string(digests, ',') ~ '^[0-9a-f]{64}(,[0-9a-f]{64})*$')
);
ALTER TABLE call_face_texts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON call_face_texts FROM app_rls;

-- ---------------------------------------------------------------------------------------------------
-- 5. A unit reserved for a FULL face
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE call_speech DROP CONSTRAINT IF EXISTS call_speech_unit_check;
ALTER TABLE call_speech ADD CONSTRAINT call_speech_unit_check CHECK (
  unit IN ('intro', 'face.intro')
  OR unit ~ '^(unit|run|crisis|face)[.][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}([.][0-9]{1,5}){0,2}$');
