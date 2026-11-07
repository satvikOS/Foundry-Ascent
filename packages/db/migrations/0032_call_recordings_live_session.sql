-- Foundry Ascent — a recording is never added to a conversation being deleted (ADR-0023, docs/architecture/calls.md §7).
-- Applied on top of 0001–0031 (there is no 0014); expand-only: nothing an older build reads or writes changes, and every
-- statement is re-runnable (CREATE OR REPLACE, DROP … IF EXISTS before CREATE).
--
-- 0031's insert policy reads coaching_sessions.deleted_at without a lock, and its follow-session trigger deletes only
-- the recordings that exist when it runs. Under READ COMMITTED, a recording inserted while a delete of its conversation
-- is still uncommitted passes the policy (it sees the row before the delete), and the delete's trigger cannot see the
-- uncommitted insert: a live recording would be left in a deleted conversation, listed and kept for a year. This locks
-- the conversation row as app.soft_delete_session does (it takes FOR UPDATE first), so the two serialise, exactly as
-- 0009's turns_require_live_session does for turns: an insert that comes while a delete is in flight waits, then sees
-- the conversation deleted and is refused (55000, a conflict to the API); a delete that comes after the insert waits
-- for it, and its trigger then deletes the new recording with the rest. Owner role: RLS hides deleted conversations,
-- which must be seen here.

CREATE OR REPLACE FUNCTION app.call_recordings_require_live_session() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_deleted timestamptz;
BEGIN
  SELECT s.deleted_at INTO v_deleted FROM coaching_sessions s WHERE s.id = NEW.session_id FOR NO KEY UPDATE;
  IF NOT FOUND OR v_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'a recording cannot be added to a deleted conversation' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.call_recordings_require_live_session() FROM PUBLIC;
DROP TRIGGER IF EXISTS call_recordings_require_live_session ON call_recordings;
CREATE TRIGGER call_recordings_require_live_session BEFORE INSERT ON call_recordings
  FOR EACH ROW EXECUTE FUNCTION app.call_recordings_require_live_session();
