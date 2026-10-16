-- Foundry Ascent — memory the vEIR keeps by itself (owner decision 2026-10-16: no "add to memory" approvals).
-- Applied on top of 0001–0012, which are live and never edited here. Expand-only: code written for the previous
-- schema keeps working (the new column is nullable, the constraint only admits more). Every statement is
-- re-runnable (ADD COLUMN IF NOT EXISTS, DROP … IF EXISTS before ADD, CREATE OR REPLACE, guarded updates).
--
--  1. Automatic memory. What the vEIR learns from a standard conversation is kept at once: an AI item may be
--     `confirmed` (and later disputed or superseded by a person's correction) without a person's approval when
--     it records when it was kept automatically (`auto_kept_at`). The approval CHECK of 0007 is replaced by one
--     that admits exactly that: a model inference is still never durable without either a person's approval or
--     the record that it was kept automatically. Pending AI proposals left from before are NOT kept here: SQL
--     cannot tell a restated item or the coach's own advice from what the founder said, so the daily maintenance
--     runs each through the same checks as new memory (core `settlePendingAiProposals`) and keeps or retires it.
--     EIR proposals (origin `eir`) stay proposals for the founder to accept.
--  2. Deleting a conversation erases what was kept automatically from it. An item kept automatically that no
--     person approved or corrected since, drawn only from that conversation (its session or its turns), is
--     erased like a proposal; one also drawn from other conversations loses that conversation's sources and
--     stays (the others still support it). Everything else app.erase_drawn_from_session erased (0009) it still
--     erases, unchanged, plus what this migration adds per conversation (3, 4).
--  3. Forgetting is durable. When the founder deletes an item the vEIR learned (or corrects what it kept), the
--     vEIR records a fingerprint of it per conversation it was learned from (`memory_forgotten`: hashes of its
--     words and numbers and a 256-bit meaning signature, never text), so the next distillation of the same
--     transcript never keeps it again. The table is closed to app_rls; requests go through
--     app.record_forgotten_memory and app.forgotten_memory (founder/team only). The fingerprints go with their
--     conversation when it is deleted. app.discard_kept_memory takes back an item kept moments ago that turned out
--     to restate another one (or something forgotten) once its meaning was known.
--  4. The notebook's next topic. Distillation notes the thread to come back to as a short phrase (`nextTopic`),
--     and the greeting is phrased around it afresh each time; it goes with the opener (same source conversation),
--     so deleting that conversation clears it too.

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

-- Pending AI proposals are left as they are: the daily maintenance keeps or retires each one with the checks new
-- memory goes through (see 1 above).

-- ---------------------------------------------------------------------------------------------------
-- 3. Forgetting is durable (before 2: the erasure below deletes these rows with their conversation)
-- ---------------------------------------------------------------------------------------------------

-- One row per forgotten version and per conversation it was learned from. No text: hashes of the normalised
-- title and content words (32 hex), of the numbers it stated (16 hex), and a SimHash of its embedding (64 hex,
-- null without one). No tenant or venture column: the conversation says both, and app_rls never reads the table.
CREATE TABLE IF NOT EXISTS memory_forgotten (
  id          bigserial PRIMARY KEY,
  session_id  uuid NOT NULL REFERENCES coaching_sessions (id),
  memory_type text NOT NULL,
  title_key   text NOT NULL CHECK (title_key ~ '^[0-9a-f]{32}$'),
  content_key text NOT NULL CHECK (content_key ~ '^[0-9a-f]{32}$'),
  numbers_key text NOT NULL CHECK (numbers_key ~ '^[0-9a-f]{16}$'),
  signature   text CHECK (signature IS NULL OR signature ~ '^[0-9a-f]{64}$'),
  reason      text NOT NULL CHECK (reason IN ('deleted', 'corrected')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_forgotten_print_idx
  ON memory_forgotten (session_id, content_key, title_key, memory_type, numbers_key, coalesce(signature, ''));
ALTER TABLE memory_forgotten ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON memory_forgotten FROM PUBLIC;

-- Records the fingerprints `p_prints` ([{type, titleKey, contentKey, numbersKey, signature}], at most 20) of item
-- `p_memory` for every standard, undeleted conversation of its venture its version chain names (a `session` ref,
-- or a `turn` ref to one of its turns). Call it before the delete erases the refs. Founder/team only (as deleting
-- memory); 0 when the item is not visible. Returns the rows written.
CREATE OR REPLACE FUNCTION app.record_forgotten_memory(p_memory uuid, p_reason text, p_prints jsonb)
  RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  m     memory_objects%ROWTYPE;
  v_ids uuid[];
  v_n   integer;
BEGIN
  IF p_reason IS NULL OR p_reason NOT IN ('deleted', 'corrected') OR jsonb_typeof(p_prints) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid forgotten memory record' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO m FROM memory_objects WHERE id = p_memory AND status <> 'deleted';
  IF NOT FOUND OR NOT app.in_current_tenant(m.tenant_id)
     OR NOT app.can_see_item(m.venture_id, m.visibility, m.created_by) THEN
    RETURN 0;
  END IF;
  IF NOT app.can_write_venture(m.venture_id) THEN
    RAISE EXCEPTION 'forgetting memory requires founder or team membership' USING ERRCODE = '42501';
  END IF;
  WITH RECURSIVE chain (id, supersedes_id) AS (
    SELECT mo.id, mo.supersedes_id FROM memory_objects mo WHERE mo.id = p_memory
    UNION
    SELECT mo.id, mo.supersedes_id FROM memory_objects mo JOIN chain c ON mo.id = c.supersedes_id
    WHERE mo.venture_id = m.venture_id AND mo.status <> 'deleted')
  SELECT array_agg(chain.id) INTO v_ids FROM chain;
  WITH refs AS (
    SELECT r.ref ->> 'kind' AS kind, CAST(r.ref ->> 'id' AS uuid) AS ref_id
      FROM memory_objects mo
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(mo.source_refs) = 'array'
                                                   THEN mo.source_refs ELSE '[]'::jsonb END) AS r (ref)
     WHERE mo.id = ANY (v_ids) AND r.ref ->> 'kind' IN ('session', 'turn')
       AND app.is_contract_uuid(r.ref ->> 'id'))
  , convs AS (
    SELECT s.id FROM coaching_sessions s
     WHERE s.venture_id = m.venture_id AND s.privacy = 'standard' AND s.deleted_at IS NULL
       AND (s.id IN (SELECT ref_id FROM refs WHERE kind = 'session')
            OR s.id IN (SELECT t.session_id FROM turns t
                         WHERE t.id IN (SELECT ref_id FROM refs WHERE kind = 'turn'))))
  , prints AS (
    SELECT x ->> 'type' AS memory_type, x ->> 'titleKey' AS title_key, x ->> 'contentKey' AS content_key,
           x ->> 'numbersKey' AS numbers_key, nullif(x ->> 'signature', '') AS signature
      FROM jsonb_array_elements(p_prints) WITH ORDINALITY AS e (x, i)
     WHERE e.i <= 20)
  , ins AS (
    INSERT INTO memory_forgotten (session_id, memory_type, title_key, content_key, numbers_key, signature, reason)
    SELECT c.id, pr.memory_type, pr.title_key, pr.content_key, pr.numbers_key, pr.signature, p_reason
      FROM convs c CROSS JOIN prints pr
    ON CONFLICT DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO v_n FROM ins;
  RETURN v_n;
END
$$;
REVOKE ALL ON FUNCTION app.record_forgotten_memory(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_forgotten_memory(uuid, text, jsonb) TO app_rls;

-- The venture's forgotten fingerprints, newest first (at most `p_limit`, capped at 1000), for its founder/team
-- (none for anyone else): what a new memory candidate is compared with before it is kept.
CREATE OR REPLACE FUNCTION app.forgotten_memory(p_venture uuid, p_limit integer)
  RETURNS TABLE (session_id uuid, memory_type text, title_key text, content_key text, numbers_key text,
                 signature text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT f.session_id, f.memory_type, f.title_key, f.content_key, f.numbers_key, f.signature
    FROM memory_forgotten f JOIN coaching_sessions s ON s.id = f.session_id
   WHERE s.venture_id = p_venture AND app.in_current_tenant(s.tenant_id) AND app.can_write_venture(p_venture)
   ORDER BY f.created_at DESC, f.id DESC
   LIMIT least(greatest(coalesce(p_limit, 1), 1), 1000)
$$;
REVOKE ALL ON FUNCTION app.forgotten_memory(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.forgotten_memory(uuid, integer) TO app_rls;

-- Takes back an item the vEIR kept automatically (confirmed, nobody approved or corrected it, never a corrected
-- version) because it restates another item (`duplicate`, `p_into` the item it restates) or something the founder
-- made it forget (`forgotten`): erased like a delete, with a `deleted` event marked `system`. Founder/team of
-- its venture only (the request that kept it). Returns 1 when discarded, else 0.
CREATE OR REPLACE FUNCTION app.discard_kept_memory(p_memory uuid, p_reason text, p_into uuid)
  RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  m      memory_objects%ROWTYPE;
  v_into uuid;
BEGIN
  IF p_reason IS NULL OR p_reason NOT IN ('duplicate', 'forgotten') THEN
    RAISE EXCEPTION 'invalid discard reason' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO m FROM memory_objects WHERE id = p_memory FOR UPDATE;
  IF NOT FOUND OR NOT app.in_current_tenant(m.tenant_id) OR NOT app.can_write_venture(m.venture_id)
     OR NOT app.can_see_item(m.venture_id, m.visibility, m.created_by)
     OR m.origin <> 'ai' OR m.auto_kept_at IS NULL OR m.approved_by IS NOT NULL OR m.status <> 'confirmed'
     OR m.supersedes_id IS NOT NULL THEN
    RETURN 0;
  END IF;
  SELECT o.id INTO v_into FROM memory_objects o WHERE o.id = p_into AND o.venture_id = m.venture_id;
  UPDATE memory_objects
     SET status = 'deleted', title = '[deleted]', content = '', attributes = '{}'::jsonb,
         source_refs = '[]'::jsonb, embedding = NULL, pinned = false, updated_at = now()
   WHERE id = p_memory;
  UPDATE memory_events SET diff = '{"redacted": true}'::jsonb WHERE memory_id = p_memory;
  UPDATE turn_evidence SET title = '[deleted]' WHERE kind = 'memory' AND ref_id = p_memory;
  INSERT INTO memory_events (memory_id, venture_id, actor_id, action, diff)
  VALUES (p_memory, m.venture_id, app.current_principal(), 'deleted',
          jsonb_build_object('system', true, 'reason', p_reason, 'into', v_into));
  RETURN 1;
END
$$;
REVOKE ALL ON FUNCTION app.discard_kept_memory(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.discard_kept_memory(uuid, text, uuid) TO app_rls;

-- ---------------------------------------------------------------------------------------------------
-- 4. The notebook's next topic (a phrase of at most 120 characters, or null)
-- ---------------------------------------------------------------------------------------------------

-- 0005's check with one more optional key: `nextTopic`.
CREATE OR REPLACE FUNCTION app.notebook_content_valid(p jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(jsonb_typeof(p) = 'object'
     AND jsonb_typeof(p -> 'summary') = 'string' AND length(p ->> 'summary') <= 1200
     AND coalesce(jsonb_typeof(p -> 'nextOpener'), 'missing') IN ('string', 'null')
     AND coalesce(length(p ->> 'nextOpener'), 0) <= 300
     AND coalesce(jsonb_typeof(p -> 'nextTopic'), 'missing') IN ('string', 'null', 'missing')
     AND coalesce(length(p ->> 'nextTopic'), 0) <= 120
     AND app.notebook_entries_valid(p -> 'founderProfile', 400, false)
     AND app.notebook_entries_valid(p -> 'openQuestions', 400, false)
     AND app.notebook_entries_valid(p -> 'lastAdvice', 400, false)
     AND app.notebook_entries_valid(p -> 'commitments', 300, true)
     AND (p -> 'summarySources' IS NULL
          OR (jsonb_typeof(p -> 'summarySources') = 'array' AND jsonb_array_length(p -> 'summarySources') <= 50
              AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p -> 'summarySources') AS x (v)
                              WHERE jsonb_typeof(x.v) <> 'string' OR NOT app.is_contract_uuid(x.v #>> '{}'))))
     AND (p -> 'nextOpenerSource' IS NULL OR jsonb_typeof(p -> 'nextOpenerSource') = 'null'
          OR (jsonb_typeof(p -> 'nextOpenerSource') = 'string'
              AND app.is_contract_uuid(p ->> 'nextOpenerSource'))), false)
$$;

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
--   - the fingerprints of memory the founder made the vEIR forget that it had learned from it;
--   - the notebook summary and opener (with its next topic) when they were drawn from it. A missing `summarySources` or
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

  -- What the founder made the vEIR forget that it had learned here: the fingerprints go with the conversation.
  DELETE FROM memory_forgotten WHERE session_id = p_session;

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
           || CASE WHEN x.clear_opener THEN '{"nextOpener": null, "nextOpenerSource": null, "nextTopic": null}'::jsonb
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
