-- Foundry Ascent — security hardening (review of 2026-10-05). Applied on top of 0001 and 0002, which are
-- already live and checksummed: they are never edited; every change lives here.
--
-- Every statement is re-runnable (CREATE OR REPLACE, DROP … IF EXISTS before CREATE, ON CONFLICT DO
-- NOTHING, idempotent UPDATE/DELETE), so applying the file twice leaves the same schema (db test).
--
--  1. founder_private memory never reaches anything other people read. Turn evidence may not cite a
--     founder_private item (insert policy); existing evidence rows that do are removed, the turns that used
--     them are withdrawn from EIR review, AI memory candidates derived from them become founder_private,
--     recap evidence titles and shared escalation facts naming them are removed.
--  2. Ephemeral sessions: never readable through EIR review (turns_read), existing samples withdrawn.
--  3. RLS gaps: knowledge_chunks_insert mirrors knowledge_sources_insert and requires the chunk's
--     tenant/scope/venture/persona to match its source; eir_reviews_read is tenant-scoped; role grants and
--     memberships may only be written for principals of the current tenant.
--  4. Venture names: unique per tenant (case-insensitive, trimmed) for every new or changed name; program
--     leads and platform admins rename any venture of their tenant through app.rename_venture.
--  5. Sharing consent on an escalation can only be recorded by the person who created it (its subject).
--  6. Helpers for atomic per-principal limits: spend-cap state of the current principal (turns) and the
--     current principal's uploads today (presign quota), plus the quota defaults in platform_settings.
--
-- New functions are created with EXECUTE revoked from PUBLIC (PostgreSQL grants it by default) and granted
-- to app_rls only where a request needs them.

-- ---------------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------------

-- True when (p_kind, p_ref) is turn evidence that cites a founder_private memory item.
CREATE OR REPLACE FUNCTION app.is_founder_private_memory(p_kind text, p_ref uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p_kind = 'memory' AND EXISTS (
    SELECT 1 FROM memory_objects m WHERE m.id = p_ref AND m.visibility = 'founder_private')
$$;

CREATE OR REPLACE FUNCTION app.session_is_ephemeral(p_session uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM coaching_sessions s WHERE s.id = p_session AND s.privacy = 'ephemeral')
$$;

CREATE OR REPLACE FUNCTION app.principal_in_current_tenant(p_principal uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM principals pr WHERE pr.id = p_principal AND pr.tenant_id = app.current_tenant())
$$;

CREATE OR REPLACE FUNCTION app.venture_in_current_tenant(p_venture uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM ventures v WHERE v.id = p_venture AND v.tenant_id = app.current_tenant())
$$;

-- A chunk must carry exactly its source's tenant, scope, venture and persona, and the source must still be
-- usable (not withdrawn).
CREATE OR REPLACE FUNCTION app.chunk_matches_source(
  p_source uuid, p_tenant uuid, p_scope text, p_venture uuid, p_persona uuid
) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM knowledge_sources s
    WHERE s.id = p_source AND s.tenant_id = p_tenant AND s.scope = p_scope
      AND s.venture_id IS NOT DISTINCT FROM p_venture
      AND s.persona_id IS NOT DISTINCT FROM p_persona
      AND s.status <> 'withdrawn')
$$;

