-- Foundry Ascent — the founder path (owner, 2026-11-24).
-- Applied on top of 0001–0032 (there is no 0014); expand-only: nothing an older build reads or writes changes, and
-- every statement is re-runnable (IF NOT EXISTS, CREATE OR REPLACE, DROP … IF EXISTS before CREATE).
--
--  1. venture_paths: one row per venture: the stage the path has reached and what the founder told Thomas once (the
--     intake). Created by the first coaching turn that gives a step, or by the intake; a venture without a row is read
--     as its record says (core `path/`).
--  2. path_steps: the steps the path gave a venture. A step's id is derived from the venture, the play and how often
--     the play was already closed (core `path/ids.ts`), so the same step has the same id in every conversation, and two
--     turns that give it at once insert one row.
--  3. path_criteria: what the venture has shown of a stage (claimed in the founder's words, met by a finished step, or
--     reopened). A criterion the venture's record shows by itself is not stored.
--  4. turns.guidance: what the path decided for the turn (contract `TurnGuidance`), erased with the turn's other words.
--
-- Read by the venture's founders and team and its assigned EIR, as its conversations are (`sessions_read`); written by
-- founders and team. A program lead reads the path's shape only (stage, criteria statuses, step titles and statuses),
-- never a founder's words: app.path_overview.

CREATE TABLE IF NOT EXISTS venture_paths (
  venture_id       uuid PRIMARY KEY REFERENCES ventures (id),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  stage            text NOT NULL,
  intake           jsonb,
  intake_by        uuid REFERENCES principals (id),
  intake_at        timestamptz,
  playbook_version text NOT NULL,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT venture_paths_stage_check CHECK (stage IN ('idea', 'discovery', 'validation', 'business_model',
                                                        'commercialization', 'growth', 'transition')),
  CONSTRAINT venture_paths_intake_check CHECK (intake IS NULL OR jsonb_typeof(intake) = 'object'),
  CONSTRAINT venture_paths_version_check CHECK (version > 0)
);

CREATE TABLE IF NOT EXISTS path_steps (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants (id),
  venture_id        uuid NOT NULL REFERENCES ventures (id),
  play_id           text,
  criterion_id      text,
  title             text NOT NULL,
  items             jsonb NOT NULL,
  done_when         text NOT NULL,
  due_on            date,
  status            text NOT NULL,
  origin            text NOT NULL DEFAULT 'path',
  -- What the founder reported, in their words (completed), or why it was skipped or is blocked.
  evidence          text,
  reason            text,
  template          jsonb,
  citations         jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The person whose turn gave the step; a check-in is said to them.
  given_to          uuid REFERENCES principals (id),
  -- The conversation the evidence or reason was said in (its words go when it is deleted).
  source_session_id uuid REFERENCES coaching_sessions (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  completed_by      uuid REFERENCES principals (id),
  version           integer NOT NULL DEFAULT 1,
  CONSTRAINT path_steps_status_check CHECK (status IN ('now', 'next', 'later', 'done', 'skipped', 'blocked')),
  CONSTRAINT path_steps_origin_check CHECK (origin IN ('path', 'founder', 'coach')),
  CONSTRAINT path_steps_text_check CHECK (
    length(title) BETWEEN 1 AND 200 AND length(done_when) BETWEEN 1 AND 400
    AND (evidence IS NULL OR length(evidence) <= 1000) AND (reason IS NULL OR length(reason) <= 300)
    AND (play_id IS NULL OR length(play_id) <= 60) AND (criterion_id IS NULL OR length(criterion_id) <= 60)),
  CONSTRAINT path_steps_json_check CHECK (
    jsonb_typeof(items) = 'array' AND jsonb_array_length(items) <= 10 AND jsonb_typeof(citations) = 'array'
    AND (template IS NULL OR jsonb_typeof(template) = 'object')),
  CONSTRAINT path_steps_done_check CHECK ((status = 'done') = (completed_at IS NOT NULL)),
  CONSTRAINT path_steps_version_check CHECK (version > 0)
);
CREATE INDEX IF NOT EXISTS path_steps_venture_idx ON path_steps (venture_id, created_at DESC);
CREATE INDEX IF NOT EXISTS path_steps_session_idx ON path_steps (source_session_id)
  WHERE source_session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS path_criteria (
  venture_id        uuid NOT NULL REFERENCES ventures (id),
  criterion_id      text NOT NULL,
  tenant_id         uuid NOT NULL REFERENCES tenants (id),
  status            text NOT NULL,
  -- The founder's own words for it.
  evidence          text,
  step_id           uuid REFERENCES path_steps (id),
  source_session_id uuid REFERENCES coaching_sessions (id),
  updated_by        uuid REFERENCES principals (id),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venture_id, criterion_id),
  CONSTRAINT path_criteria_status_check CHECK (status IN ('open', 'claimed', 'met')),
  CONSTRAINT path_criteria_text_check CHECK (
    length(criterion_id) BETWEEN 1 AND 60 AND (evidence IS NULL OR length(evidence) <= 1000))
);
CREATE INDEX IF NOT EXISTS path_criteria_session_idx ON path_criteria (source_session_id)
  WHERE source_session_id IS NOT NULL;

