-- The current product requirement restores human approval before AI memory becomes coach-readable.
-- Expand-compatible: retain 0013's nullable column and constraint for rollback; do not erase historical content.
-- Previously auto-kept, unapproved active AI items return to review. Already approved/corrected items stay.
-- The new service does not auto-confirm candidates, retrieval requires approval, and maintenance leaves them pending.
WITH pending AS (
  UPDATE memory_objects SET status = 'proposed', pinned = false, updated_at = now()
  WHERE origin = 'ai' AND approved_by IS NULL AND status IN ('confirmed', 'disputed')
  RETURNING id, venture_id, created_by
)
INSERT INTO memory_events (memory_id, venture_id, actor_id, action, diff)
SELECT id, venture_id, created_by, 'proposed', '{"reason":"approval_policy_restored"}'::jsonb FROM pending;