REVOKE ALL ON FUNCTION app.is_founder_private_memory(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.session_is_ephemeral(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.principal_in_current_tenant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.venture_in_current_tenant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.chunk_matches_source(uuid, uuid, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_founder_private_memory(text, uuid) TO app_rls;
GRANT EXECUTE ON FUNCTION app.session_is_ephemeral(uuid) TO app_rls;
GRANT EXECUTE ON FUNCTION app.principal_in_current_tenant(uuid) TO app_rls;
GRANT EXECUTE ON FUNCTION app.venture_in_current_tenant(uuid) TO app_rls;
GRANT EXECUTE ON FUNCTION app.chunk_matches_source(uuid, uuid, text, uuid, uuid) TO app_rls;

-- ---------------------------------------------------------------------------------------------------
-- 1. founder_private memory: turn evidence, legacy clean-up
-- ---------------------------------------------------------------------------------------------------

DROP POLICY IF EXISTS turn_evidence_insert ON turn_evidence;
CREATE POLICY turn_evidence_insert ON turn_evidence FOR INSERT TO app_rls
  WITH CHECK (EXISTS (SELECT 1 FROM turns t WHERE t.id = turn_id AND app.can_write_venture(t.venture_id))
              AND NOT app.is_founder_private_memory(kind, ref_id));

-- Turns that cited a founder_private item leave the EIR review queue (sampled turns are shared with the
-- assigned EIR).
UPDATE turns t SET sampled_for_review = false
 WHERE t.sampled_for_review
   AND EXISTS (SELECT 1 FROM turn_evidence te
               JOIN memory_objects m ON m.id = te.ref_id
               WHERE te.turn_id = t.id AND te.kind = 'memory' AND m.visibility = 'founder_private');

-- AI memory candidates still awaiting review that came from such a turn or session, or cite such an item,
-- become founder_private (visible to their creator only) instead of team.
UPDATE memory_objects c SET visibility = 'founder_private', updated_at = now()
 WHERE c.origin = 'ai' AND c.status = 'proposed' AND c.visibility <> 'founder_private'
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.source_refs) = 'array'
                                             THEN c.source_refs ELSE '[]'::jsonb END) AS r (ref)
     WHERE (r.ref ->> 'kind' = 'memory' AND EXISTS (
              SELECT 1 FROM memory_objects m
              WHERE m.id::text = r.ref ->> 'id' AND m.visibility = 'founder_private'))
        OR (r.ref ->> 'kind' = 'turn' AND EXISTS (
              SELECT 1 FROM turn_evidence te JOIN memory_objects m ON m.id = te.ref_id
              WHERE te.turn_id::text = r.ref ->> 'id' AND te.kind = 'memory'
                AND m.visibility = 'founder_private'))
        OR (r.ref ->> 'kind' = 'session' AND EXISTS (
              SELECT 1 FROM turns t
              JOIN turn_evidence te ON te.turn_id = t.id AND te.kind = 'memory'
              JOIN memory_objects m ON m.id = te.ref_id
              WHERE t.session_id::text = r.ref ->> 'id' AND m.visibility = 'founder_private')));

-- Session recaps: drop evidence entries whose title is a founder_private item of the venture.
UPDATE coaching_sessions s
   SET recap = jsonb_set(s.recap, '{evidence}', coalesce((
         SELECT jsonb_agg(e.item ORDER BY e.n)
         FROM jsonb_array_elements(s.recap -> 'evidence') WITH ORDINALITY AS e (item, n)
         WHERE NOT EXISTS (SELECT 1 FROM memory_objects m
                           WHERE m.venture_id = s.venture_id AND m.visibility = 'founder_private'
                             AND m.title = e.item ->> 'title')), '[]'::jsonb))
 WHERE s.recap IS NOT NULL AND jsonb_typeof(s.recap -> 'evidence') = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.recap -> 'evidence') AS e (item)
               JOIN memory_objects m ON m.venture_id = s.venture_id AND m.visibility = 'founder_private'
                                    AND m.title = e.item ->> 'title');

-- Escalation packets are read by the whole venture team and the assignee: no founder_private facts.
UPDATE escalations x
   SET packet = jsonb_set(x.packet, '{sharedFacts}', coalesce((
         SELECT jsonb_agg(f.item ORDER BY f.n)
         FROM jsonb_array_elements(x.packet -> 'sharedFacts') WITH ORDINALITY AS f (item, n)
         WHERE NOT EXISTS (SELECT 1 FROM memory_objects m
                           WHERE m.id::text = f.item ->> 'memoryId' AND m.visibility = 'founder_private')),
         '[]'::jsonb)),
       updated_at = now()
 WHERE jsonb_typeof(x.packet -> 'sharedFacts') = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(x.packet -> 'sharedFacts') AS f (item)
               JOIN memory_objects m ON m.id::text = f.item ->> 'memoryId'
               WHERE m.visibility = 'founder_private');

