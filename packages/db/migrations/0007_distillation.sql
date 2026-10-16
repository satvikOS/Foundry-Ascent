-- Foundry Ascent — distillation and memory hygiene (how the specific pool grows from conversations).
-- Needs 0001–0004 only (independent of 0005 and 0006). Expand-only: code that predates this file keeps working on
-- the new schema.
--
-- Every statement is re-runnable (CREATE OR REPLACE, DROP … IF EXISTS before CREATE, ADD COLUMN IF NOT EXISTS),
-- so applying the file twice leaves the same schema.
--
--  1. AI memory proposals may expire. The 0001 CHECK forbids durable AI memory without a person's approval;
--     it is kept and only widened to let an unapproved proposal become `expired` (daily maintenance expires
--     proposals nobody acted on for 30 days). An index serves that scan.
--  2. The vEIR notebook records which lines a person edited since the last distillation (`person_edits`),
--     maintained by a trigger from the content change itself. Distillation keeps those lines exactly as the
--     person left them; its own write clears the list. The same trigger records the version of the vEIR's
--     last write (`veir_version`), so a distillation can tell another distillation's write from a person's
--     edit.
--  3. A distillation claims its conversation before the model call (`distill_claim_id`, `distill_claimed_until`):
--     the jobs a conversation's triggers queue may overlap, and only one of them pays for a model call.
--  4. Lesson drafts record the conversation they were distilled from (`patterns.source_session_id`); deleting
--     the conversation withdraws the drafts nobody has taken up for review yet.

-- ---------------------------------------------------------------------------------------------------
-- 1. AI proposals may expire
-- ---------------------------------------------------------------------------------------------------

-- The 0001 constraint is unnamed (auto-named by PostgreSQL), so it is found by its definition.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT con.conname FROM pg_constraint con
     WHERE con.conrelid = 'public.memory_objects'::regclass AND con.contype = 'c'
       AND con.conname <> 'memory_objects_ai_approval_check'
       AND pg_get_constraintdef(con.oid) LIKE '%origin <> ''ai''%'
  LOOP
    EXECUTE format('ALTER TABLE public.memory_objects DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$$;

-- Still no durable memory from a model inference alone (blueprint 02 §5): an AI item is a proposal, rejected,
-- expired or deleted unless a person approved it.
ALTER TABLE memory_objects DROP CONSTRAINT IF EXISTS memory_objects_ai_approval_check;
ALTER TABLE memory_objects ADD CONSTRAINT memory_objects_ai_approval_check
  CHECK (origin <> 'ai' OR status IN ('proposed', 'rejected', 'expired', 'deleted') OR approved_by IS NOT NULL);

-- Daily expiry of stale AI proposals (by last activity: a proposal raised again stays fresh).
CREATE INDEX IF NOT EXISTS memory_objects_ai_proposals_idx
  ON memory_objects (updated_at) WHERE origin = 'ai' AND status = 'proposed';

-- ---------------------------------------------------------------------------------------------------
-- 2. Lines a person edited since the last distillation
-- ---------------------------------------------------------------------------------------------------

-- Entry and commitment ids, plus "summary" / "nextOpener", that a person wrote or changed since the vEIR last
-- wrote the notebook. Ids only, never text.
ALTER TABLE veir_notebooks ADD COLUMN IF NOT EXISTS person_edits jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE veir_notebooks DROP CONSTRAINT IF EXISTS veir_notebooks_person_edits_check;
ALTER TABLE veir_notebooks ADD CONSTRAINT veir_notebooks_person_edits_check
  CHECK (jsonb_typeof(person_edits) = 'array' AND jsonb_array_length(person_edits) <= 200);

-- The notebook version the vEIR (distillation) last wrote; 0 before its first write.
ALTER TABLE veir_notebooks ADD COLUMN IF NOT EXISTS veir_version integer NOT NULL DEFAULT 0;
ALTER TABLE veir_notebooks DROP CONSTRAINT IF EXISTS veir_notebooks_veir_version_check;
ALTER TABLE veir_notebooks ADD CONSTRAINT veir_notebooks_veir_version_check CHECK (veir_version >= 0);

-- Computes `person_edits` and `veir_version` on every write, whatever the writer sends:
-- - a write by the vEIR (distillation) clears the edits (they were respected by the write itself) and records
--   its version;
-- - a write by a person adds every entry or commitment that is new or differs from before, the summary when it
--   was rewritten (not when it was cleared) and the opener when it was set (not when it was removed). A removed
--   line needs no mark: it is gone, and its fingerprint is in `suppressed`.
-- Only ids that still exist are kept.
CREATE OR REPLACE FUNCTION app.notebook_track_person_edits() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_old  jsonb := CASE WHEN TG_OP = 'UPDATE' THEN OLD.content ELSE '{}'::jsonb END;
  v_pins jsonb := CASE WHEN TG_OP = 'UPDATE' THEN OLD.person_edits ELSE '[]'::jsonb END;
BEGIN
  NEW.veir_version := CASE WHEN TG_OP = 'UPDATE' THEN OLD.veir_version ELSE 0 END;
  IF NEW.last_edited_by IS DISTINCT FROM 'person' THEN
    NEW.person_edits := '[]'::jsonb;
    IF NEW.last_edited_by = 'veir' THEN
      NEW.veir_version := NEW.version;
    END IF;
    RETURN NEW;
  END IF;
  IF jsonb_typeof(v_pins) IS DISTINCT FROM 'array' THEN
    v_pins := '[]'::jsonb;
  END IF;
  IF coalesce(NEW.content ->> 'summary', '') <> ''
     AND (NEW.content -> 'summary') IS DISTINCT FROM (v_old -> 'summary') THEN
    v_pins := v_pins || '["summary"]'::jsonb;
  END IF;
  IF jsonb_typeof(NEW.content -> 'nextOpener') = 'string'
     AND (NEW.content -> 'nextOpener') IS DISTINCT FROM (v_old -> 'nextOpener') THEN
    v_pins := v_pins || '["nextOpener"]'::jsonb;
  END IF;
  SELECT v_pins || coalesce(jsonb_agg(e.item -> 'id'), '[]'::jsonb) INTO v_pins
    FROM unnest(ARRAY['founderProfile', 'commitments', 'openQuestions', 'lastAdvice']) AS s (section)
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(NEW.content -> s.section) = 'array' THEN NEW.content -> s.section
           ELSE '[]'::jsonb END) AS e (item)
   WHERE NOT EXISTS (
     SELECT 1 FROM jsonb_array_elements(
       CASE WHEN jsonb_typeof(v_old -> s.section) = 'array' THEN v_old -> s.section ELSE '[]'::jsonb END) AS o (item)
      WHERE o.item = e.item);
  SELECT coalesce(jsonb_agg(DISTINCT p.pin), '[]'::jsonb) INTO NEW.person_edits
    FROM jsonb_array_elements(v_pins) AS p (pin)
   WHERE jsonb_typeof(p.pin) = 'string'
     AND ((p.pin = '"summary"'::jsonb AND coalesce(NEW.content ->> 'summary', '') <> '')
          OR (p.pin = '"nextOpener"'::jsonb AND jsonb_typeof(NEW.content -> 'nextOpener') = 'string')
          OR EXISTS (
            SELECT 1
              FROM unnest(ARRAY['founderProfile', 'commitments', 'openQuestions', 'lastAdvice']) AS s (section)
              CROSS JOIN LATERAL jsonb_array_elements(
                CASE WHEN jsonb_typeof(NEW.content -> s.section) = 'array' THEN NEW.content -> s.section
                     ELSE '[]'::jsonb END) AS e (item)
             WHERE e.item -> 'id' = p.pin));
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.notebook_track_person_edits() FROM PUBLIC;
DROP TRIGGER IF EXISTS veir_notebooks_track_person_edits ON veir_notebooks;
CREATE TRIGGER veir_notebooks_track_person_edits BEFORE INSERT OR UPDATE ON veir_notebooks
  FOR EACH ROW EXECUTE FUNCTION app.notebook_track_person_edits();

