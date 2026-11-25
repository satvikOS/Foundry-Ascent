-- Foundry Ascent — what supports a cited sentence, and which model embedded a row.
-- Applied on top of 0001–0033; expand-only: nothing an older build reads or writes changes (every column is nullable
-- without a default), and every statement is re-runnable (ADD COLUMN IF NOT EXISTS). Grants and row-level security are
-- the tables' own: 0001 grants whole tables, so the columns are read and written under the same policies.
--
--  1. A knowledge source's public page (`url`), attribution (`attribution`; `license` exists) and the day it was read
--     (`accessed_on`), and a passage's place in it (`locator`: module, unit and timestamp, section or chapter), so a
--     citation can show the exact supporting excerpt and where it can be checked.
--  2. `turn_evidence.citation`: what a shared citation showed when the answer was given (excerpt, locator, page,
--     licence, attribution, and a play's own sources). A play of the playbook is evidence without a stored passage, and
--     a library note may be reworded later; the answer keeps what it cited. Never set for a venture's memory or
--     documents: their text is read from the rows themselves, so deleting them deletes it everywhere.
--  3. `embedding_model`: the model that made a row's vector. Vectors of two models cannot be compared; while the
--     platform changes its embedding model (docs/runbooks/embedding-model.md), each row is compared with the query
--     embedded by its own model. Null: not recorded (rows embedded before this migration); such a row is compared with
--     the query as before. The dimension stays 1024, so the vector columns and their index are unchanged.

ALTER TABLE knowledge_sources ADD COLUMN IF NOT EXISTS url text;
ALTER TABLE knowledge_sources ADD COLUMN IF NOT EXISTS attribution text;
ALTER TABLE knowledge_sources ADD COLUMN IF NOT EXISTS accessed_on date;

ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS locator text;
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embedding_model text;

ALTER TABLE memory_objects ADD COLUMN IF NOT EXISTS embedding_model text;

ALTER TABLE turn_evidence ADD COLUMN IF NOT EXISTS citation jsonb;
ALTER TABLE turn_evidence DROP CONSTRAINT IF EXISTS turn_evidence_citation_shape;
ALTER TABLE turn_evidence ADD CONSTRAINT turn_evidence_citation_shape
  CHECK (citation IS NULL
         OR (jsonb_typeof(citation) = 'object' AND kind IN ('chunk', 'doctrine') AND venture_id IS NULL
             AND source_scope IS DISTINCT FROM 'venture' AND pg_column_size(citation) <= 16384));
