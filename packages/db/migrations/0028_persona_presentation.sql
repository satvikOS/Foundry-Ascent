-- Foundry Ascent — how a persona presents itself to founders (ADR-0021: Thomas, a stock-avatar mentor persona).
-- Applied on top of 0001–0027 (there is no 0014); expand-only: nothing an older build reads or writes changes, and
-- every statement is re-runnable (IF NOT EXISTS, DROP … IF EXISTS before ADD).
--
-- personas.presentation:
--   'twin'   (every persona before this migration, and the default): an EIR persona is that EIR's digital twin and is
--            named after them ("Corin's vEIR", "Corin · vEIR" with the first-person consent); a guide keeps its name.
--   'mentor' : an AI mentor presented under its own name (the platform owner's decision for a stock avatar's persona,
--            "Thomas"). It speaks in the first person as itself, never as the EIR or as their twin; its doctrine is
--            still an EIR's approved doctrine under that EIR's consent (the consent rules of 0001/0004/0016 are
--            unchanged), and its releases are approved like any other release. Only an EIR persona can be one.
--
-- No row changes here: the owner-approved release that presents a persona as a mentor ships through the seed
-- (packages/db/src/seed/owner-releases.ts, `SEED_OWNER_RELEASES`), which runs after the migrations on every deploy.

ALTER TABLE personas ADD COLUMN IF NOT EXISTS presentation text NOT NULL DEFAULT 'twin';
ALTER TABLE personas DROP CONSTRAINT IF EXISTS personas_presentation_check;
ALTER TABLE personas ADD CONSTRAINT personas_presentation_check CHECK (
  presentation IN ('twin', 'mentor') AND (presentation = 'twin' OR kind = 'eir_persona'));
