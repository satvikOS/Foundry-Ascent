-- Foundry Ascent — the vEIR welcome per mentor: a person meets each mentor's introduction once, and again when the
-- mentor they meet is presented differently (ADR-0021: Corin's vEIR, a twin, became Thomas, a mentor).
-- Applied on top of 0001–0028 (there is no 0014); expand-only: nothing an older build reads or writes changes, and
-- every statement is re-runnable (IF NOT EXISTS, CREATE OR REPLACE, REVOKE and GRANT).
--
--  1. principals.veir_welcome_introductions: the introductions this person has read, each the key
--     '<persona id>:<presentation>' (@foundry/contracts `veirIntroductionKey`), newest last, at most 20. Empty for
--     everyone at first, so every founder meets their current mentor's introduction once more: someone who read
--     "Meet Corin's vEIR" (0016's one acknowledgement) now meets Thomas. Like 0016's column it is the person's own
--     setting and is not granted to app_rls (0010 granted app_rls only the columns principals had then), so nobody
--     reads or sets another person's value, staff included.
--  2. app.veir_welcome_introductions() reads the caller's own list; app.acknowledge_veir_introductions(keys) adds
--     the given keys for the caller only (a key already there is kept where it is), sets 0016's
--     veir_welcome_acknowledged_at the first time, and says whether anything was new: a key, or the first
--     acknowledgement (the API audits only then).
--     0016's functions are unchanged: an older build keeps reading and setting the single acknowledgement.

-- ---------------------------------------------------------------------------------------------------
-- 1. The column, closed to app_rls
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE principals ADD COLUMN IF NOT EXISTS veir_welcome_introductions text[] NOT NULL DEFAULT '{}';

-- ---------------------------------------------------------------------------------------------------
-- 2. The caller's own list
-- ---------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.veir_welcome_introductions() RETURNS text[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT pr.veir_welcome_introductions FROM principals pr
   WHERE pr.id = app.current_principal() AND pr.tenant_id = app.current_tenant()
$$;
REVOKE ALL ON FUNCTION app.veir_welcome_introductions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.veir_welcome_introductions() TO app_rls;

CREATE OR REPLACE FUNCTION app.acknowledge_veir_introductions(
  p_keys text[], OUT acknowledged_at timestamptz, OUT first_time boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  k text;
  kept text[];
  added boolean := false;
  unread boolean;
BEGIN
  IF p_keys IS NULL OR cardinality(p_keys) > 20 THEN
    RAISE EXCEPTION 'at most 20 introductions at once' USING ERRCODE = '22023';
  END IF;
  FOREACH k IN ARRAY p_keys LOOP
    IF k IS NULL OR k !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(twin|mentor)$' THEN
      RAISE EXCEPTION 'not an introduction key' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  SELECT pr.veir_welcome_introductions, pr.veir_welcome_acknowledged_at IS NULL INTO kept, unread
    FROM principals pr
   WHERE pr.id = app.current_principal() AND pr.tenant_id = app.current_tenant() AND pr.status = 'active'
     FOR UPDATE;
  IF NOT FOUND THEN
    acknowledged_at := NULL;
    first_time := false;
    RETURN;
  END IF;
  FOREACH k IN ARRAY p_keys LOOP
    IF NOT (k = ANY (kept)) THEN
      kept := array_append(kept, k);
      added := true;
    END IF;
  END LOOP;
  IF cardinality(kept) > 20 THEN
    kept := kept[cardinality(kept) - 19 :];
  END IF;

  UPDATE principals pr
     SET veir_welcome_introductions = kept,
         veir_welcome_acknowledged_at = coalesce(pr.veir_welcome_acknowledged_at, now())
   WHERE pr.id = app.current_principal() AND pr.tenant_id = app.current_tenant()
     AND (added OR unread);
  acknowledged_at := app.veir_welcome_acknowledged_at();
  first_time := added OR unread;
END
$$;
REVOKE ALL ON FUNCTION app.acknowledge_veir_introductions(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.acknowledge_veir_introductions(text[]) TO app_rls;
