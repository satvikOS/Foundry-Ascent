-- Foundry Ascent — the vEIR's digital twin: a vendor face (HeyGen LiveAvatar, LITE mode) and a cloned voice
-- (ElevenLabs), each under its own consent scope, off until the program turns them on (docs/runbooks/avatars.md).
-- Applied on top of 0001–0016 (there is no 0014); expand-only: nothing an older build reads or writes changes, and
-- every statement is re-runnable (IF NOT EXISTS, DROP … IF EXISTS before ADD, CREATE OR REPLACE, ON CONFLICT).
--
--  1. persona_media: a persona's face and cloned voice at their vendors (the avatar id, the voice id: identifiers,
--     never credentials), with a status. Only an EIR persona has them, one of each kind; `ready` needs the consent
--     in force to cover the scope (`likeness` for a face, `voice` for a voice), checked whenever a row is written,
--     and a change of the persona's consent to one that no longer covers it withdraws it. The call path never
--     reads the table: app.persona_twin() returns only what is ready and covered right now.
--     Curators of the persona (its program leads and its own EIR) read and write it.
--  2. calls.voice_vendor: the voice a call started with (`polly`, or `elevenlabs` for the EIR's cloned voice);
--     like the call's other identity it never changes.
--  3. call_faces: the vendor face session of a call, at most one. The control channel (LITE's ws_url) is a
--     credential: stored only encrypted by the API, erased when the face or its call ends. Face seconds are metered
--     from the server's clock into the usage ledger (`metered_seconds` is what the ledger has, never beyond
--     `max_seconds`; ending the call leaves the tail to that metering, so the two never disagree). `speaking_unit`
--     is the unit whose later parts the face takes now (none after barge-in). Owner role only.
--  4. call_speech.face_plays / face_next_chunk: how often a synthesized unit was handed to the call's face
--     (bounded per unit), and the next one-second chunk of it the face may take (parts in order, each once).
--  5. Settings: `faces_enabled` and `cloned_voice_enabled` (off), video minutes per person per month (60) and per
--     call (20).

-- ---------------------------------------------------------------------------------------------------
-- 1. A persona's face and voice at their vendors
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS persona_media (
  persona_id  uuid NOT NULL REFERENCES personas (id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  kind        text NOT NULL,
  vendor      text NOT NULL,
  -- The avatar id (HeyGen) or voice id (ElevenLabs): an identifier at the vendor, not a secret.
  vendor_ref  text NOT NULL,
  status      text NOT NULL DEFAULT 'pending',
  updated_by  uuid NOT NULL REFERENCES principals (id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (persona_id, kind),
  CONSTRAINT persona_media_kind_check
    CHECK ((kind = 'face' AND vendor = 'heygen') OR (kind = 'voice' AND vendor = 'elevenlabs')),
  CONSTRAINT persona_media_ref_check CHECK (vendor_ref ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$'),
  CONSTRAINT persona_media_status_check CHECK (status IN ('pending', 'ready', 'withdrawn'))
);

-- Only an EIR persona of the row's tenant; `ready` only under a consent in force that covers the scope.
CREATE OR REPLACE FUNCTION app.persona_media_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_kind text;
  v_tenant uuid;
  v_assets text[];
BEGIN
  SELECT pe.kind, pe.tenant_id INTO v_kind, v_tenant FROM personas pe WHERE pe.id = NEW.persona_id;
  IF v_kind IS DISTINCT FROM 'eir_persona' OR v_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'only an EIR persona of the same tenant has a face or a voice at a vendor'
      USING ERRCODE = '23514', CONSTRAINT = 'persona_media_persona';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.persona_id <> OLD.persona_id OR NEW.kind <> OLD.kind
                          OR NEW.tenant_id <> OLD.tenant_id) THEN
    RAISE EXCEPTION 'a persona''s media keeps its persona and kind' USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'ready' THEN
    SELECT c.asset_types INTO v_assets FROM personas pe JOIN consents c ON c.id = pe.consent_id
     WHERE pe.id = NEW.persona_id AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > now());
    IF NOT coalesce((CASE NEW.kind WHEN 'face' THEN 'likeness' ELSE 'voice' END) = ANY (v_assets), false) THEN
      RAISE EXCEPTION 'a face needs consent to likeness and a cloned voice consent to voice'
        USING ERRCODE = '23514', CONSTRAINT = 'persona_media_consent';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.persona_media_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS persona_media_guard ON persona_media;
CREATE TRIGGER persona_media_guard BEFORE INSERT OR UPDATE ON persona_media
  FOR EACH ROW EXECUTE FUNCTION app.persona_media_guard();

-- A persona moved to a consent that no longer covers a scope: that scope's media is withdrawn (pending or ready).
CREATE OR REPLACE FUNCTION app.persona_media_follow_consent() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_assets text[];
BEGIN
  SELECT c.asset_types INTO v_assets FROM consents c
   WHERE c.id = NEW.consent_id AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > now());
  UPDATE persona_media m SET status = 'withdrawn'
   WHERE m.persona_id = NEW.id AND m.status <> 'withdrawn'
     AND NOT coalesce((CASE m.kind WHEN 'face' THEN 'likeness' ELSE 'voice' END) = ANY (v_assets), false);
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.persona_media_follow_consent() FROM PUBLIC;
DROP TRIGGER IF EXISTS persona_media_follow_consent ON personas;
CREATE TRIGGER persona_media_follow_consent AFTER UPDATE OF consent_id ON personas
  FOR EACH ROW WHEN (NEW.consent_id IS DISTINCT FROM OLD.consent_id)
  EXECUTE FUNCTION app.persona_media_follow_consent();

GRANT SELECT, INSERT, UPDATE ON persona_media TO app_rls;
ALTER TABLE persona_media ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS persona_media_read ON persona_media;
CREATE POLICY persona_media_read ON persona_media FOR SELECT TO app_rls
  USING (app.in_current_tenant(tenant_id) AND app.can_curate_persona(persona_id));
DROP POLICY IF EXISTS persona_media_insert ON persona_media;
CREATE POLICY persona_media_insert ON persona_media FOR INSERT TO app_rls
  WITH CHECK (app.in_current_tenant(tenant_id) AND app.can_curate_persona(persona_id)
              AND updated_by = app.current_principal());
DROP POLICY IF EXISTS persona_media_update ON persona_media;
CREATE POLICY persona_media_update ON persona_media FOR UPDATE TO app_rls
  USING (app.in_current_tenant(tenant_id) AND app.can_curate_persona(persona_id))
  WITH CHECK (app.in_current_tenant(tenant_id) AND app.can_curate_persona(persona_id)
              AND updated_by = app.current_principal());

-- What a call may use of a persona's twin right now: ready media whose scope its consent in force covers.
CREATE OR REPLACE FUNCTION app.persona_twin(p_persona uuid)
  RETURNS TABLE (kind text, vendor text, vendor_ref text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.kind, m.vendor, m.vendor_ref FROM persona_media m
   JOIN personas pe ON pe.id = m.persona_id AND pe.tenant_id = app.current_tenant()
   WHERE m.persona_id = p_persona AND m.status = 'ready' AND pe.kind = 'eir_persona'
     AND (CASE m.kind WHEN 'face' THEN 'likeness' ELSE 'voice' END) = ANY (app.persona_consent_assets(p_persona))
   ORDER BY m.kind
$$;
REVOKE ALL ON FUNCTION app.persona_twin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.persona_twin(uuid) TO app_rls;

-- ---------------------------------------------------------------------------------------------------
-- 2. The voice a call started with
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE calls ADD COLUMN IF NOT EXISTS voice_vendor text NOT NULL DEFAULT 'polly';
ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_voice_vendor_check;
ALTER TABLE calls ADD CONSTRAINT calls_voice_vendor_check CHECK (voice_vendor IN ('polly', 'elevenlabs', 'fake'));

-- Like the rest of a call's identity (0008's calls_guard), its voice vendor never changes. A trigger of its own, so
-- 0008's guard stays as 0008 wrote it.
CREATE OR REPLACE FUNCTION app.calls_voice_vendor_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.voice_vendor IS DISTINCT FROM OLD.voice_vendor THEN
    RAISE EXCEPTION 'a call''s voice never changes' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.calls_voice_vendor_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS calls_voice_vendor_guard ON calls;
CREATE TRIGGER calls_voice_vendor_guard BEFORE UPDATE OF voice_vendor ON calls
  FOR EACH ROW EXECUTE FUNCTION app.calls_voice_vendor_guard();

-- ---------------------------------------------------------------------------------------------------
-- 3. The vendor face session of a call
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS call_faces (
  call_id            uuid PRIMARY KEY REFERENCES calls (id) ON DELETE CASCADE,
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  started_by         uuid NOT NULL REFERENCES principals (id),
  vendor             text NOT NULL,
  -- The vendor's session id (not a secret).
  session_ref        text NOT NULL,
  -- AES-GCM of the server-held control channel (LITE ws_url), by the API; erased when the face ends.
  control_ciphertext bytea,
  -- The vendor session ends by itself then: the smaller of the call's time left and the person's video minutes.
  max_seconds        integer NOT NULL,
  -- Seconds billed into the usage ledger so far (the metering moves it and writes the ledger in one transaction).
  metered_seconds    integer NOT NULL DEFAULT 0,
  started_at         timestamptz NOT NULL DEFAULT now(),
  ended_at           timestamptz,
  end_reason         text,
  -- The unit (call_speech key) the face is saying: only its next part is taken; null after barge-in.
  speaking_unit      text,
  CONSTRAINT call_faces_vendor_check CHECK (vendor IN ('heygen', 'fake')),
  CONSTRAINT call_faces_session_check CHECK (length(session_ref) BETWEEN 1 AND 200),
  CONSTRAINT call_faces_speaking_check CHECK (speaking_unit IS NULL OR length(speaking_unit) BETWEEN 1 AND 120),
  CONSTRAINT call_faces_seconds_check
    CHECK (max_seconds BETWEEN 0 AND 14400 AND metered_seconds BETWEEN 0 AND max_seconds),
  CONSTRAINT call_faces_end_check CHECK (
    (ended_at IS NULL AND end_reason IS NULL)
    OR (ended_at IS NOT NULL AND end_reason ~ '^[a-z][a-z_]{0,39}$' AND control_ciphertext IS NULL))
);
-- Video minutes of a person this month.
CREATE INDEX IF NOT EXISTS call_faces_starter_started_idx ON call_faces (started_by, started_at);
ALTER TABLE call_faces ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON call_faces FROM app_rls;

-- Whatever ends a call (hang-up, a server stop, the reaper) ends its face and erases the control channel. The face's
-- seconds up to that end are billed by the metering (the API right after, or the daily maintenance), which moves
-- metered_seconds and writes the usage ledger together: the trigger never moves it, or the tail would go unbilled.
CREATE OR REPLACE FUNCTION app.calls_end_face() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE call_faces f
     SET ended_at = greatest(f.started_at, coalesce(NEW.ended_at, now())), end_reason = 'call_ended',
         control_ciphertext = NULL, speaking_unit = NULL
   WHERE f.call_id = NEW.id AND f.ended_at IS NULL;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.calls_end_face() FROM PUBLIC;
DROP TRIGGER IF EXISTS calls_end_face ON calls;
CREATE TRIGGER calls_end_face AFTER UPDATE OF status ON calls
  FOR EACH ROW WHEN (NEW.status = 'ended' AND OLD.status = 'live')
  EXECUTE FUNCTION app.calls_end_face();

-- ---------------------------------------------------------------------------------------------------
-- 4. Units handed to a call's face
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE call_speech ADD COLUMN IF NOT EXISTS face_plays integer NOT NULL DEFAULT 0;
ALTER TABLE call_speech DROP CONSTRAINT IF EXISTS call_speech_face_plays_check;
ALTER TABLE call_speech ADD CONSTRAINT call_speech_face_plays_check CHECK (face_plays BETWEEN 0 AND 100);
-- The next one-second chunk of the unit the face may take (a unit is at most 90 chunks: 600 characters).
ALTER TABLE call_speech ADD COLUMN IF NOT EXISTS face_next_chunk integer NOT NULL DEFAULT 0;
ALTER TABLE call_speech DROP CONSTRAINT IF EXISTS call_speech_face_next_chunk_check;
ALTER TABLE call_speech ADD CONSTRAINT call_speech_face_next_chunk_check CHECK (face_next_chunk BETWEEN 0 AND 90);

-- ---------------------------------------------------------------------------------------------------
-- 5. Settings
-- ---------------------------------------------------------------------------------------------------

INSERT INTO platform_settings (key, value) VALUES
  ('faces_enabled', 'false'),
  ('cloned_voice_enabled', 'false'),
  ('face_minutes_per_principal_month', '60'),
  ('face_minutes_per_call', '20')
ON CONFLICT (key) DO NOTHING;
