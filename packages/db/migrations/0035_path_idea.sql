-- Foundry Ascent — the founder's idea in their own words, and what they changed it from (founder path).
-- Applied on top of 0001–0034; expand-only: nothing an older build reads or writes changes, and every statement is
-- re-runnable (ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE). Grants and row-level security are the table's own (0033).
--
--  1. venture_paths.idea_session_id: the conversation the idea in the intake was said in (null: typed in the intake).
--  2. venture_paths.pivots: each change of the idea, oldest first: {on, from, to, sessionId}, the founder's own words.
--     A change of direction also re-opens what the old customer had shown (path_criteria), and may move the stage back.
--  3. path_steps.given_session_id: the conversation a step in the founder's own words was said in (what they said they
--     would do; program steps have none).
--  4. A deleted conversation takes those words too (app.path_follow_session, 0033).

ALTER TABLE venture_paths ADD COLUMN IF NOT EXISTS idea_session_id uuid REFERENCES coaching_sessions (id);
ALTER TABLE venture_paths ADD COLUMN IF NOT EXISTS pivots jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE venture_paths DROP CONSTRAINT IF EXISTS venture_paths_pivots_check;
ALTER TABLE venture_paths ADD CONSTRAINT venture_paths_pivots_check
  CHECK (jsonb_typeof(pivots) = 'array' AND jsonb_array_length(pivots) <= 20);
CREATE INDEX IF NOT EXISTS venture_paths_idea_session_idx ON venture_paths (idea_session_id)
  WHERE idea_session_id IS NOT NULL;

ALTER TABLE path_steps ADD COLUMN IF NOT EXISTS given_session_id uuid REFERENCES coaching_sessions (id);
CREATE INDEX IF NOT EXISTS path_steps_given_session_idx ON path_steps (given_session_id)
  WHERE given_session_id IS NOT NULL;

-- A deleted conversation takes the words the path kept from it (what was done stays done, that the idea changed stays
-- dated): SECURITY DEFINER, as in 0033.
CREATE OR REPLACE FUNCTION app.path_follow_session() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE path_steps SET evidence = NULL, reason = NULL, source_session_id = NULL, updated_at = now()
   WHERE source_session_id = NEW.id;
  UPDATE path_criteria SET evidence = NULL, source_session_id = NULL, updated_at = now()
   WHERE source_session_id = NEW.id;
  UPDATE path_steps SET title = 'A step you set', items = '[]'::jsonb, done_when = 'It is done.',
         given_session_id = NULL, updated_at = now()
   WHERE given_session_id = NEW.id AND origin = 'founder';
  UPDATE venture_paths
     SET intake = jsonb_set(intake, '{idea}', '""'::jsonb), idea_session_id = NULL, version = version + 1,
         updated_at = now()
   WHERE idea_session_id = NEW.id AND intake IS NOT NULL;
  UPDATE venture_paths
     SET pivots = (SELECT coalesce(jsonb_agg(
                            CASE WHEN e.value ->> 'sessionId' = NEW.id::text
                                 THEN e.value || '{"from": "", "to": "", "sessionId": null}'::jsonb
                                 ELSE e.value END ORDER BY e.ordinality), '[]'::jsonb)
                   FROM jsonb_array_elements(pivots) WITH ORDINALITY e),
         updated_at = now()
   WHERE pivots @> jsonb_build_array(jsonb_build_object('sessionId', NEW.id::text));
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.path_follow_session() FROM PUBLIC;
