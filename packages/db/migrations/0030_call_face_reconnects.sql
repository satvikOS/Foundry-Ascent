-- Foundry Ascent — a video call reconnects its face (docs/architecture/calls.md §4.3, owner 2026-11-06: "load the
-- actual avatar, then the conversation starts"; a vendor session that ends during the call is replaced, not dropped).
-- Applied on top of 0001–0029 (there is no 0014); expand-only: nothing an older build reads or writes changes, and every
-- statement is re-runnable (IF NOT EXISTS, DROP … IF EXISTS before ADD). It reads nothing of 0029.
--
-- A call still has one call_faces row; the row now holds the call's CURRENT vendor session, and a call whose face the
-- page dropped (the vendor ended its session: the free plan's ~2 minute limit, a dropped room) may open the next one in
-- the same row, as many times as the API allows (`FACE_SESSIONS_PER_CALL`) and within every cap of a first face
-- (faces on, audience, likeness, the call's time left, the per-call and monthly video minutes, the platform spend cap).
-- The API meters a session to its end (the usage ledger) before it replaces it, and the replacement refuses a row whose
-- seconds are not all billed, so every session is billed exactly once.
--
--  1. call_faces.sessions: how many vendor sessions the call opened (1 for every face before this migration).
--  2. call_faces.earlier_seconds: the billed seconds of the call's earlier sessions (each within its own limit). The
--     month's video minutes and the per-call video limit count them with the current session.

ALTER TABLE call_faces ADD COLUMN IF NOT EXISTS sessions smallint NOT NULL DEFAULT 1;
ALTER TABLE call_faces DROP CONSTRAINT IF EXISTS call_faces_sessions_check;
ALTER TABLE call_faces ADD CONSTRAINT call_faces_sessions_check CHECK (sessions BETWEEN 1 AND 100);

ALTER TABLE call_faces ADD COLUMN IF NOT EXISTS earlier_seconds integer NOT NULL DEFAULT 0;
ALTER TABLE call_faces DROP CONSTRAINT IF EXISTS call_faces_earlier_seconds_check;
ALTER TABLE call_faces ADD CONSTRAINT call_faces_earlier_seconds_check CHECK (earlier_seconds BETWEEN 0 AND 1440000);
