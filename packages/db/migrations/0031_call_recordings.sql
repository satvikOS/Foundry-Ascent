-- Foundry Ascent — call recordings (ADR-0023, docs/architecture/calls.md §7).
-- Applied on top of 0001–0030 (there is no 0014); expand-only: nothing an older build reads or writes changes, and
-- every statement is re-runnable (IF NOT EXISTS, CREATE OR REPLACE, DROP … IF EXISTS before CREATE).
--
--  1. call_recordings: a recording a founder made of one of their own calls, kept so they can watch it again without
--     calling the vEIR. The browser records the call itself (the vEIR's face or the call's presence, both voices, and
--     the captions as a timed transcript) and uploads the files straight to the private recordings bucket with
--     presigned URLs the API issues after checking the call is the caller's own; the row holds the object keys,
--     sizes, duration and lifecycle (pending → ready, then deleted and purged), never content. Seen and changed only
--     by the person who recorded it: no team member, EIR or platform admin reads anyone else's recordings.
--     A private (temporary) conversation is never recorded: the insert policy refuses it. A recording is kept for a
--     year (the daily maintenance deletes older ones; the bucket's lifecycle is the backstop).
--  2. Deleting a conversation deletes its recordings (trigger on coaching_sessions.deleted_at): the rows are marked
--     deleted in the same transaction, and the API (at once) and the daily maintenance (any it missed) delete the
--     files from the bucket and mark the rows purged.

-- ---------------------------------------------------------------------------------------------------
-- 1. Recordings
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS call_recordings (
  -- Chosen by the API (the object keys carry it).
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  venture_id      uuid NOT NULL REFERENCES ventures (id),
  session_id      uuid NOT NULL REFERENCES coaching_sessions (id),
  call_id         uuid NOT NULL REFERENCES calls (id),
  recorded_by     uuid NOT NULL REFERENCES principals (id),
  -- The container the browser recorded (webm on Chromium and Firefox, mp4 on Safari); video unless the browser
  -- could only record sound.
  mime_type       text NOT NULL,
  bytes           integer NOT NULL,
  duration_ms     integer NOT NULL,
  -- tenants/{tenant}/ventures/{venture}/sessions/{session}/recordings/{id}/call.{webm|mp4}
  storage_key     text NOT NULL,
  -- The captions as WebVTT beside it (null: nobody said anything while it recorded).
  captions_key    text,
  captions_bytes  integer,
  -- How many caption cues the transcript holds (a count, never words).
  cues            integer NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'pending',
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  deleted_at      timestamptz,
  -- founder (they deleted it), conversation (its conversation was deleted), abandoned (the upload never finished),
  -- expired (kept as long as recordings are, RECORDING_LIMITS.retentionDays)
  deleted_reason  text,
  -- The files were removed from the bucket.
  purged_at       timestamptz,
  CONSTRAINT call_recordings_mime_check CHECK (mime_type IN ('video/webm', 'video/mp4', 'audio/webm', 'audio/mp4')),
  CONSTRAINT call_recordings_bytes_check CHECK (bytes BETWEEN 1 AND 1073741824),
  CONSTRAINT call_recordings_duration_check CHECK (duration_ms BETWEEN 1 AND 14460000),
  CONSTRAINT call_recordings_key_check CHECK (
    length(storage_key) BETWEEN 1 AND 512 AND storage_key LIKE 'tenants/%'
    AND (captions_key IS NULL OR (length(captions_key) BETWEEN 1 AND 512 AND captions_key LIKE 'tenants/%'))),
  CONSTRAINT call_recordings_captions_check CHECK (
    (captions_key IS NULL AND captions_bytes IS NULL AND cues = 0)
    OR (captions_key IS NOT NULL AND captions_bytes BETWEEN 1 AND 4194304 AND cues BETWEEN 1 AND 100000)),
  CONSTRAINT call_recordings_status_check CHECK (
    (status = 'pending' AND completed_at IS NULL) OR (status = 'ready' AND completed_at IS NOT NULL)),
  CONSTRAINT call_recordings_deleted_check CHECK (
    (deleted_at IS NULL AND deleted_reason IS NULL AND purged_at IS NULL)
    OR (deleted_at IS NOT NULL AND deleted_reason IN ('founder', 'conversation', 'abandoned', 'expired')
        AND (purged_at IS NULL OR purged_at >= deleted_at)))
);

-- A conversation's recordings and a person's recordings, latest first (deleted ones are never listed).
CREATE INDEX IF NOT EXISTS call_recordings_session_idx
  ON call_recordings (session_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS call_recordings_owner_idx
  ON call_recordings (recorded_by, created_at DESC) WHERE deleted_at IS NULL;
-- Files still to remove from the bucket, and uploads nobody finished.
CREATE INDEX IF NOT EXISTS call_recordings_purge_idx
  ON call_recordings (deleted_at) WHERE deleted_at IS NOT NULL AND purged_at IS NULL;
CREATE INDEX IF NOT EXISTS call_recordings_pending_idx
  ON call_recordings (created_at) WHERE status = 'pending' AND deleted_at IS NULL;

-- A recording's identity, files and size never change; a ready recording stays ready; a deleted one stays deleted.
CREATE OR REPLACE FUNCTION app.call_recordings_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.venture_id <> OLD.venture_id
     OR NEW.session_id <> OLD.session_id OR NEW.call_id <> OLD.call_id OR NEW.recorded_by <> OLD.recorded_by
     OR NEW.mime_type <> OLD.mime_type OR NEW.bytes <> OLD.bytes OR NEW.duration_ms <> OLD.duration_ms
     OR NEW.storage_key <> OLD.storage_key OR NEW.captions_key IS DISTINCT FROM OLD.captions_key
     OR NEW.captions_bytes IS DISTINCT FROM OLD.captions_bytes OR NEW.cues <> OLD.cues THEN
    RAISE EXCEPTION 'a recording''s identity and files never change' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'ready' AND NEW.status <> 'ready' THEN
    RAISE EXCEPTION 'a ready recording stays ready' USING ERRCODE = '55000';
  END IF;
  IF OLD.deleted_at IS NOT NULL AND (NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
                                     OR NEW.deleted_reason IS DISTINCT FROM OLD.deleted_reason
                                     OR NEW.status <> OLD.status) THEN
    RAISE EXCEPTION 'a deleted recording stays deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD.purged_at IS NOT NULL AND NEW.purged_at IS DISTINCT FROM OLD.purged_at THEN
    RAISE EXCEPTION 'a purged recording stays purged' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.call_recordings_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS call_recordings_guard ON call_recordings;
CREATE TRIGGER call_recordings_guard BEFORE UPDATE ON call_recordings
  FOR EACH ROW EXECUTE FUNCTION app.call_recordings_guard();

GRANT SELECT, INSERT, UPDATE ON call_recordings TO app_rls;
ALTER TABLE call_recordings ENABLE ROW LEVEL SECURITY;

-- Only the person who recorded it: not the venture's team, not its EIR, not a platform admin.
DROP POLICY IF EXISTS call_recordings_read ON call_recordings;
CREATE POLICY call_recordings_read ON call_recordings FOR SELECT TO app_rls
  USING (app.in_current_tenant(tenant_id) AND recorded_by = app.current_principal());
-- A person records their own call, in a remembered (standard) conversation that still exists, as themselves.
DROP POLICY IF EXISTS call_recordings_insert ON call_recordings;
CREATE POLICY call_recordings_insert ON call_recordings FOR INSERT TO app_rls
  WITH CHECK (app.in_current_tenant(tenant_id) AND recorded_by = app.current_principal()
              AND status = 'pending' AND deleted_at IS NULL
              AND EXISTS (SELECT 1 FROM calls c
                          WHERE c.id = call_recordings.call_id AND c.started_by = app.current_principal()
                            AND c.session_id = call_recordings.session_id
                            AND c.venture_id = call_recordings.venture_id AND c.tenant_id = call_recordings.tenant_id)
              AND EXISTS (SELECT 1 FROM coaching_sessions s
                          WHERE s.id = call_recordings.session_id AND s.privacy = 'standard'
                            AND s.deleted_at IS NULL));
DROP POLICY IF EXISTS call_recordings_update ON call_recordings;
CREATE POLICY call_recordings_update ON call_recordings FOR UPDATE TO app_rls
  USING (app.in_current_tenant(tenant_id) AND recorded_by = app.current_principal())
  WITH CHECK (app.in_current_tenant(tenant_id) AND recorded_by = app.current_principal());

-- ---------------------------------------------------------------------------------------------------
-- 2. A deleted conversation takes its recordings with it
-- ---------------------------------------------------------------------------------------------------

-- Whoever deletes the conversation (a founder or team member, app.soft_delete_session), every recording of it is
-- deleted in the same transaction, whoever made it: SECURITY DEFINER, since the deleting person cannot see the
-- recordings of others. The files follow (the API after the commit, the daily maintenance otherwise).
CREATE OR REPLACE FUNCTION app.call_recordings_follow_session() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE call_recordings SET deleted_at = now(), deleted_reason = 'conversation'
   WHERE session_id = NEW.id AND deleted_at IS NULL;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.call_recordings_follow_session() FROM PUBLIC;
DROP TRIGGER IF EXISTS call_recordings_follow_session ON coaching_sessions;
CREATE TRIGGER call_recordings_follow_session AFTER UPDATE OF deleted_at ON coaching_sessions
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION app.call_recordings_follow_session();