-- Finally the evidence rows themselves (their titles were readable by everyone who could read the turn).
DELETE FROM turn_evidence te
 USING memory_objects m
 WHERE te.kind = 'memory' AND m.id = te.ref_id AND m.visibility = 'founder_private';

-- ---------------------------------------------------------------------------------------------------
-- 2. Ephemeral sessions are never part of EIR review
-- ---------------------------------------------------------------------------------------------------

DROP POLICY IF EXISTS turns_read ON turns;
CREATE POLICY turns_read ON turns FOR SELECT TO app_rls
  USING (app.in_current_tenant(tenant_id) AND (app.can_write_venture(venture_id)
         OR (sampled_for_review AND app.is_assigned_eir(venture_id) AND NOT app.session_is_ephemeral(session_id))));

UPDATE turns SET sampled_for_review = false
 WHERE sampled_for_review
   AND session_id IN (SELECT s.id FROM coaching_sessions s WHERE s.privacy = 'ephemeral');

-- ---------------------------------------------------------------------------------------------------
-- 3. RLS gaps
-- ---------------------------------------------------------------------------------------------------

DROP POLICY IF EXISTS knowledge_chunks_insert ON knowledge_chunks;
CREATE POLICY knowledge_chunks_insert ON knowledge_chunks FOR INSERT TO app_rls
  WITH CHECK (app.in_current_tenant(tenant_id)
              AND app.chunk_matches_source(source_id, tenant_id, scope, venture_id, persona_id)
              AND CASE scope
                    WHEN 'venture' THEN app.can_write_venture(venture_id)
                    ELSE app.has_role('program_lead') OR app.has_role('eir') END);

DROP POLICY IF EXISTS eir_reviews_read ON eir_reviews;
CREATE POLICY eir_reviews_read ON eir_reviews FOR SELECT TO app_rls
  USING (app.venture_in_current_tenant(venture_id)
         AND (reviewer_id = app.current_principal() OR app.has_role('program_lead')));

DROP POLICY IF EXISTS role_grants_insert ON role_grants;
CREATE POLICY role_grants_insert ON role_grants FOR INSERT TO app_rls
  WITH CHECK (app.principal_in_current_tenant(principal_id)
              AND (tenant_id IS NULL OR app.in_current_tenant(tenant_id))
              AND (app.has_role('platform_admin')
                   OR (app.has_role('program_lead') AND app.in_current_tenant(tenant_id) AND role = 'eir')));

DROP POLICY IF EXISTS role_grants_update ON role_grants;
CREATE POLICY role_grants_update ON role_grants FOR UPDATE TO app_rls
  USING (app.principal_in_current_tenant(principal_id)
         AND (app.has_role('platform_admin')
              OR (app.has_role('program_lead') AND app.in_current_tenant(tenant_id) AND role = 'eir')));

DROP POLICY IF EXISTS memberships_insert ON venture_memberships;
CREATE POLICY memberships_insert ON venture_memberships FOR INSERT TO app_rls
  WITH CHECK (app.has_role('program_lead') AND app.venture_in_current_tenant(venture_id)
              AND app.principal_in_current_tenant(principal_id));

DROP POLICY IF EXISTS memberships_update ON venture_memberships;
CREATE POLICY memberships_update ON venture_memberships FOR UPDATE TO app_rls
  USING (app.has_role('program_lead') AND app.venture_in_current_tenant(venture_id)
         AND app.principal_in_current_tenant(principal_id));

-- ---------------------------------------------------------------------------------------------------
-- 4. Venture names
-- ---------------------------------------------------------------------------------------------------

-- AFTER trigger: runs once the row passed RLS, so it never answers for a write the caller may not make.
-- Serialised per tenant; only new or changed names are checked (an existing duplicate is left alone until
-- one of the two is renamed).
CREATE OR REPLACE FUNCTION app.ventures_name_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF lower(btrim(NEW.name)) = lower(btrim(OLD.name)) THEN
      RETURN NULL;
    END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(7012028, hashtext(NEW.tenant_id::text));
  IF EXISTS (SELECT 1 FROM ventures v
             WHERE v.tenant_id = NEW.tenant_id AND v.id <> NEW.id
               AND lower(btrim(v.name)) = lower(btrim(NEW.name))) THEN
    -- The message names the constraint like a unique index would: the RDS Data API reports only the
    -- message and SQLSTATE (no constraint field), and the API maps this violation by that name.
    RAISE EXCEPTION 'duplicate key value violates unique constraint "ventures_tenant_name_unique"'
      USING ERRCODE = '23505', CONSTRAINT = 'ventures_tenant_name_unique',
            DETAIL = 'Another venture of this tenant already uses this name.';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.ventures_name_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS ventures_name_unique ON ventures;
