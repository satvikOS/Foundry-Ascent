-- Foundry Ascent — the first-call privacy notice, acknowledged once per person.
-- Applied on top of 0001–0008 (it does not depend on 0009); expand-only: nothing an older build reads or writes
-- changes, and every statement is re-runnable (IF NOT EXISTS, CREATE OR REPLACE, REVOKE and GRANT).
--
--  1. principals.call_notice_acknowledged_at: when the person acknowledged how a call handles their voice (shown
--     before their first call), null until then. It is the person's own setting, so only they read or write it.
--     Row level security cannot hide one column of a row the whole tenant reads (names and titles), so app_rls
--     holds column privileges on principals instead of table-wide ones: SELECT, INSERT and UPDATE on every
--     column it had before, and none on this one. Nobody reads or sets another person's value, staff included.
--     A column added to principals later is closed to app_rls until it is granted here too.
--  2. app.call_notice_acknowledged_at() reads the caller's own value; app.acknowledge_call_notice() sets it for
--     the caller only, once (a repeat keeps the first time), and says whether this call set it (the API audits
--     the first acknowledgement only).

-- ---------------------------------------------------------------------------------------------------
-- 1. The column, closed to app_rls
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE principals ADD COLUMN IF NOT EXISTS call_notice_acknowledged_at timestamptz;

REVOKE SELECT, INSERT, UPDATE ON principals FROM app_rls;
GRANT SELECT (id, tenant_id, display_name, email, title, synthetic, status, created_at, updated_at)
  ON principals TO app_rls;
GRANT INSERT (id, tenant_id, display_name, email, title, synthetic, status, created_at, updated_at)
  ON principals TO app_rls;
GRANT UPDATE (id, tenant_id, display_name, email, title, synthetic, status, created_at, updated_at)
  ON principals TO app_rls;

-- ---------------------------------------------------------------------------------------------------
-- 2. The caller's own value
-- ---------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.call_notice_acknowledged_at() RETURNS timestamptz
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT pr.call_notice_acknowledged_at FROM principals pr
   WHERE pr.id = app.current_principal() AND pr.tenant_id = app.current_tenant()
$$;
REVOKE ALL ON FUNCTION app.call_notice_acknowledged_at() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.call_notice_acknowledged_at() TO app_rls;

CREATE OR REPLACE FUNCTION app.acknowledge_call_notice(OUT acknowledged_at timestamptz, OUT first_time boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE principals pr SET call_notice_acknowledged_at = now()
   WHERE pr.id = app.current_principal() AND pr.tenant_id = app.current_tenant()
     AND pr.status = 'active' AND pr.call_notice_acknowledged_at IS NULL
  RETURNING pr.call_notice_acknowledged_at INTO acknowledged_at;
  first_time := FOUND;
  IF NOT first_time THEN
    acknowledged_at := app.call_notice_acknowledged_at();
  END IF;
END
$$;
REVOKE ALL ON FUNCTION app.acknowledge_call_notice() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.acknowledge_call_notice() TO app_rls;
