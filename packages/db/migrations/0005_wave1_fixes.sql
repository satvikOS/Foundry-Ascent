-- Foundry Ascent — corrections to the vEIR knowledge pools and conversations of 0004
-- (docs/architecture/knowledge-pools.md). 0001–0004 are live and checksummed: they are never edited.
--
-- Every statement is re-runnable and expand-only: code written for 0004 keeps working on this schema.
--
--  1. Conversation titles record who set them (`title_source`): distillation replaces only automatic titles,
--     never one a person chose. Temporary chats never carry a title (CHECK, after clearing any that do).
--  2. The notebook document matches its contract exactly (uuid sources, ISO timestamps) and may record the
--     conversations its summary and opener were drawn from. Rows that predate the stricter shape are repaired.
--  3. Deleting a conversation also clears the notebook summary and opener drawn from it, and erases the AI
--     memory proposals drawn from it that nobody kept (rejected or expired as well as pending). Escalation
--     packets stay: a shared one went to a person with the founder's consent, and a draft is the founder's
--     to send or withdraw.
--  4. Seeded knowledge: chunks that a seed re-run brought back under an edited or withdrawn source are
--     removed (the seed now inserts chunks only together with a new source). The program method corpus
--     becomes an authored note, as 0004 did for the persona corpora.
--  5. Platform admins may add members to a venture team (invitations), as program leads may.
--  6. Consent wording: the program-lead exception covers synthetic (fictional) EIRs whether or not they can
--     sign in.

-- ---------------------------------------------------------------------------------------------------
-- 1. Conversation titles
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS title_source text NOT NULL DEFAULT 'auto';
ALTER TABLE coaching_sessions DROP CONSTRAINT IF EXISTS coaching_sessions_title_source_check;
ALTER TABLE coaching_sessions ADD CONSTRAINT coaching_sessions_title_source_check
  CHECK (title_source IN ('auto', 'person'));

-- Temporary chats never carry a title.
UPDATE coaching_sessions SET title = NULL WHERE privacy <> 'standard' AND title IS NOT NULL;
ALTER TABLE coaching_sessions DROP CONSTRAINT IF EXISTS coaching_sessions_title_privacy_check;
ALTER TABLE coaching_sessions ADD CONSTRAINT coaching_sessions_title_privacy_check
  CHECK (privacy = 'standard' OR title IS NULL);

-- Titles people chose before this column existed: renamed conversations (audited), and titles given at start
-- (they match neither the first message nor the goal). Distilled titles stay automatic.
UPDATE coaching_sessions s SET title_source = 'person'
 WHERE s.title_source = 'auto' AND s.title IS NOT NULL AND s.deleted_at IS NULL
   AND (EXISTS (SELECT 1 FROM audit_events a
                 WHERE a.action = 'session.renamed' AND a.object_type = 'session' AND a.object_id = s.id::text)
        OR (s.distilled_at IS NULL
            AND s.title IS DISTINCT FROM (SELECT app.conversation_title(t.founder_text) FROM turns t
                                           WHERE t.session_id = s.id AND t.risk_label IS DISTINCT FROM 'crisis'
                                           ORDER BY t.ordinal LIMIT 1)
            AND s.title IS DISTINCT FROM app.conversation_title(s.goal)));

-- ---------------------------------------------------------------------------------------------------
-- 2. Notebook shape
-- ---------------------------------------------------------------------------------------------------

