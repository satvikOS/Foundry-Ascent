-- Foundry Ascent — RLS helper functions, audit determinism, idempotency request hashes.
--
-- 1. Soft deletes. The SELECT policies hide rows whose status is 'deleted', and PostgreSQL requires the
--    new version of an UPDATEd row to satisfy the SELECT policies whenever the statement reads the table
--    (WHERE / RETURNING). app_rls therefore cannot soft-delete memory objects or documents with a plain
--    UPDATE. These SECURITY DEFINER functions re-check the same predicates as the UPDATE policies.
-- 2. Escalation routing. Program leads hold an UPDATE policy on escalations but no SELECT policy (they see
--    queue metadata through app.escalation_queue()), so a direct UPDATE matches no rows.
--    app.route_escalation re-checks role, tenant and the founder's sharing consent.
-- 3. Audit chain determinism. The chained hash covers the event time rendered as text, which depends on
--    the session TimeZone and DateStyle; both are pinned on the writer and on the verifier.
-- 4. idempotency_keys.request_hash detects reuse of a key with a different request. Deleting memory or a
--    document also purges stored idempotent responses that mention it (they can hold its content for up to
--    24 h); a retry of such a request then executes again instead of replaying the deleted content.

-- ---------------------------------------------------------------------------------------------------
-- 1. Soft deletes
-- ---------------------------------------------------------------------------------------------------

