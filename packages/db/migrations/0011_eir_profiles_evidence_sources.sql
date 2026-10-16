-- Foundry Ascent — EIR profiles made in the product, and the knowledge source behind each cited passage.
-- Applied on top of 0001–0010, which are live and never edited here. Expand-only: code written for the previous
-- schema keeps working (new columns are nullable, policies only admit more). Every statement is re-runnable
-- (ADD COLUMN IF NOT EXISTS, DROP … IF EXISTS before CREATE, guarded backfills and index).
--
--  1. EIR profiles. Until now only the seed created them. Program leads and platform admins now create and edit
--     them in the product: a profile names the real person a vEIR may be built from (display name, title,
--     expertise, a short bio) and is linked to the person's own account, someone of the same tenant. The insert
--     and update policies admitted program leads only; platform admins are added, and an insert may only link a
--     person of the caller's tenant. One profile per person: a unique index, created only where no person has
--     two profiles already (the service refuses a second one either way). A profile never implies consent:
--     consent stays the subject's own act, recorded on the vEIR (0004 §6), before any release can be approved.
--  2. The source of a cited passage. turn_evidence records, for a chunk or doctrine citation, the knowledge
--     source the passage came from and its scope (a venture document, or a program, public or persona library
--     source) at the time of the answer. Evidence then names its source by id instead of by title (the web
--     matched titles, so a program source titled like a venture file was counted as that file), and keeps
--     naming it after an edit replaces the source's chunks. Existing rows are backfilled from the chunks that
--     still exist; a passage whose chunk is gone (its document was deleted) stays unknown.

-- ---------------------------------------------------------------------------------------------------
-- 1. EIR profiles
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE eir_profiles ADD COLUMN IF NOT EXISTS bio text;
ALTER TABLE eir_profiles DROP CONSTRAINT IF EXISTS eir_profiles_bio_length;
ALTER TABLE eir_profiles ADD CONSTRAINT eir_profiles_bio_length CHECK (bio IS NULL OR length(bio) <= 2000);

DROP POLICY IF EXISTS eir_profiles_write ON eir_profiles;
CREATE POLICY eir_profiles_write ON eir_profiles FOR INSERT TO app_rls
  WITH CHECK (app.in_current_tenant(tenant_id)
              AND (app.has_role('program_lead') OR app.has_role('platform_admin'))
              AND (principal_id IS NULL OR app.principal_in_current_tenant(principal_id)));
DROP POLICY IF EXISTS eir_profiles_update ON eir_profiles;
CREATE POLICY eir_profiles_update ON eir_profiles FOR UPDATE TO app_rls
  USING (app.in_current_tenant(tenant_id)
         AND (app.has_role('program_lead') OR app.has_role('platform_admin')
              OR principal_id = app.current_principal()))
  WITH CHECK (app.in_current_tenant(tenant_id)
              AND (app.has_role('program_lead') OR app.has_role('platform_admin')
                   OR principal_id = app.current_principal()));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM eir_profiles WHERE principal_id IS NOT NULL
                 GROUP BY principal_id HAVING count(*) > 1) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS eir_profiles_principal_uq ON eir_profiles (principal_id)
      WHERE principal_id IS NOT NULL;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------------
-- 2. The knowledge source of a cited passage
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE turn_evidence ADD COLUMN IF NOT EXISTS source_id uuid;
ALTER TABLE turn_evidence ADD COLUMN IF NOT EXISTS source_scope text;
ALTER TABLE turn_evidence DROP CONSTRAINT IF EXISTS turn_evidence_source_scope_check;
ALTER TABLE turn_evidence ADD CONSTRAINT turn_evidence_source_scope_check
  CHECK (source_scope IS NULL OR source_scope IN ('venture', 'program', 'public', 'persona'));
-- Only passages have a source, and a source always has its scope.
ALTER TABLE turn_evidence DROP CONSTRAINT IF EXISTS turn_evidence_source_shape;
ALTER TABLE turn_evidence ADD CONSTRAINT turn_evidence_source_shape
  CHECK ((source_id IS NULL) = (source_scope IS NULL)
         AND (source_id IS NULL OR kind IN ('chunk', 'doctrine')));

UPDATE turn_evidence te
   SET source_id = c.source_id, source_scope = c.scope
  FROM knowledge_chunks c
 WHERE te.kind IN ('chunk', 'doctrine') AND c.id = te.ref_id AND te.source_id IS NULL;