-- A conversation id as the contract accepts it (RFC 9562 layout, or the nil and max ids).
CREATE OR REPLACE FUNCTION app.is_contract_uuid(p text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(p ~ '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$', false)
$$;

-- An ISO 8601 timestamp as the contract accepts it: a real calendar date, seconds, optional fraction, and
-- `Z` or a `±hh:mm` offset.
CREATE OR REPLACE FUNCTION app.is_contract_timestamp(p text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(p ~ ('^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29'
                       || '|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)'
                       || '|(?:02)-(?:0[1-9]|1\d|2[0-8])))'
                       || 'T(?:[01]\d|2[0-3])[:][0-5]\d[:][0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3])[:][0-5]\d)$'),
                  false)
$$;

-- One section of a notebook: an array (at most 40) of {id, text, sourceSessionId, createdAt} objects;
-- commitments also carry {due, status}. Sources are conversation ids or null; times are ISO timestamps.
CREATE OR REPLACE FUNCTION app.notebook_entries_valid(p_entries jsonb, p_max_text integer, p_commitments boolean)
  RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(jsonb_typeof(p_entries) = 'array' AND jsonb_array_length(p_entries) <= 40
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_entries) AS e (item)
       WHERE coalesce(jsonb_typeof(e.item), 'missing') <> 'object'
          OR coalesce(jsonb_typeof(e.item -> 'id'), 'missing') <> 'string'
          OR coalesce(length(e.item ->> 'id'), 0) NOT BETWEEN 1 AND 64
          OR coalesce(jsonb_typeof(e.item -> 'text'), 'missing') <> 'string'
          OR coalesce(length(e.item ->> 'text'), 0) > p_max_text
          OR coalesce(jsonb_typeof(e.item -> 'sourceSessionId'), 'missing') NOT IN ('string', 'null')
          OR (jsonb_typeof(e.item -> 'sourceSessionId') = 'string'
              AND NOT app.is_contract_uuid(e.item ->> 'sourceSessionId'))
          OR coalesce(jsonb_typeof(e.item -> 'createdAt'), 'missing') <> 'string'
          OR NOT app.is_contract_timestamp(e.item ->> 'createdAt')
          OR (p_commitments AND (
                coalesce(e.item ->> 'status', 'missing') NOT IN ('open', 'done', 'dropped')
                OR coalesce(jsonb_typeof(e.item -> 'due'), 'missing') NOT IN ('string', 'null')))), false)
$$;

