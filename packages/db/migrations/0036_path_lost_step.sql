-- Foundry Ascent — a step whose words went with their conversation is not a step any more (founder path).
-- Applied on top of 0001–0035; expand-only and re-runnable: the trigger function of 0035 with one column more, and the
-- rows it left open before.
--
-- A step in the founder's own words loses them when the conversation they were said in is deleted. It stayed the next
-- step, with nothing in it to do; it is closed instead, and the path goes on from the step before it.

UPDATE path_steps SET status = 'skipped', updated_at = now()
 WHERE origin = 'founder' AND title = 'A step you set' AND items = '[]'::jsonb AND given_session_id IS NULL
   AND status IN ('now', 'next', 'later', 'blocked');

CREATE OR REPLACE FUNCTION app.path_follow_session() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE path_steps SET evidence = NULL, reason = NULL, source_session_id = NULL, updated_at = now()
   WHERE source_session_id = NEW.id;
  UPDATE path_criteria SET evidence = NULL, source_session_id = NULL, updated_at = now()
   WHERE source_session_id = NEW.id;
  UPDATE path_steps SET title = 'A step you set', items = '[]'::jsonb, done_when = 'It is done.',
         status = CASE WHEN status = 'done' THEN status ELSE 'skipped' END,
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
