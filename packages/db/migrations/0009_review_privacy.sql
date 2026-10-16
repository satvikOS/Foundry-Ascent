-- Foundry Ascent — privacy, turn-engine and distillation fixes from the review of 5105c40.
-- Applied on top of 0001–0008, which are never edited here. Expand-only: code written for the previous schema
-- keeps working. Every statement is re-runnable (CREATE OR REPLACE, DROP … IF EXISTS before CREATE).
--
--  1. A turn is never stored on a deleted conversation. A BEFORE INSERT trigger locks the conversation the way
--     deleting it does, so a turn admitted while a delete is committing waits for it and is then refused; the
--     trigger that moves a conversation's last activity skips deleted ones, and titles a conversation only from
--     a message that is neither a crisis nor high-risk (the client shows its default title until then).
--  2. Deleting a conversation clears what the founder heard of every reply (`heard_text`) explicitly, whether or
--     not the turn's words change (0008's trigger clears it only when they do). It also purges the stored
--     idempotent responses that carry what it erases without naming the conversation: the AI memory proposals
--     drawn from it (a review or batch response holds their text) and the conversations whose copy of its
--     opener is cleared (their start response holds the opener), as app.soft_delete_memory does.
--  3. Openers of unknown origin are erased. A conversation records whether a person wrote the opener it copied
--     (`opener_by_person`); a copy that has neither a source conversation nor that mark is of unknown origin
--     (a legacy notebook opener), and deleting any conversation of the venture clears it, as it clears a
--     notebook opener of unknown origin in every notebook of the venture. Over-erasing is harmless: the next
--     distillation writes a new opener, and a conversation that already started keeps its turns.

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

-- ---------------------------------------------------------------------------------------------------
-- 2. Deleting a conversation (and 3. openers of unknown origin)
-- ---------------------------------------------------------------------------------------------------

