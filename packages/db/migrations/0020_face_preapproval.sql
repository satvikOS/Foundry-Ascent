-- Foundry Ascent — a FULL face's units admitted where they are produced (docs/architecture/calls.md §4).
-- Applied on top of 0001–0019 (there is no 0014); expand-only: nothing an older build reads or writes changes, and
-- every statement is re-runnable (IF NOT EXISTS, COMMENT).
--
--  1. call_face_texts.preapproved: true for a unit the turn engine admitted to the call's live FULL face as it
--     signed it (the same checks the face/say request makes: never the crisis line, the kill switches, the
--     spend cap, the call's speech budget once, each unit once and in order), so the browser hands it to the face
--     without asking first. The face/say request for such a unit answers 204 again without reserving or
--     storing anything more; a unit face/say admitted itself stays false, and asking for it again stays refused.
--     The transcript is reconciled against the digests of every admitted unit alike.
--  2. Its column comment says the same.

ALTER TABLE call_face_texts ADD COLUMN IF NOT EXISTS preapproved boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN call_face_texts.preapproved IS
  'Admitted by the turn engine as it signed the unit (face pre-approval); false when face/say admitted it.';
