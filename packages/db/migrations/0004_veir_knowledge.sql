-- Foundry Ascent — vEIR knowledge pools, conversations and calls (docs/architecture/knowledge-pools.md).
-- Applied on top of 0001–0003, which are live and checksummed: they are never edited; every change lives here.
--
-- Every statement is re-runnable (CREATE OR REPLACE, DROP … IF EXISTS before CREATE, ADD COLUMN IF NOT EXISTS,
-- ON CONFLICT DO NOTHING, guarded backfills), so applying the file twice leaves the same schema.
--
--  1. Helpers: who curates a persona's common pool (a program lead, or the EIR the persona is built from),
--     conversation titles, notebook shape validation; app.can_write_venture answers false instead of NULL for
--     non-members (the soft-delete functions of 0002 let an assigned EIR through on NULL).
--  2. Conversations: title, last activity, call marker, digest, distillation bookkeeping and soft delete; turns
--     record whether they were typed or spoken. Deleted conversations disappear from every list and lose
--     their content like an ended temporary chat.
--  3. The vEIR notebook, one per venture × persona: AI notes that the venture team sees and corrects. It is
--     derived from conversations, so it is exactly as visible as they are (founder/team, assigned EIR).
--  4. Common pool: knowledge sources gain a kind, authored text, a summary and an upload state. Persona
--     corpora may only be written by their curators and program corpora by program leads (closes the 0001
--     gap where any EIR could write any persona's or the program's corpus).
--  5. Lessons: patterns may belong to one persona and record whether they were distilled or authored; the
--     persona's EIR reviews them alongside program leads.
--  6. Personas: embodiment (call provider, voice, portrait), only with consent covering voice / likeness for
--     EIR personas, and a tagline. Consent stays the subject's own act, except that a program lead records the
--     consent of a synthetic (fictional) EIR who cannot sign in.
--  7. Usage purposes `distill` and `speech`, call-minute caps and their accounting helper; persona document
--     uploads count against the daily upload quota.
--
-- New functions are created with EXECUTE revoked from PUBLIC and granted to app_rls only where a request needs
-- them.

-- ---------------------------------------------------------------------------------------------------
-- 1. Helpers
-- ---------------------------------------------------------------------------------------------------

-- True when the current principal holds the eir role and is the EIR the persona is built from.
CREATE OR REPLACE FUNCTION app.is_persona_eir(p_persona uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app.has_role('eir') AND EXISTS (
    SELECT 1 FROM personas pe JOIN eir_profiles e ON e.id = pe.eir_profile_id
    WHERE pe.id = p_persona AND pe.tenant_id = app.current_tenant()
      AND e.principal_id = app.current_principal())
$$;

-- Program leads curate every persona of their tenant; an EIR curates the personas built from them.
CREATE OR REPLACE FUNCTION app.can_curate_persona(p_persona uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM personas pe WHERE pe.id = p_persona AND pe.tenant_id = app.current_tenant())
     AND (app.has_role('program_lead') OR app.is_persona_eir(p_persona))
$$;

-- A conversation title from a message: Markdown markers dropped, whitespace collapsed, cut at a word boundary
-- (at most 80 characters plus an ellipsis). NULL for empty text.
CREATE OR REPLACE FUNCTION app.conversation_title(p_text text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
           WHEN s.t = '' THEN NULL
           WHEN length(s.t) <= 80 THEN s.t
           ELSE rtrim(regexp_replace(left(s.t, 80), '\s+\S*$', ''), ' ,.;:-') || '…'
         END
  FROM (SELECT btrim(regexp_replace(regexp_replace(coalesce(p_text, ''), '[#*_`>]+', '', 'g'), '\s+', ' ', 'g'))
               AS t) AS s
$$;

-- One section of a notebook: an array (at most 40) of {id, text, sourceSessionId, createdAt} objects;
-- commitments also carry {due, status}.
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
          OR coalesce(jsonb_typeof(e.item -> 'createdAt'), 'missing') <> 'string'
          OR (p_commitments AND (
                coalesce(e.item ->> 'status', 'missing') NOT IN ('open', 'done', 'dropped')
                OR coalesce(jsonb_typeof(e.item -> 'due'), 'missing') NOT IN ('string', 'null')))), false)
