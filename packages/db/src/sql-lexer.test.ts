import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from './migrate.js';
import { scanSql, splitStatements } from './sql-lexer.js';

describe('splitStatements', () => {
  it('splits on top-level semicolons only', () => {
    const sql = `
      -- leading comment; not a split
      CREATE TABLE a (x text DEFAULT 'semi;colon');
      /* block ; comment /* nested ; */ still comment */
      INSERT INTO a VALUES (E'escaped \\' quote; still string');
      SELECT "weird;identifier" FROM a;
      SELECT 1`;
    expect(splitStatements(sql)).toEqual([
      "-- leading comment; not a split\n      CREATE TABLE a (x text DEFAULT 'semi;colon')",
      "/* block ; comment /* nested ; */ still comment */\n      INSERT INTO a VALUES (E'escaped \\' quote; still string')",
      'SELECT "weird;identifier" FROM a',
      'SELECT 1',
    ]);
  });

  it('keeps $$ and $tag$ function bodies whole', () => {
    const sql = `
CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$
DECLARE x int := 1;
BEGIN
  PERFORM 'a;b';
  RETURN x; -- done;
END
$$;
CREATE FUNCTION g() RETURNS text LANGUAGE sql AS $body$ SELECT $q$;$q$ || ';' $body$;
DO $$ BEGIN RAISE NOTICE 'x;y'; END $$;`;
    const parts = splitStatements(sql);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatch(/^CREATE FUNCTION f\(\)[\s\S]*END\n\$\$$/);
    expect(parts[1]).toBe(
      "CREATE FUNCTION g() RETURNS text LANGUAGE sql AS $body$ SELECT $q$;$q$ || ';' $body$",
    );
    expect(parts[2]).toBe("DO $$ BEGIN RAISE NOTICE 'x;y'; END $$");
  });

  it('does not treat positional parameters or identifiers containing $ as dollar quotes', () => {
    expect(splitStatements('SELECT $1; SELECT a$b FROM t; SELECT 2')).toEqual([
      'SELECT $1',
      'SELECT a$b FROM t',
      'SELECT 2',
    ]);
  });

  it('drops empty and comment-only statements', () => {
    expect(splitStatements(';;  -- nothing\n; /* x */ ;')).toEqual([]);
  });

  it('splits the bundled migrations into executable statements matching the SQL files', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const m of MIGRATIONS) {
      const onDisk = readFileSync(join(here, '..', 'migrations', `${m.version}.sql`), 'utf8');
      expect(onDisk.replace(/\r\n/g, '\n')).toBe(m.sql);
      const statements = splitStatements(m.sql);
      expect(statements.length).toBeGreaterThan(10);
      for (const s of statements) {
        expect(s.trim()).not.toBe('');
        expect(s.endsWith(';')).toBe(false);
      }
      // Every dollar-quoted body stays intact inside one statement.
      for (const s of statements) expect((s.match(/\$\$/g) ?? []).length % 2).toBe(0);
    }
    const init = splitStatements(MIGRATIONS[0]?.sql ?? '');
    expect(init.some((s) => s.startsWith('DO $$'))).toBe(true);
    const audit = init.find((s) => s.includes('CREATE FUNCTION app.append_audit'));
    expect(audit).toMatch(/LANGUAGE plpgsql[\s\S]*RETURN v_id;\nEND\n\$\$$/);
  });
});

describe('scanSql', () => {
  it('reports placeholders with offsets', () => {
    const { placeholders, terminators } = scanSql('SELECT :a, :b_2; SELECT x::int, :=');
    expect(placeholders.map((ph) => ph.name)).toEqual(['a', 'b_2']);
    expect(placeholders[0]).toMatchObject({ start: 7, end: 9 });
    expect(terminators).toEqual([15]);
  });

  it('handles unterminated constructs without throwing', () => {
    expect(() => scanSql("SELECT 'open")).not.toThrow();
    expect(() => scanSql('SELECT $$ open')).not.toThrow();
    expect(() => scanSql('SELECT /* open')).not.toThrow();
  });
});