-- Whether a person wrote the opener a conversation copied (the notebook's `nextOpenerSource` was null). A copy
-- with no source conversation and without this mark is of unknown origin. Existing rows hold false: their
-- origin is unknown, and erasing such a copy is harmless.
ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS opener_by_person boolean NOT NULL DEFAULT false;
ALTER TABLE coaching_sessions DROP CONSTRAINT IF EXISTS coaching_sessions_opener_origin_check;
ALTER TABLE coaching_sessions ADD CONSTRAINT coaching_sessions_opener_origin_check
  CHECK (NOT opener_by_person OR opener_source_session_id IS NULL) NOT VALID;

-- 0005's function, which erases what the vEIR drew from a conversation when it is deleted, with two changes:
-- stored idempotent responses that carry an erased AI proposal are purged (they hold its title and content and
-- need not name the conversation), and a notebook opener of unknown origin is cleared in every notebook of the
-- venture (it may carry any of its conversations). Internal (no grant): its callers authorize. It erases:
--   - AI memory proposals drawn from it that no person kept (pending, rejected or expired);
--   - escalations drawn from it that the founder never shared: open ones are withdrawn, and the packet (their
--     question verbatim) is erased. A shared one went to a person with the founder's consent and stays;
--   - notebook lines sourced from it;
--   - the notebook summary and opener when they were drawn from it. A missing `summarySources` or
--     `nextOpenerSource` key means their origin is unknown; `[]` or null means no conversation (a person wrote
--     them). A summary of unknown origin is cleared when the conversation was distilled or a notebook line
--     cites it (in that persona's notebook only); an opener of unknown origin always (any notebook of the
--     venture): it may carry the conversation, and the next distillation writes a new one.
-- `p_actor` (the person who deleted the conversation) is recorded in the history of the erased proposals.
CREATE OR REPLACE FUNCTION app.erase_drawn_from_session(p_session uuid, p_actor uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s           coaching_sessions%ROWTYPE;
  v_turns     uuid[];
  v_mem       uuid[];
  v_persona   uuid;
  v_distilled boolean;
  v_id        jsonb := to_jsonb(p_session::text);
BEGIN
  SELECT * INTO s FROM coaching_sessions WHERE id = p_session;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT r.persona_id INTO v_persona FROM persona_releases r WHERE r.id = s.persona_release_id;
  v_distilled := s.distilled_at IS NOT NULL OR s.distill_version > 0;
  SELECT coalesce(array_agg(t.id), '{}') INTO v_turns FROM turns t WHERE t.session_id = p_session;

  -- AI proposals drawn from this conversation that no person kept.
  SELECT coalesce(array_agg(m.id), '{}') INTO v_mem FROM memory_objects m
   WHERE m.venture_id = s.venture_id AND m.origin = 'ai' AND m.status IN ('proposed', 'rejected', 'expired')
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.source_refs) = 'array'
                                               THEN m.source_refs ELSE '[]'::jsonb END) AS r (ref)
       WHERE (r.ref ->> 'kind' = 'session' AND r.ref ->> 'id' = p_session::text)
          OR (r.ref ->> 'kind' = 'turn' AND (r.ref ->> 'id') = ANY (SELECT x::text FROM unnest(v_turns) AS x)));
  UPDATE memory_objects
     SET status = 'deleted', title = '[deleted]', content = '', attributes = '{}'::jsonb,
         source_refs = '[]'::jsonb, embedding = NULL, pinned = false, updated_at = now()
   WHERE id = ANY (v_mem);
  UPDATE memory_events SET diff = '{"redacted": true}'::jsonb WHERE memory_id = ANY (v_mem);
  UPDATE turn_evidence SET title = '[deleted]' WHERE kind = 'memory' AND ref_id = ANY (v_mem);
  INSERT INTO memory_events (memory_id, venture_id, actor_id, action, diff)
  SELECT x, s.venture_id, coalesce(p_actor, s.started_by), 'deleted', '{"conversationDeleted": true}'::jsonb
  FROM unnest(v_mem) AS x;
  DELETE FROM idempotency_keys k
   WHERE EXISTS (SELECT 1 FROM unnest(v_mem) AS v (id) WHERE strpos(k.response::text, v.id::text) > 0);

  -- Escalations the founder never shared.
  UPDATE escalations e
     SET status = CASE WHEN e.status IN ('draft', 'awaiting_consent') THEN 'withdrawn' ELSE e.status END,
         packet = jsonb_build_object(
           'founderQuestion', '[deleted conversation]', 'desiredDecision', NULL, 'sharedFacts', '[]'::jsonb,
           'evidenceConsidered', '[]'::jsonb, 'conflictingSignals', '[]'::jsonb, 'unknowns', '[]'::jsonb,
           'reason', '[deleted conversation]',
           'urgency', CASE WHEN jsonb_typeof(e.packet -> 'urgency') = 'string' THEN e.packet -> 'urgency'
                           ELSE '""'::jsonb END,
           'proposedNextStep', NULL, 'sessionSummary', NULL, 'aiGenerated', true),
         updated_at = now()
   WHERE e.venture_id = s.venture_id AND e.sharing_consent_at IS NULL
     AND (e.session_id = p_session OR e.turn_id = ANY (v_turns))
     AND (e.status IN ('draft', 'awaiting_consent')
          OR e.packet ->> 'founderQuestion' IS DISTINCT FROM '[deleted conversation]');

  -- Notebook lines sourced from this conversation, and a summary or opener drawn from it.
  UPDATE veir_notebooks n
     SET content = n.content
           || jsonb_build_object(
                'founderProfile', (SELECT coalesce(jsonb_agg(e.item ORDER BY e.i), '[]'::jsonb)
                                   FROM jsonb_array_elements(n.content -> 'founderProfile') WITH ORDINALITY AS e (item, i)
                                   WHERE e.item ->> 'sourceSessionId' IS DISTINCT FROM p_session::text),
                'commitments', (SELECT coalesce(jsonb_agg(e.item ORDER BY e.i), '[]'::jsonb)
                                FROM jsonb_array_elements(n.content -> 'commitments') WITH ORDINALITY AS e (item, i)
                                WHERE e.item ->> 'sourceSessionId' IS DISTINCT FROM p_session::text),
                'openQuestions', (SELECT coalesce(jsonb_agg(e.item ORDER BY e.i), '[]'::jsonb)
                                  FROM jsonb_array_elements(n.content -> 'openQuestions') WITH ORDINALITY AS e (item, i)
                                  WHERE e.item ->> 'sourceSessionId' IS DISTINCT FROM p_session::text),
                'lastAdvice', (SELECT coalesce(jsonb_agg(e.item ORDER BY e.i), '[]'::jsonb)
                               FROM jsonb_array_elements(n.content -> 'lastAdvice') WITH ORDINALITY AS e (item, i)
                               WHERE e.item ->> 'sourceSessionId' IS DISTINCT FROM p_session::text))
           || CASE WHEN x.clear_summary THEN '{"summary": "", "summarySources": []}'::jsonb ELSE '{}'::jsonb END
           || CASE WHEN x.clear_opener THEN '{"nextOpener": null, "nextOpenerSource": null}'::jsonb
                   ELSE '{}'::jsonb END,
         version = n.version + 1, last_edited_by = 'person', last_edited_principal = p_actor, updated_at = now()
    FROM (SELECT c.id, c.cites,
                 c.summary <> ''
                   AND (coalesce(c.summary_sources @> jsonb_build_array(v_id), false)
                        OR (c.summary_sources IS NULL AND c.own AND (v_distilled OR c.cites))) AS clear_summary,
                 c.opener IS NOT NULL
                   AND (c.opener_source IS NOT DISTINCT FROM v_id OR c.opener_source IS NULL) AS clear_opener
            FROM (SELECT nb.id, nb.content ->> 'summary' AS summary, nb.content ->> 'nextOpener' AS opener,
                         -- SQL NULL when the key is missing (unknown); a JSON array or JSON null when known.
                         CASE WHEN jsonb_typeof(nb.content -> 'summarySources') = 'array'
                              THEN nb.content -> 'summarySources' END AS summary_sources,
                         nb.content -> 'nextOpenerSource' AS opener_source,
                         nb.persona_id IS NOT DISTINCT FROM v_persona AS own,
                         EXISTS (SELECT 1 FROM jsonb_each(nb.content) AS sec (k, v)
                                 WHERE jsonb_typeof(sec.v) = 'array'
                                   AND EXISTS (SELECT 1 FROM jsonb_array_elements(sec.v) AS e (item)
                                               WHERE jsonb_typeof(e.item) = 'object'
                                                 AND e.item ->> 'sourceSessionId' = p_session::text)) AS cites
                    FROM veir_notebooks nb WHERE nb.venture_id = s.venture_id) AS c) AS x
   WHERE n.id = x.id AND (x.cites OR x.clear_summary OR x.clear_opener);
