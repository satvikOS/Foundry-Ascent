-- Withdrawing or correcting memory also withdraws generated continuity drawn from its source sessions.
-- Conversation transcripts remain reviewable. digest_deleted_at fences background distillation under its
-- existing row lock, so a job started before this transaction cannot restore the old summary.
CREATE OR REPLACE FUNCTION app.invalidate_memory_continuity(p_memory uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  m memory_objects%ROWTYPE;
  s coaching_sessions%ROWTYPE;
  p_session uuid;
  v_persona uuid;
  v_distilled boolean;
  v_id jsonb;
BEGIN
  SELECT * INTO m FROM memory_objects WHERE id = p_memory AND status <> 'deleted';
  IF NOT FOUND OR NOT app.in_current_tenant(m.tenant_id)
     OR NOT app.can_see_item(m.venture_id, m.visibility, m.created_by) THEN RETURN; END IF;
  IF NOT app.can_write_venture(m.venture_id) THEN
    RAISE EXCEPTION 'memory continuity changes require venture membership' USING ERRCODE = '42501';
  END IF;
  FOR p_session IN
    WITH RECURSIVE chain AS (
      SELECT mo.id, mo.supersedes_id, mo.source_refs FROM memory_objects mo WHERE mo.id = p_memory
      UNION
      SELECT mo.id, mo.supersedes_id, mo.source_refs FROM memory_objects mo JOIN chain c ON mo.id = c.supersedes_id
       WHERE mo.venture_id = m.venture_id AND mo.status <> 'deleted'
    ), refs AS (
      SELECT r.ref ->> 'kind' AS kind, CAST(r.ref ->> 'id' AS uuid) AS id FROM chain c
      CROSS JOIN LATERAL jsonb_array_elements(c.source_refs) r(ref)
      WHERE r.ref ->> 'kind' IN ('session', 'turn') AND app.is_contract_uuid(r.ref ->> 'id')
    )
    SELECT cs.id FROM coaching_sessions cs WHERE cs.venture_id = m.venture_id
      AND cs.privacy = 'standard' AND cs.deleted_at IS NULL
      AND (cs.id IN (SELECT id FROM refs WHERE kind = 'session')
        OR cs.id IN (SELECT t.session_id FROM turns t WHERE t.id IN (SELECT id FROM refs WHERE kind = 'turn')))
    ORDER BY cs.id
  LOOP
    SELECT * INTO s FROM coaching_sessions WHERE id = p_session FOR UPDATE;
    SELECT r.persona_id INTO v_persona FROM persona_releases r WHERE r.id = s.persona_release_id;
    v_distilled := s.distilled_at IS NOT NULL OR s.distill_version > 0;
    v_id := to_jsonb(p_session::text);
    UPDATE coaching_sessions SET digest = NULL, digest_deleted_at = now(), opener = NULL
      WHERE id = p_session;
    -- Remove copies of that source's generated opener as well.
    UPDATE coaching_sessions SET opener = NULL WHERE venture_id = m.venture_id AND opener_source_session_id = p_session;
  -- Notebook lines sourced from this conversation, and a summary or opener drawn from it.
  UPDATE veir_notebooks n
     SET content = n.content
           || jsonb_build_object(
                'founderProfile', (SELECT coalesce(jsonb_agg(e.item ORDER BY e.i), '[]'::jsonb)
                                   FROM jsonb_array_elements(n.content -> 'founderProfile') WITH ORDINALITY AS e (item, i)
                                   WHERE NOT app.notebook_line_drawn_from(e.item, p_session::text)),
                'commitments', (SELECT coalesce(jsonb_agg(e.item ORDER BY e.i), '[]'::jsonb)
                                FROM jsonb_array_elements(n.content -> 'commitments') WITH ORDINALITY AS e (item, i)
                                WHERE NOT app.notebook_line_drawn_from(e.item, p_session::text)),
                'openQuestions', (SELECT coalesce(jsonb_agg(e.item ORDER BY e.i), '[]'::jsonb)
                                  FROM jsonb_array_elements(n.content -> 'openQuestions') WITH ORDINALITY AS e (item, i)
                                  WHERE NOT app.notebook_line_drawn_from(e.item, p_session::text)),
                'lastAdvice', (SELECT coalesce(jsonb_agg(e.item ORDER BY e.i), '[]'::jsonb)
                               FROM jsonb_array_elements(n.content -> 'lastAdvice') WITH ORDINALITY AS e (item, i)
                               WHERE NOT app.notebook_line_drawn_from(e.item, p_session::text)))
           || CASE WHEN x.clear_summary THEN '{"summary": "", "summarySources": []}'::jsonb ELSE '{}'::jsonb END
           || CASE WHEN x.clear_opener THEN '{"nextOpener": null, "nextOpenerSource": null, "nextTopic": null}'::jsonb
                   ELSE '{}'::jsonb END,
         version = n.version + 1, last_edited_by = 'person', last_edited_principal = app.current_principal(), updated_at = now()
    FROM (SELECT c.id, c.cites,
                 c.summary <> ''
                   AND (coalesce(c.summary_sources @> jsonb_build_array(v_id), false)
                        OR (c.summary_sources IS NULL AND c.own AND (v_distilled OR c.cites))) AS clear_summary,
                 c.opener IS NOT NULL
                   AND (c.opener_source IS NOT DISTINCT FROM v_id OR c.opener_source IS NULL) AS clear_opener
            FROM (SELECT nb.id, nb.content ->> 'summary' AS summary, nb.content ->> 'nextOpener' AS opener,
                         -- SQL NULL when the key is missing (unknown); a JSON array or JSON null when known.
                         CASE WHEN jsonb_typeof(nb.content -> 'summarySources') = 'array'
                              THEN nb.content -> 'summarySources' END AS summary_sources,
                         nb.content -> 'nextOpenerSource' AS opener_source,
                         nb.persona_id IS NOT DISTINCT FROM v_persona AS own,
                         EXISTS (SELECT 1 FROM jsonb_each(nb.content) AS sec (k, v)
                                 WHERE jsonb_typeof(sec.v) = 'array'
                                   AND EXISTS (SELECT 1 FROM jsonb_array_elements(sec.v) AS e (item)
                                               WHERE app.notebook_line_drawn_from(e.item, p_session::text)))
                           AS cites
                    FROM veir_notebooks nb WHERE nb.venture_id = s.venture_id) AS c) AS x
   WHERE n.id = x.id AND (x.cites OR x.clear_summary OR x.clear_opener);
  END LOOP;
END
$$;
REVOKE ALL ON FUNCTION app.invalidate_memory_continuity(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.invalidate_memory_continuity(uuid) TO app_rls;
