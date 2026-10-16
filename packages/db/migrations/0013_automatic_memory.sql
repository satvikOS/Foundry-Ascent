-- Foundry Ascent — memory the vEIR keeps by itself (owner decision 2026-10-16: no "add to memory" approvals).
-- Applied on top of 0001–0012, which are live and never edited here. Expand-only: code written for the previous
-- schema keeps working (the new column is nullable, the constraint only admits more). Every statement is
-- re-runnable (ADD COLUMN IF NOT EXISTS, DROP … IF EXISTS before ADD, CREATE OR REPLACE, guarded updates).
--
--  1. Automatic memory. What the vEIR learns from a standard conversation is kept at once: an AI item may be
--     `confirmed` (and later disputed or superseded by a person's correction) without a person's approval when
--     it records when it was kept automatically (`auto_kept_at`). The approval CHECK of 0007 is replaced by one
--     that admits exactly that: a model inference is still never durable without either a person's approval or
--     the record that it was kept automatically. Pending AI proposals left from before are kept the same way,
--     with an `approved` history event marked `system` (nobody approved them; it reads "Approved
--     automatically"). EIR proposals (origin `eir`) stay proposals for the founder to accept.
--  2. Deleting a conversation erases what was kept automatically from it. An item kept automatically that no
--     person approved or corrected since, drawn only from that conversation (its session or its turns), is
--     erased like a proposal; one also drawn from other conversations loses that conversation's sources and
--     stays (the others still support it). Everything else app.erase_drawn_from_session erased (0009) it still
--     erases, unchanged.

-- ---------------------------------------------------------------------------------------------------
-- 1. Automatic memory
-- ---------------------------------------------------------------------------------------------------

-- When the vEIR kept the item by itself (null: a person created or approved it, or it is a proposal).
ALTER TABLE memory_objects ADD COLUMN IF NOT EXISTS auto_kept_at timestamptz;

-- No durable memory from a model inference alone (blueprint 02 §5), widened by the owner's decision: an AI item is
-- a proposal, rejected, expired or deleted unless a person approved it or it records that it was kept
-- automatically.
ALTER TABLE memory_objects DROP CONSTRAINT IF EXISTS memory_objects_ai_approval_check;
ALTER TABLE memory_objects ADD CONSTRAINT memory_objects_ai_approval_check
  CHECK (origin <> 'ai' OR status IN ('proposed', 'rejected', 'expired', 'deleted') OR approved_by IS NOT NULL
         OR auto_kept_at IS NOT NULL);

-- Pending AI proposals are kept automatically, with a system event (the actor column names the person the
-- proposal was made for only because every event needs one; `system` says nobody acted).
WITH kept AS (
  UPDATE memory_objects m
     SET status = 'confirmed', auto_kept_at = now(), updated_at = now()
   WHERE m.origin = 'ai' AND m.status = 'proposed'
  RETURNING m.id, m.venture_id, m.created_by)
INSERT INTO memory_events (memory_id, venture_id, actor_id, action, diff)
SELECT kept.id, kept.venture_id, kept.created_by, 'approved',
       '{"to": "confirmed", "system": true, "reason": "kept_automatically"}'::jsonb
  FROM kept;

-- ---------------------------------------------------------------------------------------------------
-- 2. Deleting a conversation erases what was kept automatically from it
-- ---------------------------------------------------------------------------------------------------

-- Whether a source ref names the conversation `p_session` or one of its turns (`p_turns`, as text).
CREATE OR REPLACE FUNCTION app.ref_is_conversation(p_ref jsonb, p_session text, p_turns text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce((p_ref ->> 'kind' = 'session' AND p_ref ->> 'id' = p_session)
                  OR (p_ref ->> 'kind' = 'turn' AND (p_ref ->> 'id') = ANY (p_turns)), false)
$$;
REVOKE ALL ON FUNCTION app.ref_is_conversation(jsonb, text, text[]) FROM PUBLIC;

-- 0009's function, with automatic memory added to what it erases. Internal (no grant): its callers authorize.
-- It erases:
--   - AI memory proposals drawn from it that no person kept (pending, rejected or expired);
--   - AI memory kept automatically that no person approved or corrected since (`approved_by` null), drawn only
--     from it (every conversation source ref names it or its turns); one also drawn from another conversation
--     loses the refs to this one and stays;
--   - escalations drawn from it that the founder never shared: open ones are withdrawn, and the packet (their
--     question verbatim) is erased. A shared one went to a person with the founder's consent and stays;
--   - notebook lines drawn from it (`sourceSessionId`, or among `sourceSessionIds`);
--   - the notebook summary and opener when they were drawn from it. A missing `summarySources` or
--     `nextOpenerSource` key means their origin is unknown; `[]` or null means no conversation (a person wrote
--     them). A summary of unknown origin is cleared when the conversation was distilled or a notebook line
--     cites it (in that persona's notebook only); an opener of unknown origin always (any notebook of the
--     venture): it may carry the conversation, and the next distillation writes a new one.
-- `p_actor` (the person who deleted the conversation) is recorded in the history of the erased items.
CREATE OR REPLACE FUNCTION app.erase_drawn_from_session(p_session uuid, p_actor uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s           coaching_sessions%ROWTYPE;
  v_turns     uuid[];
  v_turn_ids  text[];
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
  SELECT coalesce(array_agg(x::text), '{}') INTO v_turn_ids FROM unnest(v_turns) AS x;

  -- AI proposals drawn from this conversation that no person kept, and memory the vEIR kept by itself from this
  -- conversation alone that no person approved or corrected since.
  SELECT coalesce(array_agg(m.id), '{}') INTO v_mem FROM memory_objects m
   WHERE m.venture_id = s.venture_id AND m.origin = 'ai'
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.source_refs) = 'array'
                                               THEN m.source_refs ELSE '[]'::jsonb END) AS r (ref)
       WHERE app.ref_is_conversation(r.ref, p_session::text, v_turn_ids))
     AND (m.status IN ('proposed', 'rejected', 'expired')
          OR (m.auto_kept_at IS NOT NULL AND m.approved_by IS NULL
              AND m.status IN ('confirmed', 'disputed', 'superseded')
              AND NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements(m.source_refs) AS r (ref)
                WHERE r.ref ->> 'kind' IN ('session', 'turn')
                  AND NOT app.ref_is_conversation(r.ref, p_session::text, v_turn_ids))));
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

  -- Memory kept automatically that other conversations also support: it no longer names this one.
  UPDATE memory_objects m
     SET source_refs = (SELECT coalesce(jsonb_agg(r.ref ORDER BY r.i), '[]'::jsonb)
                          FROM jsonb_array_elements(m.source_refs) WITH ORDINALITY AS r (ref, i)
                         WHERE NOT app.ref_is_conversation(r.ref, p_session::text, v_turn_ids)),
         updated_at = now()
   WHERE m.venture_id = s.venture_id AND m.origin = 'ai' AND m.auto_kept_at IS NOT NULL
     AND m.status <> 'deleted' AND jsonb_typeof(m.source_refs) = 'array'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(m.source_refs) AS r (ref)
                 WHERE app.ref_is_conversation(r.ref, p_session::text, v_turn_ids));

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
                                   WHERE NOT app.notebook_line_drawn_from(e.item, p_session::text)),
                'commitments', (SELECT coalesce(jsonb_agg(e.item ORDER BY e.i), '[]'::jsonb)
                                FROM jsonb_array_elements(n.content -> 'commitments') WITH ORDINALITY AS e (item, i)
                                WHERE NOT app.notebook_line_drawn_from(e.item, p_session::text)),
                'openQuestions', (SELECT coalesce(jsonb_agg(e.item ORDER BY e.i), '[]'::jsonb)
                                  FROM jsonb_array_elements(n.content -> 'openQuestions') WITH ORDINALITY AS e (item, i)
                                  WHERE NOT app.notebook_line_drawn_from(e.item, p_session::text)),
                'lastAdvice', (SELECT coalesce(jsonb_agg(e.item ORDER BY e.i), '[]'::jsonb)
                               FROM jsonb_array_elements(n.content -> 'lastAdvice') WITH ORDINALITY AS e (item, i)
                               WHERE NOT app.notebook_line_drawn_from(e.item, p_session::text)))
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
                                               WHERE app.notebook_line_drawn_from(e.item, p_session::text)))
                           AS cites
                    FROM veir_notebooks nb WHERE nb.venture_id = s.venture_id) AS c) AS x
   WHERE n.id = x.id AND (x.cites OR x.clear_summary OR x.clear_opener);
END
$$;
REVOKE ALL ON FUNCTION app.erase_drawn_from_session(uuid, uuid) FROM PUBLIC;
