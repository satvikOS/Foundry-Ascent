-- Foundry Ascent — a LITE stock face fed by the browser (docs/architecture/calls.md §4.4, docs/runbooks/avatars.md).
-- Applied on top of 0001–0026 (there is no 0014); expand-only: nothing an older build reads or writes changes, and
-- every statement is re-runnable (IF NOT EXISTS, DROP … IF EXISTS before ADD).
--
--  1. call_faces.route: who feeds a LITE face our audio. `server` (every face before this migration, and every
--     FULL face): the server relays verified audio over its own speak channel (the route of a real person's
--     likeness). `browser`: a vendor STOCK avatar only; the caller's page holds the speak channel and forwards the
--     PCM of units the server admitted as it signed them. Only a LITE face takes `browser`.
--  2. call_faces.said_turn / said_seq (0018) now also order the admitted units of a `browser` face: the same
--     admission as a FULL face's (each unit once, in order, never the crisis line), stored in call_face_texts.
--  3. call_faces.interrupts: barge-ins the page reported for the face (the face interrupt route), counted
--     for the face's end audit.

ALTER TABLE call_faces ADD COLUMN IF NOT EXISTS route text NOT NULL DEFAULT 'server';
ALTER TABLE call_faces DROP CONSTRAINT IF EXISTS call_faces_route_check;
ALTER TABLE call_faces ADD CONSTRAINT call_faces_route_check CHECK (
  route IN ('server', 'browser') AND (route = 'server' OR mode = 'lite'));

ALTER TABLE call_faces DROP CONSTRAINT IF EXISTS call_faces_said_check;
ALTER TABLE call_faces ADD CONSTRAINT call_faces_said_check CHECK (
  (said_turn IS NULL AND said_seq IS NULL)
  OR ((mode = 'full' OR route = 'browser') AND said_seq BETWEEN 0 AND 99999
      AND said_turn ~ '^(intro|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'));

ALTER TABLE call_faces ADD COLUMN IF NOT EXISTS interrupts integer NOT NULL DEFAULT 0;
ALTER TABLE call_faces DROP CONSTRAINT IF EXISTS call_faces_interrupts_check;
ALTER TABLE call_faces ADD CONSTRAINT call_faces_interrupts_check CHECK (interrupts BETWEEN 0 AND 100000);