-- Deletes a memory item and every earlier version it superseded: content is erased, history diffs and
-- evidence titles are redacted, stored idempotent responses that mention a version are purged, one
-- 'deleted' event per version is recorded. Returns the number of versions deleted, 0 when
-- the item does not exist or is not visible to the caller.
CREATE FUNCTION app.soft_delete_memory(p_memory uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  m     memory_objects%ROWTYPE;
  v_ids uuid[];
BEGIN
  SELECT * INTO m FROM memory_objects WHERE id = p_memory AND status <> 'deleted' FOR UPDATE;
  IF NOT FOUND OR NOT app.in_current_tenant(m.tenant_id)
     OR NOT app.can_see_item(m.venture_id, m.visibility, m.created_by) THEN
    RETURN 0;
  END IF;
  IF NOT app.can_write_venture(m.venture_id) THEN
    RAISE EXCEPTION 'memory delete requires founder or team membership' USING ERRCODE = '42501';
  END IF;

  WITH RECURSIVE chain (id, supersedes_id) AS (
    SELECT mo.id, mo.supersedes_id FROM memory_objects mo WHERE mo.id = p_memory
    UNION
    SELECT mo.id, mo.supersedes_id
    FROM memory_objects mo JOIN chain c ON mo.id = c.supersedes_id
    WHERE mo.venture_id = m.venture_id AND mo.status <> 'deleted'
  )
  SELECT array_agg(chain.id) INTO v_ids FROM chain;

  UPDATE memory_objects
     SET status = 'deleted', title = '[deleted]', content = '', attributes = '{}'::jsonb,
         source_refs = '[]'::jsonb, embedding = NULL, pinned = false, updated_at = now()
   WHERE id = ANY (v_ids);
  UPDATE memory_events SET diff = '{"redacted": true}'::jsonb WHERE memory_id = ANY (v_ids);
  UPDATE turn_evidence SET title = '[deleted]' WHERE kind = 'memory' AND ref_id = ANY (v_ids);
  DELETE FROM idempotency_keys k
   WHERE EXISTS (SELECT 1 FROM unnest(v_ids) AS v (id) WHERE strpos(k.response::text, v.id::text) > 0);
  INSERT INTO memory_events (memory_id, venture_id, actor_id, action, diff)
  SELECT v.id, m.venture_id, app.current_principal(), 'deleted', jsonb_build_object('versions', cardinality(v_ids))
  FROM unnest(v_ids) AS v (id);
  RETURN cardinality(v_ids);
END
$$;

-- Marks a document deleted, removes its chunks from retrieval (redacting evidence titles that cite them),
-- purges stored idempotent responses that mention it and withdraws its knowledge source.
-- Returns the S3 key to delete, or NULL when the document does not exist or is not visible.
CREATE FUNCTION app.soft_delete_document(p_document uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d documents%ROWTYPE;
BEGIN
  SELECT * INTO d FROM documents WHERE id = p_document AND status <> 'deleted' FOR UPDATE;
  IF NOT FOUND OR NOT app.in_current_tenant(d.tenant_id) OR NOT app.can_read_venture(d.venture_id) THEN
    RETURN NULL;
  END IF;
  IF NOT app.can_write_venture(d.venture_id) THEN
    RAISE EXCEPTION 'document delete requires founder or team membership' USING ERRCODE = '42501';
  END IF;
  UPDATE documents SET status = 'deleted', updated_at = now() WHERE id = p_document;
  DELETE FROM idempotency_keys WHERE strpos(response::text, p_document::text) > 0;
  IF d.source_id IS NOT NULL THEN
    UPDATE turn_evidence SET title = '[deleted]'
     WHERE kind = 'chunk' AND ref_id IN (SELECT c.id FROM knowledge_chunks c WHERE c.source_id = d.source_id);
    DELETE FROM knowledge_chunks WHERE source_id = d.source_id;
    UPDATE knowledge_sources SET status = 'withdrawn' WHERE id = d.source_id;
  END IF;
  RETURN d.s3_key;
END
$$;

-- ---------------------------------------------------------------------------------------------------
-- 2. Escalation routing by program leads
-- ---------------------------------------------------------------------------------------------------

CREATE FUNCTION app.route_escalation(p_escalation uuid, p_assignee uuid, p_due timestamptz) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  e escalations%ROWTYPE;
BEGIN
  IF NOT (app.has_role('program_lead') OR app.has_role('platform_admin')) THEN
    RAISE EXCEPTION 'routing requires program_lead' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO e FROM escalations WHERE id = p_escalation AND tenant_id = app.current_tenant() FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF e.sharing_consent_at IS NULL OR e.status NOT IN ('awaiting_consent', 'routed', 'acknowledged') THEN
    RAISE EXCEPTION 'escalation is not routable in its current state' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM principals pr
                 WHERE pr.id = p_assignee AND pr.tenant_id = e.tenant_id AND pr.status = 'active') THEN
    RAISE EXCEPTION 'assignee must be an active principal of the tenant' USING ERRCODE = '23503';
  END IF;
  UPDATE escalations
     SET assignee_principal_id = p_assignee, due_at = p_due, status = 'routed', updated_at = now()
   WHERE id = p_escalation;
  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION app.soft_delete_memory(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.soft_delete_document(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.route_escalation(uuid, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.soft_delete_memory(uuid) TO app_rls;
GRANT EXECUTE ON FUNCTION app.soft_delete_document(uuid) TO app_rls;
GRANT EXECUTE ON FUNCTION app.route_escalation(uuid, uuid, timestamptz) TO app_rls;

-- ---------------------------------------------------------------------------------------------------
-- 3. Audit chain determinism and verification (owner only)
-- ---------------------------------------------------------------------------------------------------

ALTER FUNCTION app.append_audit(uuid, uuid, uuid, text, text, text, text, text, text, jsonb) SET timezone = 'UTC';
ALTER FUNCTION app.append_audit(uuid, uuid, uuid, text, text, text, text, text, text, jsonb) SET datestyle = 'ISO, MDY';

-- Recomputes the chain for events with id > p_after_id (at most p_limit). first_broken_id is NULL when
-- every checked event links to its predecessor and its hash matches its contents.
CREATE FUNCTION app.verify_audit_chain(p_after_id bigint, p_limit integer)
  RETURNS TABLE (checked bigint, last_id bigint, first_broken_id bigint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp SET timezone = 'UTC' SET datestyle = 'ISO, MDY' AS $$
DECLARE
  r          audit_events%ROWTYPE;
  v_prev     text;
  v_expected text;
BEGIN
  checked := 0;
  last_id := p_after_id;
  first_broken_id := NULL;
  SELECT a.hash INTO v_prev FROM audit_events a WHERE a.id <= p_after_id ORDER BY a.id DESC LIMIT 1;
  v_prev := coalesce(v_prev, repeat('0', 64));
  FOR r IN SELECT * FROM audit_events a WHERE a.id > p_after_id ORDER BY a.id LIMIT p_limit LOOP
    v_expected := encode(digest(concat_ws('|', v_prev, r.tenant_id, r.venture_id, r.actor_id, r.action,
                                          r.object_type, r.object_id, r.outcome, r.policy_reason, r.request_id,
                                          r.metadata::text, r.at), 'sha256'), 'hex');
    IF r.prev_hash <> v_prev OR r.hash <> v_expected THEN
      first_broken_id := r.id;
      RETURN NEXT;
      RETURN;
    END IF;
    v_prev := r.hash;
    checked := checked + 1;
    last_id := r.id;
  END LOOP;
  RETURN NEXT;
END
$$;
REVOKE ALL ON FUNCTION app.verify_audit_chain(bigint, integer) FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------------
-- 4. Idempotency
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE idempotency_keys ADD COLUMN request_hash text;
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);
