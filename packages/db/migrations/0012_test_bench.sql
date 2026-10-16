-- Foundry Ascent — the EIR studio test bench: a curator talks to a release of their vEIR before approving it.
-- Applied on top of 0001–0010 (it depends on none of 0011's changes); expand-only: nothing an older build reads
-- or writes changes, and every statement is re-runnable (DROP … IF EXISTS before ADD, CREATE OR REPLACE, REVOKE
-- and GRANT).
--
-- A test conversation stores nothing: no conversation, turn, memory, notebook, escalation or review row. What it
-- leaves is what every model call leaves (usage ledger rows) and its audit events, which carry identifiers and
-- counts only.
--
--  1. Usage purpose `test_bench`: every model call of a test conversation is metered under it, so the spend
--     counts against the daily caps (the curator's own and the platform's) and is told apart from coaching.
--  2. app.test_bench_admission(window, in_flight) gives the caller's own test messages in the last `window`
--     seconds and those still being answered (started in the last `in_flight` seconds, not answered yet), read
--     from the bench's audit events (`test_bench.used` when a message is admitted, `test_bench.answered` when it
--     is done, both carrying the run id). The same per-person limits as founder messages apply to them. It
--     returns counts only; app_rls still cannot read the audit log.

-- ---------------------------------------------------------------------------------------------------
-- 1. Usage purpose
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE usage_ledger DROP CONSTRAINT IF EXISTS usage_ledger_purpose_check;
ALTER TABLE usage_ledger ADD CONSTRAINT usage_ledger_purpose_check
  CHECK (purpose IN ('turn', 'recap', 'classification', 'embedding', 'ingestion', 'eval', 'seed', 'distill',
                     'speech', 'test_bench'));

-- ---------------------------------------------------------------------------------------------------
-- 2. Admission counts of the caller's own test messages
-- ---------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.test_bench_admission(p_window_seconds integer, p_in_flight_seconds integer)
  RETURNS TABLE (recent bigint, in_flight bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*) FILTER (WHERE a.at > now() - make_interval(secs => p_window_seconds)),
         count(*) FILTER (WHERE a.at > now() - make_interval(secs => p_in_flight_seconds)
                            AND NOT EXISTS (SELECT 1 FROM audit_events f
                                             WHERE f.action = 'test_bench.answered' AND f.at >= a.at
                                               AND f.object_id = a.object_id AND f.actor_id = a.actor_id))
    FROM audit_events a
   WHERE a.action = 'test_bench.used' AND a.actor_id = app.current_principal()
     AND a.at > now() - make_interval(secs => greatest(p_window_seconds, p_in_flight_seconds))
$$;
REVOKE ALL ON FUNCTION app.test_bench_admission(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.test_bench_admission(integer, integer) TO app_rls;
