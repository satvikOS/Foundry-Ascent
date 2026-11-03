-- Retiring an unapproved proposal preserves history; it does not turn it into an approved fact.
-- Keep the legacy auto-kept branch for a compatible code rollback.
ALTER TABLE memory_objects DROP CONSTRAINT IF EXISTS memory_objects_ai_approval_check;
ALTER TABLE memory_objects ADD CONSTRAINT memory_objects_ai_approval_check
  CHECK (origin <> 'ai' OR status IN ('proposed', 'rejected', 'expired', 'deleted', 'superseded')
    OR approved_by IS NOT NULL OR auto_kept_at IS NOT NULL);

-- Background semantic deduplication may discard an unreviewed proposal, never a human-approved item.
CREATE OR REPLACE FUNCTION app.discard_kept_memory(p_memory uuid, p_reason text, p_into uuid)
  RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  m      memory_objects%ROWTYPE;
  v_into uuid;
BEGIN
  IF p_reason IS NULL OR p_reason NOT IN ('duplicate', 'forgotten') THEN
    RAISE EXCEPTION 'invalid discard reason' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO m FROM memory_objects WHERE id = p_memory FOR UPDATE;
  IF NOT FOUND OR NOT app.in_current_tenant(m.tenant_id) OR NOT app.can_write_venture(m.venture_id)
     OR NOT app.can_see_item(m.venture_id, m.visibility, m.created_by)
     OR m.origin <> 'ai' OR m.approved_by IS NOT NULL OR m.status NOT IN ('proposed', 'confirmed')
     OR m.supersedes_id IS NOT NULL THEN
    RETURN 0;
  END IF;
  SELECT o.id INTO v_into FROM memory_objects o WHERE o.id = p_into AND o.venture_id = m.venture_id;
  UPDATE memory_objects
     SET status = 'deleted', title = '[deleted]', content = '', attributes = '{}'::jsonb,
         source_refs = '[]'::jsonb, embedding = NULL, pinned = false, updated_at = now()
   WHERE id = p_memory;
  UPDATE memory_events SET diff = '{"redacted": true}'::jsonb WHERE memory_id = p_memory;
  UPDATE turn_evidence SET title = '[deleted]' WHERE kind = 'memory' AND ref_id = p_memory;
  INSERT INTO memory_events (memory_id, venture_id, actor_id, action, diff)
  VALUES (p_memory, m.venture_id, app.current_principal(), 'deleted',
          jsonb_build_object('system', true, 'reason', p_reason, 'into', v_into));
  RETURN 1;
END
$$;
REVOKE ALL ON FUNCTION app.discard_kept_memory(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.discard_kept_memory(uuid, text, uuid) TO app_rls;

