-- Foundry Ascent — privacy, turn-engine and distillation fixes from the review of 5105c40.
-- Applied on top of 0001–0008, which are never edited here. Expand-only: code written for the previous schema
-- keeps working. Every statement is re-runnable (CREATE OR REPLACE, DROP … IF EXISTS before CREATE).
--
--  1. A turn is never stored on a deleted conversation. A BEFORE INSERT trigger locks the conversation the way
--     deleting it does, so a turn admitted while a delete is committing waits for it and is then refused; the
--     trigger that moves a conversation's last activity skips deleted ones, and titles a conversation only from
--     a message that is neither a crisis nor high-risk (the client shows its default title until then).

-- ---------------------------------------------------------------------------------------------------
-- 1. Turns of deleted conversations, and titles from risky messages
-- ---------------------------------------------------------------------------------------------------

-- Locks the conversation row as app.soft_delete_session does (it takes FOR UPDATE first), so the two serialise:
-- a turn inserted while a delete is in flight waits, then sees the conversation deleted and is refused. The
-- lock is the one the insert's own trigger (turns_touch_session) takes anyway, so it adds no contention. Owner
-- role: RLS hides deleted conversations, which must be seen here.
CREATE OR REPLACE FUNCTION app.turns_require_live_session() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_deleted timestamptz;
BEGIN
  SELECT s.deleted_at INTO v_deleted FROM coaching_sessions s WHERE s.id = NEW.session_id FOR NO KEY UPDATE;
  IF v_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'a turn cannot be added to a deleted conversation' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.turns_require_live_session() FROM PUBLIC;
DROP TRIGGER IF EXISTS turns_require_live_session ON turns;
CREATE TRIGGER turns_require_live_session BEFORE INSERT ON turns
  FOR EACH ROW EXECUTE FUNCTION app.turns_require_live_session();

-- 0004's function with two changes: a deleted conversation is never touched (no activity, no title), and the
-- title comes from the first message that is neither a crisis nor high-risk (`risk_label` 'crisis' or 'high'):
-- the founder's words about their wellbeing, a legal threat or a medical question never name the conversation
-- in every list. Until such a message, the conversation keeps no title and the client shows its default.
CREATE OR REPLACE FUNCTION app.turns_touch_session() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE coaching_sessions s
     SET last_activity_at = greatest(s.last_activity_at, NEW.created_at),
         has_calls = s.has_calls OR NEW.channel = 'voice',
         title = CASE
                   WHEN s.title IS NULL AND s.privacy = 'standard'
                        AND coalesce(NEW.risk_label, 'none') NOT IN ('crisis', 'high')
                     THEN app.conversation_title(NEW.founder_text)
                   ELSE s.title
                 END
   WHERE s.id = NEW.session_id AND s.deleted_at IS NULL;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.turns_touch_session() FROM PUBLIC;