-- ---------------------------------------------------------------------------------------------------
-- 3. One distillation at a time per conversation
-- ---------------------------------------------------------------------------------------------------

-- Taken by a conditional UPDATE before the model call and released after the write; a run that never releases
-- it (the process died) frees it when `distill_claimed_until` passes, which is after any run's deadline.
ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS distill_claim_id uuid;
ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS distill_claimed_until timestamptz;

-- ---------------------------------------------------------------------------------------------------
-- 4. Lesson drafts remember their conversation
-- ---------------------------------------------------------------------------------------------------

-- Ids only: the draft itself is de-identified and never names the conversation.
ALTER TABLE patterns ADD COLUMN IF NOT EXISTS source_session_id uuid REFERENCES coaching_sessions (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS patterns_source_session_idx ON patterns (source_session_id) WHERE source_session_id IS NOT NULL;

-- Deleting a conversation removes everything the vEIR drew from it (app.soft_delete_session): its lesson drafts
-- that are still drafts are withdrawn too. A draft a curator already took into review stays with the curator.
CREATE OR REPLACE FUNCTION app.withdraw_distilled_drafts() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE patterns p SET status = 'withdrawn', updated_at = now()
   WHERE p.source_session_id = NEW.id AND p.origin = 'distilled' AND p.status = 'draft';
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.withdraw_distilled_drafts() FROM PUBLIC;
DROP TRIGGER IF EXISTS coaching_sessions_withdraw_distilled_drafts ON coaching_sessions;
CREATE TRIGGER coaching_sessions_withdraw_distilled_drafts AFTER UPDATE OF deleted_at ON coaching_sessions
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION app.withdraw_distilled_drafts();