END
$$;
REVOKE ALL ON FUNCTION app.erase_drawn_from_session(uuid, uuid) FROM PUBLIC;

-- 0006's trigger with two additions: the venture's copies of an opener of unknown origin are cleared too (they
-- may come from the deleted conversation), and the stored idempotent responses that mention a conversation
-- whose copy is cleared are purged (a start response holds the opener).
CREATE OR REPLACE FUNCTION app.sessions_erase_opener_copies() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_cleared uuid[];
BEGIN
  WITH cleared AS (
    UPDATE coaching_sessions SET opener = NULL, opener_source_session_id = NULL, opener_by_person = false
     WHERE venture_id = NEW.venture_id AND id <> NEW.id AND opener IS NOT NULL
       AND (opener_source_session_id = NEW.id OR (opener_source_session_id IS NULL AND NOT opener_by_person))
    RETURNING id)
  SELECT coalesce(array_agg(cleared.id), '{}') INTO v_cleared FROM cleared;
  DELETE FROM idempotency_keys k
   WHERE EXISTS (SELECT 1 FROM unnest(v_cleared) AS c (id) WHERE strpos(k.response::text, c.id::text) > 0);
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.sessions_erase_opener_copies() FROM PUBLIC;

-- 0005's function with one change: what the founder heard of a reply (`heard_text`) is cleared with the turn's
-- other words even when they were already redacted (turns_redact_heard fires only when they change), so a
-- barge-in recorded while an earlier erasure was committing is erased too.
CREATE OR REPLACE FUNCTION app.soft_delete_session(p_session uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s       coaching_sessions%ROWTYPE;
  v_turns uuid[];
BEGIN
  SELECT * INTO s FROM coaching_sessions WHERE id = p_session AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR NOT app.in_current_tenant(s.tenant_id)
     OR NOT (app.can_write_venture(s.venture_id) OR app.is_assigned_eir(s.venture_id)) THEN
    RETURN false;
  END IF;
  IF NOT app.can_write_venture(s.venture_id) THEN
    RAISE EXCEPTION 'deleting a conversation requires founder or team membership' USING ERRCODE = '42501';
  END IF;

  PERFORM app.erase_drawn_from_session(p_session, app.current_principal());

  SELECT coalesce(array_agg(t.id), '{}') INTO v_turns FROM turns t WHERE t.session_id = p_session;
  UPDATE turns SET status = 'failed', completed_at = coalesce(completed_at, now())
   WHERE session_id = p_session AND status = 'pending';
  UPDATE turns SET founder_text = '[deleted conversation]', response = NULL, heard_text = NULL,
                   sampled_for_review = false
   WHERE session_id = p_session;
  UPDATE feedback SET comment = NULL WHERE turn_id = ANY (v_turns) AND comment IS NOT NULL;

  DELETE FROM idempotency_keys WHERE strpos(response::text, p_session::text) > 0;
  UPDATE coaching_sessions
     SET deleted_at = now(), status = 'ended', ended_at = coalesce(ended_at, now()), title = NULL, goal = NULL,
         recap = NULL, digest = NULL
   WHERE id = p_session;
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION app.soft_delete_session(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.soft_delete_session(uuid) TO app_rls;
