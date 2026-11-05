-- Foundry Ascent — memory is automatic again (owner decision 2026-10-16, reconfirmed 2026-11-05: the vEIR remembers
-- on its own, in chats and calls, with no "add to memory" approval; students view, correct, reject, delete and
-- export what it kept). Migration 0021 (2026-11-03) read a request to preserve review as a request to restore
-- approval: it moved every AI item the vEIR had kept by itself (origin `ai`, no approver, `confirmed` or `disputed`)
-- back to `proposed`, unpinned it, and logged a `proposed` event `{"reason": "approval_policy_restored"}`. Retrieval
-- then ignored those items until a student approved each one. This migration puts back exactly those items.
--
-- Which items (0021's own predicate and marker, never a guess):
--   - an AI item (`origin = 'ai'`) still `proposed`, with no approver, that records it was kept automatically
--     (`auto_kept_at`, which 0021 left in place), and that carries 0021's marker event;
--   - nobody acted on it since: no `rejected`, `deleted`, `corrected`, `superseded`, `expired` or `approved` event
--     after the marker (a student who approved it already has it; one who rejected, corrected or deleted it, or the
--     maintenance that retired it as a restatement, is respected: those are no longer `proposed` anyway, and the
--     event check makes that explicit);
--   - nothing was forgotten in its conversations since 0021 (no `memory_forgotten` print for one of its source
--     conversations created after the marker). SQL cannot compare a forgotten print (hashes made in the app) with
--     the item, so such an item stays `proposed` and the daily maintenance settles it with the same checks new
--     memory goes through (keeps it, or retires it when it matches what was forgotten or restates another item).
-- Each restored item gets back the status it had before 0021 (`disputed` when its last status event before the
-- marker was a dispute, else `confirmed`) and its pin (its last pin/unpin event: one from before 0021, or a
-- student's since), and a
-- history event `approved` `{"system": true, "reason": "kept_automatically", "migration": "0026_automatic_memory_restored"}`
-- (shown as kept automatically, never as a person's approval). AI proposals written while approval was required
-- (no 0021 marker) are left to the daily maintenance as well, which keeps or retires each one; until then
-- retrieval never gives the coach an AI item that is still `proposed`.
--
-- A person's correction of a suggestion is theirs. While approval was required, correcting an AI item that was
-- `proposed` wrote the correction as `proposed` too (origin `ai`, no approver), and the daily maintenance then
-- judged it like the vEIR's own suggestion: it matches the forgetting print of the version it corrected away
-- from, so it was retired as forgotten or as the coach's advice. The code now confirms every correction with
-- its corrector as approver, and maintenance never takes up a version that supersedes another. This migration
-- keeps each correction left from then, as the person who wrote it (`approved_by` = its `created_by`, the
-- corrector; `approved_at` = when they corrected it): an AI item with `supersedes_id`, a `corrected` event and
-- no approver that is still `proposed`, or that the maintenance retired (`expired`, its last event an `expired`
-- marked `system`). Never one a person rejected or deleted (those are `rejected`/`deleted`). Its history gets an
-- `approved` event `{"from": <proposed|expired>, "reason": "corrected_by_person", "migration": "0026_automatic_memory_restored"}`.
--
-- Re-runnable: a restored item is no longer `proposed` (or `expired`), so a second run changes nothing. Data only;
-- no schema change.
-- Reversible: every restored item is marked by its 0026 event. To undo (only on an explicit owner decision):
--   WITH back AS (
--     UPDATE memory_objects m SET status = 'proposed', pinned = false, updated_at = now()
--      WHERE m.origin = 'ai' AND m.approved_by IS NULL AND m.status IN ('confirmed', 'disputed')
--        AND EXISTS (SELECT 1 FROM memory_events e WHERE e.memory_id = m.id
--                     AND e.diff ->> 'migration' = '0026_automatic_memory_restored')
--     RETURNING m.id, m.venture_id, m.created_by, 'proposed' AS action)
--   , back_corrections AS (
--     UPDATE memory_objects m SET status = e.diff ->> 'from', approved_by = NULL, approved_at = NULL,
--            updated_at = now()
--       FROM memory_events e
--      WHERE e.memory_id = m.id AND e.diff ->> 'migration' = '0026_automatic_memory_restored'
--        AND e.diff ->> 'reason' = 'corrected_by_person' AND e.diff ->> 'from' IN ('proposed', 'expired')
--        AND m.origin = 'ai' AND m.status = 'confirmed' AND m.approved_by = m.created_by
--     RETURNING m.id, m.venture_id, m.created_by, e.diff ->> 'from' AS action)
--   INSERT INTO memory_events (memory_id, venture_id, actor_id, action, diff)
--   SELECT id, venture_id, created_by, action, '{"reason": "approval_policy_restored", "undo": "0026"}'::jsonb
--     FROM (SELECT * FROM back UNION ALL SELECT * FROM back_corrections) AS undone;
WITH marked AS (
  SELECT m.id, m.venture_id, m.created_by, max(e.id) AS marker, max(e.at) AS marked_at
    FROM memory_objects m
    JOIN memory_events e ON e.memory_id = m.id AND e.action = 'proposed'
                        AND e.diff ->> 'reason' = 'approval_policy_restored'
   WHERE m.origin = 'ai' AND m.status = 'proposed' AND m.approved_by IS NULL AND m.auto_kept_at IS NOT NULL
   GROUP BY m.id, m.venture_id, m.created_by
), eligible AS (
  SELECT k.*,
         coalesce((SELECT e.action = 'disputed' FROM memory_events e
                    WHERE e.memory_id = k.id AND e.id < k.marker
                      AND e.action IN ('created', 'approved', 'disputed', 'proposed')
                      AND coalesce(e.diff ->> 'repeated', 'false') <> 'true'
                    ORDER BY e.id DESC LIMIT 1), false) AS was_disputed,
         coalesce((SELECT e.action = 'pinned' FROM memory_events e
                    WHERE e.memory_id = k.id AND e.action IN ('pinned', 'unpinned')
                    ORDER BY e.id DESC LIMIT 1), false) AS was_pinned
    FROM marked k
   WHERE NOT EXISTS (
           SELECT 1 FROM memory_events e
            WHERE e.memory_id = k.id AND e.id > k.marker
              AND e.action IN ('approved', 'rejected', 'deleted', 'corrected', 'superseded', 'expired'))
     AND NOT EXISTS (
           SELECT 1 FROM memory_forgotten f
            WHERE f.created_at >= k.marked_at
              AND f.session_id IN (
                SELECT CAST(r.ref ->> 'id' AS uuid)
                  FROM memory_objects mo
                  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(mo.source_refs) = 'array'
                                                               THEN mo.source_refs ELSE '[]'::jsonb END) AS r (ref)
                 WHERE mo.id = k.id AND r.ref ->> 'kind' = 'session' AND app.is_contract_uuid(r.ref ->> 'id')
                UNION
                SELECT t.session_id FROM turns t
                 WHERE t.id IN (
                   SELECT CAST(r.ref ->> 'id' AS uuid)
                     FROM memory_objects mo
                     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(mo.source_refs) = 'array'
                                                                  THEN mo.source_refs ELSE '[]'::jsonb END) AS r (ref)
                    WHERE mo.id = k.id AND r.ref ->> 'kind' = 'turn' AND app.is_contract_uuid(r.ref ->> 'id'))))
), restored AS (
  UPDATE memory_objects m
     SET status = CASE WHEN x.was_disputed THEN 'disputed' ELSE 'confirmed' END,
         pinned = x.was_pinned,
         updated_at = now()
    FROM eligible x
   WHERE m.id = x.id AND m.status = 'proposed'
  RETURNING m.id, m.venture_id, m.created_by, m.status
)
INSERT INTO memory_events (memory_id, venture_id, actor_id, action, diff)
SELECT id, venture_id, created_by, 'approved',
       jsonb_build_object('to', status, 'system', true, 'reason', 'kept_automatically',
                          'migration', '0026_automatic_memory_restored')
  FROM restored;

-- A person's correction made while approval was required: kept as theirs (see the header).
WITH corrections AS (
  SELECT m.id, m.venture_id, m.created_by, m.status AS was,
         (SELECT e.at FROM memory_events e
           WHERE e.memory_id = m.id AND e.action = 'corrected' ORDER BY e.id LIMIT 1) AS corrected_at
    FROM memory_objects m
   WHERE m.origin = 'ai' AND m.supersedes_id IS NOT NULL AND m.approved_by IS NULL
     AND EXISTS (SELECT 1 FROM memory_events e WHERE e.memory_id = m.id AND e.action = 'corrected')
     AND (m.status = 'proposed'
          OR (m.status = 'expired'
              AND coalesce((SELECT e.action = 'expired' AND coalesce(e.diff ->> 'system', 'false') = 'true'
                              FROM memory_events e WHERE e.memory_id = m.id
                             ORDER BY e.id DESC LIMIT 1), false)))
), kept AS (
  UPDATE memory_objects m
     SET status = 'confirmed', approved_by = c.created_by, approved_at = coalesce(c.corrected_at, now()),
         updated_at = now()
    FROM corrections c
   WHERE m.id = c.id AND m.status = c.was
  RETURNING m.id, m.venture_id, m.created_by, c.was
)
INSERT INTO memory_events (memory_id, venture_id, actor_id, action, diff)
SELECT id, venture_id, created_by, 'approved',
       jsonb_build_object('to', 'confirmed', 'from', was, 'reason', 'corrected_by_person',
                          'migration', '0026_automatic_memory_restored')
  FROM kept;