-- A path's venture and tenant, and a step's identity, never change.
CREATE OR REPLACE FUNCTION app.path_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.venture_id <> OLD.venture_id OR NEW.tenant_id <> OLD.tenant_id THEN
    RAISE EXCEPTION 'a path stays with its venture' USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'path_steps' THEN
    IF NEW.id <> OLD.id OR NEW.play_id IS DISTINCT FROM OLD.play_id OR NEW.origin <> OLD.origin THEN
      RAISE EXCEPTION 'a step stays the step it was given as' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.path_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS venture_paths_guard ON venture_paths;
CREATE TRIGGER venture_paths_guard BEFORE UPDATE ON venture_paths
  FOR EACH ROW EXECUTE FUNCTION app.path_guard();
DROP TRIGGER IF EXISTS path_steps_guard ON path_steps;
CREATE TRIGGER path_steps_guard BEFORE UPDATE ON path_steps
  FOR EACH ROW EXECUTE FUNCTION app.path_guard();
DROP TRIGGER IF EXISTS path_criteria_guard ON path_criteria;
CREATE TRIGGER path_criteria_guard BEFORE UPDATE ON path_criteria
  FOR EACH ROW EXECUTE FUNCTION app.path_guard();

GRANT SELECT, INSERT, UPDATE ON venture_paths, path_steps, path_criteria TO app_rls;
ALTER TABLE venture_paths ENABLE ROW LEVEL SECURITY;
ALTER TABLE path_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE path_criteria ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS venture_paths_read ON venture_paths;
CREATE POLICY venture_paths_read ON venture_paths FOR SELECT TO app_rls
  USING (app.in_current_tenant(tenant_id) AND (app.can_write_venture(venture_id) OR app.is_assigned_eir(venture_id)));
DROP POLICY IF EXISTS venture_paths_insert ON venture_paths;
CREATE POLICY venture_paths_insert ON venture_paths FOR INSERT TO app_rls
  WITH CHECK (app.in_current_tenant(tenant_id) AND app.can_write_venture(venture_id));
DROP POLICY IF EXISTS venture_paths_update ON venture_paths;
CREATE POLICY venture_paths_update ON venture_paths FOR UPDATE TO app_rls
  USING (app.in_current_tenant(tenant_id) AND app.can_write_venture(venture_id))
  WITH CHECK (app.in_current_tenant(tenant_id) AND app.can_write_venture(venture_id));

DROP POLICY IF EXISTS path_steps_read ON path_steps;
CREATE POLICY path_steps_read ON path_steps FOR SELECT TO app_rls
  USING (app.in_current_tenant(tenant_id) AND (app.can_write_venture(venture_id) OR app.is_assigned_eir(venture_id)));
DROP POLICY IF EXISTS path_steps_insert ON path_steps;
CREATE POLICY path_steps_insert ON path_steps FOR INSERT TO app_rls
  WITH CHECK (app.in_current_tenant(tenant_id) AND app.can_write_venture(venture_id)
              AND (given_to IS NULL OR given_to = app.current_principal()));
DROP POLICY IF EXISTS path_steps_update ON path_steps;
CREATE POLICY path_steps_update ON path_steps FOR UPDATE TO app_rls
  USING (app.in_current_tenant(tenant_id) AND app.can_write_venture(venture_id))
  WITH CHECK (app.in_current_tenant(tenant_id) AND app.can_write_venture(venture_id));