$$;

-- The notebook document: {summary, founderProfile[], commitments[], openQuestions[], lastAdvice[], nextOpener}.
CREATE OR REPLACE FUNCTION app.notebook_content_valid(p jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(jsonb_typeof(p) = 'object'
     AND jsonb_typeof(p -> 'summary') = 'string' AND length(p ->> 'summary') <= 1200
     AND coalesce(jsonb_typeof(p -> 'nextOpener'), 'missing') IN ('string', 'null')
     AND coalesce(length(p ->> 'nextOpener'), 0) <= 300
     AND app.notebook_entries_valid(p -> 'founderProfile', 400, false)
     AND app.notebook_entries_valid(p -> 'openQuestions', 400, false)
     AND app.notebook_entries_valid(p -> 'lastAdvice', 400, false)
     AND app.notebook_entries_valid(p -> 'commitments', 300, true), false)
$$;

-- A venture writer is a founder or team member. Fixed to answer false (not NULL) for people without a membership:
-- `IF NOT app.can_write_venture(...)` in the SECURITY DEFINER soft-delete functions treated NULL as "may write",
-- so an assigned EIR (who reads the venture without a membership) passed that check. Policies are unaffected
-- (NULL already denied there).
CREATE OR REPLACE FUNCTION app.can_write_venture(p_venture uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(app.venture_role(p_venture) IN ('founder', 'team'), false)
$$;

REVOKE ALL ON FUNCTION app.is_persona_eir(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.can_curate_persona(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.conversation_title(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.notebook_entries_valid(jsonb, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.notebook_content_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_persona_eir(uuid) TO app_rls;
GRANT EXECUTE ON FUNCTION app.can_curate_persona(uuid) TO app_rls;
-- The notebook CHECK constraint runs with the writer's privileges.
GRANT EXECUTE ON FUNCTION app.notebook_entries_valid(jsonb, integer, boolean) TO app_rls;
GRANT EXECUTE ON FUNCTION app.notebook_content_valid(jsonb) TO app_rls;

-- ---------------------------------------------------------------------------------------------------
-- 2. Conversations and turns
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS last_activity_at timestamptz;
ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS has_calls boolean NOT NULL DEFAULT false;
ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS digest jsonb;
-- Set when the founder or team deleted the digest: distillation never writes one again for this conversation.
ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS digest_deleted_at timestamptz;
-- Distillation bookkeeping: the turn count a digest was written for, and when.
ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS distilled_at timestamptz;
ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS distill_version integer NOT NULL DEFAULT 0;
ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

ALTER TABLE coaching_sessions DROP CONSTRAINT IF EXISTS coaching_sessions_title_check;
ALTER TABLE coaching_sessions ADD CONSTRAINT coaching_sessions_title_check
  CHECK (title IS NULL OR length(title) BETWEEN 1 AND 120);
-- Temporary chats never keep a digest.
ALTER TABLE coaching_sessions DROP CONSTRAINT IF EXISTS coaching_sessions_digest_check;
ALTER TABLE coaching_sessions ADD CONSTRAINT coaching_sessions_digest_check
  CHECK (digest IS NULL OR (jsonb_typeof(digest) = 'object' AND privacy = 'standard'));
ALTER TABLE coaching_sessions DROP CONSTRAINT IF EXISTS coaching_sessions_distill_version_check;
ALTER TABLE coaching_sessions ADD CONSTRAINT coaching_sessions_distill_version_check CHECK (distill_version >= 0);

ALTER TABLE turns ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'text';
ALTER TABLE turns DROP CONSTRAINT IF EXISTS turns_channel_check;
ALTER TABLE turns ADD CONSTRAINT turns_channel_check CHECK (channel IN ('text', 'voice'));

-- Backfills for conversations that predate this migration.
UPDATE coaching_sessions s
   SET last_activity_at = greatest(s.started_at,
         coalesce((SELECT max(t.created_at) FROM turns t WHERE t.session_id = s.id), s.started_at))
 WHERE s.last_activity_at IS NULL;
ALTER TABLE coaching_sessions ALTER COLUMN last_activity_at SET DEFAULT now();
ALTER TABLE coaching_sessions ALTER COLUMN last_activity_at SET NOT NULL;

UPDATE coaching_sessions s
   SET title = coalesce(
         (SELECT app.conversation_title(t.founder_text) FROM turns t
           WHERE t.session_id = s.id AND t.risk_label IS DISTINCT FROM 'crisis'
           ORDER BY t.ordinal LIMIT 1),
         app.conversation_title(s.goal))
 WHERE s.title IS NULL AND s.privacy = 'standard' AND s.deleted_at IS NULL;

UPDATE coaching_sessions s SET has_calls = true
 WHERE NOT s.has_calls AND EXISTS (SELECT 1 FROM turns t WHERE t.session_id = s.id AND t.channel = 'voice');

-- Recents: a person's conversations across ventures, and a venture's, by latest activity.
CREATE INDEX IF NOT EXISTS coaching_sessions_starter_activity_idx
  ON coaching_sessions (started_by, last_activity_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS coaching_sessions_venture_activity_idx
  ON coaching_sessions (venture_id, last_activity_at DESC) WHERE deleted_at IS NULL;
-- Distillation sweep: standard conversations whose digest was not deleted, by inactivity.
CREATE INDEX IF NOT EXISTS coaching_sessions_distill_idx
  ON coaching_sessions (last_activity_at)
  WHERE deleted_at IS NULL AND privacy = 'standard' AND digest_deleted_at IS NULL;
-- Call-minute accounting.
CREATE INDEX IF NOT EXISTS turns_author_voice_idx ON turns (author_id, created_at) WHERE channel = 'voice';

-- Every new turn moves its conversation's last activity, marks spoken conversations, and titles a standard
-- conversation from its first message (never from a crisis message; temporary chats keep no title).
CREATE OR REPLACE FUNCTION app.turns_touch_session() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE coaching_sessions s
     SET last_activity_at = greatest(s.last_activity_at, NEW.created_at),
         has_calls = s.has_calls OR NEW.channel = 'voice',
         title = CASE
                   WHEN s.title IS NULL AND s.privacy = 'standard' AND NEW.risk_label IS DISTINCT FROM 'crisis'
                     THEN app.conversation_title(NEW.founder_text)
                   ELSE s.title
                 END
   WHERE s.id = NEW.session_id;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.turns_touch_session() FROM PUBLIC;
DROP TRIGGER IF EXISTS turns_touch_session ON turns;
CREATE TRIGGER turns_touch_session AFTER INSERT ON turns
  FOR EACH ROW EXECUTE FUNCTION app.turns_touch_session();

-- Deleted conversations are invisible to everyone (the rows stay for security records).
DROP POLICY IF EXISTS sessions_read ON coaching_sessions;
CREATE POLICY sessions_read ON coaching_sessions FOR SELECT TO app_rls
  USING (app.in_current_tenant(tenant_id) AND deleted_at IS NULL
         AND (app.can_write_venture(venture_id) OR app.is_assigned_eir(venture_id)));

-- ---------------------------------------------------------------------------------------------------
-- 3. The vEIR notebook
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS veir_notebooks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants (id),
  venture_id            uuid NOT NULL REFERENCES ventures (id),
  persona_id            uuid NOT NULL REFERENCES personas (id),
  content               jsonb NOT NULL DEFAULT
    '{"summary": "", "founderProfile": [], "commitments": [], "openQuestions": [], "lastAdvice": [], "nextOpener": null}'::jsonb
    CHECK (app.notebook_content_valid(content)),
  -- Fingerprints of lines a person removed or corrected: distillation never writes them back.
  suppressed            jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(suppressed) = 'array' AND jsonb_array_length(suppressed) <= 500),
  -- Bumped by every write; edits and distillation both write against the version they read.
  version               integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  last_edited_by        text CHECK (last_edited_by IN ('veir', 'person')),
  last_edited_principal uuid REFERENCES principals (id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz,
  UNIQUE (venture_id, persona_id)
);

GRANT SELECT, INSERT, UPDATE ON veir_notebooks TO app_rls;
ALTER TABLE veir_notebooks ENABLE ROW LEVEL SECURITY;

-- Read like the conversations it is distilled from; written by the founder/team (and by distillation with the
-- owner role). The persona must be one the venture was assigned.
DROP POLICY IF EXISTS veir_notebooks_read ON veir_notebooks;
CREATE POLICY veir_notebooks_read ON veir_notebooks FOR SELECT TO app_rls
  USING (app.in_current_tenant(tenant_id)
         AND (app.can_write_venture(venture_id) OR app.is_assigned_eir(venture_id)));
DROP POLICY IF EXISTS veir_notebooks_insert ON veir_notebooks;
CREATE POLICY veir_notebooks_insert ON veir_notebooks FOR INSERT TO app_rls
  WITH CHECK (app.in_current_tenant(tenant_id) AND app.can_write_venture(venture_id)
              AND app.venture_in_current_tenant(venture_id)
              AND EXISTS (SELECT 1 FROM assignments a
                          WHERE a.venture_id = veir_notebooks.venture_id
                            AND a.persona_id = veir_notebooks.persona_id
                            AND a.tenant_id = veir_notebooks.tenant_id));
DROP POLICY IF EXISTS veir_notebooks_update ON veir_notebooks;
CREATE POLICY veir_notebooks_update ON veir_notebooks FOR UPDATE TO app_rls
  USING (app.in_current_tenant(tenant_id) AND app.can_write_venture(venture_id))
  WITH CHECK (app.in_current_tenant(tenant_id) AND app.can_write_venture(venture_id));

-- Deletes a conversation (founder/team): the content of every turn is erased exactly like an ended temporary
-- chat, together with its title, goal, recap, digest and feedback comments; pending turns are failed so a
-- late model answer is never stored; AI memory proposals drawn from it and notebook lines sourced from it are
-- removed; stored idempotent responses that mention it are purged. Security records (audit, usage, turn
-- metadata) stay. Returns false when the conversation does not exist or is not visible.
CREATE OR REPLACE FUNCTION app.soft_delete_session(p_session uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s       coaching_sessions%ROWTYPE;
  v_turns uuid[];
  v_mem   uuid[];
BEGIN
  SELECT * INTO s FROM coaching_sessions WHERE id = p_session AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR NOT app.in_current_tenant(s.tenant_id)
     OR NOT (app.can_write_venture(s.venture_id) OR app.is_assigned_eir(s.venture_id)) THEN
    RETURN false;
  END IF;
  IF NOT app.can_write_venture(s.venture_id) THEN
    RAISE EXCEPTION 'deleting a conversation requires founder or team membership' USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(array_agg(t.id), '{}') INTO v_turns FROM turns t WHERE t.session_id = p_session;
  UPDATE turns SET status = 'failed', completed_at = coalesce(completed_at, now())
   WHERE session_id = p_session AND status = 'pending';
  UPDATE turns SET founder_text = '[deleted conversation]', response = NULL, sampled_for_review = false
   WHERE session_id = p_session;
  UPDATE feedback SET comment = NULL WHERE turn_id = ANY (v_turns) AND comment IS NOT NULL;

  -- AI proposals still awaiting review that came from this conversation.
  SELECT coalesce(array_agg(m.id), '{}') INTO v_mem FROM memory_objects m
   WHERE m.venture_id = s.venture_id AND m.origin = 'ai' AND m.status = 'proposed'
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

  -- Notebook lines sourced from this conversation.
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
                               WHERE e.item ->> 'sourceSessionId' IS DISTINCT FROM p_session::text)),
         version = n.version + 1, last_edited_by = 'person', last_edited_principal = app.current_principal(),
         updated_at = now()
   WHERE n.venture_id = s.venture_id
     AND EXISTS (SELECT 1 FROM jsonb_each(n.content) AS sec (k, v)
                 WHERE jsonb_typeof(sec.v) = 'array'
                   AND EXISTS (SELECT 1 FROM jsonb_array_elements(sec.v) AS e (item)
                               WHERE e.item ->> 'sourceSessionId' = p_session::text));

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
-- 4. Common pool: knowledge sources
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE knowledge_sources ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'document';
ALTER TABLE knowledge_sources ADD COLUMN IF NOT EXISTS summary text;
-- Authored text of notes, cases, FAQs and transcripts (the chunks are derived from it).
ALTER TABLE knowledge_sources ADD COLUMN IF NOT EXISTS body text;
ALTER TABLE knowledge_sources ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE knowledge_sources ADD COLUMN IF NOT EXISTS failure_reason text;
-- Uploaded documents of shared corpora (venture documents keep their upload in `documents`).
ALTER TABLE knowledge_sources ADD COLUMN IF NOT EXISTS filename text;
ALTER TABLE knowledge_sources ADD COLUMN IF NOT EXISTS content_type text;
ALTER TABLE knowledge_sources ADD COLUMN IF NOT EXISTS size_bytes integer;
ALTER TABLE knowledge_sources ADD COLUMN IF NOT EXISTS s3_key text;

ALTER TABLE knowledge_sources DROP CONSTRAINT IF EXISTS knowledge_sources_kind_check;
ALTER TABLE knowledge_sources ADD CONSTRAINT knowledge_sources_kind_check
  CHECK (kind IN ('note', 'document', 'case', 'faq', 'transcript')
         AND (kind = 'document' OR scope IN ('persona', 'program')));
ALTER TABLE knowledge_sources DROP CONSTRAINT IF EXISTS knowledge_sources_status_check;
ALTER TABLE knowledge_sources ADD CONSTRAINT knowledge_sources_status_check
  CHECK (status IN ('pending_upload', 'processing', 'active', 'stale', 'failed', 'withdrawn'));
ALTER TABLE knowledge_sources DROP CONSTRAINT IF EXISTS knowledge_sources_text_check;
ALTER TABLE knowledge_sources ADD CONSTRAINT knowledge_sources_text_check
  CHECK ((summary IS NULL OR length(summary) <= 600)
         AND (body IS NULL OR length(body) <= 50000)
         AND (failure_reason IS NULL OR length(failure_reason) <= 64));
ALTER TABLE knowledge_sources DROP CONSTRAINT IF EXISTS knowledge_sources_upload_check;
ALTER TABLE knowledge_sources ADD CONSTRAINT knowledge_sources_upload_check
  CHECK ((s3_key IS NULL AND status NOT IN ('pending_upload', 'processing', 'failed'))
         OR (s3_key IS NOT NULL AND kind = 'document' AND scope <> 'venture' AND filename IS NOT NULL
             AND content_type IN ('application/pdf', 'text/plain', 'text/markdown',
                                  'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
             AND size_bytes BETWEEN 1 AND 10485760));
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_sources_s3_key_uq ON knowledge_sources (s3_key) WHERE s3_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS knowledge_sources_persona_idx
  ON knowledge_sources (persona_id, updated_at DESC) WHERE persona_id IS NOT NULL;

-- Persona corpora written before this migration (the seeded doctrine notes) become authored notes whose text is
-- their chunks, so their curators can read and edit them.
UPDATE knowledge_sources s
   SET kind = 'note',
       body = (SELECT string_agg(CASE WHEN c.heading IS NULL OR c.heading = '' THEN c.content
                                      ELSE '## ' || c.heading || E'\n\n' || c.content END,
                                 E'\n\n' ORDER BY c.ordinal)
               FROM knowledge_chunks c WHERE c.source_id = s.id)
 WHERE s.scope = 'persona' AND s.kind = 'document' AND s.s3_key IS NULL AND s.body IS NULL;

DROP POLICY IF EXISTS knowledge_sources_insert ON knowledge_sources;
CREATE POLICY knowledge_sources_insert ON knowledge_sources FOR INSERT TO app_rls
  WITH CHECK (app.in_current_tenant(tenant_id) AND CASE scope
    WHEN 'venture' THEN app.can_write_venture(venture_id)
    WHEN 'persona' THEN app.can_curate_persona(persona_id)
    ELSE app.has_role('program_lead') END);
DROP POLICY IF EXISTS knowledge_sources_update ON knowledge_sources;
CREATE POLICY knowledge_sources_update ON knowledge_sources FOR UPDATE TO app_rls
  USING (app.in_current_tenant(tenant_id) AND CASE scope
    WHEN 'venture' THEN app.can_write_venture(venture_id)
    WHEN 'persona' THEN app.can_curate_persona(persona_id)
    ELSE app.has_role('program_lead') END);

DROP POLICY IF EXISTS knowledge_chunks_insert ON knowledge_chunks;
CREATE POLICY knowledge_chunks_insert ON knowledge_chunks FOR INSERT TO app_rls
  WITH CHECK (app.in_current_tenant(tenant_id)
              AND app.chunk_matches_source(source_id, tenant_id, scope, venture_id, persona_id)
              AND CASE scope
                    WHEN 'venture' THEN app.can_write_venture(venture_id)
                    WHEN 'persona' THEN app.can_curate_persona(persona_id)
                    ELSE app.has_role('program_lead') END);
-- Curators replace the chunks of an authored note when its text changes (venture chunks are only removed by
-- app.soft_delete_document).
GRANT DELETE ON knowledge_chunks TO app_rls;
DROP POLICY IF EXISTS knowledge_chunks_delete ON knowledge_chunks;
CREATE POLICY knowledge_chunks_delete ON knowledge_chunks FOR DELETE TO app_rls
  USING (app.in_current_tenant(tenant_id) AND CASE scope
    WHEN 'persona' THEN app.can_curate_persona(persona_id)
    WHEN 'program' THEN app.has_role('program_lead')
    ELSE false END);

-- ---------------------------------------------------------------------------------------------------
-- 5. Lessons (patterns)
-- ---------------------------------------------------------------------------------------------------

-- NULL persona: a program-wide lesson.
ALTER TABLE patterns ADD COLUMN IF NOT EXISTS persona_id uuid REFERENCES personas (id);
ALTER TABLE patterns ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'authored';
ALTER TABLE patterns ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE patterns DROP CONSTRAINT IF EXISTS patterns_origin_check;
ALTER TABLE patterns ADD CONSTRAINT patterns_origin_check CHECK (origin IN ('distilled', 'authored'));
CREATE INDEX IF NOT EXISTS patterns_tenant_persona_idx ON patterns (tenant_id, persona_id, status);

DROP POLICY IF EXISTS patterns_read ON patterns;
CREATE POLICY patterns_read ON patterns FOR SELECT TO app_rls
  USING (app.in_current_tenant(tenant_id)
         AND (status = 'published' OR app.has_role('program_lead')
              OR (persona_id IS NOT NULL AND app.is_persona_eir(persona_id))));
DROP POLICY IF EXISTS patterns_insert ON patterns;
CREATE POLICY patterns_insert ON patterns FOR INSERT TO app_rls
  WITH CHECK (app.in_current_tenant(tenant_id)
              AND ((persona_id IS NULL AND app.has_role('program_lead'))
                   OR (persona_id IS NOT NULL AND app.can_curate_persona(persona_id))));
DROP POLICY IF EXISTS patterns_update ON patterns;
CREATE POLICY patterns_update ON patterns FOR UPDATE TO app_rls
  USING (app.in_current_tenant(tenant_id)
         AND ((persona_id IS NULL AND app.has_role('program_lead'))
              OR (persona_id IS NOT NULL AND app.can_curate_persona(persona_id))))
  WITH CHECK (app.in_current_tenant(tenant_id)
              AND ((persona_id IS NULL AND app.has_role('program_lead'))
                   OR (persona_id IS NOT NULL AND app.can_curate_persona(persona_id))));

-- ---------------------------------------------------------------------------------------------------
-- 6. Personas: embodiment and tagline
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE personas ADD COLUMN IF NOT EXISTS embodiment jsonb NOT NULL
  DEFAULT '{"provider": "builtin", "voiceId": null, "portraitKey": null}'::jsonb;
ALTER TABLE personas ADD COLUMN IF NOT EXISTS tagline text;
ALTER TABLE personas DROP CONSTRAINT IF EXISTS personas_embodiment_check;
ALTER TABLE personas ADD CONSTRAINT personas_embodiment_check
  CHECK (jsonb_typeof(embodiment) = 'object'
         AND coalesce(embodiment ->> 'provider', 'missing') IN ('builtin', 'heygen', 'tavus', 'simli')
         AND coalesce(jsonb_typeof(embodiment -> 'voiceId'), 'null') IN ('string', 'null')
         AND coalesce(length(embodiment ->> 'voiceId'), 0) <= 64
         AND coalesce(jsonb_typeof(embodiment -> 'portraitKey'), 'null') IN ('string', 'null')
         AND coalesce(length(embodiment ->> 'portraitKey'), 0) <= 512);
ALTER TABLE personas DROP CONSTRAINT IF EXISTS personas_tagline_check;
ALTER TABLE personas ADD CONSTRAINT personas_tagline_check CHECK (tagline IS NULL OR length(tagline) BETWEEN 1 AND 160);

-- An EIR persona carries a voice or a portrait only when its consent covers voice / likeness (checked whenever
-- the embodiment or the consent link changes). Calls re-check the consent before every use, and revoking it
-- suspends the persona.
CREATE OR REPLACE FUNCTION app.personas_embodiment_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_assets text[];
BEGIN
  IF NEW.kind <> 'eir_persona'
     OR ((NEW.embodiment ->> 'voiceId') IS NULL AND (NEW.embodiment ->> 'portraitKey') IS NULL) THEN
    RETURN NEW;
  END IF;
  SELECT c.asset_types INTO v_assets FROM consents c
   WHERE c.id = NEW.consent_id AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > now());
  IF (NEW.embodiment ->> 'voiceId') IS NOT NULL AND NOT coalesce('voice' = ANY (v_assets), false) THEN
    RAISE EXCEPTION 'an EIR persona can only have a voice when its consent covers voice'
      USING ERRCODE = '23514', CONSTRAINT = 'personas_embodiment_consent';
  END IF;
  IF (NEW.embodiment ->> 'portraitKey') IS NOT NULL AND NOT coalesce('likeness' = ANY (v_assets), false) THEN
    RAISE EXCEPTION 'an EIR persona can only have a portrait when its consent covers likeness'
      USING ERRCODE = '23514', CONSTRAINT = 'personas_embodiment_consent';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.personas_embodiment_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS personas_embodiment_consent ON personas;
CREATE TRIGGER personas_embodiment_consent BEFORE INSERT OR UPDATE OF embodiment, consent_id ON personas
  FOR EACH ROW EXECUTE FUNCTION app.personas_embodiment_guard();

-- The assets a persona's consent covers right now (empty when it has none, or it was revoked or expired): the
-- people a persona coaches learn whether its voice or likeness may be used without reading the consent record.
CREATE OR REPLACE FUNCTION app.persona_consent_assets(p_persona uuid) RETURNS text[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT c.asset_types FROM personas pe JOIN consents c ON c.id = pe.consent_id
                   WHERE pe.id = p_persona AND pe.tenant_id = app.current_tenant()
                     AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > now())),
                  '{}'::text[])
$$;
REVOKE ALL ON FUNCTION app.persona_consent_assets(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.persona_consent_assets(uuid) TO app_rls;

-- Consent stays the subject's own act. The one exception is a synthetic EIR (a fictional EIR profile used for
-- the pilot, whose principal cannot sign in): a program lead of the tenant records and revokes its consent.
CREATE OR REPLACE FUNCTION app.is_synthetic_eir(p_principal uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM principals pr
                 JOIN eir_profiles e ON e.principal_id = pr.id AND e.tenant_id = pr.tenant_id
                 WHERE pr.id = p_principal AND pr.tenant_id = app.current_tenant() AND pr.synthetic
                   AND e.synthetic)
$$;
REVOKE ALL ON FUNCTION app.is_synthetic_eir(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_synthetic_eir(uuid) TO app_rls;

DROP POLICY IF EXISTS consents_write ON consents;
CREATE POLICY consents_write ON consents FOR INSERT TO app_rls
  WITH CHECK (app.in_current_tenant(tenant_id)
              AND (subject_principal_id = app.current_principal()
                   OR (app.has_role('program_lead') AND app.is_synthetic_eir(subject_principal_id))));
DROP POLICY IF EXISTS consents_update ON consents;
CREATE POLICY consents_update ON consents FOR UPDATE TO app_rls
  USING (app.in_current_tenant(tenant_id)
         AND (subject_principal_id = app.current_principal()
              OR (app.has_role('program_lead') AND app.is_synthetic_eir(subject_principal_id))));

-- ---------------------------------------------------------------------------------------------------
-- 7. Usage, caps and quotas
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE usage_ledger DROP CONSTRAINT IF EXISTS usage_ledger_purpose_check;
ALTER TABLE usage_ledger ADD CONSTRAINT usage_ledger_purpose_check
  CHECK (purpose IN ('turn', 'recap', 'classification', 'embedding', 'ingestion', 'eval', 'seed', 'distill',
                     'speech'));

INSERT INTO platform_settings (key, value) VALUES
  ('max_call_minutes', '30'),
  ('daily_call_minutes_per_principal', '60')
ON CONFLICT (key) DO NOTHING;

-- When each spoken turn of the current principal was sent today (UTC), by conversation: the call-minute caps
-- are computed from these (calls are runs of spoken turns). Exposes no content.
CREATE OR REPLACE FUNCTION app.voice_turns_today() RETURNS TABLE (session_id uuid, at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.session_id, t.created_at FROM turns t
  WHERE t.author_id = app.current_principal() AND t.channel = 'voice'
    AND t.created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
  ORDER BY t.session_id, t.created_at
$$;
REVOKE ALL ON FUNCTION app.voice_turns_today() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.voice_turns_today() TO app_rls;

-- Documents (and their declared bytes) the current principal registered today (UTC), deleted ones included:
-- venture documents and uploads to shared corpora (persona knowledge libraries).
CREATE OR REPLACE FUNCTION app.upload_usage_today() RETURNS TABLE (documents bigint, bytes bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(sum(u.n), 0)::bigint, coalesce(sum(u.b), 0)::bigint
  FROM (
    SELECT count(*) AS n, sum(d.size_bytes) AS b FROM documents d
     WHERE d.uploaded_by = app.current_principal()
       AND d.created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
    UNION ALL
    SELECT count(*), sum(s.size_bytes) FROM knowledge_sources s
     WHERE s.created_by = app.current_principal() AND s.s3_key IS NOT NULL
       AND s.created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')) AS u
$$;
REVOKE ALL ON FUNCTION app.upload_usage_today() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.upload_usage_today() TO app_rls;
