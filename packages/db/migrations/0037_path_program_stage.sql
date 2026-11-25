-- Foundry Ascent — a path moves by what the founder shows, or by a change of the program's stage (founder path).
-- Applied on top of 0001–0036; expand-only and re-runnable: nothing an older build reads or writes changes (its inserts
-- get the column from the trigger). Grants and row-level security are the table's own (0033).
--
-- venture_paths.program_stage: the stage the program had the venture at when its path began (or last changed direction).
-- A path that has begun stands where it is; the program's stage counts again only once it is another one than this.

ALTER TABLE venture_paths ADD COLUMN IF NOT EXISTS program_stage text;

UPDATE venture_paths pa SET program_stage = v.stage
  FROM ventures v
 WHERE v.id = pa.venture_id AND pa.program_stage IS NULL;

CREATE OR REPLACE FUNCTION app.path_program_stage() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.program_stage IS NULL THEN
    SELECT v.stage INTO NEW.program_stage FROM ventures v WHERE v.id = NEW.venture_id;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.path_program_stage() FROM PUBLIC;
DROP TRIGGER IF EXISTS venture_paths_program_stage ON venture_paths;
CREATE TRIGGER venture_paths_program_stage BEFORE INSERT ON venture_paths
  FOR EACH ROW EXECUTE FUNCTION app.path_program_stage();