CREATE TRIGGER ventures_name_unique AFTER INSERT OR UPDATE OF name ON ventures
  FOR EACH ROW EXECUTE FUNCTION app.ventures_name_guard();

-- Program staff rename any venture of their tenant (they have no SELECT on other ventures' content, and
-- platform admins without program_lead see no ventures at all under RLS). Name rules (length, distinctive
-- words) are validated by the service; uniqueness by the trigger above.
CREATE OR REPLACE FUNCTION app.rename_venture(p_venture uuid, p_name text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT (app.has_role('program_lead') OR app.has_role('platform_admin')) THEN
    RAISE EXCEPTION 'renaming ventures requires program_lead or platform_admin' USING ERRCODE = '42501';
  END IF;
  IF p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 3 AND 80 THEN
    RAISE EXCEPTION 'venture names are 3 to 80 characters' USING ERRCODE = '23514';
  END IF;
  UPDATE ventures SET name = btrim(p_name), updated_at = now()
   WHERE id = p_venture AND tenant_id = app.current_tenant();
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION app.rename_venture(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.rename_venture(uuid, text) TO app_rls;

-- ---------------------------------------------------------------------------------------------------
-- 5. Sharing consent is the escalation subject's decision
-- ---------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.escalations_consent_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.sharing_consent_at IS NULL AND NEW.sharing_consent_at IS NOT NULL
     AND NEW.sharing_consent_by IS DISTINCT FROM NEW.created_by THEN
    RAISE EXCEPTION 'only the person who created an escalation can consent to sharing it'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.escalations_consent_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS escalations_consent_by_subject ON escalations;
CREATE TRIGGER escalations_consent_by_subject BEFORE UPDATE ON escalations
  FOR EACH ROW EXECUTE FUNCTION app.escalations_consent_guard();

-- ---------------------------------------------------------------------------------------------------
-- 6. Per-principal limits evaluated atomically with the write they guard
-- ---------------------------------------------------------------------------------------------------

-- Daily spend of the platform and of the current principal against the caps the caller read from
-- platform_settings: 'global', 'principal' or NULL (within both). Exposes no amounts.
CREATE OR REPLACE FUNCTION app.spend_cap_state(p_global_cap numeric, p_principal_cap numeric) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH today AS (
    SELECT coalesce(sum(u.cost_usd), 0) AS global_usd,
           coalesce(sum(u.cost_usd) FILTER (WHERE u.principal_id = app.current_principal()), 0) AS principal_usd
    FROM usage_ledger u
    WHERE u.at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))
  SELECT CASE WHEN today.global_usd >= p_global_cap THEN 'global'
              WHEN today.principal_usd >= p_principal_cap THEN 'principal' END
  FROM today
$$;
REVOKE ALL ON FUNCTION app.spend_cap_state(numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.spend_cap_state(numeric, numeric) TO app_rls;

-- Documents (and their declared bytes) the current principal registered today (UTC), deleted ones included.
CREATE OR REPLACE FUNCTION app.upload_usage_today() RETURNS TABLE (documents bigint, bytes bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*), coalesce(sum(d.size_bytes), 0)::bigint
  FROM documents d
  WHERE d.uploaded_by = app.current_principal()
    AND d.created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
$$;
REVOKE ALL ON FUNCTION app.upload_usage_today() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.upload_usage_today() TO app_rls;

INSERT INTO platform_settings (key, value) VALUES
  ('daily_upload_documents_per_principal', '20'),
  ('daily_upload_bytes_per_principal', '52428800')
ON CONFLICT (key) DO NOTHING;
