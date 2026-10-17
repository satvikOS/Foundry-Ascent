-- Foundry Ascent — the vEIR's presence: a one-time welcome that says what a vEIR is, and the consent scope that
-- lets a vEIR appear under its EIR's first name.
-- Applied on top of 0001–0015 (there is no 0014); expand-only: nothing an older build reads or writes changes, and
-- every statement is re-runnable (IF NOT EXISTS, DROP … IF EXISTS before ADD, CREATE OR REPLACE, REVOKE and GRANT).
--
--  1. consents.asset_types admits 'first_person': the EIR agrees that founders meet their vEIR under the EIR's
--     first name with a vEIR badge ("Corin · vEIR"), speaking in the first person as the EIR's digital twin.
--     Without it the vEIR stays "Corin's vEIR" and refers to the EIR in the third person. Consent stays the
--     subject's own act (0004's policies); app.persona_consent_assets() reports the new scope like the others.
--  2. principals.veir_welcome_acknowledged_at: when the person read the welcome that introduces their vEIR (the
--     disclosure, shown once, before their first conversation), null until then. Like 0010's call notice it is the
--     person's own setting: app_rls holds column privileges on principals (0010), and this column is not granted,
--     so nobody reads or sets another person's value, staff included.
--  3. app.veir_welcome_acknowledged_at() reads the caller's own value; app.acknowledge_veir_welcome() sets it for
--     the caller only, once (a repeat keeps the first time), and says whether this call set it (the API audits the
--     first acknowledgement only).

-- ---------------------------------------------------------------------------------------------------
-- 1. The first-person consent scope
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE consents DROP CONSTRAINT IF EXISTS consents_asset_types_check;
ALTER TABLE consents ADD CONSTRAINT consents_asset_types_check
  CHECK (asset_types <@ ARRAY['doctrine', 'style', 'voice', 'likeness', 'cases', 'first_person']::text[]);

-- ---------------------------------------------------------------------------------------------------
-- 2. The column, closed to app_rls (0010 granted app_rls only the columns it had then)
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE principals ADD COLUMN IF NOT EXISTS veir_welcome_acknowledged_at timestamptz;

-- ---------------------------------------------------------------------------------------------------
-- 3. The caller's own value
-- ---------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.veir_welcome_acknowledged_at() RETURNS timestamptz
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT pr.veir_welcome_acknowledged_at FROM principals pr
   WHERE pr.id = app.current_principal() AND pr.tenant_id = app.current_tenant()
$$;
REVOKE ALL ON FUNCTION app.veir_welcome_acknowledged_at() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.veir_welcome_acknowledged_at() TO app_rls;

CREATE OR REPLACE FUNCTION app.acknowledge_veir_welcome(OUT acknowledged_at timestamptz, OUT first_time boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE principals pr SET veir_welcome_acknowledged_at = now()
   WHERE pr.id = app.current_principal() AND pr.tenant_id = app.current_tenant()
     AND pr.status = 'active' AND pr.veir_welcome_acknowledged_at IS NULL
  RETURNING pr.veir_welcome_acknowledged_at INTO acknowledged_at;
  first_time := FOUND;
  IF NOT first_time THEN
    acknowledged_at := app.veir_welcome_acknowledged_at();
  END IF;
END
$$;
REVOKE ALL ON FUNCTION app.acknowledge_veir_welcome() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.acknowledge_veir_welcome() TO app_rls;