DROP POLICY IF EXISTS path_criteria_read ON path_criteria;
CREATE POLICY path_criteria_read ON path_criteria FOR SELECT TO app_rls
  USING (app.in_current_tenant(tenant_id) AND (app.can_write_venture(venture_id) OR app.is_assigned_eir(venture_id)));
DROP POLICY IF EXISTS path_criteria_insert ON path_criteria;
CREATE POLICY path_criteria_insert ON path_criteria FOR INSERT TO app_rls
  WITH CHECK (app.in_current_tenant(tenant_id) AND app.can_write_venture(venture_id)
              AND updated_by = app.current_principal());
DROP POLICY IF EXISTS path_criteria_update ON path_criteria;
CREATE POLICY path_criteria_update ON path_criteria FOR UPDATE TO app_rls
  USING (app.in_current_tenant(tenant_id) AND app.can_write_venture(venture_id))
  WITH CHECK (app.in_current_tenant(tenant_id) AND app.can_write_venture(venture_id)
              AND updated_by = app.current_principal());

-- ---------------------------------------------------------------------------------------------------
-- A program lead's view: the shape of a path, never a founder's words
-- ---------------------------------------------------------------------------------------------------

-- No intake, no evidence, no reason, no arc; a step a founder or coach worded themselves shows without its title.
CREATE OR REPLACE FUNCTION app.path_overview(p_venture uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v ventures%ROWTYPE;
BEGIN
  IF NOT (app.has_role('program_lead') OR app.has_role('platform_admin')) THEN
    RAISE EXCEPTION 'path overview requires program_lead' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v FROM ventures WHERE id = p_venture AND tenant_id = app.current_tenant();
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object(
    'stage', (SELECT pa.stage FROM venture_paths pa WHERE pa.venture_id = v.id),
    'venture_stage', v.stage,
    'version', (SELECT pa.version FROM venture_paths pa WHERE pa.venture_id = v.id),
    'criteria', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('id', c.criterion_id, 'status', c.status) ORDER BY c.criterion_id), '[]'::jsonb)
      FROM path_criteria c WHERE c.venture_id = v.id),
    'steps', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'id', s.id, 'play_id', s.play_id, 'criterion_id', s.criterion_id, 'origin', s.origin,
               'title', CASE WHEN s.origin = 'path' THEN s.title ELSE 'A step the team set' END,
               'due_on', s.due_on, 'status', s.status, 'completed_at', s.completed_at, 'version', s.version,
               'created_at', s.created_at) ORDER BY s.created_at, s.id), '[]'::jsonb)
      FROM (SELECT * FROM path_steps x WHERE x.venture_id = v.id ORDER BY x.created_at DESC, x.id LIMIT 40) s));
END
$$;
REVOKE ALL ON FUNCTION app.path_overview(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.path_overview(uuid) TO app_rls;

-- ---------------------------------------------------------------------------------------------------
-- The turn's guidance, and what leaves with a deleted conversation
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE turns ADD COLUMN IF NOT EXISTS guidance jsonb;

-- A turn whose words are erased (a deleted conversation, an ended temporary chat) keeps no guidance either.
CREATE OR REPLACE FUNCTION app.turns_redact_guidance() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  NEW.guidance := NULL;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.turns_redact_guidance() FROM PUBLIC;
DROP TRIGGER IF EXISTS turns_redact_guidance ON turns;
CREATE TRIGGER turns_redact_guidance BEFORE UPDATE OF founder_text ON turns
  FOR EACH ROW WHEN (NEW.founder_text IS DISTINCT FROM OLD.founder_text)
  EXECUTE FUNCTION app.turns_redact_guidance();

-- A deleted conversation takes the words the path kept from it (what was done stays done): SECURITY DEFINER, as the
-- recordings' trigger is.
CREATE OR REPLACE FUNCTION app.path_follow_session() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE path_steps SET evidence = NULL, reason = NULL, source_session_id = NULL, updated_at = now()
   WHERE source_session_id = NEW.id;
  UPDATE path_criteria SET evidence = NULL, source_session_id = NULL, updated_at = now()
   WHERE source_session_id = NEW.id;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.path_follow_session() FROM PUBLIC;
DROP TRIGGER IF EXISTS path_follow_session ON coaching_sessions;
CREATE TRIGGER path_follow_session AFTER UPDATE OF deleted_at ON coaching_sessions
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION app.path_follow_session();
