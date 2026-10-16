-- Foundry Ascent — turn engine: streamed answers, conversation openers, spend-cap defaults.
-- Applied on top of 0001–0005, which are never edited here.
--
-- Every statement is re-runnable (ADD COLUMN IF NOT EXISTS, DROP … IF EXISTS before CREATE, CREATE OR REPLACE,
-- guarded updates, ON CONFLICT DO NOTHING) and expand-only: code written for the previous schema keeps working.
--
--  1. Conversations open with the vEIR's line: `coaching_sessions.opener` is the notebook's next opener, validated
--     and copied when a standard conversation starts. Temporary chats never have one; a deleted conversation
--     loses it with the rest of its content.
--  2. Turns record how long the founder waited for the first validated sentence of a streamed answer
--     (`turns.first_token_ms`, measured from the moment the turn request reached the turn engine).
--  3. Spend caps: the defaults rise to $15 per UTC day for the platform and $1 per person, only where the stored
--     value is still the old default ($2 and $0.50); a value an administrator chose is left alone.
--  4. Kill switches for streamed replies and for calls, on by default (the AI kill switch still stops both).
--
-- The CHECK constraints on the new columns are added NOT VALID: every existing row holds NULL there, so the
-- scan a validated constraint makes (under the ACCESS EXCLUSIVE lock this transaction holds until it commits)
-- would prove nothing. Every insert and update after it is checked as usual.

-- ---------------------------------------------------------------------------------------------------
-- 1. Conversation openers
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS opener text;
ALTER TABLE coaching_sessions DROP CONSTRAINT IF EXISTS coaching_sessions_opener_check;
ALTER TABLE coaching_sessions ADD CONSTRAINT coaching_sessions_opener_check
  CHECK (opener IS NULL OR (length(opener) BETWEEN 1 AND 300 AND privacy = 'standard')) NOT VALID;

-- Deleting a conversation erases its content; the opener goes with it, whichever code path sets deleted_at.
CREATE OR REPLACE FUNCTION app.sessions_clear_opener() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  NEW.opener := NULL;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.sessions_clear_opener() FROM PUBLIC;
DROP TRIGGER IF EXISTS sessions_clear_opener ON coaching_sessions;
CREATE TRIGGER sessions_clear_opener BEFORE UPDATE OF deleted_at ON coaching_sessions
  FOR EACH ROW WHEN (NEW.deleted_at IS NOT NULL AND NEW.opener IS NOT NULL)
  EXECUTE FUNCTION app.sessions_clear_opener();

-- ---------------------------------------------------------------------------------------------------
-- 2. Time to the first streamed sentence
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE turns ADD COLUMN IF NOT EXISTS first_token_ms integer;
ALTER TABLE turns DROP CONSTRAINT IF EXISTS turns_first_token_ms_check;
ALTER TABLE turns ADD CONSTRAINT turns_first_token_ms_check
  CHECK (first_token_ms IS NULL OR first_token_ms >= 0) NOT VALID;

-- ---------------------------------------------------------------------------------------------------
-- 3. Spend-cap defaults (only where the stored value is still the old default)
-- ---------------------------------------------------------------------------------------------------

UPDATE platform_settings
   SET value = '15'::jsonb, updated_at = now()
 WHERE key = 'daily_usd_cap_global'
   AND CASE jsonb_typeof(value)
         WHEN 'number' THEN (value)::numeric = 2
         WHEN 'string' THEN (value #>> '{}') ~ '^\s*2(\.0*)?\s*$'
         ELSE false
       END;

UPDATE platform_settings
   SET value = '1'::jsonb, updated_at = now()
 WHERE key = 'daily_usd_cap_per_principal'
   AND CASE jsonb_typeof(value)
         WHEN 'number' THEN (value)::numeric = 0.5
         WHEN 'string' THEN (value #>> '{}') ~ '^\s*0?\.50*\s*$'
         ELSE false
       END;

-- ---------------------------------------------------------------------------------------------------
-- 4. Kill switches for streamed replies and calls
-- ---------------------------------------------------------------------------------------------------

INSERT INTO platform_settings (key, value) VALUES
  ('streaming_enabled', 'true'),
  ('calls_enabled', 'true')
ON CONFLICT (key) DO NOTHING;