-- The notebook document: {summary, founderProfile[], commitments[], openQuestions[], lastAdvice[], nextOpener},
-- optionally with the conversations the summary was drawn from (`summarySources`, at most 50 ids) and the one
-- the opener was drawn from (`nextOpenerSource`). Absent sources mean "unknown".
CREATE OR REPLACE FUNCTION app.notebook_content_valid(p jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(jsonb_typeof(p) = 'object'
     AND jsonb_typeof(p -> 'summary') = 'string' AND length(p ->> 'summary') <= 1200
     AND coalesce(jsonb_typeof(p -> 'nextOpener'), 'missing') IN ('string', 'null')
     AND coalesce(length(p ->> 'nextOpener'), 0) <= 300
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

REVOKE ALL ON FUNCTION app.is_contract_uuid(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.is_contract_timestamp(text) FROM PUBLIC;
-- The notebook CHECK constraint runs with the writer's privileges.
GRANT EXECUTE ON FUNCTION app.is_contract_uuid(text) TO app_rls;
GRANT EXECUTE ON FUNCTION app.is_contract_timestamp(text) TO app_rls;

-- Rows written under 0004's looser shape: a source that is not a conversation id becomes null, a time that is
-- not an ISO timestamp becomes the notebook's creation time, and malformed source lists are dropped.
CREATE OR REPLACE FUNCTION app.notebook_repair_entries(p_entries jsonb, p_at timestamptz) RETURNS jsonb
  LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(
           e.item
           || CASE WHEN jsonb_typeof(e.item -> 'sourceSessionId') = 'string'
                        AND NOT app.is_contract_uuid(e.item ->> 'sourceSessionId')
                   THEN jsonb_build_object('sourceSessionId', NULL) ELSE '{}'::jsonb END
           || CASE WHEN NOT coalesce(app.is_contract_timestamp(e.item ->> 'createdAt'), false)
                   THEN jsonb_build_object('createdAt', to_jsonb(p_at)) ELSE '{}'::jsonb END
           ORDER BY e.i), '[]'::jsonb)
  FROM jsonb_array_elements(p_entries) WITH ORDINALITY AS e (item, i)
$$;
REVOKE ALL ON FUNCTION app.notebook_repair_entries(jsonb, timestamptz) FROM PUBLIC;

UPDATE veir_notebooks n
   SET content = (n.content - 'summarySources' - 'nextOpenerSource')
                 || jsonb_build_object(
                      'founderProfile', app.notebook_repair_entries(n.content -> 'founderProfile', n.created_at),
                      'commitments', app.notebook_repair_entries(n.content -> 'commitments', n.created_at),
                      'openQuestions', app.notebook_repair_entries(n.content -> 'openQuestions', n.created_at),
                      'lastAdvice', app.notebook_repair_entries(n.content -> 'lastAdvice', n.created_at))
 WHERE NOT app.notebook_content_valid(n.content);

DROP FUNCTION IF EXISTS app.notebook_repair_entries(jsonb, timestamptz);

-- ---------------------------------------------------------------------------------------------------
-- 3. Deleting a conversation
-- ---------------------------------------------------------------------------------------------------

-- Deletes a conversation (founder/team): the content of every turn is erased exactly like an ended temporary
-- chat, together with its title, goal, recap, digest and feedback comments; pending turns are failed so a
-- late model answer is never stored. Everything the vEIR drew from it goes too:
--   - AI memory proposals drawn from it that no person kept (pending, rejected or expired);
--   - notebook lines sourced from it;
--   - the notebook summary and opener when they were drawn from it. When the notebook does not record where
--     they came from (written before sources were recorded), they are cleared if the conversation was
--     distilled or any notebook line came from it.
-- Stored idempotent responses that mention it are purged. Escalation packets stay (a shared one went to a
-- person with the founder's consent; a draft is the founder's to send or withdraw). Security records (audit,
-- usage, turn metadata) stay. Returns false when the conversation does not exist or is not visible.
CREATE OR REPLACE FUNCTION app.soft_delete_session(p_session uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s           coaching_sessions%ROWTYPE;
  v_turns     uuid[];
  v_mem       uuid[];
  v_persona   uuid;
  v_distilled boolean;
  v_id        jsonb := to_jsonb(p_session::text);
BEGIN
  SELECT * INTO s FROM coaching_sessions WHERE id = p_session AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR NOT app.in_current_tenant(s.tenant_id)
     OR NOT (app.can_write_venture(s.venture_id) OR app.is_assigned_eir(s.venture_id)) THEN
    RETURN false;
  END IF;
  IF NOT app.can_write_venture(s.venture_id) THEN
    RAISE EXCEPTION 'deleting a conversation requires founder or team membership' USING ERRCODE = '42501';
  END IF;

  SELECT r.persona_id INTO v_persona FROM persona_releases r WHERE r.id = s.persona_release_id;
  v_distilled := s.distilled_at IS NOT NULL OR s.distill_version > 0;

  SELECT coalesce(array_agg(t.id), '{}') INTO v_turns FROM turns t WHERE t.session_id = p_session;
  UPDATE turns SET status = 'failed', completed_at = coalesce(completed_at, now())
   WHERE session_id = p_session AND status = 'pending';
  UPDATE turns SET founder_text = '[deleted conversation]', response = NULL, sampled_for_review = false
   WHERE session_id = p_session;
  UPDATE feedback SET comment = NULL WHERE turn_id = ANY (v_turns) AND comment IS NOT NULL;

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
  SELECT x, s.venture_id, app.current_principal(), 'deleted', '{"conversationDeleted": true}'::jsonb
  FROM unnest(v_mem) AS x;

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
         version = n.version + 1, last_edited_by = 'person', last_edited_principal = app.current_principal(),
         updated_at = now()
    FROM (SELECT c.id, c.cites,
                 c.summary <> '' AND (c.summary_sources @> jsonb_build_array(v_id)
                                      OR (jsonb_array_length(c.summary_sources) = 0 AND c.own
                                          AND (v_distilled OR c.cites))) AS clear_summary,
                 c.opener IS NOT NULL AND (c.opener_source = v_id
                                           OR (c.opener_source IS NULL AND c.own AND (v_distilled OR c.cites)))
                   AS clear_opener
            FROM (SELECT nb.id, nb.content ->> 'summary' AS summary, nb.content ->> 'nextOpener' AS opener,
                         CASE WHEN jsonb_typeof(nb.content -> 'summarySources') = 'array'
                              THEN nb.content -> 'summarySources' ELSE '[]'::jsonb END AS summary_sources,
                         CASE WHEN jsonb_typeof(nb.content -> 'nextOpenerSource') = 'string'
                              THEN nb.content -> 'nextOpenerSource' END AS opener_source,
                         nb.persona_id IS NOT DISTINCT FROM v_persona AS own,
                         EXISTS (SELECT 1 FROM jsonb_each(nb.content) AS sec (k, v)
                                 WHERE jsonb_typeof(sec.v) = 'array'
                                   AND EXISTS (SELECT 1 FROM jsonb_array_elements(sec.v) AS e (item)
                                               WHERE jsonb_typeof(e.item) = 'object'
                                                 AND e.item ->> 'sourceSessionId' = p_session::text)) AS cites
                    FROM veir_notebooks nb WHERE nb.venture_id = s.venture_id) AS c) AS x
   WHERE n.id = x.id AND (x.cites OR x.clear_summary OR x.clear_opener);

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

-- ---------------------------------------------------------------------------------------------------
-- 4. Seeded knowledge
-- ---------------------------------------------------------------------------------------------------

-- Withdrawing a source (or deleting its document) removes its chunks, so any chunk of a withdrawn source was
-- brought back by a seed re-run.
DELETE FROM knowledge_chunks c USING knowledge_sources s WHERE c.source_id = s.id AND s.status = 'withdrawn';
-- An authored source's chunks are written in the same transaction that saves its text (and moves its
-- `updated_at`), so chunks created after its last save were brought back by a seed re-run after an edit.
DELETE FROM knowledge_chunks c USING knowledge_sources s
 WHERE c.source_id = s.id AND s.kind IN ('note', 'case', 'faq', 'transcript') AND c.created_at > s.updated_at;

-- The program method corpus written before this migration becomes an authored note whose text is its chunks,
-- like the persona corpora in 0004 (fresh databases are seeded that way).
UPDATE knowledge_sources s
   SET kind = 'note',
       body = (SELECT string_agg(CASE WHEN c.heading IS NULL OR c.heading = '' THEN c.content
                                      ELSE '## ' || c.heading || E'\n\n' || c.content END,
                                 E'\n\n' ORDER BY c.ordinal)
               FROM knowledge_chunks c WHERE c.source_id = s.id)
 WHERE s.scope = 'program' AND s.kind = 'document' AND s.s3_key IS NULL AND s.body IS NULL
   AND EXISTS (SELECT 1 FROM knowledge_chunks c WHERE c.source_id = s.id);

-- ---------------------------------------------------------------------------------------------------
-- 5. Team invitations by platform admins
-- ---------------------------------------------------------------------------------------------------

DROP POLICY IF EXISTS memberships_read ON venture_memberships;
CREATE POLICY memberships_read ON venture_memberships FOR SELECT TO app_rls
  USING (app.can_read_venture(venture_id) OR principal_id = app.current_principal()
         OR ((app.has_role('program_lead') OR app.has_role('platform_admin'))
             AND app.venture_in_current_tenant(venture_id)));
DROP POLICY IF EXISTS memberships_insert ON venture_memberships;
CREATE POLICY memberships_insert ON venture_memberships FOR INSERT TO app_rls
  WITH CHECK ((app.has_role('program_lead') OR app.has_role('platform_admin'))
              AND app.venture_in_current_tenant(venture_id) AND app.principal_in_current_tenant(principal_id));
DROP POLICY IF EXISTS memberships_update ON venture_memberships;
CREATE POLICY memberships_update ON venture_memberships FOR UPDATE TO app_rls
  USING ((app.has_role('program_lead') OR app.has_role('platform_admin'))
         AND app.venture_in_current_tenant(venture_id) AND app.principal_in_current_tenant(principal_id));

-- ---------------------------------------------------------------------------------------------------
-- 6. Consent of synthetic EIRs
-- ---------------------------------------------------------------------------------------------------

COMMENT ON FUNCTION app.is_synthetic_eir(uuid) IS
  'True for a synthetic (fictional) EIR of the current tenant, whether or not its principal can sign in. '
  'Consent stays the subject''s own act; a program lead records and revokes it only for such an EIR.';
